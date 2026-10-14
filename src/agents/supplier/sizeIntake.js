/**
 * Size-chart intake (sup.size_charts): how factory charts get INTO the size library.
 *
 * Why: the Size Checker compares factory charts with US references, but `size_charts` was
 * empty and nothing filled it. Factory charts aren't in the stores (no tables in descriptions,
 * product images are model shots); they come from KFB / 1688 as images with bare cm numbers.
 *
 * Two ways in (both key-protected routes in src/index.js, both land as NOT YET CHECKED):
 *  - paste:  Reilly types the numbers on the dashboard ({store, product_handle | product_id,
 *            unit, flat, rows}).
 *  - image:  Claude reads the chart image into the same JSON (one call, cost logged, daily
 *            budget respected). Always verified=0: "read by the brain from an image, not yet
 *            checked by Reilly".
 * Both go through the same validation (validateChart). Reilly confirms a chart with
 * POST /api/size-charts/:id/confirm, which marks exactly that chart's rows verified.
 *
 * After a chart is saved, replaced or confirmed, every recent line for that product (last
 * LOOKBACK_DAYS, all verdicts) is re-decided at once. Only a CONFIRMED chart makes KFB asks;
 * a pending ask that no longer holds is withdrawn (never deleted). See runSizeChecker.
 *
 * Never sends anything to KFB or a customer; never touches the store.
 */
import { STORES, LIVE_STORE_IDS } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { askJson, AiError } from "../../lib/ai.js";
import { normSize, sizeIndex, handleFrom } from "./common.js";
import { runSizeChecker, markProductDue } from "./sizeChecker.js";
import { garmentOf } from "./sizeReferences.js";

const ACTOR = "sup.size_charts";
export const MEASURES = Object.freeze(["chest", "shoulder", "length", "sleeve", "waist"]);
/** Plausible full garment measurements in cm, after conversion. Outside → the row is rejected. */
export const RANGES_CM = Object.freeze({ chest: [60, 200], shoulder: [25, 80], length: [30, 160], sleeve: [15, 100], waist: [40, 200] });
export const MAX_ROWS = 12;
/** "Charts needed" looks back this far for sized order lines. */
export const NEEDED_DAYS = 30;
/** 5 MB of base64 (~3.75 MB raw image): the Claude API's per-image limit is on the encoded size. */
export const MAX_IMAGE_BASE64 = 5_242_880;
export const IMAGE_TOO_BIG = "image is too large: the limit is about 3.75 MB (5,242,880 base64 characters). Crop it to the chart or save it smaller";
/** The one question asked when chest numbers could be inches or half (flat) measurements. */
export const UNCLEAR_UNIT = "unclear: inches or a flat (half) measurement? say which (set the unit, and tick flat only if the chart is measured laid flat)";
export const IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const IMAGE_SOURCE = "read by the brain from an image, not yet checked by Reilly";
export const PASTE_SOURCE = "pasted by Reilly on the dashboard, not yet confirmed";

const fail = (status, error) => ({ ok: false, status, error });
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Validate and normalise a chart to cm. Pure.
 * - inches → cm; `flat: true` doubles chest and waist.
 * - A chest under 75cm (after conversion) is never silently doubled: an inch chart typed as cm
 *   and a flat cm chart look the same. Unless the unit was given AND flat was explicitly true,
 *   the chart is refused with UNCLEAR_UNIT. `unit` undefined means "not given".
 * - sizes normalised ("XXL" → "2XL"), strictly ascending as given; measurements never shrink as size grows.
 * - every row needs a chest; chest 60–200cm after conversion; at least 2 sizes.
 * @returns {{ok:true, rows:[{size, chest, ...}], notes:string[]}|{ok:false, status:400, error:string}}
 */
