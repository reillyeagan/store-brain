/**
 * Tax, Admin & Triggers (pnl.calendar) — plain code, L1, shadow-safe (writes only events and
 * its own reminder log; it never pays, files or moves money: Reilly does, rule 12).
 *
 * What it does:
 *  1. Dated obligations → reminder events 7 days before, 1 day before and on the day (each
 *     once). Sources: a small static list (US federal estimated-tax due dates, the chargeback
 *     deadline written in the P&L spec) plus any `calendar:*` facts in the Core (Reilly's
 *     subscription log, invoices, billing days). These are GENERAL REMINDERS, NOT TAX ADVICE:
 *     the dates follow the IRS's usual 15th rule moved past weekends and MLK Day; holidays and
 *     disaster extensions can move them; Reilly's accountant has the final word.
 *  2. Money triggers from the ledger, at most once a day each:
 *     - Shopify Payments balance above CAL_BALANCE_ABOVE_USD (off until Reilly sets a number);
 *     - 7-day refund rate above CAL_REFUND_RATE_ABOVE (default 11.9%, the refund allowance in
 *       the break-even ROAS formula);
 *     - month-to-date loss: profit (or, when inputs are missing, even the costs we DO know)
 *       already below zero.
 * Inputs: the static list, core_facts (calendar:*), money_balances, pnl_days.
 * Outputs: `calendar.reminder` and `trigger.*` events (target core.briefer), calendar_reminders rows.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";
import { minusDays } from "../../lib/adsSpend.js";
import { rowsBetween } from "../../lib/pnl.js";
import { r2, r4, safeJson } from "../core/shared.js";

const ACTOR = "pnl.calendar";
export const REMIND_DAYS = [7, 1, 0];
export const DEFAULT_REFUND_RATE_ABOVE = 0.119; // docs/specs/media.md break-even formula's refund allowance
export const BALANCE_MAX_AGE_H = 24;
export const DISCLAIMER = "General reminder, not tax advice: check the date with your accountant / irs.gov.";

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Third Monday of January (MLK Day), a federal holiday. */
function mlkDay(year) {
  let d = 1;
  while (dow(iso(year, 1, d)) !== 1) d++;
  return iso(year, 1, d + 14);
}

/** Move a due date past weekends (and MLK Day, which can touch the January payment). */
export function rollForward(day) {
  let d = day;
  for (let i = 0; i < 7; i++) {
    const w = dow(d);
    if (w === 0 || w === 6 || d === mlkDay(Number(d.slice(0, 4)))) d = minusDays(d, -1);
    else break;
  }
  return d;
}

/**
 * Federal estimated tax (Form 1040-ES) due dates for a tax year: Apr 15, Jun 15, Sep 15 and
 * Jan 15 of the next year, rolled forward. Profits of a single-member LLC normally reach the
 * owner's own return, hence 1040-ES; if the LLC is taxed differently the dates differ.
 */
export function federalEstimatedTaxDates(taxYear) {
  return [
    { q: 1, due: rollForward(iso(taxYear, 4, 15)) },
    { q: 2, due: rollForward(iso(taxYear, 6, 15)) },
    { q: 3, due: rollForward(iso(taxYear, 9, 15)) },
    { q: 4, due: rollForward(iso(taxYear + 1, 1, 15)) },
  ].map((x) => ({ id: `fed_est_tax_${taxYear}_q${x.q}`, due: x.due, label: `Federal estimated tax, ${taxYear} Q${x.q} (Form 1040-ES)`, kind: "tax", note: DISCLAIMER, source: "IRS 1040-ES schedule (general)" }));
}

/** Static obligations around a moment (this tax year and the next). */
export function staticObligations(nowMs) {
  const y = Number(new Date(nowMs).toISOString().slice(0, 4));
  return [
    ...federalEstimatedTaxDates(y - 1), ...federalEstimatedTaxDates(y), ...federalEstimatedTaxDates(y + 1),
    { id: "chargeback_1053", due: "2026-10-31", label: "Chargeback #1053: response deadline", kind: "deadline", source: "docs/specs/pnl-finance.md (Tax, Admin & Triggers)" },
  ];
}

/**
 * Obligations Reilly keeps in the Core: key `calendar:<name>`, value JSON
 *   {"due":"2026-11-03","label":"..."}            one date, or
 *   {"day_of_month":5,"label":"...","amount":29}  every month (subscription log / billing day).
 */
