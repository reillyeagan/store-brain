/**
 * Refund events puller — the 15-minute backstop behind the refunds/create webhook.
 *
 * Why: refunds are EVENTS (rule 7), booked on the day the refund transaction was
 * PROCESSED, in the store's timezone, and PENDING ones count (with their status).
 * Webhooks catch new refunds in seconds, but a PENDING refund only turns SUCCESS (or
 * FAILURE) later and Shopify sends no refunds/create for that. So every 15 minutes we:
 *   1. re-read orders updated since the last good pull (minus 2 h overlap), and
 *   2. re-read every order whose refund is still PENDING in the ledger.
 * Both go through summarizeRefund, the same rule the webhook uses.
 *
 * Query cost: 10 orders × 3 refunds × 4 transactions ≈ 430 points per page (limit 1,000).
 * Field names checked against the Admin GraphQL schema, 2026-10-11:
 *   Order.refunds(first) → Refund { id createdAt processedAt transactions { nodes {
 *   id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } } } } }
 */
import { backfillFromDay } from "./orderBackfill.js";
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { summarizeRefund, upsertRefund } from "./shopifyWebhooks.js";
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";

const REFUND_FIELDS = `
  id name updatedAt
  refunds(first: 3) {
    id createdAt processedAt
    transactions(first: 4) {
      nodes { id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } } }
    }
  }`;

export const ORDERS_PER_PAGE = 10;
export const MAX_PAGES = 10;
export const FIRST_LOOKBACK_DAYS = 7;
export const OVERLAP_MIN = 120;

export const RECENT_REFUNDS = `query RecentRefunds($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${REFUND_FIELDS} }
  }
}`;

export const REFUNDS_BY_ORDER = `query RefundsByOrder($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order { ${REFUND_FIELDS} } }
}`;

/** Pure: GraphQL refund node → the shared refund shape. */
export function refundFromNode(orderId, n) {
  const txs = ((n.transactions && n.transactions.nodes) || []).map((t) => ({
    kind: t.kind,
    status: t.status,
    amount: t.amountSet && t.amountSet.shopMoney ? t.amountSet.shopMoney.amount : null,
    processedAt: t.processedAt || t.createdAt || null,
  }));
  return summarizeRefund({ refundId: n.id, orderId, refundProcessedAt: n.processedAt || n.createdAt, transactions: txs });
}

const watermarkJob = (storeId) => `refunds.${storeId}`;

async function storeRefunds(env, storeId, nodes, ctx) {
  const { tz, at, initial, store } = ctx;
  for (const o of nodes) {
    if (!o || !Array.isArray(o.refunds)) continue;
    for (const rn of o.refunds) {
      const r = refundFromNode(o.id, rn);
      const before = await upsertRefund(env.DB, storeId, r, JSON.stringify(rn), tz, at);
      ctx.seen++;
      if (!before) {
        ctx.added++;
        if (initial) continue; // first import: one summary line, not one per refund
        await logEvent(env.DB, {
          actor: "pnl.refunds", kind: "refund.backfilled", store: storeId, target: "sys.shopify",
          summary: `${store.name} ${o.name || "order"} refund $${r.amount.toFixed(2)} (${r.status}) — found by the refund check`,
          data: { refundId: r.refund_id, orderId: o.id }, at,
        });
      } else if (before.status !== r.status || Number(before.amount) !== r.amount) {
        ctx.changed++;
        await logEvent(env.DB, {
          actor: "pnl.refunds", kind: "refund.status_changed", store: storeId, target: "sys.shopify",
          summary: `${store.name} ${o.name || "order"} refund ${before.status} $${Number(before.amount).toFixed(2)} → ${r.status} $${r.amount.toFixed(2)}`,
          data: { refundId: r.refund_id, orderId: o.id, from: before.status, to: r.status }, at,
        });
      }
    }
  }
}