export function validateChart({ unit, flat, rows } = {}) {
  const unitGiven = unit != null && unit !== "";
  const u = String(unitGiven ? unit : "cm").toLowerCase();
  if (u !== "cm" && u !== "in") return fail(400, `unit must be "cm" or "in" (got "${String(unit).slice(0, 20)}")`);
  if (!Array.isArray(rows)) return fail(400, "rows must be a list of sizes");
  if (rows.length < 2) return fail(400, "a chart needs at least 2 sizes");
  if (rows.length > MAX_ROWS) return fail(400, `at most ${MAX_ROWS} sizes`);
  const k = u === "in" ? 2.54 : 1;
  const notes = [];
  if (u === "in") notes.push("converted from inches (×2.54)");
  if (flat === true) notes.push("chest/waist given flat (×2)");
  const out = [];
  for (const [i, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") return fail(400, `row ${i + 1} is not a size row`);
    const size = normSize(raw.size ?? raw.size_label);
    if (!size) return fail(400, `row ${i + 1}: "${String(raw.size ?? "").slice(0, 20)}" is not a letter size (XS–6XL)`);
    const row = { size };
    for (const m of MEASURES) {
      let v = m === "chest" ? (raw.chest ?? raw.bust) : raw[m];
      if (v == null || v === "") continue;
      v = Number(v);
      if (!Number.isFinite(v) || v <= 0) return fail(400, `${size}: ${m} "${String(m === "chest" ? (raw.chest ?? raw.bust) : raw[m]).slice(0, 20)}" is not a number`);
      row[m] = v * k;
    }
    if (row.chest == null) return fail(400, `${size}: chest is required`);
    if (row.chest < 75 && !(flat === true && unitGiven)) return fail(400, `${size} chest ${r1(row.chest)}cm: ${UNCLEAR_UNIT}`);
    if (flat === true) {
      row.chest *= 2;
      if (row.waist != null) row.waist *= 2;
    }
    for (const m of MEASURES) {
      if (row[m] == null) continue;
      row[m] = r1(row[m]);
      const [lo, hi] = RANGES_CM[m];
      if (row[m] < lo || row[m] > hi) return fail(400, `${size}: ${m} ${row[m]}cm is outside ${lo}–${hi}cm${m === "chest" ? " (after conversion)" : ""}: check the unit and the flat box`);
    }
    out.push(row);
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    if (sizeIndex(b.size) <= sizeIndex(a.size)) return fail(400, `sizes out of order: ${a.size} then ${b.size} (list them smallest first, each once)`);
    for (const m of MEASURES) {
      if (a[m] != null && b[m] != null && b[m] < a[m]) return fail(400, `${m} gets smaller from ${a.size} (${a[m]}cm) to ${b.size} (${b[m]}cm): check the numbers`);
    }
  }
  return { ok: true, rows: out, notes: [...new Set(notes)] };
}

/** "123" or "gid://shopify/Product/123" → the GID; anything else → null. */
export function productGid(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{1,20}$/.test(s)) return `gid://shopify/Product/${s}`;
  return /^gid:\/\/shopify\/Product\/\d{1,20}$/.test(s) ? s : null;
}

/**
 * Which product a chart is for. The handle is resolved to a product id from Catalog's copy
 * (cat_products), else from recent order lines. Unresolved → "handle:<handle>" (order lines
 * still match it by handle). A handle and an id that point to different products → refused.
 */
