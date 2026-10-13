/**
 * Thin adapter: the Quote Desk's view of the SHARED pricing rulebook
 * (src/agents/catalog/pricingRules.js, owned by Catalog). No rules live here any more, so a
 * quote and a Catalog price check can never disagree about what "in band" means.
 *
 * planVariantPrice() turns one variant's quoted cost into the proposed price + compare-at:
 *  - price: recommendPrice() (H&C directional, AUB/MAR single target, floors, $144.95 ceiling,
 *    in-band prices not ending .95 cleaned to .95)
 *  - compare-at: recomputed to keep the variant's current tier (spec), .95 preferred over .50
 *  - waiver: only when the shared module says even $144.95 leaves COGS above band
 *    (ceilingBlocksBand); the price that would reach band is shown, never applied.
 */
import {
  PRICE_CEILING, TIERS, rulesFor, recommendPrice, tierOf, compareAtFor, discountPct, up95, toCents, cogsPct,
} from "../catalog/pricingRules.js";

export { PRICE_CEILING, rulesFor, up95, tierOf, compareAtFor };
export { badgePct, down95, targetPrice } from "../catalog/pricingRules.js";

/** The tier a variant is in now; a wrong-tier badge maps to the nearest tier by raw discount. */
export function currentTier(store, price, compareAt) {
  const t = tierOf(store, price, compareAt);
  if (t != null) return t;
  const d = discountPct(price, compareAt);
  if (d == null) return 0;
  return TIERS.slice(1).reduce((a, x) => (Math.abs(x - d) < Math.abs(a - d) ? x : a), 10);
}

/**
 * @returns {{newPrice, newCompareAt, tier, change:boolean, cogsOld, cogsNew, limitedBy, waiverPrice, rule, notes:string[]}}
 */
export function planVariantPrice(store, { costUsd, price, compareAt }) {
  const rules = rulesFor(store);
  if (!rules) throw new Error(`pricing: no rules for store "${store}"`);
  const rec = recommendPrice(store, price, costUsd);
  const cmp = compareAt == null || compareAt === "" ? null : Number(compareAt);
  const tier = currentTier(store, price, cmp);
  const notes = [];
  const priceChanges = toCents(rec.price) !== toCents(price);
  let newCompareAt = cmp;
  if (priceChanges) {
    newCompareAt = tier ? compareAtFor(store, rec.price, tier) : null;
    if (tier && newCompareAt == null) notes.push(`no clean compare-at prints ${tier}% at $${rec.price.toFixed(2)}: pick one by hand`);
    if (tier && !rules.badge.verified) notes.push(`badge snippet not read for this store (${rules.badge.source})`);
  }
  let limitedBy = null; let waiverPrice = null;
  // Same cent-rounded cost the shared module judged; a "waiver" at or under the ceiling is no waiver.
  const bandPrice = up95(Math.round(costUsd * 100) / 100 / rules.band.hi);
  if (rec.ceilingBlocksBand && toCents(bandPrice) > toCents(rules.ceiling)) {
    limitedBy = "ceiling";
    waiverPrice = bandPrice;
    notes.push(`ceiling stops band: needs $${waiverPrice.toFixed(2)} (waiver offered, not applied)`);
  } else if (/floor/.test(rec.reason)) {
    limitedBy = "floor";
    notes.push(`floor $${rules.floor} applied`);
  }
  const change = priceChanges || toCents(newCompareAt) !== toCents(cmp);
  return {
    newPrice: rec.price, newCompareAt, tier, change,
    cogsOld: cogsPct(costUsd, price), cogsNew: cogsPct(costUsd, rec.price),
    limitedBy, waiverPrice, rule: rec.reason, notes,
  };
}
