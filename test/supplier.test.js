import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";

import { up95, down95, planVariantPrice, compareAtFor, tierOf, badgePct } from "../src/agents/supplier/pricing.js";
import { importQuotes, runQuoteDesk, validateQuoteRow, STATUS_LABELS, planProduct, PRODUCTS_BY_HANDLE_QUERY, VARIANT_PAGE_QUERY, settleBatches, writeQuoteCost } from "../src/agents/supplier/quotes.js";
import { recommendSize, runSizeChecker, complaintShift, chartFromRows, garmentOf, listedSizes, coreSizing, productAudience } from "../src/agents/supplier/sizeChecker.js";
import { runSimilarQc, recordSimilarOffer, judgeSimilar } from "../src/agents/supplier/similarQc.js";
import { runPreflight, preflightProduct } from "../src/agents/supplier/preflight.js";
import { addCredit, runClaims, creditAging, markCredited } from "../src/agents/supplier/claims.js";
import { runDigest, digestData, digestBody, importBills } from "../src/agents/supplier/digest.js";
import { runScout } from "../src/agents/supplier/scout.js";
import { ensureSupplierDecisions, SUPPLIER_DECISIONS } from "../src/agents/supplier/decisions.js";
import { runSupplier, supplierState } from "../src/agents/supplier/index.js";
import { listPending, decide } from "../src/lib/approvals.js";
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
    const all = productsByDomain[domain] || [];
    const page = (vs, from, n) => ({ nodes: vs.slice(from, from + n), pageInfo: { hasNextPage: from + n < vs.length, endCursor: String(from + n) } });
    if (body.variables.id) { // variant page
      const p = all.find((x) => x.id === body.variables.id);
      return Response.json({ data: { product: { variants: page(p.allVariants, Number(body.variables.after || 0), 100) } } });
    }
    const handles = [...body.variables.q.matchAll(/handle:([a-z0-9-]+)/g)].map((m) => m[1]);
    const first = Number(/variants\(first: (\d+)\)/.exec(body.query)[1]);
    const nodes = all.filter((p) => handles.includes(p.handle)).map(({ allVariants, ...p }) => ({
      ...p, variantsCount: { count: allVariants.length }, variants: page(allVariants, 0, first),
    }));
    return Response.json({ data: { products: { nodes } } });
  };
  return { fetchImpl, calls };
}

const product = (handle, { price = "49.95", compareAt = null, status = "ACTIVE", title = handle, productType = "Sweaters", variants = null, sku = null } = {}) => ({
  id: `gid://shopify/Product/${handle}`, handle, title, status, productType,
  allVariants: variants || [{ id: `gid://shopify/ProductVariant/${handle}-1`, title: "M", sku, price, compareAtPrice: compareAt }],
});

/**
 * Shopify's requested query cost (the published rules, enough to check our queries): a scalar
 * costs 0, an object 1, and a connection with first:N costs 2 + N × (1 + its node's fields),
 * plus anything else on the connection (pageInfo = 1) once.
 */
