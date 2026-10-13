import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { up95, down95, targetPrice, planVariantPrice, compareAtFor, tierOf, badgePct } from "../src/agents/supplier/pricing.js";
import { importQuotes, runQuoteDesk, validateQuoteRow, planProduct, PRODUCTS_BY_HANDLE_QUERY } from "../src/agents/supplier/quotes.js";
import { recommendSize, runSizeChecker, complaintShift, chartFromRows, garmentOf } from "../src/agents/supplier/sizeChecker.js";
import { runSimilarQc, recordSimilarOffer, judgeSimilar } from "../src/agents/supplier/similarQc.js";
import { runPreflight, preflightProduct } from "../src/agents/supplier/preflight.js";
import { addCredit, runClaims, creditAging, markCredited } from "../src/agents/supplier/claims.js";
import { runDigest, digestData, digestBody, importBills } from "../src/agents/supplier/digest.js";
import { runScout } from "../src/agents/supplier/scout.js";
import { ensureSupplierDecisions, SUPPLIER_DECISIONS } from "../src/agents/supplier/decisions.js";
import { runSupplier, supplierState } from "../src/agents/supplier/index.js";
import { listPending } from "../src/lib/approvals.js";
import { _resetTokenCacheForTests } from "../src/lib/storeGuard.js";

beforeEach(() => _resetTokenCacheForTests());

const NOW = Date.parse("2026-10-13T16:00:00Z"); // 12:00 Eastern
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const HC_CREDS = { SB_HC_CLIENT_ID: "id", SB_HC_CLIENT_SECRET: "s" };
const MAR_CREDS = { SB_MAR_CLIENT_ID: "id", SB_MAR_CLIENT_SECRET: "s" };

/* ------------------------------------------------------------ fake Shopify (read-only) */

function fakeShopify(productsByDomain) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const domain = new URL(url).host;
    const handles = [...body.variables.q.matchAll(/handle:([a-z0-9-]+)/g)].map((m) => m[1]);
    const nodes = (productsByDomain[domain] || []).filter((p) => handles.includes(p.handle));
    return Response.json({ data: { products: { nodes } } });
  };
  return { fetchImpl, calls };
}

const product = (handle, { price = "49.95", compareAt = null, status = "ACTIVE", title = handle, productType = "Sweaters", variants = null } = {}) => ({
  id: `gid://shopify/Product/${handle}`, handle, title, status, productType,
  variants: { nodes: variants || [{ id: `gid://shopify/ProductVariant/${handle}-1`, title: "M", price, compareAtPrice: compareAt }] },
});

/* ------------------------------------------------------------ pricing */

test("pricing: .95 rounding helpers", () => {
  assert.equal(up95(40), 40.95);
  assert.equal(up95(44.95), 44.95);
  assert.equal(up95(45), 45.95);
  assert.equal(down95(45), 44.95);
  assert.equal(down95(44.94), 43.95);
});

test("pricing: Marlowe target = min(max(up95(cost/0.29), 49.95), 144.95)", () => {
  assert.equal(targetPrice("mar", 20).price, 69.95); // 20/0.29 = 68.97 → 69.95
  assert.equal(targetPrice("mar", 10).price, 49.95); // floor
  const c = targetPrice("mar", 50);
  assert.equal(c.price, 144.95);
  assert.equal(c.limitedBy, "ceiling");
  assert.equal(c.waiverPrice, 172.95, "the proposal says what band needs; never waives itself");
});

test("pricing: H&C directional (raise above 33%, cut below 29%, leave in band) with the $44.95 floor", () => {
  assert.equal(targetPrice("hc", 20, 49.95).price, 60.95); // 40% → cheapest .95 at ≤33%
  assert.equal(targetPrice("hc", 20, 79.95).price, 68.95); // 25% → dearest .95 at ≥29%
  assert.equal(targetPrice("hc", 20, 64.95).price, 64.95); // 30.8% in band
  assert.equal(targetPrice("hc", 10, 39.95).price, 44.95); // band wants less, floor wins
  assert.equal(targetPrice("aub", 10).price, 44.95);
});

