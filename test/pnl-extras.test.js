import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { computeStoreDay } from "../src/lib/pnl.js";
import { matchBills, groupLines, billRate, cogsState } from "../src/agents/pnl/cogs.js";
import { pullFunnel, funnelFor, parseFunnelRows, FUNNEL_SHOPIFYQL } from "../src/agents/pnl/funnel.js";
import { explainChange, runAnalyst } from "../src/agents/pnl/analyst.js";
import { rollForward, federalEstimatedTaxDates, reminderBucket, runCalendar, mtdResult, refundRate, calendarState } from "../src/agents/pnl/calendar.js";
import { runPnlExtras, pnlExtrasState } from "../src/agents/pnl/index.js";
import { upsertOrder } from "../src/lib/shopifyWebhooks.js";
import { ensureFeeds, markFeedOk } from "../src/lib/freshness.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { STORES, LIVE_STORE_IDS } from "../src/config/stores.js";

const iso = (ms) => new Date(ms).toISOString();
const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;
const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });

async function order(DB, store, { id, name = `#${id}`, created_at, total }) {
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${store}-${id}`, name, created_at, currency: "USD",
    subtotal: total, discounts: 0, total, financial_status: "paid", payload_updated_at: created_at,
  }, JSON.stringify({ total_price: String(total) }), STORES[store].timezone, created_at);
}

/** Every P&L input fresh (same shape as pnl-brief.test.js). */
async function allFresh(DB, nowMs) {
  await ensureFeeds(DB);
  const at = iso(nowMs - 60000);
  for (const id of LIVE_STORE_IDS) {
    await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, '2026-01-01', ?)`).bind(id, at).run();
    await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, completed_at, last_full_read_at) VALUES (?, '2026-01-01', ?, ?, ?, ?)`).bind(id, at, at, at, at).run();
    for (const f of [`shopify.orders.${id}`, `ads.spend.${id}`, `shopify.payouts.${id}`]) await markFeedOk(DB, f, at);
    await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?)`).bind(`refunds.${id}`, at).run();
    await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, updated_at) VALUES (?, 'refunds', '2026-01-01', '2026-01-01', ?)`).bind(id, at).run();
    await DB.prepare(`INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, test, fetched_at) VALUES (?, ?, 'ADJUSTMENT', '2026-01-01T12:00:00Z', 0, 0, 0, 'USD', 0, ?)`).bind(id, `anchor-${id}`, at).run();
  }
}

async function bill(DB, { id, code, usd = null, total = null, lines }) {
  await DB.prepare(`INSERT INTO kfb_bills (bill_id, kfb_shop_code, total_eur, usd_charged, imported_at) VALUES (?, ?, ?, ?, '2026-10-12T00:00:00Z')`).bind(id, code, total, usd).run();
  let n = 0;
  for (const l of lines) {
    await DB.prepare(`INSERT INTO kfb_bill_lines (bill_id, line_no, kfb_shop_code, order_ref, kfb_order_id, parent_kfb_order_id, sku, quantity, cost_eur, fees_eur, shipping_eur)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).bind(id, ++n, l.code ?? null, l.ref, l.kfb ?? null, l.parent ?? null, l.sku ?? null, l.cost ?? 0, l.fees ?? 0, l.ship ?? 0).run();
  }
}

/* ---------------- COGS Matcher ---------------- */

test("cogs: no bills → 'waiting on KFB bills', nothing written", async () => {
  const DB = makeD1();
  const r = await matchBills(DB, { nowMs: Date.parse("2026-10-13T12:00:00Z") });
  assert.equal(r.status, "waiting on KFB bills");
  assert.equal((await cogsState(DB)).status, "waiting on KFB bills");
});

