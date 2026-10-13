/**
 * cat.margin_guard — Margin Guard (SHADOW, L0: flags only).
 *
 * Does: once a day per live store, for every ACTIVE product whose cost is on file in the Core,
 *   works out COGS% at each variant's price and flags (a) COGS outside the store's band,
 *   (b) a loss after typical fees and refunds, using the P&L break-even constants
 *   (contribution per $1 = (1 − COGS) × (1 − 0.119 refunds) − 0.0334 fees), and shows the
 *   break-even ROAS for each flagged product. Products with no cost on file are listed as
 *   "cost unknown" — never assumed (rule 4).
 * Inputs: `cat_products` (fresh copy), Core costs (`cost:product:<GID>` / `cost:sku:<SKU>`,
 *   USD or EUR at the 1.17 estimate, flagged).
 * Outputs: a `cat_runs` row and one digest event per store per day. Out-of-band products are
 *   carried into Pricing's approval (spec: "Out of band → added to the next pricing approval"),
 *   because Pricing reads the same costs. Never changes anything.
 * Not built yet: the discount/bundle check (order line COGS > ~50% of what the customer paid)
 *   needs discounted line amounts, which `order_lines` does not store.
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { BREAKEVEN_REFUND_RATE, BREAKEVEN_FEE_RATE, breakevenRoas } from "../../lib/pnl.js";
import { STORES } from "../../config/stores.js";
import { rulesFor, cogsPct } from "./pricingRules.js";
import { saveRun, readCosts, productCost, isHeld, pct, money } from "./common.js";

export const AGENT = "cat.margin_guard";

/** Contribution per $1 of revenue after refunds and fees, before ads. ≤ 0 = sold at a loss. */
export function contributionPerDollar(cogs) {
  if (cogs == null) return null;
  return Math.round(((1 - cogs) * (1 - BREAKEVEN_REFUND_RATE) - BREAKEVEN_FEE_RATE) * 10000) / 10000;
}

/** Judge one product with a known cost. Returns a finding or null when it's in band and profitable. */
export function judgeProduct(storeId, product, cost) {
  const rules = rulesFor(storeId);
  const priced = (product.variants || []).filter((v) => v.price != null && v.price > 0);
  if (!rules || !priced.length) return null;
  // The cheapest variant is the worst case for margin (errors run in the flattering direction).
  const low = priced.reduce((a, v) => (v.price < a.price ? v : a));
  const cogs = cogsPct(cost.usd, low.price);
  const contrib = contributionPerDollar(cogs);
  const held = isHeld(storeId, product, low.price);
  const problems = [];
  if (contrib != null && contrib <= 0) problems.push({ code: "loss_after_fees", severity: "high", message: `Loses money after refunds and fees at ${money(low.price)} (COGS ${pct(cogs)})` });
  if (cogs > rules.band.hi + 1e-9 && !held) problems.push({ code: "cogs_above_band", severity: "high", message: `COGS ${pct(cogs)} is above the ${pct(rules.band.hi)} band top` });
  if (cogs < rules.band.lo - 1e-9 && !held && low.price > rules.floor + 0.004) {
    problems.push({ code: "cogs_below_band", severity: "low", message: `COGS ${pct(cogs)} is under the ${pct(rules.band.lo)} band bottom (priced above the rules)` });
  }
  if (!problems.length) return null;
  return {
    product_id: product.product_id, handle: product.handle, title: product.title,
    price: low.price, cost_usd: cost.usd, cost_fx_estimated: !!cost.fxEstimated, cost_partial: !!cost.partial, cost_key: cost.key,
    cogs, contribution_per_dollar: contrib, breakeven_roas: breakevenRoas(cogs == null ? null : 1 - cogs), held,
    severity: problems.some((p) => p.severity === "high") ? "high" : "low", issues: problems,
  };
}

export async function runMarginGuardStore(env, storeId, products, { nowMs, day }) {
  const db = env.DB;
  if (!rulesFor(storeId)) {
    await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "not_wired", note: "No pricing band agreed for this store" });
    return { status: "not_wired" };
  }
  const costs = await readCosts(db, storeId);
  const active = products.filter((p) => p.status === "ACTIVE");
  const findings = [], unknown = [];
  let known = 0, fxEstimated = 0;
  for (const p of active) {
    const cost = productCost(costs, p);
    if (!cost) { unknown.push({ product_id: p.product_id, handle: p.handle, title: p.title }); continue; }
    known++;
    if (cost.fxEstimated) fxEstimated++;
    const f = judgeProduct(storeId, p, cost);
    if (f) findings.push(f);
  }
  findings.sort((a, b) => (b.severity === "high") - (a.severity === "high") || b.cogs - a.cogs);
  const summary = {
    checked: active.length, cost_known: known, cost_unknown: unknown.length, fx_estimated: fxEstimated,
    out_of_band: findings.filter((f) => f.issues.some((i) => i.code.startsWith("cogs_"))).length,
    loss_after_fees: findings.filter((f) => f.issues.some((i) => i.code === "loss_after_fees")).length,
    cost_unknown_sample: unknown.slice(0, 50),
    not_built: "discount/bundle line check (needs discounted order-line amounts)",
  };
  await saveRun(db, { agent: AGENT, store: storeId, day, nowMs, status: "ok", summary, findings });
  await logEvent(db, {
    actor: AGENT, kind: "catalog.margin_digest", store: storeId, at: nowIso(nowMs),
    summary: `${STORES[storeId].name}: cost known for ${known} of ${active.length} active products; ${summary.out_of_band} outside the COGS band, ${summary.loss_after_fees} at a loss after fees; ${unknown.length} cost unknown (not assumed).`,
    data: { checked: active.length, cost_known: known, cost_unknown: unknown.length, out_of_band: summary.out_of_band, loss_after_fees: summary.loss_after_fees },
  });
  return { status: "ok", checked: active.length, flagged: findings.length, unknown: unknown.length };
}