test("pricing: compare-at keeps the product's tier and prints the exact badge on H&C", () => {
  assert.equal(tierOf(49.95, null), 0);
  assert.equal(tierOf(49.95, 62.95), 20);
  const p = planVariantPrice("hc", { costUsd: 20, price: 49.95, compareAt: 62.95 });
  assert.equal(p.newPrice, 60.95);
  assert.equal(p.tier, 20);
  assert.equal(badgePct("hc", p.newPrice, p.newCompareAt), 20);
  assert.match(String(p.newCompareAt), /\.(95|5)$/);
  const none = planVariantPrice("hc", { costUsd: 20, price: 49.95, compareAt: null });
  assert.equal(none.newCompareAt, null, "tier 0 stays without a compare-at");
  const unchanged = planVariantPrice("hc", { costUsd: 20, price: 64.95, compareAt: 80.95 });
  assert.equal(unchanged.change, false);
  for (const tier of [10, 20, 30, 40]) {
    const c = compareAtFor("hc", 59.95, tier);
    assert.equal(c.printed, tier, `tier ${tier}`);
  }
});

/* ------------------------------------------------------------ import */

test("importQuotes: validates, maps KFB shop codes and links, ignores duplicates", async () => {
  const DB = makeD1();
  const rows = [
    { store: "hc", link: "https://holtandcrane.com/products/navy-cardigan?variant=1", status: 30, cost: "€17.50", quoted_at: "2026-10-12" },
    { Store: "806080-g8", handle: "oxford-shirt", Status: "denied", quoted_at: "2026-10-12", remark: "out of stock" },
    { store: "hc", link: "https://holtandcrane.com/products/navy-cardigan?variant=1", status: 30, cost: "17.50", quoted_at: "2026-10-12" },
    { store: "hc", title: "Navy Cardigan", status: 30, cost: 10, quoted_at: "2026-10-12" },
    { store: "hc", handle: "x", status: "quoted", quoted_at: "2026-10-12" },
    { store: "tund", handle: "x", status: 30, cost: 5, quoted_at: "2026-10-12" },
    { store: "hc", handle: "x", status: 99, cost: 5, quoted_at: "nope" },
  ];
  const r = await importQuotes(DB, rows, { nowMs: NOW });
  assert.equal(r.inserted, 2);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rejected.length, 4);
  const q = await DB.prepare(`SELECT * FROM kfb_quotes ORDER BY id`).all();
  assert.equal(q.results[0].product_handle, "navy-cardigan");
  assert.equal(q.results[0].cost, 17.5);
  assert.equal(q.results[0].currency, "EUR");
  assert.equal(q.results[1].store, "mar");
  assert.equal(q.results[1].status, "denied");
  assert.match(r.rejected.find((x) => x.row === 3).reason, /handle/);
  assert.equal(validateQuoteRow({ store: "hc", handle: "a", status: "only similar", quoted_at: "2026-10-12" }).reason, 'unknown status "only similar"');
  assert.equal(validateQuoteRow({ store: "hc", handle: "a", status: 30, cost: 9, quoted_at: "2026-10-12", remark: "only similar ones" }).similar, true);
});

/* ------------------------------------------------------------ Quote Desk + Denial Sync */

async function seedQuotes(DB) {
  await importQuotes(DB, [
    { store: "hc", handle: "navy-cardigan", status: 30, cost: 17.09, currency: "EUR", quoted_at: "2026-10-12T10:00:00Z" }, // 20.00 USD
    { store: "hc", handle: "grey-crew", status: 30, cost: 20, currency: "USD", quoted_at: "2026-10-12T10:00:00Z", remark: "only similar ones" },
    { store: "hc", handle: "in-band", status: 30, cost: 20, currency: "USD", quoted_at: "2026-10-12T10:00:00Z" },
    { store: "hc", handle: "wool-coat", status: 30, cost: 50, currency: "USD", quoted_at: "2026-10-12T10:00:00Z" },
    { store: "hc", handle: "dead-shirt", status: 26, quoted_at: "2026-10-12T10:00:00Z", remark: "factory closed" },
    { store: "hc", handle: "gone-tee", status: 26, quoted_at: "2026-10-12T10:00:00Z" },
    { store: "hc", handle: "not-in-store", status: 30, cost: 9, currency: "USD", quoted_at: "2026-10-12T10:00:00Z" },
    { store: "hc", handle: "navy-cardigan", status: 30, cost: 30, currency: "USD", quoted_at: "2026-10-01T10:00:00Z" }, // older: superseded
  ], { nowMs: NOW });
}

