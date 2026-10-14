import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { runRisk, riskState, RISK_JOBS } from "../src/agents/risk/index.js";
import { runChargebacks, reminderDue, approvalTitle, countdownAsOf, missingEvidence, gatherFacts, redactPii, buildCodeDraft, disputeFromNode } from "../src/agents/risk/chargebacks.js";
import { runFraud, screenOrder, shopifyLevel } from "../src/agents/risk/fraud.js";
import { runAccountHealth, judgeHealth, mergeHealth, smallSampleNote } from "../src/agents/risk/accountHealth.js";
import { collectStore, classifyPending, claimSnippets, themeStrings } from "../src/agents/risk/claimsAudit.js";
import { daysLeft } from "../src/agents/risk/shared.js";
import { scanText } from "../src/agents/risk/personalDetails.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";
import { listPending } from "../src/lib/approvals.js";

/* ---------------- fixtures ---------------- */

const NOW = Date.parse("2026-10-13T16:00:00Z"); // 12:00 Eastern, Oct 13
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const KEY = "sk-ant-api03-TESTKEY-never-log-me";
const CREDS = {
  SB_HC_CLIENT_ID: "id", SB_HC_CLIENT_SECRET: "s1",
  SB_AUB_CLIENT_ID: "id", SB_AUB_CLIENT_SECRET: "s2",
  SB_MAR_CLIENT_ID: "id", SB_MAR_CLIENT_SECRET: "s3",
};
const DOMAIN = { "jmzjx1-it.myshopify.com": "hc", "3as2ya-dw.myshopify.com": "aub", "806080-g8.myshopify.com": "mar" };
const j = (x, status = 200) => new Response(JSON.stringify(x), { status });

beforeEach(() => _resetTokenCacheForTests());

/**
 * Fake network: Shopify (token mint + GraphQL by operation name) and Claude.
 * Records every call; any mutation or non-GraphQL Shopify write fails the test.
 */
function fakeNet({ shopify = () => ({}), claude = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.push({ kind: "claude", body: JSON.parse(init.body) });
      if (!claude) throw new Error("Claude not expected");
      const text = typeof claude === "function" ? claude(JSON.parse(init.body)) : claude;
      return j({ model: "claude-test", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: "end_turn" });
    }
    const host = new URL(url).host;
    if (url.endsWith("/admin/oauth/access_token")) return j({ access_token: "shpat-SECRET", expires_in: 86399 });
    const body = JSON.parse(init.body);
    assert.ok(!/^\s*mutation/i.test(body.query), "the Risk agents must never send a mutation");
    const op = (body.query.match(/query\s+(\w+)/) || [])[1] || "anon";
    calls.push({ kind: "shopify", store: DOMAIN[host], op, variables: body.variables });
    const r = shopify(DOMAIN[host], op, body.variables || {});
    if (r && r.errors) return j(r);
    return j({ data: r });
  };
  return { fetchImpl, calls };
}

function disputeNode(over = {}) {
  return {
    id: "gid://shopify/ShopifyPaymentsDispute/1", legacyResourceId: "1", status: "NEEDS_RESPONSE", type: "CHARGEBACK",
    initiatedAt: "2026-10-10T12:00:00Z", evidenceDueBy: "2026-10-31", evidenceSentOn: null, finalizedOn: null,
    amount: { amount: "89.95", currencyCode: "USD" }, reasonDetails: { reason: "PRODUCT_NOT_RECEIVED", networkReasonCode: "13.1" },
    order: {
      id: "gid://shopify/Order/1053", name: "#1053", createdAt: "2026-09-20T12:00:00Z", email: "buyer@example.com",
      displayFulfillmentStatus: "FULFILLED", totalPriceSet: { shopMoney: { amount: "89.95", currencyCode: "USD" } },
      customer: { id: "gid://shopify/Customer/9", displayName: "Pat Buyer", numberOfOrders: "1" },
      shippingAddress: { name: "Pat Buyer", city: "Austin", provinceCode: "TX", countryCodeV2: "US", zip: "78701" },
      billingAddress: { countryCodeV2: "US", zip: "78701" },
      fulfillments: [{ createdAt: "2026-09-23T10:00:00Z", displayStatus: "IN_TRANSIT", deliveredAt: null,
        trackingInfo: [{ number: "LX123456789CN", company: "Other", url: null }] }],
      lineItems: { nodes: [{ title: "Wool Blazer", variantTitle: "Navy / L", quantity: 1, sku: "HC-WBLZ-006" }] },
    },
    ...over,
  };
}

const only = (store, handler, empty) => (s, op, v) => (s === store ? handler(s, op, v) : empty(op));
const emptyFor = (op) => ({
  RiskDisputes: { disputes: { nodes: [] } },
  RiskOrders: { orders: { nodes: [] } },
  RiskRates: { ordersCount: { count: 0, precision: "EXACT" }, disputes: { nodes: [], pageInfo: { hasNextPage: false } } },
  RiskAccount: { shopifyPaymentsAccount: { activated: true, onboardable: false, payouts: { nodes: [] } } },
  RiskPayoutSchedule: { shopifyPaymentsAccount: { payoutSchedule: { interval: "DAILY" } } },
  RiskClaimsText: { themes: { nodes: [] }, products: { nodes: [] } },
  RiskPolicies: { shop: { shopPolicies: [] } },
}[op] || {});