export async function resolveProduct(db, store, { product_handle = null, product_id = null } = {}) {
  const handle = product_handle ? handleFrom(product_handle) : null;
  if (product_handle && !handle) return fail(400, "product_handle doesn't look like a Shopify handle or product link");
  const gid = product_id != null && product_id !== "" ? productGid(product_id) : null;
  if (product_id != null && product_id !== "" && !gid) return fail(400, "product_id must be a Shopify product id or gid://shopify/Product/<id>");
  if (!handle && !gid) return fail(400, "product_handle or product_id is required");
  let found = null;
  if (handle) {
    found = await db.prepare(`SELECT product_id, handle, title FROM cat_products WHERE store = ? AND handle = ?`).bind(store, handle).first().catch(() => null);
    if (!found) {
      found = await db.prepare(`SELECT product_id, product_handle AS handle, title FROM order_lines WHERE store = ? AND product_handle = ? AND product_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
        .bind(store, handle).first().catch(() => null);
    }
  } else {
    found = await db.prepare(`SELECT product_id, handle, title FROM cat_products WHERE store = ? AND product_id = ?`).bind(store, gid).first().catch(() => null);
    if (!found) {
      found = await db.prepare(`SELECT product_id, product_handle AS handle, title FROM order_lines WHERE store = ? AND product_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .bind(store, gid).first().catch(() => null);
    }
  }
  if (gid && found && found.product_id && found.product_id !== gid) {
    return fail(400, `handle "${handle}" belongs to ${found.product_id}, not ${gid}: nothing saved`);
  }
  const productId = gid || (found && found.product_id) || `handle:${handle}`;
  return { ok: true, productId, handle: handle || (found && found.handle) || null, title: (found && found.title) || null, resolved: !!(gid || (found && found.product_id)) };
}

function checkStore(store) {
  if (!store || !STORES[store]) return fail(400, "unknown store");
  if (!LIVE_STORE_IDS.includes(store)) return fail(400, `${STORES[store].name} isn't live yet`);
  return null;
}

/**
 * Save a validated chart: one intake row, then its sizes in size_charts (verified=0), replacing
 * the product's earlier rows. A chart Reilly already confirmed is only replaced with replace:true.
 */
const CONFIRMED_EXISTS = "Reilly already confirmed a chart for this product: tick \"Replace confirmed chart\" (replace:true) to replace it. Nothing saved";

/** The size_charts product ids a chart for this product may live under (the id, and its handle placeholder). */
function chartIds(product) {
  const ids = [product.productId];
  if (product.handle && product.productId !== `handle:${product.handle}`) ids.push(`handle:${product.handle}`);
  return ids;
}

async function confirmedChartExists(db, store, product) {
  const ids = chartIds(product);
  const r = await db.prepare(`SELECT 1 AS y FROM size_charts WHERE store = ? AND verified = 1 AND product_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`)
    .bind(store, ...ids).first();
  return !!r;
}

/** Re-decide a product's recent lines (every verdict) now: a fixed chart undoes the wrong chart's decisions. */
async function redecideProduct(env, { store, ids, handle, nowMs }) {
  const due = await markProductDue(env.DB, { store, productIds: ids, handle, nowMs });
  let recheck = null;
  try { recheck = await runSizeChecker(env, { nowMs }); } catch (err) { recheck = { error: String(err && err.message).slice(0, 200) }; }
  return { due, ...recheck };
}

async function saveChart(env, { store, product, rows, notes, kind, unit, flat, source, replace = false }, nowMs) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const ids = chartIds(product);
  const marks = ids.map(() => "?").join(",");
  const { results: old } = await db.prepare(`SELECT product_id, size_label, measurements, source, verified FROM size_charts WHERE store = ? AND product_id IN (${marks})`)
    .bind(store, ...ids).all();
  if ((old || []).some((r) => r.verified) && !replace) return fail(409, CONFIRMED_EXISTS);
  const allNotes = [...notes];
  if ((old || []).length) allNotes.push(`replaced ${old.length} earlier size row${old.length === 1 ? "" : "s"}`);
  const ins = await db.prepare(
    `INSERT INTO size_chart_intakes (store, product_id, product_handle, title, kind, unit_given, flat_given, rows, notes, source, verified, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
  ).bind(store, product.productId, product.handle, product.title, kind, unit, flat ? 1 : 0, JSON.stringify(rows), JSON.stringify(allNotes), source, at).run();
  const id = ins.meta.last_row_id;
  // The library holds one chart per product: the intake row above keeps the history. The delete
  // and the inserts go in ONE batch (all or nothing), so a failure never leaves half a chart.
  const stmts = [db.prepare(`DELETE FROM size_charts WHERE store = ? AND product_id IN (${marks})`).bind(store, ...ids)];
  for (const r of rows) {
    const { size, ...m } = r;
    stmts.push(db.prepare(
      `INSERT INTO size_charts (store, product_id, product_handle, size_label, measurements, source, verified, checked_at) VALUES (?,?,?,?,?,?,0,NULL)`
    ).bind(store, product.productId, product.handle, size, JSON.stringify(m), `intake:${id} · ${source}`.slice(0, 300)));
  }
  await db.batch(stmts);
  const sizes = rows.map((r) => r.size).join(", ");
  await logEvent(db, {
    actor: ACTOR, kind: "size_chart.added", store, at,
    summary: `Size chart #${id} added for ${STORES[store].name} ${product.handle || product.productId} (${sizes}): ${source}`,
    data: { intake: id, product_id: product.productId, handle: product.handle, kind, sizes: rows.length, notes: allNotes, replaced: old || [] },
  });

  // Every recent line for this product is re-decided now, whatever its verdict (a replaced chart
  // must undo what the old one decided; pending KFB asks that no longer hold are withdrawn).
  const recheck = await redecideProduct(env, { store, ids, handle: product.handle, nowMs });
  return { ok: true, id, store, product_id: product.productId, product_handle: product.handle, resolved: product.resolved, verified: 0, rows, notes: allNotes, recheck };
}

