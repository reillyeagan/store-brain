/**
 * Pricing rules, as plain functions (no database, no network). Used by the Quote Desk.
 *
 * Source: docs/specs/supplier.md "Pricing rules" (Reilly, 2026-10-11):
 *   "max price 144.95 all 3 stores" · "min price 44.95 on H&C going forwards"
 *   H&C  29–33%  directional: above 33% → raise to the cheapest .95 at ≤33%;
 *                below 29% → cut to the dearest .95 at ≥29%; in band → leave.
 *   AUB  25–29%  single target (as Marlowe), floor $44.95.
 *   MAR  25–29%  target = min(max(up95(cost/0.29), 49.95), 144.95).
 *   Compare-at tiers: none · ~10% · ~20% · ~30% · ~40%. When a price changes, its compare-at
 *   is recomputed to keep the SAME tier, as a clean .95 (or .50) the badge prints exactly.
 *
 * NOTE for the integrator: Catalog is building src/agents/catalog/pricingRules.js with the
 * same rules. This is a deliberately small local copy so the Quote Desk could be built in
 * parallel; reconcile the two into one module (the tests in test/supplier.test.js pin the
 * behaviour this side relies on).
 *
 * All money is handled in whole cents internally, so .95 endings never drift.
 */

export const PRICE_CEILING = 144.95;

export const STORE_PRICING = Object.freeze({
  hc: { shape: "directional", bandMin: 0.29, bandMax: 0.33, floor: 44.95, ceiling: PRICE_CEILING, badge: "hc" },
  aub: { shape: "target", bandMin: 0.25, bandMax: 0.29, floor: 44.95, ceiling: PRICE_CEILING, badge: null },
  mar: { shape: "target", bandMin: 0.25, bandMax: 0.29, floor: 49.95, ceiling: PRICE_CEILING, badge: null },
});

/** The compare-at tiers, in percent off. 0 = no compare-at. */
export const TIERS = Object.freeze([0, 10, 20, 30, 40]);

const toCents = (x) => Math.round(Number(x) * 100);
const fromCents = (c) => Math.round(c) / 100;

/** Smallest price ending in .95 that is ≥ x. */
export function up95(x) {
  const c = Math.ceil(Number(x) * 100 - 1e-6);
  const n = Math.ceil((c - 95) / 100);
  return fromCents(n * 100 + 95);
}

/** Largest price ending in .95 that is ≤ x. */
export function down95(x) {
  const c = Math.floor(Number(x) * 100 + 1e-6);
  const n = Math.floor((c - 95) / 100);
  return fromCents(n * 100 + 95);
}

export function rulesFor(store) {
  return Object.prototype.hasOwnProperty.call(STORE_PRICING, store) ? STORE_PRICING[store] : null;
}

/**
 * The price the rules want for one cost.
 * @returns {{price:number, cogs:number, limitedBy:null|"ceiling"|"floor", waiverPrice:number|null, rule:string}}
 *   waiverPrice: when the ceiling stops the price reaching band, the price that WOULD reach
 *   band. The proposal offers the waiver; the brain never waives on its own.
 */
export function targetPrice(store, costUsd, currentPrice = null) {
  const r = rulesFor(store);
  if (!r) throw new Error(`pricing: no rules for store "${store}"`);
  const cost = Number(costUsd);
  if (!(cost > 0)) throw new Error("pricing: cost must be a positive number");

  let want; let rule;
  if (r.shape === "directional") {
    const cur = Number(currentPrice);
    const cogs = cur > 0 ? cost / cur : Infinity;
    if (cogs > r.bandMax + 1e-9) { want = up95(cost / r.bandMax); rule = `COGS ${pct(cogs)} above ${pct(r.bandMax)}: raise to the cheapest .95 at ≤${pct(r.bandMax)}`; }
    else if (cogs < r.bandMin - 1e-9) { want = down95(cost / r.bandMin); rule = `COGS ${pct(cogs)} below ${pct(r.bandMin)}: cut to the dearest .95 at ≥${pct(r.bandMin)}`; }
    else { want = cur; rule = `COGS ${pct(cogs)} in band: leave`; }
  } else {
    want = up95(cost / r.bandMax);
    rule = `target = cheapest .95 at ≤${pct(r.bandMax)} COGS`;
  }

  let price = want; let limitedBy = null; let waiverPrice = null;
  if (toCents(price) > toCents(r.ceiling)) {
    limitedBy = "ceiling"; waiverPrice = price; price = r.ceiling;
    rule += `; held at the $${r.ceiling} ceiling (band needs $${waiverPrice.toFixed(2)})`;
  } else if (toCents(price) < toCents(r.floor)) {
    limitedBy = "floor"; price = r.floor;
    rule += `; raised to the $${r.floor} floor`;
  }
  return { price, cogs: cost / price, limitedBy, waiverPrice, rule };
}

