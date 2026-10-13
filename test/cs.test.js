import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { runCs, csState } from "../src/agents/cs/index.js";
import { screenMail } from "../src/agents/cs/filters.js";
import { checkDraft, routeTicket } from "../src/agents/cs/routing.js";
import { findPromises, flagOverdue } from "../src/agents/cs/obligations.js";
import { validateTriage, orderRefFromText } from "../src/agents/cs/triage.js";
import { b64urlEncode, b64urlDecode, stripQuoted } from "../src/agents/cs/gmail.js";

const NOW = Date.parse("2026-10-13T16:00:00Z"); // Tuesday, 12:00 Eastern
const MIN = 60000;
const KEY = "sk-ant-test-key";
const BASE_ENV = {
  APPROVAL_SIGNING_KEY: "k".repeat(48), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_ACCOUNT: "reillyworking26@gmail.com", ANTHROPIC_API_KEY: KEY,
};

async function connect(env, slot, account, refresh) {
  const { enc_token, iv } = await encryptToken(env, refresh);
  await env.DB.prepare(`INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at, verified_at) VALUES (?, ?, 'x', ?, ?, 't', 't')`)
    .bind(slot, account, enc_token, iv).run();
}

let seq = 0;
function mail({ id, threadId, from, to = "info@auberlane.com", subject = "Hello", body = "Hi", at = NOW - 60 * MIN, labels = ["INBOX"], headers = {}, msgId }) {
  seq++;
  const hs = { From: from, To: to, Subject: subject, "Message-ID": msgId || `<m${id}@mail.example>`, ...headers };
  return {
    id, threadId: threadId || `t${id}`, labelIds: labels, internalDate: String(at), snippet: body.slice(0, 50),
    payload: { mimeType: "multipart/alternative", headers: Object.entries(hs).map(([name, value]) => ({ name, value })),
      parts: [{ mimeType: "text/plain", body: { data: b64urlEncode(body) } }] },
  };
}

/** A fake Google + Claude + Shopify. Records every call. */
function world({ boxes = {}, triage = () => ({}), reply = () => ({ body: "" }), retention = () => ({ option: "exchange_size", why: "fits", line: "Would a bigger size help?" }) } = {}) {
  const calls = [];
  const drafts = new Map();
  const tokenFor = { "rt-main": "at-main", "rt-hc": "at-hc" };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, body: init.body });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(init.body);
      return json({ access_token: tokenFor[p.get("refresh_token")], expires_in: 3600 });
    }
    if (u.startsWith("https://gmail.googleapis.com/")) {
      const tok = String((init.headers || {}).authorization || "").replace("Bearer ", "");
      const box = boxes[tok] || { messages: [], threads: {} };
      const path = new URL(u).pathname.replace("/gmail/v1/users/me", "");
      if (method === "GET" && path === "/messages") {
        const q = new URL(u).searchParams.get("q") || "";
        const after = Number((q.match(/after:(\d+)/) || [])[1] || 0) * 1000;
        const list = box.messages.filter((m) => Number(m.internalDate) >= after).sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        return json({ messages: list.map((m) => ({ id: m.id, threadId: m.threadId })) });
      }
      let m;
      if (method === "GET" && (m = path.match(/^\/messages\/(.+)$/))) {
        const msg = box.messages.find((x) => x.id === decodeURIComponent(m[1]));
        return msg ? json(msg) : json({ error: "nf" }, 404);
      }
      if (method === "GET" && (m = path.match(/^\/threads\/(.+)$/))) {
        return json({ id: m[1], messages: (box.threads || {})[decodeURIComponent(m[1])] || [] });
      }
      if (method === "POST" && path === "/drafts") {
        const b = JSON.parse(init.body);
        const id = `d${drafts.size + 1}`;
        drafts.set(id, { threadId: b.message.threadId, raw: b.message.raw, tok });
        return json({ id, message: { id: `dm${id}`, threadId: b.message.threadId } });
      }
      if (method === "GET" && (m = path.match(/^\/drafts\/(.+)$/))) {
        const d = drafts.get(m[1]);
        return d ? json({ id: m[1], message: { threadId: d.threadId } }) : json({}, 404);
      }
      return json({ error: "unexpected" }, 400);
    }
    if (u.startsWith("https://api.anthropic.com/")) {
      const b = JSON.parse(init.body);
      const sys = String(b.system || "");
      const user = String((b.messages && b.messages[0] && b.messages[0].content) || "");
      const out = sys.includes("You sort") ? triage(user) : sys.includes("You write customer-service") ? reply(user) : retention(user);
      return json({ model: b.model, content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 200, output_tokens: 80 }, stop_reason: "end_turn" });
    }
    return json({ error: "no route" }, 404);
  };
  return { fetchImpl, calls, drafts };
}

