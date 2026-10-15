/**
 * Core department cron entry point and page data.
 *
 *   runCore(env, {nowMs, fetchImpl})  — called by the department rotation. Never throws. Each agent
 *                                       runs in its own try and self-throttles via job_runs.
 *   coreState(env, {nowMs})          — small JSON for the Core department page.
 *
 * Cadence: the Core comes round about twice an hour in the department rotation
 * (src/agents/index.js), so the Router and the Incident Desk run on every visit (their
 * 15-minute throttle never holds them back; the Router reads until it has caught up) ·
 * Auditor and Librarian (checks + vault outbox) hourly · Librarian weekly report every 7 days ·
 * decision seed daily (idempotent; inserts only what's missing).
 * Live since go-live (GO_LIVE = "1", 2026-10-14). Still nothing leaves the ledger except an approval
 * (and, through src/lib/phoneAlerts.js, an urgent phone alert). No AI is used by these agents today.
 */
import { modeFor, liveMeans } from "../../config/live.js";
import { claimJob } from "../../lib/jobRuns.js";
import { guarded, noteResult, jobInfo } from "./shared.js";
import { seedDecisions, decisionsState } from "./decisions.js";
import { runLibrarian, weeklyReport, librarianState } from "./librarian.js";
import { runAuditor, auditorState } from "./auditor.js";
import { runIncidents, incidentsState } from "./incidents.js";
import { runRouter, routerState } from "./router.js";

export const CORE_JOBS = Object.freeze({
  "core.decisions.seed": 24 * 60,
  "core.router": 15,
  "core.incidents": 15,
  "core.auditor": 60,
  "core.librarian": 60,
  "core.librarian.weekly": 7 * 24 * 60,
});

async function step(env, job, actor, nowMs, fn) {
  const db = env.DB;
  try {
    if (!(await claimJob(db, job, CORE_JOBS[job], nowMs))) return "not due";
  } catch (err) {
    return { error: String(err && err.message) };
  }
  const r = await guarded(db, actor, job.replace(/\./g, "_"), nowMs, fn);
  await noteResult(db, job, r && r.error ? `error: ${r.error}` : `ok: ${JSON.stringify(r).slice(0, 250)}`);
  return r;
}

// eslint-disable-next-line no-unused-vars
export async function runCore(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = {};
  out.decisions = await step(env, "core.decisions.seed", "core.decisions", nowMs, () => seedDecisions(env.DB, { nowMs }));
  out.router = await step(env, "core.router", "core.router", nowMs, () => runRouter(env, { nowMs }));
  out.incidents = await step(env, "core.incidents", "core.incidents", nowMs, () => runIncidents(env, { nowMs }));
  out.auditor = await step(env, "core.auditor", "core.auditor", nowMs, () => runAuditor(env, { nowMs }));
  out.librarian = await step(env, "core.librarian", "core.librarian", nowMs, () => runLibrarian(env.DB, { nowMs }));
  out.librarian_weekly = await step(env, "core.librarian.weekly", "core.librarian", nowMs, () => weeklyReport(env.DB, { nowMs }));
  return out;
}

export async function coreState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const safe = async (fn) => { try { return await fn(); } catch (err) { return { error: String(err && err.message) }; } };
  const jobs = {};
  for (const j of Object.keys(CORE_JOBS)) jobs[j] = await jobInfo(db, j);
  return {
    mode: modeFor(env, "core"), live_means: liveMeans(env, "core"),
    jobs,
    decisions: await safe(() => decisionsState(db)),
    librarian: await safe(() => librarianState(db, { nowMs })),
    auditor: await safe(() => auditorState(db)),
    incidents: await safe(() => incidentsState(db, { nowMs })),
    router: await safe(() => routerState(db)),
  };
}
