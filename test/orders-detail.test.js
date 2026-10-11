import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeD1 } from "./helpers/d1.js";

import { handleShopifyWebhook, parseOrder } from "../src/lib/shopifyWebhooks.js";
import { reconcileOrders, orderFromNode, ORDER_LINES } from "../src/lib/reconcile.js";
import { isExpressShipping, sizeAndColor, linesFromWebhook, linesFromNode } from "../src/lib/orderLines.js";
import {
  runKfbComposer, composeExpressBody, signKfb, verifyKfbSig, easternClock, getKfbMessage,
} from "../src/lib/kfbMessage.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { recentEvents } from "../src/lib/eventlog.js";
import { markFeedOk } from "../src/lib/freshness.js";
import worker from "../src/index.js";

/* ---------------- fixtures ---------------- */

const HC = "jmzjx1-it.myshopify.com";
const AUB = "3as2ya-dw.myshopify.com";

function webhookRequest(topic, domain, payload, secret) {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", secret).update(body).digest("base64");
  return new Request("https://brain.example/webhooks/shopify", {
    method: "POST", body,
    headers: { "x-shopify-topic": topic, "x-shopify-shop-domain": domain, "x-shopify-hmac-sha256": hmac },
  });
}

const restOrder = (n, { express = false, created = "2026-10-11T15:00:00Z", updated = null } = {}) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`,
  created_at: created, updated_at: updated || created, currency: "USD",
  current_subtotal_price: "89.90", current_total_discounts: "0.00", current_total_price: "89.90",
  financial_status: "paid",
  shipping_lines: [express ? { title: "Express Shipping (3-5 days)", code: "EXPRESS" } : { title: "Standard Shipping", code: "Standard" }],
  line_items: [
    { id: n * 10 + 1, admin_graphql_api_id: `gid://shopify/LineItem/${n * 10 + 1}`, product_id: 555, variant_id: 777,
      sku: "HC-WBLZ-006-NV-L", title: "Wool Blazer", variant_title: "Navy / L", quantity: 1, price: "89.90" },
  ],
});

const SECRETS = { SB_HC_CLIENT_SECRET: "hc-secret", SB_AUB_CLIENT_SECRET: "aub-secret" };
const send = (env, domain, payload, topic = "orders/create") =>
  handleShopifyWebhook(webhookRequest(topic, domain, payload, domain === HC ? "hc-secret" : "aub-secret"), env);

const ET = (hhmm, day = "2026-10-11") => Date.parse(`${day}T${hhmm}:00-04:00`); // October = EDT

const PO = { PUSHOVER_APP_TOKEN: "app-tok", PUSHOVER_USER_KEY: "user-key", APPROVAL_SIGNING_KEY: "sign" };
const poLog = (log) => async (url, init) => { log.push({ url, init }); return new Response('{"status":1}', { status: 200 }); };

/* ---------------- size, colour, express ---------------- */

test("size/colour: picks the option that looks like a size from the variant title", () => {
  assert.deepEqual(sizeAndColor({ variantTitle: "Navy / L" }), { size: "L", color: "Navy" });
  assert.deepEqual(sizeAndColor({ variantTitle: "3XL / Charcoal" }), { size: "3XL", color: "Charcoal" });
  assert.deepEqual(sizeAndColor({ variantTitle: "XXL" }), { size: "XXL", color: null });
  assert.deepEqual(sizeAndColor({ variantTitle: "Black / 32" }), { size: "32", color: "Black" });
  assert.deepEqual(sizeAndColor({ variantTitle: "Default Title" }), { size: null, color: null });
  assert.deepEqual(sizeAndColor({ variantTitle: "Cream" }), { size: null, color: "Cream" });
});

test("size/colour: named options win over guessing", () => {
  const r = sizeAndColor({
    variantTitle: "L / Navy",
    options: [{ name: "Colour", value: "Navy" }, { name: "Size", value: "L" }],
  });
  assert.deepEqual(r, { size: "L", color: "Navy" });
  // A named Size option is trusted even when its value isn't a standard label.
  assert.equal(sizeAndColor({ options: [{ name: "Size", value: "One size" }] }).size, "One size");
});

test("express: matches the shipping title or code, case-insensitive", () => {
  assert.equal(isExpressShipping("Express Shipping", null), true);
  assert.equal(isExpressShipping("Shipping", "EXPRESS-3D"), true);
  assert.equal(isExpressShipping("Standard Shipping", "standard"), false);
  assert.equal(isExpressShipping(null, null), false);
});

/* ---------------- capture: webhook ---------------- */

