import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { pullAdsSpend, parseSpendRows, cleanCustomerId, adsApiVersion, scrubSecrets } from "../src/lib/adsSpend.js";
import { pullPayouts, checkPayout } from "../src/lib/payouts.js";
import { pullRefunds, refundFromNode } from "../src/lib/refunds.js";
import { parseRefund } from "../src/lib/shopifyWebhooks.js";
import { claimJob, retrySoon } from "../src/lib/jobRuns.js";
import { runMoneyJobs } from "../src/lib/moneyJobs.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { ensureFeeds, evaluateFeeds } from "../src/lib/freshness.js";
import worker from "../src/index.js";

/* ---------------- fixtures ---------------- */

const SHOP_SECRETS = {
  SB_HC_CLIENT_ID: "hc-id", SB_HC_CLIENT_SECRET: "hc-secret",
  SB_AUB_CLIENT_ID: "aub-id", SB_AUB_CLIENT_SECRET: "aub-secret",
  SB_MAR_CLIENT_ID: "mar-id", SB_MAR_CLIENT_SECRET: "mar-secret",
};
const DOMAIN = { "jmzjx1-it.myshopify.com": "hc", "3as2ya-dw.myshopify.com": "aub", "806080-g8.myshopify.com": "mar" };
const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });

const GENV = (DB, extra = {}) => ({
  DB, GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-secret",
  APPROVAL_SIGNING_KEY: "k".repeat(48), ...extra,
});

