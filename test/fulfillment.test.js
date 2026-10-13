import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { runOrderWatch, RECHECK_MIN } from "../src/agents/fulfillment/orderWatch.js";
import { runFulfillment, fulfillmentState } from "../src/agents/fulfillment/index.js";
import { upsertOrder } from "../src/lib/shopifyWebhooks.js";
import { ensureFeeds, markFeedOk } from "../src/lib/freshness.js";
import { STORES } from "../src/config/stores.js";

const iso = (ms) => new Date(ms).toISOString();
const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;
const SWEEP = Date.parse("2026-10-13T12:00:00Z");

async function order(DB, store, { id, created_at, status = "paid", test = false }) {
  await upsertOrder(DB, STORES[store], {
    order_id: `gid://shopify/Order/${store}-${id}`, name: `#${id}`, created_at, currency: "USD",
    subtotal: 50, discounts: 0, total: 50, financial_status: status, payload_updated_at: created_at,
  }, JSON.stringify({ total_price: "50", test }), STORES[store].timezone, created_at);
}

async function kfb(DB, store, ref, importedMs = SWEEP) {
  await DB.prepare(`INSERT INTO kfb_orders (kfb_order_id, kfb_shop_code, order_ref, imported_at) VALUES (?, ?, ?, ?)`)
    .bind(`K-${store}-${ref}`, STORES[store].kfbShopCode, ref, iso(importedMs)).run();
}

async function sweep(DB, atMs = SWEEP) {
  await ensureFeeds(DB);
  await markFeedOk(DB, "kfb.morning_sweep", iso(atMs));
}

test("order watch: no KFB session yet → waiting, nothing flagged", async () => {
  const DB = makeD1();
  await order(DB, "hc", { id: 1, created_at: "2026-10-12T10:00:00Z" });
  const r = await runOrderWatch({ DB }, { nowMs: SWEEP + 60000 });
  assert.equal(r.status, "waiting");
  assert.match(r.reason, /waiting on KFB session/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM order_watch`).first()).n, 0);
  const st = await fulfillmentState({ DB }, { nowMs: SWEEP });
  assert.equal(st.order_watch.status, "waiting on KFB session");
  assert.equal(st.exceptions.status, "planned");
  assert.equal(st.parcel_tracking.on, false);
});

test("order watch: missing once → suspect (silent); still missing on the re-check → one flag; found later → cleared", async () => {
  const DB = makeD1();
  await sweep(DB);
  await order(DB, "hc", { id: 1, created_at: "2026-10-12T10:00:00Z" }); // 26 h before the sweep
  await order(DB, "hc", { id: 2, created_at: "2026-10-12T09:00:00Z" });
  await order(DB, "hc", { id: 3, created_at: "2026-10-13T08:00:00Z" }); // too recent for this sweep
  await order(DB, "hc", { id: 4, created_at: "2026-10-12T09:00:00Z", status: "voided" });
  await order(DB, "hc", { id: 5, created_at: "2026-10-12T09:00:00Z", test: true });
  await kfb(DB, "hc", "2");
  await kfb(DB, "aub", "1"); // the same number in another store doesn't count
  let r = await runOrderWatch({ DB }, { nowMs: SWEEP + 60000 });
  assert.equal(r.checked, 2);
  assert.equal(r.suspect, 1);
  assert.equal((await evs(DB, "ful.not_in_kfb")).length, 0);
  r = await runOrderWatch({ DB }, { nowMs: SWEEP + 60000 + (RECHECK_MIN - 5) * 60000 });
  assert.equal(r.flagged, 0);
  r = await runOrderWatch({ DB }, { nowMs: SWEEP + 60000 + (RECHECK_MIN + 1) * 60000 });
  assert.equal(r.flagged, 1);
  await runOrderWatch({ DB }, { nowMs: SWEEP + 3 * 3600000 });
  const flags = await evs(DB, "ful.not_in_kfb");
  assert.equal(flags.length, 1);
  assert.equal(flags[0].target, "sup.relay");
  assert.match(flags[0].summary, /#1/);
  await kfb(DB, "hc", "#1", SWEEP + 3 * 3600000);
  r = await runOrderWatch({ DB }, { nowMs: SWEEP + 4 * 3600000 });
  assert.equal(r.found, 1);
  assert.equal((await evs(DB, "ful.kfb_found")).length, 1);
});

test("order watch: a sweep that read nothing for a store, or a stale sweep, checks nothing (rule 6)", async () => {
  const DB = makeD1();
  await sweep(DB);
  await order(DB, "mar", { id: 9, created_at: "2026-10-12T09:00:00Z" });
  await kfb(DB, "hc", "100");
  let r = await runOrderWatch({ DB }, { nowMs: SWEEP + 60000 });
  assert.ok(r.skipped_stores.some((s) => s.store === "mar"));
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM order_watch`).first()).n, 0);
  r = await runOrderWatch({ DB }, { nowMs: SWEEP + 30 * 3600000 }); // sweep older than its 26 h limit
  assert.equal(r.status, "waiting");
});

test("runFulfillment: hourly, never throws, no network", async () => {
  const DB = makeD1();
  const fetchImpl = async () => { throw new Error("no network"); };
  const r = await runFulfillment({ DB }, { nowMs: SWEEP, fetchImpl });
  assert.equal(r.order_watch.status, "waiting");
  assert.equal((await runFulfillment({ DB }, { nowMs: SWEEP + 60000, fetchImpl })).order_watch, "not due");
  const broken = await runFulfillment({ DB: { prepare() { throw new Error("D1 down"); } } }, { nowMs: SWEEP, fetchImpl });
  assert.ok(broken.order_watch.error);
});
