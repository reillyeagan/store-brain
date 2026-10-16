/**
 * cs.reply_writer, second job — STARTER drafts for the emails flagged to Reilly.
 *
 * Why (Reilly 2026-10-15, looking at Waiting on you): "i thought the brain was supposed to draft
 * replies for me, not just tell me". Flagged emails (refunds, returns, complaints, anything the
 * playbook doesn't cover) are still Reilly's DECISION, but he shouldn't have to write the reply
 * from nothing. So each one gets a starting reply in Gmail that decides nothing: it acknowledges
 * the email, uses only the order facts code attached, asks for whatever is missing (order number,
 * photos) and says the team is looking into it. Reilly adds the decision and sends it himself.
 *
 * Same safety as every draft: Gmail DRAFT only (never sent), only with CS_DRAFTS_LIVE=1, the
 * inbox account is checked first, one draft per conversation, read back after creating, and the
 * text must pass the same independent code check (routing.checkDraft: no money, no promises, no
 * dates, no numbers or links code didn't supply). A draft that fails is simply not made; the
 * flag stays as it was.
 *
 * State lives in draft_status (no schema change):
 *   'starter'          = written and stored, Gmail copy not made yet (retried next run)
 *   'gmail_draft'      = in Gmail (set by pushGmailDraft)
 *   'starter_skipped'  = no starter: needs no reply, failed the check, or the flag was closed.
 */
import { askJson } from "../../lib/ai.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { CAPS, DELIVERY_FACTS, storeName } from "./config.js";
import { checkDraft } from "./routing.js";
import { emailAsksAboutSize } from "./sizeUpGate.js";
import { draftsLive, pushGmailDraft, corePolicy, userPrompt, signOff } from "./replyWriter.js";
import { escalationReason } from "./escalation.js";
import { otherLiveDraft } from "./gmailDrafts.js";
import { getThread } from "./gmail.js";
import { getGoogleAccessToken } from "../../lib/google.js";
import { safeJson, clip } from "./util.js";

const ACTOR = "cs.reply_writer";
const PER_RUN = 2;
/** Starters blocked before the one-rewrite retry existed (2026-10-16) get one more go. */
export const RETRY_BLOCKED_BEFORE = "2026-10-16T17:00:00.000Z"; // AI starters per run (the run's call allowance is shared with the rest of CS)

export const OLD_CARD_TAIL = "Reply in Gmail; nothing has been sent.";
export const NEW_CARD_TAIL = "A starting reply is in your Gmail drafts: add your decision, then send. Nothing has been sent.";

export function starterSystem(store, policy, why) {
  return `You write customer-service email replies for ${store}, a small online clothing store. This email was flagged to the owner, Reilly, because: ${why}. He makes that decision himself. Write a STARTING reply he will edit and send.
The reply must:
- thank them and show you understood exactly what they asked or reported;
- use only the order facts given; if no order was found, ask for the order number;
- if an item arrived wrong, damaged or faulty, ask for a photo of it;
- say the team is looking into it and will follow up shortly (no date, no time frame);
- decide nothing and promise nothing;
- say a parcel is delivered or not delivered ONLY from carrier_says_delivered (when unknown, say neither);
- write as the store ("we"); never mention Reilly or any person by name.
Voice: warm, short, plain English, no corporate filler. 3-6 sentences. Greet the customer by first name if known. Sign off with just the store name on its own line, exactly: "${store}" (Reilly 2026-10-15: not "Customer Care").
Hard rules:
- Never invent order numbers, tracking numbers, dates, measurements or policies.
- Never write any date, weekday or month name, and never the words refund, money, credit, discount, code, free, replace, reship, resend, return label. The only numbers you may write are the order number, tracking numbers and links given, and delivery-time ranges in business days.
- Delivery timing you may use: ${DELIVERY_FACTS.join(" ")}
- If the reason says the order number belongs to a different email, do not say anything about that order: ask which email address they used to place it.
- Never mention that a bigger or different factory size may be sent.
- If the email asks nothing and needs no reply (only thanks or an acknowledgement), return {"no_reply":true}.
${policy ? `Store policy (from the playbook):\n${policy}` : ""}
Return {"body":"the full reply text","no_reply":false}`;
}

