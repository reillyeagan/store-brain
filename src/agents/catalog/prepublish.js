/**
 * cat.prepublish — New-Product Check (SHADOW: flags only, never edits).
 *
 * Does: the morning after Reilly publishes, checks every ACTIVE product published (or created)
 *   in the last CATALOG_NEW_DAYS days (default 3) for the basics in the catalog spec: price
 *   within the rules ($44.95–$144.95, Marlowe $49.95 floor, .95 ending, COGS band if cost is
 *   known), NO compare-at while the product is younger than NO_COMPARE_AT_DAYS (GMC Playbook),
 *   a valid compare-at tier for older ones (and which tier it should take if the spread is short),
 *   images, a size option, a size chart in the library, cost on file, title and description,
 *   SEO title/description, no duplicate handle ("name-1" next to "name"), and the Supplier's
 *   Supply Pre-flight (preflightProduct: a confirmed KFB supply line, quoted and not denied).
 * Inputs: `cat_products` (fresh copy), Core costs (per variant), `size_charts`, Pricing's tier
 *   spread, Supplier `kfb_quotes` via preflightProduct.
 * Outputs: a `cat_runs` row (per-product checklist) and one digest event per store per day.
 *   Reilly publishes products himself; this never edits, drafts or publishes anything.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { validatePrice, tierDistribution, assignTier, tierOf } from "./pricingRules.js";
import { saveRun, readCosts, productCost, variantCost, getRun } from "./common.js";
import { preflightProduct } from "../supplier/index.js";

export const AGENT = "cat.prepublish";
export const DEFAULT_NEW_DAYS = 3;

export function newDays(env) {
  const n = parseInt(env && env.CATALOG_NEW_DAYS, 10);
  return Number.isFinite(n) && n > 0 && n <= 30 ? n : DEFAULT_NEW_DAYS;
}

/**
 * No compare-at on a product younger than this many days. The rule, from the GMC Playbook in
 * the vault (04 Resources/Courses/GMC Playbook (UNLMTD - Fixable)/UNLMTD GMC Playbook - Full
 * Distillation.md, line 122): "do NOT use compare-at prices on new products — the single most
 * common mistake ... Wait 30–60+ days of stable sales before any compare-at, and even then it
 * remains one of the most sensitive misrep triggers". Repeated at line 158 ("Don't use
 * compare-at prices on new products ... wait 30–60+ days of stable sales"). 30 is the rule's
 * MINIMUM; the playbook says many wait longer. Course Module 8.5 agrees: "list products without
 * discounts while the GMC is fresh (month 1)".
 */
export const NO_COMPARE_AT_DAYS = 30;

/** A new product has this long to get a KFB quote before "no quote" counts as a problem. */
export const QUOTE_GRACE_DAYS = 2;

/** Days since the product was published (or created), or null when neither date is known. */
export function productAgeDays(p, nowMs = Date.now()) {
  const t = Date.parse(p.published_at || p.created_at || "");
  return Number.isFinite(t) ? (nowMs - t) / 86400000 : null;
}