async function setup(extraEnv = {}) {
  _resetGoogleCacheForTests();
  const DB = makeD1();
  return { ...BASE_ENV, DB, ...extraEnv };
}

async function addOrder(DB, { store = "aub", id = "gid://shopify/Order/1", name = "#1001", email = "jane@buyer.com", express = 0, raw = null } = {}) {
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, currency, total, financial_status, raw, updated_at, express, shipping_title) VALUES (?, ?, ?, ?, ?, 'USD', 59.9, 'paid', ?, ?, ?, ?)`)
    .bind(store, id, name, "2026-10-05T15:00:00Z", "2026-10-05", raw || JSON.stringify({ email, fulfillment_status: "fulfilled" }), "2026-10-12T00:00:00Z", express, express ? "Express" : "Standard").run();
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, product_id, title, variant_title, size, color, quantity, price, updated_at) VALUES (?, ?, ?, 'gid://shopify/Product/77', 'Wool Overshirt', 'Navy / M', 'M', 'Navy', 1, 59.9, 't')`)
    .bind(store, id, `${id}-l1`).run();
}

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ?`).bind(kind).all()).results;
const tickets = async (DB) => (await DB.prepare(`SELECT * FROM cs_tickets ORDER BY id`).all()).results;

/* ---------- pure logic ---------- */

test("cs filters: reviews, marketing, Shopify notices and other mail are not customers; stores found by address or contact-form name", () => {
  const main = { slot: "google", stores: ["aub", "mar", "hc"], own: false };
  const H = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(screenMail({ headers: H({ From: "Judge.me <no-reply@judge.me>", To: "info@auberlane.com", Subject: "New 2 star review" }) }, main).keep, false);
  assert.equal(screenMail({ headers: H({ From: "Shop <news@brand.com>", To: "info@auberlane.com", Subject: "Sale", "List-Unsubscribe": "<x>" }) }, main).keep, false);
  assert.equal(screenMail({ headers: H({ From: "Shopify <mailer@shopify.com>", To: "reilly", Subject: "[Auberlane] Order #1001 placed" }) }, main).keep, false);
  assert.equal(screenMail({ headers: H({ From: "Friend <pal@gmail.com>", To: "reillyworking26@gmail.com", Subject: "lunch?" }) }, main).reason, "not addressed to a store");
  const a = screenMail({ headers: H({ From: "Jane <jane@buyer.com>", To: "info@auberlane.com", Subject: "my order" }) }, main);
  assert.deepEqual([a.keep, a.store, a.replyTo], [true, "aub", "jane@buyer.com"]);
  const cf = screenMail({ headers: H({ From: "Shopify <mailer@shopify.com>", "Reply-To": "Bob <bob@x.com>", To: "reillyworking26@gmail.com", Subject: "New customer message on October 12" }), body: "You received a new message from your online store's contact form. Marlowe Standard\nName: Bob" }, main);
  assert.deepEqual([cf.keep, cf.store, cf.via, cf.replyTo], [true, "mar", "contact_form", "bob@x.com"]);
  // H&C has its own inbox connected: its mail in the main inbox is left to that inbox.
  const mainNoHc = { slot: "google", stores: ["aub", "mar"], own: false };
  assert.equal(screenMail({ headers: H({ From: "Jane <jane@buyer.com>", To: "info@holtandcrane.com" }) }, mainNoHc).keep, false);
  // A store's own inbox: everything that passes the filters is that store's.
  const own = screenMail({ headers: H({ From: "Jane <jane@buyer.com>", To: "info@holtandcrane.com" }) }, { slot: "google:hc", stores: ["hc"], own: true }, "info@holtandcrane.com");
  assert.deepEqual([own.keep, own.store], [true, "hc"]);
});

test("cs triage validation: unknown categories become other, invented quotes dropped, order numbers digits only", () => {
  const v = validateTriage({ category: "refund_now", store: "zzz", order_number: "#1234", size: { quote: "made up words" } }, "it is too small");
  assert.equal(v.category, "other");
  assert.equal(v.store, null);
  assert.equal(v.order_number, "1234");
  assert.equal(v.size.quote, null);
  assert.equal(orderRefFromText("Hi, order #1043 hasn't arrived"), "1043");
  assert.equal(orderRefFromText("order number: 1077"), "1077");
  assert.equal(orderRefFromText("I am 5 foot 10"), null);
  assert.equal(stripQuoted("Thanks!\n\nOn Mon, Oct 12, 2026 at 9:00 AM Shop <a@b.com> wrote:\n> old"), "Thanks!");
  assert.equal(b64urlDecode(b64urlEncode("héllo ✓")), "héllo ✓");
});

test("cs draft check: refunds, reships, dates, foreign order/tracking numbers and placeholders are blocked", () => {
  const ctx = { name: "#1001", shipments: [{ tracking_number: "YT2512345678901" }] };
  assert.deepEqual(checkDraft("Hi Jane, your order #1001 shipped. Tracking: YT2512345678901. Best, Auberlane Customer Care", { ctx }), []);
  assert.ok(checkDraft("Hi Jane, we'll issue a full refund today. Best, Auberlane", { ctx }).some((p) => p.includes("refund")));
  assert.ok(checkDraft("Hi Jane, we will send you a replacement right away. Best", { ctx }).some((p) => p.includes("reship")));
  assert.ok(checkDraft("Hi Jane, it will arrive by Friday, guaranteed. Best", { ctx }).some((p) => p.includes("date")));
  assert.ok(checkDraft("Hi Jane, your tracking number is LX999888777CN. Best regards", { ctx }).some((p) => p.includes("tracking")));
  assert.ok(checkDraft("Hi Jane, about order #2002, it's on the way. Best regards", { ctx }).some((p) => p.includes("#2002")));
  assert.ok(checkDraft("Hi [Customer Name], it's on the way. Best regards", { ctx }).some((p) => p.includes("placeholder")));
  // Routing: money and anger are Reilly's.
  assert.equal(routeTicket({ category: "return_refund" }, {}, null).action, "escalate");
  assert.equal(routeTicket({ category: "where_is_order" }, { angry: true }, null).action, "escalate");
  assert.equal(routeTicket({ category: "exchange" }, {}, { shipped: false }).action, "draft");
  assert.equal(routeTicket({ category: "exchange" }, {}, { shipped: true }).action, "escalate");
  assert.equal(routeTicket({ category: "where_is_order" }, {}, null).action, "draft");
});

test("cs promises: dated promises found by code, vague ones not guessed", () => {
  const p = findPromises("Thanks Jane. We'll update you by Friday once KFB confirms. Have a nice day.", NOW);
  assert.deepEqual(p.map((x) => x.due_day), ["2026-10-16"]);
  assert.deepEqual(findPromises("I'll get back to you within 2 business days.", NOW).map((x) => x.due_day), ["2026-10-15"]);
  assert.deepEqual(findPromises("We will email you tomorrow.", NOW).map((x) => x.due_day), ["2026-10-14"]);
  assert.deepEqual(findPromises("We'll be in touch soon.", NOW), []);
  assert.deepEqual(findPromises("Your parcel left on Friday.", NOW), []);
});

/* ---------- agents end to end (all network faked) ---------- */

test("cs: nothing connected → not wired, said once, no Gmail calls, never zero tickets claimed as 'read'", async () => {
  const env = await setup();
  const w = world();
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: w.fetchImpl });
  assert.equal(w.calls.filter((c) => c.url.includes("gmail")).length, 0);
  const inbox = await env.DB.prepare(`SELECT * FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.match(inbox.last_error, /not wired/);
  assert.equal(inbox.last_ok_at, null);
  assert.equal((await evs(env.DB, "cs.inbox_not_wired")).length, 1);
  const st = await csState(env, { nowMs: NOW });
  assert.equal(st.inboxes[0].wired, false);
  assert.equal(st.last_read_at, null);
  assert.ok(st.not_wired.length >= 1);
});