/** Swap the card's last line once a starter is in Gmail, so the card says where it is. */
async function markCard(db, approvalId) {
  if (!approvalId) return;
  const a = await db.prepare(`SELECT options, status FROM approvals WHERE id = ?`).bind(approvalId).first();
  if (!a || a.status !== "pending") return;
  const opts = safeJson(a.options, []);
  let changed = false;
  for (const o of opts) if (o && typeof o.detail === "string" && o.detail.includes(OLD_CARD_TAIL)) { o.detail = o.detail.replace(OLD_CARD_TAIL, NEW_CARD_TAIL); changed = true; }
  if (changed) await db.prepare(`UPDATE approvals SET options = ? WHERE id = ? AND status = 'pending'`).bind(JSON.stringify(opts), approvalId).run();
}

export async function writeStarterDrafts(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  if (!draftsLive(env)) return { skipped: "Gmail drafts are off (CS_DRAFTS_LIVE)" };
  const out = { written: 0, gmail: 0, no_reply: 0, failed: 0 };
  // Only tickets still waiting on Reilly, with their flag still open, never replied to, and with
  // no Gmail draft yet. Newest first: today's emails matter most.
  const { results } = await db.prepare(
    `SELECT c.* FROM cs_tickets c JOIN approvals a ON a.id = c.approval_id
      WHERE c.status = 'needs_reilly' AND a.status = 'pending' AND c.replied_at IS NULL
        AND c.gmail_draft_id IS NULL AND c.gmail_push IS NULL
        AND (c.draft_status IS NULL OR c.draft_status IN ('blocked','escalated','starter')
             ${nowMs >= Date.parse(RETRY_BLOCKED_BEFORE) ? `OR (c.draft_status = 'starter_skipped' AND c.draft_note LIKE '%Starting reply not used:%' AND c.updated_at < '${RETRY_BLOCKED_BEFORE}')` : ""})
      ORDER BY c.id DESC LIMIT 10`
  ).all();
  let asked = 0;
  const skip = (t, note, at) => db.prepare(`UPDATE cs_tickets SET draft_status = 'starter_skipped', draft_note = ?, updated_at = ? WHERE id = ?`)
    // The earlier note (why the normal draft was blocked) is kept in front.
    .bind(clip(`${t.draft_note ? `${t.draft_note} · ` : ""}${note}`, 300), at, t.id).run();
  for (const t of results || []) {
    // Up to 2 thread reads + 1 AI call + 4 Gmail calls for the draft (guard, create, read back).
    if (budget.left < 8) break;
    const at = nowIso(nowMs);
    let body = t.draft_status === "starter" ? t.draft_body : null;
    if (!body && asked >= PER_RUN) continue;
    // Another draft for this conversation still in Gmail (a joined follow-up, or a stale draft
    // Reilly was told to delete): no second one, and no AI call spent finding that out.
    if (await otherLiveDraft(env, t, { fetchImpl, nowMs, budget })) { await skip(t, "No starting reply: another draft for this conversation is still in Gmail", at); continue; }
    // Has Reilly already answered in Gmail? The thread check (obligations) only comes round every
    // couple of hours, so the thread is read now. A failed read proves nothing: next run.
    try {
      if (!budget.take(2)) break;
      const token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: t.slot });
      const thread = t.thread_id ? await getThread(token, t.thread_id, { fetchImpl }) : { messages: [] };
      const customerMs = Date.parse(t.received_at || t.opened_at) || 0;
      if ((thread.messages || []).some((m) => (m.labelIds || []).includes("SENT") && Number(m.internalDate) > customerMs)) {
        await skip(t, "No starting reply: you already replied in this conversation", at);
        continue;
      }
    } catch {
      continue;
    }
    if (!body) {
      if (!budget.take(1)) break;
      asked++;
      const ctx = safeJson(t.context, null);
      const sizeAsked = emailAsksAboutSize(t);
      const store = storeName(t.order_store || t.store) || "our store";
      const why = clip(escalationReason(t) || String(t.category || "not covered by the playbook").replace(/_/g, " "), 200);
      let r;
      try {
        r = await askJson(env, { system: starterSystem(store, await corePolicy(db, t.order_store || t.store), why), user: userPrompt(t, ctx, null), maxTokens: 500, actor: ACTOR, label: "CS starter draft", store: t.store || undefined }, { fetchImpl, nowMs });
      } catch (err) {
        // An unusable AI answer is not retried every run (it would hold up every older flag).
        out.failed++;
        await skip(t, `Starting reply not made: AI answer unusable (${clip(String(err && err.message), 100)})`, at);
        continue;
      }
      if (r.skipped) break; // AI paused or out of allowance; the reply writer logs that
      const j = r.json || {};
      if (j.no_reply === true) {
        out.no_reply++;
        await skip(t, "No starting reply: the writer says this email needs no reply", at);
        continue;
      }
      body = signOff(typeof j.body === "string" ? j.body.trim() : "");
      const checkOpts = { ctx: t.order_mismatch ? null : ctx, orderRef: t.order_mismatch ? null : t.order_ref, sizeAsked };
      let problems = checkDraft(body, checkOpts);
      // One rewrite with the check's own words (live 2026-10-16: refund and return requests kept
      // failing because the writer echoed "refund" / "send it back"). The same code check then
      // decides again; a second failure is final.
      if (problems.length && budget.take(1)) {
        try {
          const r2 = await askJson(env, {
            system: starterSystem(store, await corePolicy(db, t.order_store || t.store), why),
            user: `${userPrompt(t, ctx, null)}\n\nYour previous reply was rejected by the safety check: ${problems.join("; ")}.\nWrite it again without those words or anything like them. Refer to what they asked for as "your request" (never name a refund, return, replacement or exchange), and say the team is looking into it.`,
            maxTokens: 500, actor: ACTOR, label: "CS starter draft (rewrite)", store: t.store || undefined,
          }, { fetchImpl, nowMs });
          const j2 = (r2 && r2.json) || {};
          if (typeof j2.body === "string" && j2.body.trim()) {
            const body2 = signOff(j2.body.trim());
            const p2 = checkDraft(body2, checkOpts);
            if (!p2.length) { body = body2; problems = []; } else problems = p2;
          }
        } catch { /* keep the first problems */ }
      }
      if (problems.length) {
        out.failed++;
        await skip(t, `Starting reply not used: ${problems.join("; ")}`, at);
        await logEvent(db, { actor: ACTOR, kind: "cs.starter_blocked", store: t.store, at, summary: `Ticket ${t.id}: starting reply not used (${clip(problems.join("; "), 160)}); the flag stays as it is`, data: { ticket: t.id, problems } });
        continue;
      }
      out.written++;
      await db.prepare(`UPDATE cs_tickets SET draft_body = ?, draft_status = 'starter', draft_at = ?, updated_at = ? WHERE id = ?`).bind(body, at, at, t.id).run();
    }
    const g = await pushGmailDraft(env, t, body, { nowMs, fetchImpl, budget });
    if (!g.ok) continue; // stays 'starter' (retried) unless pushGmailDraft refused it for good
    out.gmail++;
    await markCard(db, t.approval_id);
    await logEvent(db, { actor: ACTOR, kind: "cs.starter_to_gmail", store: t.store, target: "sys.gmail", at, summary: `Ticket ${t.id} (flagged to Reilly): starting reply saved as a Gmail draft for him to finish and send. Nothing sent.`, data: { ticket: t.id, approvalId: t.approval_id } });
  }
  return out;
}
