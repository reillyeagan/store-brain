import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeD1, makeR2 } from "./helpers/d1.js";

import {
  validatePayload, importKfb, normShopCode, storeForShopCode, shopCodeOf, kfbTime, parseOrderNo,
  normalizeQuoteRow, normalizeOrderRow, normalizeBills, quoteCost, runKfbReminder, billPaidState,
} from "../src/lib/kfbImport.js";
import { kfbImportStatus } from "../src/lib/kfbReads.js";
import { KFB_ORIGINS, DASHBOARD_ORIGIN, KFB_ENDPOINTS, KFB_IMPORT_MAX_ROWS } from "../src/config/kfb.js";
import { evaluateFeeds } from "../src/lib/freshness.js";
import { sweepStatus, runOrderWatch } from "../src/agents/fulfillment/orderWatch.js";
import { upsertOrder } from "../src/lib/shopifyWebhooks.js";
import { STORES } from "../src/config/stores.js";
import { matchBills } from "../src/agents/pnl/cogs.js";
import { digestData, digestBody } from "../src/agents/supplier/digest.js";
import { detectCancelledBilled } from "../src/agents/supplier/claims.js";
import { plainBrief, gatherBriefData } from "../src/lib/brief.js";
import worker from "../src/index.js";

const NOW = Date.parse("2026-10-14T13:30:00Z"); // 09:30 Eastern
const iso = (ms) => new Date(ms).toISOString();
const KEY = "k".repeat(32);

