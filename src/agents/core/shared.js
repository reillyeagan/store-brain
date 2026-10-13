/**
 * Small helpers shared by the Core, P&L-extras and Fulfillment agents.
 * Kept here (not in src/lib) so this build doesn't touch shared files.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";

export function safeJson(s, fallback = null) {
  if (s == null) return fallback;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const r2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
export const r4 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10000) / 10000);

/**
 * Has `actor` logged `kind` within the last `minutes`? The at-most-once-an-hour pattern from
 * moneyJobs.js, so a problem that persists is one line in the feed, not one per tick.
 */
export async function loggedWithin(db, actor, kind, minutes, nowMs = Date.now()) {
  const since = nowIso(nowMs - minutes * 60000);
  const row = await db.prepare(`SELECT id FROM events WHERE actor = ? AND kind = ? AND at >= ? LIMIT 1`)
    .bind(actor, kind, since).first().catch(() => null);
  return !!row;
}

/**
 * Run one agent step without ever throwing: an error becomes one `error.<name>` event
 * (at most once an hour per actor+kind) and the step's result says what went wrong.
 */
export async function guarded(db, actor, name, nowMs, fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 200);
    const kind = `error.${name}`;
    if (!(await loggedWithin(db, actor, kind, 60, nowMs))) {
      await logEvent(db, { actor, kind, summary: `${name} failed; it will try again on a later run (${msg})`, at: nowIso(nowMs) }).catch(() => {});
    }
    return { error: msg };
  }
}

/** Last run + result of a job_runs row, for the department pages. */
export async function jobInfo(db, job) {
  const r = await db.prepare(`SELECT last_run_at, last_result FROM job_runs WHERE job = ?`).bind(job).first().catch(() => null);
  return r ? { last_run_at: r.last_run_at, last_result: r.last_result } : { last_run_at: null, last_result: null };
}

export async function noteResult(db, job, result) {
  await db.prepare(`UPDATE job_runs SET last_result = ? WHERE job = ?`).bind(String(result).slice(0, 300), job).run().catch(() => {});
}

/** "#1234", "1234 ", " #1234" → "1234". KFB and Shopify write order numbers differently. */
export const normRef = (s) => String(s == null ? "" : s).trim().replace(/^#/, "").trim();
