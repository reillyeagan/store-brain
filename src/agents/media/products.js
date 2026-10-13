/**
 * media.products — Product Performance. SHADOW / WATCH ONLY.
 *
 * Does: per store, once a day, reads product-level ad results (Shopping and Performance Max,
 *   shopping_performance_view) for the last 14 closed days and flags:
 *    - "spending without selling": spent at least MEDIA_PRODUCT_BURN_USD (default $20) with
 *      zero Google conversions — worse ("bad") when Shopify also sold none of it;
 *    - "losing money even when it sells": converts, but its ROAS (Google value capped at
 *      the store's total revenue — a sanity cap, not verified ad sales) is under break-even.
 *   It cross-checks each product against real Shopify sales (order_lines) in the same days.
 *   Those sales are from EVERY channel, so they are an upper bound for what ads earned: if a
 *   product is under break-even even counting all of them, it is certainly losing (rule 5).
 * Inputs: Google Ads shopping_performance_view (read-only), order_lines + orders, pnl_days.
 * Outputs: media_products rows, media_findings ("item:<id>"), a media.flag event for each new
 *   flag (at most 10 per run) and one media.pulled event. Nothing is changed in Google or Shopify.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import {
  accountTz, windowFor, micros, int, real, r2, storeBreakeven, revenueCap, breakevenLabel, CAP_LABEL, runBatched, MAX_STORED_ROWS,
  upsertFinding, clearUnseen, storeName, money, ratio,
} from "./common.js";

export const AGENT = "media.products";
export const PRODUCT_DAYS = 14;
export const BURN_MIN_USD_DEFAULT = 20;
const MAX_FLAG_EVENTS = 10;

/** "shopify_US_123_456" → "123" (Shopify product id). Null when the id has another shape. */
export function productIdFromItem(itemId) {
  const m = String(itemId || "").match(/^shopify_[a-z]{2}_(\d+)_(\d+)$/i);
  return m ? m[1] : null;
}

/** Pure: GAQL rows → one row per product item id. */
export function parseProductRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const s = (r && r.segments) || {};
    const id = s.productItemId;
    if (!id) continue;
    const m = r.metrics || {};
    const cur = out.get(id) || { item_id: id, title: s.productTitle || null, product_id: productIdFromItem(id), cost: 0, clicks: 0, impressions: 0, conversions: 0, conv_value: 0 };
    cur.cost += micros(m.costMicros);
    cur.clicks += int(m.clicks);
    cur.impressions += int(m.impressions);
    cur.conversions += real(m.conversions);
    cur.conv_value += real(m.conversionsValue);
    out.set(id, cur);
  }
  return [...out.values()].map((v) => ({ ...v, cost: r2(v.cost), conv_value: r2(v.conv_value) }));
}

/**
 * Pure: decide a product's flag. `real` = { units, revenue } from Shopify (all channels) or null.
 * Returns null (no flag) or { kind, severity, why }.
 */
