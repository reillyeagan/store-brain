/**
 * The P&L page's data: the fees + refunds + media buyer total on every day, and the Payouts
 * block (next payout, recent paid ones, freshness-gated).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { recomputeDays, pnlHistory, feesRefundsGuy } from "../src/lib/pnl.js";
import { payoutsState, RECENT_PAID } from "../src/lib/payoutsState.js";
import { upsertOrder, upsertRefund } from "../src/lib/shopifyWebhooks.js";
import { ensureFeeds, markFeedOk, markFeedFailed } from "../src/lib/freshness.js";
import { STORES, LIVE_STORE_IDS } from "../src/config/stores.js";
import worker from "../src/index.js";

const NY = "America/New_York";
const iso = (ms) => new Date(ms).toISOString();

async function order(DB, store, { id, created_at, total }) {
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: total, discounts: 0, total, financial_status: "paid", payload_updated_at: created_at,
  }, JSON.stringify({ total_price: String(total) }), STORES[store].timezone, created_at);
}
async function refund(DB, store, { id, orderId, processed_at, amount, status = "SUCCESS" }) {
  await upsertRefund(DB, store, { refund_id: `gid://shopify/Refund/${id}`, order_id: `gid://shopify/Order/${orderId}`, processed_at, amount, status }, "{}", NY, processed_at);
}
async function ads(DB, store, day, cost) {
  await DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at)
    VALUES (?, ?, ?, 10, 100, 0, 'USD', ?, '2026-10-11T00:00:00Z') ON CONFLICT(store, day) DO UPDATE SET cost = excluded.cost`).bind(store, day, cost, NY).run();
}
async function charge(DB, store, { id, date, fee, type = "CHARGE" }) {
  await DB.prepare(`INSERT INTO balance_txns (store, txn_id, type, date, amount, fee, net, currency, test, fetched_at)
    VALUES (?, ?, ?, ?, 100, ?, ?, 'USD', 0, '2026-10-11T00:00:00Z') ON CONFLICT(store, txn_id) DO NOTHING`).bind(store, `gid://t/${id}`, type, date, fee, 100 - fee).run();
}
async function allFresh(DB, nowMs) {
  await ensureFeeds(DB);
  const at = iso(nowMs - 60000);
  for (const id of LIVE_STORE_IDS) {
    await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES (?, '2026-01-01', ?)`).bind(id, at).run();
    await DB.prepare(`INSERT INTO order_backfill (store, query_from, started_at, updated_at, completed_at, last_full_read_at) VALUES (?, '2026-01-01', ?, ?, ?, ?)`).bind(id, at, at, at, at).run();
    for (const f of [`shopify.orders.${id}`, `ads.spend.${id}`, `shopify.payouts.${id}`]) await markFeedOk(DB, f, at);
    await DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?, ?)`).bind(`refunds.${id}`, at).run();
    await DB.prepare(`INSERT INTO feed_coverage (store, feed, start_day, covered_from, updated_at) VALUES (?, 'refunds', '2026-01-01', '2026-01-01', ?)`).bind(id, at).run();
    await charge(DB, id, { id: `anchor-${id}`, date: "2026-01-01T12:00:00Z", fee: 0, type: "ADJUSTMENT" });
  }
}
async function payout(DB, store, { n, issued_at, status, net, currency = "USD" }) {
  await DB.prepare(`INSERT INTO payouts (store, payout_id, issued_at, status, net, currency, fetched_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-11T00:00:00Z')`)
    .bind(store, `gid://shopify/ShopifyPaymentsPayout/${store}${n}`, issued_at, status, net, currency).run();
}

/* ---------------- fees + refunds + media buyer ---------------- */

test("feesRefundsGuy: the three parts added; null when any part is unknown (never a partial sum)", () => {
  assert.equal(feesRefundsGuy({ fees: 3.1, refunds: 20, guy_fee: 10.07 }), 33.17);
  assert.equal(feesRefundsGuy({ fees: 3.1, refunds: 20, guy_fee: 0 }), 23.1, "no media buyer: a real zero adds nothing");
  assert.equal(feesRefundsGuy({ fees: null, refunds: 20, guy_fee: 1 }), null);
  assert.equal(feesRefundsGuy({ fees: 1, refunds: null, guy_fee: 1 }), null);
  assert.equal(feesRefundsGuy({ fees: 1, refunds: 1, guy_fee: null }), null, "ads unknown → Guy unknown → total unknown");
  assert.equal(feesRefundsGuy(null), null);
});

