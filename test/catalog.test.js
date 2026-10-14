import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./helpers/d1.js";
import { _resetTokenCacheForTests, shopifyGraphQL, shopifyGraphQLWithCost, StoreGuardError } from "../src/lib/storeGuard.js";
import { encryptToken, _resetGoogleCacheForTests } from "../src/lib/google.js";
import { EUR_USD_ESTIMATE } from "../src/lib/pnl.js";

import * as R from "../src/agents/catalog/pricingRules.js";
import { syncStore, getSync, cacheReady, passProgress, pagesForStore, PAGE_SIZE, PRODUCTS_QUERY, MAX_PAGES_PER_TICK, SYNC_PAGE_BUDGET } from "../src/agents/catalog/sync.js";
import { checkProduct, SHADOW_NOTE, runPricingStore } from "../src/agents/catalog/pricing.js";
import { judgeProduct, contributionPerDollar } from "../src/agents/catalog/marginGuard.js";
import { statusProposals } from "../src/agents/catalog/status.js";
import { checkNewProduct, supplyCheck } from "../src/agents/catalog/prepublish.js";
import { findingFromProduct, merchantIdFor } from "../src/agents/catalog/feedHealth.js";
import { readCosts, productCost, isHoldCandidate, isOuterwear, resolveHolds, claimDaily } from "../src/agents/catalog/common.js";
import { runCatalog, catalogState } from "../src/agents/catalog/index.js";

const HC_DOMAIN = "jmzjx1-it.myshopify.com";
const HC_ENV = { SB_HC_CLIENT_ID: "hc-id", SB_HC_CLIENT_SECRET: "hc-secret" }; // only H&C wired
const NOW = Date.parse("2026-10-13T14:00:00Z"); // 10:00 in New York

/* ======================= pricing rules (pure) ======================= */

test("rules: floors, the $144.95 ceiling on all 3 stores, bands and shapes match Reilly's words", () => {
  assert.equal(R.PRICE_CEILING, 144.95);
  for (const s of ["hc", "aub", "mar"]) assert.equal(R.rulesFor(s).ceiling, 144.95);
  assert.equal(R.rulesFor("hc").floor, 44.95);   // "min price 44.95 on H&C going forwards"
  assert.equal(R.rulesFor("aub").floor, 44.95);
  assert.equal(R.rulesFor("mar").floor, 49.95);
  assert.deepEqual(R.rulesFor("hc").band, { lo: 0.29, hi: 0.33 });
  assert.deepEqual(R.rulesFor("aub").band, { lo: 0.25, hi: 0.29 });
  assert.equal(R.rulesFor("hc").shape, "directional");
  assert.equal(R.rulesFor("mar").shape, "single");
  assert.equal(R.rulesFor("cc"), null, "no rules agreed: never borrow another store's");
  assert.equal(R.rulesFor("nope"), null);
  assert.equal(R.rulesFor("hc").badge.verified, true);
  assert.equal(R.rulesFor("aub").badge.model, "round5", "Auberlane's live snippet rounds to the nearest 5");
  assert.equal(R.rulesFor("mar").badge.model, "round1", "Marlowe's live snippet rounds to the nearest whole percent");
  assert.equal(R.rulesFor("aub").badge.verified, true);
  assert.equal(R.rulesFor("mar").badge.verified, true);
});

test("rules: each store's badge prints what its own theme snippet prints", () => {
  // Auberlane: pct / 5, round, × 5.
  assert.equal(R.badgePct("aub", 82, 100), 20);   // 18% → 20
  assert.equal(R.badgePct("aub", 83, 100), 15);   // 17% → 15
  assert.equal(R.badgePct("aub", 77.5, 100), 25); // 22.5% → 25 (half rounds up, as Liquid does)
  // Marlowe: nearest whole percent, so 19% is NOT the 20 tier.
  assert.equal(R.badgePct("mar", 81, 100), 19);
  assert.equal(R.tierOf("mar", 81, 100), null, "19% badge is a wrong tier on Marlowe");
  assert.equal(R.badgePct("mar", 80.4, 100), 20);
  // Exact halves are computed in cents like the theme, so they round UP (float dollars said 22.4999…).
  assert.equal(R.badgePct("aub", 44.95, 58.00), 25, "exactly 22.5% off prints -25% live");
  assert.equal(R.tierOf("aub", 44.95, 58.00), null, "so it is a wrong tier, not tier 20");
  assert.equal(R.badgePct("aub", 47.95, 54.80), 15);
  assert.equal(R.badgePct("mar", 114.95, 190.00), 40);
  // A discount that rounds to 0 shows no badge: wrong tier, and said that way.
  assert.equal(R.badgePct("aub", 99.95, 101.95), 0);
  assert.equal(R.tierOf("aub", 99.95, 101.95), null);
  const zero = R.validatePrice("aub", { price: 99.95, compareAt: 101.95, cost: 27 });
  assert.ok(zero.issues.some((i) => i.code === "compare_at_tier_wrong" && /No badge would show/.test(i.detail || i.message || JSON.stringify(i))));
  // compareAtFor finds a pair that prints the tier exactly on every store.
  let hits = 0;
  for (const id of ["aub", "mar"]) for (const p of [49.95, 79.95, 129.95]) for (const t of [10, 20, 30, 40]) {
    const c = R.compareAtFor(id, p, t);
    assert.ok(c != null, `${id} ${p} tier ${t} has a compare-at`);
    assert.equal(R.badgePct(id, p, c), t, `${id} ${p} tier ${t} → ${c}`);
    assert.equal(R.tierOf(id, p, c), t);
    hits++;
  }
  assert.equal(hits, 24);
  // Marlowe wrong tier is a real finding now its snippet is read.
  const m = R.validatePrice("mar", { price: 81, compareAt: 100, cost: 21 });
  assert.ok(m.issues.some((i) => i.code === "compare_at_tier_wrong" && i.severity === "medium"));
});

test("rules: .95 helpers work in whole cents", () => {
  assert.equal(R.up95(51.72), 51.95);
  assert.equal(R.up95(50.95), 50.95);
  assert.equal(R.up95(50.96), 51.95);
  assert.equal(R.up95(60.6060606), 60.95);
  assert.equal(R.down95(51.72), 50.95);
  assert.equal(R.down95(51.95), 51.95);
  assert.equal(R.down95(0.5), null);
  assert.ok(R.isCleanPrice(44.95) && !R.isCleanPrice(44.99) && !R.isCleanPrice(45));
  assert.ok(R.isCleanCompareAt(49.95) && R.isCleanCompareAt(49.5) && !R.isCleanCompareAt(49.99));
});

test("rules: cost in EUR converts at the 1.17 estimate and says so; unknown stays unknown", () => {
  assert.equal(EUR_USD_ESTIMATE, 1.17);
  assert.deepEqual(R.costToUsd({ eur: 12 }), { usd: 14.04, currency: "EUR", fxEstimated: true, fx: 1.17, eur: 12 });
  assert.equal(R.costToUsd({ amount: 10, currency: "EUR" }, 1.1).fxEstimated, false, "an actual card rate is not an estimate");
  assert.equal(R.costToUsd(15).usd, 15);
  assert.equal(R.costToUsd(null), null);
  assert.equal(R.costToUsd(0), null, "zero is a claim, not a cost");
  assert.equal(R.costToUsd({ amount: 10, currency: "GBP" }), null);
  assert.equal(R.cogsPct(null, 50), null);
});