export async function coreObligations(db, todayDay) {
  const { results } = await db.prepare(`SELECT id, store, key, value, source FROM core_facts WHERE live = 1 AND key LIKE 'calendar:%' ORDER BY id`).all();
  const out = [];
  for (const f of results || []) {
    const v = safeJson(f.value, null);
    if (!v || typeof v !== "object") continue;
    const label = String(v.label || f.key.slice(9));
    if (v.due && /^\d{4}-\d{2}-\d{2}$/.test(v.due)) out.push({ id: f.key, due: v.due, label, kind: v.kind || "admin", store: f.store, source: `core:${f.key}` });
    else if (Number(v.day_of_month) >= 1 && Number(v.day_of_month) <= 31) {
      // This month's date, or next month's once this month's has passed.
      for (const offset of [0, 1]) {
        const base = new Date(`${todayDay.slice(0, 7)}-01T12:00:00Z`);
        base.setUTCMonth(base.getUTCMonth() + offset);
        const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1;
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const due = iso(y, m, Math.min(Number(v.day_of_month), last));
        if (due >= todayDay) { out.push({ id: f.key, due, label, kind: v.kind || "billing", store: f.store, amount: v.amount ?? null, source: `core:${f.key}` }); break; }
      }
    }
  }
  return out;
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Pure: which reminder bucket (7, 1 or 0 days before) applies today, or null. */
export function reminderBucket(today, due) {
  const left = daysBetween(today, due);
  if (left < 0) return null;
  const fit = REMIND_DAYS.filter((d) => d >= left).sort((x, y) => x - y)[0];
  return fit == null ? null : fit;
}

async function once(db, key, due, at) {
  const r = await db.prepare(`INSERT INTO calendar_reminders (key, due_day, sent_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`).bind(key, due, at).run();
  return !!(r.meta && r.meta.changes);
}

/** Money triggers (pure parts take rows; see the header for each rule). */
export function refundRate(rows) {
  if (!rows.length || rows.some((r) => r.revenue == null || r.refunds == null)) return null;
  const rev = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const ref = rows.reduce((s, r) => s + Number(r.refunds), 0);
  return rev > 0 ? ref / rev : null;
}

/**
 * Month-to-date result for a loss check. `profit` when every day is known; otherwise
 * `upper_bound`: the sum of profit_partial, valid only when revenue is known every day (the
 * missing parts are then all costs, so the real result can only be lower).
 */
export function mtdResult(rows, expectedDays) {
  if (!rows.length || rows.length < expectedDays) return { profit: null, upper_bound: null };
  const profit = rows.every((r) => r.profit != null) ? r2(rows.reduce((s, r) => s + Number(r.profit), 0)) : null;
  const upper = rows.every((r) => r.revenue != null && r.profit_partial != null) ? r2(rows.reduce((s, r) => s + Number(r.profit_partial), 0)) : null;
  return { profit, upper_bound: upper };
}

export async function runCalendar(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const today = localDay(nowMs, "America/New_York");
  let reminders = 0, triggers = 0;

  // 1. dated obligations
  const obligations = [...staticObligations(nowMs), ...(await coreObligations(db, today))];
  for (const o of obligations) {
    const b = reminderBucket(today, o.due);
    if (b == null) continue;
    if (!(await once(db, `${o.id}:${o.due}:${b}d`, o.due, at))) continue;
    const left = daysBetween(today, o.due);
    await logEvent(db, {
      actor: ACTOR, kind: "calendar.reminder", target: "core.briefer", store: o.store || null,
      summary: `${left === 0 ? "Due today" : `Due in ${left} day${left === 1 ? "" : "s"} (${o.due})`}: ${o.label}${o.note ? `. ${o.note}` : ""}`,
      data: { id: o.id, due: o.due, days_left: left, kind: o.kind, source: o.source, amount: o.amount ?? null }, at,
    });
    reminders++;
  }

  // 2. money triggers
  const limitBal = Number(env.CAL_BALANCE_ABOVE_USD);
  const limitRef = env.CAL_REFUND_RATE_ABOVE != null && env.CAL_REFUND_RATE_ABOVE !== "" ? Number(env.CAL_REFUND_RATE_ABOVE) : DEFAULT_REFUND_RATE_ABOVE;
  const yesterday = minusDays(today, 1);
  const monthFrom = `${yesterday.slice(0, 7)}-01`;
  const expected = daysBetween(monthFrom, yesterday) + 1;
  const mtdAll = [];
  for (const id of LIVE_STORE_IDS) {
    const name = STORES[id].name;
    if (Number.isFinite(limitBal) && limitBal > 0) {
      const b = await db.prepare(`SELECT amount, currency, as_of FROM money_balances WHERE source = 'shopify_payments' AND store = ?`).bind(id).first();
      // A stale balance is not used (rule 4).
      if (b && b.as_of && nowMs - Date.parse(b.as_of) <= BALANCE_MAX_AGE_H * 3600000 && Number(b.amount) > limitBal && await once(db, `trigger:balance:${id}:${today}`, today, at)) {
        await logEvent(db, { actor: ACTOR, kind: "trigger.balance_high", store: id, target: "core.briefer",
          summary: `${name} Shopify balance is $${Number(b.amount).toFixed(2)} (over your $${limitBal.toFixed(2)} trigger, as of ${b.as_of.slice(0, 16).replace("T", " ")} UTC)`,
          data: { amount: b.amount, limit: limitBal, as_of: b.as_of }, at });
        triggers++;
      }
    }
    const week = await rowsBetween(db, id, minusDays(yesterday, 6), yesterday);
    const rate = week.length === 7 ? refundRate(week) : null;
    if (rate != null && rate > limitRef && await once(db, `trigger:refund_rate:${id}:${today}`, today, at)) {
      await logEvent(db, { actor: ACTOR, kind: "trigger.refund_rate_high", store: id, target: "core.briefer",
        summary: `${name} refunds were ${(rate * 100).toFixed(1)}% of revenue over the last 7 days (trigger ${(limitRef * 100).toFixed(1)}%)`,
        data: { rate: r4(rate), limit: limitRef, from: minusDays(yesterday, 6), to: yesterday }, at });
      triggers++;
    }
    const mtdRows = await rowsBetween(db, id, monthFrom, yesterday);
    mtdAll.push(...mtdRows);
    const m = mtdResult(mtdRows, expected);
    const loss = m.profit != null ? m.profit < 0 : m.upper_bound != null && m.upper_bound < 0;
    if (loss && await once(db, `trigger:mtd_loss:${id}:${today}`, today, at)) {
      await logEvent(db, { actor: ACTOR, kind: "trigger.mtd_loss", store: id, target: "core.briefer",
        summary: m.profit != null
          ? `${name} is at a loss month to date: −$${Math.abs(m.profit).toFixed(2)} (${monthFrom} to ${yesterday})`
          : `${name} is at a loss month to date: at most −$${Math.abs(m.upper_bound).toFixed(2)} from the costs known so far; missing costs can only make it worse`,
        data: { ...m, from: monthFrom, to: yesterday }, at });
      triggers++;
    }
  }
  const g = mtdResult(mtdAll, expected * LIVE_STORE_IDS.length);
  const gLoss = g.profit != null ? g.profit < 0 : g.upper_bound != null && g.upper_bound < 0;
  if (gLoss && await once(db, `trigger:mtd_loss:all:${today}`, today, at)) {
    await logEvent(db, { actor: ACTOR, kind: "trigger.mtd_loss", target: "core.briefer",
      summary: `The group is at a loss month to date: ${g.profit != null ? `−$${Math.abs(g.profit).toFixed(2)}` : `at most −$${Math.abs(g.upper_bound).toFixed(2)} (costs still missing)`}`,
      data: { ...g, from: monthFrom, to: yesterday }, at });
    triggers++;
  }
  return { reminders, triggers };
}

export async function calendarState(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const today = localDay(nowMs, "America/New_York");
  const horizon = minusDays(today, -90);
  const items = [...staticObligations(nowMs), ...(await coreObligations(db, today))]
    .filter((o) => o.due >= today && o.due <= horizon).sort((a, b) => (a.due < b.due ? -1 : 1)).slice(0, 30)
    .map((o) => ({ ...o, days_left: daysBetween(today, o.due) }));
  const { results } = await db.prepare(`SELECT * FROM events WHERE actor = ? AND kind LIKE 'trigger.%' ORDER BY id DESC LIMIT 20`).bind(ACTOR).all();
  return {
    upcoming: items, disclaimer: DISCLAIMER,
    triggers: {
      balance_above_usd: Number(env.CAL_BALANCE_ABOVE_USD) > 0 ? Number(env.CAL_BALANCE_ABOVE_USD) : null,
      balance_note: Number(env.CAL_BALANCE_ABOVE_USD) > 0 ? null : "off until Reilly sets CAL_BALANCE_ABOVE_USD",
      refund_rate_above: env.CAL_REFUND_RATE_ABOVE ? Number(env.CAL_REFUND_RATE_ABOVE) : DEFAULT_REFUND_RATE_ABOVE,
      mtd_loss: "profit (or known costs) below $0 month to date",
    },
    recent_triggers: (results || []).map((e) => ({ at: e.at, store: e.store, kind: e.kind, summary: e.summary })),
    not_known: ["Shopify and Google Ads billing cycles: add them to the Core as calendar:* facts (day_of_month) when Reilly's subscription log is in"],
  };
}
