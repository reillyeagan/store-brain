/**
 * Orders backfill — gives the P&L a COMPLETE order history (fix after review, 2026-10-11).
 *
 * Why: webhooks only deliver orders placed after they were connected, and the 15-minute
 * reconciliation pull only reads the 25 most recently updated orders per store. Yesterday
 * and month-to-date would silently miss older orders, i.e. understate revenue (and hide
 * a loss as easily as a gain). So:
 *
 *  1. First pass (once per store): page every order created since the first day of the
 *     PREVIOUS month, oldest first, 50 per page, a few pages per 15-minute run. The cursor
 *     is saved after every page, so a run that stops half-way resumes where it left off.
 *     When the last page is read, `order_coverage` gets a row: from `covered_from` on,
 *     the ledger has every order. The P&L treats any earlier day (or a store with no row
 *     yet) as incomplete, profit null.
 *  2. Incremental (hourly afterwards): re-read orders UPDATED since the last pass (with
 *     a 2-hour overlap), the same way, so a burst bigger than the 15-minute pull's 25
 *     orders can't leave a hole.
 *
 * Quiet: orders go through the same `upsertOrder` as webhooks and the pull (same
 * out-of-order guard), but no per-order events: one summary line per store.
 * Line items are not read here (cost); orders without lines use the store's COGS rate.
 * Requested cost per page: 50 orders x 10 points + 2 ≈ 502 (limit 1,000), see ORDER_FIELDS.
 */
import { LIVE_STORE_IDS, STORES } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { upsertOrder } from "./shopifyWebhooks.js";
import { ORDER_FIELDS, orderFromNode } from "./reconcile.js";
import { claimJob } from "./jobRuns.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso } from "./time.js";
import { minusDays } from "./adsSpend.js";

export const BACKFILL_PAGE_SIZE = 50;
export const BACKFILL_PAGES_PER_RUN = 4; // 200 orders per store per run keeps the Worker well inside its limits
export const BACKFILL_EVERY_MIN = 15; // first pass: every cron run until done
export const INCREMENTAL_EVERY_MIN = 60;
export const INCREMENTAL_OVERLAP_MIN = 120;

const ACTOR = "pnl.pullers";

const backfillQuery = (sortKey) => `query OrdersBackfill($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: ${sortKey}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS}
    }
  }
}`;
export const BACKFILL_QUERY = backfillQuery("CREATED_AT");
export const INCREMENTAL_QUERY = backfillQuery("UPDATED_AT");