function requestedCost(query) {
  const src = query.slice(query.indexOf("{"));
  let i = 0;
  const parseSel = () => { // at "{": returns [{name, args, children}]
    i++;
    const fields = [];
    while (i < src.length) {
      const rest = src.slice(i);
      if (/^\s*}/.test(rest)) { i += rest.indexOf("}") + 1; return fields; }
      const m = /^\s*([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*/.exec(rest);
      if (!m) { i++; continue; }
      i += m[0].length;
      const f = { name: m[1], args: m[3] || "", children: null };
      if (src[i] === "{") f.children = parseSel();
      fields.push(f);
    }
    return fields;
  };
  const cost = (f) => {
    if (!f.children) return 0;
    const first = /first:\s*(\d+)/.exec(f.args);
    if (first) {
      return 2 + f.children.reduce((t, c) => t + (c.name === "nodes" || c.name === "edges"
        ? Number(first[1]) * (1 + c.children.reduce((u, g) => u + cost(g), 0))
        : cost(c)), 0);
    }
    return 1 + f.children.reduce((t, c) => t + cost(c), 0);
  };
  return parseSel().reduce((t, f) => t + cost(f), 0);
}

/* ------------------------------------------------------------ pricing (shared Catalog rulebook) */

const plan = (store, costUsd, price, compareAt = null) => planVariantPrice(store, { costUsd, price, compareAt });

test("pricing: Quote Desk uses the shared catalog/pricingRules.js (Marlowe target, floors, ceiling waiver)", () => {
  assert.equal(up95(40), 40.95);
  assert.equal(down95(45), 44.95);
  assert.equal(plan("mar", 20, 59.95).newPrice, 69.95); // 20/0.29 = 68.97 → 69.95
  assert.equal(plan("mar", 10, 59.95).newPrice, 49.95); // floor
  const c = plan("mar", 50, 99.95);
  assert.equal(c.newPrice, 144.95);
  assert.equal(c.limitedBy, "ceiling");
  assert.equal(c.waiverPrice, 172.95, "the proposal says what band needs; never waives itself");
});

test("pricing: no false ceiling waiver when $144.95 keeps COGS in band", () => {
  // 47.80 / 144.95 = 32.98% ≤ 33%: in band at the ceiling, so no waiver is offered.
  const p = plan("hc", 47.8, 129.95);
  assert.equal(p.newPrice, 144.95);
  assert.equal(p.waiverPrice, null);
  assert.equal(p.limitedBy, null);
  const m = plan("mar", 42.03, 120.95); // 42.03 / 144.95 = 28.997%: in band at the ceiling
  assert.equal(m.newPrice, 144.95);
  assert.equal(m.waiverPrice, null);
  assert.equal(plan("mar", 42.05, 120.95).waiverPrice, 145.95, "just over band: the waiver is real");
});

test("pricing: H&C directional (raise above 33%, cut below 29%, leave in band), $44.95 floor, in-band non-.95 cleaned", () => {
  assert.equal(plan("hc", 20, 49.95).newPrice, 60.95); // 40% → cheapest .95 at ≤33%
  assert.equal(plan("hc", 20, 79.95).newPrice, 68.95); // 25% → dearest .95 at ≥29%
  const keep = plan("hc", 20, 64.95);
  assert.equal(keep.newPrice, 64.95);
  assert.equal(keep.change, false);
  assert.equal(plan("hc", 10, 39.95).newPrice, 44.95); // band wants less, floor wins
  assert.equal(plan("aub", 10, 49.95).newPrice, 44.95);
  assert.equal(plan("hc", 20, 65).newPrice, 64.95, "in band but not .95: cleaned to .95");
});

test("pricing: compare-at keeps the tier, prefers .95 over .50, badge prints the exact tier", () => {
  assert.equal(tierOf("hc", 49.95, null), 0);
  assert.equal(tierOf("hc", 49.95, 62.95), 20);
  const p = plan("hc", 20, 49.95, 62.95);
  assert.equal(p.newPrice, 60.95);
  assert.equal(p.tier, 20);
  assert.equal(badgePct("hc", p.newPrice, p.newCompareAt), 20);
  assert.match(p.newCompareAt.toFixed(2), /\.95$/, ".95 preferred");
  assert.equal(plan("hc", 20, 49.95, null).newCompareAt, null, "tier 0 stays without a compare-at");
  for (const tier of [10, 20, 30, 40]) {
    const c = compareAtFor("hc", 59.95, tier);
    assert.equal(badgePct("hc", 59.95, c), tier, `tier ${tier}`);
    assert.match(c.toFixed(2), /\.95$/);
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

test("Quote Desk: new quotes wait while the batch is pending; newer quotes for its products supersede it", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  const { fetchImpl, calls } = fakeShopify(HC_PRODUCTS);
  const env = { DB, ...HC_CREDS };
  await runQuoteDesk(env, { nowMs: NOW, fetchImpl });
  // A quote for a product that is not in the waiting batch: waits, no second approval.
  await importQuotes(DB, [{ store: "hc", handle: "in-band", status: 30, cost: 25, currency: "USD", quoted_at: "2026-10-13T10:00:00Z" }], { nowMs: NOW });
  const r2 = await runQuoteDesk(env, { nowMs: NOW + 3600000, fetchImpl });
  assert.match(r2.find((r) => r.store === "hc").waiting, /waiting on Reilly/);
  assert.equal((await listPending(DB)).length, 1);
  assert.equal(calls.length, 1, "no Shopify read while waiting");
  // A newer quote for a product IN the batch: the batch is superseded and re-planned with everything.
  await importQuotes(DB, [{ store: "hc", handle: "grey-crew", status: 30, cost: 25, currency: "USD", quoted_at: "2026-10-13T11:00:00Z" }], { nowMs: NOW });
  await runQuoteDesk(env, { nowMs: NOW + 2 * 3600000, fetchImpl });
  const pending = await listPending(DB);
  assert.equal(pending.length, 1, "still exactly one pending approval");
  const old = await DB.prepare(`SELECT b.status, a.status AS ap FROM supplier_batches b JOIN approvals a ON a.id = b.approval_id WHERE b.id = 1`).first();
  assert.deepEqual([old.status, old.ap], ["superseded", "expired"]);
  const nb = await DB.prepare(`SELECT id FROM supplier_batches WHERE approval_id = ?`).bind(pending[0].id).first();
  const { results: plans } = await DB.prepare(`SELECT product_handle, kind, new_price FROM supplier_plans WHERE batch_id = ? ORDER BY id`).bind(nb.id).all();
  const by = Object.fromEntries(plans.map((p) => [p.product_handle, p]));
  assert.equal(by["navy-cardigan"].kind, "reprice", "the old batch's other items are carried into the new one");
  assert.equal(by["dead-shirt"].kind, "draft");
  assert.equal(by["grey-crew"].new_price, 75.95, "with the newer cost (25/0.33 → 75.95)");
});

test("Quote Desk: batch status follows its approval; an unanswered batch expires after 3 days", async () => {
  const DB = makeD1();
  await seedQuotes(DB);
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify(HC_PRODUCTS).fetchImpl });
  const [ap] = await listPending(DB);
  await decide(DB, ap.id, { choice: "approve_all" });
  await settleBatches(DB, "hc", NOW + 60000);
  assert.equal((await DB.prepare(`SELECT status FROM supplier_batches WHERE id = 1`).first()).status, "approved");

  const DB2 = makeD1();
  await seedQuotes(DB2);
  await runQuoteDesk({ DB: DB2, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify(HC_PRODUCTS).fetchImpl });
  assert.equal(await settleBatches(DB2, "hc", NOW + 2 * DAY), 1, "still waiting at 2 days");
  assert.equal(await settleBatches(DB2, "hc", NOW + 3 * DAY + 60000), null);
  const b = await DB2.prepare(`SELECT b.status, a.status AS ap FROM supplier_batches b JOIN approvals a ON a.id = b.approval_id`).first();
  assert.deepEqual([b.status, b.ap], ["expired", "expired"]);
});

test("Quote Desk: the approval says plainly that nothing is applied, and lists every variant old → new", async () => {
  const DB = makeD1();
  await importQuotes(DB, [{ store: "hc", handle: "two-sizes", status: 30, cost: 20, currency: "USD", quoted_at: "2026-10-12" }], { nowMs: NOW });
  const variants = [
    { id: "gid://shopify/ProductVariant/a", title: "S", sku: "TS-S", price: "49.95", compareAtPrice: "62.95" },
    { id: "gid://shopify/ProductVariant/b", title: "M", sku: "TS-M", price: "52.95", compareAtPrice: null },
  ];
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify({ "jmzjx1-it.myshopify.com": [product("two-sizes", { title: "Two Sizes", variants })] }).fetchImpl });
  const [ap] = await listPending(DB);
  const d = ap.options[0].detail;
  assert.doesNotMatch(d, /Catalog applies|R2 backup/);
  assert.match(d, /nothing is written to Shopify/);
  assert.match(d, /S: \$49\.95 → \$60\.95, compare-at \$62\.95 → \$75\.95/);
  assert.match(d, /M: \$52\.95 → \$60\.95, compare-at n\/a → n\/a/);
});