/** The checklist for one new product. `ctx`: {cost, costs, hasSizeChart, handles:Set, tierCounts, supply, nowMs}. */
export function checkNewProduct(storeId, p, ctx) {
  const problems = [];
  const add = (code, severity, message) => problems.push({ code, severity, message });
  const v0 = (p.variants || [])[0];
  if (!p.title || !String(p.title).trim()) add("no_title", "high", "Title is empty");
  if (!p.description_len) add("no_description", "medium", "Description is empty");
  if (!p.image_count) add("no_images", "high", "No images");
  const hasSize = (p.option_names || []).some((n) => /size/i.test(n));
  if (!hasSize) add("no_size_option", "medium", "No Size option");
  else if (!ctx.hasSizeChart) add("no_size_chart", "low", "No size chart in the library yet");
  if (!ctx.cost) add("cost_unknown", "medium", "No cost on file (KFB quote not in the Core yet)");
  else if (ctx.cost.partial) add("cost_partial", "low", "Cost on file for only some variants (the others aren't judged on COGS)");
  // The Supplier's pre-publish gate: a confirmed supply line (quoted, not denied).
  if (ctx.supply && ctx.supply.error) add("supply_preflight_unavailable", "info", `Supply pre-flight couldn't run: ${ctx.supply.error}`);
  else if (ctx.supply && !ctx.supply.ok) {
    // "No quote yet" is expected while KFB quotes aren't wired for this store, and for a product
    // younger than QUOTE_GRACE_DAYS (Reilly clicks "get products" in KFB after publishing): info
    // then, so it doesn't drown real problems. Denied / not-quoted / ceiling stay medium.
    const age = productAgeDays(p, ctx.nowMs);
    const expected = ctx.supply.no_quote && (!ctx.supply.quotes_wired || (age != null && age < QUOTE_GRACE_DAYS));
    const why = !ctx.supply.quotes_wired ? "KFB quotes not wired for this store yet" : `published ${age == null ? "?" : age.toFixed(1)} days ago, inside the ${QUOTE_GRACE_DAYS}-day grace for "get products"`;
    const noQuote = (ctx.supply.reasons || []).filter((r) => /no KFB quote/i.test(r));
    const other = (ctx.supply.reasons || []).filter((r) => !/no KFB quote/i.test(r));
    if (expected && noQuote.length) add("supply_no_quote_yet", "info", `Supply pre-flight: ${noQuote.join("; ")} (expected: ${why})`);
    const rest = expected ? other : ctx.supply.reasons || [];
    if (rest.length) add("supply_preflight", "medium", `Supply pre-flight: ${rest.join("; ")}`);
  }
  if (!p.seo_title || !p.seo_description) add("seo_basics", "info", "SEO title/description not set (Shopify falls back to title/description)");
  const m = /^(.*)-(\d+)$/.exec(p.handle || "");
  if (m && ctx.handles.has(m[1])) add("possible_duplicate", "medium", `Handle looks like a copy of "${m[1]}"`);
  if (!v0) add("no_variants", "high", "No variants read");

  let suggestedTier = null;
  for (const v of p.variants || []) {
    // Each variant on its own cost; a variant with no cost is judged on floor/ceiling/ending only.
    const vc = ctx.costs ? variantCost(ctx.costs, p, v) : null;
    const r = validatePrice(storeId, { price: v.price, compareAt: v.compareAt, cost: vc ? vc.usd : null });
    if (!r) continue;
    for (const i of r.issues) {
      if (i.severity === "info") continue;
      if (!problems.some((x) => x.code === i.code)) problems.push({ ...i, variant: v.title });
    }
  }
  // GMC Playbook: no compare-at on a product younger than NO_COMPARE_AT_DAYS. An unknown age
  // counts as new (the safe side): a strikethrough on a new product is a misrep trigger.
  const age = productAgeDays(p, ctx.nowMs);
  const young = age == null || age < NO_COMPARE_AT_DAYS;
  const struck = (p.variants || []).filter((v) => v.compareAt != null && v.price != null && v.compareAt > v.price);
  if (young && struck.length) {
    const n = (p.variants || []).length;
    add("compare_at_on_new_product", "high",
      `Has a compare-at (${struck.length} of ${n} variant${n === 1 ? "" : "s"}) but is ${age == null ? "of unknown age" : `${age.toFixed(1)} days old`}: the GMC Playbook says no compare-at for the first ${NO_COMPARE_AT_DAYS}-60 days (the most common misrep trigger). Flag only; Reilly decides.`);
  }
  // A product with no compare-at is a legitimate "none" tier, unless "none" is not the short tier.
  // Never proposed for a product younger than the GMC rule's minimum: "none" is its only tier.
  if (!young && v0 && (v0.compareAt == null || v0.compareAt <= v0.price) && ctx.tierCounts) {
    const t = assignTier(p.product_id, ctx.tierCounts);
    if (t !== 0) { suggestedTier = t; add("tier_unassigned", "low", `No compare-at; the ${t}% tier is the short one (seeded pick)`); }
  }
  const worst = problems.some((x) => x.severity === "high") ? "high" : problems.some((x) => x.severity === "medium") ? "medium"
    : problems.some((x) => x.severity === "low") ? "low" : "info";
  return {
    product_id: p.product_id, handle: p.handle, title: p.title, published_at: p.published_at, created_at: p.created_at,
    passed: !problems.some((x) => x.severity !== "info"), severity: worst, issues: problems, suggested_tier: suggestedTier,
  };
}

