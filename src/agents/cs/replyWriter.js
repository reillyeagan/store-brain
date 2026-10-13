/**
 * cs.reply_writer — Reply Writer (AI). SHADOW: drafts are stored in D1 (cs_tickets.draft_body).
 * NEVER sends. Only when env CS_DRAFTS_LIVE === "1" does it also create a Gmail DRAFT (threaded
 * reply, in the inbox the customer wrote to) for Reilly to review and send himself
 * (spec decision 2, Reilly 2026-10-11: "lets start of with the emails being put in my drafts").
 *
 * Rules the draft follows (spec + CS Playbook facts seeded in the Core, when present):
 *   - signed as the store the customer wrote to / bought from;
 *   - express may be called the faster option, never a guaranteed date (decision 1);
 *   - never promises refunds, reships or replacements (those tickets go to cs.escalation);
 *   - order facts come only from the order context code attached; nothing invented.
 * Every draft is then checked by code (routing.checkDraft). A draft that fails is not used; the
 * ticket goes to Reilly instead.
 * Inputs: cs_tickets with context, core_facts (CS policy), size_charts. Outputs: drafts, events.
 */
import { askJson } from "../../lib/ai.js";
import { getGoogleAccessToken } from "../../lib/google.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { CAPS, DELIVERY_FACTS, expectedSlotAccount, storeName } from "./config.js";
import { routeTicket, checkDraft } from "./routing.js";
import { threadWaitingOnReilly } from "./escalation.js";
import { createReplyDraft, getDraft } from "./gmail.js";
import { safeJson, clip, logOnce } from "./util.js";

const ACTOR = "cs.reply_writer";

export const draftsLive = (env) => !!(env && env.CS_DRAFTS_LIVE === "1");

/** CS rules from the Core (the vault's CS Playbook, once seeded). Capped so the prompt stays small. */
async function corePolicy(db, store) {
  const { results } = await db.prepare(
    `SELECT key, value FROM core_facts WHERE live = 1 AND (store IS NULL OR store = ?)
       AND (area IN ('policy', 'cs') OR key LIKE 'cs.%' OR key LIKE 'policy.%') ORDER BY id LIMIT 30`
  ).bind(store || null).all().catch(() => ({ results: [] }));
  let out = "";
  for (const r of results || []) {
    const line = `- ${r.key}: ${clip(r.value, 400)}\n`;
    if (out.length + line.length > 3000) break;
    out += line;
  }
  return out;
}

async function sizeChartFor(db, ctx) {
  if (!ctx || !ctx.items) return null;
  const out = [];
  for (const it of ctx.items.slice(0, 3)) {
    if (!it.product_id) continue;
    const { results } = await db.prepare(`SELECT size_label, measurements, verified FROM size_charts WHERE store = ? AND product_id = ? LIMIT 12`).bind(ctx.store, it.product_id).all();
    if ((results || []).length) out.push({ product: it.title, verified: results.every((r) => r.verified === 1), sizes: results.map((r) => ({ size: r.size_label, cm: safeJson(r.measurements, null) })) });
  }
  return out.length ? out : null;
}

function system(store, policy) {
  return `You write customer-service email replies for ${store}, a small online clothing store. Reilly reviews and sends every reply himself.
Voice: warm, short, plain English, no corporate filler. 3-8 sentences. Greet the customer by first name if known. Sign off exactly: "${store} Customer Care".
Hard rules:
- Use ONLY the order facts given. Never invent order numbers, tracking numbers, dates, measurements or policies.
- Never promise a refund, a reship, a replacement, or a guaranteed delivery date.
- Express shipping can be described as the faster option, never with a guaranteed date.
- Delivery timing you may use: ${DELIVERY_FACTS.join(" ")}
- If a tracking number and link are given, include them. If no order was found, ask politely for the order number.
- For size questions use only the size chart given; if there is none, say you'll check the measurements and get back to them (no date).
- For address / colour / size changes before shipping: say you've passed the request on and will confirm once it's updated (no promise it will be possible).
- If the email needs a decision only the owner can make (money back, a replacement, a complaint, a threat), set needs_reilly true and write no body.
${policy ? `Store policy (from the playbook):\n${policy}` : ""}
Return {"body":"the full reply text","needs_reilly":false,"reason":null}`;
}

