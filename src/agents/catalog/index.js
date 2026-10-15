/**
 * Catalog & Feed department (dept "cat") — cron entry point and dashboard data. SHADOW.
 *
 * Catalog gets 2 of the 12 five-minute department slots each hour (src/agents/index.js
 * ROTATION), so it runs about twice an hour, 20 and 40 minutes apart. Each run:
 *   1. The catalog reader (sync.js) reads a few pages of each live store's products from
 *      Shopify (read-only) into `cat_products` (job "cat.sync": at most once per 15 min, so
 *      every catalog run reads; the claim only stops overlapping runs reading twice).
 *   2. Once a day per store, after 06:00 store time, and only if that copy is fresh:
 *      Margin Guard, Pricing, Product Status, New-Product Check (in that order).
 *   3. Once a month per store (fresh copy only): the Feed Hygiene report (zombies, best-sellers
 *      not on sale, SKU count vs ad spend).
 *   4. Once a day per store: Merchant Center Health (doesn't need the product copy).
 * Each agent runs in its own try: one failing never stops the others, a failed daily run
 * gives its claim back so the next tick retries (rule 6), and errors are logged at most
 * once an hour. Nothing is ever written to Shopify, Merchant Center or anywhere outside D1.
 */
import { modeFor, liveMeans } from "../../config/live.js";
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { claimJob } from "../../lib/jobRuns.js";
import { nowIso } from "../../lib/time.js";
import { syncStore, getSync, cacheReady, pagesForStore, passProgress, SYNC_PAGE_BUDGET } from "./sync.js";
import { runPricingStore, AGENT as PRICING } from "./pricing.js";
import { runMarginGuardStore, AGENT as MARGIN } from "./marginGuard.js";
import { runStatusStore, AGENT as STATUS } from "./status.js";
import { runPrepublishStore, AGENT as PREPUBLISH } from "./prepublish.js";
import { runFeedHealthStore, AGENT as FEED } from "./feedHealth.js";
import { runHygieneStore, AGENT as HYGIENE } from "./hygiene.js";
import { rulesFor, PRICE_CEILING } from "./pricingRules.js";
import { dailyDue, claimDaily, releaseDaily, markWaiting, getRun, loadProducts, logEventOnce } from "./common.js";

export const SYNC_JOB = "cat.sync";
/** Catalog runs ~20/40 min apart; 15 min is only a guard against two overlapping runs both reading. */
export const SYNC_EVERY_MIN = 15;
export const STATE_LIST_CAP = 50;

const PRODUCT_AGENTS = [
  { id: MARGIN, run: runMarginGuardStore },
  { id: PRICING, run: runPricingStore },
  { id: STATUS, run: runStatusStore },
  { id: PREPUBLISH, run: runPrepublishStore },
];

/** Catalog work only for live stores that have agreed pricing rules (hc, aub, mar today). */
export function catalogStores() {
  return LIVE_STORE_IDS.filter((id) => rulesFor(id));
}

async function logError(db, actor, store, what, err, nowMs) {
  await logEventOnce(db, {
    actor, kind: "error.catalog", store,
    summary: `${STORES[store] ? STORES[store].name : store}: ${what} failed; will retry (${String(err && err.message).slice(0, 200)})`,
  }, nowMs, 60).catch(() => {});
}

