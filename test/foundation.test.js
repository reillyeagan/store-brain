import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeD1, makeR2 } from "./helpers/d1.js";

import { STORES, LIVE_STORE_IDS, getStore, storeByDomain } from "../src/config/stores.js";
import { AGENTS, SERVICES } from "../src/config/agents.js";
import { logEvent, recentEvents, redact, costSince } from "../src/lib/eventlog.js";
import { feedState, runSentinel, markFeedOk, markFeedFailed, evaluateFeeds } from "../src/lib/freshness.js";
import { verifiedWrite } from "../src/lib/writeVerifier.js";
import { backup, readBackup } from "../src/lib/backupVault.js";
import {
  createApproval, decide, listPending, markExecuted, signDecision, verifyDecisionSig, getApproval,
} from "../src/lib/approvals.js";
import { notifyPhone, sendTestNotification } from "../src/lib/phone.js";
import { handleApprovalPage } from "../src/lib/approvalPage.js";
import {
  storeCredentials, getAccessToken, assertShop, guardedWrite, verifyWebhookHmac, StoreGuardError,
  _resetTokenCacheForTests,
} from "../src/lib/storeGuard.js";
import { parseOrder, parseRefund, handleShopifyWebhook } from "../src/lib/shopifyWebhooks.js";
import { localDay } from "../src/lib/time.js";
import worker from "../src/index.js";

/* ---------------- config ---------------- */

test("stores: exactly H&C, Auberlane and Marlowe are live", () => {
  assert.deepEqual([...LIVE_STORE_IDS].sort(), ["aub", "hc", "mar"]);
  assert.equal(STORES.cc.live, false);
  assert.equal(STORES.tund.live, false);
});

test("stores: secret prefixes are unique per store", () => {
  const names = Object.values(STORES).flatMap((s) => [s.secrets.clientId, s.secrets.clientSecret]);
  assert.equal(new Set(names).size, names.length);
});

test("stores: lookup never defaults to a store", () => {
  assert.equal(getStore(undefined), null);
  assert.equal(getStore("toString"), null);
  assert.equal(storeByDomain("JMZJX1-IT.myshopify.com").id, "hc");
  assert.equal(storeByDomain("evil.myshopify.com"), null);
});

test("agents: 48 agents (3 catalog agents dropped 2026-10-11; 2 parcel agents retired 2026-10-13; P&L Sheets added 2026-10-14), unique ids, 7 services", () => {
  assert.equal(AGENTS.length, 48);
  assert.equal(new Set(AGENTS.map((a) => a.id)).size, 48);
  assert.ok(!AGENTS.some((a) => a.status === "off"), "switched-off agents are removed, not shown crossed off");
  assert.equal(SERVICES.length, 7);
});

/* ---------------- time ---------------- */

test("localDay uses the store timezone, not UTC", () => {
  // 02:30 UTC on Oct 11 is still Oct 10 in New York (EDT, UTC-4)
  assert.equal(localDay("2026-10-11T02:30:00Z", "America/New_York"), "2026-10-10");
  assert.equal(localDay("2026-10-11T04:30:00Z", "America/New_York"), "2026-10-11");
});

/* ---------------- event log ---------------- */

test("event log: stores events newest-first and redacts secrets", async () => {
  const db = makeD1();
  await logEvent(db, { actor: "svc.store_guard", kind: "a", summary: "one", data: { token: "abc", ok: 1 } });
  await logEvent(db, { actor: "pnl.pullers", kind: "b", summary: "two", costUsd: 0.25 });
  const ev = await recentEvents(db);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].summary, "two");
  assert.equal(ev[1].data.token, "[redacted]");
  assert.equal(ev[1].data.ok, 1);
  assert.equal(await costSince(db, "2000-01-01T00:00:00Z"), 0.25);
});

test("event log: unknown actors are logged but flagged", async () => {
  const db = makeD1();
  await logEvent(db, { actor: "mystery.worker", kind: "x", summary: "hi" });
  const [e] = await recentEvents(db);
  assert.equal(e.data._unknownActor, true);
});

test("event log: requires actor, kind, summary", async () => {
  await assert.rejects(logEvent(makeD1(), { actor: "a", kind: "b" }));
});

test("redact handles nested objects and arrays", () => {
  const r = redact({ a: [{ api_key: "x", n: 1 }], nested: { Authorization: "y" } });
  assert.equal(r.a[0].api_key, "[redacted]");
  assert.equal(r.a[0].n, 1);
  assert.equal(r.nested.Authorization, "[redacted]");
});

