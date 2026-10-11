import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import {
  computeStoreDay, writePnlRow, recomputeDays, runPnlCron, runDayClose, pnlState,
  guyFeeFor, breakevenRoas, cogsRate, parseRate, FALLBACK_COGS_RATE,
} from "../src/lib/pnl.js";
import {
  runBrief, unverifiedNumbers, briefHtml, handleBriefPage, verifyBriefSig, aiCostUsd, plainBrief, gatherBriefData,
} from "../src/lib/brief.js";
import { upsertOrder, upsertRefund } from "../src/lib/shopifyWebhooks.js";
import { ensureFeeds, markFeedOk } from "../src/lib/freshness.js";
import { costSince } from "../src/lib/eventlog.js";
import { STORES, LIVE_STORE_IDS } from "../src/config/stores.js";
import worker from "../src/index.js";

/* ---------------- fixtures ---------------- */

const NY = "America/New_York";
const iso = (ms) => new Date(ms).toISOString();
const API_KEY = "sk-ant-api03-TESTKEY-never-log-me-1234567890";

async function order(DB, store, { id, created_at, total, raw = null, status = "paid" }) {
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: total, discounts: 0, total, financial_status: status, payload_updated_at: created_at,
  }, raw ? JSON.stringify(raw) : null, STORES[store].timezone, created_at);
}

async function refund(DB, store, { id, orderId, processed_at, amount, status = "SUCCESS" }) {
  await upsertRefund(DB, store, { refund_id: `gid://shopify/Refund/${id}`, order_id: `gid://shopify/Order/${orderId}`, processed_at, amount, status }, "{}", NY, processed_at);
}

async function ads(DB, store, day, cost, tz = NY) {
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at)
    VALUES (?, ?, ?, 10, 100, 0, 'USD', ?, '2026-10-11T00:00:00Z')
    ON CONFLICT(store, day) DO UPDATE SET cost = excluded.cost`).bind(store, day, cost, tz).run();
}

async function charge(DB, store, { id, date, fee, type = "CHARGE", test = 0 }) {
  await DB.prepare(`INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, test, fetched_at)
    VALUES (?, ?, ?, ?, 100, ?, ?, 'USD', ?, '2026-10-11T00:00:00Z')`).bind(store, `gid://t/${id}`, type, date, fee, 100 - fee, test).run();
}

