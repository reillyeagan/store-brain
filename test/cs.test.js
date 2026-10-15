import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { runCs, csState } from "../src/agents/cs/index.js";
import { screenMail } from "../src/agents/cs/filters.js";
import { checkDraft, routeTicket } from "../src/agents/cs/routing.js";
import { emailAsksAboutSize, sizeUpMention } from "../src/agents/cs/sizeUpGate.js";
import { findPromises, flagOverdue } from "../src/agents/cs/obligations.js";
import { findGoodsPromises, closeKeptPromises, askOverduePromises, looksLikeReplacement } from "../src/agents/cs/promises.js";
import { validateTriage, orderRefFromText } from "../src/agents/cs/triage.js";
import { b64urlEncode, b64urlDecode, stripQuoted } from "../src/agents/cs/gmail.js";
import { findLedgerOrder } from "../src/agents/cs/orderContext.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { noActionCheck } from "../src/agents/cs/noAction.js";
import { escalateTickets } from "../src/agents/cs/escalation.js";
import { listPending, createApproval } from "../src/lib/approvals.js";

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
        const before = Number((q.match(/before:(\d+)/) || [])[1] || 0) * 1000 || Infinity;
        const list = box.messages.filter((m) => Number(m.internalDate) >= after && Number(m.internalDate) < before && !(m.labelIds || []).includes("SENT"))
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
  // Ordinary safe drafts keep passing.
  const safe = [
    "Hi Jan, it's 80% wool and the M measures 41 inches across the chest. Auberlane Customer Care",
    "Hi Jane, could you reply with your order number so we can look into this? Auberlane Customer Care",
    "Hi Jane, orders usually ship within 3-8 business days and standard delivery takes 8-12 business days. Auberlane Customer Care",
    "Hi Jan, thanks for reaching out. I've passed your request on and will confirm once it's updated. Auberlane Customer Care",
  ];
  for (const d of safe) assert.deepEqual(checkDraft(d, { ctx }), [], d);
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
    "We'll give you 20 dollars off your next order.",
    "We will waive the shipping fee, no charge.",
    "We'll ship you a second jacket on us.",
    "We'll cover the return postage.",
    "Just send the item back and we'll sort you out.",
    "It will be with you in 2 days.",
    "It will arrive within 48 hours.",
    "Please visit evil.example/reset to continue.",
    "Email billing@evil.example with your card details.",
    "It should be there in a couple of days.",
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
  // First run read the 8 OLDEST; the cursor hasn't moved past anything unread.
  const first = (await tickets(env.DB)).map((x) => x.gmail_id);
  assert.deepEqual(first, ["x00", "x01", "x02", "x03", "x04", "x05", "x06", "x07"]);
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

/* ---------- re-check fixes ---------- */

test("cs backlog bigger than one listing: works back with before: until the oldest is read; every email read once", async () => {
  const env = await setup({ ANTHROPIC_API_KEY: undefined });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const msgs = [];
  // 40 emails, but one listing shows at most 5 pages x 5 = 25 of them.
  for (let i = 0; i < 40; i++) msgs.push(mail({ id: `y${String(i).padStart(2, "0")}`, from: `C${i} <c${i}@buyer.com>`, subject: `q${i}`, body: "hello", at: NOW - (50 - i) * MIN }));
  const w = world({ boxes: { "at-main": { messages: msgs } }, pageCap: 5 });
  let t = NOW;
  for (let i = 0; i < 20; i++) { await runCs(env, { nowMs: t, fetchImpl: w.fetchImpl }); t += 20 * MIN; }
  const ids = (await tickets(env.DB)).map((x) => x.gmail_id);
  assert.equal(ids.length, 40);
  assert.equal(new Set(ids).size, 40);
  assert.equal(w.calls.filter((c) => /\/messages\/y\d\d\?/.test(c.url)).length, 40);
  assert.ok(w.calls.some((c) => decodeURIComponent(c.url).includes("before:")));
  const inbox = await env.DB.prepare(`SELECT cursor_ms, scan_before_ms FROM cs_inboxes WHERE slot = 'google'`).first();
  assert.equal(inbox.scan_before_ms, null);
  assert.equal(inbox.cursor_ms, NOW - 11 * MIN); // the newest email
});