/* ---------------- freshness ---------------- */

test("freshness: states", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(feedState({ wired: 0 }, now), "not_wired");
  assert.equal(feedState({ wired: 1, last_ok_at: "2026-10-10T11:45:00Z", max_age_min: 30 }, now), "fresh");
  assert.equal(feedState({ wired: 1, last_ok_at: "2026-10-10T11:00:00Z", max_age_min: 30 }, now), "stale");
  assert.equal(
    feedState({ wired: 1, last_ok_at: "2026-10-10T11:50:00Z", last_try_at: "2026-10-10T11:55:00Z", last_error: "boom", max_age_min: 30 }, now),
    "failing"
  );
});

test("freshness: sentinel alarms once on change, not every run", async () => {
  const db = makeD1();
  const t0 = Date.parse("2026-10-10T12:00:00Z");
  await runSentinel(db, t0); // creates feeds as not_wired (quiet state events)
  await markFeedOk(db, "shopify.orders.hc", "2026-10-10T12:00:00Z");
  await runSentinel(db, t0 + 5 * 60000); // hc orders becomes fresh
  await runSentinel(db, t0 + 60 * 60000); // 60 min later: stale (limit 30)
  await runSentinel(db, t0 + 75 * 60000); // still stale — no new alarm
  const alarms = (await recentEvents(db)).filter((e) => e.kind === "feed.alarm" && e.data.feed === "shopify.orders.hc");
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].data.to, "stale");
});

test("freshness: a failure after success reads as failing", async () => {
  const db = makeD1();
  await runSentinel(db, Date.parse("2026-10-10T12:00:00Z"));
  await markFeedOk(db, "ads.spend.aub", "2026-10-10T12:00:00Z");
  await markFeedFailed(db, "ads.spend.aub", "HTTP 500", "2026-10-10T12:10:00Z");
  const f = (await evaluateFeeds(db, Date.parse("2026-10-10T12:11:00Z"))).find((x) => x.id === "ads.spend.aub");
  assert.equal(f.current, "failing");
});

/* ---------------- write verifier ---------------- */

test("write verifier: succeeds only when the read-back shows the change", async () => {
  let stored = 0;
  const ok = await verifiedWrite({
    write: async () => { stored = 5; return 200; }, read: async () => stored, expect: (v) => v === 5, sleep: async () => {},
  });
  assert.equal(ok.ok, true);

  const fake200 = await verifiedWrite({
    write: async () => 200, read: async () => 0, expect: (v) => v === 5, attempts: 3, sleep: async () => {},
  });
  assert.equal(fake200.ok, false); // a "200" that changed nothing is a failure
  assert.equal(fake200.attempts, 3);
});

