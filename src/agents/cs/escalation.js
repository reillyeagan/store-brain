/**
 * cs.escalation — Escalation Desk (code; the one-line summary is the AI's from triage).
 * SHADOW: creates ONE approval/flag for Reilly per conversation; nothing is sent to anyone.
 *
 * Escalated (spec: "refunds, reships, replacements, chargebacks, angry/'scam', anything
 * uncovered stay Reilly's"): every ticket routing.routeTicket sends to Reilly, plus tickets whose
 * draft failed the code check or whose writer said it needs Reilly.
 * No duplicates: a ticket is claimed once (escalated_at), and a newer email in a conversation
 * that already has a pending flag joins that flag instead of making a new one.
 * Inputs: cs_tickets (with order context). Outputs: approvals, events.
 */
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { CAPS, storeName } from "./config.js";
import { routeTicket } from "./routing.js";
import { safeJson, clip } from "./util.js";
import { otherLiveDraft } from "./gmailDrafts.js";
import { noActionCheck, earlierUnansweredAsk, SUMMARY_NO_ACTION } from "./noAction.js";

const ACTOR = "cs.escalation";

/** Another email in this conversation is already waiting on Reilly (pending flag)? Returns its approval id. */
export async function threadWaitingOnReilly(db, t) {
  if (!t.thread_id) return null;
  const r = await db.prepare(
    `SELECT c.approval_id FROM cs_tickets c JOIN approvals a ON a.id = c.approval_id
      WHERE c.slot = ? AND c.thread_id = ? AND c.id <> ? AND a.status = 'pending' LIMIT 1`
  ).bind(t.slot, t.thread_id, t.id).first();
  return r ? r.approval_id : null;
}

/**
 * A reply draft already sitting in Gmail from an earlier email in this conversation (the customer
 * wrote again before Reilly sent it). Checked against Gmail (gmailDrafts.js): a draft Reilly sent
 * or deleted is not stale. A second draft is never made; Reilly is told to delete the stale one.
 */
export async function staleGmailDraft(env, t, opts = {}) {
  return otherLiveDraft(env, t, opts);
}

export const STALE_DRAFT_NOTE = "stale reply draft in Gmail from earlier in this conversation — delete it, then reply";

export function escalationReason(t) {
  const triage = safeJson(t.triage, {});
  const ctx = safeJson(t.context, null);
  if (t.draft_status === "blocked") return t.draft_note || "draft failed the check";
  if (t.draft_status === "escalated") return t.draft_note || "the writer said it needs Reilly";
  const r = routeTicket(t, triage, ctx);
  return r.action === "escalate" ? r.reason : null;
}

function detailLine(t, reason, stale) {
  const ctx = safeJson(t.context, null);
  const retention = safeJson(t.retention, null);
  const bits = [
    t.summary || clip(t.subject, 120),
    `Why it's yours: ${reason}.`,
    stale && reason !== STALE_DRAFT_NOTE ? `Also: ${STALE_DRAFT_NOTE}.` : null,
    ctx ? `Order ${ctx.name}: ${ctx.financial_status || "payment ?"}, ${ctx.shipped ? "shipped" : ctx.shipped === false ? "not shipped" : "shipping unknown"}${ctx.express ? ", express" : ""}${ctx.refunds && ctx.refunds.length ? `, ${ctx.refunds.length} refund event(s) already` : ""}.` : `No order matched (${t.context_note || "?"}).`,
    retention && retention.option ? `Retention idea: ${retention.option}` : null,
    `From ${t.from_name ? `${t.from_name} ` : ""}<${t.from_email}>. Reply in Gmail; nothing has been sent.`,
  ];
  return clip(bits.filter(Boolean).join(" "), 900);
}