test("rules: Marlowe / Auberlane single target = min(max(up95(cost/0.29), floor), 144.95)", () => {
  assert.equal(R.targetPrice("mar", 15).target, 51.95);           // 15/0.29 = 51.72 → 51.95
  assert.equal(R.targetPrice("mar", 10).target, 49.95);           // 34.48 → 34.95 → floor 49.95
  assert.equal(R.targetPrice("mar", 10).floorAboveBand, true);
  const hi = R.targetPrice("mar", 50);                              // 172.41 → ceiling
  assert.equal(hi.target, 144.95);
  assert.equal(hi.ceilingBlocksBand, true, "the ceiling stopping the band is reported, never waived");
  const eur = R.targetPrice("aub", { eur: 12 });                    // €12 → $14.04 → 48.41 → 48.95
  assert.equal(eur.target, 48.95);
  assert.equal(eur.fxEstimated, true);
  assert.equal(R.targetPrice("mar", { eur: 12 }).target, 49.95, "Marlowe floor is $49.95");
  assert.deepEqual(R.targetPrice("mar", 15).cleanRange, { min: 51.95, max: 59.95 });
  assert.equal(R.targetPrice("hc", 20).target, null, "H&C is directional, no single target");
  assert.equal(R.targetPrice("mar", null), null);
});

test("rules: H&C directional — raise above 33%, cut below 29%, leave in band, floor wins", () => {
  // $20 cost at $54.95 = 36.4% → cheapest .95 at ≤ 33% = 60.95 (32.8%)
  assert.equal(R.recommendPrice("hc", 54.95, 20).price, 60.95);
  // $15 cost at $69.95 = 21.4% → dearest .95 at ≥ 29% = 50.95 (29.4%)
  assert.equal(R.recommendPrice("hc", 69.95, 15).price, 50.95);
  assert.ok(15 / 50.95 >= 0.29);
  // In band → leave
  assert.equal(R.recommendPrice("hc", 64.95, 20).price, 64.95);
  // Cut would go under the floor → floor
  assert.equal(R.recommendPrice("hc", 59.95, 10).price, 44.95);
  // Cost unknown → only floor/ceiling/ending
  assert.equal(R.recommendPrice("hc", 39.95, null).price, 44.95);
  assert.equal(R.recommendPrice("hc", 150, null).price, 144.95);
  assert.equal(R.recommendPrice("hc", 59.99, null).price, 59.95, "never rounds a price up silently");
  // Ceiling blocks band
  const r = R.recommendPrice("hc", 144.95, 60);
  assert.equal(r.price, 144.95);
  assert.equal(r.ceilingBlocksBand, true);
});

test("rules: compare-at tiers are clean and the H&C badge prints the exact tier", () => {
  // Spec example: "a rough 10% compare at ... clean numbers like 43.95"
  assert.equal(R.compareAtFor("hc", 39.95, 10), 43.95);
  assert.equal(R.compareAtFor("hc", 39.95, 20), 49.95);
  assert.equal(R.compareAtFor("hc", 39.95, 30), 56.95);
  assert.equal(R.compareAtFor("hc", 39.95, 40), 66.95);
  assert.equal(R.compareAtFor("hc", 39.95, 0), null);
  for (const p of [44.95, 51.95, 60.95, 89.95, 114.95, 144.95]) {
    for (const t of [10, 20, 30, 40]) {
      const c = R.compareAtFor("hc", p, t);
      assert.ok(R.isCleanCompareAt(c), `${p} tier ${t} → ${c} is clean`);
      assert.equal(R.badgePct("hc", p, c), t, `${p} tier ${t} → ${c} prints ${t}%`);
      assert.equal(R.tierOf("hc", p, c), t);
    }
  }
  // H&C badge: floor to a whole percent, then round to 10 → ±5 points prints clean
  assert.equal(R.badgePct("hc", 85, 100), 20);   // 15% → 20
  assert.equal(R.badgePct("hc", 85.5, 100), 10); // 14.5 → 14 → 10
  assert.equal(R.tierOf("hc", 50, null), 0);
  assert.equal(R.tierOf("hc", 50, 50), 0);
  assert.equal(R.tierOf("hc", 39.95, 79.95), null, "50% is not a tier");
  assert.equal(R.tierOf("hc", 49.95, 51.95), null, "a 3.9% sale prints 0%: wrong tier");
});

test("rules: validatePrice flags floor, ceiling, ending, COGS and compare-at, and proposes old → new keeping the tier", () => {
  const bad = R.validatePrice("hc", { price: 39.99, compareAt: 79.99, cost: 20 });
  const codes = bad.issues.map((i) => i.code);
  for (const c of ["below_floor", "unclean_price", "cogs_above_band", "compare_at_unclean", "compare_at_tier_wrong"]) assert.ok(codes.includes(c), c);
  assert.equal(bad.ok, false);
  assert.equal(bad.proposed.price, 60.95);
  assert.equal(bad.proposed.tier, 40, "a wrong 50% compare-at goes to the nearest tier");
  assert.equal(R.badgePct("hc", bad.proposed.price, bad.proposed.compareAt), 40);

  const good = R.validatePrice("hc", { price: 64.95, compareAt: R.compareAtFor("hc", 64.95, 20), cost: 20 });
  assert.equal(good.ok, true);
  assert.equal(good.proposed, null);
  assert.equal(good.tier, 20);

  const over = R.validatePrice("aub", { price: 159.95 });
  assert.ok(over.issues.some((i) => i.code === "above_ceiling"));
  assert.equal(over.proposed.price, 144.95);
  assert.equal(over.costUsd, null, "cost unknown stays null");

  // Single-target store, in band but off target → low, with the target proposed; tier kept.
  const off = R.validatePrice("aub", { price: 55.95, compareAt: R.compareAtFor("aub", 55.95, 20), cost: 15 });
  assert.ok(off.issues.some((i) => i.code === "off_target" && i.severity === "low"));
  assert.equal(off.proposed.price, 51.95);
  assert.equal(off.proposed.tier, 20);
  assert.ok(!off.issues.some((i) => i.code === "badge_unverified"), "Auberlane's badge is now read from its theme");

  // Ceiling blocks the band: reported with the waiver note, no price proposal past the ceiling.
  const blocked = R.validatePrice("hc", { price: 144.95, cost: 60 });
  assert.ok(blocked.issues.some((i) => i.code === "ceiling_blocks_band"));
  assert.equal(blocked.proposed, null);
  assert.equal(R.validatePrice("cc", { price: 50 }), null);
});

test("rules: tier spread and seeded tier assignment are reproducible", () => {
  const d = R.tierDistribution([0, 0, 10, 20, 30, 40, 40, null, 0, 10]);
  assert.equal(d.total, 10);
  assert.equal(d.counts[0], 3);
  assert.equal(d.counts.wrong, 1);
  assert.equal(d.target_each, 2);
  assert.equal(d.gap[0], 1);
  assert.equal(R.assignTier("gid://shopify/Product/1", { 0: 5, 10: 5, 20: 1, 30: 5, 40: 5 }), 20);
  const counts = { 0: 2, 10: 2, 20: 2, 30: 2, 40: 2 };
  assert.equal(R.assignTier("gid://p/77", counts), R.assignTier("gid://p/77", counts), "same product → same tier");
});

/* ======================= fixtures ======================= */

function variant(id, price, compareAt = null, extra = {}) {
  return { id: `gid://shopify/ProductVariant/${id}`, sku: `SKU-${id}`, title: "M", price: String(price),
    compareAtPrice: compareAt == null ? null : String(compareAt), inventoryQuantity: 0, inventoryPolicy: "CONTINUE",
    inventoryItem: { tracked: false }, ...extra };
}
function product(n, { price = 64.95, compareAt = null, status = "ACTIVE", updatedAt, createdAt = "2026-08-01T00:00:00Z", publishedAt = "2026-08-01T00:00:00Z", media = 3, options = ["Size"], variants = null, collections = 0, type = "Shirt", handle = null, description = "A good shirt" } = {}) {
  return {
    id: `gid://shopify/Product/${n}`, handle: handle || `product-${n}`, title: `Product ${n}`, status, productType: type, tags: [],
    createdAt, updatedAt: updatedAt || `2026-10-0${1 + (n % 9)}T00:00:00Z`, publishedAt,
    description, seo: { title: null, description: null }, mediaCount: { count: media },
    options: options.map((name) => ({ name })), tracksInventory: false, totalInventory: 0,
    collections: { nodes: Array.from({ length: collections }, (_, i) => ({ id: `gid://shopify/Collection/${i}` })) },
    variantsCount: { count: (variants || [1]).length },
    variants: { nodes: variants || [variant(n, price, compareAt)] },
  };
}