test("write verifier: retries a lagging system", async () => {
  let reads = 0;
  const r = await verifiedWrite({
    write: async () => {}, read: async () => ++reads, expect: (v) => v >= 2, sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

/* ---------------- backup vault ---------------- */

test("backup vault: writes, confirms and reads back", async () => {
  const r2 = makeR2();
  const res = await backup(r2, { store: "hc", label: "prices before reprice", data: [{ id: 1, price: 49.95 }] });
  assert.equal(res.ok, true);
  assert.match(res.key, /^backups\/hc\//);
  const back = await readBackup(r2, res.key);
  assert.equal(back.data[0].price, 49.95);
});

test("backup vault: refuses to run without a bucket", async () => {
  await assert.rejects(backup(null, { store: "hc", label: "x", data: 1 }), /Refusing/);
});

/* ---------------- approvals ---------------- */

test("approvals: pending → approved, second tap does nothing", async () => {
  const db = makeD1();
  const id = await createApproval(db, {
    dept: "cs", requestedBy: "cs.reply_writer", title: "Send reply to order #1231",
    options: [{ id: "send", label: "Send as drafted" }],
  });
  assert.equal((await listPending(db)).length, 1);
  const first = await decide(db, id, { choice: "send", note: "looks good" });
  assert.equal(first.ok, true);
  assert.equal(first.status, "approved");
  const second = await decide(db, id, { choice: "reject" });
  assert.equal(second.ok, false);
  assert.equal(second.error, "already_approved");
  assert.equal((await listPending(db)).length, 0);
  const exec = await markExecuted(db, id, { ok: true, result: { verified: true } });
  assert.equal(exec.status, "executed");
});

test("approvals: invalid choices and option rules", async () => {
  const db = makeD1();
  await assert.rejects(createApproval(db, { dept: "cs", requestedBy: "x", title: "t", options: [] }));
  await assert.rejects(createApproval(db, { dept: "cs", requestedBy: "x", title: "t", options: [{ id: "reject", label: "no" }] }));
  const id = await createApproval(db, { dept: "cs", requestedBy: "x", title: "t", options: [{ id: "a", label: "A" }] });
  assert.equal((await decide(db, id, { choice: "zzz" })).error, "invalid_choice");
  assert.equal((await decide(db, 999, { choice: "a" })).error, "not_found");
});

test("approvals: signed phone links are bound to one approval, option, creation time and expiry", async () => {
  const ap = { id: 7, created_at: "2026-10-10T12:00:00.000Z" };
  const exp = Date.parse("2026-10-17T12:00:00Z");
  const now = Date.parse("2026-10-11T12:00:00Z");
  const sig = await signDecision("k", ap, "send", exp);
  assert.equal(await verifyDecisionSig("k", ap, "send", sig, exp, now), true);
  assert.equal(await verifyDecisionSig("k", ap, "reject", sig, exp, now), false);
  assert.equal(await verifyDecisionSig("k", { ...ap, id: 8 }, "send", sig, exp, now), false);
  // same id but a recreated ledger (different creation time) can't reuse the link
  assert.equal(await verifyDecisionSig("k", { ...ap, created_at: "2026-11-01T00:00:00.000Z" }, "send", sig, exp, now), false);
  assert.equal(await verifyDecisionSig("other", ap, "send", sig, exp, now), false);
  // expired, or expiry tampered with
  assert.equal(await verifyDecisionSig("k", ap, "send", sig, exp, exp + 1), false);
  assert.equal(await verifyDecisionSig("k", ap, "send", sig, exp + 86400000, now), false);
});

test("approvals: phone notify is a no-op until the phone is set up", async () => {
  const r = await notifyPhone({}, { id: 1, title: "t", options: [{ id: "a", label: "A" }] }, { baseUrl: "https://x" });
  assert.equal(r.sent, false);
});

const PO_ENV = { PUSHOVER_APP_TOKEN: "app-tok-xyz", PUSHOVER_USER_KEY: "user-key-abc", APPROVAL_SIGNING_KEY: "k" };
const poOk = (log) => async (url, init) => { log.push({ url, init }); return new Response('{"status":1,"request":"r"}', { status: 200 }); };

test("approvals: phone notify sends one signed page link through Pushover", async () => {
  const log = [];
  const r = await notifyPhone(PO_ENV,
    { id: 3, created_at: "2026-10-11T00:00:00Z", title: "Draft 4 denied products", options: [{ id: "draft", label: "Draft all 4" }] },
    { baseUrl: "https://brain.example", fetchImpl: poOk(log) });
  assert.equal(r.sent, true);
  assert.equal(log[0].url, "https://api.pushover.net/1/messages.json");
  const form = new URLSearchParams(log[0].init.body);
  assert.match(form.get("url"), /^https:\/\/brain\.example\/approve\/3\?exp=\d+&sig=[0-9a-f]{64}$/);
  assert.match(form.get("message"), /Draft all 4/);
});

/* ---------------- store guard ---------------- */

const ENV = {
  SB_HC_CLIENT_ID: "id-hc", SB_HC_CLIENT_SECRET: "secret-hc",
  SB_AUB_CLIENT_ID: "id-aub", SB_AUB_CLIENT_SECRET: "secret-aub",
};

function fakeShopify(reportedDomainFor) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/admin/oauth/access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-" + new URL(url).host, expires_in: 86399 }) };
    }
    const host = new URL(url).host;
    return { ok: true, status: 200, json: async () => ({ data: { shop: { myshopifyDomain: reportedDomainFor(host), name: "x" } } }) };
  };
  return { fetchImpl, calls };
}

test("store guard: refuses unknown, not-live and unwired stores", () => {
  assert.throws(() => storeCredentials(ENV, "nope"), (e) => e.code === "UNKNOWN_STORE");
  assert.throws(() => storeCredentials(ENV, "tund"), (e) => e.code === "STORE_NOT_LIVE");
  assert.throws(() => storeCredentials(ENV, "mar"), (e) => e.code === "NOT_WIRED");
});

test("store guard: writes run only when Shopify confirms the right shop", async () => {
  _resetTokenCacheForTests();
  const ok = fakeShopify((host) => host);
  let wrote = false;
  await guardedWrite(ENV, "hc", async () => { wrote = true; }, { fetchImpl: ok.fetchImpl });
  assert.equal(wrote, true);
});

test("store guard: a token for the wrong shop is a hard stop", async () => {
  _resetTokenCacheForTests();
  const bad = fakeShopify(() => "3as2ya-dw.myshopify.com"); // everything claims to be Auberlane
  let wrote = false;
  await assert.rejects(
    guardedWrite(ENV, "hc", async () => { wrote = true; }, { fetchImpl: bad.fetchImpl }),
    (e) => e instanceof StoreGuardError && e.code === "STORE_MISMATCH"
  );
  assert.equal(wrote, false);
});

test("store guard: tokens are cached per store", async () => {
  _resetTokenCacheForTests();
  const f = fakeShopify((h) => h);
  await getAccessToken(ENV, "hc", { fetchImpl: f.fetchImpl });
  await getAccessToken(ENV, "hc", { fetchImpl: f.fetchImpl });
  await getAccessToken(ENV, "aub", { fetchImpl: f.fetchImpl });
  assert.equal(f.calls.filter((u) => u.includes("access_token")).length, 2);
});

test("store guard: webhook HMAC check", async () => {
  const body = '{"id":1}';
  const good = createHmac("sha256", "s3cret").update(body).digest("base64");
  assert.equal(await verifyWebhookHmac(body, good, "s3cret"), true);
  assert.equal(await verifyWebhookHmac(body, good, "wrong"), false);
  assert.equal(await verifyWebhookHmac('{"id":2}', good, "s3cret"), false);
  assert.equal(await verifyWebhookHmac(body, "", "s3cret"), false);
});

/* ---------------- webhooks ---------------- */

const ORDER = {
  id: 1231, admin_graphql_api_id: "gid://shopify/Order/1231", name: "#1231",
  created_at: "2026-10-11T02:30:00Z", currency: "USD",
  current_subtotal_price: "129.90", current_total_discounts: "12.99", current_total_price: "116.91",
  financial_status: "paid",
};

test("webhooks: order parsing", () => {
  const o = parseOrder(ORDER);
  assert.equal(o.total, 116.91);
  assert.equal(o.order_id, "gid://shopify/Order/1231");
});

test("webhooks: refund amount comes from refund transactions, PENDING kept", () => {
  const r = parseRefund({
    id: 9, order_id: 1231, processed_at: "2026-10-10T15:00:00Z",
    transactions: [{ kind: "refund", amount: "48.95", status: "pending" }, { kind: "sale", amount: "999", status: "success" }],
  });
  assert.equal(r.amount, 48.95);
  assert.equal(r.status, "PENDING");
});

function webhookRequest(topic, domain, payload, secret) {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", secret).update(body).digest("base64");
  return new Request("https://brain.example/webhooks/shopify", {
    method: "POST", body,
    headers: { "x-shopify-topic": topic, "x-shopify-shop-domain": domain, "x-shopify-hmac-sha256": hmac },
  });
}

test("webhooks: a signed Auberlane order lands in the ledger, on the store's local day, and marks the feed fresh", async () => {
  const DB = makeD1();
  const env = { DB, TIMEZONE: "America/New_York", SB_AUB_CLIENT_SECRET: "aub-secret" };
  const res = await handleShopifyWebhook(webhookRequest("orders/create", "3as2ya-dw.myshopify.com", ORDER, "aub-secret"), env);
  assert.equal(res.status, 200);
  const row = await DB.prepare("SELECT * FROM orders").first();
  assert.equal(row.store, "aub");
  assert.equal(row.local_day, "2026-10-10");
  const feed = await DB.prepare("SELECT * FROM feeds WHERE id = 'shopify.orders.aub'").first();
  assert.equal(feed.wired, 1);
  assert.ok(feed.last_ok_at);
  const [ev] = await recentEvents(DB);
  assert.equal(ev.kind, "order.created");
  assert.match(ev.summary, /Auberlane #1231/);
});

test("webhooks: forged or cross-store signatures are rejected", async () => {
  const DB = makeD1();
  const env = { DB, SB_AUB_CLIENT_SECRET: "aub-secret", SB_HC_CLIENT_SECRET: "hc-secret" };
  // signed with H&C's secret but claiming to be Auberlane
  const res = await handleShopifyWebhook(webhookRequest("orders/create", "3as2ya-dw.myshopify.com", ORDER, "hc-secret"), env);
  assert.equal(res.status, 401);
  assert.equal(await DB.prepare("SELECT COUNT(*) AS n FROM orders").first().then((r) => r.n), 0);
  const unknown = await handleShopifyWebhook(webhookRequest("orders/create", "x.myshopify.com", ORDER, "aub-secret"), env);
  assert.equal(unknown.status, 404);
});

test("webhooks: the same order twice is one row (updates are upserts)", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  await handleShopifyWebhook(webhookRequest("orders/create", "jmzjx1-it.myshopify.com", ORDER, "hc-secret"), env);
  await handleShopifyWebhook(webhookRequest("orders/updated", "jmzjx1-it.myshopify.com", { ...ORDER, current_total_price: "100.00" }, "hc-secret"), env);
  const rows = (await DB.prepare("SELECT * FROM orders").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 100);
});

test("webhooks: tag-only updates are silent; money changes get one clear line", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  const send = (topic, body) => handleShopifyWebhook(webhookRequest(topic, "jmzjx1-it.myshopify.com", body, "hc-secret"), env);
  await send("orders/create", ORDER);
  await send("orders/updated", { ...ORDER, updated_at: "2026-10-11T03:00:00Z", tags: "kfb-sent" });
  await send("orders/updated", { ...ORDER, updated_at: "2026-10-11T03:05:00Z", note: "fulfilled" });
  let evs = (await recentEvents(DB)).filter((e) => e.kind.startsWith("order."));
  assert.equal(evs.length, 1, "only the creation is logged");
  assert.equal(evs[0].kind, "order.created");
  await send("orders/updated", { ...ORDER, updated_at: "2026-10-11T04:00:00Z", financial_status: "refunded", current_total_price: "0.00" });
  evs = (await recentEvents(DB)).filter((e) => e.kind === "order.updated");
  assert.equal(evs.length, 1);
  assert.match(evs[0].summary, /→ \$0\.00/);
  assert.match(evs[0].summary, /→ refunded/);
});

test("phone: test notification goes through Pushover; Pushover's own receipt is checked", async () => {
  assert.equal((await sendTestNotification({})).sent, false);
  const log = [];
  assert.equal((await sendTestNotification(PO_ENV, { fetchImpl: poOk(log) })).sent, true);
  assert.equal(new URLSearchParams(log[0].init.body).get("url"), null, "no link on a test");
  // HTTP 200 without status:1 is not a delivery.
  const r = await sendTestNotification(PO_ENV, { fetchImpl: async () => new Response('{"status":0}', { status: 200 }) });
  assert.equal(r.sent, false);
});

/* ---------------- worker routes ---------------- */

test("worker: /health is public; /api/state needs the key", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: "k".repeat(32) };
  const h = await worker.fetch(new Request("https://b.example/health"), env);
  assert.equal(h.status, 200);
  const denied = await worker.fetch(new Request("https://b.example/api/state"), env);
  assert.equal(denied.status, 401);
  const ok = await worker.fetch(new Request("https://b.example/api/state", { headers: { "x-store-brain-key": "k".repeat(32) } }), env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.agents.length, 48);
  assert.ok(body.feeds.length >= 10);
  assert.ok(body.feeds.every((f) => f.state === "not_wired"));
});