function userPrompt(t, ctx, chart) {
  const facts = ctx ? {
    order: ctx.name, placed: ctx.created_at, payment: ctx.financial_status, fulfillment: ctx.fulfillment_status,
    cancelled: !!ctx.cancelled_at, shipped: ctx.shipped, express: ctx.express, shipping_method: ctx.shipping_method,
    items: (ctx.items || []).map((i) => `${i.qty || 1} × ${i.title}${i.variant ? ` (${i.variant})` : ""}`),
    tracking: (ctx.shipments || []).map((s) => ({ number: s.tracking_number, link: s.tracking_url, carrier: s.carrier, shipped: s.shipped_at, shopify_status: s.shopify_status, delivered: s.delivered_at })),
    data_as_of: ctx.as_of,
  } : null;
  return [
    `Category: ${t.category}`,
    `Customer: ${t.from_name || "(name unknown)"} <${t.from_email}>`,
    `Subject: ${t.subject || ""}`,
    `Their email:\n${clip(t.body || "", 2000)}`,
    facts ? `Order facts (from Shopify):\n${JSON.stringify(facts)}` : `Order facts: no order found (${t.context_note || "not matched"}).`,
    chart ? `Size chart (cm${chart.every((c) => c.verified) ? "" : ", not yet verified by a person"}):\n${JSON.stringify(chart)}` : null,
  ].filter(Boolean).join("\n\n");
}

