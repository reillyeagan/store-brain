/**
 * Order (and refund) history EXTENSION — moves each store's P&L history back to HISTORY_FROM
 * (2026-07-01), safely. Reilly, 2026-10-14: "use the spreadsheets to fill in accurate data for
 * every single day we have".
 *
 * Why it is separate from the first pass (orderBackfill.js): the first pass already proved the
 * ledger has every order from `order_coverage.covered_from` on (the 1st of the previous month,
 * clamped inside Shopify's 60-day window). Re-running it from an earlier day would throw that
 * proof away. The extension only reads the gap BEFORE it, and only moves `covered_from` back
 * once the gap has been read to the end:
 *
 *  1. Orders: every order CREATED in [ext_from, covered_from), oldest first, a few pages per
 *     run, cursor saved per page. Done → order_coverage.covered_from = ext_from.
 *  2. Refunds: refunds are booked by processed day, and a refund always updates its order.
 *     The refunds chain already read every order UPDATED since (its start - 1 day). So reading
 *     every order updated in [ext_from - 1 day, that start - 1 day + 2 h) closes the gap.
 *     Done → feed_coverage (refunds) start_day / covered_from = ext_from.
 *
 * How far back: Shopify silently hides orders older than 60 days unless the app has the
 * read_all_orders scope. The scope is checked LIVE (currentAppInstallation.accessScopes):
 * granted → HISTORY_FROM; not granted → the same 58-day clamp the first pass uses (so with the
 * scope missing the brain gains the days still inside the window, and says why it stopped there).
 * If the window moves past ext_from while a pass without the scope is running, it restarts.
 *
 * Days that can't be proven stay "open" in the P&L with the reason ("order history only covers
 * ... onwards" / "refunds only read from ..."); the P&L Sheets agent never papers over that.
 */
import { LIVE_STORE_IDS, STORES, HISTORY_FROM } from "../config/stores.js";
import { shopifyGraphQL } from "./storeGuard.js";
import { upsertOrder } from "./shopifyWebhooks.js";
import { orderFromNode } from "./reconcile.js";
import { BACKFILL_QUERY, BACKFILL_PAGE_SIZE } from "./orderBackfill.js";
import { RECENT_REFUNDS, ORDERS_PER_PAGE, OVERLAP_MIN, storeRefunds } from "./refunds.js";
import { claimJob } from "./jobRuns.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso, startOfLocalDayMs } from "./time.js";

export const EXT_EVERY_MIN = 15;
export const EXT_ORDER_PAGES_PER_RUN = 4;   // 200 orders per store per run, like the first pass
export const EXT_REFUND_PAGES_PER_RUN = 8;  // 80 orders per store per run (refund pages are dearer)
export const CLAMP_DAYS = 58;
const ACTOR = "pnl.pullers";

const SCOPES_QUERY = `{ currentAppInstallation { accessScopes { handle } } }`;

/** How far back this store can go: HISTORY_FROM with read_all_orders, else the 58-day clamp. */
export function extensionTarget(nowMs, tz, allOrders, historyFrom = HISTORY_FROM) {
  if (allOrders) return historyFrom;
  const clamp = localDay(nowMs - CLAMP_DAYS * 86400000, tz);
  return clamp > historyFrom ? clamp : historyFrom;
}

/** Re-check a missing read_all_orders scope this often. */
export const SCOPE_RECHECK_MIN = 60; // hourly, so a newly granted scope is picked up the same hour

/** Does the store's app have read_all_orders right now (asked live)? */
async function hasAllOrders(env, id, opts) {
  const data = await shopifyGraphQL(env, id, SCOPES_QUERY, {}, opts);
  const handles = ((data && data.currentAppInstallation && data.currentAppInstallation.accessScopes) || []).map((s) => s.handle);
  return handles.includes("read_all_orders");
}

