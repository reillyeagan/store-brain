/**
 * cs.obligations — Obligations Tracker (code). SHADOW: reads Gmail threads; writes only to D1.
 *
 * What it does, honestly limited to what code can see:
 *   1. Re-reads the Gmail thread of recent tickets (capped per run) to see whether Reilly has
 *      replied (a SENT message after the customer's). If he has, the ticket is marked replied.
 *   2. If his sent reply makes a dated promise in a recognisable form ("we'll update you by
 *      Friday", "I'll get back to you within 2 business days", "tomorrow"), it is recorded in the
 *      shared `obligations` table (kind "reply") with the due date computed by code.
 *      Promises in unsent drafts are NOT recorded: a draft is not a promise until Reilly sends it
 *      (rule 3: the system of record is the sent mail).
 *   3. A later sent reply in the same thread closes the promise (done). Open promises past their
 *      due date are flagged once each (event + listed on the CS page).
 *   4. Refund / replacement / exchange promises in the same sent replies are opened too (see
 *      promises.js): those close only when Shopify (or KFB) shows the thing happened.
 * Inputs: Gmail threads (read), cs_tickets, obligations. Outputs: obligations rows, flags, events.
 */
import { getGoogleAccessToken } from "../../lib/google.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso, localDay, endOfLocalDayMs } from "../../lib/time.js";
import { CAPS, storeName } from "./config.js";
import { getThread, bodyText, stripQuoted, headerMap } from "./gmail.js";
import { clip, logOnce } from "./util.js";
import { findGoodsPromises, recordGoodsPromise } from "./promises.js";

const ACTOR = "cs.obligations";
const TZ = "America/New_York";
const RECHECK_HOURS = 2; // a thread is re-read at most every 2 hours (cost-bounded; replies are not urgent)
// A conversation on Reilly's to-do list is re-read much sooner, so it drops off soon after he
// answers (Reilly 2026-10-16: "the brain should know when i reply to emails").
const RECHECK_FLAGGED_MIN = 20;
const ESCALATION_ACTOR = "cs.escalation";
// "Still on Reilly's list": unanswered, and its flag is still pending (a flag he already ticked
// off must not keep taking the front of the queue).
const ON_LIST = `(t.status = 'needs_reilly' AND t.replied_at IS NULL AND EXISTS (SELECT 1 FROM approvals a WHERE a.id = t.approval_id AND a.status = 'pending'))`;