/** First day of the previous month, in the store's timezone. */
export function backfillFromDay(nowMs, tz) {
  const today = localDay(nowMs, tz);
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** The earliest fully-covered day for a store, or null when its backfill hasn't finished. */
export async function orderCoverage(db, storeId) {
  return db.prepare(`SELECT covered_from, completed_at FROM order_coverage WHERE store = ?`).bind(storeId).first();
}

async function readPages(env, id, store, { query, gql, cursor, opts, at, onPage }) {
  const tz = store.timezone || "America/New_York";
  let after = cursor || null, pages = 0, done = false, read = 0, added = 0, lastUpdated = null;
  while (pages < BACKFILL_PAGES_PER_RUN) {
    const data = await shopifyGraphQL(env, id, gql, { first: BACKFILL_PAGE_SIZE, after, query }, opts);
    const conn = data && data.orders;
    if (!conn) throw new Error(`${store.name}: Shopify returned no orders connection`);
    let pageAdded = 0;
    for (const node of conn.nodes || []) {
      const o = orderFromNode(node);
      if (!o.created_at) continue;
      const res = await upsertOrder(env.DB, store, o, JSON.stringify(node), tz, at);
      read++;
      if (res.isNew) { added++; pageAdded++; }
      if (node.updatedAt) lastUpdated = node.updatedAt;
    }
    pages++;
    const more = !!(conn.pageInfo && conn.pageInfo.hasNextPage);
    if (more) after = conn.pageInfo.endCursor;
    await onPage({ cursor: more ? after : null, nodes: (conn.nodes || []).length, added: pageAdded });
    if (!more) { done = true; break; }
  }
  return { pages, done, read, added, lastUpdated };
}

/** One store's backfill step. Returns what it did; throws on a Shopify fault (the caller logs it). */
export async function backfillStore(env, id, { nowMs = Date.now(), opts = {} } = {}) {
  const db = env.DB;
  const store = STORES[id];
  const tz = store.timezone || "America/New_York";
  const at = nowIso(nowMs);
  let st = await db.prepare(`SELECT * FROM order_backfill WHERE store = ?`).bind(id).first();
  const firstPass = !st || !st.completed_at;
  if (!(await claimJob(db, `orders.backfill.${id}`, firstPass ? BACKFILL_EVERY_MIN : INCREMENTAL_EVERY_MIN, nowMs))) {
    return { store: id, ran: false, reason: "not due" };
  }
  if (!st) {
    await db.prepare(
      `INSERT INTO order_backfill (store, query_from, started_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(store) DO NOTHING`
    ).bind(id, backfillFromDay(nowMs, tz), at, at).run();
    st = await db.prepare(`SELECT * FROM order_backfill WHERE store = ?`).bind(id).first();
  }

  if (firstPass) {
    // A day early on purpose: Shopify's search reads a bare date in the shop's timezone,
    // and an extra day of orders costs nothing (the P&L only counts covered_from onwards).
    const query = `created_at:>=${minusDays(st.query_from, 1)}`;
    const r = await readPages(env, id, store, {
      query, gql: BACKFILL_QUERY, cursor: st.cursor, opts, at,
      onPage: (p) => db.prepare(
        `UPDATE order_backfill SET cursor = ?, pages = pages + 1, orders = orders + ?, added = added + ?, updated_at = ? WHERE store = ?`
      ).bind(p.cursor, p.nodes, p.added, at, id).run(),
    });
    if (!r.done) {
      await db.prepare(`UPDATE job_runs SET last_result = ? WHERE job = ?`)
        .bind(`first pass: ${r.read} orders this run, more to read`, `orders.backfill.${id}`).run();
      return { store: id, ran: true, phase: "first", done: false, read: r.read, added: r.added };
    }
    // Finished: from query_from on the ledger has every order. Anything updated while the
    // pass ran is picked up by the first incremental pass (it starts at started_at).
    await db.prepare(`UPDATE order_backfill SET completed_at = ?, inc_since = ?, updated_at = ? WHERE store = ?`)
      .bind(at, st.started_at, at, id).run();
    await db.prepare(
      `INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, ?, ?)
       ON CONFLICT(store) DO UPDATE SET covered_from = excluded.covered_from, completed_at = excluded.completed_at`
    ).bind(id, st.query_from, at).run();
    const total = await db.prepare(`SELECT orders, added FROM order_backfill WHERE store = ?`).bind(id).first();
    await logEvent(db, {
      actor: ACTOR, kind: "orders.history_backfilled", store: id, target: "sys.shopify",
      summary: `${store.name}: order history complete from ${st.query_from} (${total.orders} orders read, ${total.added} were missing from the ledger)`,
      data: { covered_from: st.query_from, orders: total.orders, added: total.added }, at,
    });
    return { store: id, ran: true, phase: "first", done: true, read: r.read, added: r.added };
  }

  // Incremental: orders updated since the last pass, minus an overlap.
  const sinceMs = Date.parse(st.inc_since || st.completed_at) - INCREMENTAL_OVERLAP_MIN * 60000;
  const query = `updated_at:>='${new Date(sinceMs).toISOString()}'`;
  const r = await readPages(env, id, store, { query, gql: INCREMENTAL_QUERY, cursor: null, opts, at, onPage: async () => {} });
  // Read in full → next pass starts now; cut short → it carries on from the last order read.
  const next = r.done ? at : (r.lastUpdated ? new Date(Date.parse(r.lastUpdated) + INCREMENTAL_OVERLAP_MIN * 60000).toISOString() : st.inc_since);
  await db.prepare(`UPDATE order_backfill SET inc_since = ?, updated_at = ? WHERE store = ?`).bind(next, at, id).run();
  if (r.added) {
    await logEvent(db, {
      actor: ACTOR, kind: "orders.backfilled", store: id, target: "sys.shopify",
      summary: `${store.name}: hourly order check found ${r.added} order${r.added === 1 ? "" : "s"} the webhooks and 15-minute pull had missed`,
      data: { added: r.added, read: r.read }, at,
    });
  }
  return { store: id, ran: true, phase: "incremental", done: r.done, read: r.read, added: r.added };
}

/** The cron step across live stores. One store's failure never stops the others. */
export async function runOrderBackfill(env, { nowMs = Date.now(), opts = {} } = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    try {
      out.push(await backfillStore(env, id, { nowMs, opts }));
    } catch (err) {
      if (err.code === "NOT_WIRED") { out.push({ store: id, ran: false, skipped: "not wired" }); continue; }
      await logEvent(env.DB, {
        actor: ACTOR, kind: "error.orders_backfill", store: id, target: "sys.shopify",
        summary: `${STORES[id].name}: order history check failed; it resumes from where it stopped (${String(err.message).slice(0, 150)})`,
      }).catch(() => {});
      out.push({ store: id, ran: false, error: err.message });
    }
  }
  return out;
}