const evs = async (DB, kind) => (await DB.prepare(`SELECT * FROM events WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

/* ---------------- shared helpers ---------------- */

test("risk: days left counts Eastern calendar days and never rounds up", () => {
  assert.equal(daysLeft("2026-10-31", NOW), 18);
  assert.equal(daysLeft("2026-10-13", NOW), 0);
  assert.equal(daysLeft("2026-10-12", NOW), -1);
  // 23:30 Eastern on Oct 13 is already Oct 14 in UTC: still Oct 13 here.
  assert.equal(daysLeft("2026-10-14", Date.parse("2026-10-14T03:30:00Z")), 1);
  assert.equal(daysLeft(null, NOW), null);
});

/* ---------------- Chargeback Agent ---------------- */

test("chargebacks: stores the dispute, ONE approval with order, amount and due date; no duplicate on later runs", async () => {
  const DB = makeD1();
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor) });
  const env = { DB, ...CREDS };
  await runChargebacks(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  await runChargebacks(env, { nowMs: NOW + 3600000, fetchImpl: net.fetchImpl });
  const pend = await listPending(DB);
  assert.equal(pend.length, 1);
  assert.match(pend[0].title, /#1053/);
  assert.match(pend[0].title, /\$89\.95/);
  assert.match(pend[0].title, /Oct 31/);
  // No frozen countdown in the stored title; the dated countdown sits in the option detail.
  assert.doesNotMatch(pend[0].title, /days? left|TODAY|OVERDUE/);
  assert.match(pend[0].options[0].detail, /As of Oct 13: 18 days left/);
  assert.equal(pend[0].dept, "risk");
  const row = await DB.prepare(`SELECT * FROM risk_disputes`).first();
  assert.equal(row.status, "NEEDS_RESPONSE");
  assert.equal(row.evidence_due_by, "2026-10-31"); // from Shopify's answer, never assumed
  assert.equal(row.approval_id, pend[0].id);
  assert.equal((await evs(DB, "risk.dispute_new")).length, 1);
  // Only GraphQL reads went to Shopify.
  assert.ok(net.calls.filter((c) => c.kind === "shopify").every((c) => c.op === "RiskDisputes"));
});

test("chargebacks: evidence pack facts gathered by code; missing proof listed; email kept out of the AI prompt", async () => {
  const DB = makeD1();
  const net = fakeNet({
    shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor),
    claude: "The order #1053 shipped on Sep 23 with tracking LX123456789CN. [ADD: proof of delivery]",
  });
  const env = { DB, ...CREDS, ANTHROPIC_API_KEY: KEY };
  await runChargebacks(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const pack = await DB.prepare(`SELECT * FROM risk_evidence_packs`).first();
  assert.equal(pack.status, "draft");
  assert.match(pack.rebuttal, /LX123456789CN/);
  const facts = JSON.parse(pack.facts);
  assert.equal(facts.fulfillments[0].tracking[0].number, "LX123456789CN");
  assert.equal(facts.customer.email, "buyer@example.com");
  const missing = JSON.parse(pack.missing);
  assert.ok(missing.some((m) => /Proof of delivery/.test(m)));
  assert.ok(missing.some((m) => /Customer emails/.test(m)));
  const ai = net.calls.filter((c) => c.kind === "claude");
  assert.equal(ai.length, 1);
  assert.ok(!JSON.stringify(ai[0].body).includes("buyer@example.com"));
  // Once per dispute: a second run does not call Claude again.
  await runChargebacks(env, { nowMs: NOW + 3600000, fetchImpl: net.fetchImpl });
  assert.equal(net.calls.filter((c) => c.kind === "claude").length, 1);
  assert.equal((await evs(DB, "risk.evidence_drafted")).length, 1);
});

test("chargebacks: no AI key → facts only, waiting on AI (not counted as the one attempt)", async () => {
  const DB = makeD1();
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor) });
  await runChargebacks({ DB, ...CREDS }, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const pack = await DB.prepare(`SELECT * FROM risk_evidence_packs`).first();
  assert.equal(pack.status, "waiting_ai");
  assert.equal(pack.ai_attempted_at, null);
  assert.ok(pack.facts);
});

test("chargebacks: reminders at 7 and 2 days, each once; first sight inside 2 days sends only the urgent one", async () => {
  assert.equal(reminderDue(18, []), null);
  assert.deepEqual(reminderDue(7, []), { send: 7, mark: [7] });
  assert.equal(reminderDue(5, [7]), null);
  assert.deepEqual(reminderDue(2, [7]), { send: 2, mark: [2] });
  assert.deepEqual(reminderDue(1, []), { send: 2, mark: [7, 2] });
  assert.equal(reminderDue(-1, []), null);

  const DB = makeD1();
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor) });
  const env = { DB, ...CREDS };
  const at = (day) => Date.parse(`${day}T16:00:00Z`);
  for (const d of ["2026-10-13", "2026-10-24", "2026-10-24", "2026-10-25", "2026-10-29", "2026-10-30"]) {
    await runChargebacks(env, { nowMs: at(d), fetchImpl: net.fetchImpl });
  }
  const rem = await evs(DB, "risk.dispute_reminder");
  assert.equal(rem.length, 2);
  assert.match(rem[0].summary, /7 days left/);
  assert.match(rem[1].summary, /2 days left/);
  await runChargebacks(env, { nowMs: at("2026-11-01"), fetchImpl: net.fetchImpl });
  await runChargebacks(env, { nowMs: at("2026-11-02"), fetchImpl: net.fetchImpl });
  assert.equal((await evs(DB, "risk.dispute_overdue")).length, 1);
});

test("chargebacks: once Shopify shows the evidence submitted, the pending approval is closed as expired", async () => {
  const DB = makeD1();
  let node = disputeNode();
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [node] } }), emptyFor) });
  const env = { DB, ...CREDS };
  await runChargebacks(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  node = disputeNode({ status: "UNDER_REVIEW", evidenceSentOn: "2026-10-14" });
  await runChargebacks(env, { nowMs: NOW + DAY, fetchImpl: net.fetchImpl });
  assert.equal((await listPending(DB)).length, 0);
  assert.equal((await DB.prepare(`SELECT status FROM approvals`).first()).status, "expired");
  assert.equal((await evs(DB, "risk.dispute_status")).length, 1);
});

test("chargebacks: a store that isn't wired is skipped and noted once a day, never as 'no disputes'", async () => {
  const DB = makeD1();
  const net = fakeNet({ shopify: (s, op) => emptyFor(op) });
  const env = { DB, SB_HC_CLIENT_ID: "id", SB_HC_CLIENT_SECRET: "s1" }; // aub, mar not wired
  const r = await runChargebacks(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal(r.stores.aub, "not_wired");
  assert.equal(r.stores.mar, "not_wired");
  await runChargebacks(env, { nowMs: NOW + 3600000, fetchImpl: net.fetchImpl });
  assert.equal((await evs(DB, "risk.not_wired")).length, 2); // aub + mar, once each
});

test("chargebacks: title has the due date only; the dated countdown says OVERDUE / TODAY plainly", () => {
  const d = { order_name: "#1", amount: 10, currency: "USD", evidence_due_by: "2026-10-13", type: "CHARGEBACK" };
  assert.equal(approvalTitle("hc", d), "Chargeback #1 · $10.00 · evidence due Oct 13 · Holt & Crane");
  assert.equal(countdownAsOf(d, NOW), "As of Oct 13: due TODAY");
  assert.equal(countdownAsOf({ ...d, evidence_due_by: "2026-10-10" }, NOW), "As of Oct 13: 3 days OVERDUE");
  assert.equal(countdownAsOf({ ...d, evidence_due_by: null }, NOW), "Shopify gave no due date");
});

test("chargebacks: missing evidence notes a billing/shipping ZIP mismatch on fraud disputes", async () => {
  const DB = makeD1();
  const f = await gatherFacts(DB, "hc", {
    dispute_id: "x", order_id: null, order_name: "#2", reason: "FRAUDULENT", type: "CHARGEBACK", amount: 5, currency: "USD",
    order_snapshot: JSON.stringify({ ...disputeNode().order, billingAddress: { countryCodeV2: "US", zip: "10001" } }),
  });
  assert.ok(missingEvidence(f).some((m) => /ZIP differ/.test(m)));
});

/* ---------------- Fraud Screen ---------------- */

const orderNode = (n, over = {}) => ({
  id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: iso(NOW - 3600000), email: `c${n}@example.com`, test: false, cancelledAt: null,
  totalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "USD" } }, customer: { id: `gid://shopify/Customer/${n}` },
  billingAddress: { countryCodeV2: "US" }, shippingAddress: { countryCodeV2: "US" },
  risk: { recommendation: "ACCEPT", assessments: [{ riskLevel: "LOW", facts: [], provider: null }] },
  transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", paymentDetails: { bin: "411111", number: `•••• ${String(1000 + n)}`, company: "Visa" } }],
  ...over,
});

