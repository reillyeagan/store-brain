/**
 * Media department — cron entry point and dashboard data. WATCH ONLY.
 *
 * Reilly, 2026-10-11: "guy is still the mediabuyer, dont worry about the spend cieling, and
 * for now, the media section is just watching more than anything ... eventually I want to
 * drop him as the mediabuyer and just use the store brain, but we need more data".
 *
 * runMedia(env) rides on the 15-minute cron. Every agent/store pair has its own job name in
 * job_runs (claimJob), so work is spread over ticks:
 *   media.performance.<store>   every 4h   (1 Ads call)
 *   media.guy_monitor.<store>   every 6h   (1 Ads call)
 *   media.search_terms.<store>  daily      (1 Ads call + at most 1 Claude call)
 *   media.products.<store>      daily      (1 Ads call)
 *   media.season.<store>        daily      (1 Ads call)
 *   media.conversions.<store>   every 6h   (D1 only)
 *   media.budget                daily      (D1 only + at most 1 Claude call)
 * At most MEDIA_MAX_ADS_CALLS (default 6) Google Ads requests per tick; what doesn't fit
 * runs on the next tick. A job is claimed only when it can run whole.
 *
 * Never throws. Google not connected → nothing claimed, one "not wired" event a day.
 * An Ads error → error event (at most hourly per agent+store), the job retries in 30 minutes,
 * and NO numbers are written (never zero for a failure).
 * Kill switch: env MEDIA_PAUSED = "1" stops the whole department.
 */
import { claimJob, retrySoon, noteJobResult } from "../../lib/jobRuns.js";
import { STORE_IDS } from "../../config/stores.js";
import { localDay, nowIso } from "../../lib/time.js";
import {
  AdsSession, MediaNotWired, MediaCallBudget, mediaStoreIds, notWiredReason, logMediaError, logNotWiredOnce,
  minusDays, r2, storeBreakeven, realityFactor, storeName,
} from "./common.js";
import { runPerformance } from "./performance.js";
import { runGuyMonitor } from "./guyMonitor.js";
import { runSearchTerms } from "./searchTerms.js";
import { runProducts } from "./products.js";
import { runSeason } from "./season.js";
import { runConversions } from "./conversions.js";
import { runBudget } from "./budget.js";
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
    await noteJobResult(db, job, "deferred: Ads call budget for the tick used up").catch(() => {});
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
          // Two calls of headroom: one for the report, one in case the account timezone is unknown.
          if (!session.canCall(2)) { out[job] = "waiting for a later tick"; continue; }
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
    const factor = days ? await realityFactor(db, id, from, to) : null;
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
      `SELECT key, kind, title, status, outcome, created_at FROM media_proposals WHERE store = ? AND agent = 'media.budget' ORDER BY created_at DESC, id DESC LIMIT 8`
    ).bind(id).all();
    const conv = await openFindings(db, id, "media.conversions", 5);
    const check = conv.find((f) => f.key === "check") || null;
    stores.push({
      store: id, name: storeName(id), wired: !!google, reason: google ? null : "Google not connected",
      window: { from, to, days_with_data: days, fetched_at: spend && spend.fetched_at },
      spend: cost,
      google_roas: cost ? r2(Number(spend.value) / cost) : null,
      roas_adjusted: cost && factor != null ? r2((Number(spend.value) * factor) / cost) : null,
      pnl_roas: cost && pnl && Number(pnl.n) ? r2(Number(pnl.rev) / cost) : null, // Shopify revenue (all channels) / ad spend
      breakeven: be.breakeven, breakeven_estimated: be.estimated, breakeven_note: be.reason, reality_factor: factor,
      flagged_campaigns: await openFindings(db, id, "media.performance", 10),
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
  const track = await db.prepare(
    `SELECT COUNT(*) AS n, SUM(outcome = 'right') AS right_n, SUM(outcome = 'wrong') AS wrong_n, SUM(outcome = 'unclear') AS unclear_n
     FROM media_proposals WHERE agent = 'media.budget' AND outcome IS NOT NULL`
  ).first();
  return {
    mode: "watch only",
    decision: "guy is still the mediabuyer, dont worry about the spend cieling, and for now, the media section is just watching more than anything",
    google: google ? { connected: true, since: google.created_at } : { connected: false, reason: "Google not connected" },
    watched,
    stores,
    budget: {
      rationale: await latestRead(db, "all", "media.budget"),
      track_record: { scored: Number((track && track.n) || 0), right: Number((track && track.right_n) || 0), wrong: Number((track && track.wrong_n) || 0), unclear: Number((track && track.unclear_n) || 0) },
      job: jobs.find((j) => j.job === "media.budget") || null,
    },
    at: nowIso(nowMs),
  };
}