/* ---------------- sample KFB rows, shaped like the vault describes them ---------------- */
const quoteRows = () => [
  { order_no: "AT2026081154968AT0735-995478", status: 30, un_shop_url: "jmzjx1-it", update_time: "2026-10-13 09:15:00", order_remark: "",
    items: [{ un_good_url: "https://holtandcrane.com/products/belted-trench", un_good_id: "9778258051307", un_good_sku: "LF-1", un_good_price: "89.95" }],
    product: [{ manual_pricing: { "United States": { nameOne: "15.47", nameTwo: 0 } } }] },
  { order_no: "Q-2", status: 40, un_shop_url: "jmzjx1-it.myshopify.com", update_time: "2026-10-12 08:00:00",
    items: [{ un_good_url: "https://holtandcrane.com/products/wool-coat" }], product: [{ manual_pricing: { "United States": { nameOne: 20 } } }] },
  { order_no: "Q-3", status: "26", un_shop_url: "3as2ya-dw", update_time: "2026-10-12 08:00:00", order_remark: "no supplier",
    items: [{ un_good_url: "https://auberlane.com/products/claire-sweater" }] },
  { order_no: "Q-4", status: 30, un_shop_url: "806080-g8", update_time: "2026-10-12 08:00:00", order_remark: "only similar ones",
    items: [{ un_good_url: "https://marlowestandard.com/products/field-jacket" }], product: [{ manual_pricing: { Germany: { nameOne: 18 }, France: { nameOne: 18 } } }] },
  { order_no: "Q-5", status: 30, un_shop_url: "zzz999-xx", update_time: "2026-10-12 08:00:00", items: [{ un_good_url: "https://x.com/products/a" }],
    product: [{ manual_pricing: { "United States": { nameOne: 9 } } }] },
  { order_no: "Q-6", status: 10, un_shop_url: "mek6yu-91", update_time: "2026-10-12 08:00:00", items: [{ un_good_url: "https://t.com/products/b" }] },
];
const orderRows = () => [
  { id: 501, order_no: "3733-1009", un_shop_url: "jmzjx1-it", shopify_create_at: "2026-10-13T14:00:00Z", status: 2, receiver_address: "x",
    name: "Jane Doe", consignee_name: "Jane", receiver_name: "Jane", shipping_name: "Jane", street: "1 Main", city: "Charlotte", province: "NC",
    phone_number: "1", telephone: "2", company: "Acme", email: "j@x.com" },
  { id: 502, order_no: "3733-1119-1", un_shop_url: "jmzjx1-it", shopify_create_at: "2026-10-12T14:00:00Z", status: 3 },
  { id: 503, order_no: "1009", un_shop_url: "3as2ya-dw", un_create_at: "2026-10-13 22:00:00", status: 2 },
  { id: 504, order_no: "1010", un_shop_url: "qqq111-zz", shopify_create_at: "2026-10-13T14:00:00Z", status: 2 },
];
const billRows = () => [
  // Flat bill-detail rows (KFB's "bill details"): grouped by bill_no. Their own pay_status /
  // pay_time are the CUSTOMER's payment and must not make the bill "paid"; bill_pay_status does.
  { bill_no: "B100", bill_time: "2026-10-13 10:00:00", order_no: "3733-1009", un_shop_url: "jmzjx1-it", goods_price: 12.5, num: 2, freight: 3,
    pay_status: 1, pay_time: "2026-10-12 09:00:00", bill_pay_status: 0, un_total_price: 99.9 },
  { bill_no: "B100", bill_time: "2026-10-13 10:00:00", order_no: "3733-1119-1", un_shop_url: "jmzjx1-it", goods_price: 7, num: 1,
    pay_status: 1, bill_pay_status: 0, un_total_price: 0 },
  // A bill with nested lines and a header total, already paid.
  { bill_no: "B101", bill_time: "2026-10-12 10:00:00", pay_time: "2026-10-12 11:00:00", un_shop_url: "3as2ya-dw", bill_amount: 30,
    details: [{ order_no: "1009", goods_total: 25, freight: 5 }] },
  // An unknown shop's line: refused.
  { bill_no: "B102", bill_time: "2026-10-13 10:00:00", order_no: "77-1001", un_shop_url: "zzz999-xx", goods_price: 4 },
];
const payload = (over = {}) => ({
  kind: "kfb-import", version: 1, origin: "https://www.kungfubuy.com", fetched_at: iso(NOW - 60000),
  sections: {
    quotes: { ok: true, endpoint: "/index/quotation/get.html", rows: quoteRows() },
    orders: { ok: true, endpoint: "/index/order/get.html", rows: orderRows() },
    bills: { ok: true, endpoint: "/index/billOrder/get.html", rows: billRows() },
  },
  ...over,
});
/** The same morning with nothing to refuse (no unknown shops). */
const cleanPayload = (over = {}) => {
  const p = payload(over);
  p.sections.quotes.rows = p.sections.quotes.rows.filter((r) => r.un_shop_url !== "zzz999-xx");
  p.sections.orders.rows = p.sections.orders.rows.filter((r) => r.un_shop_url !== "qqq111-zz");
  p.sections.bills.rows = p.sections.bills.rows.filter((r) => r.un_shop_url !== "zzz999-xx");
  return p;
};
const env = () => ({ DB: makeD1(), BACKUPS: makeR2(), MC_KEY: KEY });
const snapshot = async (DB) => {
  const out = {};
  for (const t of ["kfb_quotes", "kfb_orders", "kfb_bills", "kfb_bill_lines", "supplier_bills", "kfb_similar_offers"]) {
    out[t] = (await DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
};

/* ---------------- origin check ---------------- */

test("origin: only the exact KFB origins are accepted; look-alikes are refused", () => {
  for (const o of KFB_ORIGINS) assert.equal(validatePayload(payload({ origin: o }), NOW).ok, true, o);
  for (const o of ["https://www.kungfubuy.com.evil.com", "http://www.kungfubuy.com", "https://evil.example", "https://www.kungfubuy.com/", null]) {
    const v = validatePayload(payload({ origin: o }), NOW);
    assert.equal(v.ok, false, String(o));
    assert.match(v.errors.join(" "), /not a KFB origin/);
  }
});

test("origin: the dashboard, the bookmarklet and the server use the same origins and endpoints", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const bm = readFileSync(new URL("../public/kfb-bookmarklet.js", import.meta.url), "utf8");
  const dashOrigins = JSON.parse(`[${/var KFB_ORIGINS=\[([^\]]+)\]/.exec(html)[1]}]`);
  const bmOrigins = JSON.parse(`[${/var KFB = \[([^\]]+)\]/.exec(bm)[1]}]`);
  assert.deepEqual(dashOrigins, [...KFB_ORIGINS]);
  assert.deepEqual(bmOrigins, [...KFB_ORIGINS]);
  assert.equal(/var SB = "([^"]+)"/.exec(bm)[1], DASHBOARD_ORIGIN);
  for (const [k, list] of Object.entries(KFB_ENDPOINTS)) for (const ep of list) assert.ok(bm.includes(`"${ep}"`), `${k} ${ep} in the bookmarklet`);
  // The dashboard checks both the sender origin and that the sender is the tab that opened it.
  assert.match(html, /function kfbTrusted\(ev\)\{ return KFB_ORIGINS\.indexOf\(ev\.origin\)>=0&&!!ev\.source&&\(ev\.source===window\.opener\|\|ev\.source===kfbPeer\); \}/);
  assert.match(html, /if\(!kfbTrusted\(ev\)\)\{ kfbIn\.ignored/);
  // No key or secret in the bookmarklet.
  assert.doesNotMatch(bm, /x-store-brain-key|MC_KEY|sessionStorage|localStorage|document\.cookie/);
  assert.match(html, /<script src="\/kfb-bookmarklet\.js"><\/script>/);
});

/* ---------------- the bookmarklet itself, run in a sandbox ---------------- */

const timers = [];
function sandbox({ origin = "https://www.kungfubuy.com", answers = {} } = {}) {
  const calls = [], posted = [], alerts = [], opened = [];
  let listener = null;
  const elem = () => ({ style: {}, textContent: "", title: "", remove() {}, click() {} });
  const box = elem();
  const tab = { postMessage: (msg, target) => posted.push({ msg, target }) };
  const ctx = {
    location: { origin },
    document: { createElement: () => box, body: { appendChild() {} } },
    alert: (m) => alerts.push(m),
    fetch: async (url, opt) => {
      calls.push({ url, opt });
      const path = url.split("?")[0];
      const a = answers[path];
      if (!a) return { ok: true, status: 200, text: async () => "<html>login</html>" };
      return { ok: true, status: 200, text: async () => JSON.stringify(a) };
    },
    setTimeout: (fn, ms) => (ms >= 10000 ? 0 : setTimeout(fn, 0)),
    setInterval: (fn) => { const t = setInterval(fn, 5); timers.push(t); return t; },
    clearInterval: (t) => clearInterval(t),
    TextEncoder, URL, Blob: class {},
  };
  ctx.window = ctx;
  ctx.open = (url) => { opened.push(url); return tab; };
  ctx.addEventListener = (t, fn) => { if (t === "message") listener = fn; };
  ctx.removeEventListener = () => {};
  vm.runInNewContext(readFileSync(new URL("../public/kfb-bookmarklet.js", import.meta.url), "utf8"), ctx);
  return { ctx, calls, posted, alerts, opened, box, tab, send: (m) => listener && listener(m) };
}
const settle = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

test("bookmarklet: refuses to run off KFB (no tab, no fetch)", () => {
  const s = sandbox({ origin: "https://evil.example" });
  vm.runInNewContext(`(${s.ctx.SB_KFB_BOOKMARKLET.toString()})()`, s.ctx);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /evil\.example/);
  assert.equal(s.opened.length, 0);
  assert.equal(s.calls.length, 0);
});