test("fraud: Shopify HIGH/CANCEL → HIGH; code checks alone never go above MEDIUM", () => {
  assert.equal(shopifyLevel({ assessments: [{ riskLevel: "LOW" }, { riskLevel: "HIGH" }] }), "HIGH");
  assert.equal(shopifyLevel({ assessments: [{ riskLevel: "PENDING" }] }), "PENDING");
  assert.equal(shopifyLevel({ assessments: [] }), null);
  const high = screenOrder(orderNode(1, { risk: { recommendation: "CANCEL", assessments: [{ riskLevel: "HIGH", facts: [{ description: "Card declined 4 times", sentiment: "NEGATIVE" }] }] } }), []);
  assert.equal(high.level, "HIGH");
  assert.ok(high.reasons.some((r) => /Card declined/.test(r)));
  const mismatch = screenOrder(orderNode(2, { billingAddress: { countryCodeV2: "NG" } }), []);
  assert.equal(mismatch.level, "MEDIUM");
  assert.match(mismatch.reasons[0], /NG ≠ shipping country US/);
  const clean = screenOrder(orderNode(3), []);
  assert.equal(clean.level, null);
  // Same card on 3 orders within a day.
  const card = { paymentDetails: { bin: "999999", number: "•••• 4242" } };
  const os = [4, 5, 6].map((n) => orderNode(n, { transactions: [card] }));
  assert.ok(screenOrder(os[0], os).reasons.some((r) => /Same card on 3 orders/.test(r)));
  assert.equal(screenOrder(os[0], os).level, "MEDIUM");
});