const HC_PRODUCTS = {
  "jmzjx1-it.myshopify.com": [
    product("navy-cardigan", { price: "49.95", compareAt: "62.95" }),
    product("grey-crew", { price: "49.95" }),
    product("in-band", { price: "64.95" }),
    product("wool-coat", { price: "114.95", title: "Wool Overcoat", productType: "Outerwear" }),
    product("dead-shirt", { title: "Dead Shirt" }),
    product("gone-tee", { status: "DRAFT" }),
  ],
};

test("Quote Desk: one batched approval per store (reprice + draft), plans stored, nothing written to Shopify", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  const { fetchImpl, calls } = fakeShopify(HC_PRODUCTS);
  const env = { DB, ...HC_CREDS };
  const res = await runQuoteDesk(env, { nowMs: NOW, fetchImpl });
  const hc = res.find((r) => r.store === "hc");
  assert.ok(hc.batchId);

  // Shadow: only the read query; never a mutation.
  assert.equal(calls.length, 1);
  for (const c of calls) {
    assert.equal(c.body.query, PRODUCTS_BY_HANDLE_QUERY);
    assert.doesNotMatch(c.body.query, /mutation/i);
  }

  const pending = await listPending(DB);
  assert.equal(pending.length, 1, "exactly one approval for the store's batch");
  assert.equal(pending[0].store, "hc");
  assert.match(pending[0].title, /Holt & Crane: Reprice 2 · draft 1/);
  assert.deepEqual(pending[0].options.map((o) => o.id), ["approve_all", "reprice_only", "drafts_only"]);
  assert.match(pending[0].options[0].detail, /\$49\.95 → \$60\.95/);

  const { results: plans } = await DB.prepare(`SELECT * FROM supplier_plans ORDER BY id`).all();
  const by = Object.fromEntries(plans.map((p) => [p.product_handle, p]));
  assert.equal(by["navy-cardigan"].kind, "reprice");
  assert.equal(by["navy-cardigan"].new_price, 60.95);
  assert.equal(badgePct("hc", 60.95, by["navy-cardigan"].new_compare_at), 20, "keeps its 20% tier");
  assert.match(by["navy-cardigan"].notes, /estimate/, "EUR conversion is flagged as an estimate");
  assert.equal(by["grey-crew"].kind, "reprice", "similar quotes priced like exact matches");
  assert.match(by["grey-crew"].notes, /q4 always fine/);
  assert.equal(by["in-band"].kind, "no_change");
  assert.equal(by["wool-coat"].kind, "held", "H&C outerwear at $114.95 is held (Reilly 09-01)");
  assert.equal(by["dead-shirt"].kind, "draft");
  assert.match(by["dead-shirt"].reason, /factory closed/);
  assert.equal(by["gone-tee"].kind, "already_off");
  assert.equal(by["not-in-store"].kind, "unmatched");

  const open = await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_quotes WHERE processed_at IS NULL`).first();
  assert.equal(open.n, 0);
  const sup = await DB.prepare(`SELECT outcome FROM kfb_quotes WHERE cost = 30`).first();
  assert.equal(sup.outcome, "superseded");

  const ev = await DB.prepare(`SELECT actor, kind FROM events WHERE actor IN ('sup.quote_desk','sup.denial_sync')`).all();
  assert.ok(ev.results.some((e) => e.kind === "quotes.planned"));
  assert.ok(ev.results.some((e) => e.actor === "sup.denial_sync" && e.kind === "denials.planned"));
});

test("Quote Desk: new quotes wait while the store's batch is still pending (no second approval)", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  const { fetchImpl, calls } = fakeShopify(HC_PRODUCTS);
  const env = { DB, ...HC_CREDS };
  await runQuoteDesk(env, { nowMs: NOW, fetchImpl });
  await importQuotes(DB, [{ store: "hc", handle: "grey-crew", status: 30, cost: 25, currency: "USD", quoted_at: "2026-10-13T10:00:00Z" }], { nowMs: NOW });
  const r2 = await runQuoteDesk(env, { nowMs: NOW + 3600000, fetchImpl });
  assert.match(r2.find((r) => r.store === "hc").waiting, /waiting on Reilly/);
  assert.equal((await listPending(DB)).length, 1);
  assert.equal(calls.length, 1, "no Shopify read while waiting");
});

test("Quote Desk: store not wired → skipped, quotes stay open, no approval", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  let fetched = 0;
  const res = await runQuoteDesk({ DB }, { nowMs: NOW, fetchImpl: async () => { fetched++; throw new Error("no network in tests"); } });
  assert.match(res.find((r) => r.store === "hc").skipped, /not wired/);
  assert.equal(fetched, 0);
  assert.equal((await listPending(DB)).length, 0);
  const open = await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_quotes WHERE processed_at IS NULL`).first();
  assert.equal(open.n, 8);
});

