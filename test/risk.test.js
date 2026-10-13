import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { runRisk, riskState, RISK_JOBS } from "../src/agents/risk/index.js";
import { runChargebacks, reminderDue, approvalTitle, missingEvidence, gatherFacts } from "../src/agents/risk/chargebacks.js";
import { runFraud, screenOrder, shopifyLevel } from "../src/agents/risk/fraud.js";
import { runAccountHealth, judgeHealth } from "../src/agents/risk/accountHealth.js";
import { collectStore, classifyPending, claimSnippets, themeStrings } from "../src/agents/risk/claimsAudit.js";
import { daysLeft } from "../src/agents/risk/shared.js";
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
  RiskAccount: { shopifyPaymentsAccount: { activated: true, onboardable: false, payoutSchedule: { interval: "DAILY" }, payouts: { nodes: [] } } },
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
  assert.match(pend[0].title, /18 days left/);
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

test("chargebacks: approval title says OVERDUE / TODAY plainly", () => {
  const d = { order_name: "#1", amount: 10, currency: "USD", evidence_due_by: "2026-10-13", type: "CHARGEBACK" };
  assert.match(approvalTitle("hc", d, NOW), /due TODAY/);
  assert.match(approvalTitle("hc", { ...d, evidence_due_by: "2026-10-10" }, NOW), /3 days OVERDUE/);
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