test("bookmarklet: GET only, same-origin session, tries bill endpoints in turn, hands over only after a ready from the dashboard", async () => {
  const s = sandbox({ answers: {
    "/index/quotation/get.html": { code: 0, count: 2, data: quoteRows().slice(0, 2) },
    "/index/order/get.html": { code: 0, count: 1, data: orderRows().slice(0, 1) },
    // first bill candidate answers a web page; the second answers data
    "/index/bill/get.html": { code: 0, count: 1, data: billRows().slice(0, 1) },
  } });
  vm.runInNewContext(`(${s.ctx.SB_KFB_BOOKMARKLET.toString()})()`, s.ctx);
  assert.equal(s.opened.length, 1);
  assert.match(s.opened[0], new RegExp(`^${DASHBOARD_ORIGIN.replace(/[.]/g, "\\.")}/#/import/kfb\\?n=[a-z0-9]+$`), "a nonce per click: a reused tab still navigates");
  const data = () => s.posted.filter((x) => x.msg.type === "sb-kfb-data");
  // A "ready" from anywhere else is ignored.
  s.send({ origin: "https://evil.example", source: s.tab, data: { type: "sb-kfb-ready" } });
  s.send({ origin: DASHBOARD_ORIGIN, source: {}, data: { type: "sb-kfb-ready" } });
  await settle(() => /handing over/.test(s.box.textContent));
  assert.equal(data().length, 0, "nothing sent before the real dashboard said ready");
  // Until then it keeps saying hello (so an already-open dashboard tab can answer), only to the dashboard origin.
  await settle(() => s.posted.some((x) => x.msg.type === "sb-kfb-hello"));
  assert.ok(s.posted.every((x) => x.target === DASHBOARD_ORIGIN));
  s.send({ origin: DASHBOARD_ORIGIN, source: s.tab, data: { type: "sb-kfb-ready" } });
  await settle(() => data().length > 0);
  for (const t of timers) clearInterval(t);
  assert.equal(data().length, 1);
  s.posted.splice(0, s.posted.length, ...data());
  for (const c of s.calls) {
    assert.equal(c.opt.method, "GET");
    assert.equal(c.opt.credentials, "same-origin");
    assert.ok(c.url.startsWith("/index/"), c.url);
  }
  const p = s.posted[0].msg.payload;
  assert.equal(s.posted[0].msg.type, "sb-kfb-data");
  assert.equal(p.sections.bills.endpoint, "/index/bill/get.html");
  assert.equal(p.sections.quotes.rows.length, 2);
  // Allowlist: customer details never leave the KFB tab; what the server reads does.
  const o0 = p.sections.orders.rows[0];
  for (const k of ["receiver_address", "name", "consignee_name", "receiver_name", "shipping_name", "street", "city", "province", "phone_number", "telephone", "company", "email"]) {
    assert.equal(o0[k], undefined, k);
  }
  assert.equal(o0.order_no, "3733-1009");
  assert.equal(o0.shopify_create_at, "2026-10-13T14:00:00Z");
  assert.deepEqual(JSON.parse(JSON.stringify(p.sections.quotes.rows[0].product[0].manual_pricing)), { "United States": { nameOne: "15.47", nameTwo: 0 } }, "country price keys kept");
  assert.equal(p.sections.quotes.total, 2);
  assert.equal(p.sections.quotes.truncated, false);
  // What it sends passes the server's own check.
  const back = JSON.parse(JSON.stringify(p));
  assert.equal(validatePayload(back, Date.parse(p.fetched_at)).ok, true);
});

/* ---------------- shape validation ---------------- */

test("shape: the envelope is checked before anything is written", () => {
  const bad = [
    [null, /JSON object/],
    [{ ...payload(), kind: "other" }, /kind/],
    [{ ...payload(), version: 2 }, /version/],
    [{ ...payload(), fetched_at: "yesterday" }, /fetched_at/],
    [{ ...payload(), fetched_at: iso(NOW + 3600000) }, /future/],
    [{ ...payload(), fetched_at: iso(NOW - 40 * 3600000) }, /older than/],
    [{ ...payload(), sections: [] }, /sections/],
    [{ ...payload(), sections: { cookies: { ok: true, rows: [] } } }, /unknown section/],
    [{ ...payload(), sections: { quotes: { ok: true, rows: "x" } } }, /rows must be an array/],
    [{ ...payload(), sections: { quotes: { ok: true, rows: [1, 2] } } }, /every row must be an object/],
    [{ ...payload(), sections: { quotes: { rows: [] } } }, /\{ok, rows\}/],
    [{ ...payload(), sections: { quotes: { ok: false, error: "x" }, bills: { ok: false, error: "y" } } }, /no section was read/],
    [{ ...payload(), sections: { quotes: { ok: true, rows: Array.from({ length: KFB_IMPORT_MAX_ROWS + 1 }, () => ({})) } } }, /more than/],
  ];
  for (const [p, re] of bad) {
    const v = validatePayload(p, NOW);
    assert.equal(v.ok, false, String(re));
    assert.match(v.errors.join(" | "), re);
  }
  assert.equal(validatePayload({ ...payload(), sections: { orders: { ok: false, error: "logged out?" }, quotes: { ok: true, rows: [] } } }, NOW).ok, true);
});

test("shape: rows are read by the documented fields; un_* store fields are never a cost", () => {
  assert.equal(kfbTime("2026-10-13 09:15:00"), "2026-10-13T01:15:00.000Z"); // China time
  assert.equal(kfbTime("2026-10-13T14:00:00Z", "Z"), "2026-10-13T14:00:00.000Z");
  assert.equal(kfbTime("1760000000"), new Date(1760000000 * 1000).toISOString());
  assert.equal(kfbTime("soon"), null);
  assert.deepEqual(parseOrderNo("3733-1119-1"), { ref: "1119", sub: "1", parent: "3733-1119" });
  assert.deepEqual(parseOrderNo("#1009"), { ref: "1009", sub: null, parent: null });
  assert.equal(parseOrderNo("KF20261006123456"), null, "a long KFB-only number is not a Shopify order");
  assert.equal(quoteCost(quoteRows()[0]).value, 15.47);
  assert.equal(quoteCost(quoteRows()[3]).value, 18, "same price everywhere");
  assert.equal(quoteCost({ product: [{ manual_pricing: { Germany: { nameOne: 18 }, France: { nameOne: 19 } } }] }).value, null);
  const q = normalizeQuoteRow(quoteRows()[0]);
  assert.equal(q.clean.handle, "belted-trench");
  assert.equal(q.clean.cost, 15.47);
  assert.equal(q.clean.status, "quoted");
  assert.equal(q.clean.quotedAt, "2026-10-13T01:15:00.000Z");
  const q40 = normalizeQuoteRow(quoteRows()[1]);
  assert.equal(q40.clean.code, 40);
  assert.equal(q40.clean.status, "awaiting_reilly_guess");
  const { bills } = normalizeBills(billRows());
  const b100 = bills.find((b) => b.bill_id === "B100");
  assert.equal(b100.lines.length, 2);
  const l1009 = b100.lines.find((l) => l.order_ref === "1009");
  assert.equal(l1009.cost_eur, 25, "unit price × quantity, never un_total_price");
  assert.equal(l1009.shipping_eur, 3);
  const sub = b100.lines.find((l) => l.order_ref === "1119");
  assert.equal(sub.parent_kfb_order_id, "3733-1119");
  assert.equal(b100.total_eur, null, "a flat line's total is not a bill total");
  assert.equal(b100.paid, false);
  const b101 = bills.find((b) => b.bill_id === "B101");
  assert.equal(b101.total_eur, 30);
  assert.equal(b101.paid, true);
});