test("cs: main inbox → customer ticket, order matched, reply drafted in D1 only (shadow), reviews/marketing ignored, each email read once", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  await env.DB.prepare(`INSERT INTO shipments (store, order_id, order_name, tracking_number, tracking_url, carrier_hint, shipped_at, shopify_status, updated_at) VALUES ('aub', 'gid://shopify/Order/1', '#1001', 'YT2512345678901', 'https://t.example/YT2512345678901', 'YunExpress', '2026-10-08T00:00:00Z', 'IN_TRANSIT', 't')`).run();
  const boxes = { "at-main": { messages: [
    mail({ id: "a1", from: "Jane Doe <jane@buyer.com>", subject: "Where is my order #1001?", body: "Hi, where is my order #1001? Thanks, Jane" }),
    mail({ id: "a2", from: "Judge.me <no-reply@judge.me>", subject: "New 1 star review", body: "A customer left a review" }),
    mail({ id: "a3", from: "Deals <deals@shopnews.com>", subject: "50% off", headers: { "List-Unsubscribe": "<mailto:x>" } }),
    mail({ id: "a4", from: "Old <old@buyer.com>", subject: "old", at: NOW - 10 * 86400000 }), // older than the first-read window
  ] } };
  let replyPrompt = "";
  const w = world({
    boxes,
    triage: () => ({ is_customer: true, category: "where_is_order", store: "aub", order_number: "1001", urgency: "normal", summary: "Asks where order #1001 is" }),
    reply: (user) => { replyPrompt = user; return { body: "Hi Jane,\n\nYour order #1001 shipped on Oct 8 with YunExpress. Tracking: YT2512345678901 (https://t.example/YT2512345678901). Standard delivery usually takes 8-12 business days.\n\nAuberlane Customer Care", needs_reilly: false }; },
  });
  const out = await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.ok(!out.read.error, JSON.stringify(out));
  const ts = await tickets(env.DB);
  assert.equal(ts.length, 1);
  const t = ts[0];
  assert.equal(t.store, "aub");
  assert.equal(t.category, "where_is_order");
  assert.equal(t.order_name, "#1001");
  assert.equal(t.status, "drafted");
  assert.equal(t.draft_status, "stored");
  assert.match(t.draft_body, /YT2512345678901/);
  assert.match(replyPrompt, /YT2512345678901/); // the tracking number came from code, not the model
  // Shadow: no Gmail write of any kind.
  assert.equal(w.calls.filter((c) => c.url.includes("gmail") && c.method !== "GET").length, 0);
  assert.equal(w.drafts.size, 0);
  // The 10-day-old email is outside the first read window.
  assert.ok(!w.calls.some((c) => c.url.endsWith("/messages/a4?format=full")));
  const seen = (await env.DB.prepare(`SELECT gmail_id, outcome FROM cs_mail_seen ORDER BY gmail_id`).all()).results;
  assert.deepEqual(seen.map((s) => s.outcome.split(" ")[0]), ["ticket", "ignored:review", "ignored:marketing"]);

  // Next tick: nothing is fetched twice.
  const gets = w.calls.filter((c) => /\/messages\/a\d/.test(c.url)).length;
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: w.fetchImpl });
  assert.equal(w.calls.filter((c) => /\/messages\/a\d/.test(c.url)).length, gets);
  assert.equal((await tickets(env.DB)).length, 1);

  const st = await csState(env, { nowMs: NOW + 15 * MIN });
  assert.equal(st.mode, "shadow");
  assert.equal(st.drafts_to_gmail, false);
  assert.equal(st.drafts[0].draft_body, t.draft_body);
  assert.equal(st.open_by_category.where_is_order.byStore.aub, 1);
  assert.ok(st.last_read_at);
});

