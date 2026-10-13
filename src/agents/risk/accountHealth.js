/**
 * Account Health (risk.account_health) — SHADOW, plain code.
 *
 * What it does: once a day, per live store (read-only):
 *   - Shopify Payments account: activated?, payout schedule, FAILED payouts among the last 10;
 *   - dispute rate over the last 90 days = disputes opened ÷ orders placed (spec: "watch
 *     ~0.75%"; we mark "watch" from 0.5% and "bad" from 0.75%);
 *   - refund rate over 90 days (orders refunded ÷ orders placed), ONLY when the ledger's refund
 *     feed covers the whole window; otherwise null ("not covered"), never 0.
 * It logs one daily check line, an alert event only when a store gets WORSE (spec: "Alerts
 * only when something gets worse"), and a weekly summary.
 *
 * Inputs: Shopify `ordersCount`, `disputes`, `shopifyPaymentsAccount` (Store Guard); the
 * ledger's refunds + feed_coverage tables.
 * Outputs: risk_account_health (latest per store), events.
 *
 * Skipped on purpose: Merchant Center account warnings (the Catalog team owns Merchant
 * Center) and Google Ads policy flags (Media). Nothing here changes any account.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay } from "../../lib/time.js";
import { DAY_MS, logProblem, safeJson } from "./shared.js";

export const ACTOR = "risk.account_health";
export const WINDOW_DAYS = 90;
export const DISPUTE_WATCH = 0.005;  // 0.5%
export const DISPUTE_BAD = 0.0075;   // 0.75% (spec)

/** Validated against Admin 2026-07. */
export const RATES_QUERY = `query RiskRates($orders: String!, $disputes: String!) {
  ordersCount(query: $orders, limit: null) { count precision }
  disputes(first: 100, query: $disputes) { nodes { id status } pageInfo { hasNextPage } }
}`;
export const ACCOUNT_QUERY = `query RiskAccount {
  shopifyPaymentsAccount {
    activated onboardable
    payoutSchedule { interval }
    payouts(first: 10, reverse: true) { nodes { id status issuedAt net { amount currencyCode } } }
  }
}`;

const RANK = { ok: 0, watch: 1, bad: 2 };
const pct = (r) => (r == null ? "unknown" : `${(r * 100).toFixed(2)}%`);

/**
 * Pure: judge one store from what was read. Unknown inputs stay unknown; the state is
 * null only when nothing at all could be judged.
 */
export function judgeHealth(h) {
  const reasons = [];
  let state = null;
  const bump = (s, why) => { reasons.push(why); if (state == null || RANK[s] > RANK[state]) state = s; };
  if (h.payments_activated === 0) bump("bad", "Shopify Payments is not activated");
  if (h.failed_payouts > 0) bump("bad", `${h.failed_payouts} failed payout${h.failed_payouts === 1 ? "" : "s"} among the last 10`);
  if (h.dispute_rate != null) {
    const floor = h.disputes_at_least ? " (at least)" : "";
    if (h.dispute_rate >= DISPUTE_BAD) bump("bad", `Dispute rate ${pct(h.dispute_rate)}${floor} over 90 days (limit to watch: 0.75%)`);
    else if (h.dispute_rate >= DISPUTE_WATCH) bump("watch", `Dispute rate ${pct(h.dispute_rate)}${floor} over 90 days, getting close to 0.75%`);
  }
  const anyKnown = h.payments_activated != null || h.dispute_rate != null || h.failed_payouts != null;
  if (state == null && anyKnown) state = "ok";
  return { state, reasons };
}

/** Refunded orders ÷ orders over the window, only if the refund feed covers the window. */
async function refundRate(db, storeId, sinceIso, ordersCount) {
  const tz = STORES[storeId].timezone || "America/New_York";
  const sinceDay = localDay(Date.parse(sinceIso), tz);
  const cov = await db.prepare(`SELECT covered_from FROM feed_coverage WHERE store = ? AND feed = 'refunds'`).bind(storeId).first().catch(() => null);
  if (!cov || !cov.covered_from || cov.covered_from > sinceDay) {
    return { rate: null, note: cov && cov.covered_from ? `refunds only read from ${cov.covered_from}` : "refund feed coverage not complete" };
  }
  if (!ordersCount) return { rate: null, note: "no orders to compare with" };
  const r = await db.prepare(`SELECT COUNT(DISTINCT order_id) AS n FROM refunds WHERE store = ? AND processed_at >= ?`).bind(storeId, sinceIso).first();
  return { rate: Number(r && r.n || 0) / ordersCount, note: null };
}

