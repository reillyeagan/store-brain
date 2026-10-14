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
import { runBilling, judgeBudget, judgeBilling, judgeAccount, isAccessGap, Q_ACCOUNT, Q_BILLING, Q_BUDGET } from "../src/agents/media/billing.js";

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

/* ---------------- 3. Guy's fee end date ---------------- */

test("guy fee: every store has an end date field, all null (only Reilly's words set one); the fee stops after an end date", async () => {
  const { STORES } = await import("../src/config/stores.js");
  const { guyFeeFor } = await import("../src/lib/pnl.js");
  for (const id of ["hc", "aub", "mar"]) assert.equal(STORES[id].guyEnd, null, id);
  assert.equal(guyFeeFor("aub", "2026-10-14", 100), 10); // still charged: no end date yet
  // With an end date (set only for this test, then put back): charged through that day, 0 after.
  STORES.aub.guyEnd = "2026-10-13";
  try {
    assert.equal(guyFeeFor("aub", "2026-10-13", 100), 10);
    assert.equal(guyFeeFor("aub", "2026-10-14", 100), 0);
    assert.equal(guyFeeFor("aub", "2026-10-14", null), null); // ads unknown stays unknown
    assert.equal(guyFeeFor("hc", "2026-10-14", 100), 10);     // other stores unaffected
  } finally {
    STORES.aub.guyEnd = null;
  }
});

test("guy fee: Auberlane's end-date question is asked once, verbatim, and never assumed", async () => {
  const DB = makeD1();
  const { askGuyEndDates } = await import("../src/agents/pnl/guyFee.js");
  assert.equal(await askGuyEndDates(DB, { nowMs: Date.parse("2026-10-14T12:00:00Z") }), 1);
  assert.equal(await askGuyEndDates(DB, { nowMs: Date.parse("2026-10-15T12:00:00Z") }), 0);
  const a = (await DB.prepare(`SELECT * FROM approvals`).all()).results;
  assert.equal(a.length, 1);
  assert.equal(a[0].title, "Auberlane's media buyer: did Guy stop after Oct 13? (your sheet says so). Reply to set the end date.");
  assert.equal(a[0].store, "aub");
  // Even after Reilly answers, it is not asked again (and nothing is parsed from his note).
  await DB.prepare(`UPDATE approvals SET status = 'approved', choice = 'reply', note = 'yes last day was the 13th'`).run();
  assert.equal(await askGuyEndDates(DB, { nowMs: Date.parse("2026-10-16T12:00:00Z") }), 0);
});

