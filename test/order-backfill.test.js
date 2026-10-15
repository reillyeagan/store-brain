import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import {
  runOrderBackfill, backfillFromDay, requestedCost, orderCoverage, coveredDays,
  BACKFILL_PAGE_SIZE, BACKFILL_PAGES_PER_RUN, SHOPIFY_MAX_QUERY_COST, BACKFILL_QUERY,
} from "../src/lib/orderBackfill.js";
import { ORDER_FIELDS, orderFromNode } from "../src/lib/reconcile.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { computeStoreDay } from "../src/lib/pnl.js";
import { startOfLocalDayMs, endOfLocalDayMs } from "../src/lib/time.js";

const HC_DOMAIN = "jmzjx1-it.myshopify.com";
const ENV_SECRETS = { SB_HC_CLIENT_ID: "hc-id", SB_HC_CLIENT_SECRET: "hc-secret" }; // only H&C wired

/** n GraphQL order nodes, one an hour from `fromIso`, oldest first. */
function makeOrders(n, fromIso) {
  const t0 = Date.parse(fromIso);
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(t0 + i * 3600000).toISOString();
    return {
      id: `gid://shopify/Order/${9000 + i}`, name: `#${9000 + i}`, createdAt: at, updatedAt: at,
      test: i === 0, currencyCode: "USD", displayFinancialStatus: "PAID",
      currentSubtotalPriceSet: { shopMoney: { amount: "40.0" } },
      currentTotalDiscountsSet: { shopMoney: { amount: "0.0" } },
      currentTotalPriceSet: { shopMoney: { amount: "40.0" } },
      totalPriceSet: { shopMoney: { amount: "50.0" } },
      shippingLine: { title: "Standard", code: "STD" },
    };
  });
}

