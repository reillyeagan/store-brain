/**
 * Media department — cron entry point and dashboard data. WATCH ONLY.
 *
 * Reilly, 2026-10-11: "guy is still the mediabuyer, dont worry about the spend cieling, and
 * for now, the media section is just watching more than anything ... eventually I want to
 * drop him as the mediabuyer and just use the store brain, but we need more data".
 *
 * runMedia(env) is called by the department rotation (src/agents/index.js): Media gets ONE
 * of the 12 five-minute slots per hour, so it runs about once an hour. Every agent/store pair
 * has its own job name in job_runs (claimJob); a job not due simply waits for a later hour:
 *   media.performance.<store>   every 4h   (1 Ads call)
 *   media.guy_monitor.<store>   every 6h   (1 Ads call)
 *   media.search_terms.<store>  daily      (1 Ads call + at most 1 Claude call)
 *   media.products.<store>      daily      (1 Ads call)
 *   media.season.<store>        daily      (1 Ads call)
 *   media.conversions.<store>   every 6h   (D1 only)
 *   media.spend_alarm.<store>   hourly     (D1 only: spend vs orders, stopped spending)
 *   media.billing.<store>       daily      (3 Ads calls: account status, billing setup, account budget)
 *   media.budget                daily      (D1 only + at most 1 Claude call)
 * At most MEDIA_MAX_ADS_CALLS (default 6) Google Ads requests per run; what doesn't fit runs
 * in the next hourly run. A job is claimed only when it can run whole. Capacity: 6 calls an
 * hour = 144 a day, against about 39 needed (3 stores × (6 performance + 4 guy + 3 daily)).
 *
 * Never throws. Google not connected → nothing claimed, one "not wired" event a day.
 * An Ads error → error event (at most hourly per agent+store), the job is retried at the next
 * hourly run, and NO numbers are written (never zero for a failure).
 * Kill switch: env MEDIA_PAUSED = "1" stops the whole department.
 */
import { modeFor, liveMeans } from "../../config/live.js";
import { claimJob, retrySoon, noteJobResult } from "../../lib/jobRuns.js";
import { STORE_IDS } from "../../config/stores.js";
import { localDay, nowIso } from "../../lib/time.js";
import {
  AdsSession, MediaNotWired, MediaCallBudget, mediaStoreIds, notWiredReason, logMediaError, logNotWiredOnce,
  minusDays, r2, storeBreakeven, revenueCap, breakevenLabel, CAP_LABEL, storeName,
} from "./common.js";
import { runPerformance } from "./performance.js";
import { runGuyMonitor } from "./guyMonitor.js";
import { runSearchTerms } from "./searchTerms.js";
import { runProducts } from "./products.js";
import { runSeason } from "./season.js";
import { runConversions } from "./conversions.js";
import { runBudget, trackRecord } from "./budget.js";
import { runSpendAlarm } from "./spendAlarm.js";
import { runBilling, CALLS as BILLING_CALLS } from "./billing.js";
import { latestRead } from "./reads.js";

export const DEFAULT_MAX_ADS_CALLS = 6;

/** Per-store agents in run order. `ads` = needs Google Ads calls this tick. */
export const STORE_AGENTS = Object.freeze([
  { agent: "media.performance", everyMin: 240, ads: true, run: runPerformance },
  { agent: "media.guy_monitor", everyMin: 360, ads: true, run: runGuyMonitor },
  { agent: "media.conversions", everyMin: 360, ads: false, run: runConversions },
  { agent: "media.search_terms", everyMin: 1440, ads: true, run: runSearchTerms },
  { agent: "media.products", everyMin: 1440, ads: true, run: runProducts },
  { agent: "media.season", everyMin: 1440, ads: true, run: runSeason },
  // D1 only. 55 min so it judges on every hourly Media run (the claim is only an overlap guard).
  { agent: "media.spend_alarm", everyMin: 55, ads: false, run: runSpendAlarm },
  // 3 read-only Ads calls a day per store (account status, billing setup, account budget).
  { agent: "media.billing", everyMin: 1440, ads: true, calls: BILLING_CALLS, run: runBilling },
]);
export const BUDGET_JOB = Object.freeze({ agent: "media.budget", job: "media.budget", everyMin: 1440 });

const jobName = (agent, store) => `${agent}.${store}`;