test("guy fee: the monthly check compares the ledger fee with 10% x spend and the sheet's SERVICES; no sheet = not wired, never $0", async () => {
  const DB = makeD1();
  const { monthlyGuyCheck, compareGuyFee } = await import("../src/agents/pnl/guyFee.js");
  for (let d = 1; d <= 30; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    const fee = day >= "2026-09-07" ? 5 : 0;
    for (const s of ["hc", "aub", "mar"]) {
      await DB.prepare(`INSERT INTO pnl_days (store, day, ads, guy_fee, status, updated_at) VALUES (?, ?, 50, ?, 'closed', 'x')`).bind(s, day, fee).run();
    }
  }
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, source, observed_at) VALUES ('hc', 'pnl', 'sheet:services:2026-09', '120.00', 'Reilly sheet', 'x')`).run();
  const NOWM = Date.parse("2026-10-14T12:00:00Z");
  const r = await monthlyGuyCheck(DB, { nowMs: NOWM });
  assert.deepEqual(r.map((x) => [x.store, x.status]), [["hc", "ok"], ["aub", "sheet not wired"], ["mar", "sheet not wired"]]);
  const e = await evs(DB, "pnl.guy_fee_check");
  assert.equal(e.length, 3);
  const hc = JSON.parse(e[0].data);
  assert.equal(hc.month, "2026-09");
  assert.equal(hc.ledger_fee, 120); // 24 days x $5
  assert.equal(hc.expected_fee, 120);
  assert.equal(hc.sheet_services, 120);
  assert.equal(JSON.parse(e[1].data).sheet_services, null);
  assert.match(e[1].summary, /not wired/);
  // Once a month per store.
  assert.deepEqual(await monthlyGuyCheck(DB, { nowMs: NOWM + 86400000 }), []);
  assert.equal(compareGuyFee({ ledgerFee: 120, expectedFee: 120, sheet: 150, daysMissing: 0 }).status, "mismatch");
});

/* ---------------- 4. Google Ads billing watch ---------------- */

/** A stand-in AdsSession: answers by query, or throws the Google error given for it. */
function fakeSession(answers) {
  const queries = [];
  return {
    queries,
    async query(store, q) {
      queries.push(q);
      assert.match(q, /^\s*SELECT\s/); // watch only
      const a = answers[q];
      if (a instanceof Error) throw a;
      return a || [];
    },
  };
}
const adsErr = (m) => Object.assign(new Error(m), { code: "ADS_HTTP" });

test("billing: judges account status, billing setup and account budget", () => {
  assert.equal(judgeAccount([{ customer: { status: "SUSPENDED" } }]).severity, "bad");
  assert.equal(judgeAccount([{ customer: { status: "ENABLED" } }]).status, "ok");
  const NOWB = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(judgeBilling([{ billingSetup: { status: "APPROVED", startDateTime: "2026-01-01 00:00:00" } }], NOWB).status, "ok");
  assert.equal(judgeBilling([{ billingSetup: { status: "APPROVED_HELD" } }], NOWB).severity, "bad");
  assert.equal(judgeBilling([], NOWB).status, "flag");
  const b = judgeBudget([{ accountBudget: { status: "APPROVED", approvedSpendingLimitMicros: "1000000000", amountServedMicros: "950000000" } }]);
  assert.equal(b.status, "flag");
  assert.equal(b.severity, "warn");
  assert.equal(b.data.left, 50);
  assert.equal(judgeBudget([]).status, "none"); // card-paid: no account budget is normal
  assert.equal(judgeBudget([{ accountBudget: { status: "APPROVED", approvedSpendingLimitType: "INFINITE" } }]).status, "ok");
});

test("billing: a suspended account and a nearly-used budget are flagged once each; failed payment is not wired (with why)", async () => {
  const DB = makeD1();
  const s = fakeSession({
    [Q_ACCOUNT]: [{ customer: { status: "SUSPENDED" } }],
    [Q_BILLING]: [{ billingSetup: { status: "APPROVED" } }],
    [Q_BUDGET]: [{ accountBudget: { status: "APPROVED", approvedSpendingLimitMicros: "500000000", amountServedMicros: "490000000" } }],
  });
  const r = await runBilling({ DB }, { storeId: "aub", session: s, nowMs: Date.parse("2026-10-14T12:00:00Z") });
  assert.match(r, /^ok: FLAG account\+budget; not wired: failed_payment/);
  await runBilling({ DB }, { storeId: "aub", session: s, nowMs: Date.parse("2026-10-15T12:00:00Z") });
  assert.equal((await evs(DB, "media.billing_flag")).length, 2); // not re-announced the next day
  const chk = await DB.prepare(`SELECT data FROM media_findings WHERE agent = 'media.billing' AND key = 'check'`).first();
  assert.match(JSON.parse(chk.data).parts.failed_payment.summary, /no failed-charge field/);
});

test("billing: a part Google refuses for access is 'not wired' with Google's reason, never 'fine' and never an error", async () => {
  const DB = makeD1();
  const s = fakeSession({
    [Q_ACCOUNT]: [{ customer: { status: "ENABLED" } }],
    [Q_BILLING]: adsErr("Google Ads HTTP 403: PERMISSION_DENIED: authorizationError=USER_PERMISSION_DENIED: User doesn't have permission"),
    [Q_BUDGET]: adsErr("Google Ads HTTP 400: INVALID_ARGUMENT: queryError=PROHIBITED_RESOURCE_TYPE_IN_FROM_CLAUSE"),
  });
  const r = await runBilling({ DB }, { storeId: "hc", session: s });
  assert.match(r, /not wired: billing, budget, failed_payment/);
  const chk = JSON.parse((await DB.prepare(`SELECT data FROM media_findings WHERE agent = 'media.billing' AND key = 'check'`).first()).data);
  assert.equal(chk.parts.billing.status, "not_wired");
  assert.match(chk.parts.billing.summary, /USER_PERMISSION_DENIED/);
  // Any other failure is a real error (thrown: the media runner logs and retries it).
  const bad = fakeSession({ [Q_ACCOUNT]: adsErr("Google Ads HTTP 500: INTERNAL") });
  await assert.rejects(() => runBilling({ DB }, { storeId: "hc", session: bad }), /INTERNAL/);
  assert.equal(isAccessGap("Google Ads HTTP 500: INTERNAL"), false);
});

test("billing: Google saying CUSTOMER_NOT_ENABLED is news about the account (red flag), not a wiring gap", async () => {
  const DB = makeD1();
  const s = fakeSession({ [Q_ACCOUNT]: adsErr("Google Ads HTTP 403: PERMISSION_DENIED: authorizationError=CUSTOMER_NOT_ENABLED: The customer account can't be accessed") });
  const r = await runBilling({ DB }, { storeId: "mar", session: s });
  assert.match(r, /FLAG account/);
  assert.equal(s.queries.length, 1);
});
