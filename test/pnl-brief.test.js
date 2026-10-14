import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import {
  computeStoreDay, writePnlRow, recomputeDays, runPnlCron, runDayClose, pnlState,
  guyFeeFor, breakevenRoas, cogsRate, parseRate, FALLBACK_COGS_RATE, pnlHistory, fillMissingDays, FILL_PER_TICK,
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

/** An order as a webhook stores it: raw payload with the ORIGINAL total_price (unless `raw` is given; `raw: false` = no payload). */
async function order(DB, store, { id, created_at, total, raw = undefined, status = "paid" }) {
  const payload = raw === undefined ? { total_price: String(total) } : raw;
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: total, discounts: 0, total, financial_status: status, payload_updated_at: created_at,
  }, payload ? JSON.stringify(payload) : null, STORES[store].timezone, created_at);
}

/** Order history: covered from `from`, every change read at `readAt`. */
async function coverage(DB, store, from, readAt) {
  await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, ?, ?)
    ON CONFLICT(store) DO UPDATE SET covered_from = excluded.covered_from`).bind(store, from, readAt).run();
  await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, completed_at, last_full_read_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(store) DO UPDATE SET last_full_read_at = excluded.last_full_read_at`).bind(store, from, readAt, readAt, readAt, readAt).run();
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
    VALUES (?, ?, ?, ?, 100, ?, ?, 'USD', ?, '2026-10-11T00:00:00Z') ON CONFLICT(store, txn_id) DO NOTHING`).bind(store, `gid://t/${id}`, type, date, fee, 100 - fee, test).run();
}

/** Make every input of every live store fresh as of `nowMs` (order history covered from 2026-01-01). */
async function allFresh(DB, nowMs, { skip = [] } = {}) {
  await ensureFeeds(DB);
  const at = iso(nowMs - 60000);
  for (const id of LIVE_STORE_IDS) {
    if (!skip.includes(`coverage.${id}`)) await coverage(DB, id, "2026-01-01", at);
    for (const f of [`shopify.orders.${id}`, `ads.spend.${id}`, `shopify.payouts.${id}`]) {
      if (!skip.includes(f)) await markFeedOk(DB, f, at);
    }
    if (!skip.includes(`refunds.${id}`)) {
      await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at`).bind(`refunds.${id}`, at).run();
      await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, updated_at) VALUES (?, 'refunds', '2026-01-01', '2026-01-01', ?)
        ON CONFLICT(store, feed) DO NOTHING`).bind(id, at).run();
    }
    // Fees are known from the day after the oldest stored balance transaction: anchor history.
    if (!skip.includes(`fees.${id}`)) await charge(DB, id, { id: `anchor-${id}`, date: "2026-01-01T12:00:00Z", fee: 0, type: "ADJUSTMENT" });
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
  // Order on Oct 8, read by a GraphQL pull: the ledger's total is Shopify's CURRENT total
  // (after $50 of refunds) = $50; the original is in totalPriceSet = $100.
  await order(DB, "hc", { id: 10, created_at: "2026-10-08T16:00:00Z", total: 50,
    raw: { id: "gid://shopify/Order/10", test: false, totalPriceSet: { shopMoney: { amount: "100.0" } }, currentTotalPriceSet: { shopMoney: { amount: "50.0" } } } });
  await refund(DB, "hc", { id: 1, orderId: 10, processed_at: "2026-10-10T02:00:00Z", amount: 40, status: "SUCCESS" }); // Oct 9 22:00 EDT
  await refund(DB, "hc", { id: 2, orderId: 10, processed_at: "2026-10-09T15:00:00Z", amount: 10, status: "PENDING" });
  // A webhook order keeps its original total_price in the payload.
  await order(DB, "hc", { id: 11, created_at: "2026-10-08T17:00:00Z", total: 0, raw: { total_price: "70.00", current_total_price: "0.00" } });

  const d8 = await computeStoreDay(DB, "hc", "2026-10-08", { nowMs });
  assert.equal(d8.revenue, 170, "original totals: 100 from totalPriceSet, 70 from the webhook total_price");
  assert.equal(d8.orders, 2);
  assert.equal(d8.refunds, 0, "no refund was processed on the order day");
  const d9 = await computeStoreDay(DB, "hc", "2026-10-09", { nowMs });
  assert.equal(d9.refunds, 50);
  assert.equal(d9.refunds_success, 40);
  assert.equal(d9.refunds_pending, 10);

  // No guessing from "current total + refunds": an order without its original total makes revenue unknown.
  await order(DB, "hc", { id: 12, created_at: "2026-10-08T18:00:00Z", total: 30, raw: false });
  const again = await computeStoreDay(DB, "hc", "2026-10-08", { nowMs });
  assert.equal(again.revenue, null);
  assert.equal(again.profit, null);
  assert.equal(again.notes.unknown_total, 1);
  assert.ok(again.notes.missing.includes("revenue"));
});