async function connectGoogle(env) {
  const { enc_token, iv } = await encryptToken(env, "1//refresh-xyz");
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at) VALUES ('google', 'reillyworking26@gmail.com', 'adwords', ?, ?, '2026-10-01T00:00:00Z')`
  ).bind(enc_token, iv).run();
}

/** Fake Google: token refresh + Ads searchStream. `rowsFor(cid)` returns daily rows. */
function fakeAds({ tz = "America/Los_Angeles", currency = "USD", rowsFor = () => [], adsResponse = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return j({ access_token: "ya29.SECRET-ACCESS", expires_in: 3600 });
    const m = url.match(/^https:\/\/googleads\.googleapis\.com\/(v\d+)\/customers\/(\d+)\/googleAds:searchStream$/);
    if (m) {
      if (adsResponse) return adsResponse(url, init);
      const q = JSON.parse(init.body).query;
      if (/FROM customer$/.test(q.trim()) && /time_zone/.test(q)) {
        return j([{ results: [{ customer: { id: m[2], timeZone: tz, currencyCode: currency } }] }]);
      }
      return j([{ results: rowsFor(m[2], q) }]);
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}
const dayRow = (date, costMicros, clicks = 10, impressions = 100, conv = 0) =>
  ({ segments: { date }, metrics: { costMicros: String(costMicros), clicks: String(clicks), impressions: String(impressions), conversionsValue: conv } });

/** Fake Shopify: token mint + GraphQL routed by store and operation name. */
function fakeShopify(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const host = new URL(url).host;
    if (url.endsWith("/admin/oauth/access_token")) return j({ access_token: "shpat-SECRET", expires_in: 86399 });
    const body = JSON.parse(init.body);
    const op = (body.query.match(/query\s+(\w+)/) || [])[1] || "anon";
    calls.push({ store: DOMAIN[host], op, variables: body.variables });
    const r = handler(DOMAIN[host], op, body.variables || {});
    if (r && r.errors) return j(r);
    return j({ data: r });
  };
  return { fetchImpl, calls };
}

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;
const feed = async (DB, id) => (await evaluateFeeds(DB)).find((f) => f.id === id);

/* ---------------- Google Ads spend ---------------- */

test("ads: helpers — dashes stripped, version normalised, zero-filled days, micros → money", () => {
  assert.equal(cleanCustomerId("710-814-3649"), "7108143649");
  assert.equal(adsApiVersion({}), "v25");
  assert.equal(adsApiVersion({ GOOGLE_ADS_API_VERSION: "26" }), "v26");
  assert.throws(() => adsApiVersion({ GOOGLE_ADS_API_VERSION: "latest" }), /not a version/);
  const days = parseSpendRows([dayRow("2026-10-09", 12345678), dayRow("2026-10-09", 1000000), dayRow("2026-09-01", 5)], { from: "2026-10-08", to: "2026-10-10" });
  assert.deepEqual(days.map((d) => [d.day, d.cost, d.clicks]), [["2026-10-08", 0, 0], ["2026-10-09", 13.35, 20], ["2026-10-10", 0, 0]]);
});

test("ads: pulls 8 days in the ACCOUNT's timezone, stores tz + currency, marks the feed ok, no dev token / login-customer-id", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB); await connectGoogle(env);
  // 02:00 UTC on Oct 11 is still Oct 10 in Los Angeles: "today" must be Oct 10.
  const nowMs = Date.parse("2026-10-11T02:00:00Z");
  const g = fakeAds({ rowsFor: () => [dayRow("2026-10-09", 50000000, 40, 900, 120.5), dayRow("2026-10-10", 7250000)] });
  const r = await pullAdsSpend(env, { fetchImpl: g.fetchImpl, nowMs });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  const adsCalls = g.calls.filter((c) => c.url.includes("googleads"));
  assert.ok(adsCalls.some((c) => c.url.includes("/v25/customers/7108143649/googleAds:searchStream")));
  const spendQ = adsCalls.map((c) => JSON.parse(c.init.body).query).find((q) => /BETWEEN/.test(q));
  assert.match(spendQ, /BETWEEN '2026-10-03' AND '2026-10-10'/);
  for (const c of adsCalls) {
    assert.equal(c.init.headers["developer-token"], undefined, "developer tokens were retired; not sent by default");
    assert.equal(c.init.headers["login-customer-id"], undefined, "direct account access, no manager");
  }
  const rows = (await DB.prepare(`SELECT * FROM ad_spend_days WHERE store = 'hc' ORDER BY day`).all()).results;
  assert.equal(rows.length, 8);
  const d9 = rows.find((x) => x.day === "2026-10-09");
  assert.equal(d9.cost, 50); assert.equal(d9.clicks, 40); assert.equal(d9.impressions, 900); assert.equal(d9.conv_value, 120.5);
  assert.equal(d9.account_tz, "America/Los_Angeles"); assert.equal(d9.currency, "USD");
  const f = (await evaluateFeeds(DB, nowMs)).find((x) => x.id === "ads.spend.hc");
  assert.equal(f.current, "fresh");
  assert.equal(f.last_ok_at, "2026-10-11T02:00:00.000Z");
  assert.equal((await evs(DB, "ads.imported")).length, 3, "one import line per store");
});

test("ads: a re-pull restates past days in place (no duplicates) and logs the change; today moving is quiet", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB); await connectGoogle(env);
  const nowMs = Date.parse("2026-10-11T18:00:00Z");
  let v = { "2026-10-09": 50000000, "2026-10-11": 1000000 };
  const g = fakeAds({ tz: "America/New_York", rowsFor: () => Object.entries(v).map(([d, c]) => dayRow(d, c)) });
  await pullAdsSpend(env, { fetchImpl: g.fetchImpl, nowMs });
  v = { "2026-10-09": 48500000, "2026-10-11": 9000000 };
  await pullAdsSpend(env, { fetchImpl: g.fetchImpl, nowMs: nowMs + 3600000 });
  const n = (await DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_days WHERE store = 'hc'`).first()).n;
  assert.equal(n, 8, "same 8 days, restated, not appended");
  assert.equal((await DB.prepare(`SELECT cost FROM ad_spend_days WHERE store='hc' AND day='2026-10-09'`).first()).cost, 48.5);
  const rest = (await evs(DB, "ads.restated")).filter((e) => e.store === "hc");
  assert.equal(rest.length, 1);
  assert.match(rest[0].summary, /2026-10-09 50\.00 → 48\.50/);
  assert.ok(!/2026-10-11/.test(rest[0].summary), "today's growth is not a restatement");
});

test("ads: developer token is sent only when GOOGLE_ADS_DEVELOPER_TOKEN is set", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB, { GOOGLE_ADS_DEVELOPER_TOKEN: "devtok-123456" }); await connectGoogle(env);
  const g = fakeAds();
  await pullAdsSpend(env, { fetchImpl: g.fetchImpl, nowMs: Date.parse("2026-10-11T18:00:00Z") });
  assert.ok(g.calls.filter((c) => c.url.includes("googleads")).every((c) => c.init.headers["developer-token"] === "devtok-123456"));
});

