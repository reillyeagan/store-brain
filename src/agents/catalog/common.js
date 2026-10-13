/**
 * Catalog department — small shared helpers (database plumbing, costs, once-a-day claims).
 * Nothing here talks to Shopify or Google.
 */
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";
import { costToUsd } from "./pricingRules.js";
import { STORES } from "../../config/stores.js";

export const DEPT = "cat";
export const SEVERITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1, info: 0 });
/** Findings kept per agent per store (the page shows ≤ 50; the rest are counted). */
export const FINDINGS_KEEP = 200;
/** Daily checks wait until this store-local hour, so the 08:00 brief sees this morning's results. */
export const DAILY_FROM_HOUR = 6;

export const storeTz = (storeId) => (STORES[storeId] && STORES[storeId].timezone) || "America/New_York";

export function localHour(nowMs, tz) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(nowMs))) % 24;
}

/**
 * Claim a once-per-local-day job. Atomic: only moves the row to a LATER day, so two
 * overlapping cron runs can't both run it. Returns true if this caller should run now.
 */
export async function claimDaily(db, job, day, nowMs) {
  const res = await db.prepare(
    `INSERT INTO cat_daily (job, day, claimed_at) VALUES (?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET day = excluded.day, claimed_at = excluded.claimed_at
     WHERE excluded.day > cat_daily.day`
  ).bind(job, day, nowIso(nowMs)).run();
  return !!(res.meta && res.meta.changes > 0);
}

/** Give a claim back after a failed run, so the next tick retries (rule 6: a failed probe is retried). */
export async function releaseDaily(db, job, day) {
  await db.prepare(`UPDATE cat_daily SET day = '0000-00-00' WHERE job = ? AND day = ?`).bind(job, day).run();
}

/** Is a daily job due for this store now? (local hour reached and not yet run today) */
export async function dailyDue(db, job, storeId, nowMs) {
  const tz = storeTz(storeId);
  if (localHour(nowMs, tz) < DAILY_FROM_HOUR) return { due: false, day: localDay(nowMs, tz) };
  const day = localDay(nowMs, tz);
  const row = await db.prepare(`SELECT day FROM cat_daily WHERE job = ?`).bind(job).first();
  return { due: !row || row.day < day, day };
}

/** Save an agent's latest run for a store (one row, replaced each run). */
export async function saveRun(db, { agent, store, day, nowMs, status, note = null, summary = null, findings = null }) {
  const kept = Array.isArray(findings) ? findings.slice(0, FINDINGS_KEEP) : null;
  await db.prepare(
    `INSERT INTO cat_runs (agent, store, day, ran_at, status, note, summary, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, store) DO UPDATE SET day = excluded.day, ran_at = excluded.ran_at, status = excluded.status,
       note = excluded.note, summary = excluded.summary, findings = excluded.findings`
  ).bind(agent, store, day, nowIso(nowMs), status, note, summary == null ? null : JSON.stringify(summary),
    kept == null ? null : JSON.stringify(kept)).run();
}

/**
 * Mark an agent as waiting (e.g. the product copy is stale) WITHOUT wiping its last real
 * results: the page keeps showing the last findings, labelled with the waiting reason.
 */
export async function markWaiting(db, { agent, store, day, nowMs, note }) {
  await db.prepare(
    `INSERT INTO cat_runs (agent, store, day, ran_at, status, note) VALUES (?, ?, ?, ?, 'waiting', ?)
     ON CONFLICT(agent, store) DO UPDATE SET status = 'waiting', note = excluded.note`
  ).bind(agent, store, day, nowIso(nowMs), note).run();
}

export async function getRun(db, agent, store) {
  const r = await db.prepare(`SELECT * FROM cat_runs WHERE agent = ? AND store = ?`).bind(agent, store).first();
  if (!r) return null;
  return { ...r, summary: safeJson(r.summary), findings: safeJson(r.findings) || [] };
}

export function safeJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Log an event at most once per `withinMin` for the same actor + kind + store, so a problem
 * that persists on every catalog run can't flood the activity feed (pattern from moneyJobs.js).
 */
