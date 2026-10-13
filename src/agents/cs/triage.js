/**
 * cs.triage — Inbox Triage (AI). SHADOW: reads mail only; never sends, labels, archives or deletes.
 *
 * What it does:
 *   1. readInboxes: for each connected inbox (Holt & Crane's own "google:hc"; Reilly's main
 *      "google" for stores without their own inbox), lists inbox mail newer than the inbox's
 *      cursor, screens it with plain code (filters.js) and stores customer mail as cs_tickets.
 *      First read looks back FIRST_READ_DAYS only. Each message is looked at once (cs_mail_seen).
 *   2. classifyTickets: asks Claude (askJson, small cap per tick) to sort each new ticket into a
 *      fixed category set + store + order number + urgency. Code validates every field; the
 *      store the code worked out from the address always beats the AI's guess.
 * Inputs: Gmail API (read), oauth_tokens, cs_tickets. Outputs: cs_tickets rows, events.
 * Not wired (no Google connection / no AI key): skipped and said so, never treated as "no mail".
 */
import { getGoogleAccessToken } from "../../lib/google.js";
import { askJson } from "../../lib/ai.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { LIVE_STORE_IDS } from "../../config/stores.js";
import { CATEGORIES, CAPS, FIRST_READ_DAYS, inboxPlan, storeName } from "./config.js";
import { listInboxIds, getMessage, headerMap, bodyText, stripQuoted } from "./gmail.js";
import { screenMail } from "./filters.js";
import { logOnce, clip } from "./util.js";

const ACTOR = "cs.triage";

/** Verified Google slots (saved but never proven = not connected, same rule as googleStatus). */
export async function connectedSlots(db) {
  const { results } = await db.prepare(`SELECT provider, account FROM oauth_tokens WHERE provider LIKE 'google%' AND verified_at IS NOT NULL`).all();
  return new Map((results || []).map((r) => [r.provider, String(r.account || "").toLowerCase()]));
}

async function noteInbox(db, slot, fields) {
  await db.prepare(`INSERT INTO cs_inboxes (slot) VALUES (?) ON CONFLICT(slot) DO NOTHING`).bind(slot).run();
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.prepare(`UPDATE cs_inboxes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE slot = ?`).bind(...keys.map((k) => fields[k]), slot).run();
}

