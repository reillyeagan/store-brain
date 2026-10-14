/**
 * The routine-audit gaps (2026-10-14): spend alarm, money/goods promises, Guy's end date,
 * Ads billing watch, compare-at on new products, personal-details scan, feed hygiene,
 * post-publish channel check. All shadow: report, flag, draft only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { minusDays } from "../src/lib/adsSpend.js";
import { SPEND_ALARM, spendAlarmConfig } from "../src/config/stores.js";
import { judgeSpend, runSpendAlarm, normallySpending } from "../src/agents/media/spendAlarm.js";
import { gatherBriefData } from "../src/lib/brief.js";

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

/* ---------------- 1. spend alarm ---------------- */

const CFG = spendAlarmConfig("hc");
const closedDays = (n, cost, from = "2026-10-13") => Array.from({ length: n }, (_, i) => ({ day: minusDays(from, i), cost }));

test("spend alarm: thresholds live in config, per-store overrides apply to that store only", () => {
  assert.equal(CFG.noOrdersMinSpend, SPEND_ALARM.noOrdersMinSpend);
  assert.equal(CFG.perStore, undefined);
});

test("spend alarm: spend with 0 orders alarms only from mid-afternoon store time, and only on a fresh orders feed", () => {
  const base = { cfg: CFG, spendToday: 45, ordersToday: 0, ordersFresh: true, acctHour: 14, closed: closedDays(14, 60), yesterday: "2026-10-13" };
  assert.deepEqual(judgeSpend({ ...base, storeHour: 11 }).alarms, []);
  assert.deepEqual(judgeSpend({ ...base, storeHour: 15 }).alarms.map((a) => a.key), ["no_orders"]);
  // A stale orders feed: 0 orders is not a claim, so no alarm (and it says why).
  const stale = judgeSpend({ ...base, storeHour: 16, ordersFresh: false });
  assert.deepEqual(stale.alarms, []);
  assert.match(stale.notes.join(" "), /orders feed not fresh/);
  // One order: no alarm.
  assert.deepEqual(judgeSpend({ ...base, storeHour: 16, ordersToday: 1 }).alarms, []);
});

test("spend alarm: over 2x a normal day with 0 orders alarms at any hour", () => {
  const r = judgeSpend({ cfg: CFG, spendToday: 130, ordersToday: 0, ordersFresh: true, storeHour: 10, acctHour: 10, closed: closedDays(14, 60), yesterday: "2026-10-13" });
  assert.deepEqual(r.alarms.map((a) => a.key), ["runaway"]);
  assert.equal(r.usual, 60);
});

test("spend alarm: a normally-spending account at $0 (yesterday, or today after 13:00) is 'stopped'; a quiet account is not", () => {
  const closed = [{ day: "2026-10-13", cost: 0 }, ...closedDays(10, 40, "2026-10-12")];
  const y = judgeSpend({ cfg: CFG, spendToday: 0, ordersToday: 2, ordersFresh: true, storeHour: 9, acctHour: 9, closed, yesterday: "2026-10-13" });
  assert.deepEqual(y.alarms.map((a) => a.key), ["stopped"]);
  assert.match(y.alarms[0].summary, /2026-10-13/);
  const t = judgeSpend({ cfg: CFG, spendToday: 0, ordersToday: 2, ordersFresh: true, storeHour: 14, acctHour: 14, closed: closedDays(10, 40), yesterday: "2026-10-13" });
  assert.deepEqual(t.alarms.map((a) => a.key), ["stopped"]);
  assert.deepEqual(judgeSpend({ cfg: CFG, spendToday: 0, ordersToday: 2, ordersFresh: true, storeHour: 11, acctHour: 11, closed: closedDays(10, 40), yesterday: "2026-10-13" }).alarms, []);
  // Never spent much: not "normally spending".
  assert.equal(normallySpending(closedDays(7, 3), CFG).normal, false);
  // A missing day is unknown, not $0: a short history never counts as normal.
  assert.equal(normallySpending(closedDays(4, 40), CFG).normal, false);
});