async function handleFailure(env, { agent, store, job, everyMin, err, nowMs }) {
  const db = env.DB;
  if (err instanceof MediaNotWired || (err && err.code === "NOT_WIRED")) {
    await noteJobResult(db, job, `not wired: ${err.message}`).catch(() => {});
    await retrySoon(db, job, everyMin, 30, nowMs).catch(() => {});
    await logNotWiredOnce(db, { reason: err.message, nowMs }).catch(() => {});
    return `not wired: ${err.message}`;
  }
  if (err instanceof MediaCallBudget) {
    await retrySoon(db, job, everyMin, 15, nowMs).catch(() => {});
    await noteJobResult(db, job, "deferred: Ads call budget for this run used up").catch(() => {});
    return "deferred";
  }
  const msg = String((err && err.message) || err).slice(0, 250);
  await noteJobResult(db, job, `error: ${msg}`).catch(() => {});
  await retrySoon(db, job, everyMin, 30, nowMs).catch(() => {});
  await logMediaError(db, { actor: agent, store, message: msg, nowMs }).catch(() => {});
  return `error: ${msg}`;
}

/** Has the Google side delivered recently for at least one store? (budget waits for it) */
async function anyFreshCampaignData(db, nowMs) {
  const r = await db.prepare(`SELECT MAX(fetched_at) AS f FROM media_campaign_days`).first().catch(() => null);
  return !!(r && r.f && nowMs - Date.parse(r.f) <= 8 * 3600000);
}

export async function runMedia(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const out = {};
  try {
    if (env.MEDIA_PAUSED === "1") return { paused: true };
    const db = env.DB;
    const maxCalls = Math.max(0, parseInt(env.MEDIA_MAX_ADS_CALLS || DEFAULT_MAX_ADS_CALLS, 10) || DEFAULT_MAX_ADS_CALLS);
    const session = new AdsSession(env, { fetchImpl, nowMs, maxCalls });
    const stores = mediaStoreIds();

    // Is Google connected at all? Checked once (one token call) only if some Ads job is due.
    for (const a of STORE_AGENTS) {
      for (const store of stores) {
        const job = jobName(a.agent, store);
        if (a.ads) {
          if (session.notWired) { out[job] = `not wired: ${session.notWired}`; continue; }
          if (session.tokenError) { out[job] = "skipped: Google sign-in failed this tick"; continue; }
          // Two calls of headroom: one for the report, one in case the account timezone is unknown
          // (an agent that needs more says so with `calls`).
          if (!session.canCall(a.calls || 2)) { out[job] = "waiting for the next media run (about an hour)"; continue; }
        }
        try {
          if (!(await claimJob(db, job, a.everyMin, nowMs))) { out[job] = "not due"; continue; }
          if (a.ads) await session.getToken(); // NOT_WIRED surfaces here, before any work
          const r = await a.run(env, { storeId: store, session, nowMs, fetchImpl });
          await noteJobResult(db, job, r);
          out[job] = r;
        } catch (err) {
          out[job] = await handleFailure(env, { agent: a.agent, store, job: jobName(a.agent, store), everyMin: a.everyMin, err, nowMs });
        }
      }
    }

    // Budget: daily, after campaign data exists.
    try {
      if (!(await anyFreshCampaignData(db, nowMs))) out[BUDGET_JOB.job] = "waiting for campaign data";
      else if (!(await claimJob(db, BUDGET_JOB.job, BUDGET_JOB.everyMin, nowMs))) out[BUDGET_JOB.job] = "not due";
      else {
        const r = await runBudget(env, { nowMs, fetchImpl });
        await noteJobResult(db, BUDGET_JOB.job, r);
        out[BUDGET_JOB.job] = r;
      }
    } catch (err) {
      out[BUDGET_JOB.job] = await handleFailure(env, { agent: BUDGET_JOB.agent, store: null, job: BUDGET_JOB.job, everyMin: BUDGET_JOB.everyMin, err, nowMs });
    }
    out._adsCalls = session.calls;
  } catch (err) {
    // Last line of defence: the shared cron must keep running.
    out._error = String((err && err.message) || err).slice(0, 200);
  }
  return out;
}

/* ---------------- dashboard data ---------------- */

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function openFindings(db, store, agent, limit = 10) {
  const { results } = await db.prepare(
    `SELECT key, severity, summary, data, first_seen, last_seen FROM media_findings WHERE store = ? AND agent = ? AND cleared_at IS NULL
     ORDER BY CASE severity WHEN 'bad' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen DESC LIMIT ?`
  ).bind(store, agent, limit).all();
  return (results || []).map((r) => ({ ...r, data: parse(r.data) }));
}

