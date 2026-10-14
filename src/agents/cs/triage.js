/**
 * cs.triage — Inbox Triage (AI). SHADOW: reads mail only; never sends, labels, archives or deletes.
 *
 * What it does:
 *   1. readInboxes: for each connected inbox (Holt & Crane's own "google:hc"; Reilly's main
 *      "google" for stores without their own inbox), lists mail newer than the inbox's
 *      cursor (all pages, oldest read first; archived mail included; the main inbox narrowed to
 *      the store domains + Shopify contact forms), screens it with plain code (filters.js) and stores customer mail as cs_tickets.
 *      First read looks back FIRST_READ_DAYS only. Each message is looked at once (cs_mail_seen).
 *   2. classifyTickets: asks Claude (askJson, small cap per run) to sort each new ticket into a
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
import { CATEGORIES, CAPS, FIRST_READ_DAYS, STORE_MAIL_DOMAINS, inboxPlan, storeName } from "./config.js";
import { listIds, inboxQuery, getMessage, headerMap, bodyText, stripQuoted } from "./gmail.js";
import { screenMail } from "./filters.js";
import { logOnce, clip } from "./util.js";
import { noActionCheck, earlierUnansweredAsk } from "./noAction.js";

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
      await logOnce(db, { actor: ACTOR, kind: "error.cs_read", target: "sys.gmail", summary: `Couldn't read ${inbox.slot === "google" ? "the main inbox" : `${storeName(inbox.stores[0])}'s inbox`}: ${msg}. Will retry next run.` }, { key: inbox.slot, nowMs });
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
  if (!budget.take(2)) return { slot: inbox.slot, skipped: "run allowance used" };
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
  // Main inbox: only mail sent to the store domains it serves (+ Shopify contact forms).
  const domains = inbox.own ? null : inbox.stores.map((s) => STORE_MAIL_DOMAINS[s]).filter(Boolean);
  // One list page was reserved above; more pages only while the run's allowance lasts.
  const maxPages = Math.max(1, Math.min(CAPS.listMaxPages, budget.left + 1));
  // Working back through a backlog bigger than one listing: only mail older than scan_before.
  const scanBefore = row && row.scan_before_ms != null ? Number(row.scan_before_ms) : null;
  const listing = await listIds(token, { q: inboxQuery(cursor, domains, scanBefore), perPage: CAPS.listPage, maxPages, fetchImpl });
  budget.spend(listing.pages - 1);
  if (!listing.complete) {
    // Gmail lists newest first only. Mail older than what was listed is still unread: the
    // cursor stays put (below), and this is said out loud instead of pretending.
    await logOnce(db, { actor: ACTOR, kind: "cs.read_backlog", target: "sys.gmail", summary: `${label}: more than ${listing.ids.length} emails since the last read; working back to the oldest over the next runs. The cursor stays put until they are read.` }, { key: inbox.slot, windowMin: 6 * 60, nowMs });
  }

  // Already-looked-at ids, in one query (Gmail's after: is per second, so lists overlap).
  const { results: seenRows } = await db.prepare(`SELECT gmail_id FROM cs_mail_seen WHERE slot = ? AND (internal_ms IS NULL OR internal_ms >= ?)`)
    .bind(inbox.slot, cursor - 86400000).all();
  const seen = new Set((seenRows || []).map((r) => r.gmail_id));
  const fresh = listing.ids.filter((m) => !seen.has(m.id));
  // Oldest first (the list is newest first).
  const batch = fresh.slice().reverse().slice(0, CAPS.readPerInbox);
  let tickets = 0, ignored = 0, read = 0, givenUp = 0;
  const failures = [];
  for (const m of batch) {
    if (!budget.take(1)) break;
    let msg;
    try {
      msg = await getMessage(token, m.id, { fetchImpl });
    } catch (err) {
      failures.push({ id: m.id, err });
      continue; // one bad message never blocks the rest
    }
    read++;
    const res = await storeMessage(db, inbox, account, msg, at);
    if (res === "ticket") tickets++; else ignored++;
  }
  if (failures.length >= 2 && !read && !failures.some((f) => f.err && f.err.status === 404)) {
    // Several different messages all failed: that's about Gmail or the connection, not the
    // messages (rule 6), so nothing is counted against them. (The list call just worked, so a
    // single message failing on its own is counted, and skipped after 3 tries.)
    throw failures[0].err;
  }
  for (const f of failures) {
    await db.prepare(
      `INSERT INTO cs_mail_failures (slot, gmail_id, fails, last_error, last_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(slot, gmail_id) DO UPDATE SET fails = fails + 1, last_error = excluded.last_error, last_at = excluded.last_at`
    ).bind(inbox.slot, f.id, clip(String(f.err && f.err.message), 200), at).run();
    const row2 = await db.prepare(`SELECT fails FROM cs_mail_failures WHERE slot = ? AND gmail_id = ?`).bind(inbox.slot, f.id).first();
    if (row2 && row2.fails >= 3) {
      givenUp++;
      await db.prepare(`INSERT OR IGNORE INTO cs_mail_seen (slot, gmail_id, seen_at, outcome, internal_ms) VALUES (?, ?, ?, ?, NULL)`)
        .bind(inbox.slot, f.id, at, `error:${clip(String(f.err && f.err.message), 150)}`).run();
      await logEvent(db, { actor: ACTOR, kind: "error.cs_mail_unreadable", target: "sys.gmail", at, summary: `${label}: one email couldn't be read after 3 tries (${clip(String(f.err && f.err.message), 120)}); skipped. Look for it in Gmail.`, data: { slot: inbox.slot, gmail_id: f.id } });
    }
  }
  // The cursor moves only when everything Gmail listed after it has been looked at, and only to
  // the newest message actually looked at: no mail is ever stepped over.
  let newCursor = cursor, newScan = scanBefore;
  if (listing.complete && read + givenUp === fresh.length) {
    if (scanBefore != null) {
      // Everything older than scan_before is now read, and everything from there up to the top
      // of the listing that started the scan was already seen: the cursor can move to it.
      newCursor = Math.max(cursor, scanBefore - 1000);
      newScan = null;
    } else {
      const mx = await db.prepare(`SELECT MAX(internal_ms) AS m FROM cs_mail_seen WHERE slot = ?`).bind(inbox.slot).first();
      if (mx && mx.m != null && Number(mx.m) > cursor) newCursor = Number(mx.m);
    }
  } else if (!listing.complete && fresh.length === 0) {
    // Every listed email is already seen but older ones exist beyond the listing: next run
    // lists before the oldest listed one, working back to the oldest unread.
    for (const m of listing.ids.slice().reverse()) {
      const r = await db.prepare(`SELECT internal_ms FROM cs_mail_seen WHERE slot = ? AND gmail_id = ?`).bind(inbox.slot, m.id).first();
      if (r && r.internal_ms != null) { newScan = Number(r.internal_ms) + 1000; break; }
    }
  }
  await noteInbox(db, inbox.slot, {
    account, cursor_ms: newCursor, scan_before_ms: newScan, last_read_at: at, last_ok_at: at, last_error: null,
    read_count: Number((row && row.read_count) || 0) + read,
  });
  const waiting = fresh.length - read - givenUp;
  if (read) {
    await logEvent(db, {
      actor: ACTOR, kind: "cs.inbox_read", target: "sys.gmail", at,
      summary: `${label}: read ${read} email${read === 1 ? "" : "s"} → ${tickets} customer ticket${tickets === 1 ? "" : "s"}, ${ignored} not customer mail${waiting > 0 ? ` (${waiting} more next run)` : ""}`,
      data: { slot: inbox.slot, read, tickets, ignored, waiting },
    });
  }
  return { slot: inbox.slot, read, tickets, ignored, waiting, failed: failures.length };
}

/** Screen one message and store it as a ticket (or as seen-and-ignored). */
async function storeMessage(db, inbox, account, msg, at) {
  const headers = headerMap(msg);
  const body = stripQuoted(bodyText(msg));
  const screen = screenMail({ headers, labelIds: msg.labelIds || [], body }, inbox, account);
  const internal = Number(msg.internalDate) || null;
  const seen = (outcome) => db.prepare(`INSERT OR IGNORE INTO cs_mail_seen (slot, gmail_id, seen_at, outcome, internal_ms) VALUES (?, ?, ?, ?, ?)`).bind(inbox.slot, msg.id, at, outcome, internal).run();
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
Return: {"is_customer":true|false,"category":"...","store":"hc|aub|mar|null","order_number":"digits or null","urgency":"low|normal|high","angry":true|false,"wants_refund":true|false,"no_action":true|false,"summary":"max 20 words","size":{"ordered":null,"wanted":null,"fit":"too_small|too_big|null","product":null,"quote":"the customer's exact words about fit, or null"},"change":{"size_to":null,"colour_to":null,"address":false}}
is_customer is false only for mail that is clearly not from a shopper (vendor pitch, spam, partnership offer).
no_action is true ONLY when the email just thanks or acknowledges (e.g. "thank you", "ok, I'll let you know when it arrives") and asks nothing, requests nothing and reports no problem. Any question, request, complaint or problem means false. When unsure, false.
The summary must not contain names, email addresses, phone numbers or street addresses.
Never invent an order number: null unless it is written in the email.`;

// "#1001" right after one of these is an address or a phone line, not an order.
const ADDRESS_BEFORE = /\b(apt|apartment|unit|suite|ste|room|rm|flat|floor|fl|bldg|building|lot|box|po box|street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd|house|no|number|phone|tel|ext)\.?\s*$/i;

/**
 * The order number a customer wrote. Digits only, or null.
 * - With an order keyword ("order 1234", "order #1234", "order number: 1234", "order no. 1234"): taken.
 * - A bare "#1234" is taken only when the AI read the same number as the order number AND it is
 *   not part of an address ("Apt #1001", "Suite #200").
 * Either way the number is only a lead: orderContext attaches an order only when the sender's
 * email is on it.
 */
export function orderRefFromText(text, aiNumber = null) {
  const s = String(text || "");
  const kw = s.match(/\border\s*(?:number|no\.?|num|id)?\s*(?:is|:)?\s*#?\s*(\d{3,6})\b/i);
  if (kw) return kw[1];
  if (!aiNumber) return null;
  for (const m of s.matchAll(/#\s?(\d{3,6})\b/g)) {
    if (m[1] !== String(aiNumber)) continue;
    const before = s.slice(Math.max(0, m.index - 20), m.index);
    if (!ADDRESS_BEFORE.test(before.trimEnd())) return m[1];
  }
  return null;
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
    // Only a literal true counts; code (noAction.js) still vetoes it on any question or problem.
    no_action: !!(j && j.no_action === true),
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
  // The AI's number alone is never enough: it must be written as an order number in the email.
  const orderRef = orderRefFromText(`${t.subject || ""}\n${t.body || ""}`, v.order_number);
  const urgency = v.category === "chargeback_or_scam_angry" || v.angry ? "high" : v.urgency;
  // A bare thank-you / acknowledgement is closed quietly (noAction.js; code vetoes on any
  // question, request, problem, anger or money word). Not if an earlier email in the same
  // conversation still had something unanswered: this one replaced it, so Reilly must see it.
  let quiet = null;
  if (v.is_customer) {
    const c = noActionCheck({ ...t, category: v.category, summary: v.summary }, v);
    if (c.close && !(await earlierUnansweredAsk(db, t))) quiet = c.reason;
  }
  const status = !v.is_customer ? "ignored" : quiet ? "no_action" : "open";
  await db.prepare(
    `UPDATE cs_tickets SET status = ?, category = ?, urgency = ?, order_ref = ?, summary = ?, triage = ?, store = ?, classified_at = ?, classify_note = ?, updated_at = ? WHERE id = ?`
  ).bind(status, v.category, urgency, orderRef, v.summary, JSON.stringify(v), store, at, quiet ? clip(`no_action: ${quiet}`, 300) : note, at, t.id).run();
  await logEvent(db, {
    actor: ACTOR, kind: !v.is_customer ? "cs.ticket_ignored" : quiet ? "cs.no_action" : "cs.ticket_classified", store, at,
    summary: !v.is_customer
      ? `Not a customer (AI): ticket ${t.id}. Listed on the CS page in case that's wrong.`
      : quiet
        ? `${storeName(store) || "Unknown store"}: ticket ${t.id} closed quietly, nothing to do (${v.summary || clip(t.subject, 80)}). Listed on the CS page under "No action needed".`
        : `${storeName(store) || "Unknown store"}: ${v.category.replace(/_/g, " ")}${orderRef ? ` (#${orderRef})` : ""}${urgency === "high" ? ", URGENT" : ""}: ${v.summary || clip(t.subject, 80)}`,
    data: { ticket: t.id, category: v.category, ...(quiet ? { no_action: quiet } : {}) },
  });
}