/** A SENT message counts as a reply only if it went to the customer (not a forward to a supplier). */
export function sentToCustomer(m, customerEmail) {
  const email = String(customerEmail || "").toLowerCase().trim();
  if (!email) return false;
  const h = headerMap(m);
  return `${h.to || ""}, ${h.cc || ""}`.toLowerCase().includes(email);
}
const WATCH_DAYS = 10;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PROMISE_VERB = /\b(we|i)\s*('ll|’ll| will| shall)\s+(be\s+)?(update|get back|let you know|follow up|send|confirm|reply|email|check|contact|reach out|be in touch|have)/i;

const dayAdd = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

function addBusinessDays(day, n) {
  let d = day, left = n;
  while (left > 0) { d = dayAdd(d, 1); if (![0, 6].includes(weekday(d))) left--; }
  return d;
}

/**
 * Dated promises in a sent reply. Returns [{ said, due_day }] (due = end of that Eastern day).
 * Only sentences with a promise verb count; vague promises ("soon") are not guessed.
 */
export function findPromises(text, sentMs) {
  const today = localDay(sentMs, TZ);
  const out = [];
  const sentences = String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (!PROMISE_VERB.test(s)) continue;
    const low = s.toLowerCase();
    let due = null, m;
    if (/\btomorrow\b/.test(low)) due = dayAdd(today, 1);
    else if (/\b(today|by end of (the )?day|by eod)\b/.test(low)) due = today;
    else if ((m = low.match(/\b(?:within|in)\s+(\d{1,2}|one|two|three|four|five)\s+(business\s+|working\s+)?days?\b/))) {
      const n = { one: 1, two: 2, three: 3, four: 4, five: 5 }[m[1]] || Number(m[1]);
      due = m[2] ? addBusinessDays(today, n) : dayAdd(today, n);
    } else if ((m = low.match(/\b(?:within|in)\s+(24|48|72)\s+hours?\b/))) due = dayAdd(today, Number(m[1]) / 24);
    else if (/\b(by )?(the )?end of (the |this )?week\b/.test(low)) { let d = today; while (weekday(d) !== 5) d = dayAdd(d, 1); due = d; }
    else if ((m = low.match(/\b(?:by|on|before)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
      const target = DAYS.indexOf(m[1]);
      let d = dayAdd(today, 1);
      while (weekday(d) !== target) d = dayAdd(d, 1);
      due = d;
    } else if ((m = low.match(/\b(?:by|on|before)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(st|nd|rd|th)?\b/))) {
      const mon = MONTHS.indexOf(m[1]) + 1;
      let y = Number(today.slice(0, 4));
      let d = `${y}-${String(mon).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
      if (d < today) d = `${y + 1}${d.slice(4)}`;
      if (!Number.isNaN(Date.parse(`${d}T00:00:00Z`))) due = d;
    }
    if (due) out.push({ said: clip(s.trim(), 300), due_day: due });
  }
  return out;
}

const noteFor = (ticketId, said, sentIso) => `cs ticket ${ticketId}: "${said}" (sent ${sentIso})`;
const sentFromNote = (note) => { const m = String(note || "").match(/\(sent ([0-9T:.\-Z]+)\)$/); return m ? m[1] : null; };

export async function checkThreads(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const since = nowIso(nowMs - WATCH_DAYS * 86400000);
  const recheck = nowIso(nowMs - RECHECK_HOURS * 3600000);
  const recheckFlagged = nowIso(nowMs - RECHECK_FLAGGED_MIN * 60000);
  // Unanswered emails still on Reilly's list come first and have no age limit: a 4-day-old
  // refund request he answered must still drop off.
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets t WHERE t.thread_id IS NOT NULL AND t.status IN ('open','drafted','needs_reilly','replied')
       AND (t.thread_checked_at IS NULL OR t.thread_checked_at < CASE WHEN ${ON_LIST} THEN ? ELSE ? END)
       AND ((t.replied_at IS NULL AND (t.received_at >= ? OR ${ON_LIST}))
            OR EXISTS (SELECT 1 FROM obligations o WHERE o.status = 'open' AND o.kind = 'reply' AND o.note LIKE 'cs ticket ' || t.id || ':%'))
     ORDER BY (${ON_LIST}) DESC, t.thread_checked_at IS NOT NULL, t.thread_checked_at, t.id LIMIT ?`
  ).bind(recheckFlagged, recheck, since, CAPS.threadChecksPerTick).all();
  let checked = 0, replied = 0, promises = 0, closed = 0, goods = 0;
  const tokens = new Map();
  for (const t of results || []) {
    const at = nowIso(nowMs);
    let token = tokens.get(t.slot);
    if (!token) {
      if (!budget.take(1)) break;
      try { token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: t.slot }); tokens.set(t.slot, token); }
      catch (err) {
        await logOnce(db, { actor: ACTOR, kind: "cs.thread_check_skipped", target: "sys.gmail", summary: `Can't re-read customer threads in ${t.slot}: ${clip(err.message, 120)}` }, { key: t.slot, windowMin: 24 * 60, nowMs });
        continue;
      }
    }
    if (!budget.take(1)) break;
    let thread;
    try { thread = await getThread(token, t.thread_id, { fetchImpl }); }
    catch (err) {
      // A failed read says nothing about the thread (rule 6): try again later.
      await db.prepare(`UPDATE cs_tickets SET thread_checked_at = ? WHERE id = ?`).bind(at, t.id).run();
      continue;
    }
    checked++;
    const customerMs = Date.parse(t.received_at || t.opened_at);
    const sent = (thread.messages || [])
      .filter((m) => (m.labelIds || []).includes("SENT") && Number(m.internalDate) > customerMs)
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const toCustomer = sent.filter((m) => sentToCustomer(m, t.from_email));
    if (toCustomer.length && !t.replied_at) {
      const firstMs = Number(toCustomer[0].internalDate);
      replied++;
      await db.prepare(`UPDATE cs_tickets SET replied_at = ?, status = CASE WHEN status IN ('open','drafted') THEN 'replied' ELSE status END, updated_at = ? WHERE id = ?`)
        .bind(new Date(firstMs).toISOString(), at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.reilly_replied", store: t.store, target: "sys.gmail", at, summary: `Reilly replied to ${storeName(t.store) || "a customer"} (${clip(t.subject, 60)})`, data: { ticket: t.id } });
    }
    // Promises in every sent reply (recorded once), and closures by a later sent reply.
    for (const m of sent) {
      const sentMs = Number(m.internalDate);
      const text = stripQuoted(bodyText(m));
      for (const p of findPromises(text, sentMs)) {
        const note = noteFor(t.id, p.said, new Date(sentMs).toISOString());
        const dup = await db.prepare(`SELECT id FROM obligations WHERE note = ?`).bind(note).first();
        if (dup) continue;
        const dueIso = new Date(endOfLocalDayMs(p.due_day, TZ) - 1000).toISOString();
        await db.prepare(`INSERT INTO obligations (created_at, store, kind, party, order_ref, due_at, status, note) VALUES (?, ?, 'reply', ?, ?, ?, 'open', ?)`)
          .bind(at, t.order_store || t.store, t.from_email, t.order_name || (t.order_ref ? `#${t.order_ref}` : null), dueIso, note).run();
        promises++;
        await logEvent(db, { actor: ACTOR, kind: "cs.obligation_recorded", store: t.store, at, summary: `Promise in a sent reply recorded (ticket ${t.id}${t.order_name ? `, ${t.order_name}` : ""}), due ${p.due_day}`, data: { ticket: t.id } });
      }
      // Money and goods promises (refund / replacement / exchange): closed only by Shopify or
      // KFB, never by another email (promises.js).
      for (const g of findGoodsPromises(text)) {
        if (await recordGoodsPromise(db, t, g, sentMs, nowMs)) goods++;
      }
    }
    // Only dated REPLY promises are kept by a later reply; a refund is kept only by a refund.
    const { results: open } = await db.prepare(`SELECT id, note FROM obligations WHERE status = 'open' AND kind = 'reply' AND note LIKE ?`).bind(`cs ticket ${t.id}:%`).all();
    for (const o of open || []) {
      const promisedAt = Date.parse(sentFromNote(o.note) || "");
      const later = sent.find((m) => Number(m.internalDate) > promisedAt);
      if (Number.isFinite(promisedAt) && later) {
        closed++;
        await db.prepare(`UPDATE obligations SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`).bind(new Date(Number(later.internalDate)).toISOString(), o.id).run();
        await logEvent(db, { actor: ACTOR, kind: "cs.obligation_kept", store: t.store, at, summary: `Promise kept: Reilly followed up (ticket ${t.id})`, data: { obligation: o.id } });
      }
    }
    await db.prepare(`UPDATE cs_tickets SET thread_checked_at = ? WHERE id = ?`).bind(at, t.id).run();
  }
  const answered = await closeAnsweredFlags(db, nowMs);
  return { checked, replied, promises, goods, closed, answered };
}

/**
 * Take an email flag off Reilly's list once he has replied in Gmail to every email on it
 * (Reilly 2026-10-16: "I have replied to their email but havent heard anything back, so that
 * should be gone until i hear back from them"). Proof is his SENT message in the thread
 * (replied_at, set above from Gmail itself, rule 3), never a draft.
 * When the customer writes again, that email is a new ticket with no reply yet, so it comes
 * back onto the list through the normal flow (a new flag, or a drafted reply).
 * The flag is closed as 'expired' with not_reilly: closing it is bookkeeping, not a decision.
 */
export async function closeAnsweredFlags(db, nowMs = Date.now()) {
  const { results: flags } = await db.prepare(
    `SELECT a.id, a.store, a.title FROM approvals a
      WHERE a.status = 'pending' AND a.requested_by = ?
        AND EXISTS (SELECT 1 FROM cs_tickets c WHERE c.approval_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM cs_tickets c WHERE c.approval_id = a.id AND (c.replied_at IS NULL OR c.replied_at < COALESCE(c.received_at, c.opened_at)))
        -- and nothing newer from the customer in the same conversation is still unanswered
        -- (an email the escalation step hasn't joined to this flag yet still counts).
        AND NOT EXISTS (SELECT 1 FROM cs_tickets c JOIN cs_tickets o ON o.slot = c.slot AND o.thread_id = c.thread_id AND o.id <> c.id
                         WHERE c.approval_id = a.id AND o.replied_at IS NULL AND o.status NOT IN ('no_action','ignored','superseded')
                           AND COALESCE(o.received_at, o.opened_at) > COALESCE(c.received_at, c.opened_at))
      ORDER BY a.id LIMIT 50`
  ).bind(ESCALATION_ACTOR).all();
  let n = 0;
  for (const a of flags || []) {
    const at = nowIso(nowMs);
    const r = await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`)
      .bind(at, JSON.stringify({ closed_by: ACTOR, not_reilly: true, outcome: "replied_in_gmail", reason: "Reilly replied in Gmail; back on the list if the customer writes again" }), a.id).run();
    if (!r.meta || r.meta.changes !== 1) continue;
    await db.prepare(`UPDATE cs_tickets SET status = 'replied', updated_at = ? WHERE approval_id = ? AND status = 'needs_reilly'`).bind(at, a.id).run();
    n++;
    await logEvent(db, { actor: ACTOR, kind: "cs.flag_answered", store: a.store, target: "core.approvals", at, summary: `Off your list: ${clip(a.title, 120)} (you replied in Gmail; it comes back if they write again)`, data: { approvalId: a.id } });
  }
  return n;
}

/** Flag each CS promise that is past due, once. */
export async function flagOverdue(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const { results } = await db.prepare(
    `SELECT o.* FROM obligations o LEFT JOIN cs_overdue_flags f ON f.obligation_id = o.id
      WHERE o.status = 'open' AND o.kind = 'reply' AND o.note LIKE 'cs ticket %' AND o.due_at < ? AND f.obligation_id IS NULL
      ORDER BY o.due_at LIMIT 20`
  ).bind(at).all();
  for (const o of results || []) {
    const ins = await db.prepare(`INSERT OR IGNORE INTO cs_overdue_flags (obligation_id, flagged_at) VALUES (?, ?)`).bind(o.id, at).run();
    if (!ins.meta || ins.meta.changes !== 1) continue;
    await logEvent(db, { actor: ACTOR, kind: "cs.obligation_overdue", store: o.store, at, summary: `Overdue promise to a customer${o.order_ref ? ` (${o.order_ref})` : ""}, due ${o.due_at.slice(0, 10)}: see the CS page (${clip((o.note.match(/^cs ticket \d+/) || ["cs"])[0], 30)})`, data: { obligation: o.id } });
  }
  return { overdue: (results || []).length };
}

