/**
 * Reconciliation pull — the backstop behind webhooks, every 15 minutes.
 *
 * Reads each live store's most recently updated orders straight from Shopify and
 * upserts them. Two jobs:
 *  1. Catch anything a webhook missed (logged as "order.backfilled", which should be rare).
 *  2. Keep the orders feed honestly "fresh": the feed is marked OK only when Shopify
 *     actually answered, so a quiet store with no orders is still green, and a broken
 *     connection turns red within one check.
 *
 * Line items come from a second, small query, only for orders whose stored lines are
 * behind the order (`lines_for_updated_at`). Why not one query: Shopify refuses any query
 * whose requested cost is over 1,000 points, and 25 orders × 50 nested line items (each
 * with price, variant options and product) is several thousand. Asking only for the few
 * orders that changed also keeps the pull cheap every 15 minutes.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { upsertOrder, describeMoneyChange, utcIso } from "./shopifyWebhooks.js";
import { shippingFromNode, linesFromNode, replaceOrderLines } from "./orderLines.js";
import { markFeedOk, markFeedFailed } from "./freshness.js";
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";

/**
 * The order fields every pull reads (shared with the orders backfill).
 *  - `test`: Shopify test orders are excluded from P&L revenue.
 *  - `totalPriceSet`: the ORIGINAL order total ("before returns"), which is the P&L
 *    revenue basis; refunds are booked separately on their processed day (rule 7).
 *  - `currentTotalPriceSet`: the current total (after refunds/edits), kept as `orders.total`.
 *  - `subtotalPriceSet`, `totalTaxSet`, `taxesIncluded`: the ORIGINAL subtotal (line items after
 *    discounts, no shipping, no tax), for the P&L sheets' revenue definition (pnl/sheets.js).
 * Requested cost per order: the Order 1 + 6 MoneyBags x 2 (bag + shopMoney) + shippingLine 1
 * = 14 points; 25 orders ≈ 352 points, 50 orders ≈ 702 (Shopify's limit is 1,000).
 */
export const ORDER_FIELDS = `
      id name createdAt updatedAt test currencyCode displayFinancialStatus
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      subtotalPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      taxesIncluded
      shippingLine { title code }`;

const RECENT_ORDERS = `{
  orders(first: 25, sortKey: UPDATED_AT, reverse: true) {
    nodes { ${ORDER_FIELDS}
    }
  }
}`;

/**
 * Line items for a few orders at a time. Requested cost per order is about
 * 3 + 30 × 6 ≈ 183 points, so 4 orders per call stays well under Shopify's 1,000 limit.
 * Orders with more than 30 lines are not expected (KFB dropshipping, 1–3 items typical).
 */
export const LINES_PER_ORDER = 30;
export const ORDERS_PER_LINES_CALL = 4;
export const ORDER_LINES = `query OrderLines($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id updatedAt
      lineItems(first: ${LINES_PER_ORDER}) {
        nodes {
          id name title sku quantity variantTitle
          originalUnitPriceSet { shopMoney { amount } }
          variant { id selectedOptions { name value } }
          product { id handle }
        }
      }
    }
  }
}`;

const amt = (m) => {
  const n = parseFloat(m && m.shopMoney && m.shopMoney.amount);
  return Number.isFinite(n) ? n : null;
};

/** Map a GraphQL order node to the same shape webhooks produce. */
export function orderFromNode(n) {
  return {
    order_id: n.id,
    name: n.name || null,
    created_at: n.createdAt,
    currency: n.currencyCode || null,
    subtotal: amt(n.currentSubtotalPriceSet),
    discounts: amt(n.currentTotalDiscountsSet),
    total: amt(n.currentTotalPriceSet),
    original_total: amt(n.totalPriceSet), // revenue basis; the P&L reads it from `raw`
    test: n.test === true,
    financial_status: n.displayFinancialStatus ? String(n.displayFinancialStatus).toLowerCase() : null,
    payload_updated_at: utcIso(n.updatedAt || n.createdAt),
    ...shippingFromNode(n), // shipping_title, shipping_code, express
    // Lines arrive separately (see ORDER_LINES); unless this node already carries them.
    lines: linesFromNode(n),
  };
}