test("test and voided orders are excluded and counted in notes", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-10T16:00:00Z", total: 100 });
  await order(DB, "hc", { id: 2, created_at: "2026-10-10T16:00:00Z", total: 100, raw: { test: true, total_price: "100.00" } });
  // A GraphQL-shaped test order (reconcile / backfill now fetch `test`).
  await order(DB, "hc", { id: 4, created_at: "2026-10-10T16:00:00Z", total: 100, raw: { test: true, totalPriceSet: { shopMoney: { amount: "100.0" } } } });
  await order(DB, "hc", { id: 3, created_at: "2026-10-10T16:00:00Z", total: 100, status: "voided" });
  const r = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(r.revenue, 100);
  assert.equal(r.orders, 1);
  assert.equal(r.notes.excluded_test, 2);
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

test("the cron recomputes 3 days per live store, every 15-minute tick (not twice in one tick)", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  const a = await runPnlCron({ DB }, { nowMs });
  assert.equal(a.ran, true);
  assert.equal(a.rows.length, 3 * LIVE_STORE_IDS.length);
  assert.equal((await runPnlCron({ DB }, { nowMs: nowMs + 60000 })).ran, false, "a second run in the same tick is skipped");
  assert.equal((await runPnlCron({ DB }, { nowMs: nowMs + 15 * 60000 })).ran, true, "the next tick recomputes");
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
  assert.equal(r.checked, false);
  assert.match(r.body, /^> \*\*Unverified numbers:\*\* \$9,999\.00\./);
  const stored = await DB.prepare(`SELECT checked, unverified FROM briefs WHERE id = ?`).bind(r.id).first();
  assert.equal(stored.checked, 0);
  assert.deepEqual(unverifiedNumbers("ROAS 2.35 vs 1.8, margin 67%, 3 orders, $1,234", { a: 2.351, b: 1.8, m: 0.67, r: 1234 }), []);
  assert.deepEqual(unverifiedNumbers("revenue $500", { a: 499 }), ["$500"]);
});

test("brief check: only computed figures count — digits in ids, timestamps, order names and text never whitelist a number", () => {
  const text = "lost $52; margin 37%; refunds $118; ads $1,047; profit $455.90";
  // Every one of those digits appears in the data, but only inside ids, timestamps, names and text.
  const data = {
    waiting: { approvals: [{ id: 52, title: "Holt & Crane #1047 not delivered 37 days" }] },
    money: { scheduled_payouts: [{ date: "2026-10-11", note: "payout $118.00 ref 455.90" }] },
    feeds_not_fresh: [{ last_ok_at: "2026-10-11T10:37:52Z" }],
    orders: { new_flags_24h: [{ order: "#118", detail: "Day 37 $1,047" }] },
    stores: [{ yesterday: { revenue: 800, profit: 12.5, margin: 0.61, roas: 2.4 } }],
  };
  assert.deepEqual(unverifiedNumbers(text, data), ["$52", "37%", "$118", "$1,047", "$455.90"]);
  assert.deepEqual(unverifiedNumbers(text, {}), ["$52", "37%", "$118", "$1,047", "$455.90"]);
  // The same figures, computed, pass in any normalisation: 1047.2 ≡ "$1,047.20" ≡ "$1,047"; 0.37 ≡ "37%".
  const computed = { loss: -52, margin: 0.37, refunds: 118, ads: 1047.2, profit: 455.9 };
  assert.deepEqual(unverifiedNumbers(text, computed), []);
  assert.deepEqual(unverifiedNumbers("ads $1,047.20, $1.05k, ROAS 2.4x vs break-even 1.8", { ads: 1047.2, roas: 2.4, be: 1.8 }), []);
  assert.deepEqual(unverifiedNumbers("ads $1,048 · ROAS 3.1 · break-even 3", { ads: 1047.2, roas: 2.4, be: 1.8 }), ["$1,048", "ROAS 3.1", "break-even 3"]);
  // Order names and dates: only those in the references given to the model.
  const refs = { references: {}, x: { order: "#1231", day: "2026-10-10" } };
  assert.deepEqual(unverifiedNumbers("#1231 on 2026-10-10 (Oct 10) at 08:00, 3 orders", refs), []);
  assert.deepEqual(unverifiedNumbers("#1232 on 2026-10-09 and Oct 31", refs), ["#1232", "2026-10-09", "Oct 31"]);
});