/**
 * The Supplier's Supply Pre-flight for one product (spec: Catalog's pre-publish gate calls it).
 * Guarded: if the Supplier tables are missing or it fails, the check says so (info) instead of
 * failing the whole New-Product Check. Pure read on the Supplier side.
 */
export async function supplyCheck(db, storeId, p) {
  if (!p.handle) return { error: "product has no handle" };
  try {
    const prices = (p.variants || []).map((v) => v.price).filter((x) => x != null);
    const r = await preflightProduct(db, storeId, p.handle, { price: prices.length ? Math.max(...prices) : null });
    // Are KFB quotes wired for this store at all? (any row = the Quote Desk has imported quotes)
    const w = await db.prepare(`SELECT 1 AS x FROM kfb_quotes WHERE store = ? LIMIT 1`).bind(storeId).first();
    return { ok: !!r.ok, reasons: r.reasons || [], quote_status: r.quote ? r.quote.status : null, no_quote: !r.quote, quotes_wired: !!w };
  } catch (err) {
    return { error: String(err && err.message).slice(0, 160) };
  }
}

export async function runPrepublishStore(env, storeId, products, { nowMs, day }) {
  const db = env.DB;
  const days = newDays(env);
  const since = new Date(nowMs - days * 86400000).toISOString();
  const fresh = products.filter((p) => p.status === "ACTIVE" && ((p.published_at && p.published_at >= since) || (p.created_at && p.created_at >= since)));
  const costs = await readCosts(db, storeId);
  const handles = new Set(products.map((p) => p.handle).filter(Boolean));
  const charted = new Set();
  if (fresh.length) {
    const { results } = await db.prepare(`SELECT DISTINCT product_id FROM size_charts WHERE store = ?`).bind(storeId).all();
    for (const r of results || []) charted.add(r.product_id);
  }
  // Tier spread over the rest of the active catalog (new ones excluded, so they fill the gaps).
  const freshIds = new Set(fresh.map((p) => p.product_id));
  const pricing = await getRun(db, "cat.pricing", storeId);
  let tierCounts = null;
  if (pricing && pricing.summary && pricing.summary.tiers) tierCounts = pricing.summary.tiers.counts;
  else {
    const tiers = products.filter((p) => p.status === "ACTIVE" && !freshIds.has(p.product_id) && p.variants[0])
      .map((p) => tierOf(storeId, p.variants[0].price, p.variants[0].compareAt));
    tierCounts = tierDistribution(tiers).counts;
  }
  const results = [];
  for (const p of fresh) {
    results.push(checkNewProduct(storeId, p, {
      cost: productCost(costs, p), costs, hasSizeChart: charted.has(p.product_id), handles, tierCounts,
      supply: await supplyCheck(db, storeId, p), nowMs,
    }));
  }
  const rank = { high: 3, medium: 2, low: 1, info: 0 };
  results.sort((a, b) => rank[b.severity] - rank[a.severity]);
  const failed = results.filter((r) => !r.passed).length;
  const summary = { window_days: days, new_products: results.length, passed: results.length - failed, flagged: failed };
  await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings: results });
  await logEvent(db, {
    actor: AGENT, kind: "catalog.new_product_digest", store: storeId, at: nowIso(nowMs),
    summary: results.length
      ? `${STORES[storeId].name}: ${results.length} product(s) published in the last ${days} days; ${failed} flagged, ${results.length - failed} pass. Flags only.`
      : `${STORES[storeId].name}: no products published in the last ${days} days.`,
    data: summary,
  });
  return { status: "ok", ...summary };
}