test("Quote Desk: Shopify query stays under the 1000-point cost limit; long variant lists are paged", async () => {
  for (const q of [PRODUCTS_BY_HANDLE_QUERY, VARIANT_PAGE_QUERY]) assert.ok(requestedCost(q) < 1000, `cost ${requestedCost(q)}`);
  assert.equal(requestedCost(PRODUCTS_BY_HANDLE_QUERY), 877);
  assert.equal(requestedCost(`{ products(first: 50) { nodes { id variants(first: 100) { nodes { id } } } } }`), 5152, "the estimator catches the old query");

  const DB = makeD1();
  await importQuotes(DB, [{ store: "hc", handle: "many", status: 30, cost: 20, currency: "USD", quoted_at: "2026-10-12" }], { nowMs: NOW });
  const variants = Array.from({ length: 45 }, (_, i) => ({ id: `gid://shopify/ProductVariant/m${i}`, title: `V${i}`, price: "49.95", compareAtPrice: null }));
  const { fetchImpl, calls } = fakeShopify({ "jmzjx1-it.myshopify.com": [product("many", { variants })] });
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl });
  assert.equal(calls.length, 2, "one product page + one variant page");
  const p = await DB.prepare(`SELECT kind, variants FROM supplier_plans`).first();
  assert.equal(p.kind, "reprice");
  assert.equal(JSON.parse(p.variants).length, 45, "every variant priced, none dropped");
});

test("Quote Desk: quote costs go to the Core for Margin Guard; Reilly's own cost is never overwritten", async () => {
  const DB = makeD1();
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at) VALUES ('hc','product','cost:sku:GC-M','12','observation','Reilly 2026-10-01', ?)`).bind(iso(NOW)).run();
  await seedQuotes(DB);
  const prods = { "jmzjx1-it.myshopify.com": HC_PRODUCTS["jmzjx1-it.myshopify.com"].map((p) => (p.handle === "grey-crew" ? product("grey-crew", { sku: "GC-M" }) : p)) };
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify(prods).fetchImpl });
  const f = await DB.prepare(`SELECT value, source FROM core_facts WHERE key = 'cost:product:gid://shopify/Product/navy-cardigan'`).first();
  assert.deepEqual(JSON.parse(f.value), { amount: 17.09, currency: "EUR" }, "EUR kept as EUR so each reader applies its own FX rule");
  assert.match(f.source, /^kfb_quote/);
  const usd = await DB.prepare(`SELECT value FROM core_facts WHERE key = 'cost:product:gid://shopify/Product/grey-crew'`).first();
  assert.deepEqual(JSON.parse(usd.value), { usd: 20 });
  const { results: sku } = await DB.prepare(`SELECT value, source FROM core_facts WHERE key = 'cost:sku:GC-M'`).all();
  assert.equal(sku.length, 1);
  assert.equal(sku[0].value, "12", "Reilly's fact kept");
  assert.equal(await writeQuoteCost(DB, "hc", "cost:sku:GC-M", { id: 9, cost: 30, currency: "USD" }, NOW), "kept");
  // A newer quote updates the brain's own fact in place (no pile of rows).
  assert.equal(await writeQuoteCost(DB, "hc", "cost:product:gid://shopify/Product/grey-crew", { id: 9, cost: 22, currency: "USD", quoted_at: iso(NOW) }, NOW), "updated");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM core_facts WHERE key = 'cost:product:gid://shopify/Product/grey-crew'`).first()).n, 1);
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

const asRead = (p) => ({ ...p, variants: { nodes: p.allVariants } });

