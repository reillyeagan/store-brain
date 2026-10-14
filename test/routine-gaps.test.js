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
import { checkNewProduct, NO_COMPARE_AT_DAYS, channelCheck, runPrepublishStore } from "../src/agents/catalog/prepublish.js";
import { PRODUCTS_QUERY, rowFromNode } from "../src/agents/catalog/sync.js";
import { hygieneReport, runHygieneStore } from "../src/agents/catalog/hygiene.js";
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

/* ---------------- 5. no compare-at on new products ---------------- */

const newProd = (publishedAt, compareAt, price = 64.95) => ({
  product_id: "gid://shopify/Product/77", handle: "wool-coat", title: "Wool Coat", status: "ACTIVE", description_len: 40,
  image_count: 3, option_names: ["Size"], seo_title: "x", seo_description: "y", created_at: publishedAt, published_at: publishedAt,
  variants: [{ id: "v1", sku: "S1", title: "M", price, compareAt }],
});
const TIERS = { 0: 10, 10: 2, 20: 10, 30: 10, 40: 10 };

test("new-product check: a new product WITH a compare-at is flagged high (GMC Playbook: none for the first 30-60 days)", () => {
  const NOWP = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(NO_COMPARE_AT_DAYS, 30);
  const r = checkNewProduct("hc", newProd("2026-10-13T12:00:00Z", 89.95), { cost: { usd: 20 }, hasSizeChart: true, handles: new Set(), tierCounts: TIERS, nowMs: NOWP });
  const f = r.issues.find((i) => i.code === "compare_at_on_new_product");
  assert.ok(f, JSON.stringify(r.issues));
  assert.equal(f.severity, "high");
  assert.equal(r.passed, false);
  assert.equal(r.suggested_tier, null);
});

test("new-product check: never proposes a compare-at tier for a product younger than 30 days (or of unknown age); older ones keep the tier logic", () => {
  const NOWP = Date.parse("2026-10-14T12:00:00Z");
  const young = checkNewProduct("hc", newProd("2026-10-12T12:00:00Z", null), { cost: { usd: 20 }, hasSizeChart: true, handles: new Set(), tierCounts: TIERS, nowMs: NOWP });
  assert.equal(young.suggested_tier, null);
  assert.ok(!young.issues.some((i) => i.code === "tier_unassigned"));
  assert.equal(young.passed, true, JSON.stringify(young.issues));
  const unknown = checkNewProduct("hc", { ...newProd(null, null), created_at: null, published_at: null }, { cost: { usd: 20 }, hasSizeChart: true, handles: new Set(), tierCounts: TIERS, nowMs: NOWP });
  assert.equal(unknown.suggested_tier, null);
  const old = checkNewProduct("hc", newProd("2026-09-01T12:00:00Z", null), { cost: { usd: 20 }, hasSizeChart: true, handles: new Set(), tierCounts: TIERS, nowMs: NOWP });
  assert.equal(old.suggested_tier, 10);
  assert.ok(!old.issues.some((i) => i.code === "compare_at_on_new_product"));
});

/* ---------------- 7. monthly feed hygiene ---------------- */

const prod = (n, { published = "2026-06-01T00:00:00Z", compareAt = null, status = "ACTIVE", variants = 3 } = {}) => ({
  product_id: `gid://shopify/Product/${n}`, handle: `p-${n}`, title: `P ${n}`, status, published_at: published, created_at: published,
  variants_count: variants, variants: [{ id: `v${n}`, price: 64.95, compareAt }],
});

test("feed hygiene: zombies need 60 days live and no sales; best-sellers not on sale listed (too-new ones marked); SKUs vs spend per course 8.6", () => {
  const NOWH = Date.parse("2026-10-14T12:00:00Z");
  const products = [prod(1), prod(2), prod(3, { published: "2026-10-01T00:00:00Z" }), prod(4, { compareAt: 99.95 }), prod(5, { published: "2026-10-05T00:00:00Z" }), prod(6, { status: "DRAFT" })];
  const units = new Map([["gid://shopify/Product/2", 5], ["gid://shopify/Product/4", 9], ["gid://shopify/Product/5", 3]]);
  const r = hygieneReport({ products, units60: units, units90: units, units30: units, coverage60: { ok: true }, avgDailySpend: 50, nowMs: NOWH });
  // #1 old and unsold → zombie (also past the course's 90 days); #3 too new to judge; #6 draft.
  assert.deepEqual(r.zombies.map((z) => z.product_id), ["gid://shopify/Product/1"]);
  assert.equal(r.zombies[0].course_90d, true);
  // Best-sellers not on sale: #2 (ready) and #5 (too new: GMC Playbook 30 days); #4 is already on sale.
  assert.deepEqual(r.bestsellers_no_compare_at.map((b) => [b.product_id, b.too_new]), [["gid://shopify/Product/2", false], ["gid://shopify/Product/5", true]]);
  // 5 active × 3 variants = 15 SKUs vs $50/day → course benchmark ~5,000 SKUs: room to add.
  assert.equal(r.skus.skus, 15);
  assert.equal(r.skus.course_benchmark_skus, 5000);
  assert.match(r.skus.verdict, /room to add/);
  // Incomplete order history: no zombie claim at all (0 sales from missing data is not a claim).
  const r2 = hygieneReport({ products, units60: new Map(), units90: null, units30: new Map(), coverage60: { ok: false, why: "backfill not finished" }, avgDailySpend: null, spendWhy: "feed stale", nowMs: NOWH });
  assert.equal(r2.zombies, null);
  assert.match(r2.zombies_note, /backfill not finished/);
  assert.equal(r2.skus.verdict, null);
});