test("worker: the key is accepted from the header only, never the URL", async () => {
  const env = { DB: makeD1(), MC_KEY: "k".repeat(32) };
  const res = await worker.fetch(new Request(`https://b.example/api/state?key=${"k".repeat(32)}`), env);
  assert.equal(res.status, 401);
});

test("worker: API stays locked when no key is configured", async () => {
  const res = await worker.fetch(new Request("https://b.example/api/state?key="), { DB: makeD1() });
  assert.equal(res.status, 401);
});

test("worker: decisions via key or a signed link only", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: "x".repeat(32), APPROVAL_SIGNING_KEY: "sign" };
  const id = await createApproval(DB, { dept: "sup", requestedBy: "sup.denial_sync", title: "Draft 2", options: [{ id: "draft", label: "Draft both" }] });
  const exp = Date.now() + 3600000;
  const forged = await worker.fetch(new Request(`https://b.example/api/approvals/${id}/decide?choice=draft&exp=${exp}&sig=abc`, { method: "POST" }), env);
  assert.equal(forged.status, 401);
  // the key in a URL is no longer accepted (header only)
  const urlKey = await worker.fetch(new Request(`https://b.example/api/approvals/${id}/decide?choice=draft&key=${"x".repeat(32)}`, { method: "POST" }), env);
  assert.equal(urlKey.status, 401);
  const ap = await DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first();
  const sig = await signDecision("sign", ap, "draft", exp);
  const good = await worker.fetch(new Request(`https://b.example/api/approvals/${id}/decide?choice=draft&exp=${exp}&sig=${sig}`, { method: "POST" }), env);
  assert.equal(good.status, 200);
  const again = await worker.fetch(new Request(`https://b.example/api/approvals/${id}/decide?choice=draft&exp=${exp}&sig=${sig}`, { method: "POST" }), env);
  assert.equal(again.status, 409);
});