/** Make every input of every live store fresh as of `nowMs`. */
async function allFresh(DB, nowMs, { skip = [] } = {}) {
  await ensureFeeds(DB);
  const at = iso(nowMs - 60000);
  for (const id of LIVE_STORE_IDS) {
    for (const f of [`shopify.orders.${id}`, `ads.spend.${id}`, `shopify.payouts.${id}`]) {
      if (!skip.includes(f)) await markFeedOk(DB, f, at);
    }
    if (!skip.includes(`refunds.${id}`)) {
      await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at`).bind(`refunds.${id}`, at).run();
    }
  }
}

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

/** Fake Claude + Pushover. */
function fakeApis({ claude = "ok", text = "## Yesterday's money\n- **Holt & Crane:** revenue $200.00" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "https://api.anthropic.com/v1/messages") {
      if (claude === "down") throw new Error("network down " + API_KEY);
      if (claude === "500") return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "Overloaded" } }), { status: 529 });
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn",
        content: [{ type: "text", text }], usage: { input_tokens: 3000, output_tokens: 400 },
      }), { status: 200 });
    }
    if (url === "https://api.pushover.net/1/messages.json") return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}

/* ---------------- P&L: day math ---------------- */

test("day math: orders and fees land on the store's local day across the DST change", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-11-05T15:00:00Z");
  await allFresh(DB, nowMs);
  // 2026-11-01 03:30Z = Oct 31 23:30 EDT; 2026-11-02 04:30Z = Nov 1 23:30 EST (DST ended Nov 1).
  await order(DB, "hc", { id: 1, created_at: "2026-11-01T03:30:00Z", total: 50 });
  await order(DB, "hc", { id: 2, created_at: "2026-11-02T04:30:00Z", total: 80 });
  await charge(DB, "hc", { id: 1, date: "2026-11-02T04:30:00Z", fee: 2.5 });
  await charge(DB, "hc", { id: 2, date: "2026-11-01T03:30:00Z", fee: 1.25 });

  const oct31 = await computeStoreDay(DB, "hc", "2026-10-31", { nowMs });
  const nov1 = await computeStoreDay(DB, "hc", "2026-11-01", { nowMs });
  const nov2 = await computeStoreDay(DB, "hc", "2026-11-02", { nowMs });
  assert.equal(oct31.revenue, 50);
  assert.equal(oct31.fees, 1.25);
  assert.equal(nov1.revenue, 80);
  assert.equal(nov1.fees, 2.5);
  assert.equal(nov2.revenue, 0);
  assert.equal(nov2.fees, 0);
});

test("day math: fees follow the store's timezone, not UTC", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-20T15:00:00Z");
  await allFresh(DB, nowMs);
  // 05:30Z = 01:30 New York (Oct 10) but 22:30 Los Angeles (Oct 9).
  await charge(DB, "hc", { id: 1, date: "2026-10-10T05:30:00Z", fee: 3 });
  assert.equal((await computeStoreDay(DB, "hc", "2026-10-10", { nowMs })).fees, 3);
  assert.equal((await computeStoreDay(DB, "hc", "2026-10-09", { nowMs, tz: "America/Los_Angeles" })).fees, 3);
  assert.equal((await computeStoreDay(DB, "hc", "2026-10-10", { nowMs, tz: "America/Los_Angeles" })).fees, 0);
});

test("day close at 05:00Z closes the day that just ended, in EDT and in EST", async () => {
  for (const [nowIsoStr, expected] of [["2026-10-10T05:00:00Z", "2026-10-09"], ["2026-11-10T05:00:00Z", "2026-11-09"]]) {
    const DB = makeD1();
    const nowMs = Date.parse(nowIsoStr);
    await allFresh(DB, nowMs);
    await runDayClose({ DB }, { nowMs });
    const closes = await evs(DB, "day.close");
    assert.equal(closes.length, LIVE_STORE_IDS.length);
    for (const e of closes) assert.equal(JSON.parse(e.data).day, expected, nowIsoStr);
  }
});

/* ---------------- P&L: the numbers ---------------- */

test("refunds are booked on their processed day, PENDING kept apart; revenue is the original total", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  // Order on Oct 8. The ledger's total is Shopify's CURRENT total (after $50 of refunds) = $50.
  await order(DB, "hc", { id: 10, created_at: "2026-10-08T16:00:00Z", total: 50 });
  await refund(DB, "hc", { id: 1, orderId: 10, processed_at: "2026-10-10T02:00:00Z", amount: 40, status: "SUCCESS" }); // Oct 9 22:00 EDT
  await refund(DB, "hc", { id: 2, orderId: 10, processed_at: "2026-10-09T15:00:00Z", amount: 10, status: "PENDING" });
  // A webhook order keeps its original total_price in the payload.
  await order(DB, "hc", { id: 11, created_at: "2026-10-08T17:00:00Z", total: 0, raw: { total_price: "70.00", current_total_price: "0.00" } });

  const d8 = await computeStoreDay(DB, "hc", "2026-10-08", { nowMs });
  assert.equal(d8.revenue, 170, "original totals: 50 + 50 refunded, and 70 from the payload");
  assert.equal(d8.orders, 2);
  assert.equal(d8.refunds, 0, "no refund was processed on the order day");
  const d9 = await computeStoreDay(DB, "hc", "2026-10-09", { nowMs });
  assert.equal(d9.refunds, 50);
  assert.equal(d9.refunds_success, 40);
  assert.equal(d9.refunds_pending, 10);
});

test("test and voided orders are excluded and counted in notes", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-10T16:00:00Z", total: 100 });
  await order(DB, "hc", { id: 2, created_at: "2026-10-10T16:00:00Z", total: 100, raw: { test: true, total_price: "100.00" } });
  await order(DB, "hc", { id: 3, created_at: "2026-10-10T16:00:00Z", total: 100, status: "voided" });
  const r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.revenue, 100);
  assert.equal(r.orders, 1);
  assert.equal(r.notes.excluded_test, 1);
  assert.equal(r.notes.excluded_voided, 1);
});

test("fees are null when the payouts feed isn't wired (never 0), and profit is null with profit_partial shown", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs, { skip: ["shopify.payouts.hc"] });
  await order(DB, "hc", { id: 1, created_at: "2026-10-10T16:00:00Z", total: 100 });
  await ads(DB, "hc", "2026-10-10", 20);
  const r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.fees, null);
  assert.equal(r.profit, null);
  assert.ok(r.notes.missing.includes("fees"));
  // 100 - 0 refunds - 33 COGS - 20 ads - 2 Guy
  assert.equal(r.profit_partial, 45);
  assert.equal(r.complete, 0);

  // Wired with no charges that day: 0 is now a claim.
  await markFeedOk(DB, "shopify.payouts.hc", iso(nowMs - 60000));
  const r2 = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r2.fees, 0);
  assert.equal(r2.profit, 45);
});

test("COGS is an estimate, flagged ASSUMED without a Core rate; a measured Core rate and per-product costs are used; bands are ignored", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-10T16:00:00Z", total: 100 });
  let r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.cogs, 33);
  assert.equal(r.cogs_source, "estimate");
  assert.equal(r.cogs_actual, null);
  assert.equal(r.cogs_estimated_share, 1);
  assert.equal(r.cogs_basis.rate_assumed, true);
  assert.match(r.notes.cogs_assumed, /ASSUMED 33%/);

  const fact = (store, key, value) => DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at) VALUES (?, 'pnl', ?, ?, 'observation', 'test', '2026-10-01T00:00:00Z')`).bind(store, key, value).run();
  await fact("hc", "pricing.cogs_band", "29-33%"); // a target, not a measurement
  assert.equal((await cogsRate(DB, "hc")).assumed, true);
  await fact("hc", "pnl.cogs_rate", "30.5%");
  r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.cogs, 30.5);
  assert.equal(r.cogs_basis.rate_assumed, false);
  assert.equal(r.cogs_basis.rate_source, "core:pnl.cogs_rate");
  assert.equal(r.cogs_source, "estimate", "still an estimate: KFB bills aren't wired");
  assert.equal(r.notes.cogs_assumed, undefined);

  // Per-product cost for every line of the order wins over the rate.
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, sku, product_id, quantity, price, updated_at) VALUES ('hc', 'gid://shopify/Order/1', 'l1', 'HC-1', 'p1', 2, 50, 'x')`).run();
  await fact("hc", "cost:sku:HC-1", JSON.stringify({ usd: 12.5 }));
  r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.cogs, 25);
  assert.equal(r.cogs_basis.orders_by_product_cost, 1);
  assert.equal(parseRate("0.31"), 0.31);
  assert.equal(parseRate("140"), null);
});

test("Guy's fee is charged only from his start date", async () => {
  const start = STORES.hc.guyStart;
  assert.equal(start, "2026-09-07");
  assert.equal(guyFeeFor("hc", "2026-09-06", 200), 0);
  assert.equal(guyFeeFor("hc", "2026-09-07", 200), 20);
  assert.equal(guyFeeFor("hc", "2026-09-07", null), null);
  assert.equal(guyFeeFor("cc", "2026-10-01", 200), 0, "a store without Guy config has no fee");
});

test("ROAS and break-even ROAS use the spec formula", async () => {
  // margin 0.67: 1 / (0.67 * 0.881 - 0.0334) = 1.8
  assert.equal(breakevenRoas(0.67), 1.8);
  assert.equal(breakevenRoas(0.03), null, "can't break even at any ROAS");
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-10T16:00:00Z", total: 300 });
  await ads(DB, "hc", "2026-10-10", 100);
  const r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.roas, 3);
  assert.equal(r.margin, 0.67);
  assert.equal(r.breakeven_roas, 1.8);
});

test("complete is false for today and while any input is stale; true once the day is over and all are fresh", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-11T16:00:00Z", total: 100 });
  await ads(DB, "hc", "2026-10-11", 10);
  await ads(DB, "hc", "2026-10-12", 10);
  assert.equal((await computeStoreDay(DB, "hc", "2026-10-12", { nowMs })).complete, 0, "today is partial");
  assert.equal((await computeStoreDay(DB, "hc", "2026-10-11", { nowMs })).complete, 1);
  // Ads feed last delivered 3 hours ago (limit 90 min) → stale.
  await markFeedOk(DB, "ads.spend.hc", iso(nowMs - 3 * 3600000));
  const r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.complete, 0);
  assert.deepEqual(r.notes.stale_inputs, ["ads stale"]);
  // Refund pull never ran → not wired.
  await DB.prepare(`DELETE FROM job_runs WHERE job = 'refunds.hc'`).run();
  await markFeedOk(DB, "ads.spend.hc", iso(nowMs - 60000));
  const r2 = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r2.complete, 0);
  assert.equal(r2.refunds, null);
});

test("a closed day whose numbers move is marked restated and logged", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await ads(DB, "hc", "2026-10-11", 10);
  await writePnlRow(DB, await computeStoreDay(DB, "hc", "2026-10-11", { nowMs }));
  await ads(DB, "hc", "2026-10-11", 12);
  const w = await writePnlRow(DB, await computeStoreDay(DB, "hc", "2026-10-11", { nowMs }));
  assert.equal(w.status, "restated");
  assert.equal((await evs(DB, "pnl.restated")).length, 1);
});

test("the cron recomputes 3 days per live store, at most hourly", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  const a = await runPnlCron({ DB }, { nowMs });
  assert.equal(a.ran, true);
  assert.equal(a.rows.length, 3 * LIVE_STORE_IDS.length);
  assert.equal((await runPnlCron({ DB }, { nowMs: nowMs + 15 * 60000 })).ran, false);
  assert.equal((await runPnlCron({ DB }, { nowMs: nowMs + 60 * 60000 })).ran, true);
});

test("Mission Control state: today partial, yesterday, MTD; group null when a store's part is unknown", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-03T15:00:00Z");
  await allFresh(DB, nowMs, { skip: ["shopify.payouts.mar"] });
  await order(DB, "hc", { id: 1, created_at: "2026-10-02T16:00:00Z", total: 100 });
  await recomputeDays({ DB }, { nowMs, days: 3 });
  const s = await pnlState(DB, { nowMs });
  const hc = s.stores.find((x) => x.id === "hc");
  assert.equal(hc.today.status, "partial");
  assert.equal(hc.yesterday.revenue, 100);
  assert.equal(hc.mtd.days, 2);
  assert.equal(hc.mtd.missing_days.length, 0);
  assert.equal(s.group.yesterday.fees, null, "Marlowe's fees aren't wired, so the group's aren't known");
  assert.equal(s.group.yesterday.revenue, 100);
});

/* ---------------- brief ---------------- */

function briefEnv(DB, extra = {}) {
  return { DB, ANTHROPIC_API_KEY: API_KEY, BRIEF_MODEL: "claude-sonnet-5-5", APPROVAL_SIGNING_KEY: "s".repeat(48),
    PUSHOVER_APP_TOKEN: "app-token-xyz", PUSHOVER_USER_KEY: "user-key-xyz", PUBLIC_BASE_URL: "https://brain.example", ...extra };
}

test("brief: composed once per Eastern day, only at/after 08:00 ET, with Claude via the Messages API", async () => {
  const DB = makeD1();
  const env = briefEnv(DB);
  const { fetchImpl, calls } = fakeApis();
  // 11:59Z = 07:59 EDT
  assert.equal((await runBrief(env, { nowMs: Date.parse("2026-10-12T11:59:00Z"), fetchImpl })).ran, false);
  const r = await runBrief(env, { nowMs: Date.parse("2026-10-12T12:00:00Z"), fetchImpl });
  assert.equal(r.ran, true);
  assert.equal(r.day, "2026-10-12");
  assert.equal(r.composer, "ai");
  assert.equal((await runBrief(env, { nowMs: Date.parse("2026-10-12T12:15:00Z"), fetchImpl })).ran, false);
  // In EST, 08:00 is 13:00Z.
  assert.equal((await runBrief(env, { nowMs: Date.parse("2026-11-12T12:30:00Z"), fetchImpl })).ran, false);
  assert.equal((await runBrief(env, { nowMs: Date.parse("2026-11-12T13:00:00Z"), fetchImpl })).ran, true);

  const call = calls.find((c) => c.url === "https://api.anthropic.com/v1/messages");
  assert.equal(call.init.headers["x-api-key"], API_KEY);
  assert.equal(call.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.ok(body.max_tokens <= 2000);
  assert.match(body.system, /never invent/i);
  assert.match(body.system, /short and concise while getting the info across/);
  assert.equal(body.temperature, undefined);
  assert.equal(calls.filter((c) => c.url.includes("pushover")).length, 0, "shadow: nothing to the phone");

  // AI cost shows in today's AI-cost tile.
  assert.equal(aiCostUsd("claude-sonnet-5-5", { input_tokens: 3000, output_tokens: 400 }), 0.01);
  assert.ok((await costSince(DB, "2026-10-12T04:00:00Z")) >= 0.01);
  const ai = await evs(DB, "ai.call");
  assert.equal(JSON.parse(ai[0].data).usage_in, 3000);
});

test("brief: an AI failure falls back to the plain brief, and the API key is never stored or logged", async () => {
  for (const mode of ["down", "500"]) {
    const DB = makeD1();
    const { fetchImpl } = fakeApis({ claude: mode });
    const r = await runBrief(briefEnv(DB), { nowMs: Date.parse("2026-10-12T12:05:00Z"), fetchImpl });
    assert.equal(r.composer, "plain");
    assert.match(r.body, /^> Plain brief, built by code: the AI version is unavailable/);
    assert.match(r.body, /## Yesterday's money/);
    const everything = JSON.stringify([
      (await DB.prepare(`SELECT * FROM events`).all()).results,
      (await DB.prepare(`SELECT * FROM briefs`).all()).results,
    ]);
    assert.ok(!everything.includes(API_KEY), `key leaked (${mode})`);
    assert.equal((await evs(DB, "brief.ai_failed")).length, 1);
  }
});

test("brief: no API key → plain brief, Claude is never called", async () => {
  const DB = makeD1();
  const { fetchImpl, calls } = fakeApis();
  const r = await runBrief(briefEnv(DB, { ANTHROPIC_API_KEY: undefined }), { nowMs: Date.parse("2026-10-12T12:05:00Z"), fetchImpl });
  assert.equal(r.composer, "plain");
  assert.match(r.body, /ANTHROPIC_API_KEY is not set/);
  assert.equal(calls.length, 0);
});

test("brief: numbers the data doesn't contain are flagged at the top", async () => {
  const DB = makeD1();
  const { fetchImpl } = fakeApis({ text: "## Yesterday's money\n- H&C profit $9,999.00 (great!)" });
  const r = await runBrief(briefEnv(DB), { nowMs: Date.parse("2026-10-12T12:05:00Z"), fetchImpl });
  assert.deepEqual(r.unverified, ["$9,999.00"]);
  assert.match(r.body, /^> \*\*Check:\*\*/);
  assert.deepEqual(unverifiedNumbers("ROAS 2.35 vs 1.8, margin 67%, 3 orders, $1,234", { a: 2.351, b: 1.8, m: 0.67, r: 1234 }), []);
  assert.deepEqual(unverifiedNumbers("revenue $500", { a: 499 }), ["$500"]);
});

test("brief: live mode sends a phone link that only works with a valid signature; no money in the notification", async () => {
  const DB = makeD1();
  const env = briefEnv(DB, { BRIEF_PHONE_LIVE: "1" });
  const { fetchImpl, calls } = fakeApis();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await order(DB, "hc", { id: 1, created_at: "2026-10-11T16:00:00Z", total: 123.45 });
  const r = await runBrief(env, { nowMs, fetchImpl });
  assert.equal(r.mode, "live");
  assert.equal(r.phone.sent, true);
  const push = calls.find((c) => c.url.includes("pushover"));
  const form = new URLSearchParams(push.init.body);
  assert.doesNotMatch(form.get("message"), /\$|\d+\.\d{2}/);
  const link = new URL(form.get("url"));
  assert.equal(link.pathname, `/brief/${r.id}`);
  assert.ok(link.searchParams.get("sig") && link.searchParams.get("exp"));

  const ok = await handleBriefPage(new Request(link.href), env, r.id, nowMs);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Morning brief/);
  const unsigned = await handleBriefPage(new Request(`https://brain.example/brief/${r.id}`), env, r.id, nowMs);
  assert.equal(unsigned.status, 403);
  const forged = new URL(link.href); forged.searchParams.set("sig", "0".repeat(64));
  assert.equal((await handleBriefPage(new Request(forged.href), env, r.id, nowMs)).status, 403);
  const other = new URL(link.href); other.searchParams.set("exp", String(Number(link.searchParams.get("exp")) + 1));
  assert.equal((await handleBriefPage(new Request(other.href), env, r.id, nowMs)).status, 403);
  // Expired after 48 hours.
  assert.equal((await handleBriefPage(new Request(link.href), env, r.id, nowMs + 49 * 3600000)).status, 403);
  // Through the worker: no key, no signature → not readable.
  const viaWorker = await worker.fetch(new Request(`https://brain.example/brief/${r.id}`), env);
  assert.equal(viaWorker.status, 403);
  assert.equal(await verifyBriefSig(env.APPROVAL_SIGNING_KEY, null, "x", 1, nowMs), false);
});