async function seedAlarmWorld(DB, { spendToday = 50, adsOkAt, ordersOkAt, orders = 0 } = {}) {
  const NOWISH = "2026-10-14T20:00:00Z";
  await DB.prepare(`INSERT INTO feeds (id, store, label, max_age_min, wired, last_ok_at, last_try_at) VALUES ('ads.spend.hc', 'hc', 'ads', 90, 1, ?, ?)`).bind(adsOkAt || NOWISH, adsOkAt || NOWISH).run();
  await DB.prepare(`INSERT INTO feeds (id, store, label, max_age_min, wired, last_ok_at, last_try_at) VALUES ('shopify.orders.hc', 'hc', 'orders', 30, 1, ?, ?)`).bind(ordersOkAt || NOWISH, ordersOkAt || NOWISH).run();
  const ins = (day, cost) => DB.prepare(`INSERT INTO ad_spend_days (store, day, cost, clicks, impressions, conv_value, currency, account_tz, fetched_at) VALUES ('hc', ?, ?, 10, 100, 0, 'USD', 'America/New_York', ?)`).bind(day, cost, NOWISH).run();
  await ins("2026-10-14", spendToday);
  for (let i = 1; i <= 14; i++) await ins(minusDays("2026-10-14", i), 60);
  for (let i = 0; i < orders; i++) {
    await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, updated_at) VALUES ('hc', ?, ?, '2026-10-14T15:00:00Z', '2026-10-14', 50, 'x')`).bind(`o${i}`, `#${2000 + i}`).run();
  }
}

test("spend alarm: one alarm per store per day through the event log, never a second the same day", async () => {
  const DB = makeD1();
  await seedAlarmWorld(DB);
  const NOW = Date.parse("2026-10-14T20:05:00Z"); // 16:05 Eastern
  const r1 = await runSpendAlarm({ DB }, { storeId: "hc", nowMs: NOW });
  assert.match(r1, /^ok: ALARM no_orders/);
  const r2 = await runSpendAlarm({ DB }, { storeId: "hc", nowMs: NOW + 20 * 60000 });
  assert.match(r2, /already raised today/);
  const e = await evs(DB, "media.spend_alarm");
  assert.equal(e.length, 1);
  assert.equal(e[0].store, "hc");
  const d = JSON.parse(e[0].data);
  assert.equal(d.spend_today, 50);
  assert.equal(d.orders_today, 0);
  assert.match(e[0].summary, /Watch only/);
  // The alarm reaches the morning brief's Risk list with its figures as numbers.
  const b = await gatherBriefData({ DB }, { nowMs: NOW + 30 * 60000 });
  const item = b.risk.find((x) => x.kind === "media.spend_alarm");
  assert.ok(item);
  assert.equal(item.spend_alarm.spend_today, 50);
});

test("spend alarm: a stale ads feed is never judged (says can't check, no alarm)", async () => {
  const DB = makeD1();
  await seedAlarmWorld(DB, { adsOkAt: "2026-10-14T10:00:00Z" });
  const r = await runSpendAlarm({ DB }, { storeId: "hc", nowMs: Date.parse("2026-10-14T20:05:00Z") });
  assert.match(r, /^can't check: Google Ads spend feed is stale/);
  assert.equal((await evs(DB, "media.spend_alarm")).length, 0);
  assert.equal((await evs(DB, "media.spend_alarm_skipped")).length, 1);
  const f = await DB.prepare(`SELECT key FROM media_findings WHERE agent = 'media.spend_alarm' AND cleared_at IS NULL`).all();
  assert.deepEqual(f.results.map((x) => x.key), ["cant_check"]);
});

test("spend alarm: a stale orders feed never produces a 0-orders alarm", async () => {
  const DB = makeD1();
  await seedAlarmWorld(DB, { ordersOkAt: "2026-10-14T12:00:00Z" });
  const r = await runSpendAlarm({ DB }, { storeId: "hc", nowMs: Date.parse("2026-10-14T20:05:00Z") });
  assert.match(r, /^ok: no alarm.*orders feed not fresh/);
  assert.equal((await evs(DB, "media.spend_alarm")).length, 0);
});