test("worker: cron runs the sentinel; day-close cron logs a marker", async () => {
  const DB = makeD1();
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await worker.scheduled({ cron: "*/15 * * * *" }, { DB }, ctx);
  await worker.scheduled({ cron: "0 5 * * *" }, { DB }, ctx);
  await Promise.all(waits);
  const ev = await recentEvents(DB);
  assert.ok(ev.some((e) => e.kind === "day.close"));
  // First run: feeds exist and are "not wired" — recorded silently, no alarm spam.
  const feeds = (await DB.prepare("SELECT * FROM feeds").all()).results;
  assert.ok(feeds.length >= 10);
  assert.ok(feeds.every((f) => f.state === "not_wired"));
  assert.equal(ev.filter((e) => e.actor === "svc.freshness").length, 0);
});

/* ---------------- review fixes ---------------- */

function webhookWithId(topic, domain, payload, secret, id) {
  const r = webhookRequest(topic, domain, payload, secret);
  const h = new Headers(r.headers); h.set("x-shopify-webhook-id", id);
  return new Request(r.url, { method: "POST", headers: h, body: JSON.stringify(payload) });
}

test("review: webhooks for a store that isn't live are acknowledged but store nothing", async () => {
  const DB = makeD1();
  const env = { DB, SB_TUND_CLIENT_SECRET: "tund-secret" };
  const res = await handleShopifyWebhook(webhookRequest("orders/create", "mek6yu-91.myshopify.com", ORDER, "tund-secret"), env);
  assert.equal(res.status, 200);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 0);
});