test("P&L history: every day carries fees+refunds+Guy, and revenue − ads − COGS − it equals profit", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-11T15:00:00Z");
  await allFresh(DB, nowMs);
  // Days after Guy's start (2026-09-07), so his 10% is charged.
  for (const id of LIVE_STORE_IDS) {
    await order(DB, id, { id: `${id}1`, created_at: "2026-10-09T16:00:00Z", total: 180 });
    await order(DB, id, { id: `${id}2`, created_at: "2026-10-10T16:00:00Z", total: 95.5 });
    await ads(DB, id, "2026-10-09", 100.7);
    await ads(DB, id, "2026-10-10", 41.33);
    await ads(DB, id, "2026-10-11", 12);
  }
  await charge(DB, "hc", { id: "c1", date: "2026-10-09T16:00:10Z", fee: 5.52 });
  await refund(DB, "hc", { id: 1, orderId: "hc1", processed_at: "2026-10-10T18:00:00Z", amount: 30 });
  await refund(DB, "hc", { id: 2, orderId: "hc1", processed_at: "2026-10-10T19:00:00Z", amount: 12.25, status: "PENDING" });
  await recomputeDays({ DB }, { nowMs, days: 3 });

  for (const store of ["hc", "all"]) {
    const h = await pnlHistory(DB, store, { nowMs });
    const checked = h.days.filter((d) => d.profit != null);
    assert.ok(checked.length >= 2, `${store}: some days have a known profit`);
    for (const d of h.days) {
      const parts = d.fees != null && d.refunds != null && d.guy_fee != null;
      assert.equal(d.fees_refunds_guy, parts ? Math.round((d.fees + d.refunds + d.guy_fee) * 100) / 100 : null, `${store} ${d.day}`);
      if (d.profit == null) continue;
      // Profit = revenue − ad spend − COGS − (fees + refunds + Guy), to the cent (rounding of parts).
      assert.ok(Math.abs(d.revenue - d.ads - d.cogs - d.fees_refunds_guy - d.profit) <= 0.011, `${store} ${d.day}: adds up`);
    }
  }
  const hc = await pnlHistory(DB, "hc", { nowMs });
  const oct9 = hc.days.find((d) => d.day === "2026-10-09");
  assert.equal(oct9.guy_fee, 10.07, "Guy's 10% of $100.70");
  assert.equal(oct9.fees_refunds_guy, 15.59, "fees 5.52 + refunds 0 + Guy 10.07");
  const oct10 = hc.days.find((d) => d.day === "2026-10-10");
  assert.equal(oct10.fees_refunds_guy, Math.round((0 + 42.25 + 4.13) * 100) / 100, "pending refunds count");
  assert.equal(oct10.per_store[0].fees_refunds_guy, oct10.fees_refunds_guy);

  // A day whose fees are unknown: the total is unknown, never fees-less.
  await DB.prepare(`UPDATE pnl_days SET fees = NULL WHERE store = 'hc' AND day = '2026-10-09'`).run();
  const again = await pnlHistory(DB, "hc", { nowMs });
  assert.equal(again.days.find((d) => d.day === "2026-10-09").fees_refunds_guy, null);
  assert.equal((await pnlHistory(DB, "all", { nowMs })).days.find((d) => d.day === "2026-10-09").fees_refunds_guy, null, "group too");
});

/* ---------------- payouts ---------------- */

