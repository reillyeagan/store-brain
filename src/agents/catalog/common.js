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
 * that persists every 15 minutes can't flood the activity feed (pattern from moneyJobs.js).
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
 * One product's cost. A product-level cost wins; otherwise the DEAREST known variant cost
 * (errors run in the flattering direction, so the brain assumes the higher cost).
 * Returns null when nothing is known ("cost unknown"; never a guess).
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

/**
 * H&C standing hold (Reilly, 09-01): outerwear held at $114.95 under band. Recognised by
 * product type or tags; the hold covers COGS findings only (floor/ceiling/ending still apply).
 */
const OUTERWEAR = /\b(outerwear|coat|overcoat|topcoat|peacoat|pea coat|parka|jacket|trench|puffer)\b/i;
export function isHeld(storeId, product, price) {
  if (storeId !== "hc" || Math.abs(Number(price) - 114.95) > 0.004) return false;
  const text = [product.product_type || "", ...(product.tags || [])].join(" ");
  return OUTERWEAR.test(text);
}

export const money = (n) => (n == null ? "?" : `$${Number(n).toFixed(2)}`);
export const pct = (x) => (x == null ? "?" : `${(x * 100).toFixed(1)}%`);
