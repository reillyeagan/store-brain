/**
 * Reconciliation pull — the backstop behind webhooks, every 15 minutes.
 *
 * Reads each live store's most recently updated orders straight from Shopify and
 * upserts them. Two jobs:
 *  1. Catch anything a webhook missed (logged as "order.backfilled", which should be rare).
 *  2. Keep the orders feed honestly "fresh": the feed is marked OK only when Shopify
 *     actually answered, so a quiet store with no orders is still green, and a broken
 *     connection turns red within one check.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { upsertOrder } from "./shopifyWebhooks.js";
import { markFeedOk, markFeedFailed } from "./freshness.js";
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";

const RECENT_ORDERS = `{
  orders(first: 25, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id name createdAt updatedAt currencyCode displayFinancialStatus
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
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
    financial_status: n.displayFinancialStatus ? String(n.displayFinancialStatus).toLowerCase() : null,
    payload_updated_at: n.updatedAt || n.createdAt || null,
  };
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
      for (const node of data.orders.nodes) {
        const o = orderFromNode(node);
        if (!o.created_at) continue;
        const isNew = await upsertOrder(env.DB, store, o, JSON.stringify(node), store.timezone || "America/New_York", at);
        if (isNew) {
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
      out.push({ store: id, ok: true, seen: data.orders.nodes.length, backfilled });
    } catch (err) {
      // A store with no credentials yet is "not wired", not "failing": stay quiet.
      if (err.code === "NOT_WIRED") { out.push({ store: id, ok: false, skipped: "not wired" }); continue; }
      await markFeedFailed(env.DB, feed, err.message, at).catch(() => {});
      out.push({ store: id, ok: false, error: err.message });
    }
  }
  return out;
}