test("cs: a draft Reilly already sent (gone from Gmail) is not stale — the follow-up gets its own draft, no 'delete it' flag", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const box = { messages: [mail({ id: "g1", threadId: "TG", from: "Jane <jane@buyer.com>", subject: "q", body: "Is the overshirt warm? Order #1001" })] };
  const w = world({
    boxes: { "at-main": box },
    triage: () => ({ category: "product_question", summary: "Asks about warmth" }),
    reply: () => ({ body: "Hi Jane, yes, it's a heavy wool blend and very warm. Auberlane Customer Care" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal(w.drafts.size, 1);
  w.drafts.clear(); // Reilly sent it: Gmail no longer has the draft
  box.messages.push(mail({ id: "g2", threadId: "TG", from: "Jane <jane@buyer.com>", subject: "Re: q", body: "Thanks! Is it itchy?", at: NOW + 10 * MIN }));
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  const [old, neu] = await tickets(env.DB);
  assert.equal(old.gmail_draft_state, "gone");
  assert.equal(neu.draft_status, "gmail_draft");
  assert.equal(w.drafts.size, 1);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 0);
  assert.equal((await csState(env, { nowMs: NOW + 20 * MIN })).stale_gmail_drafts.length, 0);
});

test("cs: a Gmail push refused because another draft still exists is recorded and never retried", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const ins = (gid, status, extra) => env.DB.prepare(`INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, thread_id, rfc_message_id, store, from_email, subject, body, via, status, category, draft_body, draft_status, draft_at, context_at, gmail_draft_id)
    VALUES ('t','t','google',?,'TT',?,'aub','jane@buyer.com','q','hi','email',?,'product_question','Hi Jane, it is warm. Auberlane Customer Care','stored','t','t',?)`).bind(gid, `<${gid}@x>`, status, extra).run();
  await ins("k1", "replied", "dX");   // an older draft Reilly never sent, still in Gmail
  await ins("k2", "drafted", null);   // a stored draft waiting for its Gmail copy
  const w = world({ boxes: { "at-main": { messages: [] } } });
  w.drafts.set("dX", { threadId: "TT", raw: "", tok: "at-main" });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const k2 = (await tickets(env.DB)).find((x) => x.gmail_id === "k2");
  assert.equal(k2.gmail_push, "refused");
  assert.match(k2.gmail_push_note, /still in Gmail/);
  assert.equal(w.drafts.size, 1);
  const before = w.calls.length;
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  assert.equal(w.calls.filter((c, i) => i >= before && c.url.includes("/drafts")).length, 0); // not retried
});

test("cs size-up gate: a bigger Chinese size is never volunteered (Reilly: 'no unless they ask')", () => {
  const draft = "Hi Sam, thanks for your order. We're sending a larger size because the Chinese sizing runs small. Holt & Crane Customer Care";
  // Didn't ask (where-is-my-order): the draft fails the check, and fails by default.
  assert.equal(emailAsksAboutSize({ category: "where_is_my_order", subject: "Order status", body: "Where is my order?" }), false);
  const p = checkDraft(draft, {});
  assert.ok(p.some((x) => /sizing up/.test(x)), p.join("; "));
  assert.ok(checkDraft("Hi Sam, we'll size it up for you. Holt & Crane Customer Care", {}).some((x) => /sizing up/.test(x)));
  // Asked about size or fit (by category or in their own words): allowed.
  assert.equal(emailAsksAboutSize({ category: "size_question" }), true);
  assert.equal(emailAsksAboutSize({ category: "other", body: "Will the medium fit me? I'm usually a M." }), true);
  assert.equal(emailAsksAboutSize({ category: "other", subject: "sizing", body: "hi" }), true);
  assert.deepEqual(checkDraft(draft, { sizeAsked: true }).filter((x) => /sizing up/.test(x)), []);
  // Ordinary size words in a reply are not a size-up.
  assert.equal(sizeUpMention("Your order of the Shawl Cardigan in size M is on its way."), null);
});

test("cs size-up gate: mentioning a size is not asking about fit; real size/fit questions open it", () => {
  const asks = (body) => emailAsksAboutSize({ category: "where_is_my_order", subject: "", body });
  for (const closed of [
    "I ordered the cardigan in size M two weeks ago, where is it?",
    "Order #1234\nShawl Cardigan\nSize: M / Navy\nQty: 1\nWhere is my order?",
    "Can I change the shipping address? Size: L / Grey",
  ]) assert.equal(asks(closed), false, closed);
  for (const open of [
    "what size should I get? I'm 6ft", "Which size do you recommend?", "does it run small?", "does it run large",
    "the jacket is too small", "way too big on me", "it doesn't fit", "how is the fit on this one?", "any sizing advice?",
    "do you have a size chart?", "can I exchange for a bigger size?", "could I swap to a smaller size",
  ]) assert.equal(asks(open), true, open);
});

test("cs size-up gate: the draft check catches every way of saying 'we sent a bigger size'", () => {
  for (const said of [
    "we sent a larger one", "we upsized your order", "we've sent the XL so it fits", "we'll size up for you",
    "we sent a bigger size", "it's one size up from what you ordered", "we shipped the L instead", "sized it up",
  ]) {
    assert.ok(sizeUpMention(`Hi Sam, ${said}. Holt & Crane Customer Care`), said);
    assert.ok(checkDraft(`Hi Sam, thanks for writing, ${said}. Holt & Crane Customer Care`, {}).some((x) => /sizing up/.test(x)), said);
  }
  for (const fine of ["Your Shawl Cardigan in size M has shipped.", "Thanks for your order, it's on its way.", "The medium is in stock."]) {
    assert.equal(sizeUpMention(fine), null, fine);
  }
});

test("cs size-up gate: 'my size' and a bare 'fits' don't open it; 'went up one' and a larger named size are caught", () => {
  const asks = (body) => emailAsksAboutSize({ category: "where_is_my_order", subject: "", body });
  assert.equal(asks("I ordered my size M, where is it?"), false);
  assert.equal(asks("It was a gift, hope it fits!"), false);
  assert.equal(asks("will it fit a 42 chest?"), true);
  assert.equal(asks("these fit small, should I size up?"), true);
  for (const said of ["we went up one for you", "we went up a size", "we went up one size"]) assert.ok(sizeUpMention(said), said);
  // Ordered size known: naming a larger letter size is a size-up.
  const ctx = { name: "#1234", items: [{ title: "Shawl Cardigan", size: "M" }] };
  const p = checkDraft("Hi Sam, your Shawl Cardigan in L is on its way. Holt & Crane Customer Care", { ctx });
  assert.ok(p.some((x) => /names size L, larger than ordered/.test(x)), p.join("; "));
  assert.ok(sizeUpMention("Your XL is on its way.", { orderedSizes: ["Medium"] }));
  assert.equal(sizeUpMention("Your M is on its way.", { orderedSizes: ["M"] }), null, "the ordered size itself is fine");
  assert.equal(sizeUpMention("Your S is on its way.", { orderedSizes: ["M"] }), null, "smaller isn't a size-up");
  assert.equal(sizeUpMention("Your L is on its way.", {}), null, "ordered size unknown: no comparison");
  assert.deepEqual(checkDraft("Hi Sam, your Shawl Cardigan in L is on its way. Holt & Crane Customer Care", { ctx, sizeAsked: true }).filter((x) => /larger than ordered/.test(x)), []);
});

test("order context: the live-Shopify path reads the size from the variant title", async () => {
  const { sizeFromVariant } = await import("../src/agents/cs/orderContext.js");
  assert.equal(sizeFromVariant("M / Navy"), "M");
  assert.equal(sizeFromVariant("Navy / XL"), "XL");
  assert.equal(sizeFromVariant("Navy"), null);
  assert.equal(sizeFromVariant(null), null);
});

/* ---------- no_action: thank-yous never reach Reilly (live 2026-10-14) ---------- */

const REAL_9 = "Customer replied 'Thankyou' to a shipping update notification for their order; no action or question raised.";
const REAL_2 = "Customer thanks the store for a status update and says they will reply once the item is received. No action requested.";

test("cs no_action: the two live thank-you summaries close; a question, a refund or a problem never does", () => {
  const t = (summary, body, extra = {}) => ({ category: "other", urgency: "low", subject: "Re: A shipment from order #1253 is on the way", summary, body, triage: JSON.stringify({ category: "other", summary }), ...extra });
  assert.equal(noActionCheck(t(REAL_9, "Thankyou")).close, true);
  assert.equal(noActionCheck(t(REAL_2, "Thank you for the update. I will reply once I have received the item.")).close, true);
  // The classifier saying "nothing asked" is overruled by a question mark.
  const q = noActionCheck(t("Customer thanks the store. No action requested.", "thanks! when will it arrive?", { triage: JSON.stringify({ category: "other", no_action: true }) }));
  assert.equal(q.close, false);
  assert.match(q.reason, /question/);
  for (const body of [
    "Thanks, but the colour is wrong, I want a refund", "thank you. please send the tracking", "Thanks. It hasn't arrived yet",
    "thanks for nothing, this is a scam", "Thanks, I'd like to return it", "ok thanks. need to change my address",
  ]) assert.equal(noActionCheck(t(REAL_9, body)).close, false, body);
  // Only "other" can be a bare thank-you; a real category always has something to do.
  assert.equal(noActionCheck(t(REAL_9, "Thankyou", { category: "where_is_order" })).close, false);
  // A bare thank-you closes even without the classifier's words; anything more doesn't.
  assert.equal(noActionCheck(t("Customer thanks the store", "Thanks so much!\nJane", { from_name: "Jane Doe" })).close, true);
  assert.equal(noActionCheck(t("Customer thanks the store", "Hi team,\nThank you for the update.\nBest,\nJane Doe\nSent from my iPhone", { from_name: "Jane Doe" })).close, true);
  assert.equal(noActionCheck(t("Customer thanks the store", "Thanks so much, the jacket looks lovely on my husband who wore it to the wedding on saturday in town")).close, false);
});

test("cs no_action review: an allowlist, not a problem list — any word beyond a plain thank-you keeps it with Reilly, whatever the classifier said", () => {
  // The classifier claims "nothing asked" on every one of these; code must still refuse.
  const t = (body, extra = {}) => ({ category: "other", urgency: "low", subject: "Re: Your order is on the way", from_name: "Jane Doe", body,
    summary: "Customer thanks the store. No action requested.", triage: JSON.stringify({ category: "other", no_action: true }), ...extra });
  for (const body of [
    "thanks, but the zipper broke", "thanks, the parcel was empty", "thank you the shoes hurt", "Thanks got it but it smells",
    "thanks. received two of the same", "Thank you, but I ordered a medium", "thanks it arrived opened", "Thanks, the item is used",
    "thank you, it's not what i ordered",
    // Not English: the model alone never closes.
    "Gracias, pero el pedido no llegó", "Danke, aber die Jacke ist kaputt", "Merci mais je n'ai rien reçu",
    // HTML is read as text first.
    "<html><head><style>p{color:red}</style></head><body><p>Thank you</p><p>but the box was crushed</p></body></html>",
    // A "name" line that isn't the sender's name, and a greeting to someone who isn't the store.
    "Thanks\nZipper Broke", "Hi Broken, thanks",
  ]) assert.equal(noActionCheck(t(body)).close, false, body);
  // A plain thank-you in HTML closes once the HTML is read as text.
  assert.equal(noActionCheck(t("<html><head><style>.x{}</style></head><body><div>Thank you!</div><div>Jane</div></body></html>")).close, true);
  // Everything the classifier says is only a supporting sign: the reason records it.
  assert.match(noActionCheck(t("Thankyou")).reason, /only a thank-you.*classifier said nothing was asked/);
});

test("cs no_action: a thank-you is closed quietly (no flag, no draft, listed on the CS page); 'thanks! when will it arrive?' and a wrong-colour refund still reach Reilly", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, {});
  const box = { messages: [
    mail({ id: "n1", from: "Jane <jane@buyer.com>", subject: "Re: A shipment from order #1001 is on the way", body: "Thankyou" }),
    mail({ id: "n2", from: "Jane <jane@buyer.com>", subject: "Re: Your order #1001", body: "thanks! when will it arrive?" }),
    mail({ id: "n3", from: "Jane <jane@buyer.com>", subject: "Wrong colour #1001", body: "I got the wrong colour, I want a refund or return" }),
  ] };
  const w = world({ boxes: { "at-main": box }, triage: (u) => u.includes("Thankyou")
    ? { category: "other", urgency: "low", summary: REAL_9, no_action: true }
    : u.includes("when will it arrive") // the classifier gets it wrong; code must overrule it
      ? { category: "other", urgency: "low", summary: "Customer thanks the store. No action requested.", no_action: true }
      : { category: "return_refund", wants_refund: true, order_number: "1001", summary: "Wrong colour received; wants a refund or return" } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  await runCs(env, { nowMs: NOW + 25 * MIN, fetchImpl: w.fetchImpl });
  const ts = await tickets(env.DB);
  const by = (id) => ts.find((t) => t.gmail_id === id);
  assert.equal(by("n1").status, "no_action");
  assert.equal(by("n1").approval_id, null);
  assert.equal(by("n1").draft_body, null);
  assert.match(by("n1").classify_note, /^no_action: /);
  assert.equal(by("n2").status, "needs_reilly");
  assert.equal(by("n3").status, "needs_reilly");
  assert.equal((await listPending(env.DB)).length, 2);
  assert.equal((await evs(env.DB, "cs.no_action")).length, 1);
  const st = await csState(env, { nowMs: NOW + 30 * MIN });
  assert.deepEqual(st.no_action_needed.map((x) => x.id), [by("n1").id]);
  assert.match(st.no_action_needed[0].why, /classifier said nothing was asked/);
  assert.ok(!st.escalations.some((e) => e.id === by("n1").id));
});

test("cs no_action: open flags the classifier called 'no action requested/raised' are re-closed with the reason; the wrong-colour refund stays", async () => {
  const env = await setup();
  const DB = env.DB;
  const at = new Date(NOW - 3600000).toISOString();
  const add = (o) => addFlagged(DB, at, o);
  const a9 = await add({ id: 9, summary: REAL_9, body: "Thankyou" });
  const a2 = await add({ id: 2, summary: REAL_2, body: "Thank you for the update, I will get back to you once I receive the item.", order: "#1059" });
  const a3 = await add({ id: 3, summary: "Received the wrong colour and wants a refund or return.", body: "Wrong colour arrived. I want a refund or a return.", category: "return_refund", urgency: "normal", order: "#1100" });
  const nf = async () => new Response("{}", { status: 404 });
  const out = await escalateTickets(env, { nowMs: NOW, fetchImpl: nf });
  assert.equal(out.reclosed, 2);
  assert.deepEqual((await listPending(DB)).map((a) => a.id), [a3]);
  for (const id of [a9, a2]) {
    const ap = await DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first();
    assert.equal(ap.status, "expired");
    // The brain's reason never goes in `note` (Reilly's verbatim words).
    assert.equal(ap.note, null);
    const res = JSON.parse(ap.result);
    assert.equal(res.closed_by, "cs.escalation");
    assert.equal(res.not_reilly, true);
    assert.match(res.reason, /only a thank-you/);
  }
  const ts = await tickets(DB);
  assert.deepEqual(ts.map((t) => [t.id, t.status]), [[2, "no_action"], [3, "needs_reilly"], [9, "no_action"]]);
  assert.match(ts[0].classify_note, /re-closed flag/);
  const ev = await evs(DB, "cs.no_action_reclosed");
  assert.equal(ev.length, 2);
  assert.match(JSON.parse(ev[0].data).reason, /only a thank-you/);
  // A one-off: a later run does nothing, even for a qualifying flag from before the cutoff.
  await add({ id: 11, summary: REAL_9, body: "Thankyou", order: "#1300" });
  assert.equal((await escalateTickets(env, { nowMs: NOW + MIN, fetchImpl: nf })).reclosed, 0);
  assert.equal((await DB.prepare(`SELECT value FROM agent_cursors WHERE name = 'cs.no_action_reclose'`).first()).value, 2);
});

/** A CS flag already waiting on Reilly, as the escalation desk made them before the guard. */
async function addFlagged(DB, at, { id, summary, body, category = "other", urgency = "low", order = "#1253", thread = null, created = "2026-10-14T12:00:00Z", status = "needs_reilly", flag = true }) {
  let ap = null;
  if (flag) {
    ap = await createApproval(DB, { dept: "cs", requestedBy: "cs.escalation", store: "hc", title: `Holt & Crane: ${category} ${order} — ticket ${id}`, options: [{ id: "handled", label: "I'll handle it in Gmail", detail: summary }] });
    await DB.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).bind(created, ap).run();
  }
  await DB.prepare(`INSERT INTO cs_tickets (id, opened_at, updated_at, slot, gmail_id, thread_id, store, from_email, from_name, subject, body, via, status, category, urgency, summary, triage, context_at, order_name, escalated_at, approval_id)
    VALUES (?, ?, ?, 'google:hc', ?, ?, 'hc', 'c@x.com', 'Casey Shopper', ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, at, at, `g${id}`, thread || `T${id}`, `Re: order ${order}`, body, status, category, urgency, summary, JSON.stringify({ category, summary }), at, order, flag ? at : null, ap).run();
  return ap;
}

test("cs no_action review: the one-off re-close never overrides an earlier unanswered ask in the thread, and leaves flags made after the cutoff alone", async () => {
  const env = await setup();
  const DB = env.DB;
  const at = "2026-10-14T11:00:00Z";
  // A superseded real problem, then "Thanks" in the same conversation (the flag is on "Thanks").
  await addFlagged(DB, at, { id: 20, thread: "TT", flag: false, status: "superseded", category: "exchange", summary: "Jacket arrived torn; asks for a replacement", body: "My jacket arrived torn, can I get a replacement?" });
  const aThanks = await addFlagged(DB, at, { id: 21, thread: "TT", summary: REAL_9, body: "Thanks" });
  // A plain thank-you flagged AFTER the cutoff: not the one-off's business.
  const aLate = await addFlagged(DB, at, { id: 22, summary: REAL_9, body: "Thankyou", created: "2026-10-14T17:00:00Z" });
  const nf = async () => new Response("{}", { status: 404 });
  for (const m of [0, 20, 40]) await escalateTickets(env, { nowMs: NOW + m * MIN, fetchImpl: nf });
  assert.deepEqual((await listPending(DB)).map((a) => a.id).sort(), [aThanks, aLate].sort());
  assert.equal((await evs(DB, "cs.no_action_reclosed")).length, 0);
});

/* ---------------- money and goods promises (routine audit, 2026-10-14) ---------------- */

test("cs promises: refund / replacement / exchange promises are found; offers, questions and refusals are not", () => {
  const k = (t) => findGoodsPromises(t).map((p) => p.kind);
  assert.deepEqual(k("Hi Sam, I'm so sorry. I'll issue a full refund for your order today."), ["refund"]);
  assert.deepEqual(k("We will send you a replacement in the XL this week."), ["replacement"]);
  assert.deepEqual(k("I've processed your refund, it can take 5-10 days to show."), ["refund"]);
  assert.deepEqual(k("Your refund will be processed once the parcel reaches us."), ["refund"]);
  assert.deepEqual(k("We'll exchange it for the M, no problem."), ["exchange"]);
  assert.deepEqual(k("Would you like a refund or a replacement?"), []);
  assert.deepEqual(k("If you'd like, we can offer a refund."), []);
  assert.deepEqual(k("Unfortunately we can't refund opened items."), []);
  assert.deepEqual(k("I have a question about your refund request."), []);
  assert.deepEqual(k("Your parcel is on its way."), []);
});

/** A ticket for #1019 (H&C), verified to jane by order_context, and Reilly's sent reply. */
async function promiseWorld({ body = "Hi Jane, I'm sorry about the coat. I'll issue a full refund for #1019 today." } = {}) {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  await addOrder(env.DB, { store: "hc", id: "gid://shopify/Order/1019", name: "#1019" });
  const cust = mail({ id: "p1", threadId: "TP", from: "Jane <jane@buyer.com>", to: "info@holtandcrane.com", subject: "refund", body: "The coat doesn't fit, I'd like a refund on #1019." });
  const box = { messages: [cust], threads: { TP: [cust] } };
  const w = world({
    boxes: { "at-main": box },
    triage: () => ({ category: "return_refund", store: "hc", summary: "Wants a refund", order_number: "1019" }),
    reply: () => ({ body: "Hi Jane, I've passed this on to the team. Holt & Crane" }),
  });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  const t = (await tickets(env.DB))[0];
  const sent = mail({ id: "p2", threadId: "TP", from: "Reilly <reillyworking26@gmail.com>", labels: ["SENT"], body, at: NOW + 20 * MIN });
  box.threads.TP = [cust, sent];
  return { env, w, t, box, cust, sent };
}

test("cs promises: a refund promised in sent mail opens an obligation on the VERIFIED order, goes to Waiting on you when overdue, and only a Shopify refund closes it", async () => {
  const { env, w, t } = await promiseWorld();
  assert.equal(t.order_name, "#1019"); // order_context verified it by email
  await runCs(env, { nowMs: NOW + 3 * 60 * MIN, fetchImpl: w.fetchImpl });
  const ob = (await env.DB.prepare(`SELECT * FROM obligations WHERE kind = 'refund'`).all()).results;
  assert.equal(ob.length, 1);
  assert.equal(ob[0].order_id, "gid://shopify/Order/1019");
  assert.equal(ob[0].order_ref, "#1019");
  assert.equal(ob[0].status, "open");
  const LATER = NOW + 4 * 86400000;
  // Overdue after 3 days: one question for Reilly, never two.
  await askOverduePromises(env.DB, { nowMs: LATER });
  await askOverduePromises(env.DB, { nowMs: LATER + 3600000 });
  const q = (await listPending(env.DB)).filter((a) => a.requested_by === "cs.obligations");
  assert.equal(q.length, 1);
  assert.match(q[0].title, /Holt & Crane #1019: refund promised 2026-10-13 \(3 days ago\), no refund for that order in Shopify yet/);
  // A FAILED refund doesn't count.
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r0', 'gid://shopify/Order/1019', ?, 59.9, 'FAILURE', 'x')`).bind(new Date(LATER).toISOString()).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: LATER }), 0);
  // A PENDING one is shown as "refund pending" but keeps it open (it can still fail).
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r1', 'gid://shopify/Order/1019', ?, 59.9, 'PENDING', 'x')`).bind(new Date(LATER).toISOString()).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: LATER }), 0);
  const pendSt = await csState(env, { nowMs: LATER });
  assert.equal(pendSt.promises_open[0].refund_pending, true);
  assert.match(pendSt.promises_open[0].pending_detail, /refund pending/);
  // The pending refund fails: still open.
  await env.DB.prepare(`UPDATE refunds SET status = 'FAILURE' WHERE refund_id = 'r1'`).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: LATER }), 0);
  assert.equal((await csState(env, { nowMs: LATER })).promises_open[0].refund_pending, false);
  // Only SUCCESS closes it (rule 3: the system of record, completed).
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r2', 'gid://shopify/Order/1019', ?, 59.9, 'SUCCESS', 'x')`).bind(new Date(LATER).toISOString()).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: LATER }), 1);
  assert.equal((await env.DB.prepare(`SELECT status FROM obligations WHERE kind = 'refund'`).first()).status, "done");
  assert.equal((await evs(env.DB, "cs.promise_kept")).length, 1);
  // The dated-reply tracker never closed it with a later email.
  assert.equal((await evs(env.DB, "cs.obligation_kept")).length, 0);
  const st = await csState(env, { nowMs: LATER });
  assert.equal(st.promises_open.length, 0);
});

