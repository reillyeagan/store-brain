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
 * Reilly, 2026-10-14: "we should have different size charts for different products right? like a
 * womens sweater might have different size measurements than a womens coat or even a womens fitted blouse"
 *
 * Inputs:  order_lines + orders (Shopify, already in the ledger), size_charts (library, cm;
 *          filled by the chart intake in sizeIntake.js), size_complaints (from email; CS fills
 *          it), core_facts (optional overrides below), the US reference library (sizeReferences.js).
 * Outputs: size_recommendations (one per line), kfb_size_asks (only when a different size
 *          should ship), events.
 *
 * Logic (size EQUIVALENCE, spec "Fit rule"):
 *  - The line is matched to a US reference by (audience, garment, fit): e.g. women's coat,
 *    regular fit. Each reference declares the measurements compared (coat/blazer chest +
 *    shoulder, women's knit chest only, men's knit chest + length, dress chest + waist, any
 *    relaxed fit chest only). A Chinese size "is" the US size ordered on a measurement when it
 *    reaches the reference for that size (minus a small tolerance).
 *  - The CHEST decides: ship the smallest Chinese size whose chest reaches the reference. A wrong
 *    size-up is the costly error (the customer gets a too-big item), so shoulder, length, sleeve
 *    and waist shortfalls are notes (conflict=1), never a size-up on their own. The reason says
 *    which measurement said what, and names the reference.
 *  - Oversized / relaxed garments are compared ONLY against the relaxed reference, and are never
 *    sized up just for being oversized: a size-up is capped at what the REGULAR-fit chest needs.
 *  - Only a CONFIRMED chart (or the complaints logic) makes a KFB ask; an unconfirmed chart's
 *    size-up is recorded as "pending your chart confirm". A pending ask that no longer holds is
 *    withdrawn, never deleted.
 *  - Never above the factory's largest size: nothing fits → "no_fit" (customer message needed).
 *  - Customer complaints for the product → treated as running small even if the chart looks
 *    fine; the size-up is learned from what customers said fit.
 *  - No chart and no complaints → "no_chart", no guess. Bottoms (waist sizes), numeric sizes
 *    and kids' items → "no_reference".
 *  - Audience per store (Reilly, 2026-10-13: "H&C is mens and womens. Auberlane is womens.
 *    Marlowe is mens."): STORES[store].audience, overridable by a live Core fact
 *    `profile.audience` only where config is silent. "women" → women's references. "men" →
 *    men's. "both" (H&C) → decided per product from its title, tags and product type; a
 *    product marked neither way is NOT assumed either way. A product marked against its
 *    store's audience, or marked both ways, gets no reference (never guessed).
 *  - Runs large → still shipped as ordered (sizing DOWN is not automated; noted only).
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { SIZE_ORDER, normSize, sizeIndex } from "./common.js";
import {
  referenceFor, referenceName, garmentOf as garmentFor, fitOf, librarySummary, LEGACY_GARMENT,
} from "./sizeReferences.js";

const ACTOR = "sup.size_charts";

/** Order lines from the last N days are checked (covers a missed day; KFB ships within days). */
export const LOOKBACK_DAYS = 3;
/** Bounded work per tick. */
export const MAX_LINES_PER_RUN = 100;
/** "no chart" lines are looked at again this often while recent (a chart may have arrived). */
export const RECHECK_HOURS = 6;

/**
 * What the dashboard says about the references. Every table is a LABELLED INFERENCE (US body
 * measurement + garment ease), see sizeReferences.js. Override one with a Core fact: area
 * "sizing", key "sizing.us_reference:<audience>:<garment>" (or ...:<garment>:<fit>), value JSON
 * {"M": {"chest":112, ...}, ...}. The old key "sizing.us_reference:<garment>" still means men's.
 */
export const REFERENCE_SOURCE = `brain's starting US references (inference: US body chest/bust + garment ease, by audience, garment and fit): ${librarySummary()}. Refine via Core sizing facts and complaints; factory charts come from the chart intake`;

/** How far under the reference still counts as the same size (cm). */
export const TOLERANCE = Object.freeze({ chest: 3, shoulder: 1.5, length: 2, sleeve: 2, waist: 3 });

const WOMENS_RE = /\b(women'?s?|womens|ladies|her)\b/i;
// Word boundaries matter: "women" contains "men" and "female" contains "male"; \bmen and
// \bmale never match inside them. Any feminine marker counts (woman, womenswear, lady, girl...).
const WOMEN_MARK_RE = /\b(wom[ae]n(?:'?s)?|womens|womenswear|lad(?:y|ies)(?:'?s)?|females?|girls?(?:'?s)?)\b/i;
// Not the bare word "man": "Man-made fibres", "Man Made", "Isle of Man" say nothing about who it's for.
const MEN_MARK_RE = /\b(men(?:'?s)?|menswear|males?)\b/i;
// Children's sizes are a different system altogether: never sized against an adult reference.
// Not "baby": "Baby Alpaca" is a yarn, not a size range.
const KIDS_RE = /\b(girls?(?:'?s)?|boys?(?:'?s)?|kids?(?:'?s)?|child(?:ren)?(?:'?s)?|toddlers?|youth|infants?)\b/i;

/** The reason a "both" store's unmarked product gets no size (only H&C is "both" today). */
export const UNMARKED_BOTH_REASON = "H&C sells men's and women's; this product isn't marked either way";
/** A product marked both men's and women's: no reference, never men's. */
export const MIXED_MARKS_REASON = "product is marked both men's and women's: no size reference (never sized as men's)";

/** Which audience one free-text value names ("women", "men", "both"), or null. */
export function audienceOfText(text) {
  const s = String(text || "");
  const w = WOMEN_MARK_RE.test(s), m = MEN_MARK_RE.test(s);
  if ((w && m) || /\b(both|unisex)\b/i.test(s)) return "both";
  return w ? "women" : m ? "men" : null;
}

/**
 * Which audience one product is marked for, from its title, tags (array or JSON array) and
 * product type. Both markers present → "mixed": never sized as men's (a women's line must
 * never be sized against the men's chart, so doubt falls on the cautious side).
 * @returns {"women"|"men"|"mixed"|null}
 */
export function productAudience({ title = null, tags = null, productType = null } = {}) {
  let t = tags;
  if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = [t]; } }
  const text = [title, productType, ...(Array.isArray(t) ? t : [])].filter(Boolean).map(String).join(" | ");
  const w = WOMEN_MARK_RE.test(text), m = MEN_MARK_RE.test(text);
  if (w && m) return "mixed";
  return w ? "women" : m ? "men" : null;
}

/** The garment a title names for an audience (rules and their order: sizeReferences.js). */
export function garmentOf(title, audience = "men") { return garmentFor(title, audience); }

/** Read a chart's rows into {size: {chest, shoulder, length, sleeve, waist}} with the size labels normalised. */
export function chartFromRows(rows) {
  const chart = {}; const notes = [];
  for (const r of rows || []) {
    const s = normSize(r.size_label);
    if (!s) continue;
    let m = r.measurements;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch { m = null; } }
    if (!m || typeof m !== "object") continue;
    const out = {};
    for (const k of ["chest", "shoulder", "length", "sleeve", "waist"]) {
      const v = Number(k === "chest" ? (m.chest ?? m.bust) : m[k]);
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
    // A chest under 75cm can't be a full adult circumference: it's a flat (half) measurement.
    if (out.chest && out.chest < 75) { out.chest *= 2; notes.push(`${s} chest looked like a flat measurement (×2)`); }
    // Same for a waist under 50cm (charts saved through the intake are already full; older rows may not be).
    if (out.waist && out.waist < 50) { out.waist *= 2; notes.push(`${s} waist looked like a flat measurement (×2)`); }
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
  let small = 0, large = 0;
  for (const c of complaints || []) {
    const o = sizeIndex(c.size_ordered), f = sizeIndex(c.size_that_fits);
    if (o >= 0 && f >= 0) {
      if (f > o) { shifts.push(f - o); small++; } else if (f < o) large++;
      continue;
    }
    const said = String(c.said || "");
    if (/too (big|large|loose|long)|baggy|oversized|runs (big|large)/i.test(said)) large++;
    else if (/small|tight|short|snug/i.test(said)) { shifts.push(1); small++; }
  }
  // Mixed signals never size up: only when "too small" clearly outnumbers "too large".
  if (!small || large >= small) return 0;
  shifts.sort((a, b) => a - b);
  return Math.max(1, shifts[Math.floor((shifts.length - 1) / 2)]); // median, at least one size
}

/** A Core override table with its size labels normalised, or null if it isn't a usable table. */
function cleanTable(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out = {};
  for (const [k, v] of Object.entries(t)) { const s = normSize(k); if (s && v && typeof v === "object") out[s] = v; }
  return Object.keys(out).length ? out : null;
}

/** A Core override for (audience, garment, fit): most specific key first; old one-word keys are men's. */
function overrideFor(overrides, audience, garment, fit) {
  const o = overrides || {};
  const tries = [`${audience}:${garment}:${fit}`, `${audience}:${garment}`];
  if (audience === "men") {
    tries.push(garment);
    for (const [old, now] of Object.entries(LEGACY_GARMENT)) if (now.includes(garment)) tries.push(old);
  }
  for (const k of tries) {
    const t = cleanTable(o[k]);
    if (t) return { key: k, table: t };
  }
  return null;
}

/**
 * Which US reference one line is sized against: audience (store + product marks), garment
 * (title, then product type), fit (title + tags). Pure.
 * @returns {{none:string}|{audience, garment, fit, table, key, name, regularTable, notes:string[]}}
 */
export function referenceForLine({ title, audience = null, tags = null, productType = null, overrides = {} }) {
  let tagList = tags;
  if (typeof tagList === "string") { try { tagList = JSON.parse(tagList); } catch { tagList = [tagList]; } }
  const allText = [title, productType, ...(Array.isArray(tagList) ? tagList : [])].filter(Boolean).map(String).join(" | ");
  if (KIDS_RE.test(allText)) return { none: "children's item: no kids' US reference (never sized against an adult chart)" };
  const marked = productAudience({ title, tags, productType });
  if (marked === "mixed") return { none: MIXED_MARKS_REASON };
  const womenMarked = marked === "women" || (marked == null && WOMENS_RE.test(String(title || "")));
  let aud;
  if (audience === "women") {
    if (marked === "men") return { none: "product is marked men's but the store sells women's: no size reference (never guessed)" };
    aud = "women";
  } else if (audience === "men") {
    if (womenMarked) return { none: "product is marked women's but the store sells men's: no size reference (never sized as men's)" };
    aud = "men";
  } else if (audience === "both") {
    // A store that sells both: only a product marked one way gets that way's reference. Never assume.
    if (womenMarked) aud = "women";
    else if (marked === "men") aud = "men";
    else return { none: UNMARKED_BOTH_REASON };
  } else {
    aud = womenMarked ? "women" : "men"; // store not described yet: the run adds "audience assumed"
  }

  const notes = [];
  let garment = garmentFor(title, aud);
  if (garment == null && productType) garment = garmentFor(productType, aud);
  if (garment === "bottoms") return { none: "bottoms: no US waist/inseam reference yet" };
  if (garment == null) {
    garment = "knit";
    notes.push("garment type unclear from the title: compared as a knit");
  }
  const { fit, mixed } = fitOf(title, tagList);
  if (mixed) notes.push("the title says both fitted and relaxed: compared as regular fit");

  const lib = referenceFor(aud, garment, fit);
  if (!lib) return { none: `no US ${aud === "women" ? "women's" : "men's"} ${garment} reference` };
  const ov = overrideFor(overrides, aud, garment, fit);
  const regOv = fit === "relaxed" ? overrideFor(overrides, aud, garment, "regular") : null;
  return {
    audience: aud, garment, fit,
    table: ov ? ov.table : lib.table,
    key: lib.key,
    name: ov ? `Core fact sizing.us_reference:${ov.key} (${fit} fit)` : referenceName(aud, garment, fit),
    regularTable: fit === "relaxed" ? (regOv ? regOv.table : referenceFor(aud, garment, "regular").table) : null,
    notes,
  };
}

/**
 * Decide the size to send for one line. Pure.
 * `overrides` are Core reference tables keyed "<audience>:<garment>[:<fit>]" (or the old "<garment>", men's).
 * @returns {{verdict, send_size, reason, conflict:boolean, reference?:string}}
 */
export function recommendSize({ title, orderedSize, chartRows, complaints = [], audience = null, productSizes = null, tags = null, productType = null, overrides = {} }) {
  const ordered = normSize(orderedSize);
  const nComplaints = (complaints || []).length;
  const shift = complaintShift(complaints);
  if (!ordered) return { verdict: "no_reference", send_size: null, reason: `size "${orderedSize}" is not a letter size (waist/number sizes have no reference yet)`, conflict: false };
  const line = referenceForLine({ title, audience, tags, productType, overrides });
  if (line.none) return { verdict: "no_reference", send_size: null, reason: line.none, conflict: false };
  const reference = line.table;
  if (!reference[ordered]) return { verdict: "no_reference", send_size: null, reason: `no ${line.name} reference for size ${ordered}`, conflict: false };
  const vs = `vs ${line.name} reference`;
  const garmentNote = line.notes.length ? ` (${line.notes.join("; ")})` : "";

  const { chart, notes } = chartFromRows(chartRows);
  const sizes = sortedSizes(chart);
  if (!sizes.length) {
    if (shift > 0) {
      const want = SIZE_ORDER[Math.min(sizeIndex(ordered) + shift, SIZE_ORDER.length - 1)];
      const base = `no size chart; ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"} say it runs small by ${shift} → ${want}`;
      // Never ask for a size the product doesn't come in: cap at the largest size it is listed in.
      const listed = (productSizes || []).map(normSize).filter(Boolean);
      if (!listed.length) {
        return { verdict: "complaints_only", send_size: null, conflict: false, reason: `${base}, but the product's largest size is not known yet: no ask made` };
      }
      const largestListed = listed.sort((a, b) => sizeIndex(a) - sizeIndex(b))[listed.length - 1];
      if (sizeIndex(want) > sizeIndex(largestListed)) {
        return { verdict: "complaints_only", send_size: null, conflict: false, reason: `${base}, which is above the largest size it comes in (${largestListed}): customer message needed` };
      }
      return { verdict: "complaints_only", send_size: want, conflict: false, reason: `${base} (it comes in up to ${largestListed}; no chart to check the factory's sizes)` };
    }
    return { verdict: "no_chart", send_size: null, reason: `no size chart in the library yet: no guess (would compare ${vs})`, conflict: false };
  }
  const key = line.key;

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
  // The CHEST decides the size (review of 1e5fd64: a wrong size-up is the costly error, so it
  // needs strong evidence). Shoulder, length, sleeve and waist are reported as notes, and never
  // force a size-up on their own.
  if (!("chest" in picks)) {
    return { verdict: "no_chart", send_size: null, conflict: false,
      reason: `chart has no chest measurement ${vs}: the chest decides the size, so no guess${said.length ? ` (${said.join("; ")})` : ""}` };
  }

  // Oversized / relaxed: never sized up just for being an oversized cut. The extra room the
  // relaxed reference expects is a style choice, so a size-up is capped at what the REGULAR-fit
  // chest needs: if the ordered Chinese size reaches the regular chest it ships as ordered, and a
  // chart that is genuinely small goes up only as far as the regular chest says.
  let oversizeNote = "";
  if (line.fit === "relaxed" && (picks.chest === null || sizeIndex(picks.chest) > sizeIndex(ordered))) {
    const reg = line.regularTable && line.regularTable[ordered] && line.regularTable[ordered].chest;
    const regPick = reg == null ? null : sizes.find((s) => chart[s].chest != null && chart[s].chest >= reg - TOLERANCE.chest);
    if (regPick && (picks.chest === null || sizeIndex(regPick) < sizeIndex(picks.chest))) {
      picks.chest = sizeIndex(regPick) < sizeIndex(ordered) ? ordered : regPick;
      oversizeNote = picks.chest === ordered
        ? `. Chinese ${ordered} chest ${chart[ordered] ? `${chart[ordered].chest}cm ` : ""}already reaches the regular-fit US ${ordered} (~${reg}cm): not sized up just for being an oversized cut`
        : `. Capped at Chinese ${picks.chest}, the size that reaches the regular-fit US ${ordered} chest (~${reg}cm): never sized up further just for being an oversized cut`;
    }
  }

  const largest = sizes[sizes.length - 1];
  if (!picks.chest) {
    return { verdict: "no_fit", send_size: null, conflict: false, reference: line.name,
      reason: `${vs}: no chest up to the factory's largest (${largest}) fits a US ${ordered}: ${said.join("; ")}. Customer message needed.${garmentNote}` };
  }
  let sendIdx = sizeIndex(picks.chest);
  // Never send smaller than ordered: a chart that runs large is noted, not acted on.
  const chartBelowOrdered = sendIdx < sizeIndex(ordered);
  if (chartBelowOrdered) sendIdx = sizeIndex(ordered);
  // Other measurements that fall short of the size the chest chose: a conflict, noted only.
  const short = measured.filter((m) => m !== "chest" && (picks[m] === null || sizeIndex(picks[m]) > sendIdx));
  const conflict = short.length > 0;
  let why = `${vs}: ${said.join("; ")}${oversizeNote}`;
  if (conflict) {
    why += `. Measurements disagree (chest says ${SIZE_ORDER[sendIdx]}, ${short.map((m) => `${m} says ${picks[m] || "none fits"}`).join(", ")}): ` +
      `the chest decides (${SIZE_ORDER[sendIdx]}); the ${short.join(" and ")} shortfall is noted only, never a size-up on its own`;
  }

  if (shift > 0) {
    const fromComplaints = sizeIndex(ordered) + shift;
    if (fromComplaints > sendIdx) {
      sendIdx = fromComplaints;
      why += `. ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"}: customers say it runs small by ${shift}`;
    } else {
      why += `. ${nComplaints} sizing complaint${nComplaints === 1 ? "" : "s"} agree it runs small`;
    }
  }
  const out = (o) => ({ ...o, reference: line.name });
  if (sendIdx > sizeIndex(largest)) {
    return out({ verdict: "no_fit", send_size: null, conflict,
      reason: chartBelowOrdered
        ? `${why}. The chart says a smaller Chinese size would fit, but the factory's largest is ${largest} and the brain never sends smaller than ordered: customer message needed.${garmentNote}`
        : `${why}. That's above the factory's largest size (${largest}): customer message needed.${garmentNote}` });
  }
  if (notes.length) why += `. Note: ${notes.join("; ")}`;
  const send = SIZE_ORDER[sendIdx];
  if (send === ordered) {
    if (chartBelowOrdered) {
      return out({ verdict: "runs_large", send_size: ordered, conflict, reason: `${why}. Runs large: shipped as ordered (the brain never sends smaller than ordered)${garmentNote}` });
    }
    // Would one size smaller also match on the chest? Then it runs large: noted, still shipped as ordered.
    const smaller = sizes.filter((s) => sizeIndex(s) < sizeIndex(ordered)).pop();
    const runsLarge = !oversizeNote && smaller && chart[smaller].chest != null && chart[smaller].chest >= reference[ordered].chest - TOLERANCE.chest;
    if (runsLarge) return out({ verdict: "runs_large", send_size: ordered, conflict, reason: `${why}. Chinese ${smaller} would also fit: runs large, shipped as ordered (sizing down is not automated)${garmentNote}` });
    return out({ verdict: "as_ordered", send_size: ordered, conflict, reason: `${why}. True to size: ship as ordered${garmentNote}` });
  }
  return out({ verdict: "size_up", send_size: send, conflict, reason: `${why}${garmentNote}` });
}

/** Letter sizes a product is listed in, from cat_products.variants JSON ([{title:"Navy / M"}, ...]). */
export function listedSizes(variantsJson) {
  let vs = variantsJson;
  if (typeof vs === "string") { try { vs = JSON.parse(vs); } catch { return []; } }
  const out = new Set();
  for (const v of Array.isArray(vs) ? vs : []) {
    for (const part of String((v && v.title) || "").split("/")) { const s = normSize(part); if (s) out.add(s); }
  }
  return [...out];
}

/**
 * Audience and the US reference per garment.
 *
 * Audience: Reilly's recorded word (STORES[store].audience, 2026-10-13) wins. Core facts are
 * only read when they are scoped to THIS store (an all-stores fact can't speak for one store),
 * and even then never outrank the config: a fact that agrees changes nothing, a fact that
 * disagrees is reported as a conflict note and ignored. So a fact can never switch off H&C's
 * per-product check. Only a store Reilly hasn't described yet (audience null) takes its
 * audience from a store-scoped fact.
 * @returns {{audience, audienceConflict:string|null, references}}
 */
export async function coreSizing(db, store) {
  const config = (STORES[store] && STORES[store].audience) || null;
  const out = { audience: config, audienceConflict: null, references: {} };
  const { results } = await db.prepare(
    `SELECT key, value, store FROM core_facts WHERE live = 1 AND (
        (key = 'profile.audience' AND store = ?) OR (key LIKE 'sizing.us_reference:%' AND (store = ? OR store IS NULL)))
      ORDER BY id`
  ).bind(store, store).all().catch(() => ({ results: [] }));
  for (const f of results || []) {
    if (f.key === "profile.audience") {
      const said = audienceOfText(f.value);
      if (!said) continue; // unreadable fact: ignored
      if (!config) out.audience = said;
      else if (said !== config) {
        out.audienceConflict = `Core fact profile.audience "${String(f.value).slice(0, 60)}" disagrees with Reilly's recorded audience "${config}" (2026-10-13): Reilly's used`;
      }
    } else {
      // "sizing.us_reference:women:coat" → "women:coat"; the old "sizing.us_reference:jacket" → "jacket" (men's).
      try { out.references[f.key.slice("sizing.us_reference:".length)] = JSON.parse(f.value); } catch { /* bad fact: ignored, default used */ }
    }
  }
  return out;
}

/** How an unconfirmed chart is named in a reason, from where its rows came from. */
export function chartStatusNote(chartRows) {
  const src = (chartRows || []).map((r) => String(r.source || "")).join(" ");
  if (/from an image/i.test(src)) return "chart read by the brain from an image, not yet confirmed";
  if (/pasted/i.test(src)) return "chart pasted by Reilly, not yet confirmed";
  return "chart not yet confirmed by Reilly";
}

/**
 * Make a product's recent lines (last LOOKBACK_DAYS, every verdict) due again, so the next run
 * re-decides them. Used when a chart is saved, replaced or confirmed: fixing a chart must undo
 * what the wrong chart decided.
 */
export async function markProductDue(db, { store, productIds = [], handle = null, nowMs = Date.now() }) {
  const since = nowIso(nowMs - LOOKBACK_DAYS * 86400000);
  const ids = productIds.length ? productIds : [""];
  const marks = ids.map(() => "?").join(",");
  const r = await db.prepare(
    `UPDATE size_recommendations SET checked_at = '' WHERE store = ?
       AND (product_id IN (${marks}) OR (product_handle IS NOT NULL AND product_handle = ?))
       AND line_id IN (SELECT l.line_id FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
                        WHERE l.store = ? AND o.created_at >= ?)`
  ).bind(store, ...ids, handle || "", store, since).run();
  return (r.meta && r.meta.changes) || 0;
}

/**
 * Check new order lines. Bounded per run; a line is decided once, except: "no_chart" /
 * "no_reference" lines are re-checked while recent (a chart may have arrived), and any line made
 * due by markProductDue (checked_at = '') is re-decided whatever its verdict.
 *
 * KFB asks: only a CONFIRMED chart (or the complaints logic) makes one. A size-up read from an
 * unconfirmed chart is recorded as "pending your chart confirm". A pending ask that no longer
 * holds is withdrawn (status 'withdrawn', reason appended to `why`), never deleted.
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
        AND (r.line_id IS NULL OR r.checked_at = '' OR (r.verdict IN ('no_chart', 'no_reference') AND r.checked_at < ?))
      ORDER BY (r.line_id IS NULL) DESC, o.created_at LIMIT ?`
  ).bind(...LIVE_STORE_IDS, since, nowIso(nowMs - RECHECK_HOURS * 3600000), MAX_LINES_PER_RUN).all();

  const core = {};
  const counts = {}; let asks = 0; let changed = 0; let withdrawn = 0; let updatedAsks = 0;
  for (const l of lines || []) {
    core[l.store] = core[l.store] || await coreSizing(db, l.store);
    const { results: chartRows } = await db.prepare(
      `SELECT size_label, measurements, verified, source FROM size_charts WHERE store = ? AND (product_id = ? OR (product_handle IS NOT NULL AND product_handle = ?))`
    ).bind(l.store, l.product_id || "", l.product_handle || "").all();
    const { results: complaints } = await db.prepare(
      `SELECT size_ordered, size_that_fits, said FROM size_complaints WHERE store = ? AND product_id = ?`
    ).bind(l.store, l.product_id || "").all();
    // Catalog's copy of the product: its title/tags/type say men's or women's at a store that
    // sells both, and its sizes cap a complaints-only ask.
    const listing = await db.prepare(`SELECT title, tags, product_type, variants FROM cat_products WHERE store = ? AND product_id = ?`)
      .bind(l.store, l.product_id || "").first().catch(() => null);
    const productSizes = listedSizes(listing && listing.variants);
    const title = [l.title, listing && listing.title].filter(Boolean).join(" | ");
    const input = { title, orderedSize: l.size, chartRows, complaints, overrides: core[l.store].references, audience: core[l.store].audience, productSizes,
      tags: listing && listing.tags, productType: listing && listing.product_type };
    const rec = recommendSize(input);
    let reason = rec.reason;
    if (rec.verdict !== "no_chart" && rec.verdict !== "no_reference" && !core[l.store].audience) reason += " (audience assumed men's: not in the Core yet)";
    if (core[l.store].audienceConflict) reason += ` (conflict: ${core[l.store].audienceConflict})`;
    const verified = chartRows && chartRows.length ? (chartRows.every((r) => r.verified) ? 1 : 0) : null;
    const ordered = normSize(l.size);

    // What, if anything, KFB should be asked to ship instead.
    let askSize = null, askWhy = null;
    if (rec.verdict === "complaints_only" && rec.send_size && rec.send_size !== ordered) {
      askSize = rec.send_size; askWhy = reason;
    } else if (rec.verdict === "size_up" && rec.send_size && rec.send_size !== ordered) {
      if (verified === 1) {
        askSize = rec.send_size; askWhy = `runs small: ${reason}`;
      } else {
        // An unconfirmed chart never makes a KFB ask on its own; complaints still can.
        const alt = recommendSize({ ...input, chartRows: [] });
        if (alt.verdict === "complaints_only" && alt.send_size && alt.send_size !== ordered) {
          askSize = alt.send_size; askWhy = `customer complaints (the chart is pending your confirm): ${alt.reason}`;
        }
        reason += `. Pending your chart confirm: no KFB ask from an unconfirmed chart${askSize ? ` (the complaints alone ask for ${askSize})` : ""}`;
      }
    }
    if (verified === 0) reason += ` (${chartStatusNote(chartRows)})`;

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

    // Keep the KFB ask in step with the decision. Never deleted: history stays in `why`.
    const ask = await db.prepare(`SELECT id, status, send_size, why FROM kfb_size_asks WHERE store = ? AND line_id = ?`).bind(l.store, l.line_id).first();
    if (askSize) {
      if (!ask) {
        const r = await db.prepare(
          `INSERT OR IGNORE INTO kfb_size_asks (store, order_id, line_id, order_name, title, ordered_size, send_size, why, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(l.store, l.order_id, l.line_id, l.order_name, l.title, ordered, askSize, askWhy.slice(0, 1500), at).run();
        if (r.meta && r.meta.changes) asks++;
      } else if ((ask.status === "pending" || ask.status === "withdrawn") && (ask.send_size !== askSize || ask.status === "withdrawn")) {
        await db.prepare(`UPDATE kfb_size_asks SET status = 'pending', send_size = ?, why = ? WHERE id = ?`)
          .bind(askSize, `${askWhy} [earlier: ${ask.status} ${ask.send_size}, changed ${at}]`.slice(0, 1500), ask.id).run();
        updatedAsks++;
      } else if (ask.status === "included" && ask.send_size !== askSize) {
        await logEvent(db, { actor: ACTOR, kind: "sizes.ask_conflict", store: l.store, target: "sup.relay", at,
          summary: `${l.order_name}: KFB was already asked for ${ask.send_size}; the brain now says ${askSize}. Your call (nothing sent)` });
      }
    } else if (ask && ask.status === "pending") {
      const now = `now ${rec.verdict.replace(/_/g, " ")}${rec.send_size ? ` ${rec.send_size}` : ""}${verified === 0 ? `, ${chartStatusNote(chartRows)}` : ""}`;
      await db.prepare(`UPDATE kfb_size_asks SET status = 'withdrawn', why = ? WHERE id = ?`)
        .bind(`${ask.why} | withdrawn ${at}: no longer holds (${now})`.slice(0, 2000), ask.id).run();
      withdrawn++;
    } else if (ask && ask.status === "included") {
      await logEvent(db, { actor: ACTOR, kind: "sizes.ask_conflict", store: l.store, target: "sup.relay", at,
        summary: `${l.order_name}: KFB was already asked for ${ask.send_size}, but the brain no longer recommends it (${rec.verdict.replace(/_/g, " ")}). Your call (nothing sent)` });
    }
  }
  if (changed || withdrawn || updatedAsks) {
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
    await logEvent(db, {
      actor: ACTOR, kind: "sizes.checked", target: asks ? "sup.relay" : null, at,
      summary: `Size check: ${changed} order line${changed === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}` +
        (asks ? `; ${asks} size ask${asks === 1 ? "" : "s"} ready for the KFB message` : "") +
        (updatedAsks ? `; ${updatedAsks} ask${updatedAsks === 1 ? "" : "s"} changed` : "") +
        (withdrawn ? `; ${withdrawn} ask${withdrawn === 1 ? "" : "s"} withdrawn (no longer hold)` : "") + " (shadow: nothing sent)",
      data: { counts, asks, updatedAsks, withdrawn },
    });
  }
  return { checked: (lines || []).length, changed, asks, updatedAsks, withdrawn, counts };
}

/** For the store name in messages. */
export const storeName = (id) => (STORES[id] ? STORES[id].name : id);
