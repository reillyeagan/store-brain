/**
 * P&L extras: cron entry point and page data for the Analyst, Tax/Admin & Triggers, the COGS
 * Matcher and the Shopify funnel feed (part of the Data Pullers).
 *
 *   runPnlExtras(env, {nowMs, fetchImpl}) — department rotation (about hourly). Never throws; each job in its own
 *                                           try, throttled through job_runs.
 *   pnlExtrasState(env, {nowMs})          — JSON for the P&L department page.
 *
 * Cadence: funnel hourly (≤ 2 Shopify calls per live store) · COGS Matcher hourly (does
 * nothing until KFB bills exist) · calendar hourly (each reminder/trigger at most once a day)
 * · Analyst once a day, from 06:00 UTC (after the 05:00 UTC day close)
 * · Google Ads history backfill hourly until done (≤ 3 calls per store) · P&L Sheets hourly
 *   (reads the workbooks, fills the brain's gaps, cross-checks, then fills blank sheet cells).
 * Shadow: everything stays in the ledger, except the P&L Sheets writes, which Reilly asked for
 * directly (2026-10-14) and which SHEETS_WRITE = "0" stops. AI: one capped Analyst call a day at most.
 */
import { claimJob } from "../../lib/jobRuns.js";
import { guarded, noteResult, jobInfo } from "../core/shared.js";
import { pullFunnel, funnelState } from "./funnel.js";
import { matchBills, cogsState } from "./cogs.js";
import { runCalendar, calendarState } from "./calendar.js";
import { runAnalyst, analystState } from "./analyst.js";
import { runSheets, sheetsState } from "./sheets.js";
import { runAdsHistory, adsHistoryState } from "../../lib/adsHistory.js";
import { historyExtensionState } from "../../lib/historyExtend.js";

export const PNL_EXTRA_JOBS = Object.freeze({
  "pnl.funnel": 60,
  "pnl.cogs": 60,
  "pnl.calendar": 60,
  "pnl.analyst": 24 * 60,
  "pnl.ads_history": 60,
  "pnl.sheets": 60,
});
export const ANALYST_AFTER_UTC_HOUR = 6;

async function step(env, job, actor, nowMs, fn) {
  try {
    if (!(await claimJob(env.DB, job, PNL_EXTRA_JOBS[job], nowMs))) return "not due";
  } catch (err) {
    return { error: String(err && err.message) };
  }
  const r = await guarded(env.DB, actor, job.replace(/\./g, "_"), nowMs, fn);
  await noteResult(env.DB, job, r && r.error ? `error: ${r.error}` : `ok: ${JSON.stringify(r).slice(0, 250)}`);
  return r;
}

export async function runPnlExtras(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = {};
  out.funnel = await step(env, "pnl.funnel", "pnl.pullers", nowMs, () => pullFunnel(env, { nowMs, fetchImpl }));
  out.cogs = await step(env, "pnl.cogs", "pnl.cogs", nowMs, () => matchBills(env.DB, { nowMs }));
  // Ads history first, so the sheet cross-check sees the API's rows as soon as they land.
  out.ads_history = await step(env, "pnl.ads_history", "pnl.pullers", nowMs, () => runAdsHistory(env, { nowMs, fetchImpl }));
  out.sheets = await step(env, "pnl.sheets", "pnl.sheets", nowMs, () => runSheets(env, { nowMs, fetchImpl }));
  out.calendar = await step(env, "pnl.calendar", "pnl.calendar", nowMs, () => runCalendar(env, { nowMs }));
  // The daily analysis waits for the day close, so "yesterday" is final-ish.
  out.analyst = new Date(nowMs).getUTCHours() >= ANALYST_AFTER_UTC_HOUR
    ? await step(env, "pnl.analyst", "pnl.analyst", nowMs, () => runAnalyst(env, { nowMs, fetchImpl }))
    : "not due";
  return out;
}

export async function pnlExtrasState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const safe = async (fn) => { try { return await fn(); } catch (err) { return { error: String(err && err.message) }; } };
  const jobs = {};
  for (const j of Object.keys(PNL_EXTRA_JOBS)) jobs[j] = await jobInfo(db, j);
  return {
    mode: "shadow",
    jobs,
    funnel: await safe(() => funnelState(db, { nowMs })),
    cogs: await safe(() => cogsState(db)),
    calendar: await safe(() => calendarState(env, { nowMs })),
    analyst: await safe(() => analystState(db)),
    sheets: await safe(() => sheetsState(env, { nowMs })),
    ads_history: await safe(() => adsHistoryState(db)),
    order_history: await safe(() => historyExtensionState(db)),
  };
}

export { funnelFor } from "./funnel.js";
export { matchBills } from "./cogs.js";
