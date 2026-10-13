/**
 * Size-Chart Checker (sup.size_charts) — plain code, SHADOW.
 *
 * What it does: for every new order line with a size, works out which Chinese (factory) size
 * actually matches the US size the customer ordered, and records it. When the factory size
 * runs small it records a "KFB ask" (#1234 ordered M → please ship L) for Relay to include in
 * the KFB message later. It never changes the store ("dont fix the store") and never messages KFB.
 *
 * Reilly, 2026-10-11: "if the customer orders a M and the chinese M looks more like a S, we
 * might want to send out a chinese L" · "check everything and make logical decisions" ·
 * "keep track of email info from customers who have complained about sizing ... and make note of that."
 *
 * Inputs:  order_lines + orders (Shopify, already in the ledger), size_charts (library, cm),
 *          size_complaints (from email; CS fills it), core_facts (optional overrides below).
 * Outputs: size_recommendations (one per line), kfb_size_asks (only when a different size
 *          should ship), events.
 *
 * Logic (size EQUIVALENCE, spec "Fit rule"):
 *  - For the garment type, the measurements that matter are compared: jacket chest+shoulder,
 *    sweater chest+length, shirt chest+shoulder. A Chinese size "is" the US size ordered on a
 *    measurement when it reaches the US reference for that size (minus a small tolerance).
 *  - Ship the smallest Chinese size that matches on EVERY measurement that matters. When the
 *    measurements disagree, the reason says which said what.
 *  - Never above the factory's largest size: nothing fits → "no_fit" (customer message needed).
 *  - Customer complaints for the product → treated as running small even if the chart looks
 *    fine; the size-up is learned from what customers said fit.
 *  - No chart and no complaints → "no_chart", no guess. Bottoms (waist sizes) and women's
 *    items → "no_reference" until a reference exists.
 *  - Runs large → still shipped as ordered (sizing DOWN is not automated; noted only).
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { SIZE_ORDER, normSize, sizeIndex } from "./common.js";

const ACTOR = "sup.size_charts";

/** Order lines from the last N days are checked (covers a missed day; KFB ships within days). */
export const LOOKBACK_DAYS = 3;
/** Bounded work per tick. */
export const MAX_LINES_PER_RUN = 100;
/** "no chart" lines are looked at again this often while recent (a chart may have arrived). */
export const RECHECK_HOURS = 6;

/**
 * US garment reference, men's tops, in cm (garment measurements, not body).
 * LABELLED INFERENCE, not an observation: built from standard US men's body chest
 * (S 34–36", M 38–40", L 42–44", XL 46–48" ...) plus the house ~5" ease from the spec
 * ("Converts per listing (house scale, ~5" ease)"), and typical US garment shoulder/length/
 * sleeve. Override per garment with a Core fact: area "sizing", key
 * "sizing.us_reference:<garment>", value JSON {"M": {"chest":112, ...}, ...}.
 */
export const US_REFERENCE_MEN = Object.freeze({
  S: { chest: 102, shoulder: 44, length: 70, sleeve: 62 },
  M: { chest: 112, shoulder: 46, length: 72, sleeve: 63.5 },
  L: { chest: 122, shoulder: 48, length: 74, sleeve: 65 },
  XL: { chest: 132, shoulder: 50, length: 76, sleeve: 66 },
  "2XL": { chest: 142, shoulder: 52, length: 78, sleeve: 67 },
  "3XL": { chest: 152, shoulder: 54, length: 80, sleeve: 68 },
  "4XL": { chest: 162, shoulder: 56, length: 82, sleeve: 69 },
});
export const REFERENCE_SOURCE = "brain's starting US reference (inference: US body chest + ~5\" house ease); refine via Core sizing facts and complaints";

/** How far under the reference still counts as the same size (cm). */
export const TOLERANCE = Object.freeze({ chest: 3, shoulder: 1.5, length: 2, sleeve: 2 });