test("planProduct: a hold is not re-proposed unless the cost changed", () => {
  const q = [{ id: 1, variant_id: "", status: "quoted", cost: 50, currency: "USD", similar: 0 }];
  const p = asRead(product("blazer", { price: "99.95" }));
  assert.equal(planProduct("hc", "blazer", q, p, { held_price: 99.95, cost_at_hold: 50 }).kind, "held");
  assert.equal(planProduct("hc", "blazer", q, p, { held_price: 99.95, cost_at_hold: 40 }).kind, "reprice");
  const seeded = planProduct("hc", "blazer", q, p, { held_price: 99.95, cost_at_hold: null });
  assert.equal(seeded.kind, "held");
  assert.equal(seeded.seedHold.cost_at_hold, 50, "the cost at hold time is recorded");
});

test("planProduct: outerwear hold uses Catalog's test (plurals, topcoat, tags)", () => {
  const q = [{ id: 1, variant_id: "", status: "quoted", cost: 50, currency: "USD", similar: 0 }];
  const topcoat = asRead(product("navy-topcoat", { price: "114.95", title: "Navy Topcoat", productType: "Coats & Jackets" }));
  assert.equal(planProduct("hc", "navy-topcoat", q, topcoat).kind, "held");
  const tagged = asRead({ ...product("quilted", { price: "114.95", title: "Quilted Layer", productType: "Layers" }), tags: ["Puffers"] });
  assert.equal(planProduct("hc", "quilted", q, tagged).kind, "held");
  const sweater = asRead(product("knit", { price: "114.95", title: "Heavy Knit", productType: "Sweaters" }));
  assert.equal(planProduct("hc", "knit", q, sweater).kind, "reprice");
});

test("Quote Desk: H&C outerwear hold records its cost and is proposed again when the cost changes", async () => {
  const DB = makeD1();
  const coat = { "jmzjx1-it.myshopify.com": [product("wool-coat", { price: "114.95", title: "Wool Overcoat", productType: "Outerwear" })] };
  await importQuotes(DB, [{ store: "hc", handle: "wool-coat", status: 30, cost: 50, currency: "USD", quoted_at: "2026-10-12" }], { nowMs: NOW });
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify(coat).fetchImpl });
  const hold = await DB.prepare(`SELECT * FROM supplier_price_holds WHERE product_handle = 'wool-coat'`).first();
  assert.equal(hold.cost_at_hold, 50);
  assert.equal((await listPending(DB)).length, 0);
  // Same cost again → still held.
  await importQuotes(DB, [{ store: "hc", handle: "wool-coat", status: 30, cost: 50, currency: "USD", quoted_at: "2026-10-13" }], { nowMs: NOW });
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW + 3600000, fetchImpl: fakeShopify(coat).fetchImpl });
  assert.equal((await listPending(DB)).length, 0);
  // Cost moves → proposed again.
  await importQuotes(DB, [{ store: "hc", handle: "wool-coat", status: 30, cost: 44, currency: "USD", quoted_at: "2026-10-14" }], { nowMs: NOW });
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW + 2 * 3600000, fetchImpl: fakeShopify(coat).fetchImpl });
  const [ap] = await listPending(DB);
  assert.ok(ap, "re-proposed after the cost changed");
  assert.match(ap.options[0].detail, /Wool Overcoat/);
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

test("Size Checker: complaints size up even when the chart looks fine; complaints alone stay within the listed sizes", () => {
  const fine = [{ size_label: "M", measurements: { chest: 112, length: 72 } }, { size_label: "L", measurements: { chest: 122, length: 74 } }, { size_label: "XL", measurements: { chest: 132, length: 76 } }];
  const complaints = [{ size_ordered: "M", size_that_fits: "L" }, { said: "way too small" }];
  assert.equal(complaintShift(complaints), 1);
  const r = recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: fine, complaints });
  assert.equal(r.send_size, "L");
  assert.match(r.reason, /complaint/);
  const only = recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: [], complaints, productSizes: ["S", "M", "L", "XL"] });
  assert.equal(only.verdict, "complaints_only");
  assert.equal(only.send_size, "L");
  const unknown = recommendSize({ title: "Cardigan", orderedSize: "M", chartRows: [], complaints });
  assert.equal(unknown.send_size, null, "largest size unknown: no ask");
  const beyond = recommendSize({ title: "Cardigan", orderedSize: "XL", chartRows: [], complaints, productSizes: ["S", "M", "L", "XL"] });
  assert.equal(beyond.send_size, null, "never asks for a size the product doesn't come in");
  assert.match(beyond.reason, /above the largest size it comes in \(XL\)/);
  assert.deepEqual(listedSizes(JSON.stringify([{ title: "Navy / Medium" }, { title: "Navy / XXL" }])).sort(), ["2XL", "M"]);
});

test("Size Checker: mixed complaints (as many 'too large' as 'too small') never size up", () => {
  assert.equal(complaintShift([{ size_ordered: "M", size_that_fits: "L" }, { size_ordered: "L", size_that_fits: "M" }]), 0);
  assert.equal(complaintShift([{ said: "too small" }, { said: "way too big" }, { said: "too loose" }]), 0);
  assert.equal(complaintShift([{ said: "too small" }, { said: "tight" }, { said: "too big" }]), 1);
});