export async function logEventOnce(db, e, nowMs, withinMin = 60) {
  const since = nowIso(nowMs - withinMin * 60000);
  const recent = await db.prepare(
    `SELECT id FROM events WHERE actor = ? AND kind = ? AND COALESCE(store, '') = ? AND at >= ? LIMIT 1`
  ).bind(e.actor, e.kind, e.store || "", since).first().catch(() => null);
  if (recent) return null;
  return logEvent(db, { ...e, at: e.at || nowIso(nowMs) });
}

/** The product rows the brain has read for a store (variants/options/tags parsed). */
export async function loadProducts(db, storeId) {
  const { results } = await db.prepare(`SELECT * FROM cat_products WHERE store = ?`).bind(storeId).all();
  return (results || []).map((r) => ({
    ...r,
    tags: safeJson(r.tags) || [],
    option_names: safeJson(r.option_names) || [],
    variants: safeJson(r.variants) || [],
  }));
}

/* ---------------- costs from the Core ---------------- */

/**
 * Per-product costs from the Core (`core_facts`), in USD, with where each came from.
 * Keys (same convention as pnl.js productCosts): "cost:product:<GID>", "cost:sku:<SKU>",
 * "sku:<SKU>:cost". Values: a number (USD), {"usd":x}, {"eur":x} or {"amount":x,"currency":"EUR"}.
 * EUR is converted at the 1.17 estimate and flagged; any other currency is ignored.
 * The Supplier team's Quote Desk is expected to write KFB quotes under the same keys.
 * Returns Map "product:<GID>" | "sku:<SKU>" → {usd, fxEstimated, key, observedAt}.
 */
export async function readCosts(db, storeId) {
  const { results } = await db.prepare(
    `SELECT key, value, observed_at FROM core_facts
      WHERE live = 1 AND (store = ? OR store IS NULL)
        AND (key LIKE 'cost:sku:%' OR key LIKE 'cost:product:%' OR (key LIKE 'sku:%' AND key LIKE '%:cost'))
      ORDER BY CASE WHEN store IS NULL THEN 0 ELSE 1 END, observed_at, id`
  ).bind(storeId).all();
  const map = new Map();
  for (const f of results || []) {
    let v = f.value;
    try { v = JSON.parse(v); } catch { /* plain text number */ }
    const c = costToUsd(v);
    if (!c) continue;
    let k;
    if (f.key.startsWith("cost:sku:")) k = `sku:${f.key.slice(9)}`;
    else if (f.key.startsWith("cost:product:")) k = `product:${f.key.slice(13)}`;
    else k = `sku:${f.key.slice(4, -5)}`;
    map.set(k, { usd: c.usd, fxEstimated: c.fxEstimated, key: f.key, observedAt: f.observed_at }); // newer/store-specific wins
  }
  return map;
}

/**
 * One VARIANT's cost: a product-level cost (KFB quotes whole products) applies to every variant;
 * otherwise that variant's own SKU cost; otherwise null ("cost unknown" — no COGS proposal for it).
 * A variant never borrows a sibling's cost: a cheap variant judged on a dear one's cost would
 * get a raise it doesn't need.
 */
export function variantCost(costs, product, variant) {
  const direct = costs.get(`product:${product.product_id}`);
  if (direct) return direct;
  return (variant && variant.sku && costs.get(`sku:${variant.sku}`)) || null;
}

/**
 * A product-level SUMMARY cost, for counts ("cost known for N products") and for remembering
 * a hold's cost. A product-level cost wins; otherwise the DEAREST known variant cost (the
 * conservative side); `partial` says some variants have no cost. Never used to judge one
 * variant's price — that's variantCost. Null when nothing is known (never a guess).
 */
export function productCost(costs, product) {
  const direct = costs.get(`product:${product.product_id}`);
  if (direct) return { ...direct, partial: false };
  let best = null, known = 0;
  for (const v of product.variants || []) {
    const c = v.sku ? costs.get(`sku:${v.sku}`) : null;
    if (!c) continue;
    known++;
    if (!best || c.usd > best.usd) best = c;
  }
  if (!best) return null;
  return { ...best, partial: known < (product.variants || []).length };
}