test("cs: throttled — a second run in the same tick does nothing", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const w = world({ boxes: { "at-main": { messages: [] } } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const n = w.calls.length;
  const again = await runCs(env, { nowMs: NOW + 60000, fetchImpl: w.fetchImpl });
  assert.equal(w.calls.length, n);
  assert.equal(again.read, undefined);
});

test("cs: angry/chargeback → one flag for Reilly per conversation (no reply drafted, no duplicates)", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const box = { messages: [mail({ id: "b1", threadId: "T1", from: "Jane <jane@buyer.com>", subject: "SCAM", body: "This is a scam, I'm filing a chargeback for #1001" })] };
  const w = world({ boxes: { "at-main": box }, triage: (u) => u.includes("Still waiting")
    ? { category: "where_is_order", summary: "Asks for an update" } // a plain follow-up: still Reilly's conversation
    : { category: "chargeback_or_scam_angry", angry: true, summary: "Threatens chargeback on #1001" } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  let ap = (await env.DB.prepare(`SELECT * FROM approvals`).all()).results;
  assert.equal(ap.length, 1);
  assert.equal(ap[0].dept, "cs");
  assert.equal(ap[0].requested_by, "cs.escalation");
  assert.ok(!w.calls.some((c) => c.url.includes("anthropic") && String(c.body).includes("You write customer-service")));
  // Customer writes again in the same thread → joins the existing flag.
  box.messages.push(mail({ id: "b2", threadId: "T1", from: "Jane <jane@buyer.com>", subject: "Re: SCAM", body: "Still waiting!!", at: NOW + 10 * MIN }));
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: w.fetchImpl });
  await runCs(env, { nowMs: NOW + 30 * MIN, fetchImpl: w.fetchImpl });
  ap = (await env.DB.prepare(`SELECT * FROM approvals`).all()).results;
  assert.equal(ap.length, 1);
  const ts = await tickets(env.DB);
  assert.deepEqual(ts.map((t) => t.approval_id), [ap[0].id, ap[0].id]);
  assert.equal((await evs(env.DB, "cs.escalation_joined")).length, 1);
  assert.ok(!w.calls.some((c) => c.url.includes("anthropic") && String(c.body).includes("You write customer-service")));
  assert.equal(ts[1].draft_body, null);
});