/* ---------------- shop-code mapping ---------------- */

test("shop codes: rows map to stores by KFB shop code only; unknown shops are refused, never guessed", async () => {
  assert.equal(normShopCode("https://JMZJX1-IT.myshopify.com/"), "jmzjx1-it");
  assert.equal(storeForShopCode("3as2ya-dw").id, "aub");
  assert.equal(storeForShopCode("806080-g8.myshopify.com").id, "mar");
  assert.equal(storeForShopCode("zzz999-xx"), null);
  assert.equal(storeForShopCode(null), null);
  assert.equal(shopCodeOf({ items: [{ un_shop_url: "jmzjx1-it" }] }), "jmzjx1-it");
  assert.match(normalizeOrderRow(orderRows()[3]).reason, /unknown KFB shop "qqq111-zz"/);
  assert.equal(normalizeOrderRow({ order_no: "1009" }).reason, "no KFB shop code (un_shop_url)");

  const e = env();
  const r = await importKfb(e, payload(), { nowMs: NOW });
  assert.equal(r.ok, true);
  const q = (await e.DB.prepare(`SELECT store, product_handle, status_code, status, cost, source FROM kfb_quotes ORDER BY product_handle`).all()).results;
  assert.deepEqual(q.map((x) => [x.store, x.product_handle, x.status_code]), [
    ["hc", "belted-trench", 30], ["aub", "claire-sweater", 26], ["mar", "field-jacket", 30], ["hc", "wool-coat", 40]]);
  assert.ok(q.every((x) => x.source === "kfb_session"));
  assert.equal(q.find((x) => x.status_code === 40).status, "awaiting_reilly_guess", "status 40 kept raw, read as Reilly's best guess");
  assert.deepEqual(r.counts.unknown_shops.sort(), ["qqq111-zz", "zzz999-xx"]);
  assert.equal(r.counts.quotes.skipped_not_live, 1, "Tundrelle is not live: its quote is skipped");
  const o = (await e.DB.prepare(`SELECT * FROM kfb_orders ORDER BY kfb_order_id`).all()).results;
  assert.deepEqual(o.map((x) => [x.kfb_shop_code, x.order_ref]), [["3as2ya-dw", "1009"], ["jmzjx1-it", "1009"], ["jmzjx1-it", "1119"]]);
  assert.equal(o.find((x) => x.kfb_shop_code === "3as2ya-dw").kfb_created_at, "2026-10-13T14:00:00.000Z", "China time read as UTC+8");
  const lines = (await e.DB.prepare(`SELECT * FROM kfb_bill_lines`).all()).results;
  assert.ok(lines.every((l) => ["jmzjx1-it", "3as2ya-dw"].includes(l.kfb_shop_code)), "no unknown shop line stored");
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_bills WHERE bill_id = 'B102'`).first()).n, 0);
  assert.equal(r.counts.by_store.hc.orders, 2);
  // The "only similar ones" quote reaches the Similar QC.
  const sim = (await e.DB.prepare(`SELECT * FROM kfb_similar_offers`).all()).results;
  assert.deepEqual(sim.map((x) => [x.store, x.context, x.product_handle]), [["mar", "quote", "field-jacket"]]);
  // Bills to pay: B100 unpaid (two lines, 25 + 3 + 7), B101 paid.
  const pay = (await e.DB.prepare(`SELECT bill_id, store, amount, status FROM supplier_bills ORDER BY bill_id`).all()).results;
  assert.deepEqual(pay, [{ bill_id: "B100", store: "hc", amount: 35, status: "unpaid" }, { bill_id: "B101", store: "aub", amount: 30, status: "paid" }]);
  // Raw payload kept in R2 for audit.
  assert.ok(r.r2Key.startsWith("kfb-imports/2026-10-14/"));
  assert.ok(e.BACKUPS._store.has(r.r2Key));
});

/* ---------------- idempotency ---------------- */

test("idempotent: the same data again changes nothing; next day it only confirms the read", async () => {
  const e = env();
  const first = await importKfb(e, cleanPayload(), { nowMs: NOW });
  assert.equal(first.ok, true);
  const snap = await snapshot(e.DB);
  const events = (await e.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first()).n;
  const feeds = await evaluateFeeds(e.DB, NOW);

  // Same rows, read a minute later, same day: refused as a duplicate, nothing written.
  const again = await importKfb(e, cleanPayload({ fetched_at: iso(NOW) }), { nowMs: NOW + 120000 });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.deepEqual(await snapshot(e.DB), snap);
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first()).n, events);
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_imports`).first()).n, 1);
  assert.deepEqual(await evaluateFeeds(e.DB, NOW), feeds);

  // Next morning, same rows: a new import (the read happened) but every data row unchanged.
  const tomorrow = NOW + 86400000;
  const next = await importKfb(e, cleanPayload({ fetched_at: iso(tomorrow - 60000) }), { nowMs: tomorrow });
  assert.equal(next.duplicate, undefined);
  assert.equal(next.counts.quotes.inserted, 0);
  assert.equal(next.counts.orders.inserted + next.counts.orders.updated, 0);
  assert.equal(next.counts.bills.inserted + next.counts.bills.updated, 0);
  assert.equal(next.counts.bills.to_pay.inserted + next.counts.bills.to_pay.updated, 0);
  assert.deepEqual(await snapshot(e.DB), snap);

  // A real change (bill B100 paid, an order status moved) updates only those rows.
  const changed = cleanPayload({ fetched_at: iso(tomorrow) });
  changed.sections.bills.rows[0].bill_pay_status = 1; changed.sections.bills.rows[1].bill_pay_status = 1;
  changed.sections.orders.rows[0].status = 5;
  const upd = await importKfb(e, changed, { nowMs: tomorrow + 60000 });
  assert.equal(upd.counts.orders.updated, 1);
  assert.equal(upd.counts.bills.to_pay.updated, 1);
  assert.equal((await e.DB.prepare(`SELECT status FROM supplier_bills WHERE bill_id = 'B100'`).first()).status, "paid");
  assert.equal((await e.DB.prepare(`SELECT imported_at FROM kfb_orders WHERE kfb_order_id = 'jmzjx1-it:3733-1009'`).first()).imported_at, iso(NOW), "first seen time kept");
});

