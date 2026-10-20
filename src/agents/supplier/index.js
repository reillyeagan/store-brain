/**
 * Supplier Relations (dept "sup") — the cron entry point and the dashboard data.
 *
 * Everything here is SHADOW: agents propose (one approval per store batch), flag and record.
 * Nothing is written to Shopify, KFB or a customer. Relay (sup.relay, src/lib/kfbMessage.js)
 * is separate and unchanged; it can pick up the size asks from `kfb_size_asks` later.
 *
 * KFB has no API and a CAPTCHA login: quotes, bills and "similar" offers arrive only through
 * the KFB morning import (Reilly logs in, clicks the bookmarklet: src/lib/kfbImport.js). Until
 * the first import those agents idle and the page says "waiting on KFB session". What works
 * from Shopify / the ledger alone:
 * Size-Chart Checker (order lines + size library + complaints), Supply Pre-flight, Claims.
 *
 * Cadence (the Worker cron fires every 15 min; each job self-throttles via job_runs):
 *   sup.decisions   daily   record Reilly's supplier decisions verbatim (idempotent)
 *   sup.similar_qc  15 min  judge new "similar" offers (DB only)
 *   sup.quote_desk  60 min  one Shopify read per store with open quotes (≤ 25 handles)
 *   sup.size_charts 15 min  ≤ 100 order lines
 *   sup.preflight   60 min  5 set-based queries
 *   sup.claims      6 h     aging flags
 *   sup.digest      15 min  writes once per Eastern day after 07:00
 */
import { modeFor, liveMeans } from "../../config/live.js";
import { claimJob, retrySoon, noteJobResult } from "../../lib/jobRuns.js";
import { nowIso } from "../../lib/time.js";
import { STORES, LIVE_STORE_IDS } from "../../config/stores.js";
import { ensureSupplierDecisions } from "./decisions.js";
import { runSimilarQc, SIMILAR_RULE } from "./similarQc.js";
import { runQuoteDesk, FX } from "./quotes.js";
import { runSizeChecker, REFERENCE_SOURCE } from "./sizeChecker.js";
import { chartsNeeded, recentCharts } from "./sizeIntake.js";
import { runChartFetch } from "./chartFetch.js";
import { runPreflight } from "./preflight.js";
import { runClaims, creditAging } from "./claims.js";
import { runDigest, digestData, digestBody, latestSupplierDigest } from "./digest.js";
import { logAgentError, WAITING_ON_KFB } from "./common.js";

export { importQuotes } from "./quotes.js";
export { recordSimilarOffer } from "./similarQc.js";
export { addCredit, markCredited } from "./claims.js";
export { importBills, latestSupplierDigest } from "./digest.js";
export { preflightProduct } from "./preflight.js";

export const SUPPLIER_JOBS = Object.freeze([
  { job: "sup.decisions", everyMin: 1440, actor: "sup.digest", run: (env, o) => ensureSupplierDecisions(env.DB, o) },
  { job: "sup.similar_qc", everyMin: 15, actor: "sup.similar_qc", run: runSimilarQc },
  { job: "sup.quote_desk", everyMin: 60, actor: "sup.quote_desk", run: runQuoteDesk },
  { job: "sup.size_charts", everyMin: 15, actor: "sup.size_charts", run: runSizeChecker },
  // Reads missing factory charts from the 1688 listings KFB buys from (Reilly 2026-10-20).
  { job: "sup.chart_fetch", everyMin: 15, actor: "sup.size_charts", run: runChartFetch },
  { job: "sup.preflight", everyMin: 60, actor: "sup.preflight", run: runPreflight },
  { job: "sup.claims", everyMin: 360, actor: "sup.claims", run: runClaims },
  { job: "sup.digest", everyMin: 15, actor: "sup.digest", run: runDigest },
]);