test("Quote Desk: ceiling-limited products offer the waiver as a separate option", async () => {
  const DB = makeD1();
  await importQuotes(DB, [{ store: "mar", handle: "big-coat", status: 30, cost: 50, currency: "USD", quoted_at: "2026-10-12" }], { nowMs: NOW });
  const { fetchImpl } = fakeShopify({ "806080-g8.myshopify.com": [product("big-coat", { price: "99.95" })] });
  await runQuoteDesk({ DB, ...MAR_CREDS }, { nowMs: NOW, fetchImpl });
  const [ap] = await listPending(DB);
  assert.deepEqual(ap.options.map((o) => o.id), ["approve_all", "approve_all_waive_ceiling"]);
  assert.match(ap.options[1].detail, /\$172\.95/);
});

test("planProduct: a hold is not re-proposed unless the cost changed", () => {
  const q = [{ id: 1, variant_id: "", status: "quoted", cost: 50, currency: "USD", similar: 0 }];
  const p = product("blazer", { price: "99.95" });
  assert.equal(planProduct("hc", "blazer", q, p, { held_price: 99.95, cost_at_hold: 50 }).kind, "held");
  assert.equal(planProduct("hc", "blazer", q, p, { held_price: 99.95, cost_at_hold: 40 }).kind, "reprice");
});

/* ------------------------------------------------------------ Size Checker */

const SMALL_CHART = [ // a Chinese chart that runs ~one size small
  { size_label: "M", measurements: { chest: 104, length: 68, shoulder: 44 } },
  { size_label: "L", measurements: { chest: 112, length: 70, shoulder: 46 } },
  { size_label: "XL", measurements: { chest: 120, length: 72, shoulder: 48 } },
  { size_label: "XXL", measurements: { chest: 128, length: 74, shoulder: 50 } },
];

test("Size Checker: Chinese M that is really a US S → send a Chinese L", () => {
  const r = recommendSize({ title: "Shawl Collar Cardigan", orderedSize: "M", chartRows: SMALL_CHART });
  assert.equal(r.verdict, "size_up");
  assert.equal(r.send_size, "L");
  assert.match(r.reason, /Chinese M chest 104cm ≈ US S/);
});

test("Size Checker: true to size ships as ordered; disagreement states the conflict", () => {
  const true2size = [{ size_label: "M", measurements: { chest: 112, length: 72 } }, { size_label: "L", measurements: { chest: 122, length: 74 } }];
  assert.equal(recommendSize({ title: "Merino Sweater", orderedSize: "Medium", chartRows: true2size }).verdict, "as_ordered");
  const conflict = [{ size_label: "M", measurements: { chest: 112, length: 66 } }, { size_label: "L", measurements: { chest: 122, length: 71 } }];
  const r = recommendSize({ title: "Merino Sweater", orderedSize: "M", chartRows: conflict });
  assert.equal(r.send_size, "L");
  assert.equal(r.conflict, true);
  assert.match(r.reason, /chest says M, length says L/);
});

test("Size Checker: never above the factory's largest; no chart means no guess", () => {
  const r = recommendSize({ title: "Cardigan", orderedSize: "2XL", chartRows: SMALL_CHART });
  assert.equal(r.verdict, "no_fit");
  assert.equal(r.send_size, null);
  assert.match(r.reason, /customer message/i);
  assert.equal(recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: [] }).verdict, "no_chart");
  assert.equal(recommendSize({ title: "Slim Chinos", orderedSize: "32", chartRows: SMALL_CHART }).verdict, "no_reference");
  assert.equal(recommendSize({ title: "Women's Cardigan", orderedSize: "M", chartRows: SMALL_CHART }).verdict, "no_reference");
});

