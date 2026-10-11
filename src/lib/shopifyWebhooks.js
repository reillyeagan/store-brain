/**
 * Shopify webhook intake — how new orders and refunds reach the brain in seconds,
 * for every store (the old dash only refreshed H&C quickly; see docs/specs/pnl-finance.md).
 *
 * Topics handled: orders/create, orders/updated, refunds/create.
 * Every webhook is HMAC-verified with that store's own app secret before anything
 * is stored. The 15-minute reconciliation pulls remain the backstop.
 */
import { storeByDomain, STORES, STORE_IDS } from "../config/stores.js";
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
    payload_updated_at: o.updated_at || o.created_at || null,
  };
}

/**
 * Refund amount = sum of its refund transactions that moved (or are moving) money:
 * SUCCESS and PENDING. FAILURE/ERROR transactions are kept in the status, never in the amount.
 * Note: PENDING refunds only change status later; the reconciliation pull (Phase 2)
 * re-reads refund transactions and updates `refunds.status`.
 */
export function parseRefund(r) {
  const txs = Array.isArray(r.transactions) ? r.transactions : [];
  const refundTxs = txs.filter((t) => (t.kind || "").toLowerCase() === "refund");
  const counted = refundTxs.filter((t) => ["success", "pending"].includes(String(t.status || "").toLowerCase()));
  const amount = counted.reduce((s, t) => s + (num(t.amount) || 0), 0);
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
 * Insert or update one order. Shared by webhooks and the reconciliation pull.
 * Webhooks can arrive out of order: an older payload never overwrites a newer one.
 * @returns {Promise<{isNew: boolean, moneyChanged: boolean, before: object|null, after: object|null}>}
 *   isNew: the order was not in the ledger before.
 *   moneyChanged: an existing order's total or payment status actually changed in the ledger.
 *   Shopify sends orders/updated for every tag, note or fulfilment step; only money changes
 *   are worth a line in the Activity feed.
 */
export async function upsertOrder(db, store, o, raw, tz, at) {
  const readMoney = () =>
    db.prepare(`SELECT total, financial_status FROM orders WHERE store = ? AND order_id = ?`).bind(store.id, o.order_id).first();
  const before = await readMoney();
  await db.prepare(
      `INSERT INTO orders (store, order_id, name, created_at, local_day, currency, subtotal, discounts, total, financial_status, raw, payload_updated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, order_id) DO UPDATE SET
         name = excluded.name, currency = excluded.currency, subtotal = excluded.subtotal,
         discounts = excluded.discounts, total = excluded.total,
         financial_status = excluded.financial_status, raw = excluded.raw,
         payload_updated_at = excluded.payload_updated_at, updated_at = excluded.updated_at
       WHERE orders.payload_updated_at IS NULL OR excluded.payload_updated_at >= orders.payload_updated_at`
    )
    .bind(store.id, o.order_id, o.name, o.created_at, localDay(o.created_at, tz), o.currency,
      o.subtotal, o.discounts, o.total, o.financial_status, raw, o.payload_updated_at, at)
    .run();
  // Compare against what the ledger now holds, not the payload: an older payload is skipped.
  const after = await readMoney();
  const moneyChanged = !!before && !!after &&
    (before.total !== after.total || (before.financial_status || null) !== (after.financial_status || null));
  return { isNew: !before, moneyChanged, before: before || null, after: after || null };
}

const money = (v) => (v == null ? "amount unknown" : "$" + Number(v).toFixed(2));

/** One readable line for a money change, e.g. "$100.00 → $0.00, paid → refunded". */
export function describeMoneyChange(before, after) {
  const parts = [];
  if (before.total !== after.total) parts.push(`${money(before.total)} → ${money(after.total)}`);
  if ((before.financial_status || null) !== (after.financial_status || null)) {
    parts.push(`${before.financial_status || "unknown"} → ${after.financial_status || "unknown"}`);
  }
  return parts.join(", ");
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
  // The signature covers the body, not the shop-domain header. That's only safe if every
  // store has its OWN app secret, so a shared secret is refused outright.
  const shared = STORE_IDS.some((id) => id !== store.id && env[STORES[id].secrets.clientSecret] === secret);
  if (secret && shared) {
    return new Response("misconfigured: stores must not share an app secret", { status: 500 });
  }
  if (!secret || !(await verifyWebhookHmac(raw, hmac, secret))) {
    return new Response("unauthorized", { status: 401 });
  }
  // Stores that aren't live get no rows. Acknowledge so Shopify doesn't retry.
  if (!store.live) return new Response("ignored: store not live");

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const tz = store.timezone || env.TIMEZONE || "America/New_York";
  const at = nowIso();

  // A webhook delivered twice (Shopify retries, or a replay) is processed once.
  if (webhookId) {
    const seen = await env.DB.prepare(
      `INSERT INTO webhooks_seen (webhook_id, store, topic, at) VALUES (?, ?, ?, ?) ON CONFLICT(webhook_id) DO NOTHING`
    ).bind(webhookId, store.id, topic, at).run();
    if (seen.meta && seen.meta.changes === 0) return new Response("duplicate");
  }

  if (topic === "orders/create" || topic === "orders/updated") {
    const o = parseOrder(body);
    if (!o.created_at || Number.isNaN(Date.parse(o.created_at))) {
      return new Response("bad payload: no created_at", { status: 400 });
    }
    const res = await upsertOrder(env.DB, store, o, raw, tz, at);
    await markFeedOk(env.DB, `shopify.orders.${store.id}`, at);
    const label = `${store.name} ${o.name || "order"}`;
    if (res.isNew) {
      // First time we see it, whichever topic arrived first.
      await logEvent(env.DB, {
        actor: "pnl.pullers", kind: "order.created", store: store.id, target: "sys.shopify",
        summary: `${label} — ${money(o.total)}`, data: { orderId: o.order_id, webhookId }, at,
      });
    } else if (res.moneyChanged) {
      await logEvent(env.DB, {
        actor: "pnl.pullers", kind: "order.updated", store: store.id, target: "sys.shopify",
        summary: `${label} changed: ${describeMoneyChange(res.before, res.after)}`, data: { orderId: o.order_id, webhookId }, at,
      });
    }
    // Tag/note/fulfilment-only updates are stored silently.
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