test("cs promises: a refund on ANOTHER order, or long before the promise, never closes it", async () => {
  const { env, w } = await promiseWorld();
  await runCs(env, { nowMs: NOW + 3 * 60 * MIN, fetchImpl: w.fetchImpl });
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r9', 'gid://shopify/Order/9999', ?, 59.9, 'SUCCESS', 'x')`).bind(new Date(NOW + 86400000).toISOString()).run();
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r8', 'gid://shopify/Order/1019', '2026-09-01T00:00:00Z', 10, 'SUCCESS', 'x')`).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: NOW + 2 * 86400000 }), 0);
  const st = await csState(env, { nowMs: NOW + 2 * 86400000 });
  assert.equal(st.promises_open.length, 1);
  assert.equal(st.promises_open[0].verified_order, true);
});

test("cs promises: a stranger's order is never matched; the promise is kept with no order and goes to Reilly", async () => {
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  // #1019 belongs to someone else: order_context refuses it (order_mismatch).
  await addOrder(env.DB, { store: "hc", id: "gid://shopify/Order/1019", name: "#1019", email: "someone@else.com" });
  const cust = mail({ id: "s1", threadId: "TS", from: "Mallory <mal@x.com>", to: "info@holtandcrane.com", body: "Refund #1019 please" });
  const box = { messages: [cust], threads: { TS: [cust] } };
  const w = world({ boxes: { "at-main": box }, triage: () => ({ category: "return_refund", store: "hc", summary: "refund", order_number: "1019" }) });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl });
  assert.equal((await tickets(env.DB))[0].order_mismatch, 1);
  box.threads.TS = [cust, mail({ id: "s2", threadId: "TS", from: "Reilly <reillyworking26@gmail.com>", labels: ["SENT"], body: "We will refund you today.", at: NOW + 10 * MIN })];
  await runCs(env, { nowMs: NOW + 3 * 60 * MIN, fetchImpl: w.fetchImpl });
  const ob = await env.DB.prepare(`SELECT * FROM obligations WHERE kind = 'refund'`).first();
  assert.equal(ob.order_id, null);
  assert.equal(ob.order_ref, null);
  // Even a real refund on #1019 can't close an obligation that has no verified order.
  await env.DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, amount, status, updated_at) VALUES ('hc', 'r1', 'gid://shopify/Order/1019', ?, 59.9, 'SUCCESS', 'x')`).bind(new Date(NOW + 86400000).toISOString()).run();
  assert.equal(await closeKeptPromises(env.DB, { nowMs: NOW + 2 * 86400000 }), 0);
  await askOverduePromises(env.DB, { nowMs: NOW + 4 * 86400000 });
  const q = (await listPending(env.DB)).filter((a) => a.requested_by === "cs.obligations");
  assert.equal(q.length, 1);
  assert.match(q[0].title, /no verified order/);
});

test("cs promises: a replacement closes on a later $0 / 'replacement' order for the same customer, never a stranger's", () => {
  const party = "jane@buyer.com";
  assert.equal(looksLikeReplacement({ total: 0, raw: JSON.stringify({ email: party }) }, { originalName: "#1059", party }), true);
  assert.equal(looksLikeReplacement({ total: 59.9, raw: JSON.stringify({ email: party, note: "Replacement for #1059" }) }, { originalName: "#1059", party }), true);
  assert.equal(looksLikeReplacement({ total: 59.9, raw: JSON.stringify({ email: party }) }, { originalName: "#1059", party }), false); // a new purchase
  assert.equal(looksLikeReplacement({ total: 0, raw: JSON.stringify({ email: "other@x.com" }) }, { originalName: "#1059", party }), false);
});

/* ---------------- review fixes (2026-10-14) ---------------- */

test("cs promises: conditional promises are 'awaiting return'; 'resend' counts only for the goods", () => {
  const one = (t) => findGoodsPromises(t)[0] || null;
  for (const t of ["Once we receive the return, we'll refund you in full.", "We'll refund you as soon as it's back with us.", "I'll issue the refund when it arrives back at our warehouse."]) {
    const p = one(t);
    assert.equal(p && p.kind, "refund", t);
    assert.equal(p.awaiting_return, true, t);
  }
  assert.equal(one("I'll issue a full refund today.").awaiting_return, false);
  assert.deepEqual(findGoodsPromises("I'll resend the tracking link now.").map((p) => p.kind), []);
  assert.deepEqual(findGoodsPromises("We'll resend the confirmation email.").map((p) => p.kind), []);
  assert.deepEqual(findGoodsPromises("We'll resend the jacket in the right size this week.").map((p) => p.kind), ["replacement"]);
});

async function insertOb(DB, { id, kind = "replacement", note, status = "open", due = "2026-10-01T00:00:00Z", orderId = "gid://shopify/Order/1059", ref = "#1059", created = "2026-09-30T00:00:00Z" }) {
  await DB.prepare(`INSERT INTO obligations (id, created_at, store, kind, party, order_ref, order_id, due_at, status, note) VALUES (?, ?, 'hc', ?, 'jane@buyer.com', ?, ?, ?, ?, ?)`)
    .bind(id, created, kind, ref, orderId, due, status, note).run();
}

test("cs promises: the original order's KFB fulfilment never closes a replacement; only a SECOND KFB order after the promise does", async () => {
  const env = await setup();
  const DB = env.DB;
  await insertOb(DB, { id: 1, note: `cs ticket 9 replacement: "We'll send a replacement." (sent 2026-10-05T12:00:00.000Z)` });
  // The original KFB order for #1059, even if KFB dates it after the promise (late import).
  await DB.prepare(`INSERT INTO kfb_orders (kfb_order_id, kfb_shop_code, order_ref, kfb_created_at, imported_at) VALUES ('K1', 'jmzjx1-it', '1059', '2026-10-05T13:00:00Z', 'x')`).run();
  assert.equal(await closeKeptPromises(DB, { nowMs: NOW }), 0);
  // A Shopify $0 order created just BEFORE the promise doesn't count either.
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, raw, updated_at) VALUES ('hc', 'o-early', '#1100', '2026-10-05T11:00:00Z', '2026-10-05', 0, ?, 'x')`).bind(JSON.stringify({ email: "jane@buyer.com" })).run();
  assert.equal(await closeKeptPromises(DB, { nowMs: NOW }), 0);
  // A second KFB order for the same number, after the promise: kept.
  await DB.prepare(`INSERT INTO kfb_orders (kfb_order_id, kfb_shop_code, order_ref, kfb_created_at, imported_at) VALUES ('K2', 'jmzjx1-it', '1059', '2026-10-07T09:00:00Z', 'x')`).run();
  assert.equal(await closeKeptPromises(DB, { nowMs: NOW }), 1);
  assert.match((await evs(DB, "cs.promise_kept"))[0].summary, /second KFB order K2/);
});