test("Size Checker: complaints size up even when the chart looks fine; complaints alone are labelled", () => {
  const fine = [{ size_label: "M", measurements: { chest: 112, length: 72 } }, { size_label: "L", measurements: { chest: 122, length: 74 } }, { size_label: "XL", measurements: { chest: 132, length: 76 } }];
  const complaints = [{ size_ordered: "M", size_that_fits: "L" }, { said: "way too small" }];
  assert.equal(complaintShift(complaints), 1);
  const r = recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: fine, complaints });
  assert.equal(r.send_size, "L");
  assert.match(r.reason, /complaint/);
  const only = recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: [], complaints });
  assert.equal(only.verdict, "complaints_only");
  assert.equal(only.send_size, "L");
  assert.match(only.reason, /largest size unknown/);
});

test("Size Checker: flat chest measurements are doubled; garment types", () => {
  const { chart, notes } = chartFromRows([{ size_label: "L", measurements: JSON.stringify({ chest: 56 }) }]);
  assert.equal(chart.L.chest, 112);
  assert.equal(notes.length, 1);
  assert.equal(garmentOf("Wool Blazer"), "jacket");
  assert.equal(garmentOf("Cable Knit Cardigan"), "sweater");
  assert.equal(garmentOf("Linen Shirt"), "shirt");
});