test("webhook: line items and shipping method are captured", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS };
  const res = await send(env, HC, restOrder(1231, { express: true }));
  assert.equal(res.status, 200);
  const o = await DB.prepare("SELECT * FROM orders").first();
  assert.equal(o.shipping_title, "Express Shipping (3-5 days)");
  assert.equal(o.shipping_code, "EXPRESS");
  assert.equal(o.express, 1);
  const lines = (await DB.prepare("SELECT * FROM order_lines").all()).results;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line_id, "gid://shopify/LineItem/12311");
  assert.equal(lines[0].product_id, "gid://shopify/Product/555");
  assert.equal(lines[0].variant_id, "gid://shopify/ProductVariant/777");
  assert.equal(lines[0].size, "L");
  assert.equal(lines[0].color, "Navy");
  assert.equal(lines[0].price, 89.9);
  assert.equal(lines[0].quantity, 1);
});

test("webhook: parseOrder stores updated_at as UTC so webhook and pull times compare correctly", () => {
  const o = parseOrder({ ...restOrder(1), updated_at: "2026-10-10T22:30:00-04:00" });
  assert.equal(o.payload_updated_at, "2026-10-11T02:30:00.000Z");
});

test("webhook: an older payload never replaces newer lines; removed lines go", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS };
  const base = restOrder(1300, { updated: "2026-10-11T16:00:00Z" });
  const newer = { ...base, line_items: [{ ...base.line_items[0], variant_title: "Navy / XL" }] };
  await send(env, HC, newer, "orders/updated");
  const older = { ...base, updated_at: "2026-10-11T15:30:00Z", line_items: [...base.line_items, { ...base.line_items[0], id: 99, admin_graphql_api_id: "gid://shopify/LineItem/99" }] };
  await send(env, HC, older, "orders/updated");
  let lines = (await DB.prepare("SELECT * FROM order_lines").all()).results;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].size, "XL");
  // A newer edit that drops the line leaves no orphan row.
  await send(env, HC, { ...base, updated_at: "2026-10-11T17:00:00Z", line_items: [] }, "orders/updated");
  lines = (await DB.prepare("SELECT * FROM order_lines").all()).results;
  assert.equal(lines.length, 0);
});

/* ---------------- capture: GraphQL pull ---------------- */

const gqlLines = (n) => ({
  lineItems: { nodes: [{
    id: `gid://shopify/LineItem/${n}1`, name: "Wool Blazer - L / Navy", title: "Wool Blazer", sku: "HC-WBLZ-006",
    quantity: 2, variantTitle: "L / Navy", originalUnitPriceSet: { shopMoney: { amount: "79.95" } },
    variant: { id: "gid://shopify/ProductVariant/777", selectedOptions: [{ name: "Size", value: "L" }, { name: "Color", value: "Navy" }] },
    product: { id: "gid://shopify/Product/555", handle: "wool-blazer" },
  }] },
});
const gqlOrder = (n, { express = false, updatedAt = "2026-10-11T14:05:00Z" } = {}) => ({
  id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: "2026-10-11T14:00:00Z", updatedAt,
  currencyCode: "USD", displayFinancialStatus: "PAID", currentTotalPriceSet: { shopMoney: { amount: "159.90" } },
  shippingLine: express ? { title: "Express", code: "express" } : { title: "Standard", code: "standard" },
});

test("GraphQL node: shipping, lines, selectedOptions and handle map to the ledger shape", () => {
  const o = orderFromNode({ ...gqlOrder(5, { express: true }), ...gqlLines(5) });
  assert.equal(o.express, 1);
  assert.equal(o.shipping_title, "Express");
  const [l] = linesFromNode(gqlLines(5));
  assert.equal(l.product_handle, "wool-blazer");
  assert.equal(l.size, "L");
  assert.equal(l.color, "Navy");
  assert.equal(l.price, 79.95);
  assert.equal(l.quantity, 2);
  assert.equal(linesFromWebhook({}), null, "no line list = leave stored lines alone");
});

function pullEnv() {
  return { DB: makeD1(), SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b", SB_AUB_CLIENT_ID: "c", SB_AUB_CLIENT_SECRET: "d", SB_MAR_CLIENT_ID: "e", SB_MAR_CLIENT_SECRET: "f" };
}
function fakeShop(ordersByHost) {
  _resetTokenCacheForTests();
  const lineCalls = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/admin/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 86399 }) };
    const host = new URL(url).host;
    const { query, variables } = JSON.parse(init.body);
    if (query === ORDER_LINES) {
      lineCalls.push(variables.ids);
      const nodes = variables.ids.map((id) => {
        const n = (ordersByHost[host] || []).find((x) => x.id === id);
        return n ? { id, updatedAt: n.updatedAt, ...gqlLines(id.split("/").pop()) } : null;
      });
      return { ok: true, status: 200, json: async () => ({ data: { nodes } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { orders: { nodes: ordersByHost[host] || [] } } }) };
  };
  return { fetchImpl, lineCalls };
}