test("brief: the data given to the model carries the order-name/date references it may use", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await allFresh(DB, nowMs);
  await DB.prepare(`INSERT INTO shipment_flags (store, order_id, order_name, kind, detail, raised_at) VALUES ('hc', 'gid://shopify/Order/1231', '#1231', 'day15', 'Day 15', ?)`).bind(iso(nowMs - 3600000)).run();
  const d = await gatherBriefData({ DB, PARCEL_TRACKING: "1" }, { nowMs }); // parcel flags exist only with tracking on
  assert.ok(d.references.order_names.includes("#1231"));
  assert.ok(d.references.dates.includes("2026-10-11"));
  assert.match((await import("../src/lib/brief.js")).SYSTEM_PROMPT, /DATA\.references/);
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

test("cogs: the Core's measured 'EUR per $1' blanket rate is used (×1.17 est. FX), not the 33% fallback", async () => {
  const { makeD1 } = await import("./helpers/d1.js");
  const { cogsRate } = await import("../src/lib/pnl.js");
  const DB = makeD1();
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at) VALUES ('hc','pnl','cogs.blanket_rate','H&C blanket COGS estimate rate: 0.2849 EUR per $1 of revenue (176 orders).','observation','vault','2026-10-06')`).run();
  const r = await cogsRate(DB, "hc");
  assert.equal(r.assumed, false);
  assert.ok(Math.abs(r.rate - 0.2849 * 1.17) < 1e-9);
  assert.match(r.source, /est\. FX/);
  const m = await cogsRate(DB, "mar");
  assert.equal(m.assumed, true);
});

/* ---------------- review fixes: coverage, completeness, rule 4, AI spend, stuck briefs ---------------- */

test("order coverage: a day before the backfill's coverage (or with none yet) has profit null; the brief says MTD covers X of Y days", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs, { skip: ["coverage.hc"] });
  for (const d of ["2026-10-04", "2026-10-11"]) {
    await order(DB, "hc", { id: d.slice(8), created_at: `${d}T16:00:00Z`, total: 100 });
    await ads(DB, "hc", d, 10);
  }
  // No coverage at all yet.
  let r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.revenue, 100, "revenue shown, but flagged");
  assert.equal(r.profit, null);
  assert.ok(r.notes.missing.includes("order_history"));
  assert.equal(r.notes.missing_why.order_history, "orders backfill not finished");
  assert.equal(r.complete, 0);
  assert.equal(r.profit_partial, 56);

  // Covered from Oct 6: Oct 11 complete, Oct 4 not.
  await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES ('hc', '2026-10-06', ?)`).bind(iso(nowMs - 60000)).run();
  await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, last_full_read_at) VALUES ('hc', '2026-10-06', ?, ?, ?)`)
    .bind(iso(nowMs - 60000), iso(nowMs - 60000), iso(nowMs - 60000)).run();
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.profit, 56);
  assert.equal(r.complete, 1);
  const early = await computeStoreDay(DB, "hc", "2026-10-04", { nowMs });
  assert.equal(early.profit, null);
  assert.match(early.notes.missing_why.order_history, /only covers 2026-10-06 onwards/);
  assert.equal(early.complete, 0);

  await recomputeDays({ DB }, { nowMs, days: 12 });
  const s = await pnlState(DB, { nowMs });
  const hc = s.stores.find((x) => x.id === "hc");
  assert.equal(hc.mtd.order_history_days, 6);
  assert.equal(hc.mtd.days_in_period, 11);
  assert.equal(hc.mtd.profit, null);
  const d = await gatherBriefData({ DB }, { nowMs });
  const m = d.stores.find((x) => x.id === "hc").month_to_date;
  assert.equal(m.order_history_days_covered, 6);
  assert.equal(m.days_in_period, 11);
  assert.match(plainBrief(d), /Holt & Crane month to date covers 6 of 11 days/);
});

test("complete: only once the day has ended AND each input was pulled 2 h after it (payouts 6 h) AND coverage includes it", async () => {
  const DB = makeD1();
  // Oct 11 ends 2026-10-12T04:00Z (EDT).
  const end = Date.parse("2026-10-12T04:00:00Z");
  await order(DB, "hc", { id: 1, created_at: "2026-10-11T16:00:00Z", total: 100 });
  await ads(DB, "hc", "2026-10-11", 10);
  // 1 hour after the day ended, every feed fresh: not complete (pulls too early).
  await allFresh(DB, end + 3600000);
  let r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs: end + 3600000 });
  assert.equal(r.complete, 0);
  assert.equal(r.profit, 56, "the numbers are usable, the day just isn't settled");
  assert.deepEqual(r.notes.unsettled.sort(), ["ads not pulled 2 h after the day ended", "orders not pulled 2 h after the day ended",
    "payouts not pulled 6 h after the day ended", "refunds not pulled 2 h after the day ended"]);
  // 3 hours after: orders, refunds, ads settled; payouts not yet (6 h).
  await allFresh(DB, end + 3 * 3600000);
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs: end + 3 * 3600000 });
  assert.equal(r.complete, 0);
  assert.deepEqual(r.notes.unsettled, ["payouts not pulled 6 h after the day ended"]);
  // 7 hours after: complete.
  await allFresh(DB, end + 7 * 3600000);
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs: end + 7 * 3600000 });
  assert.equal(r.complete, 1);
  // The orders input's pull is the backfill's last FULL read, not the webhook-fed feed.
  await DB.prepare(`UPDATE order_backfill SET last_full_read_at = ? WHERE store = 'hc'`).bind(iso(end + 3600000)).run();
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs: end + 7 * 3600000 });
  assert.equal(r.complete, 0);
  assert.deepEqual(r.notes.unsettled, ["orders not pulled 2 h after the day ended"]);
});

test("rule 4: a stale input gives a null component (never computed from stale data); profit null, profit_partial names what's missing", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-11T16:00:00Z", total: 100 });
  await refund(DB, "hc", { id: 1, orderId: 1, processed_at: "2026-10-11T18:00:00Z", amount: 5 });
  await ads(DB, "hc", "2026-10-11", 10);
  await charge(DB, "hc", { id: 1, date: "2026-10-11T16:00:00Z", fee: 3 });
  let r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.profit, 100 - 5 - 33 - 10 - 1 - 3);

  // Ads feed last delivered 3 h ago (limit 90 min): the stored row is NOT used.
  await markFeedOk(DB, "ads.spend.hc", iso(nowMs - 3 * 3600000));
  // Payouts feed past its 6 h limit.
  await markFeedOk(DB, "shopify.payouts.hc", iso(nowMs - 7 * 3600000));
  // Refund pull watermark 3 h old.
  await DB.prepare(`UPDATE job_runs SET last_run_at = ? WHERE job = 'refunds.hc'`).bind(iso(nowMs - 3 * 3600000)).run();
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.ads, null);
  assert.equal(r.guy_fee, null);
  assert.equal(r.fees, null);
  assert.equal(r.refunds, null);
  assert.equal(r.revenue, 100);
  assert.equal(r.profit, null);
  assert.equal(r.profit_partial, 67, "revenue - COGS only");
  assert.deepEqual(r.notes.missing, ["refunds", "ads", "guy_fee", "fees"]);
  assert.equal(r.notes.missing_why.ads, "ads stale");
  assert.equal(r.notes.missing_why.fees, "payouts stale");
  assert.equal(r.notes.missing_why.refunds, "refunds stale");
  assert.equal(r.roas, null);

  // Orders feed stale → revenue, orders and COGS null.
  await markFeedOk(DB, "shopify.orders.hc", iso(nowMs - 2 * 3600000));
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.revenue, null);
  assert.equal(r.orders, null);
  assert.equal(r.cogs, null);
  assert.equal(r.notes.missing_why.revenue, "orders stale");

  // A failing feed whose last success is still inside its age limit stays usable (rule 6).
  await markFeedOk(DB, "shopify.orders.hc", iso(nowMs - 10 * 60000));
  await DB.prepare(`UPDATE feeds SET last_try_at = ?, last_error = 'HTTP 502' WHERE id = 'shopify.orders.hc'`).bind(iso(nowMs - 60000)).run();
  r = await computeStoreDay(DB, "hc", "2026-10-11", { nowMs });
  assert.equal(r.revenue, 100);
  assert.equal(r.complete, 0, "but the day is not complete while a feed is failing");
});

test("AI spend is logged even when Claude's answer is empty or malformed", async () => {
  for (const content of [[], [{ type: "text", text: "   " }], "nonsense"]) {
    const DB = makeD1();
    const fetchImpl = async (url, init) => {
      if (url.includes("anthropic")) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ model: body.model, stop_reason: "end_turn", content, usage: { input_tokens: 3000, output_tokens: 400 } }), { status: 200 });
      }
      throw new Error("unexpected " + url);
    };
    const r = await runBrief(briefEnv(DB), { nowMs: Date.parse("2026-10-12T12:05:00Z"), fetchImpl });
    assert.equal(r.composer, "plain");
    assert.match(r.aiError, /returned no text/);
    const ai = await evs(DB, "ai.call");
    assert.equal(ai.length, 1, JSON.stringify(content));
    assert.equal(JSON.parse(ai[0].data).usage_in, 3000);
    assert.equal(ai[0].cost_usd, 0.01);
    const b = await DB.prepare(`SELECT cost_usd, input_tokens, output_tokens FROM briefs WHERE id = ?`).bind(r.id).first();
    assert.equal(b.cost_usd, 0.01);
    assert.equal(b.input_tokens, 3000);
  }
});

test("a brief stuck in 'composing' for over 30 minutes is reclaimed by the next run, once; a younger one is left alone", async () => {
  const DB = makeD1();
  const env = briefEnv(DB);
  const { fetchImpl } = fakeApis();
  const t0 = Date.parse("2026-10-12T12:00:00Z");
  // A run that died part-way at 08:00 ET.
  await DB.prepare(`INSERT INTO briefs (day, created_at, status, mode) VALUES ('2026-10-12', ?, 'composing', 'shadow')`).bind(iso(t0)).run();
  assert.equal((await runBrief(env, { nowMs: t0 + 15 * 60000, fetchImpl })).ran, false, "15 min: may still be running");
  const r = await runBrief(env, { nowMs: t0 + 31 * 60000, fetchImpl });
  assert.equal(r.ran, true);
  assert.equal(r.reclaimed, iso(t0));
  const rec = await evs(DB, "brief.reclaimed");
  assert.equal(rec.length, 1);
  assert.match(rec[0].summary, /never finished/);
  const rows = (await DB.prepare(`SELECT status FROM briefs`).all()).results;
  assert.deepEqual(rows.map((x) => x.status), ["ready"]);
  // A ready brief is never reclaimed.
  assert.equal((await runBrief(env, { nowMs: t0 + 120 * 60000, fetchImpl })).ran, false);
  assert.equal((await evs(DB, "brief.reclaimed")).length, 1);
});


test("rule 5: refunds and fees before their first full read are unknown (null), never $0", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-11T18:00:00Z");
  await allFresh(DB, nowMs, { skip: ["fees.hc"] });
  await DB.prepare(`UPDATE feed_coverage SET covered_from = '2026-10-09' WHERE store = 'hc' AND feed = 'refunds'`).run();
  await charge(DB, "hc", { id: "t1", date: "2026-10-09T16:00:00Z", fee: 2 });
  const { computeStoreDay } = await import("../src/lib/pnl.js");
  const early = await computeStoreDay(DB, "hc", "2026-10-08", { nowMs });
  assert.equal(early.refunds, null);
  assert.equal(early.fees, null);
  assert.equal(early.profit, null);
  const later = await computeStoreDay(DB, "hc", "2026-10-10", { nowMs });
  assert.equal(later.refunds, 0);
  assert.equal(later.fees, 0);
});

test("review fix: a loss written up as profit is flagged; ordinary decimals are not", async () => {
  const { unverifiedNumbers } = await import("../src/lib/brief.js");
  const data = { group: { yesterday: { profit: -52, revenue: 400, refunds: 118, ads: 1047.2, breakeven_roas: 1.9 } }, references: [] };
  assert.deepEqual(unverifiedNumbers("profit $52 (good day)", data), ["$52"]);
  assert.deepEqual(unverifiedNumbers("lost $52 yesterday", data), []);
  assert.deepEqual(unverifiedNumbers("profit -$52", data), []);
  assert.deepEqual(unverifiedNumbers("written by Claude Sonnet 5.5; parcel 1.5 days late; break-even 1.9; ads $1,047; refunds $118", data), []);
  assert.deepEqual(unverifiedNumbers("COGS at the ASSUMED 33% rate", data), ["33%"], "33% only when a row is assumed");
  assert.deepEqual(unverifiedNumbers("COGS at the ASSUMED 33% rate", { ...data, x: { cogs_rate_assumed: true } }), []);
  assert.deepEqual(unverifiedNumbers("The net loss was $52. A loss of about $52. In the red by $52.", data), []);
  assert.deepEqual(unverifiedNumbers("Margin was 12%", { m: { margin: -0.12 } }), ["12%"]);
  assert.deepEqual(unverifiedNumbers("Margin was -12%", { m: { margin: -0.12 } }), []);
  assert.deepEqual(unverifiedNumbers("No losses today, net profit $52.", data), ["$52"]);
  assert.deepEqual(unverifiedNumbers("Ad spend down, margin 12%.", { m: { margin: -0.12 } }), ["12%"]);
});

test("review fix: a failed first refunds read can't be mistaken for a full one", async () => {
  const { pullStoreRefunds } = await import("../src/lib/refunds.js");
  const { _resetTokenCacheForTests } = await import("../src/lib/storeGuard.js");
  const DB = makeD1();
  const env = { DB, SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b" };
  await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES ('refunds.hc', '2026-10-11T15:00:00Z')`).run();
  const queries = [];
  let fail = true;
  const fetchImpl = async (url, init) => {
    if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    const b = JSON.parse(init.body); if (b.variables && b.variables.query) queries.push(b.variables.query);
    if (fail) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, nodes: [] } }));
  };
  _resetTokenCacheForTests();
  await assert.rejects(pullStoreRefunds(env, "hc", { fetchImpl, nowMs: Date.parse("2026-10-11T16:00:00Z") }));
  fail = false;
  await pullStoreRefunds(env, "hc", { fetchImpl, nowMs: Date.parse("2026-10-11T16:30:00Z") });
  assert.match(queries.at(-1), /2026-08-31/, "second run still reads from the window start");
  const cov = await DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store='hc'`).first();
  assert.equal(cov.covered_from, "2026-09-01");
});

test("review fix: backfill window never reaches past Shopify's 60-day order limit", async () => {
  const { backfillFromDay } = await import("../src/lib/orderBackfill.js");
  assert.equal(backfillFromDay(Date.parse("2026-10-11T16:00:00Z"), "America/New_York"), "2026-09-01");
  // Aug 31 → first of July is 61 days back: clamped.
  assert.equal(backfillFromDay(Date.parse("2026-08-31T16:00:00Z"), "America/New_York"), "2026-07-04");
});

test("review fix: a refunds watermark without a coverage row triggers one full read and gets coverage", async () => {
  const { pullStoreRefunds } = await import("../src/lib/refunds.js");
  const DB = makeD1();
  await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES ('refunds.hc', '2026-10-11T15:00:00Z')`).run();
  let query = null;
  const env = { DB, SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b" };
  const fetchImpl = async (url, init) => {
    if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    const b = JSON.parse(init.body); query = query || b.variables && b.variables.query;
    return new Response(JSON.stringify({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, nodes: [] } }));
  };
  const { _resetTokenCacheForTests } = await import("../src/lib/storeGuard.js");
  _resetTokenCacheForTests();
  const r = await pullStoreRefunds(env, "hc", { fetchImpl, nowMs: Date.parse("2026-10-11T16:00:00Z") });
  assert.equal(r.ok, true);
  assert.match(query, /2026-08-31/);
  const cov = await DB.prepare(`SELECT covered_from FROM feed_coverage WHERE store='hc' AND feed='refunds'`).first();
  assert.equal(cov.covered_from, "2026-09-01");
});