test("idempotent: the COGS Matcher's card amount and signature survive a re-import", async () => {
  const e = env();
  await importKfb(e, payload(), { nowMs: NOW });
  await e.DB.prepare(`UPDATE kfb_bills SET usd_charged = 41.5, fx_source = 'wf_alert:x' WHERE bill_id = 'B100'`).run();
  const r = await matchBills(e.DB, { nowMs: NOW });
  assert.equal(r.status, "running", "COGS Matcher stops waiting once bills are in");
  const sig = (await e.DB.prepare(`SELECT matched_sig FROM kfb_bills WHERE bill_id = 'B100'`).first()).matched_sig;
  await importKfb(e, payload({ fetched_at: iso(NOW + 86400000 - 1000) }), { nowMs: NOW + 86400000 });
  const b = await e.DB.prepare(`SELECT usd_charged, fx_source, matched_sig FROM kfb_bills WHERE bill_id = 'B100'`).first();
  assert.deepEqual(b, { usd_charged: 41.5, fx_source: "wf_alert:x", matched_sig: sig });
});

/* ---------------- feed freshness ---------------- */

test("freshness: an import marks the KFB sweep fresh at the read time; the agents stop waiting", async () => {
  const e = env();
  let st = await sweepStatus(e.DB, NOW);
  assert.equal(st.usable, false);
  assert.match(st.reason, /waiting on KFB session/);
  assert.equal((await kfbImportStatus(e.DB, NOW)).doneToday, false);
  const r = await importKfb(e, payload(), { nowMs: NOW });
  const f = (await evaluateFeeds(e.DB, NOW)).find((x) => x.id === "kfb.morning_sweep");
  assert.equal(f.current, "fresh");
  assert.equal(f.last_ok_at, iso(NOW - 60000));
  st = await sweepStatus(e.DB, NOW);
  assert.equal(st.usable, true);
  const imp = await kfbImportStatus(e.DB, NOW);
  assert.equal(imp.doneToday, true);
  assert.equal(imp.sections.bills.ok, true);
  const ev = (await e.DB.prepare(`SELECT * FROM events WHERE kind = 'kfb.imported'`).all()).results;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "svc.kfb_session");
  assert.match(ev[0].summary, /quotes 4 new/);
  assert.equal(JSON.parse(ev[0].data).importId, r.importId);
  // Stale after 26 h, as the Freshness Sentinel defines it.
  assert.equal((await evaluateFeeds(e.DB, NOW + 27 * 3600000)).find((x) => x.id === "kfb.morning_sweep").current, "stale");
  // Digest: quotes and bills are read from the import, not "waiting on KFB session".
  const body = digestBody(await digestData(e.DB, NOW));
  assert.doesNotMatch(body, /waiting on KFB session/);
  assert.match(body, /Bills: 1 unpaid bill, EUR 35\.00/);
});

test("freshness: the Order Watcher counts an unchanged re-import as a read of that store's orders", async () => {
  const e = env();
  const order = (store, id, created_at) => upsertOrder(e.DB, STORES[store], {
    order_id: `gid://shopify/Order/${store}-${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: "paid", payload_updated_at: created_at,
  }, JSON.stringify({ total_price: "50" }), STORES[store].timezone, created_at);
  await order("hc", 1009, "2026-10-13T14:00:00Z");
  await order("hc", 1010, "2026-10-13T15:00:00Z");
  await importKfb(e, payload(), { nowMs: NOW });
  // Two days later the same rows are read again: kfb_orders is not rewritten, yet H&C was read.
  const later = NOW + 2 * 86400000;
  await importKfb(e, payload({ fetched_at: iso(later - 60000) }), { nowMs: later });
  const r = await runOrderWatch({ DB: e.DB }, { nowMs: later });
  assert.equal(r.status, "checked");
  assert.ok(!r.skipped_stores.some((s) => s.store === "hc"), JSON.stringify(r.skipped_stores));
  const w = (await e.DB.prepare(`SELECT order_name, state FROM order_watch WHERE store = 'hc'`).all()).results;
  assert.deepEqual(w, [{ order_name: "#1010", state: "suspect" }], "1009 is in KFB; only 1010 is missing");
});

/* ---------------- the key ---------------- */

test("HTTP: POST /api/import/kfb needs the key, caps the size, and refuses a bad payload", async () => {
  const e = env();
  const body = JSON.stringify({ payload: payload({ fetched_at: new Date().toISOString() }) });
  const req = (headers, b = body) => new Request("https://b/api/import/kfb", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: b });
  assert.equal((await worker.fetch(req({}), e)).status, 401);
  assert.equal((await worker.fetch(req({ "x-store-brain-key": "wrong".padEnd(32, "x") }), e)).status, 401);
  assert.equal((await worker.fetch(req({}), { ...e, MC_KEY: undefined })).status, 401, "no key configured = locked");
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_imports`).first()).n, 0);
  assert.equal((await worker.fetch(new Request("https://b/api/import/kfb", { method: "GET", headers: { "x-store-brain-key": KEY } }), e)).status, 404);

  const ok = await worker.fetch(req({ "x-store-brain-key": KEY }), e);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.ok, true);
  assert.equal(j.counts.quotes.inserted, 4);

  const bad = await worker.fetch(req({ "x-store-brain-key": KEY }, JSON.stringify({ payload: { ...payload(), origin: "https://evil.example" } })), e);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not a KFB origin/);
  assert.equal((await worker.fetch(req({ "x-store-brain-key": KEY }, "{not json"), e)).status, 400);
  const big = "x".repeat(5 * 1024 * 1024 + 10);
  assert.equal((await worker.fetch(req({ "x-store-brain-key": KEY }, big), e)).status, 413);

  // Without the R2 audit store nothing is imported.
  const noR2 = { DB: makeD1(), MC_KEY: KEY };
  const r = await worker.fetch(req({ "x-store-brain-key": KEY }), noR2);
  assert.equal(r.status, 503);
  assert.equal((await noR2.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_quotes`).first()).n, 0);

  // Mission Control state carries the import status for "Waiting on you".
  const s = await (await worker.fetch(new Request("https://b/api/state", { headers: { "x-store-brain-key": KEY } }), e)).json();
  assert.equal(s.kfbImport.doneToday, true);
  assert.equal(s.kfbImport.reminder, "shadow");
  assert.equal(s.stores.find((x) => x.id === "hc").kfbShopCode, "jmzjx1-it");
});

/* ---------------- reminders ---------------- */

test("reminder: once a day from 09:00 Eastern when no import landed; shadow unless Reilly flips it", async () => {
  const e = env();
  const at8 = Date.parse("2026-10-14T12:30:00Z"); // 08:30 EDT
  assert.equal((await runKfbReminder(e, { nowMs: at8 })).reason, "before 09:00 Eastern");
  const shadow = await runKfbReminder(e, { nowMs: NOW });
  assert.equal(shadow.sent, false);
  assert.equal(shadow.mode, "shadow");
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'kfb.reminder_shadow'`).first()).n, 1);
  assert.equal((await runKfbReminder(e, { nowMs: NOW + 900000 })).reason, "already reminded today");

  const calls = [];
  const live = { ...env(), KFB_REMINDER_LIVE: "1", PUSHOVER_APP_TOKEN: "t", PUSHOVER_USER_KEY: "u" };
  const fetchImpl = async (url, opt) => { calls.push({ url, body: opt.body }); return new Response(JSON.stringify({ status: 1 }), { status: 200 }); };
  const r = await runKfbReminder(live, { nowMs: NOW, fetchImpl });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.match(decodeURIComponent(calls[0].body.replace(/\+/g, " ")), /KFB import not done today/);
  await runKfbReminder(live, { nowMs: NOW + 900000, fetchImpl });
  assert.equal(calls.length, 1, "one reminder per day");

  // An import before 09:00: no reminder that day.
  const done = { ...env(), KFB_REMINDER_LIVE: "1", PUSHOVER_APP_TOKEN: "t", PUSHOVER_USER_KEY: "u" };
  await importKfb(done, payload({ fetched_at: iso(at8 - 60000) }), { nowMs: at8 });
  assert.equal((await runKfbReminder(done, { nowMs: NOW, fetchImpl })).reason, "imported today");
  assert.equal(calls.length, 1);
});