test("payouts: next payout is the earliest SCHEDULED/IN_TRANSIT; paid ones newest first; dates in the store's days", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-15T15:00:00Z");
  await allFresh(DB, nowMs);
  await payout(DB, "hc", { n: 1, issued_at: "2026-10-17T04:00:00Z", status: "SCHEDULED", net: 120.4 });
  await payout(DB, "hc", { n: 2, issued_at: "2026-10-16T04:00:00Z", status: "IN_TRANSIT", net: 67.62 });
  for (let i = 0; i < 6; i++) await payout(DB, "hc", { n: 10 + i, issued_at: `2026-10-0${i + 1}T12:00:00Z`, status: "PAID", net: 67.62 });
  await payout(DB, "hc", { n: 30, issued_at: "2026-10-12T12:00:00Z", status: "FAILED", net: 9 });
  // 01:00Z on Oct 14 is still Oct 13 in New York: the payout date is the store's day.
  await payout(DB, "mar", { n: 1, issued_at: "2026-10-14T01:00:00Z", status: "SCHEDULED", net: 10 });

  const p = await payoutsState(DB, "all", { nowMs });
  assert.equal(p.ok, true);
  const hc = p.stores.find((s) => s.store === "hc");
  assert.equal(hc.current, true);
  assert.equal(hc.next.status, "IN_TRANSIT");
  assert.equal(hc.next.date, "2026-10-16");
  assert.equal(hc.next.net, 67.62);
  assert.deepEqual(hc.upcoming.map((x) => x.net), [67.62, 120.4]);
  assert.deepEqual(hc.upcoming_total, { USD: 188.02 });
  assert.equal(hc.paid.length, RECENT_PAID);
  assert.equal(hc.paid[0].date, "2026-10-06", "newest paid first");
  assert.equal(hc.paid.filter((x) => x.net === 67.62).length, RECENT_PAID, "identical amounts are separate payouts");
  assert.equal(hc.failed[0].status, "FAILED");
  assert.equal(p.stores.find((s) => s.store === "mar").next.date, "2026-10-13");
  assert.deepEqual(p.upcoming_total, { USD: 198.02 }, "group total across stores");

  const one = await payoutsState(DB, "hc", { nowMs });
  assert.deepEqual(one.stores.map((s) => s.store), ["hc"], "respects the store selector");
  assert.equal((await payoutsState(DB, "cc", { nowMs })).ok, false, "a store that isn't live has no payouts");
});

test("payouts: a stale or failing feed never shows an old SCHEDULED payout as current; not wired is null, not $0", async () => {
  const DB = makeD1();
  const nowMs = Date.parse("2026-10-15T15:00:00Z");
  await ensureFeeds(DB);
  await markFeedOk(DB, "shopify.payouts.hc", iso(nowMs - 7 * 3600000)); // limit is 6 h
  await markFeedOk(DB, "shopify.payouts.aub", iso(nowMs - 60000));
  await markFeedFailed(DB, "shopify.payouts.aub", "HTTP 503", iso(nowMs - 30000));
  await payout(DB, "hc", { n: 1, issued_at: "2026-10-16T04:00:00Z", status: "SCHEDULED", net: 50 });
  await payout(DB, "hc", { n: 2, issued_at: "2026-10-10T04:00:00Z", status: "PAID", net: 40 });

  const p = await payoutsState(DB, "all", { nowMs });
  const hc = p.stores.find((s) => s.store === "hc");
  assert.equal(hc.current, false);
  assert.equal(hc.feed.state, "stale");
  assert.equal(hc.next, null);
  assert.equal(hc.upcoming, null);
  assert.equal(hc.upcoming_total, null);
  assert.match(hc.why, /stale/);
  assert.equal(hc.paid.length, 1, "paid payouts are history and stay shown");
  const aub = p.stores.find((s) => s.store === "aub");
  assert.equal(aub.feed.state, "failing");
  assert.equal(aub.next, null);
  const mar = p.stores.find((s) => s.store === "mar");
  assert.equal(mar.wired, false);
  assert.equal(mar.upcoming_total, null, "not wired is not $0");
  assert.match(mar.why, /not wired/);
  assert.equal(p.all_current, false);
  assert.equal(p.upcoming_total, null, "no group total unless every store is current");
});

test("worker: /api/pnl carries the payouts block for the selected store", async () => {
  const DB = makeD1();
  const env = { DB, MC_KEY: "k".repeat(32) };
  const res = await worker.fetch(new Request("https://brain.example/api/pnl?store=hc", { headers: { "x-store-brain-key": "k".repeat(32) } }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.payouts.ok, true);
  assert.deepEqual(j.payouts.stores.map((s) => s.store), ["hc"]);
  assert.equal(j.payouts.stores[0].next, null);
});
