/**
 * cat.prepublish — New-Product Check (SHADOW: flags only, never edits).
 *
 * Does: the morning after Reilly publishes, checks every ACTIVE product published (or created)
 *   in the last CATALOG_NEW_DAYS days (default 3) for the basics in the catalog spec: price
 *   within the rules ($44.95–$144.95, Marlowe $49.95 floor, .95 ending, COGS band if cost is
 *   known), a valid compare-at tier (and which tier it should take if the spread is short),
 *   images, a size option, a size chart in the library, cost on file, title and description,
 *   SEO title/description, and no duplicate handle ("name-1" next to "name").
 * Inputs: `cat_products` (fresh copy), Core costs, `size_charts`, Pricing's tier spread.
 * Outputs: a `cat_runs` row (per-product checklist) and one digest event per store per day.
 *   Reilly publishes products himself; this never edits, drafts or publishes anything.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";
import { validatePrice, tierDistribution, assignTier, tierOf } from "./pricingRules.js";
import { saveRun, readCosts, productCost, getRun } from "./common.js";

export const AGENT = "cat.prepublish";
export const DEFAULT_NEW_DAYS = 3;

export function newDays(env) {
  const n = parseInt(env && env.CATALOG_NEW_DAYS, 10);
  return Number.isFinite(n) && n > 0 && n <= 30 ? n : DEFAULT_NEW_DAYS;
}

/** The checklist for one new product. `ctx`: {cost, hasSizeChart, handles:Set, tierCounts}. */
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
  if (!p.seo_title || !p.seo_description) add("seo_basics", "info", "SEO title/description not set (Shopify falls back to title/description)");
  const m = /^(.*)-(\d+)$/.exec(p.handle || "");
  if (m && ctx.handles.has(m[1])) add("possible_duplicate", "medium", `Handle looks like a copy of "${m[1]}"`);
  if (!v0) add("no_variants", "high", "No variants read");

  let suggestedTier = null;
  for (const v of p.variants || []) {
    const r = validatePrice(storeId, { price: v.price, compareAt: v.compareAt, cost: ctx.cost ? ctx.cost.usd : null });
    if (!r) continue;
    for (const i of r.issues) {
      if (i.severity === "info") continue;
      if (!problems.some((x) => x.code === i.code)) problems.push({ ...i, variant: v.title });
    }
  }
  // A product with no compare-at is a legitimate "none" tier, unless "none" is not the short tier.
  if (v0 && (v0.compareAt == null || v0.compareAt <= v0.price) && ctx.tierCounts) {
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
  const results = fresh.map((p) => checkNewProduct(storeId, p, {
    cost: productCost(costs, p), hasSizeChart: charted.has(p.product_id), handles, tierCounts,
  }));
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