/** Fake Shopify for H&C: token mint + cursor-paged products, filter by updated_at when asked. */
function fakeShopify(getAll, { failOnCall = null, throttleOnCall = null, costFor = null } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    assert.ok(url.startsWith(`https://${HC_DOMAIN}/admin/api/`), `only H&C with its own credentials, got ${url}`);
    const body = JSON.parse(init.body);
    assert.ok(!/\bmutation\b/i.test(body.query), "never a mutation");
    calls.push(body);
    n++;
    if (failOnCall === n) return new Response("bad gateway", { status: 502 });
    if (throttleOnCall === n) {
      // Shopify's real throttle answer: HTTP 200 with a THROTTLED error.
      return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 722, actualQueryCost: null, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 40, restoreRate: 50 } } } }), { status: 200 });
    }
    let all = [...getAll()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const q = body.variables.query || "";
    // Shopify's status filter: "status:active,draft" keeps only those statuses.
    const st = /status:([a-z,]+)/i.exec(q);
    if (st) { const keep = st[1].toUpperCase().split(","); all = all.filter((p) => keep.includes(p.status)); }
    const m = /updated_at:>='([^']+)'/.exec(q);
    if (m) all = all.filter((p) => p.updatedAt >= m[1]);
    const start = body.variables.after ? Number(body.variables.after.slice(2)) : 0;
    const nodes = all.slice(start, start + body.variables.first);
    const end = start + nodes.length;
    const out = { data: { productsCount: { count: all.length, precision: "EXACT" }, products: { pageInfo: { hasNextPage: end < all.length, endCursor: `c:${end}` }, nodes } } };
    if (costFor) out.extensions = { cost: costFor(n) };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, calls };
}

async function freshEnv(extra = {}) {
  _resetTokenCacheForTests();
  _resetGoogleCacheForTests();
  const DB = makeD1();
  return { DB, ...HC_ENV, ...extra };
}

/* ======================= sync ======================= */

test("sync: full read spreads over ticks with a saved cursor, then deltas use the updated_at filter; deleted products drop out on the next full read", async () => {
  const env = await freshEnv();
  let catalog = Array.from({ length: 45 }, (_, i) => product(i + 1));
  const fake = fakeShopify(() => catalog);
  assert.match(PRODUCTS_QUERY, /updatedAt/);

  const P = 4; // pages per tick for this test (the run's budget decides it live)
  const r1 = await syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl, pages: P });
  assert.equal(r1.read, P * PAGE_SIZE);
  assert.equal(r1.completed, false);
  assert.equal(cacheReady(await getSync(env.DB, "hc"), NOW).ready, false, "not trusted before the first full read completes");
  assert.match(cacheReady(await getSync(env.DB, "hc"), NOW).reason, /40 of 45 active\/draft/);
  const r2 = await syncStore(env, "hc", { nowMs: NOW + 15 * 60000, fetchImpl: fake.fetchImpl, pages: P });
  assert.equal(r2.completed, true);
  assert.equal(r2.kind, "full");
  assert.equal(fake.calls[P].variables.after, `c:${P * PAGE_SIZE}`, "resumed from the saved cursor");
  assert.equal(fake.calls[0].variables.query, "status:active,draft", "the full pass reads active + draft only");
  let s = await getSync(env.DB, "hc");
  assert.equal(s.watermark, "2026-10-09T00:00:00Z");
  assert.ok(cacheReady(s, NOW + 20 * 60000).ready);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_products`).first()).n, 45);

  // Delta: only changed products are read.
  catalog[0] = product(1, { price: 39.95, updatedAt: "2026-10-12T10:00:00Z" });
  const before = fake.calls.length;
  const r3 = await syncStore(env, "hc", { nowMs: NOW + 30 * 60000, fetchImpl: fake.fetchImpl });
  assert.equal(r3.kind, "delta");
  assert.equal(fake.calls[before].variables.query, "status:active,draft AND updated_at:>='2026-10-09T00:00:00Z'");
  assert.ok(r3.read < 45);
  const row = await env.DB.prepare(`SELECT variants FROM cat_products WHERE product_id = 'gid://shopify/Product/1'`).first();
  assert.equal(JSON.parse(row.variants)[0].price, 39.95);
  s = await getSync(env.DB, "hc");
  assert.equal(s.watermark, "2026-10-12T10:00:00Z");

  // A day later: full read again; a product deleted in Shopify leaves the copy.
  catalog = catalog.slice(1);
  const later = NOW + 25 * 3600000;
  for (let i = 0; i < 3; i++) await syncStore(env, "hc", { nowMs: later + i * 15 * 60000, fetchImpl: fake.fetchImpl, pages: P });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_products`).first()).n, 44);
});

test("sync: only active + draft are read; a store full of archived products completes and becomes fresh; archived drop out", async () => {
  const env = await freshEnv();
  // 30 active, 10 draft, 200 archived (the live stores' shape: many old archived products).
  let catalog = [
    ...Array.from({ length: 30 }, (_, i) => product(i + 1)),
    ...Array.from({ length: 10 }, (_, i) => product(100 + i, { status: "DRAFT" })),
    ...Array.from({ length: 200 }, (_, i) => product(1000 + i, { status: "ARCHIVED" })),
  ];
  const fake = fakeShopify(() => catalog);
  const r = await syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl });
  assert.equal(r.completed, true, "40 products = 4 pages: done in one run");
  assert.equal(r.read, 40);
  assert.ok(fake.calls.every((c) => /^status:active,draft\b/.test(c.variables.query)), "every page carries the status filter");
  const s = await getSync(env.DB, "hc");
  assert.ok(cacheReady(s, NOW + 60000).ready, "fresh");
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_products WHERE status = 'ARCHIVED'`).first()).n, 0);

  // A product archived later drops out on the next full read (it is no longer seen).
  catalog = catalog.map((p) => (p.id === "gid://shopify/Product/1" ? { ...p, status: "ARCHIVED", updatedAt: "2026-10-13T20:00:00Z" } : p));
  const later = NOW + 25 * 3600000;
  await syncStore(env, "hc", { nowMs: later, fetchImpl: fake.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_products WHERE product_id = 'gid://shopify/Product/1'`).first()).n, 0);
});

test("sync: a pass started before the status filter (unfiltered, live 2026-10-14) restarts with the filter", async () => {
  const env = await freshEnv();
  await env.DB.prepare(`INSERT INTO cat_sync (store, pass_kind, pass_query, pass_cursor, pass_started_at, pass_read) VALUES ('hc', 'full', NULL, 'c:760', ?, 760)`)
    .bind(new Date(NOW - 20 * 3600000).toISOString()).run();
  const fake = fakeShopify(() => Array.from({ length: 15 }, (_, i) => product(i + 1)));
  const r = await syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls[0].variables.after, null, "the old cursor belongs to another list: not reused");
  assert.equal(fake.calls[0].variables.query, "status:active,draft");
  assert.equal(r.completed, true);
  assert.ok(cacheReady(await getSync(env.DB, "hc"), NOW + 60000).ready);
});