test("review fix: an unfinished orders backfill re-clamps to the 60-day window", async () => {
  const { backfillStore } = await import("../src/lib/orderBackfill.js");
  const { _resetTokenCacheForTests } = await import("../src/lib/storeGuard.js");
  const DB = makeD1();
  await DB.prepare(`INSERT INTO order_backfill (store, query_from, cursor, started_at, updated_at) VALUES ('hc', '2026-06-01', 'old-cursor', 'x', 'x')`).run();
  const queries = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    const b = JSON.parse(init.body); queries.push(b.variables);
    return new Response(JSON.stringify({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
  };
  _resetTokenCacheForTests();
  await backfillStore({ DB, SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b" }, "hc", { nowMs: Date.parse("2026-10-11T16:00:00Z"), opts: { fetchImpl } });
  const row = await DB.prepare(`SELECT query_from FROM order_backfill WHERE store='hc'`).first();
  assert.equal(row.query_from, "2026-09-01");
  assert.equal(queries[0].after ?? null, null, "old cursor dropped");
  const cov = await DB.prepare(`SELECT covered_from FROM order_coverage WHERE store='hc'`).first();
  assert.ok(!cov || cov.covered_from >= "2026-08-14");
});

/* ---------------- P&L page history (/api/pnl) ---------------- */

test("P&L history: one store's days newest first; the group sums stores and is null-profit when a store's day is missing", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-03T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-02T16:00:00Z", total: 100 });
  await order(DB, "aub", { id: 2, created_at: "2026-10-02T17:00:00Z", total: 50 });
  await recomputeDays({ DB }, { nowMs, days: 3 });

  const hc = await pnlHistory(DB, "hc", { nowMs });
  assert.equal(hc.ok, true);
  assert.deepEqual(hc.days.map((d) => d.day), ["2026-10-03", "2026-10-02", "2026-10-01"]);
  assert.equal(hc.days[1].revenue, 100);

  const all = await pnlHistory(DB, "all", { nowMs });
  const y = all.days.find((d) => d.day === "2026-10-02");
  assert.equal(y.revenue, 150, "group revenue is the sum of the stores");
  assert.equal(y.per_store.length, LIVE_STORE_IDS.length);
  assert.deepEqual(y.missing_stores, []);

  // Remove Marlowe's row for that day: the group can't claim a profit for it.
  await DB.prepare(`DELETE FROM pnl_days WHERE store = 'mar' AND day = '2026-10-02'`).run();
  const all2 = await pnlHistory(DB, "all", { nowMs });
  const y2 = all2.days.find((d) => d.day === "2026-10-02");
  assert.deepEqual(y2.missing_stores, ["mar"]);
  assert.equal(y2.profit, null);
  assert.equal(y2.complete, false);
  for (const k of ["revenue", "ads", "cogs", "fees", "refunds", "orders", "roas", "breakeven_roas"]) {
    assert.equal(y2[k], null, `group ${k} is unknown when a store's day is missing (a partial sum would understate)`);
  }
  // A store expected from its coverage start is missing even if its rows start later
  // (history still filling): the group day stays unknown, never a partial "profit".
  await DB.prepare(`DELETE FROM pnl_days WHERE store = 'mar' AND day = '2026-10-01'`).run();
  const all3 = await pnlHistory(DB, "all", { nowMs });
  const d1 = all3.days.find((d) => d.day === "2026-10-01");
  assert.deepEqual(d1.missing_stores, ["mar"]);
  assert.equal(d1.ads, null);
  // Before a store's coverage start it simply wasn't tracked yet: not a gap.
  await DB.prepare(`UPDATE order_coverage SET covered_from = '2026-10-03' WHERE store = 'mar'`).run();
  const all4 = await pnlHistory(DB, "all", { nowMs });
  assert.deepEqual(all4.days.find((d) => d.day === "2026-10-01").missing_stores, []);
  // A store whose history read hasn't finished (no coverage row) is expected as far back as
  // the others, so those group days stay unknown.
  await DB.prepare(`DELETE FROM order_coverage WHERE store = 'mar'`).run();
  const all5 = await pnlHistory(DB, "all", { nowMs });
  assert.deepEqual(all5.days.find((d) => d.day === "2026-10-01").missing_stores, ["mar"]);

  assert.equal((await pnlHistory(DB, "cc", { nowMs })).ok, false, "a store that isn't live has no P&L");
});

test("worker: /api/pnl needs the key and returns the history", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: "k".repeat(32) };
  const no = await worker.fetch(new Request("https://brain.example/api/pnl?store=all"), env);
  assert.equal(no.status, 401);
  const res = await worker.fetch(new Request("https://brain.example/api/pnl?store=all", { headers: { "x-store-brain-key": "k".repeat(32) } }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.days));
  const bad = await worker.fetch(new Request("https://brain.example/api/pnl?store=zzz", { headers: { "x-store-brain-key": "k".repeat(32) } }), env);
  assert.equal(bad.status, 400);
});

test("history fill: days since order coverage with no P&L row are computed, a few per tick, oldest first", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-11T15:00:00Z");
  await allFresh(DB, nowMs);
  await DB.prepare(`UPDATE order_coverage SET covered_from = '2026-09-20'`).run();
  await order(DB, "hc", { id: 7, created_at: "2026-09-20T16:00:00Z", total: 80 });
  const a = await fillMissingDays({ DB }, { nowMs });
  assert.equal(a.length, FILL_PER_TICK);
  assert.deepEqual(a[0], { store: "hc", day: "2026-09-20", kind: "filled" });
  const row = await DB.prepare(`SELECT revenue FROM pnl_days WHERE store = 'hc' AND day = '2026-09-20'`).first();
  assert.equal(row.revenue, 80);
  // Keeps going on later ticks until every day up to the recompute window has a row.
  for (let i = 0; i < 10; i++) await fillMissingDays({ DB }, { nowMs });
  const n = await DB.prepare(`SELECT COUNT(*) AS n FROM pnl_days WHERE store = 'hc' AND day >= '2026-09-20' AND day <= '2026-10-08'`).first();
  assert.equal(n.n, 19);
  const last = await fillMissingDays({ DB }, { nowMs });
  assert.equal(last.filter((x) => x.kind === "filled").length, 0, "nothing left to fill");
  assert.ok(last.length <= FILL_PER_TICK, "revisits of incomplete old days stay bounded per tick");
});