export function judgeProduct(p, { breakeven, factor, minUsd, real: sold, beText = null }) {
  if (p.cost < minUsd) return null;
  if (p.conversions <= 0) {
    const none = sold && sold.units === 0;
    return { kind: "burning", severity: none ? "bad" : "warn",
      why: `${money(p.cost)} spent, 0 Google conversions${sold ? `, ${sold.units} sold in Shopify (all channels)` : ""}` };
  }
  if (breakeven == null) return null;
  const adj = (p.conv_value * (factor == null ? 1 : factor)) / p.cost;
  if (adj >= breakeven) return null;
  const realRoas = sold && sold.revenue != null ? sold.revenue / p.cost : null;
  const certain = realRoas != null && realRoas < breakeven;
  return { kind: "losing", severity: certain ? "bad" : "warn", roas: r2(adj), real_roas: r2(realRoas),
    why: `${CAP_LABEL} ${ratio(r2(adj))} vs ${beText || `break-even ${ratio(breakeven)}`} on ${money(p.cost)}${certain ? `; even all its Shopify sales (${money(r2(sold.revenue))}) don't cover it` : ""}` };
}

/** Units and revenue per Shopify product id in [from, to] (store days), from order_lines. */
async function shopifySales(db, storeId, from, to) {
  const { results } = await db.prepare(
    `SELECT l.product_id AS pid, COALESCE(SUM(l.quantity), 0) AS units, COALESCE(SUM(l.quantity * l.price), 0) AS revenue
     FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
     WHERE l.store = ? AND o.local_day >= ? AND o.local_day <= ? AND l.product_id IS NOT NULL
     GROUP BY l.product_id`
  ).bind(storeId, from, to).all();
  const m = new Map();
  for (const r of results || []) {
    const id = String(r.pid).split("/").pop();
    m.set(id, { units: Number(r.units), revenue: r2(r.revenue) });
  }
  return m;
}

/** Do we have Shopify order lines covering this window at all? If not, "sold" is unknown, not 0. */
async function haveLines(db, storeId, from, to) {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.store = l.store AND o.order_id = l.order_id
     WHERE l.store = ? AND o.local_day >= ? AND o.local_day <= ?`
  ).bind(storeId, from, to).first();
  return !!(r && Number(r.n) > 0);
}

export async function runProducts(env, { storeId, session, nowMs = Date.now() }) {
  const db = env.DB;
  const tz = await accountTz(env, storeId, session);
  const { from, to } = windowFor(nowMs, tz, PRODUCT_DAYS);
  const rows = await session.query(storeId,
    `SELECT segments.product_item_id, segments.product_title, metrics.cost_micros, metrics.clicks,
       metrics.impressions, metrics.conversions, metrics.conversions_value
     FROM shopping_performance_view WHERE segments.date BETWEEN '${from}' AND '${to}'`);
  const products = parseProductRows(rows);
  const at = nowIso(nowMs);
  // New rows FIRST (batched, capped at the costliest MAX_STORED_ROWS), then drop the previous
  // window's rows: a failure part-way never leaves the table empty.
  const keep = [...products].sort((a, b) => b.cost - a.cost).slice(0, MAX_STORED_ROWS);
  await runBatched(db, keep.map((p) => db.prepare(
    `INSERT INTO media_products (store, item_id, title, product_id, window_from, window_to, cost, clicks, impressions, conversions, conv_value, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store, item_id) DO UPDATE SET title = excluded.title, product_id = excluded.product_id, window_from = excluded.window_from,
       window_to = excluded.window_to, cost = excluded.cost, clicks = excluded.clicks, impressions = excluded.impressions,
       conversions = excluded.conversions, conv_value = excluded.conv_value, fetched_at = excluded.fetched_at`
  ).bind(storeId, p.item_id, p.title, p.product_id, from, to, p.cost, p.clicks, p.impressions, p.conversions, p.conv_value, at)));
  await db.prepare(`DELETE FROM media_products WHERE store = ? AND fetched_at <> ?`).bind(storeId, at).run();

  const be = await storeBreakeven(db, storeId, from, to);
  const factor = await revenueCap(db, storeId, from, to);
  const minUsd = Number(env.MEDIA_PRODUCT_BURN_USD || BURN_MIN_USD_DEFAULT);
  const linesKnown = await haveLines(db, storeId, from, to);
  const sales = linesKnown ? await shopifySales(db, storeId, from, to) : null;
  const keys = [];
  let events = 0; let burning = 0; let losing = 0;
  for (const p of products.sort((a, b) => b.cost - a.cost)) {
    // Shopify sales are only "known" when lines exist for the window and the item maps to a product.
    const sold = sales && p.product_id ? (sales.get(p.product_id) || { units: 0, revenue: 0 }) : null;
    const j = judgeProduct(p, { breakeven: be.breakeven, factor, minUsd, real: sold, beText: breakevenLabel(be) });
    if (!j) continue;
    if (j.kind === "burning") burning += 1; else losing += 1;
    const key = `item:${p.item_id}`;
    keys.push(key);
    const summary = `${storeName(storeId)}: "${p.title || p.item_id}" ${j.kind === "burning" ? "spending without selling" : "losing money even when it sells"}: ${j.why}`;
    const isNew = await upsertFinding(db, { store: storeId, agent: AGENT, key, severity: j.severity, summary, at,
      data: { item_id: p.item_id, title: p.title, kind: j.kind, cost: p.cost, conversions: p.conversions, conv_value: p.conv_value,
        roas: j.roas ?? null, roas_basis: CAP_LABEL, real_roas: j.real_roas ?? null, shopify: sold, breakeven: be.breakeven, breakeven_estimated: be.estimated, window: { from, to } } });
    if (isNew && events < MAX_FLAG_EVENTS) {
      events += 1;
      await logEvent(db, { actor: AGENT, kind: "media.flag", store: storeId, target: "sys.ads", summary, data: { item_id: p.item_id, kind: j.kind }, at });
    }
  }
  await clearUnseen(db, { store: storeId, agent: AGENT, keys, at });
  await logEvent(db, {
    actor: AGENT, kind: "media.pulled", store: storeId, target: "sys.ads", at,
    summary: `${storeName(storeId)}: ${products.length} advertised products read (${from} to ${to}); ${burning} spending without selling, ${losing} under break-even${be.breakeven == null ? " (break-even unknown)" : ""}`,
    data: { products: products.length, burning, losing, breakeven: be.breakeven, revenue_cap: factor, breakeven_estimated: be.estimated, shopify_lines: linesKnown },
  });
  return `ok: ${products.length} products, ${burning} burning, ${losing} losing`;
}