/** POST /api/size-charts: a chart typed in by hand. */
export async function addPastedChart(env, body, { nowMs = Date.now() } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const bad = checkStore(b.store);
  if (bad) return bad;
  // Flat counts as said only when it is ticked (true); anything else is "not said".
  const v = validateChart({ unit: b.unit, flat: b.flat === true ? true : undefined, rows: b.rows });
  if (!v.ok) return v;
  const product = await resolveProduct(env.DB, b.store, { product_handle: b.product_handle, product_id: b.product_id });
  if (!product.ok) return product;
  return saveChart(env, { store: b.store, product, rows: v.rows, notes: v.notes, kind: "paste", unit: String(b.unit || "cm").toLowerCase(), flat: b.flat === true, source: PASTE_SOURCE, replace: b.replace === true }, nowMs);
}

const IMAGE_SYSTEM = `You read garment size charts from clothing factories (often Chinese, usually in cm) and copy the numbers exactly.
Chinese labels: 胸围 = chest/bust, 肩宽 = shoulder, 衣长 or 后中长 = length, 袖长 = sleeve, 腰围 = waist, 平铺 = measured flat.
Rules: copy only numbers you can read in the image; use null for a measurement the chart doesn't give; never invent or estimate a number.
If one cell shows a range (e.g. 80-85), give its midpoint. Size labels as printed (S, M, L, XL, XXL, 2XL, 3XL ...).
If the image is not a readable size chart, return rows: [] and say why in "unreadable".`;
const IMAGE_USER = `Read this size chart. Return {"unit":"cm"|"in","flat":true|false|null,"rows":[{"size":"M","chest":110,"shoulder":48,"length":80,"sleeve":60,"waist":null}],"unreadable":null}.
"flat" is true only if the chart says chest/waist are measured laid flat (half the circumference), false if it says full circumference, null if it doesn't say.`;

/** POST /api/size-charts/image: Claude reads the chart image. One call; always verified=0. */
export async function addChartFromImage(env, body, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const bad = checkStore(b.store);
  if (bad) return bad;
  const mediaType = String(b.media_type || "").toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) return fail(400, `media_type must be one of ${IMAGE_TYPES.join(", ")}`);
  let data = String(b.image_base64 || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!data) return fail(400, "image_base64 is required");
  if (data.length > MAX_IMAGE_BASE64) return fail(400, IMAGE_TOO_BIG);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail(400, "image_base64 is not base64");
  // Resolve the product, and refuse a confirmed chart without replace:true, BEFORE the paid call.
  const product = await resolveProduct(env.DB, b.store, { product_handle: b.product_handle, product_id: b.product_id });
  if (!product.ok) return product;
  if (b.replace !== true && (await confirmedChartExists(env.DB, b.store, product))) return fail(409, CONFIRMED_EXISTS);
  let r;
  try {
    r = await askJson(env, {
      system: IMAGE_SYSTEM, user: IMAGE_USER, image: { media_type: mediaType, data },
      maxTokens: 1500, actor: ACTOR, label: "Size chart image", store: b.store,
    }, { fetchImpl, nowMs });
  } catch (err) {
    return fail(502, `the brain couldn't read the chart: ${String(err instanceof AiError ? err.message : "error").slice(0, 200)}`);
  }
  if (r.skipped) return fail(503, `image reading is ${r.skipped}: paste the numbers instead`);
  const j = r.json || {};
  if (!Array.isArray(j.rows) || !j.rows.length) return fail(422, `no chart read from the image${j.unreadable ? `: ${String(j.unreadable).slice(0, 200)}` : ""}`);
  // The unit is never assumed: no explicit "cm" or "in" from the model → refused, nothing saved.
  const unit = String(j.unit || "").toLowerCase();
  if (unit !== "cm" && unit !== "in") return fail(422, `the image does not say the unit: ${UNCLEAR_UNIT}`);
  // The same validation as a paste. The model's flat flag is used only when it is a clear true.
  const v = validateChart({ unit, flat: j.flat === true ? true : undefined, rows: j.rows });
  if (!v.ok) return fail(422, `the chart read from the image didn't pass the checks: ${v.error}`);
  return saveChart(env, { store: b.store, product, rows: v.rows, notes: v.notes, kind: "image", unit, flat: j.flat === true, source: IMAGE_SOURCE, replace: b.replace === true }, nowMs);
}