test("history fill: uneven fill across stores never gives a group day without every store", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-11T15:00:00Z");
  await allFresh(DB, nowMs);
  await DB.prepare(`UPDATE order_coverage SET covered_from = '2026-09-20'`).run();
  for (const id of LIVE_STORE_IDS) for (let d = 20; d <= 30; d++) await ads(DB, id, `2026-09-${d}`, 50);
  await recomputeDays({ DB }, { nowMs, days: 3 });
  await fillMissingDays({ DB }, { nowMs }); // one tick: only Holt & Crane's oldest days so far
  const all = await pnlHistory(DB, "all", { nowMs });
  const d = all.days.find((x) => x.day === "2026-09-21");
  assert.ok(d.missing_stores.length > 0);
  assert.equal(d.ads, null, "never $50 of a true $150");
  assert.equal(d.profit, null);
});

test("history fill: skips a store whose orders feed is stale; revisits incomplete old rows", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-11T15:00:00Z");
  await allFresh(DB, nowMs, { skip: ["shopify.orders.hc"] });
  await DB.prepare(`UPDATE order_coverage SET covered_from = '2026-10-01'`).run();
  const a = await fillMissingDays({ DB }, { nowMs });
  assert.ok(a.every((x) => x.store !== "hc"), "no blank days written for a stale store");
  // An old incomplete row gets recomputed on a later tick.
  await DB.prepare(`UPDATE pnl_days SET complete = 0, computed_at = '2026-01-01T00:00:00Z' WHERE store = 'aub' AND day = '2026-10-01'`).run();
  for (let i = 0; i < 5; i++) await fillMissingDays({ DB }, { nowMs });
  const r = await DB.prepare(`SELECT computed_at FROM pnl_days WHERE store = 'aub' AND day = '2026-10-01'`).first();
  assert.notEqual(r.computed_at, "2026-01-01T00:00:00Z");
});

