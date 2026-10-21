/**
 * cs.reply_writer, second job — STARTER drafts for the emails flagged to Reilly.
 *
 * Why (Reilly 2026-10-15, looking at Waiting on you): "i thought the brain was supposed to draft
 * replies for me, not just tell me". Flagged emails (refunds, returns, complaints, anything the
 * playbook doesn't cover) are still Reilly's DECISION, but he shouldn't have to write the reply
 * from nothing. Since 2026-10-20 ("look at how i handle certain situations and what i do, and
 * update and train the brain better") each draft is the reply HE would send next, from his own
 * sent mail (playbook.js): photos first for any return, then his usual choice once photos are in.
 * The card says what the draft proposes; Reilly checks it, edits if needed, and sends it himself.
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
import { draftsLive, pushGmailDraft, corePolicy, userPrompt, withSignature, bodyWithoutSignature } from "./replyWriter.js";
import { escalationReason } from "./escalation.js";
import { otherLiveDraft } from "./gmailDrafts.js";
import { getThread, bodyText, stripQuoted, hasImages } from "./gmail.js";
import { PLAYBOOK, VOICE } from "./playbook.js";
import { getGoogleAccessToken } from "../../lib/google.js";
import { safeJson, clip } from "./util.js";

const ACTOR = "cs.reply_writer";
const PER_RUN = 2; // tickets per run (up to 2 AI calls each: the starter and one rewrite)
/** Starters blocked before the one-rewrite retry existed (2026-10-16) get one more go. */
export const RETRY_BLOCKED_BEFORE = "2026-10-16T17:00:00.000Z";

export const OLD_CARD_TAIL = "Reply in Gmail; nothing has been sent.";
export const NEW_CARD_TAIL = "A starting reply is in your Gmail drafts: add your decision, then send. Nothing has been sent.";

/** What a starter draft proposes: Reilly's next step in his own playbook. */
export const PROPOSALS = Object.freeze({
  photos: "asks for photos of the item first",
  info: "asks for the missing details (order number, reason, which product)",
  refund_keep: "full refund, customer keeps the item",
  replacement: "free replacement in the right size",
  return_address: "return address, refund once it arrives",
  received_refund: "item received, refund issued",
  order_change: "says the order change is done (make it in Shopify first)",
  delivered_check: "asks them to check other places it may have been left",
  other: "an answer in his usual words",
});
/** Proposals that state Reilly's decision: his policy wording is allowed in them (routing.checkDraft policy). */
export const DECIDING = new Set(["refund_keep", "replacement", "return_address", "received_refund"]);
/** Step 2 needs the photos first (his rule: "the first step of the return process is ... photos"). */
export const NEEDS_PHOTOS = new Set(["refund_keep", "replacement", "return_address"]);
/** The check options for a proposal: policy wording only for HIS step, and only once photos are in. */
export function proposalPolicy(proposes, photosSent) {
  if (!DECIDING.has(proposes)) return null;
  if (NEEDS_PHOTOS.has(proposes) && !photosSent) return null;
  return proposes;
}

export function starterSystem(store, policy, why) {
  return `You write customer-service email replies for ${store}, a small online clothing store, AS REILLY WOULD WRITE THEM. Reilly owns the store; he reads every draft, edits it if needed and sends it himself. This email was flagged to him because: ${why}.
${PLAYBOOK}
${VOICE}
Write the reply Reilly would send NOW, following his playbook:
- Work out which step the conversation is at from "Reilly's last reply" and whether the customer has sent photos. A return/refund/exchange request with no photos yet → step 1 (ask for photos of the current condition). Photos already sent → step 2 (his usual choice for what they show).
- Use only the order facts given; if no order was found and you need it, ask for the order number. If the order number belongs to a different email, ask which email they used to place it.
- Say a parcel is delivered or not ONLY from carrier_says_delivered.
- Never write an amount of money, a percentage, a discount or coupon code, store credit, a prepaid label, a date, weekday or month name. Refund timing only as "within the next few days" or "within the next week or so". The only numbers allowed: the order number, tracking numbers and links given, and the return address.
- Never mention that a bigger or different factory size may be sent unless the customer asked about size or fit.
- If the email asks nothing and needs no reply (only thanks), return {"no_reply":true}.
End with one closing line ("Thanks," / "Let us know if you have any other questions,"). Do NOT sign: the signature is added after you.
${policy ? `Store policy notes (from the Core):\n${policy}` : ""}
Return {"body":"the reply","proposes":"${Object.keys(PROPOSALS).join("|")}","no_reply":false}`;
}

/** The conversation so far, for the writer: Reilly's last reply and whether photos came after it. */
export function threadSoFar(thread, customerMs) {
  const msgs = [...((thread && thread.messages) || [])].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const sent = msgs.filter((m) => (m.labelIds || []).includes("SENT") && Number(m.internalDate) <= customerMs);
  const last = sent[sent.length - 1] || null;
  const since = msgs.filter((m) => !(m.labelIds || []).includes("SENT") && Number(m.internalDate) > (last ? Number(last.internalDate) : 0));
  return {
    reillyLast: last ? clip(stripQuoted(bodyText(last)), 700) : null,
    photosSent: since.some(hasImages) || (!last && msgs.some((m) => !(m.labelIds || []).includes("SENT") && hasImages(m))),
  };
}

