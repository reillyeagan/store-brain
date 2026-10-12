/**
 * Job throttle — lets slower jobs ride on the 15-minute cron.
 *
 * Why: the Worker has one 15-minute cron. Ads spend should run hourly, payouts every
 * 6 hours, refunds hourly. Each job "claims" its run in `job_runs` with one atomic
 * statement, so two cron runs that overlap can never both run it.
 *
 * Intervals are claimed with a 5-minute slack (an hourly job claims after 55 min),
 * because cron runs land a few seconds apart and a strict 60 would skip to 75.
 */
import { nowIso } from "./time.js";

export const JOBS = Object.freeze({
  // Ads and refunds every cron tick (15 min): Reilly wants revenue and spend "updating as
  // frequently as possible" (2026-10-11). Payout fees hourly: Shopify settles them in batches.
  "ads.spend": { everyMin: 15, label: "Google Ads spend" },
  payouts: { everyMin: 60, label: "Shopify payouts" },
  refunds: { everyMin: 15, label: "Refund events" },
});

const SLACK_MIN = 5;

/**
 * Try to claim a run. Returns true if this caller should run the job now.
 * One statement: insert the first run, or move last_run_at forward only if enough time passed.
 */
export async function claimJob(db, job, everyMin, nowMs = Date.now()) {
  const at = nowIso(nowMs);
  const minGapDays = Math.max(everyMin - SLACK_MIN, 1) / (24 * 60);
  const res = await db
    .prepare(
      `INSERT INTO job_runs (job, last_run_at) VALUES (?, ?)
       ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = NULL
       WHERE julianday(excluded.last_run_at) - julianday(job_runs.last_run_at) >= ?`
    )
    .bind(job, at, minGapDays - 1e-9)
    .run();
  return !!(res.meta && res.meta.changes > 0);
}

/**
 * After a failed run: bring the next attempt forward so it retries in `retryInMin`
 * instead of waiting a whole interval (rule 6: a failed probe is retried before we conclude).
 */
export async function retrySoon(db, job, everyMin, retryInMin = 30, nowMs = Date.now()) {
  if (retryInMin >= everyMin) return;
  const back = nowMs - (everyMin - retryInMin) * 60000;
  await db.prepare(`UPDATE job_runs SET last_run_at = ? WHERE job = ?`).bind(nowIso(back), job).run();
}

export async function noteJobResult(db, job, result) {
  await db.prepare(`UPDATE job_runs SET last_result = ? WHERE job = ?`).bind(String(result).slice(0, 300), job).run();
}

export async function listJobRuns(db) {
  const { results } = await db.prepare(`SELECT * FROM job_runs ORDER BY job`).all();
  return results || [];
}