test("brief: with parcel tracking off (Reilly, Oct 13) the brief carries no parcel flags and says tracking is off", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await allFresh(DB, nowMs);
  await DB.prepare(`INSERT INTO shipment_flags (store, order_id, order_name, kind, detail, raised_at) VALUES ('hc', 'o1', '#1231', 'day15', 'Day 15', ?)`).bind(iso(nowMs - 3600000)).run();
  const d = await gatherBriefData({ DB }, { nowMs });
  assert.deepEqual(d.orders.open_shipping_flags, {});
  assert.equal(d.orders.new_flags_24h.length, 0);
  assert.match(plainBrief(d), /Parcel tracking: off/);
});

/* ---------------- brief rewrite ---------------- */

test("rewrite: same row (id, created_at, phone kept), never re-sent to the phone; the cron won't compose again", async () => {
  const { rewriteBrief } = await import("../src/lib/brief.js");
  const DB = makeD1();
  const env = briefEnv(DB, { BRIEF_PHONE_LIVE: "1" });
  const nowMs = Date.parse("2026-10-13T12:05:00Z"); // 08:05 EDT
  await allFresh(DB, nowMs);
  const { fetchImpl, calls } = fakeApis();
  const first = await runBrief(env, { nowMs, fetchImpl });
  const before = await DB.prepare(`SELECT id, created_at, phone FROM briefs WHERE day = '2026-10-13'`).first();
  const pushes = () => calls.filter((c) => c.url.includes("pushover")).length;
  const p0 = pushes();
  const later = nowMs + 60 * 60000;
  const r = await rewriteBrief(env, { nowMs: later, fetchImpl });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = await DB.prepare(`SELECT id, created_at, phone, status FROM briefs WHERE day = '2026-10-13'`).first();
  assert.equal(after.id, before.id);
  assert.equal(after.created_at, before.created_at, "the 8:00 phone link stays valid");
  assert.equal(after.phone, before.phone);
  assert.equal(after.status, "ready");
  assert.equal(pushes(), p0, "a rewrite never notifies the phone");
  assert.equal((await runBrief(env, { nowMs: later + 15 * 60000, fetchImpl })).ran, false, "the cron doesn't compose again");
  assert.equal((await rewriteBrief(env, { nowMs: later + 60000, fetchImpl })).ok, false, "at most every 10 minutes");
  assert.ok(first.ran);
});