/** Swap the card's last line once a starter is in Gmail, so the card says where it is. */
async function markCard(db, approvalId, proposes) {
  const said = proposes ? (PROPOSALS[proposes] || proposes) : null;
  const tail = said ? `A draft reply is in your Gmail drafts (it ${said.startsWith("asks") || said.startsWith("says") ? said : `proposes: ${said}`}). Check it, then send. Nothing has been sent.` : NEW_CARD_TAIL;
  if (!approvalId) return;
  const a = await db.prepare(`SELECT options, status FROM approvals WHERE id = ?`).bind(approvalId).first();
  if (!a || a.status !== "pending") return;
  const opts = safeJson(a.options, []);
  let changed = false;
  for (const o of opts) if (o && typeof o.detail === "string" && o.detail.includes(OLD_CARD_TAIL)) { o.detail = o.detail.replace(OLD_CARD_TAIL, tail); changed = true; }
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
    let so = { reillyLast: null, photosSent: false }, proposes = null;
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
      so = threadSoFar(thread, customerMs);
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
      const convo = `Reilly's last reply in this conversation: ${so.reillyLast ? `\n${so.reillyLast}` : "(none: this is the first email)"}\nPhotos sent by the customer${so.reillyLast ? " since then" : ""}: ${so.photosSent ? "yes" : "no"}`;
      const store = storeName(t.order_store || t.store) || "our store";
      const why = clip(escalationReason(t) || String(t.category || "not covered by the playbook").replace(/_/g, " "), 200);
      let r;
      try {
        r = await askJson(env, { system: starterSystem(store, await corePolicy(db, t.order_store || t.store), why), user: `${userPrompt(t, ctx, null)}\n\n${convo}`, maxTokens: 600, actor: ACTOR, label: "CS starter draft", store: t.store || undefined }, { fetchImpl, nowMs });
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
      proposes = PROPOSALS[j.proposes] ? j.proposes : "other";
      body = bodyWithoutSignature(typeof j.body === "string" ? j.body.trim() : "", store);
      const checkOpts = { ctx: t.order_mismatch ? null : ctx, orderRef: t.order_mismatch ? null : t.order_ref, sizeAsked, policy: proposalPolicy(proposes, so.photosSent) };
      let problems = checkDraft(body, checkOpts);
      // One rewrite with the check's own words (live 2026-10-16: refund and return requests kept
      // failing because the writer echoed "refund" / "send it back"). The same code check then
      // decides again; a second failure is final.
      if (problems.length && budget.take(1)) {
        try {
          const r2 = await askJson(env, {
            system: starterSystem(store, await corePolicy(db, t.order_store || t.store), why),
            user: `${userPrompt(t, ctx, null)}\n\n${convo}\n\nYour previous draft was rejected by the safety check: ${problems.join("; ")}.\nWrite it again in Reilly's words without those things.`,
            maxTokens: 600, actor: ACTOR, label: "CS starter draft (rewrite)", store: t.store || undefined,
          }, { fetchImpl, nowMs });
          const j2 = (r2 && r2.json) || {};
          if (typeof j2.body === "string" && j2.body.trim()) {
            const body2 = bodyWithoutSignature(j2.body.trim(), store);
            const proposes2 = PROPOSALS[j2.proposes] ? j2.proposes : proposes;
            const p2 = checkDraft(body2, { ...checkOpts, policy: proposalPolicy(proposes2, so.photosSent) });
            if (!p2.length) { body = body2; problems = []; proposes = proposes2; } else problems = p2;
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
      body = withSignature(body, { slot: t.slot, store });
      await db.prepare(`UPDATE cs_tickets SET draft_body = ?, draft_status = 'starter', draft_note = ?, draft_at = ?, updated_at = ? WHERE id = ?`).bind(body, clip(`Draft proposes: ${PROPOSALS[proposes]}`, 300), at, at, t.id).run();
    }
    const g = await pushGmailDraft(env, t, body, { nowMs, fetchImpl, budget });
    if (!g.ok) continue; // stays 'starter' (retried) unless pushGmailDraft refused it for good
    out.gmail++;
    await markCard(db, t.approval_id, proposes || (String(t.draft_note || "").match(/Draft proposes: (.+)$/) || [])[1] || null);
    await logEvent(db, { actor: ACTOR, kind: "cs.starter_to_gmail", store: t.store, target: "sys.gmail", at, summary: `Ticket ${t.id} (flagged to Reilly): starting reply saved as a Gmail draft for him to finish and send. Nothing sent.`, data: { ticket: t.id, approvalId: t.approval_id } });
  }
  return out;
}