test("sync: a THROTTLED page stops the tick cleanly (no error, cursor kept) and the next run resumes", async () => {
  const env = await freshEnv();
  const fake = fakeShopify(() => Array.from({ length: 45 }, (_, i) => product(i + 1)), { throttleOnCall: 3 });
  const r1 = await syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl });
  assert.equal(r1.status, "ok");
  assert.equal(r1.paused, "throttled");
  assert.equal(r1.read, 20, "two pages read before the throttle");
  assert.equal(r1.completed, false);
  let s = await getSync(env.DB, "hc");
  assert.equal(s.pass_cursor, "c:20", "cursor kept");
  assert.equal(s.last_error, null, "a throttle is a pause, not an error");
  assert.match(s.last_pause_reason, /THROTTLED/);
  const r2 = await syncStore(env, "hc", { nowMs: NOW + 20 * 60000, fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls[3].variables.after, "c:20", "resumed where it paused");
  assert.equal(r2.completed, true);
  s = await getSync(env.DB, "hc");
  assert.ok(cacheReady(s, NOW + 21 * 60000).ready);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_products`).first()).n, 45);
});

test("sync: stops before a page Shopify's cost bucket can't pay for; a pass reports size, pace and an ETA", async () => {
  const env = await freshEnv();
  // Bucket drains: after call 2 only 300 points are left for a 722-point page.
  const costFor = (n) => ({ requestedQueryCost: 722, actualQueryCost: 300,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: n >= 2 ? 300 : 900, restoreRate: 50 } });
  const fake = fakeShopify(() => Array.from({ length: 95 }, (_, i) => product(i + 1)), { costFor });
  const r = await syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl });
  assert.equal(r.paused, "cost");
  assert.equal(r.calls, 2, "no third call was sent");
  assert.equal(r.read, 20);
  const s = await getSync(env.DB, "hc");
  assert.equal(s.last_error, null);
  assert.equal(s.pass_total, 95);
  const p = passProgress(s, NOW + 30 * 60000); // 20 read in 30 minutes → 40 an hour, 75 left
  assert.equal(p.read, 20);
  assert.equal(p.total, 95);
  assert.equal(p.products_per_hour, 40);
  assert.equal(p.eta_hours, 1.9);
  assert.ok(p.last_pause && /budget/.test(p.last_pause.reason));
});

test("store guard: cost is exposed, shopifyGraphQL still returns data only, a throttle is a typed THROTTLED error", async () => {
  const env = await freshEnv();
  const cost = { requestedQueryCost: 12, actualQueryCost: 10, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 } };
  let mode = "ok";
  const fetchImpl = async (url) => {
    if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    if (mode === "throttled") return new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost } }), { status: 200 });
    if (mode === "other") return new Response(JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist" }] }), { status: 200 });
    return new Response(JSON.stringify({ data: { shop: { name: "H&C" } }, extensions: { cost } }), { status: 200 });
  };
  const r = await shopifyGraphQLWithCost(env, "hc", "{ shop { name } }", {}, { fetchImpl });
  assert.deepEqual(r.data, { shop: { name: "H&C" } });
  assert.equal(r.cost.requestedQueryCost, 12);
  assert.equal(r.cost.throttleStatus.currentlyAvailable, 990);
  assert.deepEqual(await shopifyGraphQL(env, "hc", "{ shop { name } }", {}, { fetchImpl }), { shop: { name: "H&C" } }, "unchanged for existing callers");
  mode = "throttled";
  await assert.rejects(shopifyGraphQL(env, "hc", "{ shop { name } }", {}, { fetchImpl }),
    (e) => e instanceof StoreGuardError && e.code === "THROTTLED" && e.cost.throttleStatus.currentlyAvailable === 990);
  mode = "other";
  await assert.rejects(shopifyGraphQL(env, "hc", "{ shop { name } }", {}, { fetchImpl }), (e) => e.code === "GRAPHQL_ERRORS");
});

test("sync: the run's page budget is shared across stores and stays within the subrequest limit", () => {
  assert.equal(SYNC_PAGE_BUDGET, 30);
  assert.equal(pagesForStore(30, 3), 10);
  assert.equal(pagesForStore(27, 2), 12, "pages a finished store didn't use go to the next (capped at 12)");
  assert.equal(pagesForStore(0, 1), 0);
  assert.ok(MAX_PAGES_PER_TICK <= 12);
  assert.ok(SYNC_PAGE_BUDGET + 3 /* token mints */ + 7 /* Merchant Center */ <= 50, "fits the strictest Worker subrequest limit");
});

test("sync: not wired is reported, never thrown; a failed page keeps the cursor and the error", async () => {
  const env = await freshEnv();
  const r = await syncStore(env, "aub", { nowMs: NOW, fetchImpl: async () => { throw new Error("no network in tests"); } });
  assert.equal(r.status, "not_wired");
  const fake = fakeShopify(() => Array.from({ length: 25 }, (_, i) => product(i + 1)), { failOnCall: 2 });
  await assert.rejects(syncStore(env, "hc", { nowMs: NOW, fetchImpl: fake.fetchImpl }));
  const s = await getSync(env.DB, "hc");
  assert.equal(s.pass_cursor, "c:10", "page 1 kept");
  assert.match(s.last_error, /HTTP 502/);
  const again = await syncStore(env, "hc", { nowMs: NOW + 60000, fetchImpl: fake.fetchImpl });
  assert.equal(again.completed, true);
});

/* ======================= agents (pure parts) ======================= */

function cached(n, opts = {}) {
  const p = product(n, opts);
  return {
    product_id: p.id, handle: p.handle, title: p.title, status: p.status, product_type: p.productType, tags: [],
    created_at: p.createdAt, published_at: p.publishedAt, description_len: p.description.length,
    seo_title: null, seo_description: null, image_count: p.mediaCount.count, option_names: opts.options || ["Size"],
    collections_count: p.collections.nodes.length, variants_count: p.variants.nodes.length,
    variants: p.variants.nodes.map((v) => ({ id: v.id, sku: v.sku, title: v.title, price: Number(v.price),
      compareAt: v.compareAtPrice == null ? null : Number(v.compareAtPrice), qty: v.inventoryQuantity, policy: v.inventoryPolicy, tracked: v.inventoryItem.tracked })),
  };
}

/** A cost map like readCosts returns: {"product:<gid>": usd, "sku:<SKU>": usd}. */
const costMap = (o) => new Map(Object.entries(o).map(([k, usd]) => [k, { usd, fxEstimated: false, key: `cost:${k}` }]));
const pid = (n) => `gid://shopify/Product/${n}`;

test("pricing: a held product is not re-proposed on COGS; floor still applies elsewhere; cost unknown → no COGS judgement", () => {
  const coat = { ...cached(1, { price: 114.95 }), product_type: "Outerwear" };
  assert.equal(isHoldCandidate("hc", coat, 114.95), true);
  assert.equal(isHoldCandidate("aub", coat, 114.95), false);
  assert.equal(isHoldCandidate("hc", coat, 109.95), false);
  const f = checkProduct("hc", coat, costMap({ [`product:${pid(1)}`]: 45 }), { held: true }); // 39% COGS, but held
  assert.equal(f.ok, true);
  assert.equal(f.held, true);
  const notHeld = checkProduct("hc", coat, costMap({ [`product:${pid(1)}`]: 45 }), null);
  assert.equal(notHeld.ok, false);
  const shirt = checkProduct("hc", cached(2, { price: 39.95 }));
  assert.equal(shirt.ok, false);
  assert.equal(shirt.changes[0].new_price, 44.95);
  assert.equal(shirt.cost_usd, null);
});

test("holds: outerwear found by type, tags or title alike; the hold's cost is remembered and a cost change re-proposes", async () => {
  const DB = makeD1();
  const byTitle = { ...cached(1, { price: 114.95 }), title: "Wool Overcoat", product_type: "Apparel", tags: [] };
  const byTag = { ...cached(2, { price: 114.95 }), product_type: "Apparel", tags: ["Jackets"] };
  const shirt = { ...cached(3, { price: 114.95 }), product_type: "Shirt" };
  for (const p of [byTitle, byTag]) assert.equal(isOuterwear(p), true);
  assert.equal(isOuterwear(shirt), false);

  // Day 1: cost $45 → hold recorded with that cost; product 2's cost is unknown → still held.
  let holds = await resolveHolds(DB, "hc", [byTitle, byTag, shirt], costMap({ [`product:${pid(1)}`]: 45 }), NOW);
  assert.equal(holds.get(pid(1)).held, true);
  assert.equal(holds.get(pid(1)).held_cost, 45);
  assert.equal(holds.get(pid(2)).held, true);
  assert.equal(holds.has(pid(3)), false);
  // Day 2: same cost → held; product 2's first known cost is remembered → held.
  holds = await resolveHolds(DB, "hc", [byTitle, byTag], costMap({ [`product:${pid(1)}`]: 45, [`product:${pid(2)}`]: 50 }), NOW + 86400000);
  assert.equal(holds.get(pid(1)).held, true);
  assert.equal(holds.get(pid(2)).held, true);
  assert.equal((await DB.prepare(`SELECT cost_usd FROM cat_holds WHERE product_id = ?`).bind(pid(2)).first()).cost_usd, 50);
  // Day 3: product 1's cost changed → hold lifted and re-proposed, with the reason.
  const costs = costMap({ [`product:${pid(1)}`]: 48, [`product:${pid(2)}`]: 50 });
  holds = await resolveHolds(DB, "hc", [byTitle, byTag], costs, NOW + 2 * 86400000);
  const h = holds.get(pid(1));
  assert.equal(h.held, false);
  assert.match(h.reason, /cost changed from \$45\.00 to \$48\.00/);
  const f = checkProduct("hc", byTitle, costs, h);
  assert.equal(f.ok, false);
  assert.ok(f.issues.some((i) => i.code === "hold_lifted"));
  assert.ok(f.changes[0].new_price > 114.95, "re-proposed to band");
  // Cost unknown later is not a change → held.
  holds = await resolveHolds(DB, "hc", [byTag], new Map(), NOW + 3 * 86400000);
  assert.equal(holds.get(pid(2)).held, true);
});

test("pricing: each variant is judged on its own cost; a variant without a cost gets no COGS proposal", () => {
  const p = cached(9, { variants: [variant("A", 74.95), variant("B", 54.95), variant("C", 54.95)] });
  const costs = costMap({ "sku:SKU-A": 25, "sku:SKU-B": 15 }); // C unknown
  const f = checkProduct("hc", p, costs);
  const byVariant = Object.fromEntries(f.changes.map((c) => [c.variant_id.split("/").pop(), c]));
  assert.equal(byVariant.A.new_price, 75.95, "A: 25/74.95 = 33.4% → raise to 75.95");
  assert.equal(byVariant.B.new_price, 50.95, "B: 15/54.95 = 27.3% → cut to the dearest .95 at ≥29% (not raised on A's cost)");
  assert.equal(byVariant.C, undefined, "C: cost unknown → no COGS proposal");
  assert.equal(f.cost_partial, true);
  // Margin Guard uses the same per-variant costs.
  const m = judgeProduct("hc", p, costs);
  assert.equal(m.cost_usd, 25);
  assert.equal(m.variants_cost_unknown, 1);
});

test("rules: COGS is compared unrounded (33.004% is above a 33% band) and EUR costs round up", () => {
  // $33.00 at $99.99 = 33.0033%: rounding to 4 places would have called it 33.00% (in band).
  const r = R.validatePrice("hc", { price: 99.99, cost: 33 });
  assert.ok(r.issues.some((i) => i.code === "cogs_above_band"), "33.003% must not count as in band");
  assert.equal(R.cogsPct(33.004, 100), 0.33004);
  assert.equal(R.costToUsd(33.004).usd, 33.01, "a cost never rounds down");
  assert.ok(R.validatePrice("hc", { price: 100, cost: 33.004 }).issues.some((i) => i.code === "cogs_above_band"));
  assert.ok(!R.validatePrice("hc", { price: 100, cost: 33 }).issues.some((i) => i.code === "cogs_above_band"), "exactly 33% is in band");
  assert.equal(R.costToUsd({ eur: 10.01 }).usd, 11.72, "€10.01 × 1.17 = 11.7117 → $11.72, never rounded down");
});

test("margin guard: unknown cost is never assumed; loss after fees and out-of-band are flagged with break-even ROAS", async () => {
  const DB = makeD1();
  // Same keys/format the Supplier Quote Desk writes (source "kfb_quote").
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, source, observed_at) VALUES ('hc','product','cost:sku:SKU-1','{"eur":30}','kfb_quote','2026-10-10')`).run();
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, source, observed_at) VALUES ('hc','product','cost:product:gid://shopify/Product/2','18','kfb_quote','2026-10-10')`).run();
  const costs = await readCosts(DB, "hc");
  const p1 = cached(1, { price: 44.95 }), p2 = cached(2, { price: 64.95 }), p3 = cached(3);
  const c1 = productCost(costs, p1);
  assert.equal(c1.usd, 35.1);
  assert.equal(c1.fxEstimated, true);
  assert.equal(productCost(costs, p3), null, "no cost → null, not 33%");
  assert.equal(judgeProduct("hc", p3, costs), null);
  const f1 = judgeProduct("hc", p1, costs); // 78% COGS
  assert.ok(f1.issues.some((i) => i.code === "cogs_above_band"));
  assert.equal(f1.breakeven_roas, 6.26); // 1 / (0.2191 × 0.881 − 0.0334)
  // 18 / 64.95 = 27.7%: under H&C's 29% band bottom → flagged low (priced above the rules).
  const f2 = judgeProduct("hc", p2, costs);
  assert.equal(f2.severity, "low");
  assert.deepEqual(f2.issues.map((i) => i.code), ["cogs_below_band"]);
  assert.equal(judgeProduct("hc", cached(4, { price: 64.95 }), costMap({ [`product:${pid(4)}`]: 20 })), null, "30.8% is in band");
  assert.equal(judgeProduct("hc", p1, costs, { held: true }), null, "held: band flags suppressed (and it's not a loss)");
});