/** Fake Shopify: token mint + cursor-paged orders. `failOnCall` throws a 502 on that GraphQL call. */
function fakeShopify(all, { failOnCall = null } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    assert.ok(url.startsWith(`https://${HC_DOMAIN}/admin/api/`), "only the H&C store, with its own credentials");
    const body = JSON.parse(init.body);
    calls.push(body);
    n++;
    if (failOnCall === n) return new Response("bad gateway", { status: 502 });
    const { first, after } = body.variables;
    const start = after ? Number(after.slice(2)) : 0;
    const nodes = all.slice(start, start + first);
    const end = start + nodes.length;
    return new Response(JSON.stringify({ data: { orders: { pageInfo: { hasNextPage: end < all.length, endCursor: `c:${end}` }, nodes } } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test("backfill: query cost per page stays under Shopify's 1,000 and pages hold at most 50", () => {
  assert.ok(BACKFILL_PAGE_SIZE <= 50);
  assert.equal(requestedCost(BACKFILL_PAGE_SIZE), 702);
  assert.ok(requestedCost(BACKFILL_PAGE_SIZE) < SHOPIFY_MAX_QUERY_COST);
  assert.match(BACKFILL_QUERY, /totalPriceSet/);
  assert.match(ORDER_FIELDS, /\btest\b/);
  assert.equal(backfillFromDay(Date.parse("2026-10-11T15:00:00Z"), "America/New_York"), "2026-09-01");
  assert.equal(backfillFromDay(Date.parse("2026-01-05T15:00:00Z"), "America/New_York"), "2025-12-01");
  // Store-day boundaries, including DST.
  assert.equal(new Date(startOfLocalDayMs("2026-09-01", "America/New_York")).toISOString(), "2026-09-01T04:00:00.000Z");
  assert.equal(new Date(endOfLocalDayMs("2026-11-01", "America/New_York")).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.deepEqual(coveredDays("2026-10-05", "2026-10-01", "2026-10-10"), { covered: 6, total: 10 });
  assert.deepEqual(coveredDays(null, "2026-10-01", "2026-10-10"), { covered: 0, total: 10 });
  assert.deepEqual(coveredDays("2026-09-01", "2026-10-01", "2026-10-10"), { covered: 10, total: 10 });
});

test("reconcile maps test and the original total (totalPriceSet)", () => {
  const o = orderFromNode(makeOrders(1, "2026-10-01T12:00:00Z")[0]);
  assert.equal(o.test, true);
  assert.equal(o.original_total, 50);
  assert.equal(o.total, 40);
});

test("backfill: pages from the 1st of last month with a cursor, resumes after a failure, records coverage, one summary event", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1();
  const env = { DB, ...ENV_SECRETS };
  const nowMs = Date.parse("2026-10-11T15:00:00Z");
  const all = makeOrders(360, "2026-09-01T04:30:00Z"); // 360 orders → 8 pages of 50
  const { fetchImpl, calls } = fakeShopify(all, { failOnCall: 3 });

  // Run 1: two pages stored, the third call fails.
  const r1 = await runOrderBackfill(env, { nowMs, opts: { fetchImpl } });
  assert.match(r1.find((r) => r.store === "hc").error, /HTTP 502/);
  assert.equal(r1.find((r) => r.store === "aub").skipped, "not wired");
  assert.equal(calls[0].variables.query, "created_at:>='2026-09-01T04:00:00.000Z'", "first day of the previous month, store time");
  assert.equal(calls[0].variables.first, 50);
  assert.equal(calls[0].variables.after, null);
  let st = await DB.prepare(`SELECT * FROM order_backfill WHERE store = 'hc'`).first();
  assert.equal(st.cursor, "c:100");
  assert.equal(st.completed_at, null);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = 'hc'`).first()).n, 100);
  assert.equal((await orderCoverage(DB, "hc")).covered_from, null);

  // Throttled: a second run in the same 15 minutes does nothing.
  const again = await runOrderBackfill(env, { nowMs: nowMs + 60000, opts: { fetchImpl } });
  assert.equal(again.find((r) => r.store === "hc").reason, "not due");

  // Run 2 (15 min later): resumes from c:100, reads up to 4 pages.
  const r2 = await runOrderBackfill(env, { nowMs: nowMs + 15 * 60000, opts: { fetchImpl } });
  assert.equal(r2.find((r) => r.store === "hc").done, false);
  assert.equal(calls[3].variables.after, "c:100");
  // Run 3: the last page; coverage recorded.
  const r3 = await runOrderBackfill(env, { nowMs: nowMs + 30 * 60000, opts: { fetchImpl } });
  assert.equal(r3.find((r) => r.store === "hc").done, true);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE store = 'hc'`).first()).n, 360);
  const cov = await orderCoverage(DB, "hc");
  assert.equal(cov.covered_from, "2026-09-01");
  assert.ok(cov.last_full_read_at);
  st = await DB.prepare(`SELECT * FROM order_backfill WHERE store = 'hc'`).first();
  assert.equal(st.orders, 360);
  assert.equal(st.added, 360);

  // Quiet: no per-order events, exactly one summary for the store.
  const evs = (await DB.prepare(`SELECT kind, store, summary FROM events WHERE store = 'hc'`).all()).results;
  assert.deepEqual(evs.map((e) => e.kind), ["error.orders_backfill", "orders.history_backfilled"]);
  assert.match(evs[1].summary, /order history complete from 2026-09-01 \(360 orders read, 360 were missing/);

  // Stored through upsertOrder with the GraphQL payload: P&L excludes the test order and uses totalPriceSet.
  const firstDay = await DB.prepare(`SELECT local_day FROM orders WHERE order_id = 'gid://shopify/Order/9000'`).first();
  assert.equal(firstDay.local_day, "2026-09-01");
  const row = await computeStoreDay(DB, "hc", "2026-09-01", { nowMs: nowMs + 30 * 60000, feeds: [] });
  assert.equal(row.notes.excluded_test, 1);

  // Next: hourly incremental re-reads of updated orders, not another first pass.
  const r4 = await runOrderBackfill(env, { nowMs: nowMs + 90 * 60000, opts: { fetchImpl } });
  assert.equal(r4.find((r) => r.store === "hc").phase, "incremental");
  assert.match(calls[calls.length - 1].variables.query, /^updated_at:>='/);
});