test("Size Checker: never sends smaller than ordered (a chart that runs large is noted, no KFB ask)", () => {
  const big = [ // Chinese S is really a US M
    { size_label: "S", measurements: { chest: 112, length: 72 } },
    { size_label: "M", measurements: { chest: 122, length: 74 } },
    { size_label: "L", measurements: { chest: 132, length: 76 } },
  ];
  const r = recommendSize({ title: "Merino Sweater", orderedSize: "M", chartRows: big });
  assert.equal(r.verdict, "runs_large");
  assert.equal(r.send_size, "M");
  const top = recommendSize({ title: "Merino Sweater", orderedSize: "XL", chartRows: big });
  assert.equal(top.send_size, null, "factory tops out at L: no smaller size is sent");
  assert.equal(top.verdict, "no_fit");
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

/** Catalog's copy of a product (title, tags, type), as the Size Checker reads it. */
async function seedCatProduct(DB, { store = "hc", product = "p1", title = "Shawl Collar Cardigan", tags = [], productType = null, variants = null }) {
  await DB.prepare(`INSERT INTO cat_products (store, product_id, title, tags, product_type, variants, read_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(store, `gid://shopify/Product/${product}`, title, JSON.stringify(tags), productType, variants ? JSON.stringify(variants) : null, iso(NOW)).run();
}

test("Size Checker run: records recommendations and one KFB ask per line, idempotent", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 1201 });
  await seedOrder(DB, { n: 1202, product: "p2", handle: "no-chart", title: "Plain Sweater" });
  await seedOrder(DB, { n: 1203, status: "refunded" });
  // H&C sells both: these products are tagged men's, so the men's reference applies.
  await seedCatProduct(DB, { product: "p1", tags: ["Mens", "Knitwear"] });
  await seedCatProduct(DB, { product: "p2", title: "Plain Sweater", productType: "Men's Sweaters" });
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
  assert.doesNotMatch(rec.reason, /audience assumed/, "H&C's audience is known now (Reilly, 2026-10-13)");
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

test("Size Checker audiences: women → no reference; men → men's chart, no 'assumed' note; both (H&C) → per product, never assumed", () => {
  const base = { title: "Shawl Collar Cardigan", orderedSize: "M", chartRows: SMALL_CHART };
  // women (Auberlane)
  const w = recommendSize({ ...base, audience: "women" });
  assert.equal(w.verdict, "no_reference");
  assert.match(w.reason, /women's item: no women's US reference yet/);
  // men (Marlowe)
  const m = recommendSize({ ...base, audience: "men" });
  assert.equal(m.verdict, "size_up");
  assert.equal(m.send_size, "L");
  // both (H&C): unmarked → no size, never men's by default
  const u = recommendSize({ ...base, audience: "both" });
  assert.equal(u.verdict, "no_reference");
  assert.equal(u.reason, "H&C sells men's and women's; this product isn't marked either way");
  // both: marked men's by tags, by product type, or by title
  assert.equal(recommendSize({ ...base, audience: "both", tags: JSON.stringify(["Mens"]) }).send_size, "L");
  assert.equal(recommendSize({ ...base, audience: "both", productType: "Men's Knitwear" }).send_size, "L");
  assert.equal(recommendSize({ ...base, audience: "both", title: "Men's Shawl Collar Cardigan" }).send_size, "L");
  // both: a women's line is never sized against the men's chart ("women" contains "men")
  for (const marks of [{ tags: ["Womens"] }, { tags: ["Women"] }, { productType: "Ladies Knitwear" }, { title: "Womens Shawl Cardigan" }, { tags: ["Mens", "Womens"] }]) {
    const r = recommendSize({ ...base, audience: "both", ...marks });
    assert.equal(r.verdict, "no_reference", JSON.stringify(marks));
    assert.equal(r.send_size, null);
    assert.match(r.reason, /women's/);
  }
  // a women's tag blocks the men's chart even at a men's store
  assert.equal(recommendSize({ ...base, audience: "men", tags: ["Womens"] }).verdict, "no_reference");
});

test("Size Checker audiences from config and the Core: H&C's unmarked line gets no size; a Core fact overrides; Marlowe has no 'assumed' note", async () => {
  const DB = makeD1();
  // H&C, no Catalog tags: not marked either way → no reference, no KFB ask.
  await seedOrder(DB, { n: 1401 });
  await seedChart(DB, "p1", SMALL_CHART, 1);
  // H&C, a Women's line (tagged): never sized against the men's chart.
  await seedOrder(DB, { n: 1402, product: "pw", handle: "w-cardigan", title: "Shawl Collar Cardigan" });
  await seedCatProduct(DB, { product: "pw", tags: ["Womens", "Knitwear"] });
  await seedChart(DB, "pw", SMALL_CHART, 1);
  // Marlowe (men): men's reference, no "assumed" note.
  await seedOrder(DB, { store: "mar", n: 1403, product: "pm", handle: "m-cardigan" });
  for (const r of SMALL_CHART) {
    await DB.prepare(`INSERT INTO size_charts (store, product_id, size_label, measurements, source, verified) VALUES ('mar', ?, ?, ?, 'test', 1)`)
      .bind("gid://shopify/Product/pm", r.size_label, JSON.stringify(r.measurements)).run();
  }
  // Auberlane (women): no reference.
  await seedOrder(DB, { store: "aub", n: 1404, product: "pa", handle: "a-cardigan" });
  await runSizeChecker({ DB }, { nowMs: NOW });
  const rec = async (n) => DB.prepare(`SELECT * FROM size_recommendations WHERE order_id = ?`).bind(`gid://shopify/Order/${n}`).first();
  const hcUnmarked = await rec(1401);
  assert.equal(hcUnmarked.verdict, "no_reference");
  assert.match(hcUnmarked.reason, /isn't marked either way/);
  const hcWomen = await rec(1402);
  assert.equal(hcWomen.verdict, "no_reference");
  assert.match(hcWomen.reason, /women's item/);
  const mar = await rec(1403);
  assert.equal(mar.verdict, "size_up");
  assert.doesNotMatch(mar.reason, /assumed/);
  assert.equal((await rec(1404)).verdict, "no_reference");
  const asks = (await DB.prepare(`SELECT order_name FROM kfb_size_asks ORDER BY order_name`).all()).results.map((a) => a.order_name);
  assert.deepEqual(asks, ["#1403"], "only Marlowe's men's line gets a size ask");

  assert.equal((await coreSizing(DB, "aub")).audience, "women");
  assert.equal((await coreSizing(DB, "cc")).audience, null, "not told yet: null, never a default");
  assert.equal(productAudience({ tags: '["Mens"]' }), "men");
  assert.equal(productAudience({ tags: '["Womens"]' }), "women");
  assert.equal(productAudience({ title: "Plain Sweater" }), null);
});

test("Size Checker: Reilly's recorded audience outranks Core facts; a disagreeing fact is a conflict note; all-stores facts are ignored", async () => {
  const DB = makeD1();
  const fact = (store, value) => DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at, live) VALUES (?, 'profile', 'profile.audience', ?, 'rule', 'test', ?, 1)`).bind(store, value, iso(NOW)).run();
  await fact(null, "womens");          // all-stores fact: can't speak for one store, ignored
  await fact("hc", "mens");            // disagrees with H&C "both": would switch off the per-product check
  await fact("mar", "mens");           // agrees with Marlowe: no change, no note
  await fact("cc", "womens");          // a store Reilly hasn't described yet: the store-scoped fact is used
  const hc = await coreSizing(DB, "hc");
  assert.equal(hc.audience, "both", "a fact never disables H&C's per-product check");
  assert.match(hc.audienceConflict, /disagrees with Reilly's recorded audience "both"/);
  const mar = await coreSizing(DB, "mar");
  assert.equal(mar.audience, "men");
  assert.equal(mar.audienceConflict, null);
  assert.equal((await coreSizing(DB, "aub")).audience, "women", "the all-stores 'womens' fact is ignored; config stands");
  assert.equal((await coreSizing(DB, "aub")).audienceConflict, null);
  assert.equal((await coreSizing(DB, "cc")).audience, "women");
  // The run: H&C's unmarked line stays unsized, and the reason carries the conflict note.
  await seedOrder(DB, { n: 1501 });
  await seedChart(DB, "p1", SMALL_CHART, 1);
  await runSizeChecker({ DB }, { nowMs: NOW });
  const rec = await DB.prepare(`SELECT verdict, reason FROM size_recommendations WHERE order_id = 'gid://shopify/Order/1501'`).first();
  assert.equal(rec.verdict, "no_reference");
  assert.match(rec.reason, /conflict: Core fact profile\.audience "mens" disagrees/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_size_asks`).first()).n, 0);
});

test("Size Checker: every feminine marker is women's; a product marked both ways is never sized as men's", () => {
  const base = { title: "Shawl Collar Cardigan", orderedSize: "M", chartRows: SMALL_CHART };
  const probes = [
    { tags: ["Mens", "Womenswear"] }, { tags: ["Men's", "Woman"] }, { productType: "Men's / Lady" }, { tags: ["Mens", "Female"] },
    { tags: ["Girls"] }, { tags: ["Lady"] }, { title: "Woman's Cardigan" }, { tags: ["female"] },
  ];
  for (const audience of ["both", "men"]) {
    for (const marks of probes) {
      const r = recommendSize({ ...base, audience, ...marks });
      assert.notEqual(r.verdict, "size_up", `${audience} ${JSON.stringify(marks)}`);
      assert.equal(r.verdict, "no_reference", `${audience} ${JSON.stringify(marks)}`);
      assert.equal(r.send_size, null);
    }
  }
  assert.equal(productAudience({ tags: ["Mens", "Womenswear"] }), "mixed");
  assert.match(recommendSize({ ...base, audience: "both", tags: ["Mens", "Female"] }).reason, /marked both men's and women's/);
  // Men's markers, including menswear / male, still size at a "both" store.
  for (const marks of [{ tags: ["Menswear"] }, { productType: "Male" }, { tags: ["Men"] }]) {
    assert.equal(recommendSize({ ...base, audience: "both", ...marks }).send_size, "L", JSON.stringify(marks));
  }
  assert.equal(productAudience({ tags: ["Female"] }), "women", "\\bmale never matches inside 'female'");
});

/* ------------------------------------------------------------ Similar QC */

test("Similar QC: quotes accepted per 'q4 always fine'; a substitute on a customer's order is fine too (Reilly: 'yes') but recorded", async () => {
  const DB = makeD1();
  assert.equal(judgeSimilar({ context: "quote" }).verdict, "accepted");
  const order = judgeSimilar({ context: "order" });
  assert.equal(order.verdict, "accepted");
  assert.match(order.reason, /Recorded, not flagged/);
  assert.equal(judgeSimilar({ context: "something else" }).verdict, "ask_reilly", "an unknown context is still not covered");
  await recordSimilarOffer(DB, { store: "hc", context: "quote", handle: "a", remark: "only similar ones" }, { nowMs: NOW });
  await recordSimilarOffer(DB, { store: "hc", context: "order", order_name: "#1210", remark: "similar colour" }, { nowMs: NOW });
  await assert.rejects(recordSimilarOffer(DB, { store: "tund", context: "quote" }));
  const r = await runSimilarQc({ DB }, { nowMs: NOW });
  assert.deepEqual([r.accepted, r.substituted, r.flagged], [2, 1, 0]);
  // Recorded: the verdict on the offer row and one event naming the order.
  assert.equal((await DB.prepare(`SELECT verdict FROM kfb_similar_offers WHERE order_name = '#1210'`).first()).verdict, "accepted");
  const ev = await DB.prepare(`SELECT summary FROM events WHERE kind = 'similar.substituted'`).first();
  assert.match(ev.summary, /#1210/);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'similar.flagged'`).first()).n, 0);
  const d = await digestData(DB, NOW);
  assert.equal(d.similarSubs24h, 1);
  assert.match(digestBody({ ...d, quotes: null }), /Similar substitutes on customers' orders: 1 in 24h \(fine per your rule; recorded\)/);
  const again = await runSimilarQc({ DB }, { nowMs: NOW });
  assert.equal(again.judged, 0);
});

test("Quote status 40 means 'waiting on Reilly's approval' (his best guess), not an error", async () => {
  const v = validateQuoteRow({ store: "hc", handle: "a", status: 40, quoted_at: "2026-10-12" });
  assert.equal(v.reason, undefined);
  assert.equal(v.status, "awaiting_reilly_guess");
  assert.match(STATUS_LABELS[v.status], /waiting on Reilly's approval/);
  assert.match(STATUS_LABELS[v.status], /status 40 \(Reilly: FFG, 'i think'\)/);
  const DB = makeD1();
  await importQuotes(DB, [{ store: "hc", handle: "a", status: 40, quoted_at: "2026-10-13" }], { nowMs: NOW });
  const d = await digestData(DB, NOW);
  assert.equal(d.quotes.awaitingReilly40, 1);
  assert.equal(d.quotes.unknown, 0);
  const body = digestBody(d);
  assert.match(body, /1 waiting on your approval — status 40 \(Reilly: FFG, 'i think'\)/);
  assert.doesNotMatch(body, /unknown status/);
});

test("Quote status 40: rows stored before the change (raw code 40, status 'unknown') are re-mapped on the next run", async () => {
  const DB = makeD1();
  const ins = (handle, code, status) => DB.prepare(`INSERT INTO kfb_quotes (store, product_handle, variant_id, status_code, status, quoted_at, source, imported_at)
    VALUES ('hc', ?, '', ?, ?, '2026-10-12T00:00:00.000Z', 'manual', ?)`).bind(handle, code, status, iso(NOW)).run();
  await ins("old-40", 40, "unknown");
  await ins("other-unknown", null, "unknown");   // no raw code: left alone, never guessed
  await ins("dup", 40, "unknown");
  await ins("dup", 40, "awaiting_reilly_guess"); // already there under the new status: the old row is kept as it was
  await runQuoteDesk({ DB, ...HC_CREDS }, { nowMs: NOW, fetchImpl: fakeShopify({}).fetchImpl });
  const st = async (h) => (await DB.prepare(`SELECT status FROM kfb_quotes WHERE product_handle = ? ORDER BY id`).bind(h).all()).results.map((r) => r.status);
  assert.deepEqual(await st("old-40"), ["awaiting_reilly_guess"]);
  assert.deepEqual(await st("other-unknown"), ["unknown"]);
  assert.deepEqual(await st("dup"), ["unknown", "awaiting_reilly_guess"]);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'quotes.status40_remapped'`).first()).n, 1);
});

test("Similar QC: old 'ask_reilly' order offers are re-judged (verdict only), not reported as new substitutions; approvals untouched", async () => {
  const DB = makeD1();
  const oldJudged = iso(NOW - 2 * 3600000); // inside the digest's 24h window on purpose
  await recordSimilarOffer(DB, { store: "hc", context: "order", order_name: "#1099", remark: "similar colour" }, { nowMs: NOW - DAY });
  await DB.prepare(`UPDATE kfb_similar_offers SET verdict = 'ask_reilly', verdict_reason = 'old rule', judged_at = ?`).bind(oldJudged).run();
  // An approval from elsewhere: Similar QC never touches approvals (their note holds Reilly's words).
  await DB.prepare(`INSERT INTO approvals (created_at, dept, requested_by, title, options, status) VALUES (?, 'sup', 'sup.similar_qc', 'x', '[]', 'pending')`).bind(oldJudged).run();
  const r = await runSimilarQc({ DB }, { nowMs: NOW });
  assert.deepEqual([r.rejudged, r.substituted, r.judged], [1, 0, 0]);
  const o = await DB.prepare(`SELECT verdict, verdict_reason, judged_at FROM kfb_similar_offers WHERE order_name = '#1099'`).first();
  assert.equal(o.verdict, "accepted");
  assert.match(o.verdict_reason, /^Re-judged under Reilly's 2026-10-13 rule \(was ask_reilly\): old rule/);
  assert.equal(o.judged_at, oldJudged, "judged_at left as it was");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'similar.substituted'`).first()).n, 0);
  const ev = (await DB.prepare(`SELECT summary FROM events WHERE kind = 'similar.rejudged'`).all()).results;
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /^1 old similar offer re-judged under Reilly's 2026-10-13 rule/);
  assert.equal((await digestData(DB, NOW)).similarSubs24h, 0, "not counted as a new substitution");
  const a = await DB.prepare(`SELECT status, note FROM approvals`).first();
  assert.deepEqual([a.status, a.note], ["pending", null]);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM kfb_similar_offers`).first()).n, 1, "kept, not deleted");
  assert.equal((await runSimilarQc({ DB }, { nowMs: NOW + 60000 })).rejudged, 0, "done once");
});

test("Size Checker: 'man' is not a men's marker (Man-made fibres, Man Made, Isle of Man)", () => {
  const base = { title: "Shawl Collar Cardigan", orderedSize: "M", chartRows: SMALL_CHART, audience: "both" };
  for (const marks of [{ tags: ["Man-made fibres"] }, { tags: ["Man Made"] }, { productType: "Isle of Man" }, { title: "Shawl Collar Cardigan, man-made fibres" }]) {
    const r = recommendSize({ ...base, ...marks });
    assert.equal(r.verdict, "no_reference", JSON.stringify(marks));
    assert.equal(r.reason, "H&C sells men's and women's; this product isn't marked either way");
  }
  assert.equal(productAudience({ tags: ["Man Made", "Womens"] }), "women", "'Man' doesn't turn a women's line into 'mixed'");
  assert.equal(productAudience({ tags: ["Men"] }), "men");
});

test("Quote Desk: a proposal under Auberlane's $30 minimum margin is flagged, not quietly re-priced", () => {
  // $120 cost: band target is above the ceiling, so the rules stop at $144.95 → $24.95 margin.
  const p = planVariantPrice("aub", { costUsd: 120, price: 129.95, compareAt: null });
  assert.equal(p.newPrice, 144.95);
  assert.equal(p.belowMinMargin, true);
  assert.ok(p.notes.some((n) => /below_min_margin: \$24\.95 margin/.test(n)), p.notes.join("; "));
  assert.equal(planVariantPrice("aub", { costUsd: 20, price: 69.95, compareAt: null }).belowMinMargin, false);
  assert.equal(planVariantPrice("hc", { costUsd: 120, price: 129.95, compareAt: null }).belowMinMargin, false, "H&C has no minimum-margin rule");
});

/* ------------------------------------------------------------ Pre-flight */

test("Pre-flight: denied products and size complaints flagged once; 'no quote' only once quotes are wired", async () => {
  const DB = makeD1();
  await seedOrder(DB, { n: 1301, handle: "dead-shirt", title: "Dead Shirt", product: "d1" });
  await seedOrder(DB, { n: 1302, handle: "other", title: "Other", product: "o1" });
  await seedOrder(DB, { n: 1303, handle: "other", title: "Other", product: "o1", size: "Medium" });
  await seedOrder(DB, { n: 1304, handle: "other", title: "Other", product: "o1", size: "L" });
  let r = await runPreflight({ DB }, { nowMs: NOW });
  assert.equal(r.added, 0, "no quotes wired: no 'no quote' noise");

  await importQuotes(DB, [{ store: "hc", handle: "dead-shirt", status: 26, quoted_at: "2026-10-12", remark: "factory closed" }], { nowMs: NOW });
  await DB.prepare(`INSERT INTO size_complaints (store, product_id, size_ordered, size_that_fits, at) VALUES ('hc','gid://shopify/Product/o1','m','L',?)`).bind(iso(NOW)).run();
  r = await runPreflight({ DB }, { nowMs: NOW });
  const { results } = await DB.prepare(`SELECT order_name, kind FROM supply_flags WHERE kind != 'no_quote' ORDER BY order_name, kind`).all();
  assert.deepEqual(results.map((x) => `${x.order_name}:${x.kind}`), ["#1301:denied", "#1302:size_complaints", "#1303:size_complaints"],
    "'Medium' and 'm' both count as M; L has no complaints");
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM supply_flags WHERE kind = 'no_quote'`).first()).n, 4);
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

test("Digest: an old KFB read is not used (never 'none unpaid' from a stale import)", async () => {
  const DB = makeD1();
  const old = NOW - 5 * DAY;
  await importBills(DB, [{ bill_id: "b1", amount: 10, currency: "EUR", billed_at: iso(old - DAY), paid_at: iso(old) }], { nowMs: old });
  await importQuotes(DB, [{ store: "hc", handle: "a", status: 25, quoted_at: iso(old) }], { nowMs: old });
  const body = digestBody(await digestData(DB, NOW));
  assert.doesNotMatch(body, /none unpaid/);
  assert.match(body, /Bills: KFB last read 5 days ago: too old/);
  assert.match(body, /Quotes: KFB last read 5 days ago: too old/);
  // Fresh (within 36 h) → numbers are used.
  const fresh = digestBody(await digestData(DB, old + 20 * 3600000));
  assert.match(fresh, /Bills: none unpaid/);
  assert.match(fresh, /1 waiting for your KFB confirmation/);
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