/** Step 1: read every connected inbox. */
export async function readInboxes(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const slots = await connectedSlots(db);
  const out = [];
  for (const inbox of inboxPlan(new Set(slots.keys()))) {
    if (!inbox.stores.length) continue; // every live store has its own inbox: nothing to read in main
    try {
      out.push(await readOneInbox(env, inbox, slots.get(inbox.slot) || null, { nowMs, fetchImpl, budget }));
    } catch (err) {
      const msg = String(err && err.message).slice(0, 200);
      await noteInbox(db, inbox.slot, { last_read_at: nowIso(nowMs), last_error: msg });
      await logOnce(db, { actor: ACTOR, kind: "error.cs_read", target: "sys.gmail", summary: `Couldn't read ${inbox.slot === "google" ? "the main inbox" : `${storeName(inbox.stores[0])}'s inbox`}: ${msg}. Will retry next tick.` }, { key: inbox.slot, nowMs });
      out.push({ slot: inbox.slot, error: msg });
    }
  }
  return out;
}

async function readOneInbox(env, inbox, account, { nowMs, fetchImpl, budget }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const label = inbox.slot === "google" ? `Main inbox (${inbox.stores.map(storeName).join(", ")})` : `${storeName(inbox.stores[0])} inbox`;
  if (!account) {
    await noteInbox(db, inbox.slot, { last_read_at: at, last_error: "not wired (Google not connected)" });
    await logOnce(db, { actor: ACTOR, kind: "cs.inbox_not_wired", target: "sys.gmail", summary: `${label}: not connected, so no mail is read for ${inbox.stores.map(storeName).join(", ")} (Setup → Connect).` }, { key: inbox.slot, windowMin: 24 * 60, nowMs });
    return { slot: inbox.slot, wired: false };
  }
  if (!budget.take(2)) return { slot: inbox.slot, skipped: "tick budget used" };
  let token;
  try {
    token = await getGoogleAccessToken(env, { fetchImpl, nowMs, slot: inbox.slot });
  } catch (err) {
    if (err && err.code === "NOT_WIRED") {
      await noteInbox(db, inbox.slot, { last_read_at: at, last_error: "not wired" });
      return { slot: inbox.slot, wired: false };
    }
    throw err;
  }
  const row = await db.prepare(`SELECT * FROM cs_inboxes WHERE slot = ?`).bind(inbox.slot).first();
  const firstRead = !row || row.cursor_ms == null;
  const cursor = firstRead ? nowMs - FIRST_READ_DAYS * 86400000 : Number(row.cursor_ms);
  const listed = await listInboxIds(token, { afterMs: cursor, max: CAPS.listPage, fetchImpl });

  // Gmail lists newest first and can't sort the other way. If the page is full, mail older
  // than the page may never be listed: say so instead of pretending the inbox is covered.
  if (listed.length >= CAPS.listPage) {
    await logOnce(db, { actor: ACTOR, kind: "cs.read_backlog", target: "sys.gmail", summary: `${label}: ${CAPS.listPage}+ new emails since the last read; the oldest beyond that page may be skipped. Check the inbox by hand if this repeats.` }, { key: inbox.slot, windowMin: 6 * 60, nowMs });
  }

  const fresh = [];
  for (const m of listed) {
    const seen = await db.prepare(`SELECT 1 FROM cs_mail_seen WHERE slot = ? AND gmail_id = ?`).bind(inbox.slot, m.id).first();
    if (!seen) fresh.push(m);
  }
  // Oldest first, so the cursor only ever moves past mail that was actually read.
  const batch = fresh.reverse().slice(0, CAPS.readPerInbox);
  let maxMs = cursor, tickets = 0, ignored = 0, read = 0;
  for (const m of batch) {
    if (!budget.take(1)) break;
    const msg = await getMessage(token, m.id, { fetchImpl });
    read++;
    const internal = Number(msg.internalDate) || null;
    if (internal && internal > maxMs) maxMs = internal;
    const res = await storeMessage(db, inbox, account, msg, at);
    if (res === "ticket") tickets++; else ignored++;
  }
  // Mail was read oldest first, so everything up to maxMs on this page has been looked at.
  // Gmail's after: is per second, so the next list overlaps a little; seen ids are skipped.
  await noteInbox(db, inbox.slot, {
    account, cursor_ms: Math.max(maxMs, cursor), last_read_at: at, last_ok_at: at, last_error: null,
    read_count: Number((row && row.read_count) || 0) + read,
  });
  if (read) {
    await logEvent(db, {
      actor: ACTOR, kind: "cs.inbox_read", target: "sys.gmail", at,
      summary: `${label}: read ${read} email${read === 1 ? "" : "s"} → ${tickets} customer ticket${tickets === 1 ? "" : "s"}, ${ignored} not customer mail${fresh.length > read ? ` (${fresh.length - read} more next tick)` : ""}`,
      data: { slot: inbox.slot, read, tickets, ignored, waiting: fresh.length - read },
    });
  }
  return { slot: inbox.slot, read, tickets, ignored, waiting: fresh.length - read };
}

/** Screen one message and store it as a ticket (or as seen-and-ignored). */
async function storeMessage(db, inbox, account, msg, at) {
  const headers = headerMap(msg);
  const body = stripQuoted(bodyText(msg));
  const screen = screenMail({ headers, labelIds: msg.labelIds || [], body }, inbox, account);
  const seen = (outcome) => db.prepare(`INSERT OR IGNORE INTO cs_mail_seen (slot, gmail_id, seen_at, outcome) VALUES (?, ?, ?, ?)`).bind(inbox.slot, msg.id, at, outcome).run();
  if (!screen.keep) { await seen(`ignored:${screen.reason}`); return "ignored"; }

  const received = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : at;
  const msgId = String(headers["message-id"] || "").trim() || null;
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO cs_tickets (opened_at, updated_at, slot, gmail_id, thread_id, rfc_message_id, received_at, store,
       from_email, from_name, to_addr, subject, body, via, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).bind(at, at, inbox.slot, msg.id, msg.threadId || null, msgId, received, screen.store,
    screen.replyTo, clip(screen.fromName, 120), clip(headers.to, 300), clip(headers.subject || "", 300), clip(body, 4000), screen.via).run();
  if (!ins.meta || ins.meta.changes !== 1) { await seen("ignored:duplicate (same email already read)"); return "ignored"; }
  const id = ins.meta.last_row_id;
  await seen("ticket");
  // A newer email in the same thread replaces older unanswered ones (one reply per conversation).
  // Escalated tickets stay as they are: Reilly's flag doesn't disappear because the customer wrote again.
  if (msg.threadId) {
    await db.prepare(`UPDATE cs_tickets SET status = 'superseded', updated_at = ? WHERE slot = ? AND thread_id = ? AND id < ? AND status IN ('new','open','drafted')`)
      .bind(at, inbox.slot, msg.threadId, id).run();
  }
  await logEvent(db, { actor: ACTOR, kind: "cs.ticket_opened", store: screen.store, at, summary: `New ${screen.via === "contact_form" ? "contact form" : "email"} for ${storeName(screen.store) || "an unknown store"}: "${clip(headers.subject || "(no subject)", 80)}"`, data: { ticket: id } });
  return "ticket";
}

/* ---------- step 2: classify ---------- */

const SYSTEM = `You sort customer-service emails for small online clothing stores (Holt & Crane = hc, Auberlane = aub, Marlowe Standard = mar).
Categories (pick exactly one):
- where_is_order: asking where the order / tracking is, or that it hasn't arrived
- size_question: asking which size to buy or about measurements, before or after ordering
- size_complaint: the item arrived and doesn't fit (too small / too big)
- exchange: wants a different size or item swapped for one they received
- address_change: wants the shipping address changed
- colour_change: wants a different colour on an order
- cancel: wants to cancel an order
- return_refund: wants to return for money back, or asks for a refund
- chargeback_or_scam_angry: threatens a chargeback/dispute, calls the store a scam, or is very angry
- product_question: question about a product (material, stock, care) not about a placed order
- other: anything else
Return: {"is_customer":true|false,"category":"...","store":"hc|aub|mar|null","order_number":"digits or null","urgency":"low|normal|high","angry":true|false,"wants_refund":true|false,"summary":"max 20 words","size":{"ordered":null,"wanted":null,"fit":"too_small|too_big|null","product":null,"quote":"the customer's exact words about fit, or null"},"change":{"size_to":null,"colour_to":null,"address":false}}
is_customer is false only for mail that is clearly not from a shopper (vendor pitch, spam, partnership offer).
Never invent an order number: null unless it is written in the email.`;

/** Order number written in the text ("#1234", "order 1234", "order no. 1234"). Digits only. */
export function orderRefFromText(text) {
  const s = String(text || "");
  const m = s.match(/#\s?(\d{3,6})\b/) || s.match(/\border\s*(?:number|no\.?|num|#)?\s*:?\s*#?(\d{3,6})\b/i);
  return m ? m[1] : null;
}

/** Keep only what fits the fixed shape; anything else becomes null / "other". */
export function validateTriage(j, body) {
  const pick = (v, allowed) => (allowed.includes(v) ? v : null);
  const str = (v, n = 60) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? clip(v.trim(), n) : null);
  const size = (j && typeof j.size === "object" && j.size) || {};
  const change = (j && typeof j.change === "object" && j.change) || {};
  let quote = str(size.quote, 400);
  // The customer's words must really be in the email (the complaint log stores them verbatim).
  if (quote && !String(body || "").toLowerCase().includes(quote.toLowerCase())) quote = null;
  const order = str(j && j.order_number, 12);
  return {
    is_customer: !(j && j.is_customer === false),
    category: pick(j && j.category, CATEGORIES) || "other",
    store: pick(j && j.store, LIVE_STORE_IDS),
    order_number: order && /^\d{3,6}$/.test(order.replace(/^#/, "")) ? order.replace(/^#/, "") : null,
    urgency: pick(j && j.urgency, ["low", "normal", "high"]) || "normal",
    angry: !!(j && j.angry === true),
    wants_refund: !!(j && j.wants_refund === true),
    summary: str(j && j.summary, 160),
    size: { ordered: str(size.ordered, 12), wanted: str(size.wanted, 12), fit: pick(size.fit, ["too_small", "too_big"]), product: str(size.product, 120), quote },
    change: { size_to: str(change.size_to, 12), colour_to: str(change.colour_to, 30), address: change.address === true },
  };
}

export async function classifyTickets(env, { nowMs = Date.now(), fetchImpl = fetch, budget }) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT * FROM cs_tickets WHERE status = 'new' ORDER BY id LIMIT ?`).bind(CAPS.classifyPerTick).all();
  let done = 0, waiting = 0, failed = 0;
  for (const t of results || []) {
    const at = nowIso(nowMs);
    if (!budget.take(1)) { waiting++; continue; }
    // Earlier email in the same thread, so "any update?" is understood.
    const prev = t.thread_id ? await db.prepare(`SELECT summary, category FROM cs_tickets WHERE slot = ? AND thread_id = ? AND id < ? AND summary IS NOT NULL ORDER BY id DESC LIMIT 1`).bind(t.slot, t.thread_id, t.id).first() : null;
    const user = [
      `Store (from the address it was sent to): ${storeName(t.store) || "unknown"}`,
      `Via: ${t.via}`,
      prev ? `Earlier in this conversation: [${prev.category}] ${prev.summary}` : null,
      `Subject: ${t.subject || ""}`,
      `Email:\n${clip(t.body || "", 2500)}`,
    ].filter(Boolean).join("\n");
    let r;
    try {
      r = await askJson(env, { system: SYSTEM, user, maxTokens: 350, actor: ACTOR, label: "CS triage", store: t.store || undefined }, { fetchImpl, nowMs });
    } catch (err) {
      failed++;
      // Second unusable answer: send it to Reilly as "other" rather than spend on it forever.
      if (String(t.classify_note || "").startsWith("AI answer unusable")) {
        await saveTriage(db, t, validateTriage({ category: "other", summary: "AI couldn't classify this email twice; please read it." }, t.body), at, "AI answer unusable twice → other");
      } else {
        await db.prepare(`UPDATE cs_tickets SET classify_note = ?, updated_at = ? WHERE id = ?`).bind(`AI answer unusable (${clip(err.message, 100)})`, at, t.id).run();
      }
      continue;
    }
    if (r.skipped) {
      waiting++;
      await db.prepare(`UPDATE cs_tickets SET classify_note = ? WHERE id = ?`).bind(`waiting on AI (${r.skipped})`, t.id).run();
      await logOnce(db, { actor: ACTOR, kind: "cs.ai_waiting", summary: `Customer emails are read but not sorted yet: AI is ${r.skipped}.` }, { windowMin: 6 * 60, nowMs });
      break; // the same reason applies to the rest
    }
    const v = validateTriage(r.json, t.body);
    await saveTriage(db, t, v, at, null);
    done++;
  }
  return { classified: done, waiting, failed };
}

async function saveTriage(db, t, v, at, note) {
  // Code first: the store worked out from the address beats the AI's guess.
  const store = t.store || v.store || null;
  const orderRef = orderRefFromText(`${t.subject || ""}\n${t.body || ""}`) || v.order_number;
  const urgency = v.category === "chargeback_or_scam_angry" || v.angry ? "high" : v.urgency;
  const status = v.is_customer ? "open" : "ignored";
  await db.prepare(
    `UPDATE cs_tickets SET status = ?, category = ?, urgency = ?, order_ref = ?, summary = ?, triage = ?, store = ?, classified_at = ?, classify_note = ?, updated_at = ? WHERE id = ?`
  ).bind(status, v.category, urgency, orderRef, v.summary, JSON.stringify(v), store, at, note, at, t.id).run();
  await logEvent(db, {
    actor: ACTOR, kind: v.is_customer ? "cs.ticket_classified" : "cs.ticket_ignored", store, at,
    summary: v.is_customer
      ? `${storeName(store) || "Unknown store"}: ${v.category.replace(/_/g, " ")}${orderRef ? ` (#${orderRef})` : ""}${urgency === "high" ? ", URGENT" : ""}: ${v.summary || clip(t.subject, 80)}`
      : `Not a customer (AI): "${clip(t.subject, 80)}" from ${t.from_email}. Listed on the CS page in case that's wrong.`,
    data: { ticket: t.id, category: v.category },
  });
}