test("ads: Google not connected → quiet: no calls, no events, feeds stay not wired", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB);
  await ensureFeeds(DB);
  const g = fakeAds();
  const r = await pullAdsSpend(env, { fetchImpl: g.fetchImpl });
  assert.ok(r.every((x) => x.skipped));
  assert.equal(g.calls.length, 0);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM events`).first()).n, 0);
  assert.equal((await feed(DB, "ads.spend.hc")).current, "not_wired");
});

test("ads: an API error marks the feed failed with a message that never contains a token", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB, { GOOGLE_ADS_DEVELOPER_TOKEN: "devtok-123456" }); await connectGoogle(env);
  await ensureFeeds(DB);
  const g = fakeAds({
    adsResponse: (url, init) => j({ error: { code: 403, status: "PERMISSION_DENIED",
      message: `caller ${init.headers.authorization} devtok-123456 lacks access`,
      details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: `token ya29.SECRET-ACCESS denied` }] }] } }, 403),
  });
  const r = await pullAdsSpend(env, { fetchImpl: g.fetchImpl });
  assert.ok(r.every((x) => !x.ok));
  const f = await feed(DB, "ads.spend.hc");
  assert.equal(f.current, "failing");
  assert.match(f.last_error, /USER_PERMISSION_DENIED/);
  const all = JSON.stringify(r) + JSON.stringify((await DB.prepare(`SELECT * FROM feeds`).all()).results) + JSON.stringify((await DB.prepare(`SELECT * FROM events`).all()).results);
  assert.ok(!/ya29\.SECRET|devtok-123456|refresh-xyz|GOCSPX/.test(all), all);
  assert.equal(scrubSecrets("Bearer abc.def"), "Bearer [redacted]");
});

test("ads: an unsupported API version says so plainly", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB, { GOOGLE_ADS_API_VERSION: "v19" }); await connectGoogle(env);
  await ensureFeeds(DB);
  const g = fakeAds({ adsResponse: () => new Response("<html>404. That's an error.</html>", { status: 404 }) });
  const r = await pullAdsSpend(env, { fetchImpl: g.fetchImpl });
  assert.equal(r[0].code, "UNSUPPORTED_VERSION");
  assert.match((await feed(DB, "ads.spend.hc")).last_error, /version v19 is not supported.*GOOGLE_ADS_API_VERSION/);
});

/* ---------------- Shopify Payments ---------------- */

const payout = (id, net, status = "PAID", issued = "2026-10-08T12:00:00Z") =>
  ({ id: `gid://shopify/ShopifyPaymentsPayout/${id}`, legacyResourceId: String(id), issuedAt: issued, status, net: { amount: String(net), currencyCode: "USD" } });