test("fraud: one event per flagged order, approval only for HIGH, each order screened once; test orders ignored", async () => {
  const DB = makeD1();
  const orders = [
    orderNode(10, { risk: { recommendation: "CANCEL", assessments: [{ riskLevel: "HIGH", facts: [] }] } }),
    orderNode(11, { billingAddress: { countryCodeV2: "GB" } }),
    orderNode(12),
    orderNode(13, { test: true, risk: { recommendation: "CANCEL", assessments: [{ riskLevel: "HIGH", facts: [] }] } }),
  ];
  const net = fakeNet({ shopify: only("aub", () => ({ orders: { nodes: orders } }), emptyFor) });
  const env = { DB, ...CREDS };
  await runFraud(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  await runFraud(env, { nowMs: NOW + 1800000, fetchImpl: net.fetchImpl });
  const pend = await listPending(DB);
  assert.equal(pend.length, 1);
  assert.match(pend[0].title, /#10/);
  assert.equal((await evs(DB, "risk.order_high")).length, 1);
  assert.equal((await evs(DB, "risk.order_flagged")).length, 1);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM risk_order_screens`).first()).n, 3);
  const q = net.calls.find((c) => c.op === "RiskOrders");
  assert.match(q.variables.q, /^created_at:>='/);
});

test("fraud: a PENDING Shopify assessment is re-checked, then judged", async () => {
  const DB = makeD1();
  let risk = { recommendation: "NONE", assessments: [{ riskLevel: "PENDING", facts: [] }] };
  const net = fakeNet({ shopify: only("hc", () => ({ orders: { nodes: [orderNode(20, { risk })] } }), emptyFor) });
  const env = { DB, ...CREDS };
  await runFraud(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  let row = await DB.prepare(`SELECT * FROM risk_order_screens`).first();
  assert.equal(row.final, 0);
  risk = { recommendation: "CANCEL", assessments: [{ riskLevel: "HIGH", facts: [] }] };
  await runFraud(env, { nowMs: NOW + 1800000, fetchImpl: net.fetchImpl });
  row = await DB.prepare(`SELECT * FROM risk_order_screens`).first();
  assert.equal(row.final, 1);
  assert.equal(row.level, "HIGH");
  assert.equal((await listPending(DB)).length, 1);
});

/* ---------------- Account Health ---------------- */

test("health: thresholds 0.5% watch, 0.75% bad; unknown stays unknown", () => {
  assert.equal(judgeHealth({ payments_activated: 1, failed_payouts: 0, dispute_rate: 0.004 }).state, "ok");
  assert.equal(judgeHealth({ payments_activated: 1, failed_payouts: 0, dispute_rate: 0.006 }).state, "watch");
  assert.equal(judgeHealth({ payments_activated: 1, failed_payouts: 0, dispute_rate: 0.0075 }).state, "bad");
  assert.equal(judgeHealth({ payments_activated: 1, failed_payouts: 1, dispute_rate: null }).state, "bad");
  assert.equal(judgeHealth({ payments_activated: null, failed_payouts: null, dispute_rate: null }).state, null);
});

test("health: dispute rate from Shopify counts; refund rate null when the refund feed doesn't cover 90 days; alert only when worse", async () => {
  const DB = makeD1();
  let disputes = 1;
  const net = fakeNet({
    shopify: only("mar", (s, op) => op === "RiskRates"
      ? { ordersCount: { count: 400, precision: "EXACT" }, disputes: { nodes: Array.from({ length: disputes }, (_, i) => ({ id: `d${i}`, status: "WON" })), pageInfo: { hasNextPage: false } } }
      : emptyFor(op), emptyFor),
  });
  const env = { DB, ...CREDS };
  await runAccountHealth(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  let row = await DB.prepare(`SELECT * FROM risk_account_health WHERE store = 'mar'`).first();
  assert.equal(row.dispute_rate, 1 / 400);
  assert.equal(row.state, "ok");
  assert.equal(row.refund_rate, null);
  // aub had zero orders: rate is null, never 0%.
  assert.equal((await DB.prepare(`SELECT dispute_rate FROM risk_account_health WHERE store = 'aub'`).first()).dispute_rate, null);
  assert.equal((await evs(DB, "risk.health_worse")).length, 0);
  disputes = 4; // 1% → bad
  await runAccountHealth(env, { nowMs: NOW + DAY, fetchImpl: net.fetchImpl });
  await runAccountHealth(env, { nowMs: NOW + 2 * DAY, fetchImpl: net.fetchImpl });
  row = await DB.prepare(`SELECT * FROM risk_account_health WHERE store = 'mar'`).first();
  assert.equal(row.state, "bad");
  assert.equal((await evs(DB, "risk.health_worse")).length, 1);
});

test("health (live 2026-10-14): payout schedule 'not available for this account' → interval null with the reason, the rest read, no error loop", async () => {
  const DB = makeD1();
  const net = fakeNet({
    shopify: (s, op) => op === "RiskPayoutSchedule"
      ? { errors: [{ message: "Field inside method payout_schedule is not available for this account" }] }
      : op === "RiskAccount"
        ? { shopifyPaymentsAccount: { activated: true, onboardable: false, payouts: { nodes: [{ id: "p1", status: "FAILED" }] } } }
        : emptyFor(op),
  });
  const env = { DB, ...CREDS };
  for (let i = 0; i < 3; i++) await runAccountHealth(env, { nowMs: NOW + i * 3600000, fetchImpl: net.fetchImpl });
  const row = await DB.prepare(`SELECT * FROM risk_account_health WHERE store = 'hc'`).first();
  assert.equal(row.payments_activated, 1, "the rest of the Payments read survives");
  assert.equal(row.failed_payouts, 1);
  assert.equal(row.payout_interval, null);
  assert.match(JSON.parse(row.detail).payout_interval_note, /not available to the Store Brain's app.*not available for this account/);
  assert.equal((await evs(DB, "error.risk")).length, 0, "not an error");
  assert.equal((await evs(DB, "risk.not_wired")).filter((e) => e.store === "hc").length, 1, "noted once a day, not every run");
  const st = await riskState(env, { nowMs: NOW });
  const hc = st.accountHealth.find((h) => h.store === "hc");
  assert.equal(hc.payout_interval, null);
  assert.match(hc.payout_interval_note, /not available/);

  // A passing fault on the schedule keeps the last known interval (and isn't "not available").
  const DB2 = makeD1();
  let fail = false;
  const net2 = fakeNet({ shopify: (s, op) => (op === "RiskPayoutSchedule" && fail ? { errors: [{ message: "Internal error" }] } : emptyFor(op)) });
  await runAccountHealth({ DB: DB2, ...CREDS }, { nowMs: NOW, fetchImpl: net2.fetchImpl });
  fail = true;
  await runAccountHealth({ DB: DB2, ...CREDS }, { nowMs: NOW + DAY, fetchImpl: net2.fetchImpl });
  assert.equal((await DB2.prepare(`SELECT payout_interval FROM risk_account_health WHERE store = 'hc'`).first()).payout_interval, "DAILY");
});

test("health (live 2026-10-14): Marlowe 1 WON dispute in 30 orders → rate stays 3.33% and 'bad', shown as 1 of 30 with a small-sample note", async () => {
  const DB = makeD1();
  const net = fakeNet({
    shopify: only("mar", (s, op) => op === "RiskRates"
      ? { ordersCount: { count: 30, precision: "EXACT" }, disputes: { nodes: [{ id: "d1001", status: "WON" }], pageInfo: { hasNextPage: false } } }
      : emptyFor(op), emptyFor),
  });
  const env = { DB, ...CREDS };
  await runAccountHealth(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const row = await DB.prepare(`SELECT * FROM risk_account_health WHERE store = 'mar'`).first();
  assert.equal(row.dispute_rate, 1 / 30, "the rate itself is not hidden or softened");
  assert.equal(row.state, "bad");
  const reasons = JSON.parse(row.detail).reasons;
  assert.ok(reasons.some((r) => /3\.33% \(1 of 30 orders\)/.test(r)), reasons.join(" | "));
  assert.ok(reasons.some((r) => /Small sample: only 30 orders in 90 days, so each dispute moves the rate by 3\.33 points \(won 1\)/.test(r)));
  const st = await riskState(env, { nowMs: NOW });
  const mar = st.accountHealth.find((h) => h.store === "mar");
  assert.equal(mar.disputes, "1 of 30 orders");
  assert.equal(mar.dispute_outcomes, "won 1");
  assert.match(mar.small_sample_note, /Small sample/);
  assert.match((await evs(DB, "risk.health_checked"))[0].summary, /Marlowe Standard: bad, disputes 3\.33% \(1 of 30 orders\)/);
  // 100+ orders: no small-sample note.
  assert.equal(smallSampleNote({ orders_90d: 400, disputes_90d: 4 }), null);
});

/* ---------------- Claims Auditor ---------------- */

test("claims: theme JSON (with comment header) and descriptions → only promise-like snippets", () => {
  const theme = `/* auto-generated */ {"sections":{"a":{"settings":{"text":"<p>Free shipping and delivery in 2 days!</p>","color":"#000000","link":"shopify://collections/all"}}}}`;
  const strs = themeStrings(theme);
  assert.ok(strs.includes("<p>Free shipping and delivery in 2 days!</p>"));
  const s = claimSnippets([...strs, "<p>A navy blazer. Made in Italy from 100% wool.</p>", "Soft and warm."]);
  assert.ok(s.includes("Free shipping and delivery in 2 days!"));
  assert.ok(s.some((x) => /Made in Italy/.test(x)));
  assert.ok(!s.includes("Soft and warm."));
  assert.ok(!s.some((x) => /#000000|shopify:/.test(x)));
});

test("claims: collect dedupes; policies without scope noted as not wired; AI classifies in a capped batch", async () => {
  const DB = makeD1();
  const sf = {
    themes: { nodes: [{ id: "t", name: "Dawn", files: { nodes: [{ filename: "sections/header-group.json", body: { content: `{"s":{"x":{"settings":{"text":"Free returns, ships in 2 days"}}}}` } }] } }] },
    products: { nodes: [{ id: "p", title: "Blazer", handle: "blazer", description: "<p>Handmade in Italy. Only 2 left in stock!</p>" }] },
  };
  const net = fakeNet({
    shopify: (s, op) => (op === "RiskPolicies" ? { errors: [{ message: "Access denied for shopPolicies field. Required access: `read_legal_policies` access scope." }] } : sf),
    claude: (body) => {
      const snippets = JSON.parse(body.messages[0].content).snippets;
      return JSON.stringify({ items: snippets.map((x) => ({ n: x.n, risky: /2 days|Italy/.test(x.text), category: /Italy/.test(x.text) ? "origin" : "delivery", why: "test" })) });
    },
  });
  const env = { DB, ...CREDS, ANTHROPIC_API_KEY: KEY };
  const a = await collectStore(env, "hc", { nowMs: NOW, fetchImpl: net.fetchImpl });
  const b = await collectStore(env, "hc", { nowMs: NOW + DAY, fetchImpl: net.fetchImpl });
  assert.ok(a.added >= 2);
  assert.equal(b.added, 0);
  assert.equal((await evs(DB, "risk.not_wired")).length, 1);
  const r = await classifyPending(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal(r.batches, 1);
  assert.ok(r.risky >= 2);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM risk_claims WHERE verdict = 'pending'`).first()).n, 0);
  assert.equal(net.calls.filter((c) => c.kind === "claude").length, 1);
});