/** Which measurements matter for which garment (spec: "chest + shoulder for a jacket, chest + length for a sweater"). */
export const GARMENTS = Object.freeze({
  jacket: { re: /\b(blazer|jacket|coat|overcoat|outerwear|parka|peacoat|trench|suit|gilet|vest)\b/i, key: ["chest", "shoulder"] },
  sweater: { re: /\b(sweater|cardigan|knit|jumper|hoodie|sweatshirt|pullover|crewneck|turtleneck|quarter[- ]zip|zip[- ]up)\b/i, key: ["chest", "length"] },
  shirt: { re: /\b(shirt|tee|t-shirt|polo|henley|oxford|flannel|overshirt|top)\b/i, key: ["chest", "shoulder"] },
});
const BOTTOMS_RE = /\b(pants|trousers|jeans|chinos?|shorts|joggers|slacks|skirt)\b/i;
const WOMENS_RE = /\b(women'?s?|womens|ladies|her)\b/i;

export function garmentOf(title) {
  const t = String(title || "");
  if (BOTTOMS_RE.test(t)) return "bottoms";
  for (const [g, d] of Object.entries(GARMENTS)) if (d.re.test(t)) return g;
  return null;
}

/** Read a chart's rows into {size: {chest, shoulder, length, sleeve}} with the size labels normalised. */
export function chartFromRows(rows) {
  const chart = {}; const notes = [];
  for (const r of rows || []) {
    const s = normSize(r.size_label);
    if (!s) continue;
    let m = r.measurements;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch { m = null; } }
    if (!m || typeof m !== "object") continue;
    const out = {};
    for (const k of ["chest", "shoulder", "length", "sleeve"]) {
      const v = Number(k === "chest" ? (m.chest ?? m.bust) : m[k]);
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
    // A chest under 75cm can't be a full adult circumference: it's a flat (half) measurement.
    if (out.chest && out.chest < 75) { out.chest *= 2; notes.push(`${s} chest looked like a flat measurement (×2)`); }
    chart[s] = out;
  }
  return { chart, notes: [...new Set(notes)] };
}

const sortedSizes = (chart) => Object.keys(chart).sort((a, b) => sizeIndex(a) - sizeIndex(b));

/** The US size a measurement value is nearest to (for the explanation). */
function nearestUs(ref, m, v) {
  let best = null;
  for (const [s, r] of Object.entries(ref)) {
    if (r[m] == null) continue;
    if (!best || Math.abs(r[m] - v) < Math.abs(ref[best][m] - v)) best = s;
  }
  return best;
}

/** Learned size-up from complaints: what customers said fit vs what they ordered. */
export function complaintShift(complaints) {
  const shifts = [];
  let small = 0;
  for (const c of complaints || []) {
    const o = sizeIndex(c.size_ordered), f = sizeIndex(c.size_that_fits);
    if (o >= 0 && f >= 0) { if (f > o) { shifts.push(f - o); small++; } continue; }
    if (/small|tight|short|snug/i.test(String(c.said || ""))) { shifts.push(1); small++; }
  }
  if (!small) return 0;
  shifts.sort((a, b) => a - b);
  return Math.max(1, shifts[Math.floor((shifts.length - 1) / 2)]); // median, at least one size
}

/**
 * Decide the size to send for one line. Pure.
 * @returns {{verdict, send_size, reason, conflict:boolean}}
 */
export function recommendSize({ title, orderedSize, chartRows, complaints = [], reference = US_REFERENCE_MEN, audience = null }) {
  const ordered = normSize(orderedSize);
  const garment = garmentOf(title);
  const nComplaints = (complaints || []).length;
  const shift = complaintShift(complaints);
  if (!ordered) return { verdict: "no_reference", send_size: null, reason: `size "${orderedSize}" is not a letter size (waist/number sizes have no reference yet)`, conflict: false };
  if (garment === "bottoms") return { verdict: "no_reference", send_size: null, reason: "bottoms: no US waist/inseam reference yet", conflict: false };
  if (audience === "women" || WOMENS_RE.test(String(title || ""))) return { verdict: "no_reference", send_size: null, reason: "women's item: no women's US reference yet", conflict: false };
  if (!reference[ordered]) return { verdict: "no_reference", send_size: null, reason: `no US reference for size ${ordered}`, conflict: false };

  const { chart, notes } = chartFromRows(chartRows);
  const sizes = sortedSizes(chart);
  if (!sizes.length) {
    if (shift > 0) {
      const send = SIZE_ORDER[Math.min(sizeIndex(ordered) + shift, SIZE_ORDER.length - 1)];
      return { verdict: "complaints_only", send_size: send, conflict: false,
        reason: `no size chart; ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"} say it runs small by ${shift} → ${send}. Factory's largest size unknown: check before asking KFB.` };
    }
    return { verdict: "no_chart", send_size: null, reason: "no size chart in the library yet: no guess", conflict: false };
  }
  const key = (GARMENTS[garment] || GARMENTS.sweater).key;
  const garmentNote = garment ? "" : " (garment type unclear from the title: compared as a sweater, chest + length)";

  // Per measurement that matters: the smallest Chinese size that reaches the US reference for the ordered size.
  const picks = {};
  const said = [];
  for (const m of key) {
    const need = reference[ordered][m];
    if (need == null) continue;
    const have = sizes.filter((s) => chart[s][m] != null);
    if (!have.length) { said.push(`${m}: not on the chart`); continue; }
    const fit = have.find((s) => chart[s][m] >= need - TOLERANCE[m]);
    picks[m] = fit || null;
    const asOrdered = chart[ordered] && chart[ordered][m] != null
      ? `Chinese ${ordered} ${m} ${chart[ordered][m]}cm ≈ US ${nearestUs(reference, m, chart[ordered][m])}`
      : `no Chinese ${ordered} on the chart`;
    said.push(`${m}: ${asOrdered}; US ${ordered} needs ~${need}cm → ${fit ? `Chinese ${fit}` : "no factory size reaches it"}`);
  }
  const measured = Object.keys(picks);
  if (!measured.length) return { verdict: "no_chart", send_size: null, reason: `chart has none of the measurements that matter (${key.join(", ")})`, conflict: false };

  const largest = sizes[sizes.length - 1];
  if (measured.some((m) => !picks[m])) {
    return { verdict: "no_fit", send_size: null, conflict: false,
      reason: `nothing up to the factory's largest (${largest}) fits a US ${ordered}: ${said.join("; ")}. Customer message needed.` };
  }
  let sendIdx = Math.max(...measured.map((m) => sizeIndex(picks[m])));
  const distinct = new Set(measured.map((m) => picks[m]));
  const conflict = distinct.size > 1;
  let why = said.join("; ");
  if (conflict) why += `. Measurements disagree (${measured.map((m) => `${m} says ${picks[m]}`).join(", ")}): shipping ${SIZE_ORDER[sendIdx]} so it fits on all of them`;

  if (shift > 0) {
    const fromComplaints = sizeIndex(ordered) + shift;
    if (fromComplaints > sendIdx) {
      sendIdx = fromComplaints;
      why += `. ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"}: customers say it runs small by ${shift}`;
    } else {
      why += `. ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"} agree it runs small`;
    }
  }
  if (sendIdx > sizeIndex(largest)) {
    return { verdict: "no_fit", send_size: null, conflict,
      reason: `${why}. That's above the factory's largest size (${largest}): customer message needed.` };
  }
  if (notes.length) why += `. Note: ${notes.join("; ")}`;
  const send = SIZE_ORDER[sendIdx];
  if (send === ordered) {
    // Would one size smaller also match? Then it runs large: noted, still shipped as ordered.
    const smaller = sizes.filter((s) => sizeIndex(s) < sizeIndex(ordered)).pop();
    const runsLarge = smaller && measured.every((m) => chart[smaller][m] != null && chart[smaller][m] >= reference[ordered][m] - TOLERANCE[m]);
    if (runsLarge) return { verdict: "runs_large", send_size: ordered, conflict, reason: `${why}. Chinese ${smaller} would also fit: runs large, shipped as ordered (sizing down is not automated)${garmentNote}` };
    return { verdict: "as_ordered", send_size: ordered, conflict, reason: `${why}. True to size: ship as ordered${garmentNote}` };
  }
  return { verdict: "size_up", send_size: send, conflict, reason: `${why}${garmentNote}` };
}

/** Optional Core overrides: audience per store and the US reference per garment. */
async function coreSizing(db, store) {
  const out = { audience: null, references: {} };
  const { results } = await db.prepare(
    `SELECT key, value FROM core_facts WHERE live = 1 AND (store = ? OR store IS NULL) AND (key = 'profile.audience' OR key LIKE 'sizing.us_reference:%')
      ORDER BY id`
  ).bind(store).all().catch(() => ({ results: [] }));
  for (const f of results || []) {
    if (f.key === "profile.audience") out.audience = /women|ladies/i.test(f.value) ? "women" : /men/i.test(f.value) ? "men" : null;
    else {
      try { out.references[f.key.split(":")[1]] = JSON.parse(f.value); } catch { /* bad fact: ignored, default used */ }
    }
  }
  return out;
}

/**
 * Check new order lines. Bounded per run; a line is decided once, except "no_chart" /
 * "no_reference" lines, which are re-checked while recent (a chart may have arrived).
 */
export async function runSizeChecker(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const since = nowIso(nowMs - LOOKBACK_DAYS * 86400000);
  if (!LIVE_STORE_IDS.length) return { checked: 0 };
  const marks = LIVE_STORE_IDS.map(() => "?").join(",");
  const { results: lines } = await db.prepare(
    `SELECT l.store, l.order_id, l.line_id, l.product_id, l.product_handle, l.title, l.size, o.name AS order_name
       FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
       LEFT JOIN size_recommendations r ON r.store = l.store AND r.line_id = l.line_id
      WHERE l.store IN (${marks}) AND o.created_at >= ? AND l.size IS NOT NULL
        AND COALESCE(o.financial_status, '') NOT IN ('refunded', 'voided')
        AND (r.line_id IS NULL OR (r.verdict IN ('no_chart', 'no_reference') AND r.checked_at < ?))
      ORDER BY (r.line_id IS NULL) DESC, o.created_at LIMIT ?`
  ).bind(...LIVE_STORE_IDS, since, nowIso(nowMs - RECHECK_HOURS * 3600000), MAX_LINES_PER_RUN).all();

  const core = {};
  const counts = {}; let asks = 0; let changed = 0;
  for (const l of lines || []) {
    core[l.store] = core[l.store] || await coreSizing(db, l.store);
    const { results: chartRows } = await db.prepare(
      `SELECT size_label, measurements, verified FROM size_charts WHERE store = ? AND (product_id = ? OR (product_handle IS NOT NULL AND product_handle = ?))`
    ).bind(l.store, l.product_id || "", l.product_handle || "").all();
    const { results: complaints } = await db.prepare(
      `SELECT size_ordered, size_that_fits, said FROM size_complaints WHERE store = ? AND product_id = ?`
    ).bind(l.store, l.product_id || "").all();
    const garment = garmentOf(l.title);
    const reference = (garment && core[l.store].references[garment]) || US_REFERENCE_MEN;
    const rec = recommendSize({ title: l.title, orderedSize: l.size, chartRows, complaints, reference, audience: core[l.store].audience });
    let reason = rec.reason;
    if (rec.verdict !== "no_chart" && rec.verdict !== "no_reference" && !core[l.store].audience) reason += " (audience assumed men's: not in the Core yet)";
    const verified = chartRows && chartRows.length ? (chartRows.every((r) => r.verified) ? 1 : 0) : null;
    if (verified === 0) reason += " (chart read by the brain, not yet checked)";

    const prev = await db.prepare(`SELECT verdict FROM size_recommendations WHERE store = ? AND line_id = ?`).bind(l.store, l.line_id).first();
    await db.prepare(
      `INSERT INTO size_recommendations (store, line_id, order_id, order_name, product_id, product_handle, title, ordered_size, send_size,
         verdict, reason, conflict, chart_verified, complaints, checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(store, line_id) DO UPDATE SET send_size = excluded.send_size, verdict = excluded.verdict, reason = excluded.reason,
         conflict = excluded.conflict, chart_verified = excluded.chart_verified, complaints = excluded.complaints, checked_at = excluded.checked_at`
    ).bind(l.store, l.line_id, l.order_id, l.order_name, l.product_id, l.product_handle, l.title, l.size, rec.send_size,
      rec.verdict, reason.slice(0, 1500), rec.conflict ? 1 : 0, verified, (complaints || []).length, at).run();
    if (!prev || prev.verdict !== rec.verdict) { changed++; counts[rec.verdict] = (counts[rec.verdict] || 0) + 1; }

    if ((rec.verdict === "size_up" || rec.verdict === "complaints_only") && rec.send_size && rec.send_size !== normSize(l.size)) {
      const why = rec.verdict === "complaints_only" ? reason : `runs small: ${reason}`;
      const r = await db.prepare(
        `INSERT OR IGNORE INTO kfb_size_asks (store, order_id, line_id, order_name, title, ordered_size, send_size, why, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(l.store, l.order_id, l.line_id, l.order_name, l.title, normSize(l.size), rec.send_size, why.slice(0, 1500), at).run();
      if (r.meta && r.meta.changes) asks++;
    }
  }
  if (changed) {
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
    await logEvent(db, {
      actor: ACTOR, kind: "sizes.checked", target: asks ? "sup.relay" : null, at,
      summary: `Size check: ${changed} order line${changed === 1 ? "" : "s"} (${parts.join(", ")})` +
        (asks ? `; ${asks} size ask${asks === 1 ? "" : "s"} ready for the KFB message` : "") + " (shadow: nothing sent)",
      data: { counts, asks },
    });
  }
  return { checked: (lines || []).length, changed, asks, counts };
}

/** For the store name in messages. */
export const storeName = (id) => (STORES[id] ? STORES[id].name : id);