test("review: failed refund transactions are not counted as money refunded", () => {
  const r = parseRefund({ id: 1, order_id: 2, transactions: [
    { kind: "refund", amount: "50", status: "failure" }, { kind: "refund", amount: "50", status: "success" } ] });
  assert.equal(r.amount, 50);
  assert.equal(r.status, "FAILURE|SUCCESS");
});

test("review: an older orders/updated never overwrites newer data", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  const newer = { ...ORDER, updated_at: "2026-10-11T03:00:00Z", financial_status: "refunded", current_total_price: "0.00" };
  const older = { ...ORDER, updated_at: "2026-10-11T02:40:00Z", financial_status: "paid" };
  await handleShopifyWebhook(webhookRequest("orders/updated", "jmzjx1-it.myshopify.com", newer, "hc-secret"), env);
  await handleShopifyWebhook(webhookRequest("orders/updated", "jmzjx1-it.myshopify.com", older, "hc-secret"), env);
  const row = await DB.prepare("SELECT * FROM orders").first();
  assert.equal(row.financial_status, "refunded");
});

test("review: a re-delivered webhook (same id) is processed once", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  const a = await handleShopifyWebhook(webhookWithId("orders/create", "jmzjx1-it.myshopify.com", ORDER, "hc-secret", "wh-1"), env);
  const b = await handleShopifyWebhook(webhookWithId("orders/create", "jmzjx1-it.myshopify.com", ORDER, "hc-secret", "wh-1"), env);
  assert.equal(await a.text(), "ok");
  assert.equal(await b.text(), "duplicate");
  assert.equal((await recentEvents(DB)).filter((e) => e.kind === "order.created").length, 1);
});

test("review: two stores sharing one app secret is refused", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "same", SB_AUB_CLIENT_SECRET: "same" };
  const res = await handleShopifyWebhook(webhookRequest("orders/create", "3as2ya-dw.myshopify.com", ORDER, "same"), env);
  assert.equal(res.status, 500);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 0);
});

test("review: a malformed order is rejected with 400, not retried forever", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  const { created_at, ...noDate } = ORDER;
  const res = await handleShopifyWebhook(webhookRequest("orders/create", "jmzjx1-it.myshopify.com", noDate, "hc-secret"), env);
  assert.equal(res.status, 400);
});