test("cogs: parent + ALL suborders (zero-price ones too) at the exact card rate; store by shop code, never the number alone", () => {
  const lines = [
    { bill_id: "B1", line_no: 1, code: "jmzjx1-it", ref: null, order_ref: "#1001", cost_eur: 20, fees_eur: 1, shipping_eur: 4, usd_charged: 60, total_eur: 50 },
    { bill_id: "B1", line_no: 2, code: "jmzjx1-it", order_ref: "1001", cost_eur: 0, fees_eur: 0, shipping_eur: 5 }, // suborder, price 0
    { bill_id: "B1", line_no: 3, code: "3as2ya-dw", order_ref: "1001", cost_eur: 20, usd_charged: 60, total_eur: 50 }, // same number, other store
    { bill_id: "B1", line_no: 4, code: "nope-00", order_ref: "1002", cost_eur: 9 },
  ];
  // usd_charged/total_eur come from the bill join on every line in real rows:
  for (const l of lines) { l.usd_charged = 60; l.total_eur = 50; }
  const { orders, unmatched } = groupLines(lines);
  const hc = orders.get("hc|1001");
  assert.equal(hc.cost_eur, 30);
  assert.equal(hc.cost_usd, 36); // 30 EUR × (60 / 50)
  assert.equal(orders.get("aub|1001").cost_eur, 20);
  assert.equal(unmatched.length, 1);
  assert.equal(billRate({ total_eur: null, usd_charged: 12 }, 10), 1.2);
  assert.equal(billRate({ total_eur: 10, usd_charged: null }, 10), null);
});

test("cogs: matched orders use the actual cost in the P&L (cogs_source mixed); a bill without the card amount stays an estimate", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-13T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "hc", { id: 1, created_at: "2026-10-12T15:00:00Z", total: 100 });
  await order(DB, "hc", { id: 2, created_at: "2026-10-12T16:00:00Z", total: 100 });
  await order(DB, "hc", { id: 3, created_at: "2026-10-12T17:00:00Z", total: 100 });
  await order(DB, "aub", { id: 1, created_at: "2026-10-12T15:00:00Z", total: 80 });
  await bill(DB, { id: "B1", code: "jmzjx1-it", usd: 24, lines: [{ ref: "1", cost: 15, ship: 3 }, { ref: "#1", cost: 0, ship: 2 }] });
  await bill(DB, { id: "B2", code: "jmzjx1-it", usd: null, lines: [{ ref: "2", cost: 25 }] });

  const before = await computeStoreDay(DB, "hc", "2026-10-12", { nowMs });
  assert.equal(before.cogs_source, "estimate");
  assert.equal(before.cogs, 99); // 3 × 100 × 33% assumed

  const r = await matchBills(DB, { nowMs });
  assert.equal(r.matched, 1);
  assert.equal(r.waiting_fx, 1);
  const m = await DB.prepare(`SELECT * FROM cogs_matches WHERE store = 'hc' AND order_id = 'gid://shopify/Order/hc-1'`).first();
  assert.equal(m.cost_eur, 20);
  assert.equal(m.cost_usd, 24);
  const row = await DB.prepare(`SELECT * FROM pnl_days WHERE store = 'hc' AND day = '2026-10-12'`).first();
  assert.equal(row.cogs_source, "mixed");
  assert.equal(row.cogs_actual, 24);
  assert.equal(row.cogs_est, 66);
  assert.equal(row.cogs, 90);
  // AUB order with the same number was never touched (different shop code).
  assert.equal(await DB.prepare(`SELECT * FROM cogs_matches WHERE store = 'aub'`).first(), null);
  // A second run changes nothing and logs nothing new.
  await matchBills(DB, { nowMs: nowMs + 60000 });
  assert.equal((await evs(DB, "cogs.matched")).length, 1);
  // The card amount arrives for B2 → order 2 becomes actual too.
  await DB.prepare(`UPDATE kfb_bills SET usd_charged = 30 WHERE bill_id = 'B2'`).run();
  await matchBills(DB, { nowMs: nowMs + 120000 });
  const row2 = await DB.prepare(`SELECT * FROM pnl_days WHERE store = 'hc' AND day = '2026-10-12'`).first();
  assert.equal(row2.cogs_actual, 54);
  assert.equal(row2.cogs_est, 33);
});

test("cogs: an actual cost under half the estimate is flagged (good news gets scrutiny)", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-13T15:00:00Z");
  await allFresh(DB, nowMs);
  await order(DB, "mar", { id: 7, created_at: "2026-10-12T15:00:00Z", total: 100 });
  await bill(DB, { id: "B9", code: "806080-g8", usd: 5, lines: [{ ref: "7", cost: 4 }] });
  await matchBills(DB, { nowMs });
  assert.equal((await evs(DB, "cogs.low_vs_estimate")).length, 1);
});

