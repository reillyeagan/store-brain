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
import { findLedgerOrder } from "../src/agents/cs/orderContext.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";

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
function world({ boxes = {}, triage = () => ({}), reply = () => ({ body: "" }), retention = () => ({ option: "exchange_size", why: "fits", line: "Would a bigger size help?" }), pageCap = 500, failGet = new Set(), shopify = null } = {}) {
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
        // Like Gmail: newest first, honours maxResults (capped) and pageToken.
        const sp = new URL(u).searchParams;
        const q = sp.get("q") || "";
        const after = Number((q.match(/after:(\d+)/) || [])[1] || 0) * 1000;
        const per = Math.min(Number(sp.get("maxResults") || 100), pageCap);
        const from = Number(sp.get("pageToken") || 0);
        const list = box.messages.filter((m) => Number(m.internalDate) >= after && !(m.labelIds || []).includes("SENT"))
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        const page = list.slice(from, from + per);
        return json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(from + per < list.length ? { nextPageToken: String(from + per) } : {}) });
      }
      let m;
      if (method === "GET" && (m = path.match(/^\/messages\/(.+)$/))) {
        if (failGet.has(decodeURIComponent(m[1]))) return json({ error: "boom" }, 500);
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
    if (u.includes(".myshopify.com/admin/oauth/access_token")) return json({ access_token: "shp-tok", expires_in: 86399, scope: "read_orders" });
    if (u.includes(".myshopify.com/admin/api/") && shopify) {
      const b = JSON.parse(init.body);
      return json({ data: { orders: { nodes: shopify(b.variables.q) } } });
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

async function addOrder(DB, { store = "aub", id = "gid://shopify/Order/1", name = "#1001", email = "jane@buyer.com", express = 0, raw = null, updatedAt = new Date(NOW - 30 * 60000).toISOString(), shippingTitle } = {}) {
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, currency, total, financial_status, raw, updated_at, express, shipping_title) VALUES (?, ?, ?, ?, ?, 'USD', 59.9, 'paid', ?, ?, ?, ?)`)
    .bind(store, id, name, "2026-10-05T15:00:00Z", "2026-10-05", raw || JSON.stringify({ email, fulfillment_status: "fulfilled" }), updatedAt, express, shippingTitle !== undefined ? shippingTitle : express ? "Express" : "Standard").run();
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
  assert.equal(orderRefFromText("My order is 1055"), "1055");
  assert.equal(orderRefFromText("I am 5 foot 10"), null);
  assert.equal(stripQuoted("Thanks!\n\nOn Mon, Oct 12, 2026 at 9:00 AM Shop <a@b.com> wrote:\n> old"), "Thanks!");
  assert.equal(b64urlDecode(b64urlEncode("héllo ✓")), "héllo ✓");
});

test("cs order numbers: addresses are never order numbers; a bare #number needs the AI to agree", () => {
  assert.equal(orderRefFromText("Please send it to 12 Main St, Apt #1001 instead"), null);
  assert.equal(orderRefFromText("Please send it to 12 Main St, Apt #1001 instead", "1001"), null);
  assert.equal(orderRefFromText("Suite #200, Boston", "200"), null);
  assert.equal(orderRefFromText("Where is #1043?"), null); // bare number, AI didn't say so
  assert.equal(orderRefFromText("Where is #1043?", "1043"), "1043");
  assert.equal(orderRefFromText("Where is #1043?", "1099"), null); // AI and text disagree
});

test("cs draft check: keyword-strict — every unsafe phrase is blocked, a plain tracking reply passes", () => {
  const ctx = { name: "#1001", shipments: [{ tracking_number: "YT2512345678901", tracking_url: "https://t.example/YT2512345678901" }] };
  const ok = "Hi Jane, your order #1001 is on its way. Tracking: YT2512345678901 (https://t.example/YT2512345678901). Standard delivery usually takes 8-12 business days. Feel free to reply with any questions. Auberlane Customer Care";
  assert.deepEqual(checkDraft(ok, { ctx }), []);
  assert.deepEqual(checkDraft("Hi Sam, it's 100% wool with a chest of 104 cm in size M. Auberlane Customer Care", { ctx }), []);
  const unsafe = [
    "I've refunded your order.",
    "A refund is on its way.",
    "Your money will be back in your account soon.",
    "We'll replace it for you.",
    "We can ship you another one free of charge.",
    "Here is a discount code for your next order.",
    "Enjoy 15% off your next order.",
    "We'll add store credit to your account.",
    "No need to send it back, just keep it.",
    "You'll have it by Friday.",
    "It should arrive on Oct 20.",
    "Expect delivery on October 20th.",
    "Your parcel is due 10/20.",
    "We'll resend the parcel.",
    "Your order 2002 is on the way.",
    "About order #2002, it's on the way.",
    "Tracking: YT25 9999 8888 777.",
    "Your tracking number is LX999888777CN.",
    "Track it here: https://evil.example/track",
    "Hi [Customer Name], it's on the way.",
    "We'll reimburse the shipping.",
    "We'd like to compensate you.",
  ];
  for (const phrase of unsafe) {
    const p = checkDraft(`Hi Jane, thanks for writing. ${phrase} Auberlane Customer Care`, { ctx });
    assert.ok(p.length > 0, `should block: ${phrase}`);
  }
  // Routing: money, anger and someone else's order number are Reilly's.
  assert.equal(routeTicket({ category: "return_refund" }, {}, null).action, "escalate");
  assert.equal(routeTicket({ category: "where_is_order" }, { angry: true }, null).action, "escalate");
  assert.equal(routeTicket({ category: "where_is_order", order_mismatch: 1, order_ref: "1001" }, {}, null).action, "escalate");
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
    reply: (user) => { replyPrompt = user; return { body: "Hi Jane,\n\nYour order #1001 has shipped with YunExpress. Tracking: YT2512345678901 (https://t.example/YT2512345678901). Standard delivery usually takes 8-12 business days.\n\nAuberlane Customer Care", needs_reilly: false }; },
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

  await noEmailsInEvents(env.DB, "jane@buyer.com");
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

/* ---------- review fixes (2026-10-13) ---------- */

const AUB_CREDS = { SB_AUB_CLIENT_ID: "aub-id", SB_AUB_CLIENT_SECRET: "aub-secret" };
const noEmailsInEvents = async (DB, ...emails) => {
  const all = JSON.stringify((await DB.prepare(`SELECT summary FROM events`).all()).results);
  for (const e of emails) assert.ok(!all.includes(e), `event log must not contain ${e}`);
};

test("cs privacy: an order number that belongs to a different email is never attached, never sent to KFB, and goes to Reilly", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {}); // #1001 belongs to jane@buyer.com
  let replyCalled = false;
  const w = world({
    boxes: { "at-main": { messages: [mail({ id: "p1", from: "Mallory <mallory@else.com>", subject: "order", body: "Please change the colour on order #1001 to black." })] } },
    triage: () => ({ category: "colour_change", order_number: "1001", summary: "Wants colour change", change: { colour_to: "black" } }),
    reply: () => { replyCalled = true; return { body: "x" }; },
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  assert.equal(t.order_ref, "1001");
  assert.equal(t.order_id, null);
  assert.equal(t.context, null);
  assert.equal(t.order_mismatch, 1);
  assert.match(t.context_note, /belongs to a different email/);
  assert.equal(replyCalled, false);
  assert.equal(t.status, "needs_reilly");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cs_kfb_asks`).first()).n, 0);
  const ap = await env.DB.prepare(`SELECT title, options FROM approvals`).first();
  assert.match(ap.options, /different email/);
  assert.ok(!ap.options.includes("jane@buyer.com") && !ap.title.includes("mallory"));
  await noEmailsInEvents(env.DB, "jane@buyer.com", "mallory@else.com");
});