test("rewrite: a failure puts the earlier brief back (nothing deleted, no second notification)", async () => {
  const { rewriteBrief, latestBrief } = await import("../src/lib/brief.js");
  const DB = makeD1();
  const env = briefEnv(DB);
  const nowMs = Date.parse("2026-10-13T12:05:00Z");
  await allFresh(DB, nowMs);
  await runBrief(env, { nowMs, fetchImpl: fakeApis().fetchImpl });
  const old = await latestBrief(DB);
  const boom = async () => { throw new Error("boom"); };
  // Make the fresh-numbers step throw: break the P&L table for this run only.
  const realPrepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => { if (/FROM pnl_days/.test(sql) && /SELECT/.test(sql)) throw new Error("D1 down"); return realPrepare(sql); };
  const r = await rewriteBrief(env, { nowMs: nowMs + 3600000, fetchImpl: boom });
  DB.prepare = realPrepare;
  assert.equal(r.ok, false);
  const now = await latestBrief(DB);
  assert.equal(now.id, old.id);
  assert.equal(now.body_md, old.body_md, "the earlier brief is still there");
  const row = await DB.prepare(`SELECT status FROM briefs WHERE id = ?`).bind(old.id).first();
  assert.equal(row.status, "ready");
});

test("brief: a restated closed day reaches the brief only when money moved by $5+", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await allFresh(DB, nowMs);
  const { logEvent } = await import("../src/lib/eventlog.js");
  await logEvent(DB, { actor: "pnl.ledger", kind: "pnl.restated", store: "hc", summary: "penny", data: { day: "2026-10-10", changed: ["ads"], before: { ads: 42.47 }, after: { ads: 42.94 } }, at: iso(nowMs - 3600000) });
  await logEvent(DB, { actor: "pnl.ledger", kind: "pnl.restated", store: "hc", summary: "big one", data: { day: "2026-10-09", changed: ["revenue"], before: { revenue: 900 }, after: { revenue: 400 } }, at: iso(nowMs - 3600000) });
  const d = await gatherBriefData({ DB }, { nowMs });
  const txt = JSON.stringify(d);
  assert.ok(txt.includes("big one"));
  assert.ok(!txt.includes("penny"));
});

test("brief: dozens of tiny restatements never push a real alarm out", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-12T12:05:00Z");
  await allFresh(DB, nowMs);
  const { logEvent } = await import("../src/lib/eventlog.js");
  await logEvent(DB, { actor: "pnl.pullers", kind: "error.money_job", summary: "REAL ALARM", at: iso(nowMs - 7200000) });
  for (let i = 0; i < 60; i++) await logEvent(DB, { actor: "pnl.ledger", kind: "pnl.restated", store: "hc", summary: "penny", data: { day: "2026-10-10", changed: ["ads"], before: { ads: 1 }, after: { ads: 1.01 } }, at: iso(nowMs - 3600000) });
  const txt = JSON.stringify(await gatherBriefData({ DB }, { nowMs }));
  assert.ok(txt.includes("REAL ALARM"));
  assert.ok(!txt.includes("penny"));
});

/* Live 2026-10-14: "Morning brief has 3 numbers not found in its data: $65.95, -$61.29, -$47.23".
 * $65.95 was the #1098 chargeback, only inside an approval title; -$61.29 → -$47.23 was a
 * restated P&L day, only inside the event's text. Both are now numbers in the data. */