export async function writeReplies(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM cs_tickets WHERE status = 'open' AND context_at IS NOT NULL AND draft_status IS NULL ORDER BY (urgency = 'high') DESC, id LIMIT 20`
  ).all();
  let drafted = 0, blocked = 0, toReilly = 0, gmail = 0, waiting = 0;
  for (const t of results || []) {
    if (drafted + blocked + toReilly >= CAPS.draftsPerTick) break;
    const triage = safeJson(t.triage, {});
    const ctx = safeJson(t.context, null);
    if (routeTicket(t, triage, ctx).action !== "draft") continue; // cs.escalation takes it
    if (await threadWaitingOnReilly(db, t)) continue; // the conversation is with Reilly; escalation joins it
    if (!budget.take(1)) break;
    const at = nowIso(nowMs);
    const store = storeName(t.order_store || t.store) || "our store";
    let r;
    try {
      r = await askJson(env, { system: system(store, await corePolicy(db, t.order_store || t.store)), user: userPrompt(t, ctx, await sizeChartFor(db, ctx)), maxTokens: 600, actor: ACTOR, label: "CS reply draft", store: t.store || undefined }, { fetchImpl, nowMs });
    } catch (err) {
      blocked++;
      await db.prepare(`UPDATE cs_tickets SET draft_status = 'blocked', draft_note = ?, draft_at = ?, updated_at = ? WHERE id = ?`).bind(`AI answer unusable: ${clip(err.message, 120)}`, at, at, t.id).run();
      continue;
    }
    if (r.skipped) {
      waiting++;
      await logOnce(db, { actor: ACTOR, kind: "cs.ai_waiting", summary: `Replies are not being drafted: AI is ${r.skipped}.` }, { windowMin: 6 * 60, nowMs });
      break;
    }
    const j = r.json || {};
    if (j.needs_reilly === true) {
      toReilly++;
      await db.prepare(`UPDATE cs_tickets SET draft_status = 'escalated', draft_note = ?, draft_at = ?, updated_at = ? WHERE id = ?`).bind(clip(`Writer says this needs Reilly: ${j.reason || "no reason given"}`, 300), at, at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.draft_needs_reilly", store: t.store, target: "cs.escalation", at, summary: `Ticket ${t.id}: no reply drafted, needs Reilly (${clip(j.reason || "no reason given", 120)})`, data: { ticket: t.id } });
      continue;
    }
    const body = typeof j.body === "string" ? j.body.trim() : "";
    const problems = checkDraft(body, { ctx, orderRef: t.order_ref });
    if (problems.length) {
      blocked++;
      await db.prepare(`UPDATE cs_tickets SET draft_body = ?, draft_status = 'blocked', draft_note = ?, draft_at = ?, updated_at = ? WHERE id = ?`).bind(clip(body, 3000), clip(`Draft failed the check: ${problems.join("; ")}`, 300), at, at, t.id).run();
      await logEvent(db, { actor: ACTOR, kind: "cs.draft_blocked", store: t.store, target: "cs.escalation", at, summary: `Ticket ${t.id}: draft not used (${problems.join("; ")}); sent to Reilly instead`, data: { ticket: t.id, problems } });
      continue;
    }
    drafted++;
    await db.prepare(`UPDATE cs_tickets SET draft_body = ?, draft_status = 'stored', draft_note = NULL, draft_at = ?, status = 'drafted', updated_at = ? WHERE id = ?`).bind(body, at, at, t.id).run();
    let where = "stored on the CS page (Gmail drafts are off)";
    if (draftsLive(env)) {
      const g = await pushGmailDraft(env, t, body, { nowMs, fetchImpl, budget });
      if (g.ok) { gmail++; where = "saved as a Gmail draft for Reilly to send"; }
      else where = `stored on the CS page; Gmail draft not made (${g.error})`;
    }
    await logEvent(db, { actor: ACTOR, kind: "cs.draft_written", store: t.store, target: draftsLive(env) ? "sys.gmail" : undefined, at, summary: `Reply drafted for ${store} (${String(t.category).replace(/_/g, " ")}${ctx ? `, ${ctx.name}` : ""}): ${where}. Nothing sent.`, data: { ticket: t.id } });
  }
  return { drafted, blocked, toReilly, gmailDrafts: gmail, waiting };
}

/**
 * Gmail draft (only with CS_DRAFTS_LIVE=1). Store Guard for Gmail: the connected account for the
 * slot must be the inbox we expect, or nothing is written. Verified by reading the draft back
 * (rule 3: a 200 is not proof).
 */
export async function pushGmailDraft(env, t, body, { nowMs, fetchImpl, budget }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const row = await db.prepare(`SELECT account FROM oauth_tokens WHERE provider = ?`).bind(t.slot).first();
  const expected = expectedSlotAccount(env, t.slot);
  if (!row || !expected || String(row.account).toLowerCase() !== expected) {
    await logEvent(db, { actor: ACTOR, kind: "cs.draft_guard_stop", store: t.store, target: "sys.gmail", at, summary: `Gmail draft NOT made for ticket ${t.id}: ${t.slot} is connected as ${row ? row.account : "nobody"}, expected ${expected || "an unset account"}. Hard stop.` });
    return { ok: false, error: "inbox account mismatch" };
  }
  if (!budget.take(3)) return { ok: false, error: "tick budget used; will not retry this one" };
  try {
    const token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: t.slot });
    const d = await createReplyDraft(token, { threadId: t.thread_id, to: t.from_email, subject: t.subject, inReplyTo: t.rfc_message_id, body }, { fetchImpl });
    const back = await getDraft(token, d.id, { fetchImpl });
    if (!back || !back.message || (t.thread_id && back.message.threadId !== t.thread_id)) {
      await db.prepare(`UPDATE cs_tickets SET draft_note = ?, gmail_draft_id = ? WHERE id = ?`).bind("Gmail draft created but the read-back didn't match the thread; check Gmail drafts", d.id, t.id).run();
      return { ok: false, error: "draft read-back didn't match" };
    }
    await db.prepare(`UPDATE cs_tickets SET draft_status = 'gmail_draft', gmail_draft_id = ?, updated_at = ? WHERE id = ?`).bind(d.id, at, t.id).run();
    return { ok: true, id: d.id };
  } catch (err) {
    await db.prepare(`UPDATE cs_tickets SET draft_note = ? WHERE id = ?`).bind(clip(`Gmail draft failed: ${err.message}`, 300), t.id).run();
    return { ok: false, error: clip(err.message, 120) };
  }
}