test("brief: 'KFB import not done today' leads Waiting on you until an import lands", async () => {
  const e = env();
  let d = await gatherBriefData(e, { nowMs: NOW });
  assert.equal(d.waiting.kfb_import.done_today, false);
  assert.match(plainBrief(d), /KFB import not done today/);
  await importKfb(e, payload(), { nowMs: NOW });
  d = await gatherBriefData(e, { nowMs: NOW });
  assert.equal(d.waiting.kfb_import.done_today, true);
  assert.doesNotMatch(plainBrief(d), /KFB import not done today/);
});

/* ---------------- Claims: cancelled but billed ---------------- */

test("claims: a billed order that was cancelled in Shopify opens one credit, once", async () => {
  const e = env();
  const created = "2026-10-13T14:00:00Z";
  await upsertOrder(e.DB, STORES.hc, {
    order_id: "gid://shopify/Order/hc-1009", name: "#1009", created_at: created, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: "refunded", payload_updated_at: created,
  }, JSON.stringify({ total_price: "50", cancelled_at: "2026-10-13T16:00:00Z" }), STORES.hc.timezone, created);
  // Same number at Auberlane, not cancelled: never confused with H&C's (store by shop code).
  await upsertOrder(e.DB, STORES.aub, {
    order_id: "gid://shopify/Order/aub-1009", name: "#1009", created_at: created, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: "paid", payload_updated_at: created,
  }, JSON.stringify({ total_price: "50" }), STORES.aub.timezone, created);
  await importKfb(e, payload(), { nowMs: NOW });
  assert.equal(await detectCancelledBilled(e.DB, { nowMs: NOW }), 1);
  assert.equal(await detectCancelledBilled(e.DB, { nowMs: NOW }), 0);
  const c = (await e.DB.prepare(`SELECT store, kind, order_name, amount, currency, source FROM kfb_credits`).all()).results;
  assert.deepEqual(c, [{ store: "hc", kind: "cancelled_billed", order_name: "#1009", amount: 28, currency: "EUR", source: "kfb_bill" }]);
});

/* ---------------- review of 7ce2827: one test per finding ---------------- */

test("review 1: paid state comes from the bill (header or bill_* fields), a flag beats a time, unclear is unknown", () => {
  // Nested bill: only the header counts; a line's pay fields (the customer's payment) are ignored.
  let b = normalizeBills([{ bill_no: "N1", bill_time: "2026-10-13 10:00:00", un_shop_url: "jmzjx1-it", bill_amount: 20,
    details: [{ order_no: "1001", goods_total: 20, pay_status: 1, pay_time: "2026-10-13 09:00:00" }] }]).bills[0];
  assert.equal(b.paid, null);
  assert.equal(b.paid_at, null);
  // Header flag 0 with a pay time: the flag wins (unpaid).
  b = normalizeBills([{ bill_no: "N2", bill_time: "2026-10-13 10:00:00", un_shop_url: "jmzjx1-it", bill_amount: 20, pay_status: 0, pay_time: "2026-10-13 11:00:00",
    details: [{ order_no: "1001", goods_total: 20 }] }]).bills[0];
  assert.equal(b.paid, false);
  // Unreadable flag: unknown, never paid, even with a time.
  assert.deepEqual(billPaidState({ pay_status: "processing", pay_time: "2026-10-13 11:00:00" }, { header: true }), { paid: null, paidAt: null });
  // Flat rows: plain pay_status / pay_time are ignored; rows that disagree make it unknown.
  b = normalizeBills([{ bill_no: "F1", bill_time: "2026-10-13 10:00:00", order_no: "1001", un_shop_url: "jmzjx1-it", goods_total: 5, pay_status: 1, pay_time: "2026-10-13 09:00:00" }]).bills[0];
  assert.equal(b.paid, null);
  b = normalizeBills([
    { bill_no: "F2", bill_time: "2026-10-13 10:00:00", order_no: "1001", un_shop_url: "jmzjx1-it", goods_total: 5, bill_pay_status: 1 },
    { bill_no: "F2", bill_time: "2026-10-13 10:00:00", order_no: "1002", un_shop_url: "jmzjx1-it", goods_total: 5, bill_pay_status: 0 },
  ]).bills[0];
  assert.equal(b.paid, null);
});

