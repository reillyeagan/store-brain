/**
 * media.billing — Google Ads billing & balance watch. WATCH ONLY: three read-only GAQL
 * SELECTs per store per day through the media AdsSession. Never pays, never edits billing
 * (rule 12: Reilly pays; Guy runs the ads).
 *
 * Why: a failed Google Ads charge pauses the ads, which first looks like "stopped spending"
 * (Memory Log 2026-09-27: threshold charges, PayPal settles in ~20 min, a bank in 3-5 days).
 *
 * What it reads (each part judged on its own, so one refused part doesn't hide the others):
 *   account — customer.status: SUSPENDED / CANCELED / CLOSED is a red flag. Google answering
 *             CUSTOMER_NOT_ENABLED for the account is the same news (deactivated).
 *   billing — billing_setup.status: no APPROVED setup in force (PENDING, CANCELLED,
 *             APPROVED_HELD) means Google may not be able to charge.
 *   budget  — account_budget (monthly-invoicing accounts only): approved spending limit vs
 *             amount served; 90%+ used is "nearly exhausted" (97%+ is bad). Card-paid accounts
 *             usually have no account budget: that is "none", not a problem.
 *   failed payment — the Google Ads API has no "last charge failed" field (payments history
 *             lives only in the Billing UI / Payments center). Shown as NOT WIRED with that
 *             reason; a failed charge still shows up as spend stopping, which media.spend_alarm
 *             watches.
 * A part Google refuses for lack of access (PERMISSION_DENIED, authorization errors, a field
 * this API version doesn't know) is NOT WIRED with Google's reason, never an error and never
 * "fine". Anything else throws (the media runner logs it hourly at most and retries).
 * Outputs: media_findings (agent media.billing; key "check" holds the latest read), one
 * media.billing_flag event per new red flag.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { upsertFinding, clearUnseen, storeName, micros, r2, money } from "./common.js";

export const AGENT = "media.billing";
export const CALLS = 3;
export const BUDGET_WARN = 0.9;
export const BUDGET_BAD = 0.97;
export const FAILED_PAYMENT_NOT_WIRED = "the Google Ads API has no failed-charge field (payment history is only in the Billing UI); a failed charge shows as spend stopping, which the Spend Alarm watches";

export const Q_ACCOUNT = "SELECT customer.id, customer.status, customer.descriptive_name FROM customer";
export const Q_BILLING = "SELECT billing_setup.id, billing_setup.status, billing_setup.payments_account, billing_setup.start_date_time, billing_setup.end_date_time FROM billing_setup";
export const Q_BUDGET = "SELECT account_budget.id, account_budget.status, account_budget.approved_spending_limit_micros, account_budget.approved_spending_limit_type, account_budget.adjusted_spending_limit_micros, account_budget.amount_served_micros, account_budget.approved_end_date_time FROM account_budget";

/** Google refused for lack of access / an unknown field: a wiring gap, not news about the account. */
export const isAccessGap = (msg) => /PERMISSION_DENIED|authorizationError|USER_PERMISSION_DENIED|ACTION_NOT_PERMITTED|NOT_ALLOWLISTED|UNRECOGNIZED_FIELD|PROHIBITED_RESOURCE|queryError=/i.test(String(msg || ""));
export const isNotEnabled = (msg) => /CUSTOMER_NOT_ENABLED/i.test(String(msg || ""));

/** Pure judges. Each returns {status: ok|flag|none, severity?, summary, data}. */
export function judgeAccount(rows) {
  const c = rows[0] && rows[0].customer;
  if (!c || !c.status) return { status: "none", summary: "account status not returned" };
  if (["SUSPENDED", "CANCELED", "CLOSED"].includes(c.status)) return { status: "flag", severity: "bad", summary: `Google Ads account is ${c.status}`, data: { status: c.status } };
  return { status: "ok", summary: `account ${c.status}`, data: { status: c.status } };
}

export function judgeBilling(rows, nowMs) {
  const setups = rows.map((r) => r.billingSetup).filter(Boolean);
  if (!setups.length) return { status: "flag", severity: "warn", summary: "no billing setup returned by Google (can Google charge this account?)", data: { setups: 0 } };
  const now = new Date(nowMs).toISOString().replace("T", " ").slice(0, 19);
  const inForce = setups.filter((s) => s.status === "APPROVED" && (!s.endDateTime || s.endDateTime > now) && (!s.startDateTime || s.startDateTime <= now));
  if (inForce.length) return { status: "ok", summary: "billing setup approved", data: { statuses: setups.map((s) => s.status) } };
  const statuses = [...new Set(setups.map((s) => s.status))];
  return { status: "flag", severity: statuses.includes("APPROVED_HELD") || statuses.includes("CANCELLED") ? "bad" : "warn",
    summary: `no approved billing setup in force (${statuses.join(", ")})`, data: { statuses } };
}