/** The badge percentage a store's theme would print for a price / compare-at pair. */
export function badgePct(store, price, compareAt) {
  if (!(compareAt > price)) return 0;
  const exact = ((compareAt - price) / compareAt) * 100;
  const r = rulesFor(store);
  if (r && r.badge === "hc") {
    // H&C snippets/price.liquid: floors to a whole percent, then rounds to the nearest 10.
    return Math.round(Math.floor(exact + 1e-9) / 10) * 10;
  }
  // Other stores: their badge snippet has not been read yet ("never assume"), so we
  // report the whole-percent floor and only accept compare-ats within ±2 points of the tier.
  return Math.floor(exact + 1e-9);
}

/** Which tier a product is in now (nearest of 0/10/20/30/40). */
export function tierOf(price, compareAt) {
  if (!(Number(compareAt) > Number(price))) return 0;
  const exact = ((compareAt - price) / compareAt) * 100;
  let best = 10;
  for (const t of TIERS.slice(1)) if (Math.abs(exact - t) < Math.abs(exact - best)) best = t;
  return best;
}

/**
 * A clean compare-at for a price that keeps a tier: ends .95 (preferred) or .50, and the
 * store's badge prints exactly the tier. Returns null for tier 0, or {compareAt:null,
 * problem} when no clean number prints the tier (never a near-miss presented as clean).
 */
export function compareAtFor(store, price, tier) {
  if (!tier) return { compareAt: null, printed: 0, badgeRead: true };
  const r = rulesFor(store);
  const badgeRead = !!(r && r.badge);
  const ideal = price / (1 - tier / 100);
  const lo = Math.floor(price / (1 - (tier - 6) / 100));
  const hi = Math.ceil(price / (1 - (tier + 6) / 100));
  let best = null;
  for (let d = lo; d <= hi; d++) {
    for (const cents of [95, 50]) {
      const c = fromCents(d * 100 + cents);
      if (!(c > price)) continue;
      const printed = badgePct(store, price, c);
      const ok = badgeRead ? printed === tier : Math.abs(printed - tier) <= 2;
      if (!ok) continue;
      // Closest to the ideal wins; on a tie .95 beats .50.
      // Unread badge: a compare-at whose whole-percent floor is exactly the tier beats one ±2 off.
      const score = Math.abs(c - ideal) + (cents === 50 ? 0.001 : 0) + (printed === tier ? 0 : 100);
      if (!best || score < best.score) best = { compareAt: c, printed, score };
    }
  }
  if (!best) return { compareAt: null, printed: null, badgeRead, problem: `no clean .95/.50 compare-at prints ${tier}% at $${price.toFixed(2)}` };
  return { compareAt: best.compareAt, printed: best.printed, badgeRead };
}

/**
 * Full plan for one variant: new price and compare-at from the quoted cost.
 * @returns {{newPrice, newCompareAt, tier, change:boolean, cogsOld, cogsNew, limitedBy, waiverPrice, rule, notes:string[]}}
 */
export function planVariantPrice(store, { costUsd, price, compareAt }) {
  const t = targetPrice(store, costUsd, price);
  const tier = tierOf(price, compareAt);
  const notes = [];
  let newCompareAt = compareAt == null ? null : Number(compareAt);
  const priceChanges = toCents(t.price) !== toCents(price);
  if (priceChanges) {
    // Same tier, recomputed for the new price (spec: "its compare-at is recomputed to keep the same tier").
    const c = compareAtFor(store, t.price, tier);
    if (c.problem) notes.push(c.problem);
    if (!c.badgeRead && tier) notes.push("badge snippet not read for this store: compare-at checked to ±2 points");
    newCompareAt = c.compareAt;
  }
  if (t.limitedBy === "ceiling") notes.push(`ceiling stops band: needs $${t.waiverPrice.toFixed(2)} (waiver offered, not applied)`);
  if (t.limitedBy === "floor") notes.push(`floor $${rulesFor(store).floor} applied`);
  const change = priceChanges || (newCompareAt ?? null) !== (compareAt == null ? null : Number(compareAt));
  return {
    newPrice: t.price, newCompareAt, tier, change,
    cogsOld: price > 0 ? costUsd / price : null, cogsNew: t.cogs,
    limitedBy: t.limitedBy, waiverPrice: t.waiverPrice, rule: t.rule, notes,
  };
}

function pct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a"; }
