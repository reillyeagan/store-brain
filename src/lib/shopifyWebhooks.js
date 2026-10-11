/**
 * Shopify webhook intake — how new orders and refunds reach the brain in seconds,
 * for every store (the old dash only refreshed H&C quickly; see docs/specs/pnl-finance.md).
 *
 * Topics handled: orders/create, orders/updated, refunds/create.
 * Every webhook is HMAC-verified with that store's own app secret before anything
 * is stored. The 15-minute reconciliation pulls remain the backstop.
 */
import { storeByDomain } from "../config/stores.js";
import { verifyWebhookHmac } from "./storeGuard.js";
import { logEvent } from "./eventlog.js";
import { markFeedOk } from "./freshness.js";
import { localDay, nowIso } from "./time.js";

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function parseOrder(o) {
  return {
    order_id: o.admin_graphql_api_id || `gid://shopify/Order/${o.id}`,
    name: o.name || null,
    created_at: o.created_at,
    currency: o.currency || null,
    subtotal: num(o.current_subtotal_price ?? o.subtotal_price),
    discounts: num(o.current_total_discounts ?? o.total_discounts),
    total: num(o.current_total_price ?? o.total_price),
    financial_status: o.financial_status || null,
  };
}

/** Refund amount = sum of its refund transactions (not an order-level aggregate). */
export function parseRefund(r) {
  const txs = Array.isArray(r.transactions) ? r.transactions : [];
  const refundTxs = txs.filter((t) => (t.kind || "").toLowerCase() === "refund");
  const amount = refundTxs.reduce((s, t) => s + (num(t.amount) || 0), 0);
  const statuses = [...new Set(refundTxs.map((t) => String(t.status || "").toUpperCase()).filter(Boolean))];
  return {
    refund_id: r.admin_graphql_api_id || `gid://shopify/Refund/${r.id}`,
    order_id: r.order_id ? `gid://shopify/Order/${r.order_id}` : null,
    processed_at: r.processed_at || r.created_at || null,
    amount: Math.round(amount * 100) / 100,
    // PENDING refunds report as "Paid" at order level; we keep their own status.
    status: statuses.length === 1 ? statuses[0] : statuses.length ? statuses.join("|") : "UNKNOWN",
  };
}

/**
 * @returns {Promise<Response>}
 */
export async function handleShopifyWebhook(request, env) {
  const raw = await request.text();
  const topic = request.headers.get("x-shopify-topic") || "";
  const domain = request.headers.get("x-shopify-shop-domain") || "";
  const hmac = request.headers.get("x-shopify-hmac-sha256") || "";
  const webhookId = request.headers.get("x-shopify-webhook-id") || null;

  const store = storeByDomain(domain);
  if (!store) return new Response("unknown shop", { status: 404 });
  const secret = env[store.secrets.clientSecret];
  if (!secret || !(await verifyWebhookHmac(raw, hmac, secret))) {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const tz = env.TIMEZONE || "America/New_York";
  const at = nowIso();

  if (topic === "orders/create" || topic === "orders/updated") {
    const o = parseOrder(body);
    await env.DB.prepare(
      `INSERT INTO orders (store, order_id, name, created_at, local_day, currency, subtotal, discounts, total, financial_status, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, order_id) DO UPDATE SET
         name = excluded.name, currency = excluded.currency, subtotal = excluded.subtotal,
         discounts = excluded.discounts, total = excluded.total,
         financial_status = excluded.financial_status, raw = excluded.raw, updated_at = excluded.updated_at`
    )
      .bind(store.id, o.order_id, o.name, o.created_at, localDay(o.created_at, tz), o.currency,
        o.subtotal, o.discounts, o.total, o.financial_status, raw, at)
      .run();
    await markFeedOk(env.DB, `shopify.orders.${store.id}`, at);
    await logEvent(env.DB, {
      actor: "pnl.pullers", kind: topic === "orders/create" ? "order.created" : "order.updated",
      store: store.id, target: "sys.shopify",
      summary: `${store.name} ${o.name || "order"} — $${(o.total ?? 0).toFixed(2)}${topic === "orders/updated" ? " (updated)" : ""}`,
      data: { orderId: o.order_id, webhookId }, at,
    });
    return new Response("ok");
  }

  if (topic === "refunds/create") {
    const r = parseRefund(body);
    await env.DB.prepare(
      `INSERT INTO refunds (store, refund_id, order_id, processed_at, local_day, amount, status, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, refund_id) DO UPDATE SET
         processed_at = excluded.processed_at, local_day = excluded.local_day, amount = excluded.amount,
         status = excluded.status, raw = excluded.raw, updated_at = excluded.updated_at`
    )
      .bind(store.id, r.refund_id, r.order_id, r.processed_at,
        r.processed_at ? localDay(r.processed_at, tz) : null, r.amount, r.status, raw, at)
      .run();
    await logEvent(env.DB, {
      actor: "pnl.refunds", kind: "refund.created", store: store.id, target: "sys.shopify",
      summary: `${store.name} refund $${r.amount.toFixed(2)} (${r.status})`,
      data: { refundId: r.refund_id, orderId: r.order_id, webhookId }, at,
    });
    return new Response("ok");
  }

  // Valid but unhandled topic: acknowledge so Shopify doesn't retry forever.
  return new Response("ignored");
}