test("cs privacy: an address line is not an order number, and a Shopify match under another email is refused", async () => {
  const env = await setup(AUB_CREDS);
  _resetTokenCacheForTests();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {}); // #1001 (jane)
  const w = world({
    boxes: { "at-main": { messages: [
      mail({ id: "q1", from: "Sam <sam@buyer.com>", subject: "address", body: "Please ship to 4 Elm Rd, Apt #1001 instead." }),
      mail({ id: "q2", from: "Tom <tom@buyer.com>", subject: "where", body: "Where is my order #1500?", at: NOW - 30 * MIN }),
    ] } },
    triage: (u) => u.includes("Apt") ? { category: "address_change", order_number: "1001", summary: "New address", change: { address: true } } : { category: "where_is_order", order_number: "1500", summary: "Where is it" },
    shopify: (q) => q === "name:#1500" ? [{ id: "gid://shopify/Order/15", name: "#1500", email: "someone@else.com", displayFulfillmentStatus: "FULFILLED", fulfillments: [], lineItems: { nodes: [] } }] : [],
    reply: () => ({ body: "Hi Sam, thanks. Could you send your order number so we can pass this on? Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const [sam, tom] = await tickets(env.DB);
  assert.equal(sam.order_ref, null); // "Apt #1001" is an address
  assert.equal(sam.order_id, null);
  assert.equal(tom.order_id, null);
  assert.equal(tom.order_mismatch, 1);
  assert.equal(tom.status, "needs_reilly");
  const asks = (await env.DB.prepare(`SELECT * FROM cs_kfb_asks`).all()).results;
  assert.ok(asks.every((a) => a.order_id === null));
});

test("cs backlog: 65 new emails over several pages are all read exactly once, oldest first; the cursor never skips unread mail", async () => {
  const env = await setup({ ANTHROPIC_API_KEY: undefined });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const msgs = [];
  for (let i = 0; i < 65; i++) msgs.push(mail({ id: `x${String(i).padStart(2, "0")}`, from: `C${i} <c${i}@buyer.com>`, subject: `q${i}`, body: "hello", at: NOW - (70 - i) * MIN }));
  const w = world({ boxes: { "at-main": { messages: msgs } }, pageCap: 25 });
  let t = NOW;
  await runCs(env, { nowMs: t, fetchImpl: w.fetchImpl });
  // First run read the 6 OLDEST; the cursor hasn't moved past anything unread.
  const first = (await tickets(env.DB)).map((x) => x.gmail_id);
  assert.deepEqual(first, ["x00", "x01", "x02", "x03", "x04", "x05"]);
  const inbox = await env.DB.prepare(`SELECT cursor_ms FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.ok(inbox.cursor_ms <= NOW - 70 * MIN);
  // The list followed nextPageToken (25 per page here).
  assert.ok(w.calls.some((c) => c.url.includes("pageToken=25")));
  for (let i = 0; i < 15; i++) { t += 20 * MIN; await runCs(env, { nowMs: t, fetchImpl: w.fetchImpl }); }
  const ids = (await tickets(env.DB)).map((x) => x.gmail_id);
  assert.equal(ids.length, 65);
  assert.equal(new Set(ids).size, 65);
  const gets = w.calls.filter((c) => /\/messages\/x\d\d\?/.test(c.url)).map((c) => c.url);
  assert.equal(gets.length, 65); // each email fetched once
  const after = await env.DB.prepare(`SELECT cursor_ms FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.equal(after.cursor_ms, NOW - 6 * MIN); // newest email read
  // The main inbox search is narrowed to the stores it serves + Shopify, and includes archived mail.
  const q = decodeURIComponent(w.calls.find((c) => c.url.includes("/messages?")).url);
  assert.match(q, /to:auberlane\.com/);
  assert.match(q, /from:shopify\.com/);
  assert.ok(!q.includes("in:inbox"));
});

test("cs: one unreadable email doesn't block the inbox; after 3 tries it is skipped and logged", async () => {
  const env = await setup({ ANTHROPIC_API_KEY: undefined });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const msgs = [
    mail({ id: "bad", from: "A <a@buyer.com>", subject: "a", at: NOW - 50 * MIN }),
    mail({ id: "ok1", from: "B <b@buyer.com>", subject: "b", at: NOW - 40 * MIN }),
  ];
  const box = { messages: msgs };
  const w = world({ boxes: { "at-main": box }, failGet: new Set(["bad"]) });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.deepEqual((await tickets(env.DB)).map((t) => t.gmail_id), ["ok1"]);
  box.messages.push(mail({ id: "ok2", from: "C <c@buyer.com>", subject: "c", at: NOW + 5 * MIN }));
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  await runCs(env, { nowMs: NOW + 40 * MIN, fetchImpl: w.fetchImpl });
  assert.deepEqual((await tickets(env.DB)).map((t) => t.gmail_id), ["ok1", "ok2"]);
  assert.equal((await evs(env.DB, "error.cs_mail_unreadable")).length, 1);
  assert.match((await env.DB.prepare(`SELECT outcome FROM cs_mail_seen WHERE gmail_id = 'bad'`).first()).outcome, /^error:/);
  const inbox = await env.DB.prepare(`SELECT cursor_ms FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.equal(inbox.cursor_ms, NOW + 5 * MIN);
});

test("cs escalation: if creating the approval fails, the claim is released and the next run flags it", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  let failNext = true;
  const real = env.DB;
  env.DB = { ...real, prepare: (sql) => {
    if (failNext && /INSERT INTO approvals/.test(sql)) { failNext = false; throw new Error("D1 hiccup"); }
    return real.prepare(sql);
  } };
  const w = world({
    boxes: { "at-main": { messages: [mail({ id: "e1", from: "Jane <jane@buyer.com>", subject: "refund", body: "I want a refund for order #1001" })] } },
    triage: () => ({ category: "return_refund", wants_refund: true, summary: "Wants refund" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  let t = (await tickets(real))[0];
  assert.equal(t.escalated_at, null);
  assert.equal(t.approval_id, null);
  assert.equal(t.status, "open");
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  t = (await tickets(real))[0];
  assert.ok(t.approval_id > 0);
  assert.equal(t.status, "needs_reilly");
  assert.equal((await real.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 1);
});

test("cs: customer writes again after a Gmail draft was made → no second draft; Reilly told to delete the stale one", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const box = { messages: [mail({ id: "d1", threadId: "TD", from: "Jane <jane@buyer.com>", subject: "q", body: "Is the overshirt warm? My order #1001" })] };
  const w = world({
    boxes: { "at-main": box },
    triage: () => ({ category: "product_question", summary: "Asks about warmth" }),
    reply: () => ({ body: "Hi Jane, yes, it's a heavy wool blend and very warm. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 1);
  box.messages.push(mail({ id: "d2", threadId: "TD", from: "Jane <jane@buyer.com>", subject: "Re: q", body: "Also, is it itchy?", at: NOW + 10 * MIN }));
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  await runCs(env, { nowMs: NOW + 40 * MIN, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 1); // never a second draft in the thread
  const [old, neu] = await tickets(env.DB);
  assert.equal(old.status, "superseded");
  assert.equal(neu.status, "needs_reilly");
  const ap = await env.DB.prepare(`SELECT options FROM approvals`).first();
  assert.match(ap.options, /stale reply draft in Gmail/);
  const st = await csState(env, { nowMs: NOW + 40 * MIN });
  assert.equal(st.stale_gmail_drafts.length, 1);
  assert.match(st.stale_gmail_drafts[0].note, /delete it/);
});

test("cs: a stored draft whose Gmail copy wasn't made is retried on a later run (CS_DRAFTS_LIVE=1)", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await env.DB.prepare(`INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, thread_id, rfc_message_id, store, from_email, subject, body, via, status, category, draft_body, draft_status, draft_at, context_at)
    VALUES ('t','t','google','r1','TR','<r1@x>','aub','jane@buyer.com','q','hi','email','drafted','product_question','Hi Jane, it is warm. Auberlane Customer Care','stored','t','t')`).run();
  const w = world({ boxes: { "at-main": { messages: [] } } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 1);
  const t = (await tickets(env.DB))[0];
  assert.equal(t.draft_status, "gmail_draft");
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 1); // not again
});

test("cs: email matching escapes LIKE wildcards ('_' in an address)", async () => {
  const env = await setup();
  await addOrder(env.DB, { email: "j_ane@buyer.com" });
  await addOrder(env.DB, { id: "gid://shopify/Order/2", name: "#1002", email: "jxane@buyer.com" });
  const hit = await findLedgerOrder(env.DB, { store: "aub", from_email: "j_ane@buyer.com", received_at: new Date(NOW).toISOString() });
  assert.equal(hit.order.name, "#1001");
  const none = await findLedgerOrder(env.DB, { store: "aub", from_email: "j%ne@buyer.com", received_at: new Date(NOW).toISOString() });
  assert.equal(none.order, null);
});

test("cs freshness: old order data → fresh read-only Shopify read before a where-is-my-order reply; if that fails, status is 'not current'; unknown express stays unknown", async () => {
  // a) Shopify answers: live status is used.
  let env = await setup(AUB_CREDS);
  _resetTokenCacheForTests();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, { updatedAt: new Date(NOW - 5 * 3600000).toISOString(), shippingTitle: null });
  let prompt = "";
  const node = { id: "gid://shopify/Order/1", name: "#1001", email: "jane@buyer.com", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", shippingLine: null,
    lineItems: { nodes: [] }, fulfillments: [{ createdAt: "2026-10-08T00:00:00Z", displayStatus: "IN_TRANSIT", trackingInfo: [{ number: "YT2512345678901", url: "https://t.example/YT2512345678901", company: "YunExpress" }] }] };
  let w = world({
    boxes: { "at-main": { messages: [mail({ id: "f1", from: "Jane <jane@buyer.com>", subject: "where", body: "Where is my order #1001?" })] } },
    triage: () => ({ category: "where_is_order", summary: "Where is it" }),
    shopify: (q) => (q === "name:#1001" ? [node] : []),
    reply: (u) => { prompt = u; return { body: "Hi Jane, your order #1001 is on its way: YT2512345678901. Auberlane Customer Care" }; },
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  let ctx = JSON.parse((await tickets(env.DB))[0].context);
  assert.equal(ctx.source, "shopify_live");
  assert.equal(ctx.express, null);
  assert.equal(ctx.items.length, 1); // sizes kept from the ledger
  assert.match(prompt, /"express":"unknown"/);

  // b) Shopify not reachable (no credentials): status marked not current, not stated as fact.
  env = await setup();
  _resetTokenCacheForTests();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, { updatedAt: new Date(NOW - 5 * 3600000).toISOString() });
  w = world({
    boxes: { "at-main": { messages: [mail({ id: "f2", from: "Jane <jane@buyer.com>", subject: "where", body: "Where is my order #1001?" })] } },
    triage: () => ({ category: "where_is_order", summary: "Where is it" }),
    reply: (u) => { prompt = u; return { body: "Hi Jane, I'm checking the latest status of order #1001 and will get back to you. Auberlane Customer Care" }; },
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  ctx = JSON.parse((await tickets(env.DB))[0].context);
  assert.equal(ctx.status_stale, true);
  assert.equal(ctx.age_hours, 5);
  assert.match(prompt, /not current \(order data is 5 hours old\)/);
});

test("cs state: main-inbox drafts warn they go out from Reilly's address unless a send-as alias exists", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const st = await csState(env, { nowMs: NOW });
  const main = st.inboxes.find((i) => i.slot === "google");
  assert.match(main.draft_from_warning, /reillyworking26@gmail\.com/);
  assert.match(main.draft_from_warning, /Send mail as/);
  assert.equal(st.warnings.length, 1);
});