test("review 2: pay_amount is never the bill amount; a 0 header total falls back to the lines; no-amount bills are shown", async () => {
  const b = normalizeBills([{ bill_no: "Z1", bill_time: "2026-10-13 10:00:00", un_shop_url: "jmzjx1-it", pay_amount: 0, bill_amount: 0,
    details: [{ order_no: "1001", goods_total: 12 }, { order_no: "1002", goods_total: 8, freight: 2 }] }]).bills[0];
  assert.equal(b.total_eur, null);
  assert.equal(b.amount_eur, 22);
  const e = env();
  const p = cleanPayload();
  p.sections.bills.rows.push({ bill_no: "Z2", bill_time: "2026-10-13 10:00:00", un_shop_url: "jmzjx1-it", details: [{ order_no: "1003", service_fee: 0 }] });
  const r = await importKfb(e, p, { nowMs: NOW });
  assert.equal(r.counts.bills.to_pay.no_amount, 1);
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM supplier_bills WHERE bill_id = 'Z2'`).first()).n, 0);
  assert.match(digestBody(await digestData(e.DB, NOW)), /1 bill read with no amount/);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /tp\.no_amount\?/, "the import result shows it");
});

test("review 3: the sweep feed is fresh only when orders were read; otherwise it fails with the reason", async () => {
  const e = env();
  const p = cleanPayload();
  p.sections.orders = { ok: false, error: "/index/order/get.html answered a web page, not data" };
  const r = await importKfb(e, p, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.sections.orders.ok, false);
  assert.equal(r.sections.quotes.ok, true);
  const f = (await evaluateFeeds(e.DB, NOW)).find((x) => x.id === "kfb.morning_sweep");
  assert.equal(f.current, "failing");
  assert.match(f.last_error, /orders not read/);
  assert.equal((await sweepStatus(e.DB, NOW)).usable, false);
});

test("review 4: a truncated bills read never deletes lines, flags the bill at the cut, and the COGS Matcher waits on it", async () => {
  const e = env();
  await importKfb(e, cleanPayload(), { nowMs: NOW });
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_bill_lines WHERE bill_id = 'B100'`).first()).n, 2);
  // An hour later the read stops after B100's first line: B100 is the bill at the cut.
  const later = NOW + 3600000;
  const p = cleanPayload({ fetched_at: iso(later) });
  p.sections.bills = { ok: true, endpoint: "/index/billOrder/get.html", total: 9, truncated: true,
    rows: [billRows()[2], { ...billRows()[0], goods_price: 13 }] }; // B101 whole, then B100 cut (one line re-costed)
  const r = await importKfb(e, p, { nowMs: later });
  assert.equal(r.counts.bills.incomplete, 1);
  const lines = (await e.DB.prepare(`SELECT line_no FROM kfb_bill_lines WHERE bill_id = 'B100' ORDER BY line_no`).all()).results;
  assert.equal(lines.length, 3, "both old lines kept, the new one added");
  assert.equal((await e.DB.prepare(`SELECT incomplete FROM kfb_bill_flags WHERE bill_id = 'B100'`).first()).incomplete, 1);
  assert.equal((await e.DB.prepare(`SELECT incomplete FROM kfb_bill_flags WHERE bill_id = 'B101'`).first()).incomplete, 0);
  assert.equal(r.counts.bills.to_pay.incomplete, 1, "not re-listed to pay from a partial sum");
  assert.equal((await e.DB.prepare(`SELECT amount FROM supplier_bills WHERE bill_id = 'B100'`).first()).amount, 35);
  await e.DB.prepare(`UPDATE kfb_bills SET usd_charged = 40`).run();
  await matchBills(e.DB, { nowMs: later });
  assert.equal((await e.DB.prepare(`SELECT matched_sig FROM kfb_bills WHERE bill_id = 'B100'`).first()).matched_sig, null, "incomplete bill not matched");
  assert.notEqual((await e.DB.prepare(`SELECT matched_sig FROM kfb_bills WHERE bill_id = 'B101'`).first()).matched_sig, null);
});