test("cs: a draft that promises a refund is not used; the ticket goes to Reilly instead", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const w = world({
    boxes: { "at-main": { messages: [mail({ id: "c1", from: "Jane <jane@buyer.com>", subject: "order", body: "Where is #1001?" })] } },
    triage: () => ({ category: "where_is_order", summary: "Where is 1001" }),
    reply: () => ({ body: "Hi Jane, sorry for the wait, we'll refund your order in full today. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  let t = (await tickets(env.DB))[0];
  assert.equal(t.draft_status, "blocked");
  assert.match(t.draft_note, /refund/);
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: w.fetchImpl });
  t = (await tickets(env.DB))[0];
  assert.equal(t.status, "needs_reilly");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 1);
});

test("cs: CS_DRAFTS_LIVE=1 → threaded Gmail DRAFT in the store's own inbox, read back; never a send", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google:hc", "info@holtandcrane.com", "rt-hc");
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, { store: "hc", name: "#2001", id: "gid://shopify/Order/9" });
  const w = world({
    boxes: { "at-hc": { messages: [mail({ id: "h1", threadId: "TH", to: "info@holtandcrane.com", from: "Jane <jane@buyer.com>", subject: "Size?", body: "Is the overshirt true to size? Order #2001", msgId: "<abc@buyer.com>" })] }, "at-main": { messages: [] } },
    triage: () => ({ category: "size_question", summary: "Asks about sizing" }),
    reply: () => ({ body: "Hi Jane,\n\nGood question. I'll check the measurements for your overshirt and get back to you.\n\nHolt & Crane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  assert.equal(t.slot, "google:hc");
  assert.equal(t.draft_status, "gmail_draft");
  assert.equal(w.drafts.size, 1);
  const d = [...w.drafts.values()][0];
  assert.equal(d.tok, "at-hc"); // written in the inbox the customer wrote to
  assert.equal(d.threadId, "TH");
  const raw = b64urlDecode(d.raw);
  assert.match(raw, /In-Reply-To: <abc@buyer.com>/);
  assert.match(raw, /To: jane@buyer.com/);
  assert.match(raw, /Subject: Re: Size\?/);
  // Only drafts endpoints were written to; nothing like messages/send.
  const writes = w.calls.filter((c) => c.url.includes("gmail") && c.method === "POST");
  assert.deepEqual(writes.map((c) => new URL(c.url).pathname), ["/gmail/v1/users/me/drafts"]);
});

test("cs: Gmail draft refused when the inbox is connected as the wrong account (Store Guard for Gmail)", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1", GOOGLE_ACCOUNT: "someone-else@gmail.com" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const w = world({
    boxes: { "at-main": { messages: [mail({ id: "g1", from: "Jane <jane@buyer.com>", subject: "q", body: "Is the coat warm?" })] } },
    triage: () => ({ category: "product_question", summary: "Asks about warmth" }),
    reply: () => ({ body: "Hi Jane, it's a heavy wool blend and very warm. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 0);
  assert.equal((await evs(env.DB, "cs.draft_guard_stop")).length, 1);
  assert.equal((await tickets(env.DB))[0].draft_status, "stored");
});

test("cs: size complaint → complaint log (product + customer's words) and KFB asks for changes", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  await addOrder(env.DB, { id: "gid://shopify/Order/2", name: "#1002", email: "sam@buyer.com", raw: JSON.stringify({ email: "sam@buyer.com" }) });
  const w = world({
    boxes: { "at-main": { messages: [
      mail({ id: "s1", from: "Jane <jane@buyer.com>", subject: "too small", body: "The overshirt runs way too small, the M is tight. I'd need an L." }),
      mail({ id: "s2", from: "Sam <sam@buyer.com>", subject: "change", body: "Can you change my order to size L please? I ordered M.", at: NOW - 30 * MIN }),
    ] } },
    triage: (u) => u.includes("too small")
      ? { category: "size_complaint", summary: "M too small", size: { ordered: "M", wanted: "L", fit: "too_small", quote: "the M is tight" } }
      : { category: "size_question", summary: "Change M to L", size: { ordered: "M" }, change: { size_to: "L" } },
    reply: () => ({ body: "Hi Sam, thanks, I've passed your request to change to size L on to our warehouse and will confirm once it's updated. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const sc = (await env.DB.prepare(`SELECT * FROM size_complaints`).all()).results;
  assert.equal(sc.length, 1);
  assert.equal(sc[0].product_id, "gid://shopify/Product/77");
  assert.equal(sc[0].size_ordered, "M");
  assert.equal(sc[0].size_that_fits, "L");
  assert.equal(sc[0].said, "the M is tight");
  assert.equal(sc[0].source, "gmail:s1");
  const asks = (await env.DB.prepare(`SELECT * FROM cs_kfb_asks`).all()).results;
  assert.equal(asks.length, 1);
  assert.equal(asks[0].kind, "size");
  assert.equal(asks[0].order_name, "#1002");
  assert.match(asks[0].detail, /M → L/);
  // Rerun: no duplicates.
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: w.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM size_complaints`).first()).n, 1);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cs_kfb_asks`).first()).n, 1);
  // The size complaint itself goes to Reilly (exchange/return is his call).
  assert.equal((await tickets(env.DB)).find((t) => t.gmail_id === "s1").status, "needs_reilly");
});

test("cs: no AI key → mail is still read and stored, but waits for AI; nothing drafted or flagged", async () => {
  const env = await setup({ ANTHROPIC_API_KEY: undefined });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const w = world({ boxes: { "at-main": { messages: [mail({ id: "n1", from: "Jane <jane@buyer.com>", subject: "q", body: "hello" })] } } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  assert.equal(t.status, "new");
  assert.match(t.classify_note, /waiting on AI/);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 0);
  const st = await csState(env, { nowMs: NOW });
  assert.equal(st.unsorted.count, 1);
  assert.ok(st.not_wired.some((x) => x.includes("ANTHROPIC_API_KEY")));
});

test("cs retention: cancel → a suggestion from the fixed list, stored on the ticket and in the flag; never sent", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const w = world({
    boxes: { "at-main": { messages: [mail({ id: "r1", from: "Jane <jane@buyer.com>", subject: "cancel", body: "Please cancel order #1001" })] } },
    triage: () => ({ category: "cancel", summary: "Wants to cancel #1001" }),
    retention: () => ({ option: "keep_shipping", why: "already shipped", line: "Your order is already on its way." }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  assert.equal(JSON.parse(t.retention).key, "keep_shipping");
  const ap = await env.DB.prepare(`SELECT options FROM approvals`).first();
  assert.match(ap.options, /Retention idea/);
  assert.equal((await env.DB.prepare(`SELECT kind FROM cs_kfb_asks`).first()).kind, "cancel");
  assert.equal(w.drafts.size, 0);
});

test("cs obligations: Reilly's sent reply with a dated promise is recorded, flagged once when overdue, closed by a later reply", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const cust = mail({ id: "o1", threadId: "TO", from: "Jane <jane@buyer.com>", subject: "colour", body: "Can I change the colour to black on #1001?" });
  const box = { messages: [cust], threads: { TO: [cust] } };
  const w = world({
    boxes: { "at-main": box },
    triage: () => ({ category: "colour_change", summary: "Wants black", change: { colour_to: "black" } }),
    reply: () => ({ body: "Hi Jane, I've passed your colour change request on and will confirm once it's updated. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT kind FROM cs_kfb_asks`).first()).kind, "colour");
  // Reilly sends a reply with a promise.
  const sent = mail({ id: "o2", threadId: "TO", from: "Reilly <reillyworking26@gmail.com>", labels: ["SENT"], body: "Hi Jane, we'll update you by Friday once the warehouse confirms.", at: NOW + 20 * MIN });
  box.threads.TO = [cust, sent];
  await runCs(env, { nowMs: NOW + 3 * 60 * MIN, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  assert.equal(t.status, "replied");
  const ob = (await env.DB.prepare(`SELECT * FROM obligations`).all()).results;
  assert.equal(ob.length, 1);
  assert.equal(ob[0].kind, "reply");
  assert.equal(ob[0].party, "jane@buyer.com");
  assert.equal(ob[0].due_at.slice(0, 10), "2026-10-17"); // end of Friday Eastern = early Saturday UTC
  // Saturday: overdue, flagged once.
  const SAT = Date.parse("2026-10-17T15:00:00Z");
  await flagOverdue(env, { nowMs: SAT });
  await flagOverdue(env, { nowMs: SAT + 3600000 });
  assert.equal((await evs(env.DB, "cs.obligation_overdue")).length, 1);
  const st = await csState(env, { nowMs: SAT });
  assert.equal(st.obligations_due.length, 1);
  assert.equal(st.obligations_due[0].overdue, true);
  // A later sent reply closes it.
  box.threads.TO = [cust, sent, mail({ id: "o3", threadId: "TO", from: "Reilly <reillyworking26@gmail.com>", labels: ["SENT"], body: "All done, it's now black.", at: SAT })];
  await runCs(env, { nowMs: SAT + 2 * 3600000, fetchImpl: w.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT status FROM obligations`).first()).status, "done");
});

test("cs: a Gmail fault is logged (at most hourly) and runCs never throws", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const broken = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at-main", expires_in: 3600 }), { status: 200 });
    return new Response("boom", { status: 500 });
  };
  const out = await runCs(env, { nowMs: NOW, fetchImpl: broken });
  assert.ok(out.read[0].error);
  await runCs(env, { nowMs: NOW + 15 * MIN, fetchImpl: broken });
  assert.equal((await evs(env.DB, "error.cs_read")).length, 1);
  const inbox = await env.DB.prepare(`SELECT * FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.match(inbox.last_error, /HTTP 500/);
});