/** One store's extension step. Throws on a Shopify fault (the caller logs it; the cursor stays). */
export async function extendStoreHistory(env, id, { nowMs = Date.now(), opts = {} } = {}) {
  const db = env.DB;
  const store = STORES[id];
  const tz = store.timezone || "America/New_York";
  const at = nowIso(nowMs);
  const cov = await db.prepare(`SELECT covered_from FROM order_coverage WHERE store = ?`).bind(id).first();
  let st = await db.prepare(`SELECT * FROM order_backfill WHERE store = ?`).bind(id).first();
  // Only after the first pass has proven its own range.
  if (!cov || !st || !st.completed_at) return { store: id, ran: false, reason: "first pass not finished" };
  if (st.ext_done_at && st.ref_ext_done_at) {
    // Finished WITHOUT read_all_orders: check the scope once a day, and start again from
    // HISTORY_FROM the day it is granted.
    if (Number(st.ext_all_orders) === 1) return { store: id, ran: false, done: true };
    if (st.ext_checked_at && nowMs - Date.parse(st.ext_checked_at) < SCOPE_RECHECK_MIN * 60000) return { store: id, ran: false, done: true };
    if (!(await claimJob(db, `orders.history_ext.${id}`, EXT_EVERY_MIN, nowMs))) return { store: id, ran: false, reason: "not due" };
    const granted = await hasAllOrders(env, id, opts);
    await db.prepare(`UPDATE order_backfill SET ext_checked_at = ? WHERE store = ?`).bind(at, id).run();
    if (!granted) return { store: id, ran: true, done: true, note: "read_all_orders still not granted" };
    await db.prepare(`UPDATE order_backfill SET ext_from = NULL, ext_done_at = NULL, ref_ext_done_at = NULL WHERE store = ?`).bind(id).run();
    st = await db.prepare(`SELECT * FROM order_backfill WHERE store = ?`).bind(id).first();
  } else if (!(await claimJob(db, `orders.history_ext.${id}`, EXT_EVERY_MIN, nowMs))) return { store: id, ran: false, reason: "not due" };

  // Start (or restart): decide how far back, from the scopes Shopify reports right now.
  if (!st.ext_from) {
    const allOrders = await hasAllOrders(env, id, opts);
    await db.prepare(`UPDATE order_backfill SET ext_checked_at = ? WHERE store = ?`).bind(at, id).run();
    const target = extensionTarget(nowMs, tz, allOrders);
    if (target >= cov.covered_from) {
      const note = allOrders ? `history already covers ${cov.covered_from}` : `read_all_orders not granted: Shopify only shows the last 60 days, and history already covers ${cov.covered_from}`;
      await db.prepare(`UPDATE order_backfill SET ext_from = ?, ext_to = ?, ext_all_orders = ?, ext_done_at = ?, ref_ext_done_at = ?, ext_note = ? WHERE store = ?`)
        .bind(cov.covered_from, cov.covered_from, allOrders ? 1 : 0, at, at, note, id).run();
      return { store: id, ran: true, done: true, note };
    }
    const note = allOrders ? null : `read_all_orders not granted: history can only reach ${target} (Shopify hides older orders)`;
    await db.prepare(`UPDATE order_backfill SET ext_from = ?, ext_to = ?, ext_all_orders = ?, ext_cursor = NULL, ext_orders = 0, ext_done_at = NULL, ref_ext_cursor = NULL, ref_ext_done_at = NULL, ext_note = ? WHERE store = ?`)
      .bind(target, cov.covered_from, allOrders ? 1 : 0, note, id).run();
    st = await db.prepare(`SELECT * FROM order_backfill WHERE store = ?`).bind(id).first();
  }

  // 1. Orders created in [ext_from, ext_to).
  if (!st.ext_done_at) {
    const query = `created_at:>='${new Date(startOfLocalDayMs(st.ext_from, tz)).toISOString()}' created_at:<'${new Date(startOfLocalDayMs(st.ext_to, tz)).toISOString()}'`;
    let after = st.ext_cursor || null, pages = 0, done = false, read = 0;
    while (pages < EXT_ORDER_PAGES_PER_RUN) {
      const data = await shopifyGraphQL(env, id, BACKFILL_QUERY, { first: BACKFILL_PAGE_SIZE, after, query }, opts);
      const conn = data && data.orders;
      if (!conn) throw new Error(`${store.name}: Shopify returned no orders connection`);
      for (const node of conn.nodes || []) {
        const o = orderFromNode(node);
        if (!o.created_at) continue;
        await upsertOrder(db, store, o, JSON.stringify(node), tz, at);
        read++;
      }
      pages++;
      const more = !!(conn.pageInfo && conn.pageInfo.hasNextPage);
      after = more ? conn.pageInfo.endCursor : null;
      await db.prepare(`UPDATE order_backfill SET ext_cursor = ?, ext_orders = ext_orders + ? WHERE store = ?`).bind(after, (conn.nodes || []).length, id).run();
      if (!more) { done = true; break; }
    }
    if (!done) return { store: id, ran: true, phase: "orders", done: false, read };
    // Without read_all_orders, a pass that ran while the 60-day window moved past its start
    // may have missed orders Shopify had just hidden: start again from the new window.
    if (!st.ext_all_orders && st.ext_from < localDay(nowMs - (CLAMP_DAYS + 1) * 86400000, tz)) {
      await db.prepare(`UPDATE order_backfill SET ext_from = NULL WHERE store = ?`).bind(id).run();
      return { store: id, ran: true, phase: "orders", done: false, restarted: true };
    }
    // Only move coverage back if it still starts where this pass ended (nothing else moved it).
    const moved = await db.prepare(`UPDATE order_coverage SET covered_from = ? WHERE store = ? AND covered_from = ?`).bind(st.ext_from, id, st.ext_to).run();
    await db.prepare(`UPDATE order_backfill SET ext_done_at = ? WHERE store = ?`).bind(at, id).run();
    const n = await db.prepare(`SELECT ext_orders FROM order_backfill WHERE store = ?`).bind(id).first();
    await logEvent(db, {
      actor: ACTOR, kind: "orders.history_extended", store: id, target: "sys.shopify",
      summary: `${store.name}: order history now reaches back to ${st.ext_from} (was ${st.ext_to}; ${n.ext_orders} older orders read)${st.ext_note ? `. ${st.ext_note}` : ""}`,
      data: { from: st.ext_from, was: st.ext_to, orders: n.ext_orders, moved: !!(moved.meta && moved.meta.changes) }, at,
    });
    return { store: id, ran: true, phase: "orders", done: true, read };
  }

  // 2. Refunds: orders updated in [ext_from - 1 day, refunds start - 1 day + overlap).
  const ref = await db.prepare(`SELECT start_day, covered_from FROM feed_coverage WHERE store = ? AND feed = 'refunds'`).bind(id).first();
  if (!ref || !ref.covered_from) return { store: id, ran: false, phase: "refunds", reason: "refund history's first read not finished" };
  if (ref.covered_from <= st.ext_from) {
    await db.prepare(`UPDATE order_backfill SET ref_ext_done_at = ? WHERE store = ?`).bind(at, id).run();
    return { store: id, ran: true, phase: "refunds", done: true };
  }
  // Without read_all_orders Shopify hides orders older than 60 days, refunds on them included:
  // a refund processed in the gap on an older order would be missing and flatter profit
  // (rule 5). Refund coverage is NOT moved back; those days stay open ("refunds unprovable")
  // until the scope is granted (checked daily, above).
  if (Number(st.ext_all_orders) !== 1) {
    const note = `${st.ext_note ? `${st.ext_note}. ` : ""}refunds before ${ref.covered_from} unprovable without read_all_orders`;
    await db.prepare(`UPDATE order_backfill SET ref_ext_done_at = ?, ext_note = ? WHERE store = ?`).bind(at, note, id).run();
    return { store: id, ran: true, phase: "refunds", done: true, note };
  }
  const fromMs = startOfLocalDayMs(st.ext_from, tz) - 86400000;
  const toMs = Date.parse(`${ref.start_day}T00:00:00Z`) - 86400000 + OVERLAP_MIN * 60000;
  const query = `updated_at:>='${new Date(fromMs).toISOString()}' updated_at:<'${new Date(toMs).toISOString()}'`;
  const ctx = { tz, at, initial: true, store, seen: 0, added: 0, changed: 0 };
  let after = st.ref_ext_cursor || null, pages = 0, done = false;
  while (pages < EXT_REFUND_PAGES_PER_RUN) {
    const data = await shopifyGraphQL(env, id, RECENT_REFUNDS, { first: ORDERS_PER_PAGE, after, query }, opts);
    const conn = data && data.orders;
    await storeRefunds(env, id, (conn && conn.nodes) || [], ctx);
    pages++;
    const more = !!(conn && conn.pageInfo && conn.pageInfo.hasNextPage);
    after = more ? conn.pageInfo.endCursor : null;
    await db.prepare(`UPDATE order_backfill SET ref_ext_cursor = ? WHERE store = ?`).bind(after, id).run();
    if (!more) { done = true; break; }
  }
  if (!done) return { store: id, ran: true, phase: "refunds", done: false, added: ctx.added };
  await db.prepare(`UPDATE feed_coverage SET start_day = ?, covered_from = ?, updated_at = ? WHERE store = ? AND feed = 'refunds' AND covered_from = ?`)
    .bind(st.ext_from, st.ext_from, at, id, ref.covered_from).run();
  await db.prepare(`UPDATE order_backfill SET ref_ext_done_at = ? WHERE store = ?`).bind(at, id).run();
  await logEvent(db, {
    actor: "pnl.refunds", kind: "refunds.history_extended", store: id, target: "sys.shopify",
    summary: `${store.name}: refunds now known from ${st.ext_from} (was ${ref.covered_from}; ${ctx.added} older refund${ctx.added === 1 ? "" : "s"} recorded)`,
    data: { from: st.ext_from, was: ref.covered_from, added: ctx.added }, at,
  });
  return { store: id, ran: true, phase: "refunds", done: true, added: ctx.added };
}

/** The 15-minute cron step across live stores. One store's failure never stops the others. */
export async function runHistoryExtension(env, { nowMs = Date.now(), opts = {} } = {}) {
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    try {
      out.push(await extendStoreHistory(env, id, { nowMs, opts }));
    } catch (err) {
      if (err.code === "NOT_WIRED") { out.push({ store: id, ran: false, skipped: "not wired" }); continue; }
      await logEvent(env.DB, {
        actor: ACTOR, kind: "error.history_extension", store: id, target: "sys.shopify",
        summary: `${STORES[id].name}: reading older order history failed; it resumes from where it stopped (${String(err.message).slice(0, 150)})`,
      }).catch(() => {});
      out.push({ store: id, ran: false, error: err.message });
    }
  }
  return out;
}

export async function historyExtensionState(db) {
  const { results } = await db.prepare(
    `SELECT b.store, c.covered_from, b.ext_from, b.ext_to, b.ext_all_orders, b.ext_orders, b.ext_done_at, b.ref_ext_done_at, b.ext_note
       FROM order_backfill b LEFT JOIN order_coverage c ON c.store = b.store ORDER BY b.store`
  ).all().catch(() => ({ results: [] }));
  return results || [];
}