/* ---------------- Funnel ---------------- */

const SECRETS = { SB_HC_CLIENT_ID: "a", SB_HC_CLIENT_SECRET: "b", SB_AUB_CLIENT_ID: "c", SB_AUB_CLIENT_SECRET: "d", SB_MAR_CLIENT_ID: "e", SB_MAR_CLIENT_SECRET: "f" };

function fakeShopify(answer) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/admin/oauth/access_token")) return j({ access_token: "shpat_x", expires_in: 3600 });
    if (url.includes("/graphql.json")) {
      const body = JSON.parse(init.body);
      assert.match(body.query, /shopifyqlQuery/);
      assert.doesNotMatch(body.query, /mutation/);
      return answer(url, body);
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}

test("funnel: parses ShopifyQL rows into store-days", () => {
  assert.match(FUNNEL_SHOPIFYQL, /FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout/);
  const rows = parseFunnelRows({ rows: [{ day: "2026-10-12", sessions: "120", sessions_with_cart_additions: "9", sessions_that_reached_checkout: "5", sessions_that_completed_checkout: "2" }, { day: "bad" }] });
  assert.deepEqual(rows, [{ day: "2026-10-12", sessions: 120, cart_sessions: 9, checkout_sessions: 5, converted_sessions: 2 }]);
});