/* ---------------- standing holds ---------------- */

/**
 * H&C standing hold (Reilly, 09-01, supplier spec): "H&C outerwear held at $114.95 under band.
 * A held product is never re-proposed unless its cost changes."
 * Outerwear is recognised the same way everywhere: product type, tags AND title.
 * The hold covers COGS findings only (floor/ceiling/ending/compare-at still apply).
 */
export const HOLD_PRICE = 114.95;
const OUTERWEAR = /\b(outerwear|coats?|overcoats?|topcoats?|peacoats?|pea coats?|parkas?|jackets?|trench|trenchcoats?|puffers?)\b/i;

export function isOuterwear(product) {
  const text = [product.product_type || "", ...(product.tags || []), product.title || ""].join(" | ");
  return OUTERWEAR.test(text);
}

/** Could this product/price be under the standing hold? (store + outerwear + $114.95) */
export function isHoldCandidate(storeId, product, price) {
  return storeId === "hc" && Math.abs(Number(price) - HOLD_PRICE) <= 0.004 && isOuterwear(product);
}

/**
 * Work out which products are held, remembering each hold's cost in `cat_holds`:
 *  - first sighting → the hold is recorded with today's cost (null if unknown) → held;
 *  - recorded cost unknown, cost now known → the first known cost is remembered → still held
 *    (learning the cost is not a change in it);
 *  - recorded cost known and today's cost differs by a cent or more → NOT held: re-proposed,
 *    with the reason (the row is kept, so the lift is stable and visible);
 *  - cost now unknown → still held (unknown is not a change).
 * Returns Map productId → {held, since, held_cost, cost_now, reason}.
 */
export async function resolveHolds(db, storeId, products, costs, nowMs) {
  const out = new Map();
  const candidates = products.filter((p) => (p.variants || []).some((v) => isHoldCandidate(storeId, p, v.price)));
  if (!candidates.length) return out;
  const { results } = await db.prepare(`SELECT * FROM cat_holds WHERE store = ?`).bind(storeId).all();
  const rows = new Map((results || []).map((r) => [r.product_id, r]));
  const at = nowIso(nowMs);
  for (const p of candidates) {
    const pc = productCost(costs, p);
    const now = pc ? pc.usd : null;
    const row = rows.get(p.product_id);
    if (!row) {
      await db.prepare(`INSERT OR IGNORE INTO cat_holds (store, product_id, price, cost_usd, held_at, cost_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(storeId, p.product_id, HOLD_PRICE, now, at, now == null ? null : at).run();
      out.set(p.product_id, { held: true, since: at, held_cost: now, cost_now: now, reason: "standing hold: outerwear at $114.95 (Reilly 09-01)" });
      continue;
    }
    if (row.cost_usd == null && now != null) {
      await db.prepare(`UPDATE cat_holds SET cost_usd = ?, cost_seen_at = ? WHERE store = ? AND product_id = ? AND cost_usd IS NULL`)
        .bind(now, at, storeId, p.product_id).run();
      out.set(p.product_id, { held: true, since: row.held_at, held_cost: now, cost_now: now, reason: "standing hold (first known cost remembered)" });
      continue;
    }
    if (row.cost_usd != null && now != null && Math.abs(now - row.cost_usd) >= 0.01) {
      out.set(p.product_id, { held: false, since: row.held_at, held_cost: row.cost_usd, cost_now: now,
        reason: `hold lifted: cost changed from ${money(row.cost_usd)} to ${money(now)} since the hold` });
      continue;
    }
    out.set(p.product_id, { held: true, since: row.held_at, held_cost: row.cost_usd, cost_now: now, reason: "standing hold: outerwear at $114.95 (Reilly 09-01)" });
  }
  return out;
}

export const money = (n) => (n == null ? "?" : `$${Number(n).toFixed(2)}`);
export const pct = (x) => (x == null ? "?" : `${(x * 100).toFixed(1)}%`);
