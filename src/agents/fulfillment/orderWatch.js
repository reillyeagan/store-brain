/**
 * Order-to-Supplier Watcher (ful.order_watch) — plain code, L1, shadow-safe (reads the ledger,
 * writes only its own table and events; nothing goes to KFB or a customer).
 *
 * What it does: every paid Shopify order should appear in KFB within KFB_WITHIN_HOURS (KFB's
 * app pulls orders itself; Reilly 2026-10-11). Spec (fulfillment.md): "not in KFB by next
 * morning → morning brief flag. Re-check first: an absence in KFB is a timing statement, not
 * a fact." So, per order:
 *   - checked only against a KFB sweep that is fresh AND ran at least KFB_WITHIN_HOURS after
 *     the order was placed (an earlier sweep couldn't have seen it);
 *   - checked only if that sweep read at least one order of the same store (a sweep that read
 *     nothing for a store says something about the sweep, not the orders: rule 6);
 *   - first miss → `suspect` (silent); still missing on a re-check RECHECK_MIN later → `flagged`
 *     with one `ful.not_in_kfb` event (target sup.relay, for the KFB message). Seen later →
 *     `found`.
 * Matching is by KFB shop code + order number, never the number alone (numbers are shared
 * across stores). Days counted from the Shopify order time, never KFB's.
 * Inputs: orders, kfb_orders (filled by the KFB morning session: not built yet), the
 * `kfb.morning_sweep` feed. Outputs: order_watch rows, events.
 * Today: no KFB session → nothing can be checked, so nothing is flagged ("waiting on KFB session").
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { evaluateFeeds } from "../../lib/freshness.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { normRef, safeJson } from "../core/shared.js";

const ACTOR = "ful.order_watch";
export const KFB_WITHIN_HOURS = 12;
export const RECHECK_MIN = 30;
export const LOOKBACK_DAYS = 14;
export const SWEEP_IMPORT_WINDOW_H = 6; // kfb_orders rows imported this close to the sweep belong to it
export const PAID = ["paid", "partially_paid", "partially_refunded"];

const hours = (env) => (Number(env && env.FUL_KFB_WITHIN_HOURS) > 0 ? Number(env.FUL_KFB_WITHIN_HOURS) : KFB_WITHIN_HOURS);

/** The KFB sweep as the Freshness Sentinel sees it: { usable, at, reason }. */
export async function sweepStatus(db, nowMs) {
  const feeds = await evaluateFeeds(db, nowMs);
  const f = feeds.find((x) => x.id === "kfb.morning_sweep");
  if (!f || !f.wired || !f.last_ok_at) return { usable: false, at: null, reason: "waiting on KFB session (the KFB morning sweep has never run)" };
  if (f.current !== "fresh") return { usable: false, at: f.last_ok_at, reason: `KFB sweep is ${f.current}; absences can't be trusted` };
  return { usable: true, at: f.last_ok_at, reason: null };
}