const txn = (id, payoutId, net, type = "CHARGE", fee = 0) => ({
  id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${id}`, type, test: false, transactionDate: "2026-10-07T10:00:00Z",
  amount: { amount: String(net + fee), currencyCode: "USD" }, fee: { amount: String(fee) }, net: { amount: String(net) },
  associatedPayout: { id: payoutId ? `gid://shopify/ShopifyPaymentsPayout/${payoutId}` : null, status: "PAID" },
  associatedOrder: { id: `gid://shopify/Order/${id}` }, sourceOrderTransactionId: null,
});
const conn = (nodes) => ({ shopifyPaymentsAccount: { balanceTransactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });

function paymentsHandler({ payouts, txnsByPayout, recent = [], balance = "250.10", ignoreFilter = false, perStore = {} }) {
  return (store, op, vars) => {
    if (perStore[store]) return perStore[store](op, vars);
    if (op === "PaymentsSummary") {
      return { shopifyPaymentsAccount: { id: "acct", balance: [{ amount: balance, currencyCode: "USD" }], payouts: { nodes: payouts } } };
    }
    if (op === "BalanceTxns") {
      const m = vars.query && vars.query.match(/payments_transfer_id:(\d+)/);
      if (!m || ignoreFilter) return conn(recent);
      return conn(txnsByPayout[m[1]] || []);
    }
    throw new Error("unexpected op " + op);
  };
}

test("payouts: identical amounts are two payouts (dedupe by id, never by amount); re-runs don't duplicate", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1(); const env = { DB, ...SHOP_SECRETS };
  const s = fakeShopify(paymentsHandler({
    payouts: [payout(1, 67.62), payout(2, 67.62, "PAID", "2026-10-09T12:00:00Z"), payout(3, 12.5, "SCHEDULED")],
    txnsByPayout: { 1: [txn(11, 1, 70.00, "CHARGE", 2.38), txn(12, 1, -2.38, "ADJUSTMENT"), txn(13, 1, -67.62, "TRANSFER")], 2: [txn(21, 2, 67.62)] },
    recent: [txn(31, null, 12.5), txn(31, null, 12.5)],
  }));
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  const rows = (await DB.prepare(`SELECT * FROM payouts WHERE store = 'hc' ORDER BY payout_id`).all()).results;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.net), [67.62, 67.62, 12.5]);
  assert.equal(rows[2].status, "SCHEDULED");
  assert.deepEqual(rows.slice(0, 2).map((r) => r.check_result), ["match", "match"]);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM balance_txns WHERE store = 'hc'`).first()).n, 5, "txns deduped by id");
  const bal = await DB.prepare(`SELECT * FROM money_balances WHERE source = 'shopify_payments' AND store = 'hc'`).first();
  assert.equal(bal.amount, 250.1); assert.equal(bal.currency, "USD");
  assert.equal((await feed(DB, "shopify.payouts.hc")).current, "fresh");
  assert.equal((await evs(DB, "payout.mismatch")).length, 0);
  // Matched payouts are not re-read on the second run.
  assert.equal(s.calls.filter((c) => c.store === "hc" && c.op === "BalanceTxns" && c.variables.query).length, 2);
});

test("payouts: a paid payout that doesn't equal its transactions to the cent logs payout.mismatch", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1(); const env = { DB, ...SHOP_SECRETS };
  const s = fakeShopify(paymentsHandler({
    payouts: [payout(7, 100.00)],
    txnsByPayout: { 7: [txn(71, 7, 60.00), txn(72, 7, 39.99)] },
  }));
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  const mm = (await evs(DB, "payout.mismatch")).filter((e) => e.store === "hc");
  assert.equal(mm.length, 1);
  assert.match(mm[0].summary, /off by 0\.01/);
  assert.equal(checkPayout(0.3, [{ net: 0.1 }, { net: 0.2 }]).ok, true, "cents, not floats");
});

test("payouts: if Shopify ignores the per-payout filter, the check is 'unverified', never a false mismatch", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1(); const env = { DB, ...SHOP_SECRETS };
  const s = fakeShopify(paymentsHandler({
    payouts: [payout(8, 100.00)], txnsByPayout: {}, ignoreFilter: true,
    recent: [txn(81, 8, 50.00), txn(82, 9, 50.00)],
  }));
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  assert.equal((await DB.prepare(`SELECT check_result FROM payouts WHERE store='hc'`).first()).check_result, "unverified");
  assert.equal((await evs(DB, "payout.mismatch")).length, 0);
});

test("payouts: a store without Shopify Payments is logged once and stays not wired, never failing", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1(); const env = { DB, ...SHOP_SECRETS };
  await ensureFeeds(DB);
  const s = fakeShopify(paymentsHandler({
    payouts: [], txnsByPayout: {},
    perStore: {
      aub: () => ({ shopifyPaymentsAccount: null }),
      mar: () => ({ errors: [{ message: "Access denied for shopifyPaymentsAccount field." }] }),
    },
  }));
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  await pullPayouts(env, { fetchImpl: s.fetchImpl });
  const un = await evs(DB, "payouts.unavailable");
  assert.deepEqual(un.map((e) => e.store).sort(), ["aub", "mar"], "once per store across two runs");
  assert.equal((await feed(DB, "shopify.payouts.aub")).current, "not_wired");
  assert.equal((await feed(DB, "shopify.payouts.mar")).current, "not_wired");
  assert.equal((await feed(DB, "shopify.payouts.hc")).current, "fresh");
});

/* ---------------- Refunds ---------------- */

const refundNode = (id, txs, processedAt = "2026-10-11T03:00:00Z") => ({
  id: `gid://shopify/Refund/${id}`, createdAt: processedAt, processedAt,
  transactions: { nodes: txs.map((t, i) => ({ id: `gid://shopify/OrderTransaction/${id}${i}`, kind: t.kind || "REFUND", status: t.status,
    processedAt: t.processedAt ?? null, createdAt: t.createdAt || processedAt, amountSet: { shopMoney: { amount: t.amount, currencyCode: "USD" } } })) },
});
const orderNode = (n, refunds) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, updatedAt: "2026-10-11T03:00:00Z", refunds });

