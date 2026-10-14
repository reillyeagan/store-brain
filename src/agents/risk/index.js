/**
 * Risk & Disputes department — one cron entry point and one dashboard data function.
 *
 * runRisk(env) is called once an hour: Risk's slot in the department rotation
 * (src/agents/index.js). Each agent throttles itself through job_runs (claimJob), runs inside
 * its own try (one failing agent never stops the others) and never throws. Everything is
 * SHADOW: Shopify is only read; the brain stores, flags, drafts and asks Reilly. Reilly
 * submits dispute evidence and cancels orders himself.
 *
 * Cadences (why):
 *   risk.chargebacks      hourly   evidence deadlines are days away; hourly is plenty
 *   risk.fraud            hourly   a HIGH order should reach Reilly before KFB is paid
 *   risk.account_health   daily    spec: "Account health (daily)"; weekly summary on top
 *   risk.claims_audit     weekly per store (one store per hourly run), classification hourly
 *
 * Kill switch: env RISK_OFF = "1" skips the whole department (default: runs, in shadow).
 */
import { claimJob, noteJobResult, retrySoon } from "../../lib/jobRuns.js";
import { STORES } from "../../config/stores.js";
import { runChargebacks, needsResponse } from "./chargebacks.js";
import { runFraud } from "./fraud.js";
import { runAccountHealth, weeklyHealthSummary } from "./accountHealth.js";
import { collectDue, classifyPending } from "./claimsAudit.js";
import { daysLeft, logOnce, safeJson } from "./shared.js";

export const RISK_JOBS = Object.freeze({
  chargebacks: { job: "risk.chargebacks", everyMin: 60, actor: "risk.chargebacks" },
  fraud: { job: "risk.fraud", everyMin: 60, actor: "risk.fraud" },
  health: { job: "risk.account_health", everyMin: 24 * 60, actor: "risk.account_health" },
  healthWeekly: { job: "risk.account_health.weekly", everyMin: 7 * 24 * 60, actor: "risk.account_health" },
  claimsCollect: { job: "risk.claims.collect", everyMin: 7 * 24 * 60, actor: "risk.claims_audit" }, // + ".<store>"
  claimsClassify: { job: "risk.claims.classify", everyMin: 60, actor: "risk.claims_audit" },
});

const short = (v) => {
  try { return JSON.stringify(v).slice(0, 280); } catch { return String(v).slice(0, 280); }
};

/** Run one throttled step; never throws. */
async function step(env, spec, fn, nowMs, jobName = spec.job) {
  try {
    if (!(await claimJob(env.DB, jobName, spec.everyMin, nowMs))) return "not due";
    const r = await fn();
    await noteJobResult(env.DB, jobName, short(r)).catch(() => {});
    return r;
  } catch (err) {
    await retrySoon(env.DB, jobName, spec.everyMin, Math.min(30, spec.everyMin), nowMs).catch(() => {});
    await logOnce(env.DB, { actor: spec.actor, kind: "error.risk",
      summary: `${spec.actor} run failed; it will retry on Risk's next run (${String(err && err.message).slice(0, 200)})` }, { nowMs }).catch(() => {});
    return { error: String(err && err.message) };
  }
}

export async function runRisk(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (env.RISK_OFF === "1") return { skipped: "RISK_OFF" };
  const J = RISK_JOBS;
  const out = {};
  out.chargebacks = await step(env, J.chargebacks, () => runChargebacks(env, { nowMs, fetchImpl }), nowMs);
  out.fraud = await step(env, J.fraud, () => runFraud(env, { nowMs, fetchImpl }), nowMs);
  out.health = await step(env, J.health, () => runAccountHealth(env, { nowMs, fetchImpl }), nowMs);
  // The weekly summary only reads the ledger, so it rides after the daily check.
  out.healthWeekly = await step(env, J.healthWeekly, () => weeklyHealthSummary(env, { nowMs }), nowMs);
  try {
    const claim = (storeId) => claimJob(env.DB, `${J.claimsCollect.job}.${storeId}`, J.claimsCollect.everyMin, nowMs);
    out.claimsCollect = await collectDue(env, claim, { nowMs, fetchImpl });
    if (out.claimsCollect && out.claimsCollect.error === "error") {
      // A fault (not a wiring gap): try this store again soon instead of in a week (rule 6).
      await retrySoon(env.DB, `${J.claimsCollect.job}.${out.claimsCollect.store}`, J.claimsCollect.everyMin, 60, nowMs);
    }
  } catch (err) {
    out.claimsCollect = { error: String(err && err.message) };
  }
  // Classification only spends when snippets are waiting.
  const waiting = await env.DB.prepare(`SELECT COUNT(*) AS n FROM risk_claims WHERE verdict = 'pending'`).first().catch(() => null);
  out.claimsClassify = waiting && waiting.n > 0
    ? await step(env, J.claimsClassify, () => classifyPending(env, { nowMs, fetchImpl }), nowMs)
    : "nothing waiting";
  return out;
}

/* ---------------- dashboard data ---------------- */

const DISPUTES_STALE_MIN = 3 * 60;
const storeName = (id) => (STORES[id] ? STORES[id].name : id);