async function seedOrder(DB, { store = "hc", n, product = "p1", handle = "shawl-cardigan", title = "Shawl Collar Cardigan", size = "M", createdMs = NOW - 3600000, status = "paid" }) {
  await DB.prepare(`INSERT INTO orders (store, order_id, name, created_at, local_day, total, financial_status, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(store, `gid://shopify/Order/${n}`, `#${n}`, iso(createdMs), "2026-10-13", 60, status, iso(NOW)).run();
  await DB.prepare(`INSERT INTO order_lines (store, order_id, line_id, product_id, product_handle, title, variant_title, size, quantity, price, updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,60,?)`).bind(store, `gid://shopify/Order/${n}`, `gid://shopify/LineItem/${n}`, `gid://shopify/Product/${product}`,
    handle, title, `Navy / ${size}`, size, iso(NOW)).run();
}

async function seedChart(DB, product = "p1", rows = SMALL_CHART, verified = 1) {
  for (const r of rows) {
    await DB.prepare(`INSERT INTO size_charts (store, product_id, size_label, measurements, source, verified) VALUES ('hc', ?, ?, ?, 'test', ?)`)
      .bind(`gid://shopify/Product/${product}`, r.size_label, JSON.stringify(r.measurements), verified).run();
  }
}

test("Size Checker run: records recommendations and one KFB ask per line, idempotent", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 1201 });
  await seedOrder(DB, { n: 1202, product: "p2", handle: "no-chart", title: "Plain Sweater" });
  await seedOrder(DB, { n: 1203, status: "refunded" });
  await seedChart(DB, "p1", SMALL_CHART, 0);
  const r = await runSizeChecker({ DB }, { nowMs: NOW });
  assert.equal(r.checked, 2);
  const asks = (await DB.prepare(`SELECT * FROM kfb_size_asks`).all()).results;
  assert.equal(asks.length, 1);
  assert.equal(asks[0].order_name, "#1201");
  assert.equal(asks[0].ordered_size, "M");
  assert.equal(asks[0].send_size, "L");
  const rec = await DB.prepare(`SELECT * FROM size_recommendations WHERE order_id = 'gid://shopify/Order/1201'`).first();
  assert.match(rec.reason, /not yet checked/);
  assert.match(rec.reason, /audience assumed men's/);
  const nc = await DB.prepare(`SELECT verdict FROM size_recommendations WHERE order_id = 'gid://shopify/Order/1202'`).first();
  assert.equal(nc.verdict, "no_chart");

  const again = await runSizeChecker({ DB }, { nowMs: NOW + 15 * 60000 });
  assert.equal(again.checked, 0, "decided lines aren't re-done; no-chart lines wait 6h for a re-check");
  // A chart arrives for p2; after the re-check window the line is decided.
  await seedChart(DB, "p2", [{ size_label: "M", measurements: { chest: 112, length: 72 } }]);
  const later = await runSizeChecker({ DB }, { nowMs: NOW + 7 * 3600000 });
  assert.equal(later.checked, 1);
  assert.equal((await DB.prepare(`SELECT verdict FROM size_recommendations WHERE order_id = 'gid://shopify/Order/1202'`).first()).verdict, "as_ordered");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_size_asks`).first()).n, 1);
});

/* ------------------------------------------------------------ Similar QC */

test("Similar QC: quotes accepted per 'q4 always fine'; a customer's order is flagged, never accepted", async () => {
  const DB = makeD1();
  assert.equal(judgeSimilar({ context: "quote" }).verdict, "accepted");
  await recordSimilarOffer(DB, { store: "hc", context: "quote", handle: "a", remark: "only similar ones" }, { nowMs: NOW });
  await recordSimilarOffer(DB, { store: "hc", context: "order", order_name: "#1210", remark: "similar colour" }, { nowMs: NOW });
  await assert.rejects(recordSimilarOffer(DB, { store: "tund", context: "quote" }));
  const r = await runSimilarQc({ DB }, { nowMs: NOW });
  assert.deepEqual([r.accepted, r.flagged], [1, 1]);
  const again = await runSimilarQc({ DB }, { nowMs: NOW });
  assert.equal(again.judged, 0);
});

/* ------------------------------------------------------------ Pre-flight */

test("Pre-flight: denied products and size complaints flagged once; 'no quote' only once quotes are wired", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 1301, handle: "dead-shirt", title: "Dead Shirt", product: "d1" });
  await seedOrder(DB, { n: 1302, handle: "other", title: "Other", product: "o1" });
  let r = await runPreflight({ DB }, { nowMs: NOW });
  assert.equal(r.added, 0, "no quotes wired: no 'no quote' noise");

  await importQuotes(DB, [{ store: "hc", handle: "dead-shirt", status: 26, quoted_at: "2026-10-12", remark: "factory closed" }], { nowMs: NOW });
  await DB.prepare(`INSERT INTO size_complaints (store, product_id, size_ordered, size_that_fits, at) VALUES ('hc','gid://shopify/Product/o1','M','L',?)`).bind(iso(NOW)).run();
  r = await runPreflight({ DB }, { nowMs: NOW });
  const { results } = await DB.prepare(`SELECT order_name, kind FROM supply_flags ORDER BY order_name, kind`).all();
  assert.deepEqual(results.map((x) => `${x.order_name}:${x.kind}`), ["#1301:denied", "#1301:no_quote", "#1302:no_quote", "#1302:size_complaints"]);
  r = await runPreflight({ DB }, { nowMs: NOW + 3600000 });
  assert.equal(r.added, 0, "never repeated");

  const gate = await preflightProduct(DB, "hc", "dead-shirt");
  assert.equal(gate.ok, false);
  await importQuotes(DB, [{ store: "hc", handle: "good", status: 30, cost: 10, quoted_at: "2026-10-12" }], { nowMs: NOW });
  assert.equal((await preflightProduct(DB, "hc", "good")).ok, true);
  assert.equal((await preflightProduct(DB, "hc", "good", { price: 179.95 })).ok, false);
});

/* ------------------------------------------------------------ Claims */

test("Claims: credits only (no returns), unknown amounts stay null, overdue flagged once a week", async () => {
  const DB = makeD1();
  await assert.rejects(addCredit(DB, { store: "hc", kind: "return", order_name: "#1174" }), /never returns/);
  const id = await addCredit(DB, { store: "hc", kind: "cancelled_billed", order_name: "#1174", amount: 18.15, currency: "EUR", opened_at: iso(NOW - 20 * DAY) }, { nowMs: NOW });
  await addCredit(DB, { store: "hc", kind: "missing_item", order_name: "#1180", opened_at: iso(NOW - 2 * DAY) }, { nowMs: NOW });
  const { results } = await DB.prepare(`SELECT * FROM kfb_credits`).all();
  const aging = creditAging(results, NOW);
  assert.deepEqual(aging.totals, { EUR: 18.15 });
  assert.equal(aging.unknownAmount, 1);
  assert.equal(aging.buckets["15-30"], 1);
  assert.equal((await runClaims({ DB }, { nowMs: NOW })).flagged, 1);
  assert.equal((await runClaims({ DB }, { nowMs: NOW + DAY })).flagged, 0);
  assert.equal((await runClaims({ DB }, { nowMs: NOW + 8 * DAY })).flagged, 1);
  assert.equal(await markCredited(DB, id, { creditRef: "bill-9" }), true);
});

/* ------------------------------------------------------------ Digest */

test("Digest: says 'waiting on KFB session' (never zero) and is written once per day after 07:00 ET", async () => {
  const DB = makeD1();
  const early = Date.parse("2026-10-13T10:30:00Z"); // 06:30 ET
  assert.match((await runDigest({ DB }, { nowMs: early })).skipped, /before/);
  const d = await runDigest({ DB }, { nowMs: NOW });
  assert.match(d.body, /waiting on KFB session/);
  assert.match(d.body, /Bills: waiting on KFB session/);
  assert.match((await runDigest({ DB }, { nowMs: NOW + 900000 })).skipped, /already/);

  await importBills(DB, [{ bill_id: "b1", amount: 120.5, currency: "EUR", billed_at: iso(NOW - 2 * DAY) }, { bill_id: "b2", amount: 10, billed_at: iso(NOW - DAY), paid_at: iso(NOW) }], { nowMs: NOW });
  const body = digestBody(await digestData(DB, NOW));
  assert.match(body, /1 unpaid bill, EUR 120\.50, oldest 2 days/);
});

/* ------------------------------------------------------------ Scout */

test("Scout: flags a category only after 3+ denials, once per growth", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO supplier_batches (store, created_at, prices_read_at, status) VALUES ('hc', ?, ?, 'awaiting_approval')`).bind(iso(NOW), iso(NOW)).run();
  for (const h of ["a", "b", "c"]) {
    await DB.prepare(`INSERT INTO supplier_plans (batch_id, store, kind, product_handle, product_type, created_at) VALUES (1,'hc','draft',?,'Cardigans',?)`).bind(h, iso(NOW)).run();
  }
  assert.equal((await runScout({ DB }, { nowMs: NOW })).raised, 1);
  assert.equal((await runScout({ DB }, { nowMs: NOW + DAY })).raised, 0);
});