export async function pullStoreRefunds(env, storeId, opts = {}) {
  const store = STORES[storeId];
  const nowMs = opts.nowMs || Date.now();
  const at = nowIso(nowMs);
  const tz = store.timezone || env.TIMEZONE || "America/New_York";
  const mark = await env.DB.prepare(`SELECT last_run_at FROM job_runs WHERE job = ?`).bind(watermarkJob(storeId)).first();
  // Coverage is only proven by ONE uninterrupted chain of reads that started at start_day
  // (the first day of the previous month, clamped inside Shopify's 60-day window). Until
  // that chain reaches "now", every run continues the chain from cursor_at — never from the
  // ordinary watermark — so a failed or partial run can't be mistaken for a full read.
  const windowStart = backfillFromDay(nowMs, tz);
  let cov = await env.DB.prepare(`SELECT start_day, covered_from, cursor_at FROM feed_coverage WHERE store = ? AND feed = 'refunds'`).bind(storeId).first();
  const fullMode = !cov || !cov.covered_from;
  if (fullMode && (!cov || cov.start_day < windowStart)) {
    // No chain yet, or the chain started outside the readable window: (re)start it.
    await env.DB.prepare(
      `INSERT INTO feed_coverage (store, feed, start_day, covered_from, cursor_at, updated_at) VALUES (?, 'refunds', ?, NULL, NULL, ?)
       ON CONFLICT(store, feed) DO UPDATE SET start_day = excluded.start_day, cursor_at = NULL, updated_at = excluded.updated_at
       WHERE feed_coverage.covered_from IS NULL`
    ).bind(storeId, windowStart, at).run();
    cov = { start_day: windowStart, covered_from: null, cursor_at: null };
  }
  const startDay = cov.start_day;
  const initial = fullMode && !cov.cursor_at;
  const sinceMs = fullMode
    ? (cov.cursor_at ? Date.parse(cov.cursor_at) - OVERLAP_MIN * 60000 : Date.parse(`${startDay}T00:00:00Z`) - 86400000)
    : (mark ? Date.parse(mark.last_run_at) - OVERLAP_MIN * 60000 : nowMs - 86400000);
  const ctx = { tz, at, initial, store, seen: 0, added: 0, changed: 0 };

  // 1. Orders updated since the last good pull, OLDEST first: if there are more than one
  // run reads, the watermark moves to the last order read and the next run carries on.
  let after = null, pages = 0, truncated = false, lastUpdated = null;
  const query = `updated_at:>='${new Date(sinceMs).toISOString()}'`;
  for (;;) {
    const data = await shopifyGraphQL(env, storeId, RECENT_REFUNDS, { first: ORDERS_PER_PAGE, after, query }, opts);
    const conn = data && data.orders;
    const nodes = (conn && conn.nodes) || [];
    await storeRefunds(env, storeId, nodes, ctx);
    for (const n of nodes) if (n && n.updatedAt) lastUpdated = n.updatedAt;
    pages++;
    if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    after = conn.pageInfo.endCursor;
  }

  // 2. Every order with a refund still PENDING in the ledger, whatever its updated_at.
  const { results: pend } = await env.DB.prepare(
    `SELECT DISTINCT order_id FROM refunds WHERE store = ? AND status LIKE '%PENDING%' AND order_id IS NOT NULL`
  ).bind(storeId).all();
  const ids = (pend || []).map((r) => r.order_id);
  for (let i = 0; i < ids.length; i += ORDERS_PER_PAGE) {
    const data = await shopifyGraphQL(env, storeId, REFUNDS_BY_ORDER, { ids: ids.slice(i, i + ORDERS_PER_PAGE) }, opts);
    await storeRefunds(env, storeId, (data && data.nodes) || [], ctx);
  }

  if (initial && ctx.added) {
    await logEvent(env.DB, {
      actor: "pnl.refunds", kind: "refunds.imported", store: storeId, target: "sys.shopify",
      summary: `${store.name}: first refund check, recorded ${ctx.added} refund${ctx.added === 1 ? "" : "s"} since ${startDay}`, at,
    });
  }
  if (truncated) {
    await logEvent(env.DB, {
      actor: "pnl.refunds", kind: "refunds.partial", store: storeId, target: "sys.shopify",
      summary: `${store.name}: more updated orders than one refund check reads (${pages * ORDERS_PER_PAGE}+); the rest are read on the next check`, at,
    });
  }
  // Watermark only after a successful read: "now" when the window was read in full, else
  // the last order read (plus the overlap, so the next run picks up exactly there).
  const mark2 = truncated && lastUpdated ? new Date(Date.parse(lastUpdated) + OVERLAP_MIN * 60000).toISOString() : at;
  await env.DB.prepare(
    `INSERT INTO job_runs (job, last_run_at) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at`
  ).bind(watermarkJob(storeId), mark2).run();
  // Full-read chain: move its own cursor, or — once it has caught up to now — prove coverage.
  if (fullMode) {
    if (truncated) {
      await env.DB.prepare(`UPDATE feed_coverage SET cursor_at = ?, updated_at = ? WHERE store = ? AND feed = 'refunds' AND covered_from IS NULL`)
        .bind(lastUpdated || cov.cursor_at || null, at, storeId).run();
    } else {
      await env.DB.prepare(`UPDATE feed_coverage SET covered_from = start_day, cursor_at = NULL, updated_at = ? WHERE store = ? AND feed = 'refunds' AND covered_from IS NULL`)
        .bind(at, storeId).run();
    }
  }
  return { store: storeId, ok: true, seen: ctx.seen, added: ctx.added, changed: ctx.changed, pendingRechecked: ids.length, truncated };
}

/** The refunds job across live stores. One store's failure never stops the others. */
export async function pullRefunds(env, opts = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    try {
      out.push(await pullStoreRefunds(env, id, opts));
    } catch (err) {
      if (err.code === "NOT_WIRED") { out.push({ store: id, ok: false, skipped: "not wired" }); continue; }
      await logEvent(env.DB, {
        actor: "pnl.refunds", kind: "error.refunds_pull", store: id, target: "sys.shopify",
        summary: `${STORES[id].name}: refund check failed; will try again (${String(err.message).slice(0, 150)})`,
      }).catch(() => {});
      out.push({ store: id, ok: false, error: err.message });
    }
  }
  return out;
}