export function judgeBudget(rows) {
  const budgets = rows.map((r) => r.accountBudget).filter(Boolean).filter((b) => b.status !== "CANCELLED");
  if (!budgets.length) return { status: "none", summary: "no account budget (normal for card-paid accounts)" };
  const b = budgets[0];
  const limitMicros = b.adjustedSpendingLimitMicros ?? b.approvedSpendingLimitMicros;
  if (limitMicros == null || b.approvedSpendingLimitType === "INFINITE") return { status: "ok", summary: "account budget with no spending limit", data: { status: b.status } };
  const limit = micros(limitMicros), served = micros(b.amountServedMicros);
  const used = limit > 0 ? served / limit : 1;
  const data = { limit: r2(limit), served: r2(served), left: r2(limit - served), used: Math.round(used * 1000) / 1000, ends: b.approvedEndDateTime || null };
  if (used >= BUDGET_WARN) {
    return { status: "flag", severity: used >= BUDGET_BAD ? "bad" : "warn",
      summary: `account budget ${Math.round(used * 100)}% used: ${money(data.left)} left of ${money(data.limit)} (ads stop when it runs out)`, data };
  }
  return { status: "ok", summary: `account budget ${Math.round(used * 100)}% used`, data };
}

/** Run one query; an access gap becomes {notWired}, CUSTOMER_NOT_ENABLED becomes {notEnabled}. */
async function read(session, storeId, q) {
  try {
    return { rows: await session.query(storeId, q) };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.code === "NOT_WIRED" || err.code === "CALL_BUDGET")) throw err;
    if (isNotEnabled(msg)) return { notEnabled: msg.slice(0, 200) };
    if (isAccessGap(msg)) return { notWired: msg.slice(0, 200) };
    throw err;
  }
}

export async function runBilling(env, { storeId, session, nowMs = Date.now() }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const parts = {};
  const a = await read(session, storeId, Q_ACCOUNT);
  parts.account = a.notEnabled ? { status: "flag", severity: "bad", summary: "Google says this account is not enabled (suspended, cancelled or deactivated)", data: { google: a.notEnabled } }
    : a.notWired ? { status: "not_wired", summary: `not wired: ${a.notWired}` } : judgeAccount(a.rows);
  if (!a.notEnabled) {
    const b = await read(session, storeId, Q_BILLING);
    parts.billing = b.notWired || b.notEnabled ? { status: "not_wired", summary: `not wired: ${b.notWired || b.notEnabled}` } : judgeBilling(b.rows, nowMs);
    const g = await read(session, storeId, Q_BUDGET);
    parts.budget = g.notWired || g.notEnabled ? { status: "not_wired", summary: `not wired: ${g.notWired || g.notEnabled}` } : judgeBudget(g.rows);
  }
  parts.failed_payment = { status: "not_wired", summary: `not wired: ${FAILED_PAYMENT_NOT_WIRED}` };

  const flags = Object.entries(parts).filter(([, p]) => p.status === "flag");
  const keys = ["check", ...flags.map(([k]) => k)];
  await upsertFinding(db, { store: storeId, agent: AGENT, key: "check", severity: flags.some(([, p]) => p.severity === "bad") ? "bad" : flags.length ? "warn" : "info",
    summary: Object.entries(parts).map(([k, p]) => `${k}: ${p.summary}`).join(" · "), data: { parts, read_at: at }, at });
  for (const [k, p] of flags) {
    const isNew = await upsertFinding(db, { store: storeId, agent: AGENT, key: k, severity: p.severity, summary: p.summary, data: p.data || null, at });
    if (isNew) {
      await logEvent(db, { actor: AGENT, kind: "media.billing_flag", store: storeId, target: "sys.ads", at,
        summary: `${storeName(storeId)}: ${p.summary}. Watch only: Reilly handles billing.`, data: { part: k, ...(p.data || {}) } });
    }
  }
  await clearUnseen(db, { store: storeId, agent: AGENT, keys, at });
  const nw = Object.entries(parts).filter(([, p]) => p.status === "not_wired").map(([k]) => k);
  return `ok: ${flags.length ? `FLAG ${flags.map(([k]) => k).join("+")}` : "no billing problem seen"}${nw.length ? `; not wired: ${nw.join(", ")}` : ""}`;
}