export async function runCatalog(env, { nowMs = Date.now(), fetchImpl = fetch, force = false } = {}) {
  const db = env.DB;
  const out = { sync: {}, agents: {} };
  const stores = catalogStores();

  // 1. Read products (bounded per tick).
  let syncNow = false;
  try { syncNow = force || (await claimJob(db, SYNC_JOB, SYNC_EVERY_MIN, nowMs)); }
  catch (err) { out.sync.error = String(err && err.message); }
  if (syncNow) {
    // One page budget for the whole run (SYNC_PAGE_BUDGET, see sync.js for the subrequest
    // arithmetic), shared so pages one store didn't need go to the next.
    let budget = SYNC_PAGE_BUDGET;
    for (const [i, store] of stores.entries()) {
      const pages = pagesForStore(budget, stores.length - i);
      if (!pages) { out.sync[store] = { status: "skipped", reason: "page budget for this run used up" }; continue; }
      budget -= pages; // charged up front (a failing store may have used them); unused pages are given back below
      try {
        const r = await syncStore(env, store, { nowMs, fetchImpl, pages });
        if (Number.isFinite(r.calls)) budget += pages - r.calls;
        out.sync[store] = r;
        if (r.status === "not_wired") {
          await logEventOnce(db, { actor: PRICING, kind: "catalog.not_wired", store, target: "sys.shopify",
            summary: `${STORES[store].name}: catalog checks can't read products (${r.reason}).` }, nowMs, 24 * 60);
        }
      } catch (err) {
        out.sync[store] = { status: "error", error: String(err && err.message) };
        await logError(db, PRICING, store, "reading products", err, nowMs);
      }
    }
  }

  // 2. Daily product checks, only on a fresh copy.
  for (const store of stores) {
    let products = null, ready = null;
    for (const agent of PRODUCT_AGENTS) {
      const job = `${agent.id}.${store}`;
      try {
        const due = force ? { due: true, day: (await dailyDue(db, job, store, nowMs)).day } : await dailyDue(db, job, store, nowMs);
        if (!due.due) continue;
        if (!ready) ready = cacheReady(await getSync(db, store), nowMs);
        if (!ready.ready) {
          await markWaiting(db, { agent: agent.id, store, day: due.day, nowMs, note: `Waiting for a fresh product read: ${ready.reason}` });
          out.agents[job] = { status: "waiting", reason: ready.reason };
          continue;
        }
        if (!force && !(await claimDaily(db, job, due.day, nowMs))) continue;
        try {
          if (!products) products = await loadProducts(db, store);
          out.agents[job] = await agent.run(env, store, products, { nowMs, day: due.day });
        } catch (err) {
          await releaseDaily(db, job, due.day).catch(() => {});
          throw err;
        }
      } catch (err) {
        out.agents[job] = { status: "error", error: String(err && err.message) };
        await logError(db, agent.id, store, agent.id, err, nowMs);
      }
    }

    // 2b. Feed hygiene (monthly: the course's zombie drafting is a monthly job), fresh copy only.
    const hjob = `${HYGIENE}.${store}`;
    try {
      const due = await dailyDue(db, hjob, store, nowMs);
      const month = due.day.slice(0, 7);
      const row = await db.prepare(`SELECT day FROM cat_daily WHERE job = ?`).bind(hjob).first();
      if (force || (due.due && (!row || row.day < month))) {
        if (!ready) ready = cacheReady(await getSync(db, store), nowMs);
        if (!ready.ready) {
          await markWaiting(db, { agent: HYGIENE, store, day: due.day, nowMs, note: `Waiting for a fresh product read: ${ready.reason}` });
          out.agents[hjob] = { status: "waiting", reason: ready.reason };
        } else if (force || (await claimDaily(db, hjob, month, nowMs))) {
          try {
            if (!products) products = await loadProducts(db, store);
            out.agents[hjob] = await runHygieneStore(env, store, products, { nowMs, day: due.day });
          } catch (err) { await releaseDaily(db, hjob, month).catch(() => {}); throw err; }
        }
      }
    } catch (err) {
      out.agents[hjob] = { status: "error", error: String(err && err.message) };
      await logError(db, HYGIENE, store, "feed hygiene report", err, nowMs);
    }

    // 3. Merchant Center health (daily).
    const job = `${FEED}.${store}`;
    try {
      const due = await dailyDue(db, job, store, nowMs);
      if (force || due.due) {
        if (force || (await claimDaily(db, job, due.day, nowMs))) {
          try { out.agents[job] = await runFeedHealthStore(env, store, { nowMs, day: due.day, fetchImpl }); }
          catch (err) { await releaseDaily(db, job, due.day).catch(() => {}); throw err; }
        }
      }
    } catch (err) {
      out.agents[job] = { status: "error", error: String(err && err.message) };
      await logError(db, FEED, store, "Merchant Center health", err, nowMs);
    }
  }
  return out;
}

/* ---------------- dashboard data ---------------- */

function trimRun(run) {
  if (!run) return { status: "never_run" };
  const findings = Array.isArray(run.findings) ? run.findings : [];
  return {
    status: run.status, note: run.note, day: run.day, ran_at: run.ran_at, summary: run.summary,
    findings: findings.slice(0, STATE_LIST_CAP), findings_total: findings.length,
  };
}

export async function catalogState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const stores = [];
  for (const store of catalogStores()) {
    const rules = rulesFor(store);
    const sync = await getSync(db, store);
    const counts = await db.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active FROM cat_products WHERE store = ?`
    ).bind(store).first();
    const ready = cacheReady(sync, nowMs);
    const agents = {};
    for (const id of [PRICING, MARGIN, STATUS, PREPUBLISH, FEED, HYGIENE]) agents[id] = trimRun(await getRun(db, id, store));
    stores.push({
      store, name: STORES[store].name,
      rules: { band: rules.band, shape: rules.shape, floor: rules.floor, ceiling: rules.ceiling, badge: rules.badge },
      products: {
        read: (counts && counts.n) || 0, active: (counts && counts.active) || 0,
        fresh: ready.ready, not_fresh_reason: ready.reason,
        last_full_at: sync ? sync.last_full_at : null, last_read_at: sync ? sync.last_pass_at : null,
        // Products read so far in the pass, its size and an estimate of time to completion.
        pass_in_progress: passProgress(sync, nowMs),
        reads: "active and draft products only (archived ones drop out on the next full read)",
        last_error: sync && sync.last_error ? { message: sync.last_error, at: sync.last_error_at } : null,
      },
      pricing: agents[PRICING], margin: agents[MARGIN], status: agents[STATUS], new_products: agents[PREPUBLISH], merchant_center: agents[FEED],
      feed_hygiene: agents[HYGIENE], // monthly: zombies, best-sellers not on sale, SKUs vs spend
    });
  }
  const { results } = await db.prepare(
    `SELECT id, created_at, store, requested_by, title, status FROM approvals WHERE dept = 'cat' AND status = 'pending' ORDER BY id DESC LIMIT ?`
  ).bind(STATE_LIST_CAP).all();
  return {
    generated_at: nowIso(nowMs), mode: modeFor(env, "catalog"), live_means: liveMeans(env, "catalog"), ceiling: PRICE_CEILING,
    stores, pending_approvals: results || [],
  };
}