/** The department's cron step. Never throws; each agent runs in its own try. */
export async function runSupplier(env, { nowMs = Date.now(), fetchImpl = fetch, jobs = SUPPLIER_JOBS } = {}) {
  const out = {};
  if (!env || !env.DB) return { skipped: "no DB" };
  for (const j of jobs) {
    try {
      if (!(await claimJob(env.DB, j.job, j.everyMin, nowMs))) { out[j.job] = "not due"; continue; }
      const r = await j.run(env, { nowMs, fetchImpl });
      out[j.job] = r;
      const errs = Array.isArray(r) ? r.filter((x) => x && x.error) : [];
      await noteJobResult(env.DB, j.job, errs.length ? `errors: ${errs.map((e) => `${e.store}: ${e.error}`).join(" | ")}` : "ok").catch(() => {});
      if (errs.length) await retrySoon(env.DB, j.job, j.everyMin, 30, nowMs).catch(() => {});
    } catch (err) {
      out[j.job] = { error: String(err && err.message) };
      await retrySoon(env.DB, j.job, j.everyMin, 30, nowMs).catch(() => {});
      await noteJobResult(env.DB, j.job, `error: ${String(err && err.message)}`).catch(() => {});
      await logAgentError(env.DB, j.actor, err, nowMs);
    }
  }
  return out;
}

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Small JSON for the Supplier page. Lists capped at 50. */
export async function supplierState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const { results: runs } = await db.prepare(`SELECT job, last_run_at, last_result FROM job_runs WHERE job LIKE 'sup.%'`).all();
  const lastRun = Object.fromEntries((runs || []).map((r) => [r.job, { at: r.last_run_at, result: r.last_result }]));

  const data = await digestData(db, nowMs);

  const { results: batchRows } = await db.prepare(
    `SELECT b.*, a.status AS approval_status FROM supplier_batches b LEFT JOIN approvals a ON a.id = b.approval_id
      ORDER BY b.id DESC LIMIT 10`
  ).all();
  const batches = [];
  for (const b of batchRows || []) {
    const { results: plans } = await db.prepare(
      `SELECT kind, product_handle, title, old_price, new_price, old_compare_at, new_compare_at, cost, currency, cost_usd,
              cogs_old, cogs_new, waiver_price, reason, notes, shop_status
         FROM supplier_plans WHERE batch_id = ? ORDER BY CASE kind WHEN 'reprice' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, id LIMIT 50`
    ).bind(b.id).all();
    batches.push({
      id: b.id, store: b.store, storeName: STORES[b.store] ? STORES[b.store].name : b.store, createdAt: b.created_at,
      pricesReadAt: b.prices_read_at, approvalId: b.approval_id, approvalStatus: b.approval_status || null, status: b.status,
      reprice: b.reprice_count, draft: b.draft_count, waivers: b.waiver_count, fx: { rate: b.fx_rate, source: b.fx_source },
      plans: (plans || []).map((p) => ({ ...p, notes: parse(p.notes, []) })),
    });
  }

  const { results: asks } = await db.prepare(`SELECT * FROM kfb_size_asks WHERE status = 'pending' ORDER BY id DESC LIMIT 50`).all();
  const { results: noFit } = await db.prepare(`SELECT store, order_name, title, ordered_size, reason, checked_at FROM size_recommendations WHERE verdict = 'no_fit' ORDER BY checked_at DESC LIMIT 20`).all();
  const { results: recs } = await db.prepare(
    `SELECT store, order_name, title, ordered_size, send_size, verdict, reason, conflict, chart_verified, complaints, checked_at
       FROM size_recommendations ORDER BY checked_at DESC LIMIT 50`
  ).all();
  const needed = await chartsNeeded(db, { nowMs });
  // Where each missing chart stands: the factory link from KFB, and the brain's last try at it.
  for (const n of needed) {
    if (!n.product_handle) continue;
    const link = await db.prepare(`SELECT offer_url FROM supplier_links WHERE store = ? AND product_handle = ? ORDER BY last_seen_at DESC LIMIT 1`).bind(n.store, n.product_handle).first().catch(() => null);
    const f = await db.prepare(`SELECT status, note, attempts, next_try_at FROM chart_fetches WHERE store = ? AND product_handle = ?`).bind(n.store, n.product_handle).first().catch(() => null);
    n.factory_url = link ? link.offer_url : null;
    n.fetch = f || null;
  }
  const charts = await recentCharts(db);
  const chartCount = await db.prepare(`SELECT COUNT(DISTINCT store || '|' || product_id) AS n FROM size_charts`).first();
  const { results: flags } = await db.prepare(`SELECT * FROM supply_flags ORDER BY id DESC LIMIT 50`).all();
  const { results: credits } = await db.prepare(`SELECT * FROM kfb_credits WHERE status IN ('open','claimed') ORDER BY opened_at LIMIT 50`).all();
  const { results: similar } = await db.prepare(`SELECT * FROM kfb_similar_offers ORDER BY id DESC LIMIT 20`).all();
  const digest = await latestSupplierDigest(db);
  const kfbWired = !!data.quotes;

  return {
    asOf: nowIso(nowMs),
    mode: modeFor(env, "supplier"), live_means: liveMeans(env, "supplier"),
    liveStores: LIVE_STORE_IDS,
    kfbSession: { status: kfbWired ? "has data" : WAITING_ON_KFB, lastQuoteImport: data.quotes ? data.quotes.lastImport : null },
    agents: {
      "sup.quote_desk": {
        lastRun: lastRun["sup.quote_desk"] || null,
        status: kfbWired ? "running" : WAITING_ON_KFB,
        quotes: data.quotes, // null = not wired
        fx: FX,
        batches,
      },
      "sup.denial_sync": {
        status: kfbWired ? "running (drafts go in the Quote Desk's batch approval)" : WAITING_ON_KFB,
        draftsWaiting: batches.filter((b) => b.approvalStatus === "pending").reduce((m, b) => m + b.draft, 0),
      },
      "sup.size_charts": {
        lastRun: lastRun["sup.size_charts"] || null,
        status: "running on Shopify order lines",
        chartsInLibrary: chartCount ? chartCount.n : 0,
        reference: REFERENCE_SOURCE,
        chartsNeeded: needed, // sized order lines in 30 days with no chart, most lines first (top 20)
        charts, // latest charts added (paste or image), each unchecked until Reilly confirms it
        verdicts3d: data.sizeVerdicts3d,
        asksPending: asks || [],
        noFit: noFit || [],
        recent: recs || [],
      },
      "sup.similar_qc": { lastRun: lastRun["sup.similar_qc"] || null, rule: SIMILAR_RULE, status: (similar || []).length ? "running" : WAITING_ON_KFB, offers: similar || [] },
      "sup.preflight": { lastRun: lastRun["sup.preflight"] || null, status: "running on Shopify order lines", flags: flags || [] },
      "sup.claims": {
        lastRun: lastRun["sup.claims"] || null,
        status: data.bills ? "running: KFB bills checked for cancelled-but-billed orders, plus credits added by hand / CS" : "running (credits added by hand / CS until KFB bills are read)",
        rule: "credits only: \"i never return things to KFB\"",
        aging: creditAging(credits || [], nowMs), open: credits || [],
      },
      "sup.digest": { lastRun: lastRun["sup.digest"] || null, latest: digest, preview: digestBody(data) },
    },
    bills: data.bills, // null = waiting on KFB session
  };
}
