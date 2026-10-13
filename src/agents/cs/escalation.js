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

export function escalationReason(t) {
  const triage = safeJson(t.triage, {});
  const ctx = safeJson(t.context, null);
  if (t.draft_status === "blocked") return t.draft_note || "draft failed the check";
  if (t.draft_status === "escalated") return t.draft_note || "the writer said it needs Reilly";
  const r = routeTicket(t, triage, ctx);
  return r.action === "escalate" ? r.reason : null;
}

function detailLine(t, reason) {
  const ctx = safeJson(t.context, null);
  const retention = safeJson(t.retention, null);
  const bits = [
    t.summary || clip(t.subject, 120),
    `Why it's yours: ${reason}.`,
    ctx ? `Order ${ctx.name}: ${ctx.financial_status || "payment ?"}, ${ctx.shipped ? "shipped" : ctx.shipped === false ? "not shipped" : "shipping unknown"}${ctx.express ? ", express" : ""}${ctx.refunds && ctx.refunds.length ? `, ${ctx.refunds.length} refund event(s) already` : ""}.` : `No order matched (${t.context_note || "?"}).`,
    retention && retention.option ? `Retention idea: ${retention.option}` : null,
    `From ${t.from_name ? `${t.from_name} ` : ""}<${t.from_email}>. Reply in Gmail; nothing has been sent.`,
  ];
  return clip(bits.filter(Boolean).join(" "), 900);
}

export async function escalateTickets(env, { nowMs = Date.now() } = {}) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE escalated_at IS NULL AND context_at IS NOT NULL
       AND (status = 'open' OR draft_status IN ('blocked','escalated')) AND status NOT IN ('superseded','ignored','replied')
     ORDER BY (urgency = 'high') DESC, id LIMIT 30`
  ).all();
  let flagged = 0, joined = 0;
  for (const t of results || []) {
    if (flagged + joined >= CAPS.escalationsPerTick) break;
    // A conversation already with Reilly stays with Reilly: a follow-up joins his flag
    // instead of getting a drafted reply that talks past him.
    const waitingOn = await threadWaitingOnReilly(db, t);
    const reason = escalationReason(t) || (waitingOn ? "conversation already waiting on Reilly" : null);
    if (!reason) continue;
    const at = nowIso(nowMs);
    // Claim it once; a second overlapping run gets 0 changes and moves on.
    const claim = await db.prepare(`UPDATE cs_tickets SET escalated_at = ?, status = 'needs_reilly', updated_at = ? WHERE id = ? AND escalated_at IS NULL`).bind(at, at, t.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const store = t.order_store || t.store;
    // Same conversation already waiting on Reilly → join that flag.
    const open = waitingOn ? { approval_id: waitingOn } : null;
    if (open) {
      joined++;
      await db.prepare(`UPDATE cs_tickets SET approval_id = ? WHERE id = ?`).bind(open.approval_id, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.escalation_joined", store, at, summary: `Customer wrote again in a conversation already waiting on Reilly (flag ${open.approval_id}): ${clip(t.summary || t.subject, 120)}`, data: { ticket: t.id, approvalId: open.approval_id } });
      continue;
    }
    const ctx = safeJson(t.context, null);
    const title = clip(`${storeName(store) || "Unknown store"}: ${String(t.category || "other").replace(/_/g, " ")}${ctx ? ` ${ctx.name}` : t.order_ref ? ` #${t.order_ref}` : ""} — ${t.from_name || t.from_email}${t.urgency === "high" ? " (urgent)" : ""}`, 160);
    const id = await createApproval(db, {
      dept: "cs", requestedBy: ACTOR, store, title,
      options: [{ id: "handled", label: "I'll handle it in Gmail", detail: detailLine(t, reason) }],
    });
    flagged++;
    await db.prepare(`UPDATE cs_tickets SET approval_id = ? WHERE id = ?`).bind(id, t.id).run();
    await logEvent(db, { actor: ACTOR, kind: "cs.escalated", store, target: "core.approvals", at, summary: `Flagged for Reilly: ${title} (${clip(reason, 80)})`, data: { ticket: t.id, approvalId: id } });
  }
  return { flagged, joined };
}