export async function escalateTickets(env, { nowMs = Date.now(), fetchImpl = fetch, budget = null } = {}) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE escalated_at IS NULL AND context_at IS NOT NULL
       AND (status = 'open' OR draft_status IN ('blocked','escalated')) AND status NOT IN ('superseded','ignored','replied')
     ORDER BY (urgency = 'high') DESC, id LIMIT 30`
  ).all();
  let flagged = 0, joined = 0, quiet = 0;
  // Flags made before the no_action guard existed, for mail the classifier itself called
  // "no action requested": closed now, with the reason recorded.
  const reclosed = await recloseNoActionFlags(db, { nowMs });
  for (const t of results || []) {
    if (flagged + joined >= CAPS.escalationsPerTick) break;
    // Sorted before the guard existed: a bare thank-you is closed quietly here instead of
    // reaching Reilly (same guard as triage; any question, request or problem vetoes it).
    const na = noActionCheck(t);
    if (na.close && !t.draft_status && !(await earlierUnansweredAsk(db, t))) {
      const at = nowIso(nowMs);
      const r = await db.prepare(`UPDATE cs_tickets SET status = 'no_action', classify_note = ?, updated_at = ? WHERE id = ? AND escalated_at IS NULL AND status = 'open'`)
        .bind(clip(`no_action: ${na.reason}`, 300), at, t.id).run();
      if (r.meta && r.meta.changes === 1) {
        quiet++;
        await logEvent(db, { actor: ACTOR, kind: "cs.no_action", store: t.order_store || t.store, at, summary: `Ticket ${t.id} closed quietly, nothing to do (${clip(t.summary || t.subject, 100)}). Not sent to Reilly.`, data: { ticket: t.id, no_action: na.reason } });
      }
      continue;
    }
    // A conversation already with Reilly stays with Reilly: a follow-up joins his flag
    // instead of getting a drafted reply that talks past him.
    const waitingOn = await threadWaitingOnReilly(db, t);
    const stale = await staleGmailDraft(env, t, { fetchImpl, nowMs, budget });
    const reason = escalationReason(t) || (waitingOn ? "conversation already waiting on Reilly" : null) || (stale ? STALE_DRAFT_NOTE : null);
    if (!reason) continue;
    const at = nowIso(nowMs);
    // Claim → create → release on failure: a ticket is never left marked "escalated" without
    // its flag (a second overlapping run gets 0 changes and moves on).
    const claim = await db.prepare(`UPDATE cs_tickets SET escalated_at = ?, updated_at = ? WHERE id = ? AND escalated_at IS NULL`).bind(at, at, t.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const store = t.order_store || t.store;
    try {
      if (waitingOn) {
        // Same conversation already waiting on Reilly → join that flag.
        await db.prepare(`UPDATE cs_tickets SET approval_id = ?, status = 'needs_reilly' WHERE id = ?`).bind(waitingOn, t.id).run();
        joined++;
        await logEvent(db, { actor: ACTOR, kind: "cs.escalation_joined", store, at, summary: `Customer wrote again in a conversation already waiting on Reilly (flag ${waitingOn})${stale ? "; a stale Gmail draft should be deleted" : ""}`, data: { ticket: t.id, approvalId: waitingOn } });
        continue;
      }
      const ctx = safeJson(t.context, null);
      // No customer name or email in the title: approval titles are copied into the event log.
      const title = clip(`${storeName(store) || "Unknown store"}: ${String(t.category || "other").replace(/_/g, " ")}${ctx ? ` ${ctx.name}` : t.order_ref ? ` (customer wrote #${t.order_ref})` : ""}${t.urgency === "high" ? " (urgent)" : ""} — ticket ${t.id}`, 160);
      const id = await createApproval(db, {
        dept: "cs", requestedBy: ACTOR, store, title,
        options: [{ id: "handled", label: "I'll handle it in Gmail", detail: detailLine(t, reason, stale) }],
      });
      await db.prepare(`UPDATE cs_tickets SET approval_id = ?, status = 'needs_reilly' WHERE id = ?`).bind(id, t.id).run();
      flagged++;
      await logEvent(db, { actor: ACTOR, kind: "cs.escalated", store, target: "core.approvals", at, summary: `Flagged for Reilly: ${title} (${clip(reason, 80)})`, data: { ticket: t.id, approvalId: id } });
    } catch (err) {
      // Give the claim back so the next run tries again.
      await db.prepare(`UPDATE cs_tickets SET escalated_at = NULL WHERE id = ? AND escalated_at = ? AND approval_id IS NULL`).bind(t.id, at).run();
      throw err;
    }
  }
  return { flagged, joined, no_action: quiet, reclosed };
}

/**
 * ONE-OFF clean-up of the flags made before the no_action guard existed (live 2026-10-14).
 * Only flags created before RECLOSE_CUTOFF, and only once (agent_cursors RECLOSE_DONE): every
 * later thank-you is handled by the guard before it is ever flagged, so this never becomes a
 * standing way to take things off Reilly's list.
 */
export const RECLOSE_CUTOFF = "2026-10-14T16:00:00Z";
export const RECLOSE_DONE = "cs.no_action_reclose";

/**
 * Re-close those flags when every email on them, and every email in their conversations,
 * passes the full code check (allowlisted thank-you; no question, request, problem, anger or
 * money word), the classifier itself called it "no action requested / raised", no earlier
 * unanswered email in the thread was replaced by it, and no draft was attempted. The approval
 * is closed as expired; the brain's reason goes in `result` and the event, never in `note`
 * (that column is Reilly's words). Nothing is sent to anyone.
 */
export async function recloseNoActionFlags(db, { nowMs = Date.now() } = {}) {
  // Claim the one-off first, so two overlapping runs can't both do it.
  const claim = await db.prepare(`INSERT INTO agent_cursors (name, value, updated_at) VALUES (?, -1, ?) ON CONFLICT(name) DO NOTHING`)
    .bind(RECLOSE_DONE, nowIso(nowMs)).run();
  if (!claim.meta || claim.meta.changes !== 1) return 0;
  let n = 0;
  try {
    n = await recloseOnce(db, nowMs);
  } catch (err) {
    // Give the claim back so the next run tries again.
    await db.prepare(`DELETE FROM agent_cursors WHERE name = ? AND value = -1`).bind(RECLOSE_DONE).run();
    throw err;
  }
  await db.prepare(`UPDATE agent_cursors SET value = ?, updated_at = ? WHERE name = ?`).bind(n, nowIso(nowMs), RECLOSE_DONE).run();
  return n;
}

async function recloseOnce(db, nowMs) {
  const { results: flags } = await db.prepare(
    `SELECT id, store, title FROM approvals WHERE status = 'pending' AND requested_by = ? AND created_at < ? ORDER BY id LIMIT 200`
  ).bind(ACTOR, RECLOSE_CUTOFF).all();
  let n = 0;
  for (const a of flags || []) {
    const { results: ts } = await db.prepare(`SELECT * FROM cs_tickets WHERE approval_id = ? ORDER BY id`).bind(a.id).all();
    if (!ts || !ts.length) continue;
    let ok = true;
    for (const t of ts) {
      const saidSo = SUMMARY_NO_ACTION.test(String(t.summary || "")) || (safeJson(t.triage, {}) || {}).no_action === true;
      if (!saidSo || t.draft_status || !noActionCheck(t).close || (await earlierUnansweredAsk(db, t))) { ok = false; break; }
      // Every other email in the conversation must be answered, ignored, or itself nothing-to-do.
      if (t.thread_id) {
        const { results: thread } = await db.prepare(`SELECT * FROM cs_tickets WHERE slot = ? AND thread_id = ? AND id <> ?`).bind(t.slot, t.thread_id, t.id).all();
        if ((thread || []).some((o) => !["replied", "ignored", "no_action"].includes(o.status) && !o.replied_at && !noActionCheck(o).close)) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const checks = ts.map((t) => ({ t }));
    const at = nowIso(nowMs);
    const why = `the classifier described it as "${clip(checks[0].t.summary || "", 140)}"; code check: only a thank-you, no question, request, problem, anger or refund word, nothing else open in the conversation`;
    const r = await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`)
      .bind(at, JSON.stringify({ closed_by: ACTOR, not_reilly: true, outcome: "no_action", reason: clip(why, 400) }), a.id).run();
    if (!r.meta || r.meta.changes !== 1) continue;
    for (const x of checks) {
      await db.prepare(`UPDATE cs_tickets SET status = 'no_action', classify_note = ?, updated_at = ? WHERE id = ?`)
        .bind(clip(`no_action (re-closed flag ${a.id}): ${why}`, 300), at, x.t.id).run();
    }
    n++;
    await logEvent(db, {
      actor: ACTOR, kind: "cs.no_action_reclosed", store: a.store, target: "core.approvals", at,
      summary: `No longer waiting on Reilly: ${clip(a.title, 120)}. Re-closed as no action needed (${clip(checks[0].t.summary || "", 100)})`,
      data: { approvalId: a.id, tickets: ts.map((t) => t.id), reason: why },
    });
  }
  return n;
}
