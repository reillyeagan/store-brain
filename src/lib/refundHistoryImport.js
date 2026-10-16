/**
 * One-off refund history, read from Shopify by Claude (Reilly, 2026-10-16: "just use the
 * browser to find them ... once you do it once we wont have to do it again").
 *
 * Why it exists: the Store Brain apps don't have read_all_orders, so Shopify hides orders older
 * than 60 days from them, and a refund processed in late August on a July order is invisible.
 * Those days stayed open ("refunds unprovable"). Shopify's own connector (signed in by Reilly)
 * can see every order, so Claude read every refund on every refunded / partly refunded order
 * updated since 2026-06-29 for each store, and saved them in src/data/refundHistory.js
 * (checked into git, so anyone can see exactly what was loaded and where it came from).
 *
 * What this does, once per store (job_runs "refunds.history_import.<store>"):
 *  - refuses the store's list if its shop domain isn't the store's own (Store Guard, rule 2);
 *  - inserts refunds the ledger doesn't have, ONLY for days before the refunds feed's own
 *    coverage (inside coverage the brain's live reads stay the source of record, rule 3);
 *  - first checks the list against the ledger inside coverage, both ways (every listed refund
 *    is in the ledger to the cent, and every ledger refund is on the list). Any difference and
 *    NOTHING is loaded: a short or wrong list would flatter profit (rule 5);
 *  - moves the refunds coverage back to the list's start day, only if nothing has moved it
 *    since (same guarded update as the history extension).
 * Inserted rows are new rows (no existing row is changed), so there is nothing to back up.
 */
import { REFUND_HISTORY } from "../data/refundHistory.js";
import { STORES } from "../config/stores.js";
import { logEvent } from "./eventlog.js";
import { localDay, nowIso } from "./time.js";

const ACTOR = "pnl.refunds";
const job = (id) => `refunds.history_import.${id}`;

export async function applyRefundHistory(env, { nowMs = Date.now(), history = REFUND_HISTORY } = {}) {
  const db = env.DB;
  const out = [];
  for (const h of (history && history.stores) || []) {
    const store = STORES[h.store];
    if (!store || !store.live) { out.push({ store: h.store, skipped: "not a live store" }); continue; }
    const done = await db.prepare(`SELECT last_result FROM job_runs WHERE job = ?`).bind(job(h.store)).first().catch(() => null);
    if (done) { out.push({ store: h.store, skipped: "already applied" }); continue; }
    const at = nowIso(nowMs);
    if (!store.domain || h.shop_domain !== store.domain) {
      await logEvent(db, { actor: ACTOR, kind: "error.refund_history", store: h.store, at, summary: `${store.name}: refund history refused, it was read from ${h.shop_domain}, not ${store.domain}` });
      out.push({ store: h.store, refused: "shop domain mismatch" });
      continue;
    }
    const cov = await db.prepare(`SELECT start_day, covered_from FROM feed_coverage WHERE store = ? AND feed = 'refunds'`).bind(h.store).first();
    if (!cov || !cov.covered_from) { out.push({ store: h.store, skipped: "refunds feed's first read not finished" }); continue; }
    const tz = store.timezone || env.TIMEZONE || "America/New_York";
    let added = 0, matched = 0;
    const diffs = [], toAdd = [];
    const listed = new Set();
    for (const [refundId, orderId, orderName, processedAt, amount, status] of h.refunds) {
      listed.add(refundId);
      const day = localDay(processedAt, tz);
      const have = await db.prepare(`SELECT amount FROM refunds WHERE store = ? AND refund_id = ?`).bind(h.store, refundId).first();
      if (day >= cov.covered_from) {
        // Inside coverage the ledger should already have it, to the cent.
        if (!have) diffs.push(`${orderName} $${amount} on ${day} not in the ledger`);
        else if (Math.abs(Number(have.amount) - amount) > 0.005) diffs.push(`${orderName}: ledger $${have.amount}, Shopify $${amount}`);
        else matched++;
      } else if (have) matched++;
      else if (day >= h.from) toAdd.push([refundId, orderId, orderName, processedAt, day, amount, status]);
    }
    // The other direction proves the list is complete: every money refund the ledger has from
    // coverage up to the day the list was read must be on it. One missing = the list is short.
    const { results: ledger } = await db.prepare(
      `SELECT refund_id, local_day, amount FROM refunds WHERE store = ? AND local_day >= ? AND local_day < ? AND amount <> 0`
    ).bind(h.store, cov.covered_from, localDay(history.read_at, tz)).all();
    for (const r of ledger || []) if (!listed.has(r.refund_id)) diffs.push(`ledger refund $${r.amount} on ${r.local_day} missing from the list`);
    if (diffs.length) {
      // Nothing is loaded from a list that doesn't match the brain's own reads (rule 5).
      await logEvent(db, { actor: ACTOR, kind: "refunds.history_mismatch", store: h.store, target: "sys.shopify", at,
        summary: `${store.name}: refund history NOT loaded, it doesn't match the brain's own reads (${diffs.length}: ${diffs.slice(0, 3).join("; ")}). Those days stay open`, data: { diffs } });
      await db.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`)
        .bind(job(h.store), at, JSON.stringify({ refused: true, diffs })).run();
      out.push({ store: h.store, refused: "mismatch", diffs });
      continue;
    }
    for (const [refundId, orderId, orderName, processedAt, day, amount, status] of toAdd) {
      await db.prepare(
        `INSERT INTO refunds (store, refund_id, order_id, processed_at, local_day, amount, status, raw, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(h.store, refundId, orderId, processedAt, day, amount, status, JSON.stringify({ source: history.source, read_at: history.read_at, order: orderName }), at).run();
      added++;
    }
    const moved = h.from < cov.covered_from
      ? await db.prepare(`UPDATE feed_coverage SET start_day = ?, covered_from = ?, updated_at = ? WHERE store = ? AND feed = 'refunds' AND covered_from = ?`)
        .bind(h.from, h.from, at, h.store, cov.covered_from).run()
      : null;
    const result = { added, matched, from: h.from, was: cov.covered_from, moved: !!(moved && moved.meta && moved.meta.changes) };
    await db.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`)
      .bind(job(h.store), at, JSON.stringify(result)).run();
    await logEvent(db, {
      actor: ACTOR, kind: "refunds.history_imported", store: h.store, target: "sys.shopify", at,
      summary: `${store.name}: refunds now known from ${h.from} (was ${cov.covered_from}): ${added} older refund${added === 1 ? "" : "s"} added from Shopify; the list matched all ${matched} the brain already had`,
      data: result,
    });
    out.push({ store: h.store, ...result });
  }
  return out;
}
