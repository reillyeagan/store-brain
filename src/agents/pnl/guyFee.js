/**
 * Guy's fee: end-date questions and the monthly fee check (pnl.calendar). Plain code, shadow:
 * writes only approvals (questions), calendar_reminders (once-keys) and events.
 *
 * 1. askGuyEndDates — for each GUY_END_QUESTIONS entry whose store still has no guyEnd, ONE
 *    Waiting-on-you question, asked once (never again once it exists, whatever the answer).
 *    Reilly's reply note is stored verbatim on the approval; nothing parses it. The end date is
 *    set in stores.js from his words (rule 10: only Reilly's words make a decision).
 * 2. monthlyGuyCheck — once a month per store, for the month just closed: Guy's fee as the
 *    ledger booked it (sum of pnl_days.guy_fee), the plain 10% x ad spend for the same days,
 *    and the SERVICES total from Reilly's P&L sheet when it is in the Core (fact
 *    "sheet:services:<YYYY-MM>", USD). The brain can't read the sheets yet (Sheets Writer is
 *    planned), so without that fact the sheet side is logged as NOT WIRED, never as $0.
 *    Logged as one `pnl.guy_fee_check` event per store per month (target core.briefer), from
 *    the 2nd of the month, the month claimed only after every read succeeded. A day with no ads
 *    number makes the ledger fee null ("incomplete", with the partial sum as "at least"); an
 *    empty sheet cell is null, never $0.
 */
import { LIVE_STORE_IDS, STORES, GUY_END_QUESTIONS } from "../../config/stores.js";
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { localDay, nowIso } from "../../lib/time.js";
import { minusDays } from "../../lib/adsSpend.js";
import { r2 } from "../core/shared.js";

const ACTOR = "pnl.calendar";
/** Sheet and ledger may differ by rounding per day; more than this is worth a look. */
export const GUY_CHECK_TOLERANCE_USD = 1;

export async function askGuyEndDates(db, { nowMs = Date.now(), questions = GUY_END_QUESTIONS } = {}) {
  let asked = 0;
  for (const q of questions) {
    const s = STORES[q.store];
    if (!s || s.guyEnd) continue; // already answered in config
    const had = await db.prepare(`SELECT id FROM approvals WHERE requested_by = ? AND title = ? LIMIT 1`).bind(ACTOR, q.title).first();
    if (had) continue;
    const id = await createApproval(db, {
      dept: "pnl", requestedBy: ACTOR, store: q.store, title: q.title,
      options: [{ id: "reply", label: "Answer in the note", detail: `Write the last day Guy should be charged for ${s.name} (or "still running"). Your words are kept word for word; the end date is set from them, never guessed. Source of the question: ${q.source}.` }],
    });
    await logEvent(db, { actor: ACTOR, kind: "pnl.guy_end_asked", store: q.store, target: "core.approvals", at: nowIso(nowMs),
      summary: `Asked Reilly to confirm ${s.name}'s media-buyer end date (the fee stays on until he answers)`, data: { approvalId: id, source: q.source } });
    asked++;
  }
  return asked;
}

/** The calendar month before the one containing `day` → {month:"YYYY-MM", from, to}. */
export function previousMonth(day) {
  const first = `${day.slice(0, 7)}-01`;
  const to = minusDays(first, 1);
  return { month: to.slice(0, 7), from: `${to.slice(0, 7)}-01`, to };
}

/** Pure: compare the ledger's fee, the plain rate x spend and the sheet's SERVICES total. */
export function compareGuyFee({ ledgerFee, expectedFee, sheet, daysMissing }) {
  const notes = [];
  if (daysMissing) notes.push(`${daysMissing} day(s) of the month have no ads number in the ledger, so the fee is incomplete`);
  if (ledgerFee != null && expectedFee != null && Math.abs(ledgerFee - expectedFee) > GUY_CHECK_TOLERANCE_USD) {
    notes.push(`ledger fee differs from 10% x spend by $${Math.abs(ledgerFee - expectedFee).toFixed(2)} (start/end dates?)`);
  }
  let status = "ok";
  if (sheet == null) status = "sheet not wired";
  else if (ledgerFee == null) status = "ledger incomplete";
  else if (Math.abs(sheet - ledgerFee) > GUY_CHECK_TOLERANCE_USD) status = "mismatch";
  return { status, diff: sheet == null || ledgerFee == null ? null : r2(sheet - ledgerFee), notes };
}