export async function riskState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const since7 = new Date(nowMs - 7 * 86400000).toISOString();

  const { results: dRows } = await db.prepare(
    `SELECT d.*, p.status AS pack_status, p.missing AS pack_missing, p.rebuttal AS pack_rebuttal, p.ai_error AS pack_ai_error, p.updated_at AS pack_updated_at,
            p.code_draft AS pack_code_draft, p.blocked AS pack_blocked, p.ai_attempts AS pack_ai_attempts
       FROM risk_disputes d LEFT JOIN risk_evidence_packs p ON p.store = d.store AND p.dispute_id = d.dispute_id
      WHERE d.status IN ('NEEDS_RESPONSE', 'UNDER_REVIEW')
      ORDER BY d.evidence_due_by IS NULL, d.evidence_due_by LIMIT 50`
  ).all();
  const openDisputes = (dRows || []).map((d) => ({
    store: d.store, storeName: storeName(d.store), order: d.order_name, disputeId: d.dispute_id, type: d.type,
    reason: d.reason, status: d.status, amount: d.amount, currency: d.currency, due: d.evidence_due_by,
    daysLeft: daysLeft(d.evidence_due_by, nowMs), needsResponse: needsResponse(d), evidenceSentOn: d.evidence_sent_on,
    approvalId: d.approval_id > 0 ? d.approval_id : null,
    // The draft to review: Claude's wording when there is one, else the code-written draft from
    // the order's own facts. Not submitted: Reilly submits in Shopify.
    evidence: d.pack_status ? {
      status: d.pack_status,
      draftBy: d.pack_rebuttal ? "claude" : d.pack_code_draft ? "code" : null,
      draft: d.pack_rebuttal ? String(d.pack_rebuttal).slice(0, 4000) : d.pack_code_draft ? String(d.pack_code_draft).slice(0, 4000) : null,
      blocked: d.pack_blocked || null,
      missing: safeJson(d.pack_missing, []),
      aiAttempts: d.pack_ai_attempts || 0,
      aiNote: d.pack_ai_error || null, updatedAt: d.pack_updated_at,
      submitted: "never by the brain: Reilly submits in Shopify",
    } : (needsResponse(d) ? { status: "missing", draft: null, blocked: "no evidence pack yet: facts were not gathered (see Risk errors)" } : null),
    fetchedAt: d.fetched_at,
  }));
  const { results: closed } = await db.prepare(
    `SELECT store, order_name, status, amount, currency, finalized_on FROM risk_disputes
      WHERE status NOT IN ('NEEDS_RESPONSE', 'UNDER_REVIEW') ORDER BY COALESCE(finalized_on, initiated_at) DESC LIMIT 10`
  ).all();
  const { results: fetched } = await db.prepare(`SELECT store, MAX(fetched_at) AS at FROM risk_disputes GROUP BY store`).all();
  const disputesRead = (fetched || []).map((r) => ({
    store: r.store, at: r.at, stale: !r.at || (nowMs - Date.parse(r.at)) / 60000 > DISPUTES_STALE_MIN,
  }));

  const { results: flags } = await db.prepare(
    `SELECT store, order_id, order_name, order_created_at, level, shopify_level, recommendation, reasons, approval_id, screened_at
       FROM risk_order_screens WHERE level IS NOT NULL ORDER BY screened_at DESC LIMIT 50`
  ).all();
  const screened7 = await db.prepare(`SELECT COUNT(*) AS n FROM risk_order_screens WHERE screened_at >= ?`).bind(since7).first();

  const { results: health } = await db.prepare(`SELECT * FROM risk_account_health ORDER BY store`).all();

  const { results: claims } = await db.prepare(
    `SELECT store, source, text, category, why, found_at, last_seen_at FROM risk_claims
      WHERE verdict = 'risky' AND last_seen_at >= ? ORDER BY store, category, id LIMIT 50`
  ).bind(new Date(nowMs - 8 * 86400000).toISOString()).all();
  const { results: claimCounts } = await db.prepare(`SELECT verdict, COUNT(*) AS n FROM risk_claims GROUP BY verdict`).all();

  const { results: runs } = await db.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job LIKE 'risk.%' ORDER BY job`).all();
  const { results: notWired } = await db.prepare(
    `SELECT at, actor, store, summary FROM events WHERE kind = 'risk.not_wired' AND at >= ? ORDER BY id DESC LIMIT 20`
  ).bind(since7).all();

  return {
    mode: "shadow",
    disputes: {
      open: openDisputes,
      needResponse: openDisputes.filter((d) => d.needsResponse).length,
      recentClosed: (closed || []).map((c) => ({ ...c, storeName: storeName(c.store) })),
      lastRead: disputesRead,
    },
    fraud: {
      flagged: (flags || []).map((f) => ({ ...f, storeName: storeName(f.store), reasons: safeJson(f.reasons, []) })),
      screenedLast7Days: screened7 ? screened7.n : 0,
      note: "Card-testing spike detection is not built yet (needs checkout data).",
    },
    accountHealth: (health || []).map((h) => ({ ...h, storeName: storeName(h.store), detail: safeJson(h.detail, null) })),
    claims: {
      risky: (claims || []).map((c) => ({ ...c, storeName: storeName(c.store) })),
      counts: Object.fromEntries((claimCounts || []).map((c) => [c.verdict, c.n])),
    },
    lastRuns: runs || [],
    notWired: notWired || [],
  };
}