test("claims: an unusable AI answer marks the batch 'unclear' (not re-paid every hour); no key → stays pending", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO risk_claims (store, source, text, hash, found_at, last_seen_at) VALUES ('hc', 'theme:x', 'Ships in 2 days', 'h1', ?, ?)`).bind(iso(NOW), iso(NOW)).run();
  const r0 = await classifyPending({ DB }, { nowMs: NOW, fetchImpl: fakeNet().fetchImpl });
  assert.match(r0.waiting, /not wired/);
  assert.equal((await DB.prepare(`SELECT verdict FROM risk_claims`).first()).verdict, "pending");
  const net = fakeNet({ claude: "sorry, no" });
  await classifyPending({ DB, ANTHROPIC_API_KEY: KEY }, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal((await DB.prepare(`SELECT verdict FROM risk_claims`).first()).verdict, "unclear");
});

/* ---------------- department entry points ---------------- */

test("runRisk: throttled per agent, never throws, only reads Shopify, state renders", async () => {
  const DB = makeD1();
  const net = fakeNet({ shopify: only("hc", (s, op) => (op === "RiskDisputes" ? { disputes: { nodes: [disputeNode()] } } : emptyFor(op)), emptyFor) });
  const env = { DB, ...CREDS };
  const r1 = await runRisk(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.ok(r1.chargebacks.stores);
  assert.ok(r1.fraud.stores);
  assert.ok(r1.health.hc);
  assert.equal(r1.claimsCollect.store, "hc"); // one store per tick
  const n1 = net.calls.length;
  const r2 = await runRisk(env, { nowMs: NOW + 15 * 60000, fetchImpl: net.fetchImpl });
  assert.equal(r2.chargebacks, "not due");
  assert.equal(r2.fraud, "not due");
  assert.equal(r2.health, "not due");
  assert.equal(r2.claimsCollect.store, "aub");
  assert.ok(net.calls.length - n1 <= 3);
  // A crashing network never throws out of runRisk.
  const bad = await runRisk(env, { nowMs: NOW + 2 * DAY, fetchImpl: async () => { throw new Error("network down"); } });
  assert.ok(bad);
  const st = await riskState(env, { nowMs: NOW });
  assert.equal(st.mode, "shadow");
  assert.equal(st.disputes.needResponse, 1);
  assert.equal(st.disputes.open[0].daysLeft, 18);
  assert.equal(st.disputes.open[0].evidence.status, "waiting_ai");
  assert.ok(st.lastRuns.some((x) => x.job === RISK_JOBS.chargebacks.job));
  assert.ok(st.accountHealth.length >= 1);
});

test("runRisk: RISK_OFF=1 does nothing", async () => {
  const DB = makeD1();
  const net = fakeNet();
  assert.deepEqual(await runRisk({ DB, ...CREDS, RISK_OFF: "1" }, { nowMs: NOW, fetchImpl: net.fetchImpl }), { skipped: "RISK_OFF" });
  assert.equal(net.calls.length, 0);
});

/* ---------------- review fixes (2026-10-13) ---------------- */

test("fix: customer PII from a real cs_tickets row never reaches Claude; only date, subject and redacted body are used", async () => {
  const DB = makeD1();
  await DB.prepare(
    `INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, received_at, store, from_email, from_name, to_addr, subject, body,
       order_ref, order_id, order_name, draft_body, context, triage)
     VALUES (?, ?, 'google:hc', 'g1', '2026-10-01T15:00:00Z', 'hc', 'pat.buyer@example.com', 'Pat Buyer', 'info@holtandcrane.com',
       'Where is my order #1053? - Pat Buyer', ?, '1053', 'gid://shopify/Order/1053', '#1053',
       'Hi Pat Buyer, your parcel to 12 Elm Street is on its way', '{"address":"12 Elm Street, Austin TX 78701"}', '{"from":"pat.buyer@example.com"}')`
  ).bind(iso(NOW), iso(NOW),
    "Hi, this is Pat Buyer. My blazer hasn't arrived at 12 Elm Street Apt 4, Austin TX 78701. Call me on (512) 555-0199 or email pat.buyer@example.com").run();
  const net = fakeNet({
    shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor),
    claude: "Draft. [ADD: proof of delivery]",
  });
  await runChargebacks({ DB, ...CREDS, ANTHROPIC_API_KEY: KEY }, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const ai = net.calls.filter((c) => c.kind === "claude");
  assert.equal(ai.length, 1);
  const prompt = JSON.stringify(ai[0].body);
  for (const pii of ["pat.buyer@example.com", "buyer@example.com", "Pat", "Buyer", "Elm Street", "12 Elm", "Austin", "78701", "555-0199", "512", "info@holtandcrane.com"]) {
    assert.ok(!prompt.includes(pii), `the prompt must not contain "${pii}"`);
  }
  // The message itself did make it in (redacted), so the rebuttal can cite it.
  assert.match(prompt, /blazer hasn't arrived/);
  assert.match(prompt, /2026-10-01T15:00:00Z/);
  // CS drafts, context and triage are never read.
  assert.ok(!prompt.includes("your parcel to"));
  // The stored pack holds only date, subject and redacted body.
  const facts = JSON.parse((await DB.prepare(`SELECT facts FROM risk_evidence_packs`).first()).facts);
  assert.equal(facts.customer_messages.length, 1);
  assert.deepEqual(Object.keys(facts.customer_messages[0]).sort(), ["body", "received_at", "subject"]);
  assert.ok(!JSON.stringify(facts.customer_messages).includes("example.com"));
  assert.ok(!JSON.parse((await DB.prepare(`SELECT missing FROM risk_evidence_packs`).first()).missing).some((m) => /Customer emails/.test(m)));
});

test("fix: a stranger's ticket that only TYPED the order number (order_mismatch = 1) never joins the evidence pack or reaches Claude", async () => {
  const DB = makeD1();
  const ins = (gmailId, orderId) => DB.prepare(
    `INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, received_at, store, from_email, from_name, subject, body,
       order_ref, order_id, order_name, order_store, order_mismatch)
     VALUES (?, ?, 'google', ?, '2026-10-02T15:00:00Z', 'hc', 'stranger@example.net', 'Sam Stranger', 'Order 1053',
       'this is not the cardholder, I never got order 1053', '1053', ?, '#1053', 'hc', 1)`
  ).bind(iso(NOW), iso(NOW), gmailId, orderId).run();
  await ins("probe-1", null);                          // typed number only, no verified order
  await ins("probe-2", "gid://shopify/Order/1053");     // even if an id were set, mismatch wins
  const net = fakeNet({
    shopify: only("hc", () => ({ disputes: { nodes: [disputeNode()] } }), emptyFor),
    claude: "Draft. [ADD: proof of delivery]",
  });
  await runChargebacks({ DB, ...CREDS, ANTHROPIC_API_KEY: KEY }, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const facts = JSON.parse((await DB.prepare(`SELECT facts FROM risk_evidence_packs`).first()).facts);
  assert.deepEqual(facts.customer_messages, []);
  const prompt = JSON.stringify(net.calls.filter((c) => c.kind === "claude")[0].body);
  assert.ok(!prompt.includes("not the cardholder"));
  assert.ok(!prompt.includes("stranger"));
  // With no verified email, the pack still asks Reilly for the customer emails.
  assert.ok(JSON.parse((await DB.prepare(`SELECT missing FROM risk_evidence_packs`).first()).missing).some((m) => /Customer emails/.test(m)));
});

/* ---------------- first live runs (2026-10-14) ---------------- */

/** The live #1098 shape: H&C, PRODUCT_NOT_RECEIVED, NEEDS_RESPONSE, $65.95, evidence due Oct 16. */
const live1098 = () => disputeNode({
  id: "gid://shopify/ShopifyPaymentsDispute/1098", legacyResourceId: "1098", evidenceDueBy: "2026-10-16",
  initiatedAt: "2026-09-30T09:00:00Z", amount: { amount: "65.95", currencyCode: "USD" },
  reasonDetails: { reason: "PRODUCT_NOT_RECEIVED", networkReasonCode: "13.1" },
  order: {
    id: "gid://shopify/Order/1098", name: "#1098", createdAt: "2026-09-02T18:00:00Z", email: "kim@example.org",
    displayFulfillmentStatus: "FULFILLED", totalPriceSet: { shopMoney: { amount: "65.95", currencyCode: "USD" } },
    customer: null, // guest checkout
    shippingAddress: { name: "Kim Lee", city: "Denver", provinceCode: "CO", countryCodeV2: "US", zip: "80202" },
    billingAddress: { countryCodeV2: "US", zip: "80202" },
    fulfillments: [{ createdAt: "2026-09-05T10:00:00Z", displayStatus: "IN_TRANSIT", deliveredAt: null,
      trackingInfo: [{ number: "YT2624500012345", company: "Other", url: null }] }],
    lineItems: { nodes: [{ title: "Oxford Shirt", variantTitle: "White / M", quantity: 1, sku: "HC-OXF-002" }] },
  },
});
const won1001 = () => disputeNode({ id: "gid://shopify/ShopifyPaymentsDispute/1001", legacyResourceId: "1001", status: "WON",
  finalizedOn: "2026-09-20", order: { ...disputeNode().order, id: "gid://shopify/Order/1001", name: "#1001" } });

test("live #1098: a failed AI attempt still leaves a code-written evidence draft from the order's own data; drafts is never []", async () => {
  const DB = makeD1();
  // Another order's verified ticket and a stranger who typed #1098: neither may reach #1098's evidence.
  const ins = (gmailId, orderId, mismatch, body) => DB.prepare(
    `INSERT INTO cs_tickets (opened_at, updated_at, slot, gmail_id, received_at, store, from_email, from_name, subject, body,
       order_ref, order_id, order_name, order_store, order_mismatch)
     VALUES (?, ?, 'google', ?, '2026-10-02T15:00:00Z', 'hc', 'x@example.net', 'X', 'About my order', ?, '1098', ?, '#1098', 'hc', ?)`
  ).bind(iso(NOW), iso(NOW), gmailId, body, orderId, mismatch).run();
  await ins("other-order", "gid://shopify/Order/1053", 0, "OTHER-ORDER-TEXT my 1053 blazer");
  await ins("stranger", "gid://shopify/Order/1098", 1, "STRANGER-TEXT I am not the cardholder");
  // A 17TRACK row claiming delivery: parcel tracking is off, so it must not be used.
  await DB.prepare(`INSERT INTO shipments (store, order_id, tracking_number, state, delivered_at, updated_at) VALUES ('hc', 'gid://shopify/Order/1098', 'YT2624500012345', 'delivered', '2026-09-12T00:00:00Z', ?)`)
    .bind(iso(NOW)).run();

  let claudeUp = false;
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [live1098(), won1001()] } }), emptyFor) });
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://api.anthropic.com/") && !claudeUp) {
      net.calls.push({ kind: "claude-failed" });
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
    }
    return net.fetchImpl(url, init);
  };
  const env = { DB, ...CREDS, ANTHROPIC_API_KEY: KEY };
  const live = Date.parse("2026-10-14T13:00:00Z");

  const r1 = await runChargebacks(env, { nowMs: live, fetchImpl });
  assert.deepEqual(r1.stores.hc, { read: 2, needsResponse: 1 });
  assert.equal(r1.drafts.length, 1, "the open dispute is listed, never []");
  assert.deepEqual(r1.drafts[0], { order: "#1098", store: "hc", draft: "code", ai: "failed 1/3", add: r1.drafts[0].add });
  assert.ok(r1.drafts[0].add >= 2);

  const pack = await DB.prepare(`SELECT * FROM risk_evidence_packs WHERE dispute_id = 'gid://shopify/ShopifyPaymentsDispute/1098'`).first();
  const draft = pack.code_draft;
  assert.ok(draft, "a draft exists without the AI");
  assert.equal(pack.blocked, null);
  assert.match(draft, /#1098/);
  assert.match(draft, /\$65\.95/);
  assert.match(draft, /product not received/);
  assert.match(draft, /YT2624500012345/);
  assert.match(draft, /Fulfilled in Shopify 2026-09-05/);
  assert.match(draft, /Shipped to the address the customer gave at checkout \(Denver, CO, US\)/);
  assert.match(draft, /\[ADD: carrier\]/, "carrier 'Other' is called out");
  assert.match(draft, /\[ADD: carrier proof of delivery/);
  // Only this order's own data.
  for (const leak of ["OTHER-ORDER-TEXT", "STRANGER-TEXT", "#1053", "Wool Blazer", "1001"]) assert.ok(!draft.includes(leak), `draft must not contain ${leak}`);
  const facts = JSON.parse(pack.facts);
  assert.deepEqual(facts.ledger_shipments, [], "17TRACK data not used while parcel tracking is off");
  assert.match(facts.parcel_tracking, /^off/);
  assert.ok(!/delivered 2026-09-12/.test(draft));
  const missing = JSON.parse(pack.missing);
  assert.ok(missing.some((m) => /Carrier name for tracking YT2624500012345/.test(m)));
  assert.ok(missing.some((m) => /Proof of delivery/.test(m)));
  assert.ok(missing.some((m) => /Tracking link/.test(m)));

  // Next hour: no AI hammering, but the draft is still reported.
  const r2 = await runChargebacks(env, { nowMs: live + 3600000, fetchImpl });
  assert.equal(r2.drafts.length, 1);
  assert.equal(r2.drafts[0].draft, "code");
  assert.equal(net.calls.filter((c) => c.kind === "claude-failed").length, 1);

  // 3 hours on: the AI is retried and now succeeds.
  claudeUp = true;
  const net2 = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [live1098(), won1001()] } }), emptyFor), claude: "Order #1098 shipped 2026-09-05, tracking YT2624500012345. [ADD: carrier proof of delivery]" });
  const r3 = await runChargebacks(env, { nowMs: live + 3 * 3600000 + 60000, fetchImpl: net2.fetchImpl });
  assert.equal(r3.drafts[0].draft, "claude");
  const st = await riskState(env, { nowMs: live + 4 * 3600000 });
  const open = st.disputes.open.find((d) => d.order === "#1098");
  assert.equal(open.evidence.draftBy, "claude");
  assert.match(open.evidence.draft, /YT2624500012345/);
  assert.match(open.evidence.submitted, /Reilly submits/);
  // Nothing was ever written to Shopify.
  assert.ok([...net.calls, ...net2.calls].filter((c) => c.kind === "shopify").every((c) => c.op === "RiskDisputes"));
});

/** Facts + draft for a #1098 variant, straight through the code path (no AI). */
async function draftFor(order) {
  const DB = makeD1();
  const n = live1098();
  const d = disputeFromNode({ ...n, order: { ...n.order, ...order } });
  const f = await gatherFacts(DB, "hc", { ...d, order_snapshot: JSON.stringify(d.order_snapshot) });
  return buildCodeDraft(f, missingEvidence(f)).draft;
}

test("review: an UNFULFILLED order's draft never claims a shipment; it asks for proof of shipment", async () => {
  const draft = await draftFor({ displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] });
  assert.ok(draft);
  assert.doesNotMatch(draft, /Shipped to|was shipped|delivered on/i);
  assert.match(draft, /Shopify shows no fulfillment for this order \(status UNFULFILLED\)/);
  assert.match(draft, /\[ADD: proof of shipment/);
});

test("review: a fulfilled order WITHOUT tracking doesn't claim a shipment; Shopify's deliveredAt is Shopify's word, not the carrier's", async () => {
  const noTrack = await draftFor({ fulfillments: [{ createdAt: "2026-09-05T10:00:00Z", displayStatus: "FULFILLED", deliveredAt: null, trackingInfo: [] }] });
  assert.doesNotMatch(noTrack, /Shipped to|was shipped/i);
  assert.match(noTrack, /Fulfilled in Shopify 2026-09-05: no tracking number \[ADD: proof of shipment/);
  assert.match(noTrack, /\[ADD: proof of shipment: Shopify has no fulfillment with a tracking number/);

  const delivered = await draftFor({ fulfillments: [{ createdAt: "2026-09-05T10:00:00Z", displayStatus: "DELIVERED", deliveredAt: "2026-09-12T15:00:00Z",
    trackingInfo: [{ number: "YT2624500012345", company: "YunExpress", url: "https://t.example/YT2624500012345" }] }] });
  assert.match(delivered, /Shopify shows it delivered on 2026-09-12/);
  assert.doesNotMatch(delivered, /carrier reports/i);
  assert.match(delivered, /\[ADD: the carrier's own proof of delivery\]/);
});

test("live #1098: when no order is linked the state says exactly what is missing instead of an empty list", async () => {
  const DB = makeD1();
  const net = fakeNet({ shopify: only("hc", () => ({ disputes: { nodes: [{ ...live1098(), order: null }] } }), emptyFor) });
  const r = await runChargebacks({ DB, ...CREDS }, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].draft, null);
  assert.match(r.drafts[0].blocked, /did not link an order/);
  const st = await riskState({ DB }, { nowMs: NOW });
  assert.match(st.disputes.open[0].evidence.blocked, /did not link an order/);
});

test("fix: redactPii removes emails, phones, street addresses and known names", () => {
  const s = redactPii("Jo Smith, 221 Baker Street, call +1 415-555-0100, jo@x.co, Springfield", ["Jo Smith", "Springfield"]);
  assert.ok(!/Smith|Baker|415|jo@x\.co|Springfield/.test(s), s);
});

test("fix: a HIGH order whose approval fails is NOT marked final; the next run raises it once", async () => {
  const base = makeD1();
  let failApprovals = true;
  const DB = {
    prepare(sql) {
      if (failApprovals && /INSERT INTO approvals/.test(sql)) throw new Error("approvals table busy");
      return base.prepare(sql);
    },
  };
  const high = orderNode(30, { risk: { recommendation: "CANCEL", assessments: [{ riskLevel: "HIGH", facts: [] }] } });
  const net = fakeNet({ shopify: only("hc", () => ({ orders: { nodes: [high] } }), emptyFor) });
  const env = { DB, ...CREDS };
  await runFraud(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  const row = await base.prepare(`SELECT * FROM risk_order_screens`).first();
  assert.ok(!row || row.final === 0, "must not be final without its approval");
  assert.equal((await evs(base, "risk.order_high")).length, 0);
  failApprovals = false;
  await runFraud(env, { nowMs: NOW + 3600000, fetchImpl: net.fetchImpl });
  await runFraud(env, { nowMs: NOW + 7200000, fetchImpl: net.fetchImpl });
  assert.equal((await listPending(base)).length, 1);
  assert.equal((await evs(base, "risk.order_high")).length, 1);
  const done = await base.prepare(`SELECT * FROM risk_order_screens`).first();
  assert.equal(done.final, 1);
  assert.ok(done.approval_id > 0);
});

test("fix: a partial health read keeps the last values and never lowers 'bad'; no false 'worse' alert after", async () => {
  // Pure merge: rates failed, account read fine → previous dispute rate and "bad" kept.
  const prev = { state: "bad", dispute_rate: 0.01, orders_90d: 400, disputes_90d: 4, disputes_at_least: 0, orders_precision: "EXACT", refund_rate: null,
    payments_activated: 1, payout_interval: "DAILY", failed_payouts: 0 };
  const read = { h: { payments_activated: 1, payout_interval: "DAILY", failed_payouts: 0, orders_90d: null, orders_precision: null,
    disputes_90d: null, disputes_at_least: 0, dispute_rate: null, refund_rate: null }, ratesOk: false, accountOk: true };
  const m = mergeHealth(read, prev);
  assert.equal(m.state, "bad");
  assert.equal(m.h.dispute_rate, 0.01);
  assert.equal(m.partial, true);

  // End to end: bad → (dispute read fails) → bad kept → (full read, still bad) → no second alert.
  const DB = makeD1();
  let ratesFail = false;
  const net = fakeNet({
    shopify: only("mar", (s, op) => {
      if (op === "RiskRates") {
        if (ratesFail) return { errors: [{ message: "Internal error. Looks like something went wrong on our end." }] };
        return { ordersCount: { count: 400, precision: "EXACT" }, disputes: { nodes: [1, 2, 3, 4].map((i) => ({ id: `d${i}`, status: "LOST" })), pageInfo: { hasNextPage: false } } };
      }
      return emptyFor(op);
    }, emptyFor),
  });
  const env = { DB, ...CREDS };
  await runAccountHealth(env, { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal((await DB.prepare(`SELECT state FROM risk_account_health WHERE store = 'mar'`).first()).state, "bad");
  ratesFail = true;
  await runAccountHealth(env, { nowMs: NOW + DAY, fetchImpl: net.fetchImpl });
  const mid = await DB.prepare(`SELECT * FROM risk_account_health WHERE store = 'mar'`).first();
  assert.equal(mid.state, "bad");
  assert.equal(mid.dispute_rate, 4 / 400);
  assert.equal(JSON.parse(mid.detail).partial, true);
  ratesFail = false;
  await runAccountHealth(env, { nowMs: NOW + 2 * DAY, fetchImpl: net.fetchImpl });
  assert.equal((await evs(DB, "risk.health_worse")).length, 1); // only the first time it went bad
});

/* ---------------- personal-details scan (routine audit, 2026-10-14) ---------------- */

test("personal details: Reilly's addresses, personal Gmail and 913 phone are matched; ordinary text is not", () => {
  const ids = (t) => scanText(t).map((h) => h.pattern).sort();
  assert.deepEqual(ids("Holt & Crane LLC, 12345 W 169th St, Olathe, KS 66062"), ["169th", "ks_zip", "olathe"]);
  assert.deepEqual(ids("Governed by the laws of Kansas."), ["kansas"]);
  assert.deepEqual(ids("Old office: Indian Creek Pkwy, Overland Park"), ["indian_creek", "overland_park"]);
  assert.deepEqual(ids("Questions? Email reillyworking26@gmail.com"), ["personal_gmail"]);
  assert.deepEqual(ids("Call us on (913) 555-0142 or +1 913.555.0142"), ["phone_913"]);
  assert.deepEqual(ids("Ships in 8-12 business days. Size 913 mm? Order #9130."), []);
  assert.deepEqual(ids("Contact info@holtandcrane.com"), []);
  const h = scanText("Our address: 12345 W 169th St, Olathe")[0];
  assert.match(h.excerpt, /169th/);
});

test("personal details: the weekly read flags theme, product, policy and settings text (high), clears what's fixed, and settings it can't read are not wired", async () => {
  const DB = makeD1();
  let policyBody = "<p>These terms are governed by the laws of Kansas.</p>";
  let contact = "reillyworking26@gmail.com";
  const sf = () => ({
    themes: { nodes: [{ id: "t", name: "Dawn", files: { nodes: [{ filename: "sections/footer-group.json", body: { content: `{"s":{"x":{"settings":{"text":"Call (913) 555-0142"}}}}` } }] } }] },
    products: { nodes: [{ id: "p", title: "Blazer", handle: "blazer", description: "<p>Shipped from Olathe.</p>" }] },
  });
  const net = fakeNet({
    shopify: (s, op) => op === "RiskPolicies" ? { shop: { shopPolicies: [{ type: "TERMS_OF_SERVICE", title: "Terms", body: policyBody }] } }
      : op === "RiskShopSettings" ? { shop: { name: "H&C", contactEmail: contact, billingAddress: { address1: "1 Main St", city: "Austin", province: "Texas", zip: "73301", country: "US" } } }
      : sf(),
  });
  const env = { DB, ...CREDS };
  const a = await collectStore(env, "hc", { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.equal(a.personal.found, 4);
  const open = (await DB.prepare(`SELECT source, pattern, severity FROM risk_personal_hits WHERE cleared_at IS NULL ORDER BY source`).all()).results;
  assert.deepEqual(open.map((r) => `${r.source}|${r.pattern}`), [
    "policy:terms_of_service|kansas", "product:blazer|olathe", "settings:contact_email|personal_gmail", "theme:sections/footer-group.json|phone_913",
  ]);
  assert.ok(open.every((r) => r.severity === "high"));
  assert.equal((await evs(DB, "risk.personal_details")).length, 1);
  // Reilly fixes the policy and the contact email: those close on the next read; nothing new is announced.
  policyBody = "<p>These terms are governed by the laws of Delaware.</p>";
  contact = "info@holtandcrane.com";
  await collectStore(env, "hc", { nowMs: NOW + 7 * DAY, fetchImpl: net.fetchImpl });
  const still = (await DB.prepare(`SELECT pattern FROM risk_personal_hits WHERE cleared_at IS NULL ORDER BY pattern`).all()).results.map((r) => r.pattern);
  assert.deepEqual(still, ["olathe", "phone_913"]);
  assert.equal((await evs(DB, "risk.personal_details")).length, 1);
  const st = await riskState(env, { nowMs: NOW + 7 * DAY });
  assert.equal(st.claims.personal_details.length, 2);
});

test("personal details: settings Shopify refuses are noted as not wired, and their old hits are NOT cleared (unknown is not clean)", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO risk_personal_hits (store, source, pattern, label, excerpt, found_at, last_seen_at) VALUES ('hc', 'settings:contact_email', 'personal_gmail', 'g', 'x', 't', 't')`).run();
  const net = fakeNet({
    shopify: (s, op) => op === "RiskShopSettings" ? { errors: [{ message: "Access denied for billingAddress field. Required access: `read_shop` scope." }] }
      : op === "RiskPolicies" ? { shop: { shopPolicies: [] } }
      : { themes: { nodes: [] }, products: { nodes: [] } },
  });
  const r = await collectStore({ DB, ...CREDS }, "hc", { nowMs: NOW, fetchImpl: net.fetchImpl });
  assert.ok(r.notes.some((n) => /contact settings not readable/.test(n)));
  assert.equal((await DB.prepare(`SELECT cleared_at FROM risk_personal_hits`).first()).cleared_at, null);
});