test("review 4: a truncated orders read raises no not-in-KFB flags", async () => {
  const e = env();
  const created = "2026-10-13T00:00:00Z";
  await upsertOrder(e.DB, STORES.hc, { order_id: "gid://shopify/Order/hc-1500", name: "#1500", created_at: created, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: "paid", payload_updated_at: created }, JSON.stringify({}), STORES.hc.timezone, created);
  const p = cleanPayload();
  p.sections.orders.truncated = true; p.sections.orders.total = 900;
  await importKfb(e, p, { nowMs: NOW });
  const r = await runOrderWatch({ DB: e.DB }, { nowMs: NOW });
  assert.equal(r.status, "checked");
  assert.equal(r.suspect, 0);
  assert.match(r.partial_read, /cut off/);
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM order_watch`).first()).n, 0);
  // The same order missing from a COMPLETE read is a suspect.
  const later = NOW + 3600000;
  await importKfb(e, cleanPayload({ fetched_at: iso(later) }), { nowMs: later });
  assert.equal((await runOrderWatch({ DB: e.DB }, { nowMs: later })).suspect, 1);
});

test("review 5: raw payloads older than 30 days are deleted from R2 on the next import", async () => {
  const e = env();
  const first = await importKfb(e, cleanPayload(), { nowMs: NOW });
  assert.ok(e.BACKUPS._store.has(first.r2Key));
  const later = NOW + 31 * 86400000;
  const r = await importKfb(e, cleanPayload({ fetched_at: iso(later - 1000) }), { nowMs: later });
  assert.equal(r.counts.raw_files_pruned, 1);
  assert.equal(e.BACKUPS._store.has(first.r2Key), false);
  assert.ok(e.BACKUPS._store.has(r.r2Key));
  assert.equal((await e.DB.prepare(`SELECT r2_key FROM kfb_imports WHERE id = ?`).bind(first.importId).first()).r2_key, null);
});

test("review 6: an older read can't roll newer data back; done today follows the read day; 26 h limit", async () => {
  const e = env();
  await importKfb(e, cleanPayload(), { nowMs: NOW });
  const old = cleanPayload({ fetched_at: iso(NOW - 3600000) });
  old.sections.bills.rows[0].bill_pay_status = 1;
  const r = await importKfb(e, old, { nowMs: NOW + 60000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.errors[0], /later read/);
  assert.equal((await e.DB.prepare(`SELECT status FROM supplier_bills WHERE bill_id = 'B100'`).first()).status, "unpaid");
  // A file read last evening, imported this morning: not today's session.
  const e2 = env();
  const lastEvening = Date.parse("2026-10-14T00:30:00Z"); // 20:30 EDT on the 13th
  await importKfb(e2, cleanPayload({ fetched_at: iso(lastEvening) }), { nowMs: NOW });
  assert.equal((await kfbImportStatus(e2.DB, NOW)).doneToday, false);
  assert.match(validatePayload(cleanPayload({ fetched_at: iso(NOW - 27 * 3600000) }), NOW).errors.join(), /older than 26 h/);
});

test("review 7: the import page answers a hello, so a second click into a reused tab still hands over", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /if\(d\.type==="sb-kfb-hello"\)\{\s*if\(KFB_ORIGINS\.indexOf\(ev\.origin\)<0\|\|!ev\.source\) return;\s*kfbPeer=ev\.source;\s*try\{ ev\.source\.postMessage\(\{type:"sb-kfb-ready"\},ev\.origin\); \}/);
});

test("review 8: no bare price; a line total is never multiplied; claims credits are marked as estimates", async () => {
  const one = (l) => normalizeBills([{ bill_no: "C", bill_time: "2026-10-13 10:00:00", un_shop_url: "jmzjx1-it", order_no: "1001", ...l }]);
  assert.equal(one({ price: 5 }).bills.length, 0, "a bare price is not a cost");
  assert.equal(one({ price: 5 }).rejected[0].reason, "no cost on the bill line");
  const t = one({ goods_total: 30, goods_price: 10, num: 3 }).bills[0];
  assert.equal(t.lines[0].cost_eur, 30);
  assert.equal(t.cost_basis, "line_total");
  assert.equal(one({ goods_price: 10, num: 3 }).bills[0].cost_basis, "unit_x_qty");
  const e = env();
  const created = "2026-10-13T14:00:00Z";
  await upsertOrder(e.DB, STORES.hc, { order_id: "gid://shopify/Order/hc-1009", name: "#1009", created_at: created, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: "refunded", payload_updated_at: created },
  JSON.stringify({ cancelled_at: created }), STORES.hc.timezone, created);
  await importKfb(e, cleanPayload(), { nowMs: NOW });
  await detectCancelledBilled(e.DB, { nowMs: NOW });
  assert.match((await e.DB.prepare(`SELECT note FROM kfb_credits`).first()).note, /ESTIMATE.*unit_x_qty/);
});

test("review 9: the same rows again on the same day are retried when the first import refused some", async () => {
  const e = env();
  const first = await importKfb(e, payload(), { nowMs: NOW }); // has unknown-shop rows
  assert.ok(first.counts.unknown_shops.length);
  const snap = await snapshot(e.DB);
  const again = await importKfb(e, payload(), { nowMs: NOW + 60000 });
  assert.equal(again.duplicate, undefined, "retried, not refused as a duplicate");
  assert.equal(again.importId, first.importId, "same import row, updated");
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_imports`).first()).n, 1);
  assert.deepEqual(await snapshot(e.DB), snap, "and still changes no data row");
});

test("review 10: a quote filed under its creation time still lands when re-quoted at the same status", async () => {
  const e = env();
  const row = (cost) => ({ order_no: "QC1", status: 30, un_shop_url: "jmzjx1-it", create_time: "2026-10-01 08:00:00",
    items: [{ un_good_url: "https://holtandcrane.com/products/cord-blazer" }], product: [{ manual_pricing: { "United States": { nameOne: cost } } }] });
  const only = (cost, at) => ({ ...cleanPayload({ fetched_at: iso(at) }), sections: { quotes: { ok: true, rows: [row(cost)] } } });
  await importKfb(e, only(20, NOW - 60000), { nowMs: NOW });
  const r = await importKfb(e, only(23, NOW), { nowMs: NOW + 60000 });
  assert.equal(r.counts.quotes.requoted, 1);
  const q = (await e.DB.prepare(`SELECT cost, quoted_at FROM kfb_quotes WHERE product_handle = 'cord-blazer' ORDER BY quoted_at`).all()).results;
  assert.deepEqual(q.map((x) => x.cost), [20, 23]);
  assert.equal(q[1].quoted_at, iso(NOW), "filed under the read time");
  // The same cost again (next morning, so not a same-day duplicate) is not a new quote.
  const again = await importKfb(e, only(23, NOW + 20 * 3600000), { nowMs: NOW + 20 * 3600000 });
  assert.equal(again.duplicate, undefined);
  assert.equal(again.counts.quotes.inserted, 0);
  assert.equal(again.counts.quotes.unchanged, 1);
  assert.equal((await e.DB.prepare(`SELECT COUNT(*) AS n FROM kfb_quotes WHERE product_handle = 'cord-blazer'`).first()).n, 2);
});

test("review 11: the bookmarklet's 5 MB check counts UTF-8 bytes", () => {
  const bm = readFileSync(new URL("../public/kfb-bookmarklet.js", import.meta.url), "utf8");
  assert.match(bm, /new TextEncoder\(\)\.encode\(JSON\.stringify\(payload\)\)\.length > 4900000/);
});

test("review 12: KFB times respect a written zone and accept YYYY/MM/DD", () => {
  assert.equal(kfbTime("2026-10-13 09:15:00+00:00"), "2026-10-13T09:15:00.000Z");
  assert.equal(kfbTime("2026-10-13 09:15:00 Z"), "2026-10-13T09:15:00.000Z");
  assert.equal(kfbTime("2026-10-13 09:15:00-0400"), "2026-10-13T13:15:00.000Z");
  assert.equal(kfbTime("2026/10/13 09:15"), "2026-10-13T01:15:00.000Z");
  assert.equal(kfbTime("2026/1/3"), "2026-01-02T16:00:00.000Z");
  assert.equal(kfbTime("2026-10-13T09:15:00"), "2026-10-13T01:15:00.000Z", "a T stamp without a zone is still China time");
});