/** POST /api/size-charts/:id/confirm: Reilly checked the chart. Marks exactly that chart's rows verified. */
export async function confirmChart(env, id, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const it = await db.prepare(`SELECT * FROM size_chart_intakes WHERE id = ?`).bind(id).first();
  if (!it) return fail(404, "no such chart");
  const like = `intake:${it.id} %`;
  const live = await db.prepare(`SELECT COUNT(*) AS n FROM size_charts WHERE store = ? AND product_id = ? AND source LIKE ?`).bind(it.store, it.product_id, like).first();
  if (!live || !live.n) return fail(409, "this chart was replaced by a newer one: confirm that one instead");
  if (it.verified) return { ok: true, id: it.id, verified: 1, already: true };
  await db.prepare(`UPDATE size_charts SET verified = 1, checked_at = ? WHERE store = ? AND product_id = ? AND source LIKE ?`).bind(at, it.store, it.product_id, like).run();
  await db.prepare(`UPDATE size_chart_intakes SET verified = 1, confirmed_at = ? WHERE id = ?`).bind(at, it.id).run();
  await logEvent(db, {
    actor: ACTOR, kind: "size_chart.confirmed", store: it.store, at,
    summary: `Size chart #${it.id} for ${STORES[it.store] ? STORES[it.store].name : it.store} ${it.product_handle || it.product_id}: confirmed by Reilly`,
    data: { intake: it.id, product_id: it.product_id, handle: it.product_handle },
  });
  // Re-decide the product's recent lines: chart_verified and the reason wording refresh, and only
  // now (a confirmed chart) may a size-up become a KFB ask.
  const ids = [it.product_id];
  if (it.product_handle && it.product_id !== `handle:${it.product_handle}`) ids.push(`handle:${it.product_handle}`);
  const recheck = await redecideProduct(env, { store: it.store, ids, handle: it.product_handle, nowMs });
  return { ok: true, id: it.id, verified: 1, recheck };
}

/**
 * Products with sized order lines in the last 30 days and no chart in the library, by product
 * (handle), most lines first, top 20. Bottoms and number-only sizes are left out: no reference
 * would use their chart.
 */
export async function chartsNeeded(db, { nowMs = Date.now(), limit = 20 } = {}) {
  if (!LIVE_STORE_IDS.length) return [];
  const since = nowIso(nowMs - NEEDED_DAYS * 86400000);
  const marks = LIVE_STORE_IDS.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT l.store, COALESCE(l.product_handle, l.product_id) AS k, MAX(l.product_handle) AS product_handle, MAX(l.product_id) AS product_id,
            MAX(l.title) AS title, COUNT(*) AS lines, GROUP_CONCAT(DISTINCT l.size) AS sizes, MAX(o.created_at) AS last_order_at
       FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
      WHERE l.store IN (${marks}) AND o.created_at >= ? AND l.size IS NOT NULL
        AND COALESCE(o.financial_status, '') NOT IN ('refunded', 'voided')
        AND NOT EXISTS (SELECT 1 FROM size_charts c WHERE c.store = l.store
              AND (c.product_id = l.product_id OR (l.product_handle IS NOT NULL AND c.product_handle = l.product_handle)))
      GROUP BY l.store, k ORDER BY lines DESC, last_order_at DESC LIMIT 200`
  ).bind(...LIVE_STORE_IDS, since).all();
  const out = [];
  for (const r of results || []) {
    if (garmentOf(r.title, "women") === "bottoms") continue;
    const letters = String(r.sizes || "").split(",").map(normSize).filter(Boolean);
    if (!letters.length) continue;
    out.push({
      store: r.store, storeName: STORES[r.store] ? STORES[r.store].name : r.store,
      product_handle: r.product_handle, product_id: r.product_id, title: r.title,
      lines: r.lines, sizes: [...new Set(letters)].sort((a, b) => sizeIndex(a) - sizeIndex(b)).join(", "), last_order_at: r.last_order_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The latest charts added, for the dashboard (with whether each is still the product's chart). */
export async function recentCharts(db, { limit = 20 } = {}) {
  const { results } = await db.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM size_charts c WHERE c.store = i.store AND c.product_id = i.product_id AND c.source LIKE 'intake:' || i.id || ' %') AS live_rows
       FROM size_chart_intakes i ORDER BY i.id DESC LIMIT ?`
  ).bind(limit).all().catch(() => ({ results: [] }));
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  return (results || []).map((r) => ({
    id: r.id, store: r.store, storeName: STORES[r.store] ? STORES[r.store].name : r.store,
    product_handle: r.product_handle, product_id: r.product_id, title: r.title, kind: r.kind,
    rows: parse(r.rows, []), notes: parse(r.notes, []), source: r.source,
    verified: r.verified, current: r.live_rows > 0, created_at: r.created_at, confirmed_at: r.confirmed_at,
  }));
}