export async function runOrderWatch(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const sweep = await sweepStatus(db, nowMs);
  if (!sweep.usable) return { status: "waiting", reason: sweep.reason, checked: 0, flagged: 0 };
  const sweepMs = Date.parse(sweep.at);
  const latestOrder = nowIso(sweepMs - hours(env) * 3600000);
  const earliest = nowIso(nowMs - LOOKBACK_DAYS * 86400000);
  let checked = 0, suspect = 0, flagged = 0, found = 0;
  const skippedStores = [];
  for (const id of LIVE_STORE_IDS) {
    const code = STORES[id].kfbShopCode;
    if (!code) { skippedStores.push({ store: id, reason: "no KFB shop code" }); continue; }
    // Rule 6: did this sweep read anything for this store at all?
    const seen = await db.prepare(`SELECT COUNT(*) AS n FROM kfb_orders WHERE kfb_shop_code = ? AND imported_at >= ?`)
      .bind(code, nowIso(sweepMs - SWEEP_IMPORT_WINDOW_H * 3600000)).first();
    if (!seen || !seen.n) { skippedStores.push({ store: id, reason: "the latest KFB sweep read no orders for this store" }); continue; }
    const marks = PAID.map(() => "?").join(", ");
    const { results: orders } = await db.prepare(
      `SELECT order_id, name, created_at, raw FROM orders WHERE store = ? AND created_at >= ? AND created_at <= ?
         AND lower(financial_status) IN (${marks}) ORDER BY created_at LIMIT 300`
    ).bind(id, earliest, latestOrder, ...PAID).all();
    for (const o of orders || []) {
      const raw = safeJson(o.raw, null);
      if (raw && raw.test === true) continue;
      checked++;
      const ref = normRef(o.name);
      const inKfb = ref && await db.prepare(`SELECT kfb_order_id FROM kfb_orders WHERE kfb_shop_code = ? AND (order_ref = ? OR order_ref = ?) LIMIT 1`).bind(code, ref, `#${ref}`).first();
      const row = await db.prepare(`SELECT * FROM order_watch WHERE store = ? AND order_id = ?`).bind(id, o.order_id).first();
      if (inKfb) {
        if (row && row.state !== "found") {
          await db.prepare(`UPDATE order_watch SET state = 'found', found_at = ?, checked_at = ? WHERE store = ? AND order_id = ?`).bind(at, at, id, o.order_id).run();
          found++;
          if (row.state === "flagged") {
            await logEvent(db, { actor: ACTOR, kind: "ful.kfb_found", store: id, target: "sup.relay", summary: `${STORES[id].name} ${o.name} is in KFB now (flagged earlier)`, data: { order_id: o.order_id }, at });
          }
        }
        continue;
      }
      if (!row) {
        await db.prepare(`INSERT INTO order_watch (store, order_id, order_name, created_at, state, first_missing_at, checked_at) VALUES (?, ?, ?, ?, 'suspect', ?, ?)`)
          .bind(id, o.order_id, o.name, o.created_at, at, at).run();
        suspect++;
      } else if (row.state === "suspect" && nowMs - Date.parse(row.first_missing_at) >= RECHECK_MIN * 60000) {
        await db.prepare(`UPDATE order_watch SET state = 'flagged', flagged_at = ?, checked_at = ? WHERE store = ? AND order_id = ?`).bind(at, at, id, o.order_id).run();
        flagged++;
        const h = Math.round((sweepMs - Date.parse(o.created_at)) / 3600000);
        await logEvent(db, {
          actor: ACTOR, kind: "ful.not_in_kfb", store: id, target: "sup.relay",
          summary: `${STORES[id].name} ${o.name} (paid, placed ${o.created_at.slice(0, 16).replace("T", " ")} UTC) is not in KFB ${h} h later, checked twice`,
          data: { order_id: o.order_id, order_name: o.name, sweep_at: sweep.at }, at,
        });
      } else {
        await db.prepare(`UPDATE order_watch SET checked_at = ? WHERE store = ? AND order_id = ?`).bind(at, id, o.order_id).run();
      }
    }
  }
  return { status: "checked", sweep_at: sweep.at, checked, suspect, flagged, found, skipped_stores: skippedStores };
}

export async function orderWatchState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const sweep = await sweepStatus(db, nowMs);
  const { results: open } = await db.prepare(`SELECT * FROM order_watch WHERE state IN ('flagged', 'suspect') ORDER BY state, created_at LIMIT 50`).all();
  const kfb = await db.prepare(`SELECT COUNT(*) AS n, MAX(imported_at) AS last FROM kfb_orders`).first();
  return {
    status: sweep.usable ? "watching" : "waiting on KFB session",
    reason: sweep.reason,
    within_hours: hours(env),
    kfb_orders: { count: (kfb && kfb.n) || 0, last_import: (kfb && kfb.last) || null },
    flagged: (open || []).filter((r) => r.state === "flagged"),
    suspect: (open || []).filter((r) => r.state === "suspect"),
  };
}