/**
 * Fetch and store line items for the orders whose stored lines are behind.
 * Only orders this pull actually wrote are considered (the out-of-order guard).
 */
export async function syncLines(env, id, writtenIds, at, opts) {
  if (!writtenIds.length) return 0;
  const behind = [];
  for (const orderId of writtenIds) {
    const row = await env.DB.prepare(
      `SELECT lines_for_updated_at, payload_updated_at FROM orders WHERE store = ? AND order_id = ?`
    ).bind(id, orderId).first();
    if (row && (!row.lines_for_updated_at || row.lines_for_updated_at < row.payload_updated_at)) behind.push(orderId);
  }
  let synced = 0;
  for (let i = 0; i < behind.length; i += ORDERS_PER_LINES_CALL) {
    const ids = behind.slice(i, i + ORDERS_PER_LINES_CALL);
    const data = await shopifyGraphQL(env, id, ORDER_LINES, { ids }, opts);
    for (const n of (data && Array.isArray(data.nodes) ? data.nodes : [])) {
      const lines = n ? linesFromNode(n) : null;
      if (!lines || !ids.includes(n.id)) continue;
      await replaceOrderLines(env.DB, id, n.id, lines, utcIso(n.updatedAt), at);
      synced++;
    }
  }
  return synced;
}

export async function reconcileOrders(env, opts = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    const store = STORES[id];
    const feed = `shopify.orders.${id}`;
    const at = nowIso();
    try {
      const data = await shopifyGraphQL(env, id, RECENT_ORDERS, {}, opts);
      // First ever pull for this store: import quietly and log one line, not 25.
      const had = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = ?`).bind(id).first();
      const initial = !had || Number(had.n) === 0;
      let backfilled = 0;
      const written = [];
      for (const node of data.orders.nodes) {
        const o = orderFromNode(node);
        if (!o.created_at) continue;
        const res = await upsertOrder(env.DB, store, o, JSON.stringify(node), store.timezone || "America/New_York", at);
        if (res.written && !Array.isArray(o.lines)) written.push(o.order_id);
        // Whoever writes a money change first logs it: if this pull beats the webhook,
        // the webhook will find nothing new, so the line must come from here.
        if (res.moneyChanged) {
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "order.updated", store: id, target: "sys.shopify",
            summary: `${store.name} ${o.name || "order"} changed: ${describeMoneyChange(res.before, res.after)} (found by the 15-minute check)`,
            data: { orderId: o.order_id }, at,
          });
        }
        if (res.isNew) {
          backfilled++;
          if (initial) continue;
          await logEvent(env.DB, {
            actor: "pnl.pullers", kind: "order.backfilled", store: id, target: "sys.shopify",
            summary: `${store.name} ${o.name || "order"} — ${o.total == null ? "amount unknown" : "$" + o.total.toFixed(2)} (found by the 15-minute check)`,
            data: { orderId: o.order_id }, at,
          });
        }
      }
      if (initial && backfilled) {
        await logEvent(env.DB, {
          actor: "pnl.pullers", kind: "orders.imported", store: id, target: "sys.shopify",
          summary: `${store.name}: first connection, imported its ${backfilled} most recent orders`, at,
        });
      }
      await markFeedOk(env.DB, feed, at);
      // Lines are detail, not the orders feed itself: a failure here is logged and
      // retried next run (the lines stay "behind"), but doesn't turn the orders feed red.
      let linesSynced = 0;
      try {
        linesSynced = await syncLines(env, id, written, at, opts);
      } catch (err) {
        await logEvent(env.DB, {
          actor: "pnl.pullers", kind: "order.lines_failed", store: id, target: "sys.shopify",
          summary: `${store.name}: couldn't read order line items this run; will retry in 15 minutes (${String(err.message).slice(0, 150)})`, at,
        });
      }
      out.push({ store: id, ok: true, seen: data.orders.nodes.length, backfilled, linesSynced });
    } catch (err) {
      // A store with no credentials yet is "not wired", not "failing": stay quiet.
      if (err.code === "NOT_WIRED") { out.push({ store: id, ok: false, skipped: "not wired" }); continue; }
      await markFeedFailed(env.DB, feed, err.message, at).catch(() => {});
      out.push({ store: id, ok: false, error: err.message });
    }
  }
  return out;
}