test("refunds: dated by the refund transaction's PROCESSED time in store time; PENDING kept with its status", async () => {
  _resetTokenCacheForTests();
  const DB = makeD1(); const env = { DB, ...SHOP_SECRETS };
  let status = "PENDING";
  const s = fakeShopify((store, op) => {
    if (store !== "hc") return op === "RecentRefunds" ? { orders: { pageInfo: { hasNextPage: false }, nodes: [] } } : { nodes: [] };
    // Transaction processed 02:30 UTC Oct 11 = 22:30 Oct 10 Eastern. The refund record says 03:00 UTC.
    const nodes = [orderNode(1231, [refundNode(5, [{ status, amount: "48.95", processedAt: "2026-10-11T02:30:00Z" }])]),
      orderNode(1232, [refundNode(6, [{ status: "SUCCESS", amount: "20.00", processedAt: "2026-10-11T15:00:00Z" }, { status: "FAILURE", amount: "20.00", processedAt: "2026-10-11T14:00:00Z" }])])];
    if (op === "RecentRefunds") return { orders: { pageInfo: { hasNextPage: false }, nodes } };
    if (op === "RefundsByOrder") return { nodes: nodes.filter((n) => n.id.endsWith("1231")) };
    throw new Error(op);
  });
  const nowMs = Date.parse("2026-10-11T16:00:00Z");
  await pullRefunds(env, { fetchImpl: s.fetchImpl, nowMs });
  const r5 = await DB.prepare(`SELECT * FROM refunds WHERE refund_id = 'gid://shopify/Refund/5'`).first();
  assert.equal(r5.local_day, "2026-10-10");
  assert.equal(r5.processed_at, "2026-10-11T02:30:00.000Z");
  assert.equal(r5.status, "PENDING"); assert.equal(r5.amount, 48.95);
  const r6 = await DB.prepare(`SELECT * FROM refunds WHERE refund_id = 'gid://shopify/Refund/6'`).first();
  assert.equal(r6.amount, 20, "failed refund transactions are not money refunded");
  assert.equal(r6.local_day, "2026-10-11");
  assert.equal((await evs(DB, "refunds.imported")).length, 1, "first run: one summary line");
  assert.equal((await evs(DB, "refund.backfilled")).length, 0);

  // Next hour: the pending one went through. Pending orders are re-read by id even if not "updated".
  status = "SUCCESS";
  await pullRefunds(env, { fetchImpl: s.fetchImpl, nowMs: nowMs + 3600000 });
  assert.equal((await DB.prepare(`SELECT status FROM refunds WHERE refund_id = 'gid://shopify/Refund/5'`).first()).status, "SUCCESS");
  const ch = await evs(DB, "refund.status_changed");
  assert.equal(ch.length, 1);
  assert.match(ch[0].summary, /PENDING \$48\.95 → SUCCESS \$48\.95/);
  assert.ok(s.calls.some((c) => c.op === "RefundsByOrder" && c.variables.ids.includes("gid://shopify/Order/1231")));
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM refunds`).first()).n, 2, "no duplicates");
});

test("refunds: webhook and pull share one rule (transaction processed time wins)", () => {
  const w = parseRefund({ id: 5, order_id: 1231, processed_at: "2026-10-11T03:00:00Z",
    transactions: [{ kind: "refund", status: "pending", amount: "48.95", processed_at: "2026-10-10T22:30:00-04:00" }] });
  const p = refundFromNode("gid://shopify/Order/1231", refundNode(5, [{ status: "PENDING", amount: "48.95", processedAt: "2026-10-11T02:30:00Z" }]));
  assert.deepEqual(w, p);
});

/* ---------------- throttle + isolation ---------------- */

test("job_runs: hourly job runs once per hour, overlapping cron runs can't double-run, failures retry sooner", async () => {
  const DB = makeD1();
  const t0 = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(await claimJob(DB, "x", 60, t0), true);
  assert.equal(await claimJob(DB, "x", 60, t0), false, "an overlapping run at the same moment is refused");
  assert.equal(await claimJob(DB, "x", 60, t0 + 15 * 60000), false);
  assert.equal(await claimJob(DB, "x", 60, t0 + 60 * 60000), true);
  await retrySoon(DB, "x", 360, 30, t0 + 60 * 60000);
  assert.equal(await claimJob(DB, "x", 360, t0 + 75 * 60000), false);
  assert.equal(await claimJob(DB, "x", 360, t0 + 90 * 60000), true, "retried ~30 min after the failure");
});

test("money jobs: each runs on its own schedule, and one throwing doesn't stop the others", async () => {
  const DB = makeD1();
  const ran = [];
  const jobs = [
    { job: "ads.spend", actor: "pnl.pullers", run: async () => { ran.push("ads"); throw new Error("boom"); } },
    { job: "payouts", actor: "pnl.money_map", run: async () => { ran.push("payouts"); return [{ store: "hc", ok: true }]; } },
    { job: "refunds", actor: "pnl.refunds", run: async () => { ran.push("refunds"); return [{ store: "hc", ok: true }]; } },
  ];
  const t0 = Date.parse("2026-10-11T12:00:00Z");
  await runMoneyJobs({ DB }, { jobs, nowMs: t0 });
  assert.deepEqual(ran, ["ads", "payouts", "refunds"]);
  assert.equal((await evs(DB, "error.money_job")).length, 1);
  ran.length = 0;
  await runMoneyJobs({ DB }, { jobs, nowMs: t0 + 60 * 60000 });
  assert.deepEqual(ran, ["ads", "refunds"], "payouts waits 6 h; hourly jobs run");
});

test("cron: a broken money feed never stops the Freshness Sentinel", async () => {
  const DB = makeD1();
  DB._raw.exec("DROP TABLE job_runs"); // every money job now fails at its first step
  let p; const ctx = { waitUntil: (x) => { p = x; } };
  await worker.scheduled({ cron: "*/15 * * * *" }, { DB }, ctx);
  await p;
  assert.ok((await evs(DB, "error.money_job")).length >= 1);
  const states = (await DB.prepare(`SELECT state FROM feeds`).all()).results;
  assert.ok(states.length > 0 && states.every((r) => r.state === "not_wired"), "sentinel ran after the failure");
});

test("state: /api/state carries the Money tab data, absent stays absent", async () => {
  _resetGoogleCacheForTests();
  const DB = makeD1(); const env = GENV(DB, { MC_KEY: "k-123" }); await connectGoogle(env);
  const g = fakeAds({ tz: "America/New_York", rowsFor: () => [dayRow("2026-10-10", 30000000)] });
  await pullAdsSpend(env, { fetchImpl: g.fetchImpl, nowMs: Date.now() - 0 });
  await DB.prepare(`INSERT INTO refunds (store, refund_id, order_id, processed_at, local_day, amount, status, updated_at) VALUES ('hc','r1','o1','2026-10-11T12:00:00Z', ?, 9.5, 'PENDING', 'x')`)
    .bind(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date())).run();
  const res = await worker.fetch(new Request("https://b/api/state", { headers: { "x-store-brain-key": "k-123" } }), env);
  const st = await res.json();
  const hc = st.money.stores.find((s) => s.id === "hc");
  assert.ok(hc.ads && hc.ads.currency === "USD");
  assert.equal(hc.adsFeed.state, "fresh");
  assert.equal(hc.balance, null, "no Payments data yet = null, not $0");
  assert.equal(hc.refunds.pending.length, 1);
  assert.equal(hc.refunds.byDay[0].pending_n, 1);
});
