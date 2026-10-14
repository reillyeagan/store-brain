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
import { DAY_MS, logProblem, logOnce, safeJson } from "./shared.js";

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
    payouts(first: 10, reverse: true) { nodes { id status issuedAt net { amount currencyCode } } }
  }
}`;
/**
 * The payout schedule is asked for on its own. Why: live 2026-10-14 Shopify answered
 * "Field inside method payout_schedule is not available for this account" for every store,
 * and because it sat inside ACCOUNT_QUERY the whole Payments read failed every day (activated
 * and failed payouts were lost too). ShopifyPaymentsPayoutSchedule needs one of the
 * read_shopify_payments(_accounts|_payouts) scopes AND a user with the view_payouts
 * permission; our app token comes from the client-credentials grant (no user), so Shopify
 * may never give it to us. Safe option: read it separately, and if Shopify says it is not
 * available, record the interval as null with that reason. Never an error loop.
 */
export const PAYOUT_SCHEDULE_QUERY = `query RiskPayoutSchedule {
  shopifyPaymentsAccount { payoutSchedule { interval } }
}`;
/** Below this many orders in 90 days, one dispute moves the rate a lot: say so next to it. */
export const SMALL_SAMPLE_ORDERS = 100;

/** Shopify refused the payout schedule for this account (as opposed to a passing fault). */
export const isScheduleUnavailable = (err) =>
  !!err && (err.code === "GRAPHQL_ERRORS" || err.code === "GRAPHQL_HTTP") &&
  /not available for this account|access denied|required access|view_payouts|payout_?schedule/i.test(String(err.message));

const RANK = { ok: 0, watch: 1, bad: 2 };
const pct = (r) => (r == null ? "unknown" : `${(r * 100).toFixed(2)}%`);

/** "1 of 30 orders" (the count next to the rate, so 3.33% from one dispute reads as one dispute). */
export function disputeCount(h) {
  if (h.disputes_90d == null || h.orders_90d == null) return null;
  return `${h.disputes_at_least ? "at least " : ""}${h.disputes_90d} of ${h.orders_precision === "AT_LEAST" ? "at least " : ""}${h.orders_90d} orders`;
}

/** "won 1" / "won 1, lost 1, open 1" from Shopify's dispute statuses, or null. */
export function outcomesText(o) {
  if (!o) return null;
  const won = o.WON || 0, lost = o.LOST || 0, acc = o.ACCEPTED || 0;
  const open = Object.entries(o).filter(([k]) => !["WON", "LOST", "ACCEPTED"].includes(k)).reduce((s, [, n]) => s + n, 0);
  const parts = [won && `won ${won}`, lost && `lost ${lost}`, acc && `accepted ${acc}`, open && `open ${open}`].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The small-sample note: shown when fewer than SMALL_SAMPLE_ORDERS orders in 90 days. The
 * rate itself is never hidden or softened (rule 5); the note only says how much one dispute
 * weighs.
 */
export function smallSampleNote(h) {
  if (h.orders_90d == null || h.orders_90d >= SMALL_SAMPLE_ORDERS || !h.disputes_90d) return null;
  const step = (100 / h.orders_90d).toFixed(2);
  const out = outcomesText(h.dispute_outcomes);
  return `Small sample: only ${h.orders_90d} orders in 90 days, so each dispute moves the rate by ${step} points${out ? ` (${out})` : ""}. Card networks count disputes whatever the outcome, so the rate stands.`;
}

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
    const count = disputeCount(h);
    const rate = `${pct(h.dispute_rate)}${floor}${count ? ` (${count})` : ""}`;
    if (h.dispute_rate >= DISPUTE_BAD) bump("bad", `Dispute rate ${rate} over 90 days (limit to watch: 0.75%)`);
    else if (h.dispute_rate >= DISPUTE_WATCH) bump("watch", `Dispute rate ${rate} over 90 days, getting close to 0.75%`);
    // Only next to a flagged rate: an "ok" store needs no caveat.
    const small = h.dispute_rate >= DISPUTE_WATCH && smallSampleNote(h);
    if (small) reasons.push(small);
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
    disputes_90d: null, disputes_at_least: 0, dispute_rate: null, refund_rate: null, dispute_outcomes: null };
  const notes = [];
  const problems = [];
  let ratesOk = false, accountOk = false, scheduleOk = false, payoutIntervalNote = null;

  try {
    const d = await shopifyGraphQL(env, storeId, RATES_QUERY,
      { orders: `created_at:>='${sinceIso}' AND test:false`, disputes: `initiated_at:>='${sinceIso}'` }, { fetchImpl, nowMs });
    const oc = d && d.ordersCount;
    h.orders_90d = oc && Number.isFinite(oc.count) ? oc.count : null;
    h.orders_precision = (oc && oc.precision) || null;
    const conn = d && d.disputes;
    h.disputes_90d = conn ? (conn.nodes || []).length : null;
    if (conn) {
      h.dispute_outcomes = {};
      for (const n of conn.nodes || []) { const s = String(n.status || "UNKNOWN"); h.dispute_outcomes[s] = (h.dispute_outcomes[s] || 0) + 1; }
    }
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

  // Payout schedule: its own read, so Shopify refusing it can't take the rest down.
  if (accountOk) {
    try {
      const d = await shopifyGraphQL(env, storeId, PAYOUT_SCHEDULE_QUERY, {}, { fetchImpl, nowMs });
      const a = d && d.shopifyPaymentsAccount;
      h.payout_interval = (a && a.payoutSchedule && a.payoutSchedule.interval) || null;
      if (!h.payout_interval) payoutIntervalNote = "Shopify gave no payout schedule";
      scheduleOk = true;
    } catch (err) {
      if (isScheduleUnavailable(err)) {
        // Not a fault and not "unknown for now": Shopify won't show it to this app. Null with
        // the reason, noted once a day at most, never an error.
        h.payout_interval = null;
        payoutIntervalNote = `not available to the Store Brain's app (Shopify: ${String(err.message).replace(/^[^:]+:\s*/, "").slice(0, 140)})`;
        scheduleOk = true;
        await logOnce(env.DB, { actor: ACTOR, kind: "risk.not_wired", store: storeId,
          summary: `${STORES[storeId].name} payout schedule: ${payoutIntervalNote}. Shown as not available; the rest of the Payments check runs.` },
          { windowMin: 24 * 60, nowMs }).catch(() => {});
      } else {
        // A passing fault: keep the last known interval (mergeHealth), say so, retry tomorrow.
        payoutIntervalNote = `not read this time (${String(err && err.message).slice(0, 120)}); last known value kept`;
        notes.push(`payout schedule: ${payoutIntervalNote}`);
      }
    }
  }

  const rr = await refundRate(env.DB, storeId, sinceIso, h.orders_90d);
  h.refund_rate = rr.rate;
  if (rr.note) notes.push(`refund rate: ${rr.note}`);

  return { h, notes, problems, ratesOk, accountOk, scheduleOk, payoutIntervalNote };
}