async function checkStore(env, storeId, { nowMs, fetchImpl }) {
  const sinceIso = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  const h = { payments_activated: null, payout_interval: null, failed_payouts: null, orders_90d: null, orders_precision: null,
    disputes_90d: null, disputes_at_least: 0, dispute_rate: null, refund_rate: null };
  const notes = [];
  const problems = [];
  let ratesOk = false, accountOk = false;

  try {
    const d = await shopifyGraphQL(env, storeId, RATES_QUERY,
      { orders: `created_at:>='${sinceIso}' AND test:false`, disputes: `initiated_at:>='${sinceIso}'` }, { fetchImpl, nowMs });
    const oc = d && d.ordersCount;
    h.orders_90d = oc && Number.isFinite(oc.count) ? oc.count : null;
    h.orders_precision = (oc && oc.precision) || null;
    const conn = d && d.disputes;
    h.disputes_90d = conn ? (conn.nodes || []).length : null;
    h.disputes_at_least = conn && conn.pageInfo && conn.pageInfo.hasNextPage ? 1 : 0;
    // Orders "AT_LEAST" means the true count is higher, so the rate shown can only be too high:
    // the safe direction. No orders → no rate (never 0%).
    if (h.orders_90d && h.disputes_90d != null) h.dispute_rate = h.disputes_90d / h.orders_90d;
    ratesOk = !!oc && !!conn;
    if (!ratesOk) notes.push("dispute rate: Shopify's answer was incomplete");
  } catch (err) {
    problems.push(await logProblem(env.DB, ACTOR, storeId, err, `${STORES[storeId].name} dispute rate`, nowMs));
    notes.push(`dispute rate not read: ${String(err && err.message).slice(0, 120)}`);
  }

  try {
    const d = await shopifyGraphQL(env, storeId, ACCOUNT_QUERY, {}, { fetchImpl, nowMs });
    const a = d && d.shopifyPaymentsAccount;
    if (a) {
      h.payments_activated = a.activated ? 1 : 0;
      h.payout_interval = (a.payoutSchedule && a.payoutSchedule.interval) || null;
      const payouts = (a.payouts && a.payouts.nodes) || [];
      h.failed_payouts = payouts.filter((p) => p.status === "FAILED").length;
      accountOk = true;
    } else {
      notes.push("Shopify returned no Payments account");
    }
  } catch (err) {
    problems.push(await logProblem(env.DB, ACTOR, storeId, err, `${STORES[storeId].name} Payments account`, nowMs));
    notes.push(`Payments account not read: ${String(err && err.message).slice(0, 120)}`);
  }

  const rr = await refundRate(env.DB, storeId, sinceIso, h.orders_90d);
  h.refund_rate = rr.rate;
  if (rr.note) notes.push(`refund rate: ${rr.note}`);

  return { h, notes, problems, ratesOk, accountOk };
}

const RATE_FIELDS = ["orders_90d", "orders_precision", "disputes_90d", "disputes_at_least", "dispute_rate", "refund_rate"];
const ACCOUNT_FIELDS = ["payments_activated", "payout_interval", "failed_payouts"];

/**
 * Pure: combine a (possibly partial) read with the last stored row. A probe that failed
 * says nothing about the store (rule 6), so its fields keep their last known values, and a
 * partial read may raise the state but never lower it (rule 5: a failed read must not make
 * a "bad" store look "ok", and must not set up a false "worse" alert on the next full read).
 */
export function mergeHealth(read, prevRow) {
  const h = { ...read.h };
  if (prevRow) {
    if (!read.ratesOk) for (const k of RATE_FIELDS) h[k] = prevRow[k];
    if (!read.accountOk) for (const k of ACCOUNT_FIELDS) h[k] = prevRow[k];
  }
  const verdict = judgeHealth(h);
  const partial = !read.ratesOk || !read.accountOk;
  let state = verdict.state;
  const reasons = [...verdict.reasons];
  const prevState = prevRow && prevRow.state;
  if (partial && prevState && (state == null || RANK[state] < RANK[prevState])) {
    state = prevState;
    reasons.push(`kept "${prevState}" from the last full check (this check could not read everything)`);
  }
  return { h, state, reasons, partial };
}

