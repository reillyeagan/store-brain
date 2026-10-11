/**
 * Money feeds on the 15-minute cron: Google Ads spend (hourly), Shopify payouts (every
 * 6 h) and refund events (hourly), each throttled through job_runs.
 *
 * Isolation: each job runs in its own try. One job throwing never stops the others, and
 * this whole function never throws, so the order pull, KFB composer and Freshness
 * Sentinel that share the cron always run.
 */
import { claimJob, retrySoon, noteJobResult, JOBS } from "./jobRuns.js";
import { pullAdsSpend } from "./adsSpend.js";
import { pullPayouts } from "./payouts.js";
import { pullRefunds } from "./refunds.js";
import { logEvent } from "./eventlog.js";

export const MONEY_JOBS = Object.freeze([
  { job: "ads.spend", run: pullAdsSpend, actor: "pnl.pullers" },
  { job: "payouts", run: pullPayouts, actor: "pnl.money_map" },
  { job: "refunds", run: pullRefunds, actor: "pnl.refunds" },
]);

/** A run "failed" if any store reported an error (skips for "not wired" are not failures). */
const failed = (results) => Array.isArray(results) && results.some((r) => r && r.error);

export async function runMoneyJobs(env, { nowMs = Date.now(), jobs = MONEY_JOBS, fetchImpl } = {}) {
  const out = {};
  for (const j of jobs) {
    const every = JOBS[j.job].everyMin;
    try {
      if (!(await claimJob(env.DB, j.job, every, nowMs))) { out[j.job] = "not due"; continue; }
      const results = await j.run(env, fetchImpl ? { fetchImpl, nowMs } : { nowMs });
      out[j.job] = results;
      const bad = failed(results);
      await noteJobResult(env.DB, j.job, bad
        ? `errors: ${results.filter((r) => r.error).map((r) => `${r.store}: ${r.error}`).join(" | ")}`
        : "ok");
      // Retry a failed run in 30 min rather than waiting a whole interval (rule 6).
      if (bad) await retrySoon(env.DB, j.job, every, 30, nowMs);
    } catch (err) {
      out[j.job] = { error: String(err && err.message) };
      await retrySoon(env.DB, j.job, every, 30, nowMs).catch(() => {});
      await logEvent(env.DB, {
        actor: j.actor, kind: "error.money_job",
        summary: `${JOBS[j.job].label} job failed; it will try again in about 30 minutes (${String(err && err.message).slice(0, 200)})`,
      }).catch(() => {});
    }
  }
  return out;
}