test("pull: lines are read only for orders whose lines are behind, in small batches", async () => {
  const env = pullEnv();
  const orders = [1, 2, 3, 4, 5].map((n) => gqlOrder(n, { express: n === 3 }));
  const shop = fakeShop({ [HC]: orders });
  await reconcileOrders(env, shop);
  assert.equal(shop.lineCalls.length, 2, "5 orders → batches of 4 + 1");
  assert.ok(shop.lineCalls.every((ids) => ids.length <= 4));
  const lines = (await env.DB.prepare("SELECT * FROM order_lines WHERE store = 'hc'").all()).results;
  assert.equal(lines.length, 5);
  assert.equal(lines[0].product_handle, "wool-blazer");
  const exp = await env.DB.prepare("SELECT name FROM orders WHERE express = 1").all();
  assert.deepEqual(exp.results.map((r) => r.name), ["#3"]);
  // Nothing changed: no line calls at all on the next run.
  const again = fakeShop({ [HC]: orders });
  await reconcileOrders(env, again);
  assert.equal(again.lineCalls.length, 0);
  // One order changes: only that order's lines are re-read.
  const later = fakeShop({ [HC]: [gqlOrder(2, { updatedAt: "2026-10-11T18:00:00Z" }), ...orders.filter((o) => o.id !== "gid://shopify/Order/2")] });
  await reconcileOrders(env, later);
  assert.deepEqual(later.lineCalls, [["gid://shopify/Order/2"]]);
  // The first pull stayed quiet: one import line, no backfill noise.
  const ev = await recentEvents(env.DB);
  assert.equal(ev.filter((e) => e.kind === "order.backfilled").length, 0);
  assert.equal(ev.filter((e) => e.kind === "orders.imported").length, 1);
});

test("pull: a webhook's handle-less lines don't erase the handle the pull found", async () => {
  const env = { ...pullEnv(), ...SECRETS };
  await reconcileOrders(env, fakeShop({ [HC]: [gqlOrder(1400)] }));
  const rest = restOrder(1400, { updated: "2026-10-11T19:00:00Z" });
  rest.line_items[0].id = 14001; rest.line_items[0].admin_graphql_api_id = "gid://shopify/LineItem/14001";
  await send(env, HC, rest, "orders/updated");
  const l = await env.DB.prepare("SELECT * FROM order_lines WHERE line_id = 'gid://shopify/LineItem/14001'").first();
  assert.equal(l.product_handle, "wool-blazer");
  assert.equal(l.size, "L");
});

/* ---------------- KFB composer ---------------- */

test("composer: message always names the store, orders sorted by store", () => {
  const body = composeExpressBody([
    { store: "aub", order_name: "#1062" }, { store: "hc", order_name: "#1231" },
  ]);
  assert.equal(body, "Please add express shipping to these orders:\n• Holt & Crane #1231\n• Auberlane #1062");
  assert.equal(composeExpressBody([]), null);
});

test("composer: Eastern clock", () => {
  assert.deepEqual(easternClock(ET("18:45")), { day: "2026-10-11", minutes: 18 * 60 + 45 });
  assert.equal(easternClock(Date.parse("2026-10-12T02:00:00Z")).day, "2026-10-11");
});

test("composer: once per Eastern day after 18:45, never repeats an order, nothing → no message", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS };
  await send(env, HC, restOrder(1231, { express: true }));
  await send(env, AUB, restOrder(1062, { express: true }));
  await send(env, HC, restOrder(1232)); // standard shipping: never asked

  assert.equal((await runKfbComposer(env, { nowMs: ET("18:30") })).ran, false, "too early");
  const first = await runKfbComposer(env, { nowMs: ET("18:45") });
  assert.equal(first.ran, true);
  assert.equal(first.body, "Please add express shipping to these orders:\n• Holt & Crane #1231\n• Auberlane #1062");
  assert.equal((await runKfbComposer(env, { nowMs: ET("19:00") })).reason, "already ran today");

  // A new express order the same evening waits for tomorrow; yesterday's are never repeated.
  await send(env, HC, restOrder(1233, { express: true, created: "2026-10-11T23:30:00Z" }));
  const next = await runKfbComposer(env, { nowMs: ET("18:50", "2026-10-12") });
  assert.equal(next.body, "Please add express shipping to these orders:\n• Holt & Crane #1233");

  const empty = await runKfbComposer(env, { nowMs: ET("19:15", "2026-10-13") });
  assert.equal(empty.ran, true);
  assert.equal(empty.messageId, null);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM kfb_messages").first()).n, 2);
  const ev = await recentEvents(DB);
  assert.ok(ev.some((e) => e.kind === "kfb.nothing_to_ask"));
  // UNIQUE (store, order, kind) holds in the ledger too.
  await assert.rejects(DB.prepare("INSERT INTO kfb_message_items (message_id, store, order_id, kind) VALUES (9, 'hc', 'gid://shopify/Order/1231', 'express')").run());
});