test("margin guard: contribution after refunds and fees, and the loss line", () => {
  assert.equal(contributionPerDollar(0.3), Math.round((0.7 * 0.881 - 0.0334) * 10000) / 10000);
  assert.ok(contributionPerDollar(0.97) < 0);
  const p = cached(1, { price: 44.95 });
  const f = judgeProduct("hc", p, costMap({ [`product:${pid(1)}`]: 44 }), { held: true });
  assert.ok(f.issues.some((i) => i.code === "loss_after_fees"), "a hold never hides a loss");
  assert.equal(f.breakeven_roas, null, "can't break even at any ROAS");
});

test("status: sold-out active, no images, drafts in collections", () => {
  const sold = cached(1, { variants: [variant(1, 64.95, null, { inventoryPolicy: "DENY", inventoryItem: { tracked: true }, inventoryQuantity: 0 })] });
  assert.deepEqual(statusProposals(sold).map((x) => x.code), ["sold_out_active"]);
  const sellable = cached(2, { variants: [variant(2, 64.95, null, { inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true }, inventoryQuantity: 0 })] });
  assert.deepEqual(statusProposals(sellable), [], "continue-selling on → not sold out");
  assert.deepEqual(statusProposals(cached(3, { media: 0 })).map((x) => x.code), ["no_images"]);
  assert.deepEqual(statusProposals(cached(4, { status: "DRAFT", collections: 2 })).map((x) => x.code), ["inactive_in_collections"]);
  assert.deepEqual(statusProposals(cached(5, { status: "DRAFT" })), []);
  const partial = { ...sold, variants_count: 5 };
  assert.deepEqual(statusProposals(partial), [], "not every variant read → no sold-out claim");
});