test("review: an unknown order total is shown as unknown, not $0.00", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_SECRET: "hc-secret" };
  const { current_total_price, ...noTotal } = ORDER;
  await handleShopifyWebhook(webhookRequest("orders/create", "jmzjx1-it.myshopify.com", noTotal, "hc-secret"), env);
  const [ev] = await recentEvents(DB);
  assert.match(ev.summary, /amount unknown/);
});

test("review: markExecuted only counts once", async () => {
  const db = makeD1();
  const id = await createApproval(db, { dept: "cs", requestedBy: "x", title: "t", options: [{ id: "a", label: "A" }] });
  await decide(db, id, { choice: "a" });
  assert.equal((await markExecuted(db, id, { ok: true })).ok, true);
  assert.equal((await markExecuted(db, id, { ok: true })).ok, false);
});

/* ---------------- reconciliation ---------------- */
import { reconcileOrders, orderFromNode } from "../src/lib/reconcile.js";

function reconEnv(nodesByHost) {
  _resetTokenCacheForTests();
  const fetchImpl = async (url) => {
    if (url.endsWith("/admin/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 86399 }) };
    const host = new URL(url).host;
    if (nodesByHost[host] === "fail") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { orders: { nodes: nodesByHost[host] || [] } } }) };
  };
  return { fetchImpl };
}
const node = (n, total) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: "2026-10-11T14:00:00Z", updatedAt: "2026-10-11T14:05:00Z",
  currencyCode: "USD", displayFinancialStatus: "PAID", currentTotalPriceSet: { shopMoney: { amount: total } } });

test("reconcile: first pull imports quietly; later misses are flagged; feed goes fresh", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b", SB_AUB_CLIENT_ID: "c", SB_AUB_CLIENT_SECRET: "d", SB_MAR_CLIENT_ID: "e", SB_MAR_CLIENT_SECRET: "f" };
  const first = reconEnv({ "jmzjx1-it.myshopify.com": [node(1, "50.00"), node(2, "60.00")] });
  await reconcileOrders(env, first);
  let ev = await recentEvents(DB);
  assert.equal(ev.filter((e) => e.kind === "order.backfilled").length, 0);
  assert.equal(ev.filter((e) => e.kind === "orders.imported").length, 1);
  const second = reconEnv({ "jmzjx1-it.myshopify.com": [node(3, "70.00"), node(2, "60.00")], "806080-g8.myshopify.com": "fail" });
  const r = await reconcileOrders(env, second);
  ev = await recentEvents(DB);
  assert.equal(ev.filter((e) => e.kind === "order.backfilled").length, 1);
  const feeds = await evaluateFeeds(DB);
  assert.equal(feeds.find((f) => f.id === "shopify.orders.hc").current, "fresh");
  assert.equal(feeds.find((f) => f.id === "shopify.orders.mar").current, "failing");
  assert.equal(r.find((x) => x.store === "mar").ok, false);
});

test("reconcile: a money change found by the pull is logged (the late webhook will find nothing new)", async () => {
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b", SB_AUB_CLIENT_ID: "c", SB_AUB_CLIENT_SECRET: "d", SB_MAR_CLIENT_ID: "e", SB_MAR_CLIENT_SECRET: "f" };
  await reconcileOrders(env, reconEnv({ "jmzjx1-it.myshopify.com": [node(5, "100.00")] }));
  await reconcileOrders(env, reconEnv({ "jmzjx1-it.myshopify.com": [node(5, "100.00")] }));
  assert.equal((await recentEvents(DB)).filter((e) => e.kind === "order.updated").length, 0, "no change, no line");
  await reconcileOrders(env, reconEnv({ "jmzjx1-it.myshopify.com": [node(5, "0.00")] }));
  const ups = (await recentEvents(DB)).filter((e) => e.kind === "order.updated");
  assert.equal(ups.length, 1);
  assert.match(ups[0].summary, /\$100\.00 → \$0\.00/);
});

test("phone: failures never echo the keys", async () => {
  const fetchImpl = async (url, init) => { throw new Error(`failed: ${init.body}`); };
  const r = await sendTestNotification(PO_ENV, { fetchImpl });
  const bad = await sendTestNotification(PO_ENV, { fetchImpl: async () => new Response('{"status":0,"errors":["token app-tok-xyz is invalid"]}', { status: 400 }) });
  for (const x of [r, bad]) {
    assert.equal(x.sent, false);
    assert.ok(!/app-tok-xyz|user-key-abc/.test(JSON.stringify(x)));
  }
});