async function liveCase(DB, nowMs) {
  await allFresh(DB, nowMs);
  const { createApproval } = await import("../src/lib/approvals.js");
  const { approvalTitle } = await import("../src/agents/risk/chargebacks.js");
  const { logEvent } = await import("../src/lib/eventlog.js");
  const d = { store: "hc", dispute_id: "gid://shopify/ShopifyPaymentsDispute/1", order_name: "#1098", type: "CHARGEBACK", reason: "PRODUCT_NOT_RECEIVED", amount: 65.95, currency: "USD", evidence_due_by: "2026-10-31", status: "NEEDS_RESPONSE" };
  const title = approvalTitle("hc", d);
  assert.match(title, /\$65\.95/);
  const ap = await createApproval(DB, { dept: "risk", requestedBy: "risk.chargebacks", store: "hc", title, options: [{ id: "will_submit", label: "I'll submit", detail: "x" }] });
  await DB.prepare(`INSERT INTO risk_disputes (store, dispute_id, order_name, status, type, reason, amount, currency, evidence_due_by, approval_id, first_seen_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(d.store, d.dispute_id, d.order_name, d.status, d.type, d.reason, d.amount, d.currency, d.evidence_due_by, ap, iso(nowMs), iso(nowMs)).run();
  // Same shape as pnl.js writePnlRow's restatement event.
  await logEvent(DB, { actor: "pnl.ledger", kind: "pnl.restated", store: "hc", summary: "Holt & Crane P&L for 2026-10-12 restated: profit $-61.29 → $-47.23",
    data: { day: "2026-10-12", changed: ["profit"], before: { profit: -61.29 }, after: { profit: -47.23 } }, at: iso(nowMs - 3600000) });
}

test("brief: a chargeback amount and a restatement's before/after/change are numbers in the data, so the brief can quote them and they verify", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-14T12:05:00Z"); // 08:05 EDT
  await liveCase(DB, nowMs);
  const data = await gatherBriefData({ DB }, { nowMs });
  const cb = data.waiting.approvals.find((a) => a.dispute);
  assert.equal(cb.dispute.amount, 65.95);
  assert.deepEqual(cb.amounts_in_title, [65.95]);
  assert.equal(cb.dispute.evidence_due_by, "2026-10-31");
  const rs = data.risk.find((r) => r.kind === "pnl.restated");
  assert.deepEqual(rs.changes, [{ field: "profit", before: -61.29, after: -47.23, change: 14.06 }]);

  const text = "## Waiting on you\n- Chargeback #1098 at Holt & Crane: $65.95, evidence due 2026-10-31 (Oct 31).\n" +
    "## Risk\n- Holt & Crane 2026-10-12 profit restated from -$61.29 to -$47.23 (up $14.06).";
  assert.deepEqual(unverifiedNumbers(text, data), []);
  // The verifier is not loosened: a number that isn't in the data is still flagged, and a
  // loss written as a gain still fails.
  assert.deepEqual(unverifiedNumbers("- #1098 chargeback $65.00; profit moved by $14.60", data), ["$65.00", "$14.60"]);
  assert.deepEqual(unverifiedNumbers("- H&C profit $61.29", data), ["$61.29"]);

  // End to end, including Reilly's "Rewrite now".
  const { rewriteBrief } = await import("../src/lib/brief.js");
  const { fetchImpl } = fakeApis({ text });
  const r = await runBrief(briefEnv(DB), { nowMs, fetchImpl });
  assert.deepEqual(r.unverified, []);
  assert.equal(r.checked, true);
  const rw = await rewriteBrief(briefEnv(DB), { nowMs: nowMs + 3600000, fetchImpl });
  assert.equal(rw.ok, true, JSON.stringify(rw));
  assert.equal(rw.checked, true);
  const row = await DB.prepare(`SELECT checked, unverified FROM briefs WHERE id = ?`).bind(r.id).first();
  assert.equal(row.checked, 1);
  assert.equal(row.unverified, "[]");
});

test("brief: the prompt forbids computing differences or splits; payout checks and per-store pending refunds come computed", async () => {
  const { SYSTEM_PROMPT, dollarsIn } = await import("../src/lib/brief.js");
  assert.match(SYSTEM_PROMPT, /Never work out a difference, total, average or per-store split yourself/);
  assert.deepEqual(dollarsIn("profit $-61.29 → $-47.23, fee -$1,200.50 and $3"), [-61.29, -47.23, -1200.5, 3]);
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-14T12:05:00Z");
  await allFresh(DB, nowMs);
  const { logEvent } = await import("../src/lib/eventlog.js");
  await logEvent(DB, { actor: "pnl.money_map", kind: "payout.mismatch", store: "aub", summary: "Auberlane: payout of 120.00 on 2026-10-13 doesn't match its 4 transactions (they add up to 118.50, off by 1.50)",
    data: { payoutId: "p1", payoutCents: 12000, sumCents: 11850, diffCents: 150 }, at: iso(nowMs - 3600000) });
  await refund(DB, "hc", { id: "r1", orderId: "o1", processed_at: iso(nowMs - 86400000), amount: 20, status: "PENDING" });
  await refund(DB, "mar", { id: "r2", orderId: "o2", processed_at: iso(nowMs - 86400000), amount: 30.5, status: "PENDING" });
  const data = await gatherBriefData({ DB }, { nowMs });
  assert.deepEqual(data.risk.find((r) => r.kind === "payout.mismatch").payout_check, { payout: 120, transactions_add_up_to: 118.5, off_by: 1.5 });
  assert.deepEqual(data.money.pending_refunds.by_store, [{ store: "Holt & Crane", count: 1, amount: 20 }, { store: "Marlowe Standard", count: 1, amount: 30.5 }]);
  assert.deepEqual(unverifiedNumbers("Auberlane payout $120.00 vs $118.50 (off by $1.50); PENDING refunds H&C $20.00, Marlowe $30.50", data), []);
});