test("composer: old imported express orders and refunded orders are not asked about", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS };
  await send(env, HC, restOrder(900, { express: true, created: "2026-09-20T15:00:00Z" }));
  await send(env, HC, { ...restOrder(901, { express: true }), financial_status: "refunded" });
  const r = await runKfbComposer(env, { nowMs: ET("18:45") });
  assert.equal(r.messageId, null);
});

test("composer: shadow mode (default) saves and logs but sends nothing to the phone", async () => {
  const DB = makeD1();
  const log = [];
  const env = { DB, ...SECRETS, ...PO, PUBLIC_BASE_URL: "https://brain.example" };
  await send(env, HC, restOrder(1231, { express: true }));
  const r = await runKfbComposer(env, { nowMs: ET("18:45"), fetchImpl: poLog(log) });
  assert.equal(r.mode, "shadow");
  assert.equal(log.length, 0, "no phone call in shadow mode");
  const msg = await getKfbMessage(DB, r.messageId);
  assert.equal(msg.status, "draft");
  assert.equal(msg.mode, "shadow");
  const [ev] = (await recentEvents(DB)).filter((e) => e.kind === "kfb.message_drafted");
  assert.match(ev.summary, /shadow/);
  assert.match(ev.summary, /Holt & Crane #1231/);
  assert.match(ev.summary, /may be missing/, "orders feeds aren't all fresh, so it says so");
});

test("composer: live mode sends one signed link to the copy page", async () => {
  const DB = makeD1();
  const log = [];
  const env = { DB, ...SECRETS, ...PO, PUBLIC_BASE_URL: "https://brain.example/", SUPPLIER_MESSAGES_LIVE: "1" };
  await send(env, HC, restOrder(1231, { express: true }));
  for (const s of ["hc", "aub", "mar"]) await markFeedOk(DB, `shopify.orders.${s}`, new Date(ET("18:40")).toISOString());
  const r = await runKfbComposer(env, { nowMs: ET("18:45"), fetchImpl: poLog(log) });
  assert.equal(r.mode, "live");
  assert.equal(r.phone.sent, true);
  assert.equal(log.length, 1);
  const form = new URLSearchParams(log[0].init.body);
  assert.match(form.get("url"), new RegExp(`^https://brain\\.example/kfb/${r.messageId}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  assert.match(form.get("message"), /Holt & Crane #1231/);
  assert.doesNotMatch(form.get("message"), /may be missing/, "feeds fresh, no warning");
  assert.equal((await getKfbMessage(DB, r.messageId)).status, "notified");
});

test("composer: live mode without a public address records the failure instead of guessing", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS, ...PO, SUPPLIER_MESSAGES_LIVE: "1" };
  await send(env, HC, restOrder(1231, { express: true }));
  const r = await runKfbComposer(env, { nowMs: ET("18:45"), fetchImpl: poLog([]) });
  assert.equal(r.phone.sent, false);
  assert.ok((await recentEvents(DB)).some((e) => e.kind === "kfb.notify_failed"));
  assert.equal((await getKfbMessage(DB, r.messageId)).status, "draft");
});

/* ---------------- signed page + Mark sent ---------------- */

async function composedEnv() {
  const DB = makeD1();
  const env = { DB, ...SECRETS, APPROVAL_SIGNING_KEY: "sign", MC_KEY: "m".repeat(32) };
  await send(env, HC, restOrder(1231, { express: true }));
  const r = await runKfbComposer(env, { nowMs: ET("18:45") });
  return { env, msg: await getKfbMessage(DB, r.messageId) };
}

test("kfb page: a good signature shows the message with Copy and Mark sent; forged ones are refused", async () => {
  const { env, msg } = await composedEnv();
  const exp = Date.now() + 3600000;
  const sig = await signKfb("sign", msg, "view", exp);
  const ok = await worker.fetch(new Request(`https://b.example/kfb/${msg.id}?exp=${exp}&sig=${sig}`), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.match(ok.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await ok.text();
  assert.match(html, /Holt &amp; Crane #1231/);
  assert.match(html, /navigator\.clipboard/);
  assert.match(html, new RegExp(`/api/kfb/${msg.id}/sent\\?exp=`));
  const forged = await worker.fetch(new Request(`https://b.example/kfb/${msg.id}?exp=${exp}&sig=${"0".repeat(64)}`), env);
  assert.equal(forged.status, 403);
  const expired = await worker.fetch(new Request(`https://b.example/kfb/${msg.id}?exp=${Date.now() - 1}&sig=${await signKfb("sign", msg, "view", Date.now() - 1)}`), env);
  assert.equal(expired.status, 403);
  // Bound to the message id and creation time.
  assert.equal(await verifyKfbSig("sign", { ...msg, created_at: "2027-01-01T00:00:00Z" }, "view", sig, exp), false);
});

test("kfb Mark sent: needs the 'sent' signature (not 'view'), and records once", async () => {
  const { env, msg } = await composedEnv();
  const exp = Date.now() + 3600000;
  const viewSig = await signKfb("sign", msg, "view", exp);
  const misuse = await worker.fetch(new Request(`https://b.example/api/kfb/${msg.id}/sent?exp=${exp}&sig=${viewSig}`, { method: "POST" }), env);
  assert.equal(misuse.status, 401);
  const sentSig = await signKfb("sign", msg, "sent", exp);
  const url = `https://b.example/api/kfb/${msg.id}/sent?exp=${exp}&sig=${sentSig}`;
  const first = await worker.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(first.status, 200);
  const second = await worker.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "already_sent");
  const row = await getKfbMessage(env.DB, msg.id);
  assert.equal(row.status, "sent");
  assert.ok(row.sent_at);
  assert.equal((await recentEvents(env.DB)).filter((e) => e.kind === "kfb.message_sent").length, 1);
  // Mission Control (key) gets the same single-shot answer.
  const viaKey = await worker.fetch(new Request(`https://b.example/api/kfb/${msg.id}/sent`, { method: "POST", headers: { "x-store-brain-key": "m".repeat(32) } }), env);
  assert.equal(viaKey.status, 409);
});

test("state: Mission Control gets the latest KFB messages and today's express orders", async () => {
  const DB = makeD1();
  const env = { DB, ...SECRETS, MC_KEY: "m".repeat(32) };
  const today = new Date().toISOString();
  await send(env, HC, restOrder(1500, { express: true, created: today }));
  await runKfbComposer(env, { nowMs: ET("18:45") });
  const res = await worker.fetch(new Request("https://b.example/api/state", { headers: { "x-store-brain-key": "m".repeat(32) } }), env);
  const body = await res.json();
  assert.equal(body.supplier.mode, "shadow");
  assert.ok(Array.isArray(body.supplier.kfbMessages));
  assert.ok(body.supplier.expressToday.some((o) => o.name === "#1500" && o.store_name === "Holt & Crane"));
});

test("review fix: a same-moment payload refreshes legacy rows stored as '…00Z' (shipping + express backfill)", async () => {
  const { makeD1 } = await import("./helpers/d1.js");
  const { upsertOrder } = await import("../src/lib/shopifyWebhooks.js");
  const DB = makeD1();
  const store = { id: "hc", name: "Holt & Crane", timezone: "America/New_York" };
  // Legacy row as the old pull wrote it: no milliseconds, no shipping info.
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, payload_updated_at, updated_at)
    VALUES ('hc','gid://shopify/Order/9','#1300','2026-10-11T02:00:00Z','2026-10-10',50,'2026-10-11T02:30:00Z','x')`).run();
  const res = await upsertOrder(DB, store, {
    order_id: "gid://shopify/Order/9", name: "#1300", created_at: "2026-10-11T02:00:00Z", total: 50,
    payload_updated_at: "2026-10-11T02:30:00.000Z", shipping_title: "Express Shipping", shipping_code: "express", express: 1,
  }, "{}", "America/New_York", "2026-10-11T03:00:00Z");
  const row = await DB.prepare(`SELECT express, shipping_title FROM orders WHERE order_id='gid://shopify/Order/9'`).first();
  assert.equal(row.express, 1);
  assert.equal(row.shipping_title, "Express Shipping");
  assert.equal(res.isNew, false);
});