test("phone page: signed link shows choices; bad link refused; decided approvals say so", async () => {
  const DB = makeD1();
  const env = { DB, APPROVAL_SIGNING_KEY: "k" };
  const id = await createApproval(DB, { dept: "cs", requestedBy: "cs.drafter", title: "Send <reply> to #1001", options: [{ id: "send", label: "Send it", detail: "as drafted" }] });
  const ap = await getApproval(DB, id);
  const exp = Date.now() + 60000;
  const sig = await signDecision("k", ap, "view", exp);
  const ok = await handleApprovalPage(new Request(`https://b.example/approve/${id}?exp=${exp}&sig=${sig}`), env, id);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /Send &lt;reply&gt; to #1001/, "title is escaped");
  assert.match(html, /choice=send&amp;exp=/);
  assert.match(html, /choice=reject&amp;exp=/);
  const forged = await handleApprovalPage(new Request(`https://b.example/approve/${id}?exp=${exp}&sig=${"0".repeat(64)}`), env, id);
  assert.equal(forged.status, 403);
  // the "view" signature can't be used to decide
  const misuse = await decide(DB, id, { choice: "view" });
  assert.equal(misuse.ok, false);
  await decide(DB, id, { choice: "send" });
  const after = await (await handleApprovalPage(new Request(`https://b.example/approve/${id}?exp=${exp}&sig=${sig}`), env, id)).text();
  assert.match(after, /Already decided: <b>Send it<\/b>/);
  await assert.rejects(createApproval(DB, { dept: "x", requestedBy: "y", title: "t", options: [{ id: "view", label: "V" }] }));
});

test("reconcile: GraphQL order maps to the webhook shape", () => {
  const o = orderFromNode(node(9, "12.34"));
  assert.equal(o.total, 12.34);
  assert.equal(o.financial_status, "paid");
});

test("worker: /api/agents/:id/events needs the key, knows only real agents, returns its events", async () => {
  const { makeD1 } = await import("./helpers/d1.js");
  const { logEvent } = await import("../src/lib/eventlog.js");
  const DB = makeD1();
  const env = { DB, MC_KEY: "k".repeat(32) };
  await logEvent(DB, { actor: "sup.relay", kind: "kfb.drafted", summary: "drafted", target: "sys.phone" });
  await logEvent(DB, { actor: "ful.tracking", kind: "x", summary: "other" });
  const h = { headers: { "x-store-brain-key": "k".repeat(32) } };
  assert.equal((await worker.fetch(new Request("https://b/api/agents/sup.relay/events"), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://b/api/agents/sup.nobody/events", h), env)).status, 404);
  const j = await (await worker.fetch(new Request("https://b/api/agents/sup.relay/events", h), env)).json();
  assert.equal(j.ok, true);
  assert.equal(j.events.length, 1);
  assert.equal(j.week.events, 1);
});

test("dashboard page: its script parses (a stray quote would leave Reilly with a blank page)", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "inline script present");
  assert.doesNotThrow(() => new Function(m[1]));
});

test("departments: the 5-minute cron runs one department per slot, every department at least hourly; /api/dept needs the key", async () => {
  const { ROTATION, departmentForMinute, DEPARTMENTS_RUN } = await import("../src/agents/index.js");
  for (const d of Object.keys(DEPARTMENTS_RUN)) assert.ok(ROTATION.includes(d), `${d} runs every hour`);
  assert.equal(departmentForMinute(1), ROTATION[0]);
  assert.equal(departmentForMinute(56), ROTATION[11]);
  const { makeD1 } = await import("./helpers/d1.js");
  const DB = makeD1();
  const env = { DB, MC_KEY: "k".repeat(32) };
  assert.equal((await worker.fetch(new Request("https://b/api/dept/cs"), env)).status, 401);
  const h = { headers: { "x-store-brain-key": "k".repeat(32) } };
  assert.equal((await worker.fetch(new Request("https://b/api/dept/nope", h), env)).status, 404);
  for (const d of Object.keys(DEPARTMENTS_RUN)) {
    const r = await worker.fetch(new Request(`https://b/api/dept/${d}`, h), env);
    assert.equal(r.status, 200, d);
  }
  // The cron slot never throws, even with no network and nothing wired.
  let p; const ctx = { waitUntil: (x) => { p = x; } };
  await worker.scheduled({ cron: (await import("../src/agents/index.js")).DEPT_CRON, scheduledTime: Date.now() }, { DB }, ctx);
  await p;
});