/* ------------------------------------------------------------ decisions, cron, state */

test("Reilly's supplier decisions are recorded verbatim, once", async () => {
  const DB = makeD1();
  await ensureSupplierDecisions(DB, { nowMs: NOW });
  await ensureSupplierDecisions(DB, { nowMs: NOW });
  const { results } = await DB.prepare(`SELECT topic, words FROM decisions`).all();
  assert.equal(results.length, SUPPLIER_DECISIONS.length);
  assert.ok(results.some((r) => r.words === "q4 always fine"));
  assert.ok(results.some((r) => r.words === "i never return things to KFB."));
});

test("runSupplier: throttled, never throws, no network when nothing needs Shopify; state reports waiting on KFB", async () => {
  const DB = makeD1();
  let fetched = 0;
  const fetchImpl = async () => { fetched++; throw new Error("no network"); };
  const boom = { job: "sup.boom", everyMin: 15, actor: "sup.scout", run: async () => { throw new Error("kaboom"); } };
  const out = await runSupplier({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl });
  assert.ok(out["sup.quote_desk"]);
  assert.equal(fetched, 0, "no quotes → no Shopify call");
  const again = await runSupplier({ DB, ...HC_CREDS }, { nowMs: NOW + 60000, fetchImpl });
  assert.equal(again["sup.quote_desk"], "not due");
  assert.equal(again["sup.size_charts"], "not due");

  const b = await runSupplier({ DB }, { nowMs: NOW, jobs: [boom] });
  assert.match(b["sup.boom"].error, /kaboom/);
  await runSupplier({ DB }, { nowMs: NOW + 16 * 60000, jobs: [boom] });
  const errs = await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'error.supplier'`).first();
  assert.equal(errs.n, 1, "errors logged at most once an hour");

  const s = await supplierState({ DB }, { nowMs: NOW });
  assert.equal(s.mode, "shadow");
  assert.match(s.kfbSession.status, /waiting on KFB session/);
  assert.equal(s.agents["sup.quote_desk"].quotes, null, "not wired is null, not zero");
  assert.equal(s.bills, null);
  assert.ok(s.agents["sup.digest"].latest, "digest written by the 12:00 ET run");
  assert.ok(JSON.stringify(s).length < 200000);
});

test("supplierState lists the batch plans for the page", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  const { fetchImpl } = fakeShopify(HC_PRODUCTS);
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl });
  const s = await supplierState({ DB }, { nowMs: NOW });
  const b = s.agents["sup.quote_desk"].batches[0];
  assert.equal(b.approvalStatus, "pending");
  assert.equal(b.plans[0].kind, "reprice");
  assert.equal(s.agents["sup.denial_sync"].draftsWaiting, 1);
});