test("personal details: 913 phones in every common form, E.164 included; never inside a longer number", () => {
  const ph = (t) => scanText(t).some((h) => h.pattern === "phone_913");
  for (const t of ["+19135551234", "(913) 592-9849", "9132163296", "+1 (913) 592-9849", "1-913-555-1234", "913.555.1234"]) assert.equal(ph(t), true, t);
  for (const t of ["49135551234", "91355512345", "SKU 913-55", "order 2913555123"]) assert.equal(ph(t), false, t);
});

test("personal details: a product hit is cleared only when THAT product was re-read (the run reads 20 products, not all)", async () => {
  const DB = makeD1();
  let products = [{ id: "p1", title: "A", handle: "coat", description: "<p>Made in Olathe.</p>" }];
  const net = fakeNet({
    shopify: (s, op) => op === "RiskPolicies" ? { shop: { shopPolicies: [] } }
      : op === "RiskShopSettings" ? { shop: { name: "H&C", contactEmail: "info@holtandcrane.com" } }
      : { themes: { nodes: [] }, products: { nodes: products } },
  });
  const env = { DB, ...CREDS };
  await collectStore(env, "hc", { nowMs: NOW, fetchImpl: net.fetchImpl });
  const open = async () => (await DB.prepare(`SELECT source FROM risk_personal_hits WHERE cleared_at IS NULL`).all()).results.map((r) => r.source);
  assert.deepEqual(await open(), ["product:coat"]);
  // Next week "coat" isn't among the 20 most recently updated products: unknown, NOT cleared.
  products = [{ id: "p2", title: "B", handle: "scarf", description: "<p>Soft wool.</p>" }];
  await collectStore(env, "hc", { nowMs: NOW + 7 * DAY, fetchImpl: net.fetchImpl });
  assert.deepEqual(await open(), ["product:coat"]);
  // Re-read and fixed: cleared.
  products = [{ id: "p1", title: "A", handle: "coat", description: "<p>Made with care.</p>" }];
  await collectStore(env, "hc", { nowMs: NOW + 14 * DAY, fetchImpl: net.fetchImpl });
  assert.deepEqual(await open(), []);
});