async function onceKey(db, key, due, at) {
  const r = await db.prepare(`INSERT INTO calendar_reminders (key, due_day, sent_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`).bind(key, due, at).run();
  return !!(r.meta && r.meta.changes);
}

/** The check waits until this day of the month, so the last day of the month has closed. */
export const GUY_CHECK_FROM_DAY = 2;

/** Pure: a sheet fact's value as a number, or null (an empty or non-numeric cell is not $0). */
export function sheetAmount(value) {
  if (value == null) return null;
  const t = String(value).replace(/[^0-9.\-]/g, "");
  if (!t || !/\d/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export async function monthlyGuyCheck(db, { nowMs = Date.now() } = {}) {
  const today = localDay(nowMs, "America/New_York");
  if (Number(today.slice(8, 10)) < GUY_CHECK_FROM_DAY) return [];
  const { month, from, to } = previousMonth(today);
  const at = nowIso(nowMs);
  const out = [];
  for (const id of LIVE_STORE_IDS) {
    const s = STORES[id];
    if (!s.guyFeeRate || !s.guyStart || s.guyStart > to) continue; // no fee that month
    const key = `guy_check:${id}:${month}`;
    const done = await db.prepare(`SELECT key FROM calendar_reminders WHERE key = ?`).bind(key).first();
    if (done) continue;
    const r = await db.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ads IS NULL THEN 1 ELSE 0 END) AS no_ads, SUM(guy_fee) AS fee,
              SUM(CASE WHEN day >= ? AND (? IS NULL OR day <= ?) THEN ads ELSE 0 END) AS ads_in_term
         FROM pnl_days WHERE store = ? AND day >= ? AND day <= ?`
    ).bind(s.guyStart, s.guyEnd || null, s.guyEnd || null, id, from, to).first();
    // Days of the month the ledger should have: every calendar day (rows before Guy's start
    // still exist, with fee 0). A day with no row, or no ads number, leaves the fee incomplete.
    const days = Number(to.slice(8, 10));
    const daysMissing = Math.max(0, days - Number((r && r.n) || 0)) + Number((r && r.no_ads) || 0);
    // Any day without an ads number (or without a row) makes the ledger's fee incomplete:
    // reported as null with a note, never as the partial sum (rule 5).
    const ledgerFee = r && r.n && !daysMissing ? r2(Number(r.fee || 0)) : null;
    const ledgerPartial = r && r.n && daysMissing ? r2(Number(r.fee || 0)) : null;
    const expectedFee = r && r.n ? r2(Number(r.ads_in_term || 0) * s.guyFeeRate) : null;
    const f = await db.prepare(`SELECT value FROM core_facts WHERE live = 1 AND store = ? AND key = ? ORDER BY id DESC LIMIT 1`)
      .bind(id, `sheet:services:${month}`).first().catch(() => null);
    const sheet = f ? sheetAmount(f.value) : null;
    const c = compareGuyFee({ ledgerFee, expectedFee: daysMissing ? null : expectedFee, sheet, daysMissing });
    const money = (n) => (n == null ? "unknown" : `$${Number(n).toFixed(2)}`);
    // Claimed only now, after every read succeeded: a failed read is retried tomorrow.
    if (!(await onceKey(db, key, to, at))) continue;
    await logEvent(db, {
      actor: ACTOR, kind: "pnl.guy_fee_check", store: id, target: "core.briefer", at,
      summary: `${s.name} Guy fee check for ${month}: ledger ${ledgerFee == null && ledgerPartial != null ? `incomplete (at least ${money(ledgerPartial)})` : money(ledgerFee)} (${(s.guyFeeRate * 100).toFixed(0)}% x spend = ${money(daysMissing ? null : expectedFee)}), sheet SERVICES ${sheet == null ? "not wired (the brain can't read the P&L sheets yet)" : money(sheet)}` +
        `${c.status === "mismatch" ? `: MISMATCH by ${money(Math.abs(c.diff))}` : ""}${c.notes.length ? `. ${c.notes.join("; ")}` : ""}`,
      data: { month, ledger_fee: ledgerFee, ledger_fee_partial: ledgerPartial, expected_fee: daysMissing ? null : expectedFee, sheet_services: sheet, status: c.status, diff: c.diff, days_missing: daysMissing, end: s.guyEnd || null },
    });
    out.push({ store: id, month, ...c });
  }
  return out;
}