test("new-product check: the spec's basics", () => {
  const handles = new Set(["linen-shirt", "linen-shirt-1"]);
  const p = { ...cached(1, { price: 42.99, media: 0, options: ["Color"], handle: "linen-shirt-1", description: "" }), handle: "linen-shirt-1", description_len: 0, option_names: ["Color"] };
  const r = checkNewProduct("hc", p, { cost: null, hasSizeChart: false, handles, tierCounts: { 0: 10, 10: 2, 20: 10, 30: 10, 40: 10 } });
  const codes = r.issues.map((i) => i.code);
  for (const c of ["no_description", "no_images", "no_size_option", "cost_unknown", "possible_duplicate", "below_floor", "unclean_price", "tier_unassigned"]) assert.ok(codes.includes(c), c);
  assert.equal(r.suggested_tier, 10);
  assert.equal(r.passed, false);
  const ok = checkNewProduct("hc", { ...cached(2, { price: 64.95 }), seo_title: "x", seo_description: "y" }, { cost: { usd: 20 }, hasSizeChart: true, handles, tierCounts: { 0: 1, 10: 5, 20: 5, 30: 5, 40: 5 } });
  assert.equal(ok.passed, true, JSON.stringify(ok.issues));
});

test("feed health: Merchant API product → disapproved/limited finding with Google's words", () => {
  const f = findingFromProduct({
    name: "accounts/123/products/en~US~sku1", offerId: "sku1", productAttributes: { title: "Linen shirt" },
    productStatus: {
      destinationStatuses: [{ reportingContext: "SHOPPING_ADS", disapprovedCountries: ["US"] }],
      itemLevelIssues: [{ code: "image_too_small", severity: "DISAPPROVED", description: "Image too small", applicableCountries: ["US"] },
        { code: "x", severity: "NOT_IMPACTED", description: "fine" }],
    },
  });
  assert.equal(f.status, "disapproved");
  assert.equal(f.issues.length, 1);
  assert.equal(f.issues[0].description, "Image too small");
  assert.equal(findingFromProduct({ productStatus: { itemLevelIssues: [{ severity: "NOT_IMPACTED" }] } }), null);
  const lim = findingFromProduct({ productStatus: { itemLevelIssues: [{ severity: "DEMOTED", description: "Missing gtin" }] } });
  assert.equal(lim.status, "limited");
});

/* ======================= the whole department ======================= */

async function primedEnv(extra = {}) {
  const env = await freshEnv(extra);
  const catalog = [
    product(1, { price: 39.95 }),                                   // under floor
    product(2, { price: 159.95 }),                                  // over ceiling
    product(3, { price: 64.95, compareAt: 129.95 }),                // 50% badge: wrong tier
    product(4, { price: 64.95, compareAt: R.compareAtFor("hc", 64.95, 20) }), // fine
    product(5, { price: 64.95, media: 0 }),                         // no images
    product(6, { price: 64.95, status: "DRAFT", collections: 1 }),  // draft in a collection
    product(7, { price: 59.95, createdAt: "2026-10-12T15:00:00Z", publishedAt: "2026-10-12T15:00:00Z" }), // new
  ];
  const fake = fakeShopify(() => catalog);
  // core cost: product 4 at $20 (30.8% — in band)
  await env.DB.prepare(`INSERT INTO core_facts (store, area, key, value, source, observed_at) VALUES ('hc','product','cost:sku:SKU-4','20','test','2026-10-10')`).run();
  return { env, fake, catalog };
}

test("runCatalog: reads, checks, one digest per store per agent, ONE deduped approval, nothing written outside D1", async () => {
  const { env, fake } = await primedEnv();
  const writes = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).includes(HC_DOMAIN)) writes.push(url); // anything not Shopify-read would be an external call
    return fake.fetchImpl(url, init);
  };
  const out = await runCatalog(env, { nowMs: NOW, fetchImpl });
  assert.equal(out.sync.hc.completed, true);
  assert.equal(out.sync.aub.status, "not_wired");
  assert.equal(out.agents["cat.pricing.hc"].status, "ok");
  assert.equal(out.agents["cat.pricing.hc"].checked, 6, "only ACTIVE products are priced");
  assert.equal(out.agents["cat.pricing.aub"].status, "waiting");
  assert.equal(out.agents["cat.feed_health.hc"].status, "not_wired", "no merchant id configured → not wired, not guessed");
  assert.deepEqual(writes, [], "no Google, Merchant Center or other external call when not wired");

  const pricing = (await env.DB.prepare(`SELECT * FROM cat_runs WHERE agent = 'cat.pricing' AND store = 'hc'`).first());
  const findings = JSON.parse(pricing.findings);
  const codes = findings.flatMap((f) => f.issues.map((i) => i.code));
  for (const c of ["below_floor", "above_ceiling", "compare_at_tier_wrong"]) assert.ok(codes.includes(c), c);
  assert.equal(findings[0].severity, "high");

  const approvals = (await env.DB.prepare(`SELECT * FROM approvals WHERE requested_by = 'cat.pricing'`).all()).results;
  assert.equal(approvals.length, 1, "one approval for the worst issues");
  const opts = JSON.parse(approvals[0].options);
  assert.ok(opts.length <= 4 && !opts.some((o) => o.id === "reject" || o.id === "view"));
  assert.match(opts[0].detail, /\$39\.95 → \$44\.95/);
  assert.match(approvals[0].title, /Shadow/);

  const digests = (await env.DB.prepare(`SELECT kind, store FROM events WHERE kind LIKE 'catalog.%digest' ORDER BY kind`).all()).results;
  assert.deepEqual(digests.map((d) => d.kind), ["catalog.margin_digest", "catalog.new_product_digest", "catalog.pricing_digest", "catalog.status_digest"]);
  assert.ok(digests.every((d) => d.store === "hc"));

  const status = JSON.parse((await env.DB.prepare(`SELECT findings FROM cat_runs WHERE agent = 'cat.status' AND store = 'hc'`).first()).findings);
  assert.deepEqual(status.map((f) => f.issues[0].code).sort(), ["inactive_in_collections", "no_images"]);
  const fresh = JSON.parse((await env.DB.prepare(`SELECT findings FROM cat_runs WHERE agent = 'cat.prepublish' AND store = 'hc'`).first()).findings);
  assert.deepEqual(fresh.map((f) => f.product_id), ["gid://shopify/Product/7"]);
  const margin = JSON.parse((await env.DB.prepare(`SELECT summary FROM cat_runs WHERE agent = 'cat.margin_guard' AND store = 'hc'`).first()).summary);
  assert.equal(margin.cost_known, 1);
  assert.equal(margin.cost_unknown, 5);

  // Second tick in the same 15 minutes and the same day: no new reads, no new runs, no new approval.
  const callsBefore = fake.calls.length;
  const out2 = await runCatalog(env, { nowMs: NOW + 60000, fetchImpl });
  assert.equal(fake.calls.length, callsBefore, "sync throttled to every 15 min");
  assert.deepEqual(Object.keys(out2.agents).filter((k) => k.endsWith(".hc")), [], "daily checks run once a day");

  // Next day: checks run again, same worst set → no duplicate approval.
  const tomorrow = NOW + 24 * 3600000;
  await runCatalog(env, { nowMs: tomorrow, fetchImpl });
  for (let i = 1; i <= 2; i++) await runCatalog(env, { nowMs: tomorrow + i * 15 * 60000, fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE requested_by = 'cat.pricing'`).first()).n, 1);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'catalog.pricing_digest'`).first()).n, 2);

  // Dashboard state
  const st = await catalogState(env, { nowMs: tomorrow + 3600000 });
  assert.equal(st.mode, "shadow");
  const hc = st.stores.find((s) => s.store === "hc");
  assert.equal(hc.products.active, 6);
  assert.ok(hc.pricing.findings.length <= 50);
  assert.equal(hc.merchant_center.status, "not_wired");
  assert.match(hc.merchant_center.note, /GMC_MERCHANT_ID_HC/);
  assert.equal(st.stores.find((s) => s.store === "aub").pricing.status, "waiting");
  assert.equal(st.pending_approvals.length, 1);
  assert.ok(!st.stores.some((s) => s.store === "cc" || s.store === "tund"), "non-live stores get no workers");
});

