/**
 * Closed stores (Reilly 2026-10-27: "marlowe and auberlane are no longer live. can we switch the
 * store brain so that its only focused on H&C now?").
 *
 * Their history stays in the ledger. What is taken off Reilly's list, once per store, is work
 * that only made sense while the store was selling: pending approvals from the price, quote,
 * catalog, media, supplier and risk desks. Customer-email flags are KEPT: a customer of a closed
 * store can still be waiting for an answer about an order they already have.
 * Closing them is bookkeeping, not a decision (expired, not_reilly: true).
 */
import { STORES } from "../config/stores.js";
import { logEvent } from "./eventlog.js";
import { nowIso } from "./time.js";

export async function closeStoreWork(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const out = [];
  for (const s of Object.values(STORES)) {
    if (s.live || !s.closedOn) continue;
    const job = `store.closed.${s.id}`;
    const done = await db.prepare(`SELECT 1 AS y FROM job_runs WHERE job = ?`).bind(job).first().catch(() => null);
    if (done) continue;
    const at = nowIso(nowMs);
    const r = await db.prepare(
      `UPDATE approvals SET status = 'expired', decided_at = ?, result = ? WHERE status = 'pending' AND store = ? AND requested_by NOT LIKE 'cs.%'`
    ).bind(at, JSON.stringify({ closed_by: "core.store_closed", not_reilly: true, outcome: "store_closed", reason: `${s.name} closed ${s.closedOn}` }), s.id).run();
    const n = (r.meta && r.meta.changes) || 0;
    await db.prepare(`INSERT INTO job_runs (job, last_run_at, last_result) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`)
      .bind(job, at, JSON.stringify({ closed: n })).run();
    await logEvent(db, { actor: "core.approvals", kind: "store.closed", store: s.id, at,
      summary: `${s.name} is closed (${s.closedOn}): ${n} pending item${n === 1 ? "" : "s"} from its price, quote, catalog, media and supplier desks taken off your list. Its history is kept; customer emails still waiting on you stay.` });
    out.push({ store: s.id, closed: n });
  }
  return out;
}