export async function runAccountHealth(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const out = {};
  const lines = [];
  for (const storeId of LIVE_STORE_IDS) {
    const name = STORES[storeId].name;
    const prev = await db.prepare(`SELECT * FROM risk_account_health WHERE store = ?`).bind(storeId).first();
    const read = await checkStore(env, storeId, { nowMs, fetchImpl });
    const { notes, problems } = read;
    // A store we couldn't read at all keeps its last row untouched: a failed probe says nothing
    // about the store (rule 6).
    if (!read.ratesOk && !read.accountOk) { out[storeId] = { state: prev ? prev.state : null, problems, notRead: true }; lines.push(`${name}: not read`); continue; }
    const { h, state, reasons, partial } = mergeHealth(read, prev);
    const verdict = { state, reasons };
    await db.prepare(
      `INSERT INTO risk_account_health (store, checked_at, state, payments_activated, payout_interval, failed_payouts, orders_90d,
         orders_precision, disputes_90d, disputes_at_least, dispute_rate, refund_rate, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store) DO UPDATE SET checked_at = excluded.checked_at, state = excluded.state,
         payments_activated = excluded.payments_activated, payout_interval = excluded.payout_interval,
         failed_payouts = excluded.failed_payouts, orders_90d = excluded.orders_90d, orders_precision = excluded.orders_precision,
         disputes_90d = excluded.disputes_90d, disputes_at_least = excluded.disputes_at_least, dispute_rate = excluded.dispute_rate,
         refund_rate = excluded.refund_rate, detail = excluded.detail`
    ).bind(storeId, at, verdict.state, h.payments_activated, h.payout_interval, h.failed_payouts, h.orders_90d, h.orders_precision,
      h.disputes_90d, h.disputes_at_least, h.dispute_rate, h.refund_rate, JSON.stringify({ reasons: verdict.reasons, notes, partial })).run();
    out[storeId] = { state: verdict.state, reasons: verdict.reasons };
    lines.push(`${name}: ${verdict.state || "unknown"}, disputes ${pct(h.dispute_rate)}`);
    const before = prev && prev.state ? RANK[prev.state] : 0;
    if (verdict.state && RANK[verdict.state] > before) {
      await logEvent(db, {
        actor: ACTOR, kind: "risk.health_worse", store: storeId, target: "sys.shopify",
        summary: `${name} account health got worse (${prev && prev.state ? prev.state : "ok"} → ${verdict.state}): ${verdict.reasons.join("; ")}`.slice(0, 480),
        data: { from: prev ? prev.state : null, to: verdict.state, ...h }, at,
      });
    }
  }
  await logEvent(db, { actor: ACTOR, kind: "risk.health_checked", summary: `Account health checked: ${lines.join(" · ")}`.slice(0, 480), data: out, at });
  return out;
}

/** Weekly summary event from the latest rows (no Shopify calls). */
export async function weeklyHealthSummary(env, { nowMs = Date.now() } = {}) {
  const { results } = await env.DB.prepare(`SELECT * FROM risk_account_health ORDER BY store`).all();
  const rows = results || [];
  const lines = rows.map((r) => {
    const d = safeJson(r.detail, {}) || {};
    return `${STORES[r.store] ? STORES[r.store].name : r.store}: ${r.state || "unknown"}; disputes ${r.disputes_90d ?? "?"}/${r.orders_90d ?? "?"} orders (${pct(r.dispute_rate)}); refunds ${pct(r.refund_rate)}${(d.reasons || []).length ? `; ${d.reasons.join(", ")}` : ""}`;
  });
  await logEvent(env.DB, {
    actor: ACTOR, kind: "risk.health_weekly",
    summary: rows.length ? `Weekly account health: ${lines.join(" | ")}`.slice(0, 480) : "Weekly account health: no store has been read yet",
    data: { stores: rows.map((r) => ({ store: r.store, state: r.state, dispute_rate: r.dispute_rate, refund_rate: r.refund_rate })) },
    at: nowIso(nowMs),
  });
  return lines;
}