test("feed hygiene: a store run saves the state section and one monthly event; zombies wait for full order history", async () => {
  const DB = makeD1();
  const NOWH = Date.parse("2026-10-14T12:00:00Z");
  const r = await runHygieneStore({ DB }, "hc", [prod(1), prod(2)], { nowMs: NOWH, day: "2026-10-14" });
  assert.equal(r.zombies, null);
  assert.match(r.zombies_note, /order history not fully read/);
  await DB.prepare(`INSERT INTO order_coverage (store, covered_from, completed_at) VALUES ('hc', '2026-06-01', 'x')`).run();
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, updated_at) VALUES ('hc', 'o1', '#1', '2026-10-01T12:00:00Z', '2026-10-01', 64.95, 'x')`).run();
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, product_id, quantity, updated_at) VALUES ('hc', 'o1', 'l1', 'gid://shopify/Product/2', 2, 'x')`).run();
  const r2 = await runHygieneStore({ DB }, "hc", [prod(1), prod(2)], { nowMs: NOWH, day: "2026-10-14" });
  assert.equal(r2.zombies, 1);
  assert.equal(r2.bestsellers_no_compare_at, 1);
  assert.match(r2.skus.spend_note, /not wired/);
  const run = await DB.prepare(`SELECT * FROM cat_runs WHERE agent = 'cat.hygiene' AND store = 'hc'`).first();
  assert.equal(JSON.parse(run.summary).month, "2026-10");
  assert.equal((await evs(DB, "catalog.hygiene_report")).length, 2);
});

/* ---------------- 8. post-publish channel check ---------------- */

test("channel check: the reader records the Online Store channel from onlineStoreUrl; absent field = unknown, never 'not published'", () => {
  const node = (extra) => ({ id: "gid://shopify/Product/1", handle: "h", title: "T", status: "ACTIVE", variants: { nodes: [] }, ...extra });
  assert.match(PRODUCTS_QUERY, /onlineStoreUrl/);
  assert.equal(rowFromNode("hc", node({ onlineStoreUrl: "https://holtandcrane.com/products/h" }), "t").on_online_store, 1);
  assert.equal(rowFromNode("hc", node({ onlineStoreUrl: null }), "t").on_online_store, 0);
  assert.equal(rowFromNode("hc", node({}), "t").on_online_store, null);
});

test("channel check: active products not on the Online Store or in no collection are listed; drafts and unknowns are not flagged", () => {
  const p = (n, on, cols, status = "ACTIVE") => ({ product_id: `p${n}`, handle: `h${n}`, title: `T${n}`, status, on_online_store: on, collections_count: cols });
  const r = channelCheck([p(1, 1, 2), p(2, 0, 1), p(3, 1, 0), p(4, null, 1), p(5, 0, 0, "DRAFT")]);
  assert.equal(r.checked, 4);
  assert.equal(r.not_on_online_store, 1);
  assert.equal(r.no_collection, 1);
  assert.equal(r.online_store_unknown, 1);
  assert.deepEqual(r.products.map((x) => [x.product_id, x.issues]), [["p2", ["not published to the Online Store channel"]], ["p3", ["in no collection"]]]);
  assert.match(r.collection_published, /not wired/);
});

test("channel check: the New-Product Check run saves it for the page and says it in the daily digest", async () => {
  const DB = makeD1();
  const products = [
    { product_id: "p1", handle: "h1", title: "T1", status: "ACTIVE", on_online_store: 0, collections_count: 1, variants: [{ price: 64.95 }], option_names: [], published_at: "2026-06-01T00:00:00Z" },
  ];
  await runPrepublishStore({ DB }, "hc", products, { nowMs: Date.parse("2026-10-14T12:00:00Z"), day: "2026-10-14" });
  const run = await DB.prepare(`SELECT summary FROM cat_runs WHERE agent = 'cat.prepublish' AND store = 'hc'`).first();
  assert.equal(JSON.parse(run.summary).channel.not_on_online_store, 1);
  assert.match((await evs(DB, "catalog.new_product_digest"))[0].summary, /1 active not on the Online Store/);
});

test("billing: only the APPROVED budget in force today is judged (an expired, future or pending one is ignored)", () => {
  const NOWB = Date.parse("2026-10-14T12:00:00Z");
  const old = { accountBudget: { status: "APPROVED", approvedStartDateTime: "2026-08-01 00:00:00", approvedEndDateTime: "2026-09-30 23:59:59", approvedSpendingLimitMicros: "100000000", amountServedMicros: "100000000" } };
  const future = { accountBudget: { status: "APPROVED", approvedStartDateTime: "2026-11-01 00:00:00", approvedSpendingLimitMicros: "100000000", amountServedMicros: "0" } };
  const pending = { accountBudget: { status: "PENDING", approvedSpendingLimitMicros: "100000000", amountServedMicros: "99000000" } };
  const current = { accountBudget: { status: "APPROVED", approvedStartDateTime: "2026-10-01 00:00:00", approvedSpendingLimitMicros: "1000000000", amountServedMicros: "200000000" } };
  // The old, fully-spent budget used to be read first and raise a false "exhausted".
  const r = judgeBudget([old, future, pending, current], NOWB);
  assert.equal(r.status, "ok");
  assert.equal(r.data.used, 0.2);
  assert.equal(judgeBudget([old, future, pending], NOWB).status, "none");
  assert.match(Q_BUDGET, /approved_start_date_time/);
});