test("funnel: no credentials or read_reports not granted → not wired with the reason, no rows, never zero", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-13T15:00:00Z");
  const { fetchImpl, calls } = fakeShopify(() => j({ errors: [{ message: "Access denied for shopifyqlQuery field. Required access: `read_reports` access scope." }] }));
  const r = await pullFunnel({ DB }, { nowMs, fetchImpl });
  assert.ok(r.every((x) => x.state === "not_wired"));
  assert.equal(calls.length, 0);
  _resetTokenCacheForTests();
  const r2 = await pullFunnel({ DB, ...SECRETS }, { nowMs, fetchImpl });
  assert.ok(r2.every((x) => x.state === "not_wired" && /read_reports/.test(x.reason)));
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM funnel_days`).first()).n, 0);
  const f = await funnelFor(DB, "hc", "2026-10-10", "2026-10-12", { nowMs });
  assert.equal(f.wired, false);
  assert.ok(f.days.every((d) => d.sessions === null));
  assert.equal(f.totals.sessions, null);
  // State changes are logged once per store, not every hour.
  await pullFunnel({ DB, ...SECRETS }, { nowMs: nowMs + 3600000, fetchImpl });
  assert.equal((await evs(DB, "funnel.not_wired")).length, LIVE_STORE_IDS.length);
});

test("funnel: wired stores store each day; the group sums a day only when every store has it; stale data isn't used", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-13T15:00:00Z");
  const { fetchImpl } = fakeShopify((url) => {
    const isMar = url.includes("806080-g8");
    const rows = [{ day: "2026-10-12", sessions: 100, sessions_with_cart_additions: 10, sessions_that_reached_checkout: 5, sessions_that_completed_checkout: 2 }];
    if (!isMar) rows.unshift({ day: "2026-10-11", sessions: 50, sessions_with_cart_additions: 5, sessions_that_reached_checkout: 2, sessions_that_completed_checkout: 1 });
    return j({ data: { shopifyqlQuery: { parseErrors: [], tableData: { columns: [], rows } } } });
  });
  const r = await pullFunnel({ DB, ...SECRETS }, { nowMs, fetchImpl });
  assert.ok(r.every((x) => x.state === "wired"));
  const all = await funnelFor(DB, "all", "2026-10-11", "2026-10-12", { nowMs });
  const d11 = all.days.find((d) => d.day === "2026-10-11");
  const d12 = all.days.find((d) => d.day === "2026-10-12");
  assert.equal(d11.sessions, null);
  assert.deepEqual(d11.missing_stores, ["mar"]);
  assert.equal(d12.sessions, 300);
  assert.equal(d12.converted_sessions, 6);
  assert.equal(all.totals.sessions, null);
  const hc = await funnelFor(DB, "hc", "2026-10-11", "2026-10-12", { nowMs });
  assert.equal(hc.totals.sessions, 150);
  const stale = await funnelFor(DB, "hc", "2026-10-11", "2026-10-12", { nowMs: nowMs + 4 * 3600000 });
  assert.equal(stale.wired, false);
  assert.equal(stale.totals.sessions, null);
});

/* ---------------- Analyst ---------------- */

test("analyst: drivers computed in code; unknown sides give null; profit up gets caveats first", () => {
  const cur = { revenue: 500, refunds: 20, cogs: 160, ads: 150, guy_fee: 15, fees: 15, profit: 140, complete: false, cogs_estimated_share: 1, roas: 3.33, breakeven_roas: 2.4 };
  const prev = { revenue: 400, refunds: 10, cogs: 130, ads: 150, guy_fee: 15, fees: null, profit: null, complete: true };
  const x = explainChange(cur, prev);
  assert.equal(x.profit_change, null);
  assert.equal(x.drivers.find((d) => d.key === "fees").delta, null);
  assert.equal(x.top_driver.key, "revenue");
  assert.equal(x.top_driver.profit_effect, 100);
  assert.equal(x.drivers.find((d) => d.key === "cogs").profit_effect, -30);
  const up = explainChange({ ...cur }, { ...prev, fees: 12, profit: 83 });
  assert.equal(up.direction, "up");
  assert.match(up.scrutiny, /not complete/);
  assert.match(up.scrutiny, /100% estimated/);
  assert.equal(up.above_breakeven, true);
});

async function pnlRow(DB, store, day, v) {
  await DB.prepare(`INSERT INTO pnl_days (store, day, revenue, refunds, cogs, ads, guy_fee, fees, profit, profit_partial, cogs_est, complete, status, updated_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', '2026-10-13T00:00:00Z', '{}')`)
    .bind(store, day, v.revenue, v.refunds ?? 0, v.cogs ?? 0, v.ads ?? 0, v.guy_fee ?? 0, v.fees ?? 0, v.profit, v.profit_partial ?? v.profit, v.cogs ?? 0, v.complete ?? 1).run();
}

test("analyst: AI words are kept only when every number is a computed one; otherwise rejected; no key → code figures only", async () => {
  const nowMs = Date.parse("2026-10-13T07:00:00Z");
  for (const [text, keep] of [["Holt & Crane made $40.00 more, mostly revenue.", true], ["Holt & Crane made $999.00 more.", false]]) {
    const DB = makeD1();
    for (const id of LIVE_STORE_IDS) {
      await pnlRow(DB, id, "2026-10-11", { revenue: 100, profit: 10 });
      await pnlRow(DB, id, "2026-10-12", { revenue: 140, profit: 50 });
    }
    const fetchImpl = async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      const body = JSON.parse(init.body);
      assert.ok(body.max_tokens <= 400);
      return j({ model: body.model, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } });
    };
    const r = await runAnalyst({ DB, ANTHROPIC_API_KEY: "sk-test" }, { nowMs, fetchImpl });
    assert.equal(r.words, keep);
    const row = await DB.prepare(`SELECT * FROM pnl_analysis WHERE store = 'all' AND day = '2026-10-12'`).first();
    assert.equal(!!row.words, keep);
    if (!keep) assert.deepEqual(JSON.parse(row.words_rejected), ["$999.00"]);
    const hc = JSON.parse((await DB.prepare(`SELECT figures FROM pnl_analysis WHERE store = 'hc'`).first()).figures);
    assert.equal(hc.day_over_day.profit_change, 40);
  }
  const DB = makeD1();
  const r = await runAnalyst({ DB }, { nowMs, fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal(r.words, false);
  assert.match(r.skipped, /not wired/);
});

/* ---------------- Tax, Admin & Triggers ---------------- */

test("calendar: estimated-tax dates roll past weekends and MLK Day; reminders 7 d / 1 d / on the day, each once", async () => {
  assert.equal(rollForward("2028-01-15"), "2028-01-18"); // Sat → Mon is MLK Day → Tue
  assert.equal(rollForward("2027-01-15"), "2027-01-15");
  assert.deepEqual(federalEstimatedTaxDates(2026).map((d) => d.due), ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"]);
  assert.equal(reminderBucket("2026-10-24", "2026-10-31"), 7);
  assert.equal(reminderBucket("2026-10-26", "2026-10-31"), 7);
  assert.equal(reminderBucket("2026-10-30", "2026-10-31"), 1);
  assert.equal(reminderBucket("2026-10-31", "2026-10-31"), 0);
  assert.equal(reminderBucket("2026-10-20", "2026-10-31"), null);
  const DB = makeD1();
  const env = { DB };
  await runCalendar(env, { nowMs: Date.parse("2026-10-25T14:00:00Z") });
  await runCalendar(env, { nowMs: Date.parse("2026-10-25T18:00:00Z") });
  await runCalendar(env, { nowMs: Date.parse("2026-10-30T14:00:00Z") });
  const r = (await evs(DB, "calendar.reminder")).filter((e) => /1053/.test(e.summary));
  assert.equal(r.length, 2);
  const st = await calendarState(env, { nowMs: Date.parse("2026-10-25T14:00:00Z") });
  assert.ok(st.upcoming.some((u) => /1053/.test(u.label)));
  assert.match(st.disclaimer, /not tax advice/);
});

test("calendar: refund-rate and month-to-date loss triggers fire once a day; a loss is certain even with costs missing", async () => {
  assert.equal(refundRate([{ revenue: 100, refunds: 20 }, { revenue: 100, refunds: null }]), null);
  assert.deepEqual(mtdResult([{ revenue: 100, profit: null, profit_partial: -5 }], 1), { profit: null, upper_bound: -5 });
  assert.deepEqual(mtdResult([{ revenue: null, profit: null, profit_partial: -5 }], 1), { profit: null, upper_bound: null });
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-13T14:00:00Z");
  for (let d = 1; d <= 12; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    for (const id of LIVE_STORE_IDS) await pnlRow(DB, id, day, { revenue: 100, refunds: id === "hc" ? 20 : 1, profit: id === "aub" ? null : id === "hc" ? -5 : 10, profit_partial: id === "aub" ? -2 : undefined });
  }
  await runCalendar({ DB }, { nowMs });
  await runCalendar({ DB }, { nowMs: nowMs + 3600000 });
  const rate = await evs(DB, "trigger.refund_rate_high");
  assert.deepEqual(rate.map((e) => e.store), ["hc"]);
  const loss = await evs(DB, "trigger.mtd_loss");
  assert.deepEqual(loss.map((e) => e.store).sort(), ["aub", "hc"]);
  assert.match(loss.find((e) => e.store === "aub").summary, /at most/);
  assert.equal((await evs(DB, "trigger.balance_high")).length, 0); // off until Reilly sets a number
});

/* ---------------- entry points ---------------- */

test("runPnlExtras: throttled, never throws, nothing but Shopify reads and (once a day) Claude", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1();
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    if (url.endsWith("/admin/oauth/access_token")) return j({ access_token: "t", expires_in: 3600 });
    if (url.includes("/graphql.json")) {
      assert.doesNotMatch(JSON.parse(init.body).query, /mutation/);
      return j({ data: { shopifyqlQuery: { parseErrors: ["Column Not Found"], tableData: null } } });
    }
    throw new Error("unexpected " + url);
  };
  const nowMs = Date.parse("2026-10-13T07:00:00Z");
  const r = await runPnlExtras({ DB, ...SECRETS }, { nowMs, fetchImpl });
  assert.ok(r.funnel.every((x) => x.state === "error"));
  assert.equal(r.cogs.status, "waiting on KFB bills");
  const again = await runPnlExtras({ DB, ...SECRETS }, { nowMs: nowMs + 60000, fetchImpl });
  assert.equal(again.funnel, "not due");
  assert.ok(urls.every((u) => /myshopify\.com/.test(u)));
  const broken = await runPnlExtras({ DB: { prepare() { throw new Error("D1 down"); } } }, { nowMs, fetchImpl });
  assert.ok(broken.funnel.error);
  const st = await pnlExtrasState({ DB }, { nowMs });
  assert.equal(st.mode, "shadow");
  assert.equal(st.cogs.status, "waiting on KFB bills");
});