export async function mediaState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const google = await db.prepare(`SELECT account, created_at FROM oauth_tokens WHERE provider = 'google' ORDER BY created_at DESC LIMIT 1`).first().catch(() => null);
  const { results: jobRows } = await db.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job LIKE 'media.%' ORDER BY job`).all();
  const jobs = jobRows || [];
  const watched = mediaStoreIds();
  const stores = [];
  for (const id of STORE_IDS) {
    const reason = notWiredReason(id);
    if (reason) { stores.push({ store: id, name: storeName(id), wired: false, reason }); continue; }
    const today = localDay(nowMs, "America/New_York");
    const to = minusDays(today, 1);
    const from = minusDays(to, 13);
    const spend = await db.prepare(
      `SELECT COUNT(DISTINCT day) AS days, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(conv_value), 0) AS value, MAX(fetched_at) AS fetched_at
       FROM media_campaign_days WHERE store = ? AND day >= ? AND day <= ?`
    ).bind(id, from, to).first();
    const days = Number((spend && spend.days) || 0);
    const be = await storeBreakeven(db, id, from, to);
    const cap = days ? await revenueCap(db, id, from, to) : null;
    const pnl = await db.prepare(`SELECT COALESCE(SUM(revenue), 0) AS rev, COUNT(*) AS n FROM pnl_days WHERE store = ? AND day >= ? AND day <= ? AND revenue IS NOT NULL`).bind(id, from, to).first();
    const cost = days ? r2(spend.cost) : null; // null = no data, never zero
    const { results: wasted } = await db.prepare(
      `SELECT title, detail, created_at FROM media_proposals WHERE store = ? AND agent = 'media.search_terms' AND status = 'open'
       ORDER BY CAST(json_extract(detail, '$.cost') AS REAL) DESC LIMIT 10`
    ).bind(id).all();
    const { results: changes } = await db.prepare(
      `SELECT changed_at, user_email, client_type, resource_type, operation, summary, effect FROM media_changes WHERE store = ? ORDER BY changed_at DESC LIMIT 15`
    ).bind(id).all();
    const { results: budget } = await db.prepare(
      `SELECT key, kind, title, status, outcome, created_at, updated_at FROM media_proposals WHERE store = ? AND agent = 'media.budget'
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, CASE kind WHEN 'budget_hold' THEN 1 ELSE 0 END, updated_at DESC, id DESC LIMIT 10`
    ).bind(id).all();
    const conv = await openFindings(db, id, "media.conversions", 5);
    const check = conv.find((f) => f.key === "check") || null;
    stores.push({
      store: id, name: storeName(id), wired: !!google, reason: google ? null : "Google not connected",
      window: { from, to, days_with_data: days, fetched_at: spend && spend.fetched_at },
      spend: cost,
      google_roas: cost ? r2(Number(spend.value) / cost) : null,
      roas_capped: cost && cap != null ? r2((Number(spend.value) * cap) / cost) : null,
      roas_capped_label: CAP_LABEL,
      pnl_roas: cost && pnl && Number(pnl.n) ? r2(Number(pnl.rev) / cost) : null, // Shopify revenue (all channels) / ad spend
      breakeven: be.breakeven, breakeven_estimated: be.estimated, breakeven_label: breakevenLabel(be), breakeven_note: be.reason, revenue_cap: cap,
      flagged_campaigns: await openFindings(db, id, "media.performance", 10),
      // Spend alarm: today's alarm (one a day at most) or why it can't check.
      spend_alarm: await openFindings(db, id, "media.spend_alarm", 3),
      // Billing watch: the latest read ("check") and any open red flags; parts Google refused are "not wired".
      billing: await openFindings(db, id, "media.billing", 6),
      wasted_terms: (wasted || []).map((w) => ({ title: w.title, ...(parse(w.detail) || {}) })),
      product_burners: await openFindings(db, id, "media.products", 10),
      season: await openFindings(db, id, "media.season", 10),
      guy_changes: (changes || []).map((c) => ({ ...c, effect: parse(c.effect) })),
      conversions: { status: check && check.data ? check.data.status : "unknown", check, flags: conv.filter((f) => f.key !== "check") },
      budget_calls: budget || [],
      reads: { performance: await latestRead(db, id, "media.performance") },
      jobs: jobs.filter((j) => j.job.endsWith(`.${id}`)),
    });
  }
  return {
    mode: modeFor(env, "media"), live_means: liveMeans(env, "media"),
    watch: "watch only: Guy runs the accounts, nothing is changed in Google Ads",
    decision: "guy is still the mediabuyer, dont worry about the spend cieling, and for now, the media section is just watching more than anything",
    google: google ? { connected: true, since: google.created_at } : { connected: false, reason: "Google not connected" },
    watched,
    stores,
    budget: {
      rationale: await latestRead(db, "all", "media.budget"),
      track_record: await trackRecord(db),
      job: jobs.find((j) => j.job === "media.budget") || null,
    },
    at: nowIso(nowMs),
  };
}