test("cs promises: a new promise after a closed one opens a new obligation; the same sent sentence never reopens", async () => {
  const { env, w, box, cust, sent } = await promiseWorld();
  await runCs(env, { nowMs: NOW + 3 * 60 * MIN, fetchImpl: w.fetchImpl });
  await env.DB.prepare(`UPDATE obligations SET status = 'done' WHERE kind = 'refund'`).run();
  // Re-reading the same thread later: the same sentence is not recorded again.
  await env.DB.prepare(`UPDATE cs_tickets SET thread_checked_at = NULL, replied_at = NULL`).run(); // force a re-read of the thread
  await runCs(env, { nowMs: NOW + 6 * 60 * MIN, fetchImpl: w.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM obligations WHERE kind = 'refund'`).first()).n, 1);
  // A NEW refund promise later in the thread: a new obligation.
  box.threads.TP = [cust, sent, mail({ id: "p3", threadId: "TP", from: "Reilly <reillyworking26@gmail.com>", labels: ["SENT"], body: "I'll refund the shipping cost too.", at: NOW + 7 * 60 * MIN })];
  await env.DB.prepare(`UPDATE cs_tickets SET thread_checked_at = NULL, replied_at = NULL`).run(); // force a re-read of the thread
  await runCs(env, { nowMs: NOW + 10 * 60 * MIN, fetchImpl: w.fetchImpl });
  const rows = (await env.DB.prepare(`SELECT status FROM obligations WHERE kind = 'refund' ORDER BY id`).all()).results.map((r) => r.status);
  assert.deepEqual(rows, ["done", "open"]);
});

test("cs promises: awaiting-return promises never go overdue; at most 10 promise questions wait on Reilly", async () => {
  const env = await setup();
  const DB = env.DB;
  await insertOb(DB, { id: 1, kind: "refund", due: null, note: `cs ticket 1 refund: [awaiting return] "Once we receive it we'll refund." (sent 2026-09-01T00:00:00.000Z)` });
  for (let i = 2; i <= 14; i++) await insertOb(DB, { id: i, kind: "refund", orderId: `gid://shopify/Order/${i}`, ref: `#${i}`, note: `cs ticket ${i} refund: "I'll refund you." (sent 2026-09-20T00:00:00.000Z)` });
  assert.equal(await askOverduePromises(DB, { nowMs: NOW }), 5);
  assert.equal(await askOverduePromises(DB, { nowMs: NOW }), 5);
  assert.equal(await askOverduePromises(DB, { nowMs: NOW }), 0); // 10 waiting: the rest wait their turn
  assert.equal((await DB.prepare(`SELECT approval_id FROM obligations WHERE id = 1`).first()).approval_id, null);
  const st = await csState(env, { nowMs: NOW });
  assert.equal(st.promises_open.find((o) => o.id === 1).awaiting_return, true);
});

/* ---------- starter drafts for flagged emails (Reilly 2026-10-15) ---------- */
import { writeStarterDrafts, NEW_CARD_TAIL, OLD_CARD_TAIL } from "../src/agents/cs/starterDrafts.js";
import { Budget } from "../src/agents/cs/util.js";

async function flagged(env, { id, body, category = "return_refund", mismatch = 0, orderRef = null, approvalStatus = "pending" }) {
  const aid = await createApproval(env.DB, { dept: "cs", requestedBy: "cs.escalation", store: "hc", title: `t${id}`,
    options: [{ id: "handled", label: "I'll handle it in Gmail", detail: `Summary. Why it's yours: x. ${OLD_CARD_TAIL}` }] });
  if (approvalStatus !== "pending") await env.DB.prepare(`UPDATE approvals SET status = ? WHERE id = ?`).bind(approvalStatus, aid).run();
  await env.DB.prepare(`INSERT INTO cs_tickets (id, opened_at, updated_at, slot, gmail_id, thread_id, rfc_message_id, store, from_email, from_name, subject, body, status, category, context_at, escalated_at, approval_id, order_mismatch, order_ref)
    VALUES (?, 't', 't', 'google', ?, ?, ?, 'hc', 'jane@buyer.com', 'Jane Doe', 'Wrong colour', ?, 'needs_reilly', ?, 't', 't', ?, ?, ?)`)
    .bind(id, `g${id}`, `th${id}`, `<m${id}@x>`, body, category, aid, mismatch, orderRef).run();
  return aid;
}

test("cs starter drafts: a flagged email gets a checked starting reply in Gmail and the card says so; nothing sent, unsafe text and closed flags skipped", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const replies = {
    "ordered red": { body: "Hi Jane, thanks for letting us know the blazers arrived in wine red rather than red. Could you reply with your order number and a photo of the item? The team is looking into it and will follow up shortly. Holt & Crane Customer Care" },
    "money back": { body: "Hi Jane, we'll refund you right away. Holt & Crane Customer Care" },
    "thankyou": { no_reply: true },
  };
  const w = world({ reply: (u) => { for (const [k, v] of Object.entries(replies)) if (u.toLowerCase().includes(k)) return v; return { body: "" }; } });
  const a1 = await flagged(env, { id: 1, body: "I ordered red blazers but they came wine red." });
  await flagged(env, { id: 2, body: "I want my money back." });
  await flagged(env, { id: 3, body: "Thankyou", category: "other" });
  await flagged(env, { id: 4, body: "I ordered red too", approvalStatus: "approved" }); // flag already handled
  const out = await writeStarterDrafts(env, { nowMs: NOW, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  // Two AI starters per run (newest first: 3, 2), then the next run picks up 1.
  const out2 = await writeStarterDrafts(env, { nowMs: NOW + MIN, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  assert.equal(out.no_reply + out2.no_reply, 1);
  assert.equal(out.failed + out2.failed, 1);
  assert.equal(out.gmail + out2.gmail, 1);
  const ts = await tickets(env.DB);
  assert.equal(ts[0].draft_status, "gmail_draft");
  assert.ok(ts[0].gmail_draft_id);
  assert.equal(ts[1].draft_status, "starter_skipped"); // failed the money check: no draft made
  assert.equal(ts[1].gmail_draft_id, null);
  assert.equal(ts[2].draft_status, "starter_skipped"); // a thank-you needs no reply
  assert.equal(ts[3].draft_status, null); // closed flag untouched
  assert.equal(w.drafts.size, 1);
  assert.ok(!w.calls.some((c) => /\/send\b|messages\/send/.test(c.url)), "nothing is ever sent");
  const card = await env.DB.prepare(`SELECT options FROM approvals WHERE id = ?`).bind(a1).first();
  assert.ok(card.options.includes(NEW_CARD_TAIL));
  // A third run does nothing new: one draft per conversation.
  const out3 = await writeStarterDrafts(env, { nowMs: NOW + 2 * MIN, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  assert.equal(out3.gmail, 0);
  assert.equal(w.drafts.size, 1);
});

test("cs starter drafts: off unless CS_DRAFTS_LIVE is on", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "0" });
  const w = world({ reply: () => ({ body: "x" }) });
  await flagged(env, { id: 1, body: "hello" });
  const out = await writeStarterDrafts(env, { nowMs: NOW, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  assert.ok(out.skipped);
  assert.equal(w.calls.length, 0);
});

test("cs starter drafts: no starter when Reilly already replied in the thread, and an unusable AI answer is not retried every run", async () => {
  const env = await setup({ CS_DRAFTS_LIVE: "1" });
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  let aiCalls = 0;
  const w = world({
    boxes: { "at-main": { messages: [], threads: { th1: [{ id: "s1", labelIds: ["SENT"], internalDate: String(NOW - 5 * MIN) }] } } },
    reply: () => { aiCalls++; return "not json at all"; },
  });
  await flagged(env, { id: 1, body: "I ordered red blazers." });
  await env.DB.prepare(`UPDATE cs_tickets SET received_at = ? WHERE id = 1`).bind(new Date(NOW - 60 * MIN).toISOString()).run();
  await flagged(env, { id: 2, body: "Where is my parcel" });
  await writeStarterDrafts(env, { nowMs: NOW, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  await writeStarterDrafts(env, { nowMs: NOW + MIN, fetchImpl: w.fetchImpl, budget: new Budget(28) });
  const ts = await tickets(env.DB);
  assert.equal(ts[0].draft_status, "starter_skipped");
  assert.match(ts[0].draft_note, /already replied/);
  assert.equal(ts[1].draft_status, "starter_skipped");
  assert.match(ts[1].draft_note, /AI answer unusable/);
  assert.equal(aiCalls, 1); // once, not every run
  assert.equal(w.drafts.size, 0);
});

test("cs screening (live 2026-10-15): a contact form from 'MS (Shopify)' is Marlowe's; a reply to a store's mail at Reilly's own address is that store's, even H&C's; personal mail still isn't", () => {
  const main = { slot: "google", stores: ["aub", "mar"], own: false };
  const H = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  const cf = screenMail({ headers: H({ From: "MS (Shopify) <mailer@shopify.com>", "Reply-To": "Jules Sanders <jules@x.com>", To: "reillyworking26@gmail.com", Subject: "New customer message on October 15, 2026 at 7:41 am" }), body: "You received a new message from your online store's contact form. Body: What is the material blend?" }, main);
  assert.deepEqual([cf.keep, cf.store, cf.via], [true, "mar", "contact_form"]);
  const quoted = "Hello. We have to return the sweater...\n\nFrom: H&C <requests+holtandcrane.com@judge.me>\nSent: Tuesday\nSubject: Mary, what did you think";
  const mary = screenMail({ headers: H({ From: "Mary Peretti <maryp520@msn.com>", To: "reillyworking26@gmail.com", Subject: "Re: ⭐️ Mary, what did you think about Men's Knit Cardigan" }), body: "Hello. We have to return the sweater...", fullBody: quoted }, main);
  assert.deepEqual([mary.keep, mary.store], [true, "hc"]);
  const pal = screenMail({ headers: H({ From: "Pal <pal@gmail.com>", To: "reillyworking26@gmail.com", Subject: "lunch?" }), body: "lunch tomorrow?", fullBody: "lunch tomorrow?" }, main);
  assert.equal(pal.keep, false);
  // Two stores quoted: can't tell, not kept.
  const two = screenMail({ headers: H({ From: "X <x@y.com>", To: "reillyworking26@gmail.com", Subject: "Re: hi" }), body: "hi", fullBody: "From: Auberlane <info@auberlane.com>\nFrom: H&C <info@holtandcrane.com>" }, main);
  assert.equal(two.keep, false);
});

test("cs: drafts are signed with just the store name (Reilly 2026-10-15)", async () => {
  const { signOff } = await import("../src/agents/cs/replyWriter.js");
  assert.equal(signOff("Hi Jonas,\n\nThanks.\n\nHolt & Crane Customer Care"), "Hi Jonas,\n\nThanks.\n\nHolt & Crane");
  assert.equal(signOff("Hi,\n\nAuberlane"), "Hi,\n\nAuberlane");
  const { inboxQuery } = await import("../src/agents/cs/gmail.js");
  const q = inboxQuery(NOW, ["auberlane.com"], null, ["Holt & Crane", "holtandcrane.com"]);
  assert.match(q, /"Holt & Crane"/);
  assert.match(q, /"holtandcrane\.com"/);
});

test("cs (live 2026-10-15): a 'nothing there' / 'shows delivered' email is a missing parcel for Reilly; a draft never names Reilly; delivered-or-not comes only from the carrier", async () => {
  const ctx = { name: "#1118", shipped: true, shipments: [{ tracking_number: "UL546222736YP", shopify_status: "IN_TRANSIT", delivered_at: null }] };
  assert.equal(routeTicket({ category: "where_is_order", body: "Hi i checked all locations and there was nothing there" }, {}, ctx).action, "escalate");
  assert.equal(routeTicket({ category: "where_is_order", body: "Where is my order? It hasn't arrived." }, {}, ctx).action, "draft");
  assert.equal(routeTicket({ category: "where_is_order", body: "where is it" }, {}, { ...ctx, shipments: [{ ...ctx.shipments[0], carrier_delivered: true }] }).action, "escalate");
  assert.ok(checkDraft("Hi Shaun, Reilly will review where things stand. Holt & Crane", { ctx }).some((p) => /Reilly/.test(p)));
  const { userPrompt } = await import("../src/agents/cs/replyWriter.js");
  const u = userPrompt({ category: "where_is_order", body: "where", subject: "x" }, { ...ctx, created_at: "t" }, null);
  assert.match(u, /carrier tracking not read: never say delivered or not delivered/);
  assert.doesNotMatch(u, /IN_TRANSIT/, "Shopify's lagging status is not given to the writer");
});

test("cs (review 2026-10-15): business mail quoting a store address isn't a customer; old carrier states don't count; the look-back runs once, after a finished read", async () => {
  const { storeFromQuoted } = await import("../src/agents/cs/filters.js");
  assert.equal(storeFromQuoted("Hi Reilly, please contact support@auberlane.com for the invoice.\nOn Mon, Guy <guy@x.com> wrote:"), null);
  assert.equal(storeFromQuoted("On Mon, John Williams <j@x.com> wrote:"), null, "'ms' inside a name is not Marlowe");
  const { ledgerContext } = await import("../src/agents/cs/orderContext.js");
  const DB = makeD1();
  await addOrder(DB, { store: "hc", id: "gid://shopify/Order/9", name: "#1118" });
  await DB.prepare(`INSERT INTO shipments (store, order_id, tracking_number, state, polled_at, updated_at) VALUES ('hc', 'gid://shopify/Order/9', 'UL1', 'in_transit', ?, 't')`).bind(new Date(Date.now() - 3 * 86400000).toISOString()).run();
  const order = await DB.prepare(`SELECT * FROM orders WHERE order_id = 'gid://shopify/Order/9'`).first();
  assert.equal((await ledgerContext(DB, order)).shipments[0].carrier_delivered, null, "a 3-day-old carrier state says nothing");
  const { LOOKBACK_DONE } = await import("../src/agents/cs/triage.js");
  const env = await setup();
  await connect(env, "google", "reillyworking26@gmail.com", "rt-main");
  const w = world({ boxes: { "at-main": { messages: [] } } });
  await runCs(env, { nowMs: NOW, fetchImpl: w.fetchImpl }); // first read: no look-back needed
  assert.equal(await env.DB.prepare(`SELECT value FROM agent_cursors WHERE name = ?`).bind(LOOKBACK_DONE).first(), null);
  await runCs(env, { nowMs: NOW + 20 * MIN, fetchImpl: w.fetchImpl });
  assert.ok(await env.DB.prepare(`SELECT value FROM agent_cursors WHERE name = ?`).bind(LOOKBACK_DONE).first());
});

test("cs cards (Reilly 2026-10-15, less text): a flagged email becomes a short card — store, kind, summary, customer, order, draft", async () => {
  const { csCards } = await import("../src/agents/cs/index.js");
  const env = await setup();
  const aid = await createApproval(env.DB, { dept: "cs", requestedBy: "cs.escalation", store: "hc", title: "t", options: [{ id: "handled", label: "x", detail: "long text" }] });
  await env.DB.prepare(`INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, store, from_email, from_name, subject, body, status, category, summary, context, context_at, approval_id, gmail_draft_id, received_at) VALUES ('t', 't', 'google', 'g1', 'hc', 'j@x.com', 'Jane', 's', 'b', 'needs_reilly', 'return_refund', 'Wants a refund for a wrong colour.', ?, 't', ?, 'd1', 't')`)
    .bind(JSON.stringify({ name: "#1032", financial_status: "PAID", shipped: true }), aid).run();
  const cards = await csCards(env.DB, await listPending(env.DB));
  assert.deepEqual({ ...cards[aid], at: undefined, idea: undefined }, { store: "hc", kind: "Return / refund", summary: "Wants a refund for a wrong colour.", customer: "Jane", email: "j@x.com", order: "#1032 · paid · shipped", draft: true, idea: undefined, emails: 1, at: undefined });
});