test("brief: shadow mode with phone keys set still sends nothing to the phone", async () => {
  const DB = makeD1();
  const { fetchImpl, calls } = fakeApis();
  const r = await runBrief(briefEnv(DB), { nowMs: Date.parse("2026-10-12T12:05:00Z"), fetchImpl });
  assert.equal(r.mode, "shadow");
  assert.equal(r.phone, null);
  assert.equal(calls.filter((c) => c.url.includes("pushover")).length, 0);
  assert.equal((await evs(DB, "brief.composed")).length, 1);
});

test("brief: plain brief says estimate/ASSUMED, PENDING refunds and not-wired feeds; HTML is escaped", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await allFresh(DB, nowMs, { skip: ["shopify.payouts.hc"] });
  await order(DB, "hc", { id: 1, created_at: "2026-10-11T16:00:00Z", total: 100 });
  await refund(DB, "hc", { id: 9, orderId: 1, processed_at: "2026-10-11T18:00:00Z", amount: 5, status: "PENDING" });
  await recomputeDays({ DB }, { nowMs });
  const d = await gatherBriefData({ DB }, { nowMs });
  const md = plainBrief(d);
  assert.match(md, /estimate, ASSUMED 33% rate/);
  assert.match(md, /PENDING/);
  assert.match(md, /fees not wired/);
  assert.match(md, /Holt & Crane — Shopify payouts: not wired/);
  const html = briefHtml("## Hi <script>alert(1)</script>\n- **bold** <img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /<h3>Hi &lt;script&gt;/);
  assert.match(html, /<li><b>bold<\/b> &lt;img/);
});

test("worker: /api/state carries the P&L and the latest brief", async () => {
  const DB = makeD1();
  const env = { ...briefEnv(DB), MC_KEY: "k".repeat(32) };
  const { fetchImpl } = fakeApis();
  await runBrief(env, { nowMs: Date.now() - 0, fetchImpl }).catch(() => {});
  const res = await worker.fetch(new Request("https://brain.example/api/state", { headers: { "x-store-brain-key": "k".repeat(32) } }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.pnl.stores));
  assert.equal(j.pnl.stores.length, LIVE_STORE_IDS.length);
  assert.equal(j.brief.mode, "shadow");
  assert.equal(FALLBACK_COGS_RATE, 0.33);
});