test("runCatalog: approvals can be switched off; before 06:00 store time daily checks wait", async () => {
  const { env, fake } = await primedEnv({ CATALOG_APPROVALS: "0" });
  const early = Date.parse("2026-10-13T08:00:00Z"); // 04:00 New York
  const out = await runCatalog(env, { nowMs: early, fetchImpl: fake.fetchImpl });
  assert.equal(out.sync.hc.completed, true);
  assert.equal(out.agents["cat.pricing.hc"], undefined);
  await runCatalog(env, { nowMs: NOW, fetchImpl: fake.fetchImpl });
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first()).n, 0);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM cat_runs WHERE agent = 'cat.pricing' AND store = 'hc' AND status = 'ok'`).first()).n, 1);
});

test("runCatalog: a stale product copy means 'waiting', keeping the last findings; a failing read is logged at most hourly", async () => {
  const { env, fake } = await primedEnv();
  await runCatalog(env, { nowMs: NOW, fetchImpl: fake.fetchImpl });
  const broken = async (url, init) => (url.endsWith("/access_token") ? fake.fetchImpl(url, init) : new Response("nope", { status: 500 }));
  const later = NOW + 26 * 3600000;
  for (let i = 0; i < 4; i++) await runCatalog(env, { nowMs: later + i * 15 * 60000, fetchImpl: broken });
  const run = await env.DB.prepare(`SELECT * FROM cat_runs WHERE agent = 'cat.pricing' AND store = 'hc'`).first();
  assert.equal(run.status, "waiting");
  assert.ok(JSON.parse(run.findings).length > 0, "yesterday's findings kept for the page");
  const errs = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'error.catalog' AND store = 'hc'`).first()).n;
  assert.equal(errs, 1, "one error event per hour, not one per tick");
});

test("feed health: merchant id from env, disapprovals read from the Merchant API; Merchant API disabled → not wired", async () => {
  const { env, fake } = await primedEnv({ GMC_MERCHANT_ID_HC: "1234567", APPROVAL_SIGNING_KEY: "k".repeat(48), GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec" });
  const { enc_token, iv } = await encryptToken(env, "1//refresh");
  await env.DB.prepare(`INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at, verified_at) VALUES ('google','reillyworking26@gmail.com','x',?,?,'t','t')`).bind(enc_token, iv).run();
  assert.deepEqual(await merchantIdFor(env, "hc"), { id: "1234567", source: "env GMC_MERCHANT_ID_HC" });
  assert.equal(await merchantIdFor(env, "aub"), null);
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "g", expires_in: 3600 }), { status: 200 });
    if (url.startsWith("https://merchantapi.googleapis.com/")) {
      seen.push({ url, method: (init && init.method) || "GET" });
      return new Response(JSON.stringify({ products: [
        { offerId: "a", productAttributes: { title: "A" }, productStatus: { itemLevelIssues: [{ severity: "DISAPPROVED", description: "Price mismatch" }] } },
        { offerId: "b", productStatus: { itemLevelIssues: [] } },
      ] }), { status: 200 });
    }
    return fake.fetchImpl(url, init);
  };
  const out = await runCatalog(env, { nowMs: NOW, fetchImpl });
  assert.equal(out.agents["cat.feed_health.hc"].status, "ok");
  assert.equal(out.agents["cat.feed_health.hc"].disapproved, 1);
  assert.ok(seen.every((s) => s.method === "GET"), "read only");
  assert.match(seen[0].url, /\/products\/v1\/accounts\/1234567\/products\?/);

  // Merchant API not enabled on the Cloud project → not wired (with the reason), not an alarm.
  const env2 = (await primedEnv({ GMC_MERCHANT_ID_HC: "1234567", APPROVAL_SIGNING_KEY: "k".repeat(48), GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec" })).env;
  const t2 = await encryptToken(env2, "1//refresh");
  await env2.DB.prepare(`INSERT INTO oauth_tokens (provider, account, scopes, enc_token, iv, created_at, verified_at) VALUES ('google','reillyworking26@gmail.com','x',?,?,'t','t')`).bind(t2.enc_token, t2.iv).run();
  const disabled = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "g", expires_in: 3600 }), { status: 200 });
    if (url.startsWith("https://merchantapi.googleapis.com/")) return new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Merchant API has not been used in project 1 before or it is disabled", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403 });
    return fake.fetchImpl(url, init);
  };
  const out2 = await runCatalog(env2, { nowMs: NOW, fetchImpl: disabled });
  assert.equal(out2.agents["cat.feed_health.hc"].status, "not_wired");
  assert.match(out2.agents["cat.feed_health.hc"].reason, /not enabled/);
});

test("daily claim is atomic: two overlapping runs can't both claim the same day", async () => {
  const DB = makeD1();
  assert.equal(await claimDaily(DB, "x", "2026-10-13", NOW), true);
  assert.equal(await claimDaily(DB, "x", "2026-10-13", NOW), false);
  assert.equal(await claimDaily(DB, "x", "2026-10-14", NOW), true);
});

test("approval: says when the $144.95 ceiling stops the band, offers the waiver as its own option, and says nothing is written", async () => {
  const env = await freshEnv();
  const catalog = [product(1, { price: 144.95 }), product(2, { price: 39.95 })];
  const fake = fakeShopify(() => catalog);
  // $60 at $144.95 = 41% COGS: the ceiling stops H&C's 33% band.
  await env.DB.prepare(`INSERT INTO core_facts (store, area, key, value, source, observed_at) VALUES ('hc','product','cost:sku:SKU-1','60','kfb_quote','2026-10-10')`).run();
  await runCatalog(env, { nowMs: NOW, fetchImpl: fake.fetchImpl });
  const ap = (await env.DB.prepare(`SELECT * FROM approvals WHERE requested_by = 'cat.pricing'`).all()).results;
  assert.equal(ap.length, 1);
  const opts = JSON.parse(ap[0].options);
  assert.deepEqual(opts.map((o) => o.id), ["approve_batch", "waive_ceiling", "leave"]);
  const waive = opts.find((o) => o.id === "waive_ceiling");
  assert.match(waive.label, /Waive the \$144\.95 ceiling for 1 product/);
  assert.match(waive.detail, /Product 1: stays \$144\.95/);
  assert.match(waive.detail, /ceiling stops it reaching its COGS band \(COGS 41\.4% even at \$144\.95\)/);
  assert.ok(!/Product 1/.test(opts[0].detail), "the capped product isn't in the price batch (no price change)");
  assert.equal(SHADOW_NOTE, "Shadow: approving records your yes; nothing is written to Shopify — change it yourself.");
  assert.ok(ap[0].title.includes("approving records your yes; nothing is written to Shopify — change it yourself"));
  for (const o of opts) assert.ok(o.detail.includes("nothing is written to Shopify — change it yourself"), o.id);
});