const RATE_FIELDS = ["orders_90d", "orders_precision", "disputes_90d", "disputes_at_least", "dispute_rate", "refund_rate"];
const ACCOUNT_FIELDS = ["payments_activated", "failed_payouts"];

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
    // The interval is kept only after a passing fault; "not available" is a real answer (null).
    if (!read.scheduleOk) h.payout_interval = prevRow.payout_interval;
    if (!read.ratesOk) {
      const d = safeJson(prevRow.detail, {}) || {};
      h.dispute_outcomes = d.dispute_outcomes || null;
    }
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
      h.disputes_90d, h.disputes_at_least, h.dispute_rate, h.refund_rate, JSON.stringify({
        reasons: verdict.reasons, notes, partial,
        dispute_outcomes: h.dispute_outcomes || null,
        // Why the interval is null (or kept), so the page never shows a bare "—".
        payout_interval_note: h.payout_interval ? null : (read.payoutIntervalNote || "Payments account not read yet"),
      })).run();
    out[storeId] = { state: verdict.state, reasons: verdict.reasons };
    const cnt = disputeCount(h);
    lines.push(`${name}: ${verdict.state || "unknown"}, disputes ${pct(h.dispute_rate)}${cnt ? ` (${cnt})` : ""}`);
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
    return `${STORES[r.store] ? STORES[r.store].name : r.store}: ${r.state || "unknown"}; disputes ${r.disputes_90d ?? "?"} of ${r.orders_90d ?? "?"} orders (${pct(r.dispute_rate)}); refunds ${pct(r.refund_rate)}${(d.reasons || []).length ? `; ${d.reasons.join(", ")}` : ""}`;
  });
  await logEvent(env.DB, {
    actor: ACTOR, kind: "risk.health_weekly",
    summary: rows.length ? `Weekly account health: ${lines.join(" | ")}`.slice(0, 480) : "Weekly account health: no store has been read yet",
    data: { stores: rows.map((r) => ({ store: r.store, state: r.state, dispute_rate: r.dispute_rate, refund_rate: r.refund_rate })) },
    at: nowIso(nowMs),
  });
  return lines;
}