test("new-product check: calls the Supplier's preflightProduct gate and shows its flags; a failing gate doesn't break the check", async () => {
  const DB = makeD1();
  const p = { ...cached(1, { price: 64.95 }), handle: "linen-shirt" };
  const none = await supplyCheck(DB, "hc", p);
  assert.equal(none.ok, false);
  assert.match(none.reasons[0], /no KFB quote on file/);
  const ins = (status, remark, at) => DB.prepare(`INSERT INTO kfb_quotes (store, product_handle, status, cost, currency, quoted_at, remark, source, imported_at) VALUES ('hc','linen-shirt',?,?, 'EUR', ?, ?, 'manual', ?)`)
    .bind(status, status === "quoted" ? 12 : null, at, remark, at).run();
  await ins("quoted", null, "2026-10-10T00:00:00Z");
  assert.equal((await supplyCheck(DB, "hc", p)).ok, true);
  await ins("denied", "out of stock at factory", "2026-10-12T00:00:00Z");
  const denied = await supplyCheck(DB, "hc", p);
  assert.equal(denied.ok, false);
  assert.match(denied.reasons[0], /KFB denied it: "out of stock at factory"/);
  const r = checkNewProduct("hc", p, { cost: null, handles: new Set(), tierCounts: null, supply: denied });
  assert.ok(r.issues.some((i) => i.code === "supply_preflight" && /denied/.test(i.message)));
  // Supplier tables missing / broken → info, not a crash.
  const broken = { prepare() { throw new Error("no such table: kfb_quotes"); } };
  const err = await supplyCheck(broken, "hc", p);
  assert.match(err.error, /no such table/);
  const r2 = checkNewProduct("hc", p, { cost: null, handles: new Set(), tierCounts: null, supply: err });
  assert.ok(r2.issues.some((i) => i.code === "supply_preflight_unavailable" && i.severity === "info"));
});

test("new-product check: 'no KFB quote' is info while quotes aren't wired or the product is under 2 days old, medium otherwise", async () => {
  const DB = makeD1();
  const now = NOW;
  const old = { ...cached(1, { price: 64.95, publishedAt: "2026-10-10T12:00:00Z" }), handle: "old-shirt", published_at: "2026-10-10T12:00:00Z" }; // ~3 days
  const young = { ...cached(2, { price: 64.95 }), handle: "new-shirt", published_at: "2026-10-12T20:00:00Z" };             // ~0.75 days
  const ctx = async (p) => ({ cost: null, handles: new Set(), tierCounts: null, supply: await supplyCheck(DB, "hc", p), nowMs: now });
  const sev = (r, code) => (r.issues.find((i) => i.code === code) || {}).severity;

  // Not wired: kfb_quotes has no rows for H&C → info even for the 3-day-old product.
  let s = await supplyCheck(DB, "hc", old);
  assert.equal(s.quotes_wired, false);
  let r = checkNewProduct("hc", old, await ctx(old));
  assert.equal(sev(r, "supply_no_quote_yet"), "info");
  assert.equal(sev(r, "supply_preflight"), undefined);

  // Wired (a quote exists for another product in this store; another store's quotes don't count).
  await DB.prepare(`INSERT INTO kfb_quotes (store, product_handle, status, cost, currency, quoted_at, source, imported_at) VALUES ('aub','x','quoted',10,'EUR','2026-10-01T00:00:00Z','manual','2026-10-01T00:00:00Z')`).run();
  assert.equal((await supplyCheck(DB, "hc", old)).quotes_wired, false, "only this store's quotes count");
  await DB.prepare(`INSERT INTO kfb_quotes (store, product_handle, status, cost, currency, quoted_at, source, imported_at) VALUES ('hc','other','quoted',10,'EUR','2026-10-01T00:00:00Z','manual','2026-10-01T00:00:00Z')`).run();
  r = checkNewProduct("hc", old, await ctx(old));
  assert.equal(sev(r, "supply_preflight"), "medium", "wired and older than 2 days → medium");
  assert.equal(r.passed, false);
  r = checkNewProduct("hc", young, await ctx(young));
  assert.equal(sev(r, "supply_no_quote_yet"), "info", "younger than 2 days → info");
  assert.equal(sev(r, "supply_preflight"), undefined);

  // A denial is never softened, however young the product.
  await DB.prepare(`INSERT INTO kfb_quotes (store, product_handle, status, quoted_at, remark, source, imported_at) VALUES ('hc','new-shirt','denied','2026-10-13T00:00:00Z','no stock','manual','2026-10-13T00:00:00Z')`).run();
  r = checkNewProduct("hc", young, await ctx(young));
  assert.equal(sev(r, "supply_preflight"), "medium");
  assert.match(r.issues.find((i) => i.code === "supply_preflight").message, /denied/);
});

test("rules: Auberlane $30 minimum margin per unit (Reilly: 'yes'): known cost only; unknown cost is null, never a pass; no exemption", () => {
  assert.equal(R.STORE_PRICING.aub.minMarginUsd, 30);
  // $44.95 − $20 = $24.95 → under $30: a medium issue.
  const low = R.validatePrice("aub", { price: 44.95, cost: 20 });
  const issue = low.issues.find((i) => i.code === "below_min_margin");
  assert.ok(issue, "flagged");
  assert.equal(issue.severity, "medium");
  assert.deepEqual(low.minMargin, { required: 30, margin: 24.95, met: false });
  assert.equal(low.ok, false);
  // Exactly $30 passes; well above passes (a high margin is a pass, not an exemption).
  assert.equal(R.validatePrice("aub", { price: 59.95, cost: 29.95 }).minMargin.met, true);
  assert.ok(!R.validatePrice("aub", { price: 69.95, cost: 20 }).issues.some((i) => i.code === "below_min_margin"));
  // EUR cost converts rounded up, so the margin is never overstated: €20 × 1.17 = $23.40.
  assert.equal(R.validatePrice("aub", { price: 52.95, cost: { eur: 20 } }).minMargin.margin, 29.55);
  // Unknown cost: null, never a pass, and no issue invented.
  const unknown = R.validatePrice("aub", { price: 44.95 });
  assert.deepEqual(unknown.minMargin, { required: 30, margin: null, met: null });
  assert.ok(!unknown.issues.some((i) => i.code === "below_min_margin"));
  // Stores without the rule have no check at all (null, not "met").
  assert.equal(R.validatePrice("hc", { price: 44.95, cost: 14 }).minMargin, null);
  assert.equal(R.validatePrice("mar", { price: 49.95, cost: 14 }).minMargin, null);
});

test("rules: the minimum margin is checked on the PROPOSED price too, and puts the product in front of Reilly", async () => {
  // Today $164.95 − $120 = $44.95 is fine; the rules would cut it to the $144.95 ceiling → $24.95.
  const rec = R.recommendPrice("aub", 164.95, 120);
  assert.equal(rec.price, 144.95);
  assert.deepEqual(rec.minMargin, { required: 30, margin: 24.95, met: false });
  assert.match(rec.reason, /under the \$30 minimum margin/);
  const v = R.validatePrice("aub", { price: 164.95, cost: 120 });
  const issue = v.issues.find((i) => i.code === "below_min_margin");
  assert.ok(issue);
  assert.match(issue.message, /rules' price \$144\.95 would leave \$24\.95/);
  assert.equal(R.recommendPrice("aub", 64.95, null).minMargin.met, null, "unknown cost: null, never a pass");

  // Pricing run: a below-minimum product is asked about (below_min_margin is an approval code).
  const DB = makeD1();
  const p = cached(7, { price: 144.95 });
  await DB.prepare(`INSERT INTO core_facts (store, area, key, value, kind, source, observed_at, live) VALUES ('aub', 'supplier', ?, '120', 'observation', 'test', ?, 1)`)
    .bind(`cost:product:${pid(7)}`, "2026-10-13T00:00:00Z").run();
  const out = await runPricingStore({ DB }, "aub", [p], { nowMs: Date.parse("2026-10-13T16:00:00Z"), day: "2026-10-13" });
  assert.ok(out.approvalId, "asked about");
  const ap = await DB.prepare(`SELECT title, options FROM approvals WHERE id = ?`).bind(out.approvalId).first();
  assert.match(ap.title, /floor\/ceiling\/COGS\/margin/);
  assert.match(ap.options, /below min margin/);
});
