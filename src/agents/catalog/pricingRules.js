/**
 * Pricing rules — Reilly's pricing rulebook as pure functions. No database, no network.
 *
 * Shared on purpose: Catalog (Pricing, Margin Guard, New-Product Check) uses it today and the
 * Supplier team's Quote Desk will import the same file, so a quote and a price check can never
 * disagree about what "in band" means.
 *
 * Source: docs/specs/supplier.md "Pricing rules" (Reilly, 2026-10-11), verbatim where it matters:
 *   - "max price 144.95 all 3 stores"            → ceiling $144.95 everywhere
 *   - "min price 44.95 on H&C going forwards"     → H&C floor $44.95 (Auberlane $44.95, Marlowe $49.95)
 *   - H&C 29–33% COGS, DIRECTIONAL: above 33% → raise to the cheapest .95 at ≤33%;
 *     below 29% → cut to the dearest .95 at ≥29%; in band → leave.
 *   - Auberlane / Marlowe 25–29%, SINGLE TARGET: target = min(max(up95(cost/0.29), floor), 144.95).
 *   - Prices end in .95. Compare-at is a clean .95 (or .50).
 *   - Compare-at tiers: 20% of products each at none / ~10% / ~20% / ~30% / ~40%; the badge must
 *     print the exact tier. H&C's snippets/price.liquid floors to a whole percent, then rounds to
 *     the nearest 10, so ±5 points prints clean. "Read each store's own badge snippet before
 *     computing — never assume". Auberlane's and Marlowe's live themes were read on 2026-10-13
 *     and they do NOT match H&C (see BADGE_MODELS).
 *   - When the ceiling stops a product reaching band, say so and offer the waiver; never waive.
 *   - Auberlane: at least $30 gross margin per unit (price − landed cost), Reilly "yes" 2026-10-13.
 *     Checked on known cost only; no product is exempt (high-margin exemption: Reilly "no").
 *
 * Money is handled in whole cents internally so .95 endings never drift with float maths.
 * Cost: USD, or EUR converted at EUR_USD_ESTIMATE (1.17, the quoting-sheet rate in pnl.js) until
 * the actual card rate is wired; an EUR conversion is always flagged `fxEstimated`.
 */
import { EUR_USD_ESTIMATE } from "../../lib/pnl.js";

export const PRICE_CEILING = 144.95;
export const TIERS = Object.freeze([0, 10, 20, 30, 40]);
/** Share of active products each tier should hold (Reilly: "20% of products should have no compare at, 20% ..."). */
export const TIER_SHARE = 0.2;

/**
 * Badge models: how a store's theme turns (price, compare-at) into the "−N%" badge.
 *  - floor_round10: floor to a whole percent, then round to the nearest 10 (H&C, per the supplier spec).
 *  - round5: round to the nearest 5 (Auberlane live theme, snippets/product-card.liquid and
 *    snippets/pdp-sale-pct.liquid: `pct_raw | divided_by: 5.0 | round | times: 5`). So ±2.5 points
 *    prints clean: 18% shows "-20%", 17% shows "-15%".
 *  - round1: round to the nearest whole percent (Marlowe live theme, snippets/price.liquid
 *    `... divided_by: cap | round`, and the JS in marlowe-sale-pdp / marlowe-cart-sale /
 *    recently-viewed uses Math.round the same way). Only ±0.5 points prints the exact tier.
 * Liquid's `round` and JS Math.round agree for positive numbers (half rounds up).
 */
export const BADGE_MODELS = Object.freeze({
  floor_round10: (pct) => Math.round(Math.floor(pct + 1e-9) / 10) * 10,
  round5: (pct) => Math.round(pct / 5) * 5,
  round1: (pct) => Math.round(pct),
});

export const STORE_PRICING = Object.freeze({
  hc: Object.freeze({
    store: "hc", band: Object.freeze({ lo: 0.29, hi: 0.33 }), shape: "directional",
    floor: 44.95, ceiling: PRICE_CEILING,
    badge: Object.freeze({ model: "floor_round10", verified: true, source: "H&C snippets/price.liquid (supplier spec)" }),
  }),
  aub: Object.freeze({
    store: "aub", band: Object.freeze({ lo: 0.25, hi: 0.29 }), shape: "single",
    floor: 44.95, ceiling: PRICE_CEILING,
    // Minimum gross margin per unit (price minus landed cost), confirmed by Reilly 2026-10-13:
    // asked "Auberlane $30 minimum margin per unit?", he said "yes" (decision cat.min_margin.aub).
    minMarginUsd: 30,
    badge: Object.freeze({ model: "round5", verified: true, source: "Auberlane live theme snippets/product-card.liquid + pdp-sale-pct.liquid (read 2026-10-13)" }),
  }),
  mar: Object.freeze({
    store: "mar", band: Object.freeze({ lo: 0.25, hi: 0.29 }), shape: "single",
    floor: 49.95, ceiling: PRICE_CEILING,
    badge: Object.freeze({ model: "round1", verified: true, source: "Marlowe live theme snippets/price.liquid (read 2026-10-13)" }),
  }),
});

/** The store's rules, or null (unknown store / no rules agreed yet: never guess another store's). */
export function rulesFor(storeId) {
  return Object.prototype.hasOwnProperty.call(STORE_PRICING, storeId) ? STORE_PRICING[storeId] : null;
}

/* ---------------- money helpers (whole cents) ---------------- */

/** Dollars → whole cents, or null for anything that isn't a positive-or-zero finite number. */
export function toCents(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
export const fromCents = (c) => (c == null ? null : Math.round(c) / 100);

/** The cheapest price ending in .95 that is ≥ x (x in dollars). */
export function up95(x) {
  const c = Math.ceil(Number(x) * 100 - 1e-6);
  const k = Math.ceil((c - 95) / 100);
  return fromCents(Math.max(k, 0) * 100 + 95);
}

/** The dearest price ending in .95 that is ≤ x. Null if x < 0.95. */
export function down95(x) {
  const c = Math.floor(Number(x) * 100 + 1e-6);
  const k = Math.floor((c - 95) / 100);
  return k < 0 ? null : fromCents(k * 100 + 95);
}

/** Store prices end in .95 (Reilly's rule). */
export function isCleanPrice(p) {
  const c = toCents(p);
  return c != null && c % 100 === 95;
}

/** Compare-at prices end in .95 or .50. */
export function isCleanCompareAt(p) {
  const c = toCents(p);
  return c != null && (c % 100 === 95 || c % 100 === 50);
}

/**
 * Normalise a cost to USD. Accepts a number (USD), {usd}, {eur}, or {amount, currency}.
 * Returns {usd, currency, fxEstimated, fx} or null when the cost is unknown/invalid.
 * Unknown stays unknown: no fallback rate is ever substituted here (CLAUDE.md rule 4).
 */
export function costToUsd(cost, fx = EUR_USD_ESTIMATE) {
  if (cost == null) return null;
  let amount, currency;
  if (typeof cost === "number" || typeof cost === "string") { amount = Number(cost); currency = "USD"; }
  else if (typeof cost === "object") {
    if (cost.usd != null) { amount = Number(cost.usd); currency = "USD"; }
    else if (cost.eur != null) { amount = Number(cost.eur); currency = "EUR"; }
    else { amount = Number(cost.amount ?? cost.cost); currency = String(cost.currency || "USD").toUpperCase(); }
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Costs round UP to the cent (never cheaper than they are).
  if (currency === "USD") return { usd: ceil2(amount), currency, fxEstimated: false, fx: null };
  if (currency === "EUR") {
    const rate = Number(fx);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    // Converted costs round UP to the cent: a cost must never come out cheaper than it is.
    return { usd: ceil2(amount * rate), currency, fxEstimated: rate === EUR_USD_ESTIMATE, fx: rate, eur: amount };
  }
  return null; // any other currency: not handled, so not used
}

const round2 = (n) => Math.round(n * 100) / 100;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-6) / 100;

/**
 * COGS as a share of price (0.31 = 31%), or null when either side is unknown.
 * NOT rounded: band checks compare the exact share, so 33.004% is above a 33% band top
 * (rounding would have counted it in band — the flattering direction). Round only for display.
 */
export function cogsPct(costUsd, price) {
  const c = Number(costUsd), p = Number(price);
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0 || p <= 0) return null;
  return c / p;
}

const clamp = (p, rules) => Math.min(Math.max(p, rules.floor), rules.ceiling);

/* ---------------- target price from cost ---------------- */

/**
 * What the rules say about a cost, before looking at any current price.
 * @returns {null | {
 *   store, costUsd, fxEstimated, band,
 *   bandPrices: {min, max}       // raw prices at which COGS sits exactly at the band edges
 *   cleanRange: {min, max}       // .95 prices whose COGS is inside the band (before floor/ceiling)
 *   target: number|null          // single-target stores: THE price; directional stores: null
 *   ceilingBlocksBand: boolean   // even $144.95 leaves COGS above band → needs Reilly's waiver
 *   floorAboveBand: boolean      // the floor puts COGS under band (allowed: the floor wins)
 * }}
 */
export function targetPrice(storeId, cost, { fx = EUR_USD_ESTIMATE } = {}) {
  const rules = rulesFor(storeId);
  const c = costToUsd(cost, fx);
  if (!rules || !c) return null;
  const { lo, hi } = rules.band;
  const bandPrices = { min: round2(c.usd / hi), max: round2(c.usd / lo) };
  const cleanMin = up95(c.usd / hi), cleanMax = down95(c.usd / lo);
  const cleanRange = cleanMax != null && cleanMax >= cleanMin ? { min: cleanMin, max: cleanMax } : null;
  let target = null;
  if (rules.shape === "single") target = clamp(up95(c.usd / hi), rules); // Reilly's Marlowe formula, 09-23
  return {
    store: storeId, costUsd: c.usd, fxEstimated: c.fxEstimated, band: { ...rules.band },
    bandPrices, cleanRange, target,
    ceilingBlocksBand: c.usd / rules.ceiling > hi + 1e-9,
    floorAboveBand: c.usd / rules.floor < lo - 1e-9,
  };
}

/**
 * The price the rules would set, given the current price and (maybe) the cost.
 * Cost unknown → only floor, ceiling and the .95 ending are enforced.
 * @returns {{price:number, reason:string, ceilingBlocksBand:boolean}}
 */
export function recommendPrice(storeId, currentPrice, cost, { fx = EUR_USD_ESTIMATE } = {}) {
  const rules = rulesFor(storeId);
  if (!rules) return null;
  const cur = Number(currentPrice);
  const c = costToUsd(cost, fx);
  let price = cur, reason = "keep";
  let ceilingBlocksBand = false;

  if (c) {
    const { lo, hi } = rules.band;
    const cogs = cogsPct(c.usd, cur);
    if (rules.shape === "single") {
      price = up95(c.usd / hi); reason = "single target: cheapest .95 at ≤ band top";
    } else if (cogs == null || cogs > hi) {
      price = up95(c.usd / hi); reason = "COGS above band: raise to the cheapest .95 at ≤ band top";
    } else if (cogs < lo) {
      price = down95(c.usd / lo); reason = "COGS below band: cut to the dearest .95 at ≥ band bottom";
    } else if (!isCleanPrice(cur)) {
      // In band but not .95: nearest .95 that stays in band (down first: never round a price up silently).
      const d = down95(cur);
      price = d != null && c.usd / d <= hi ? d : up95(cur);
      reason = "in band: make the price end in .95";
    } else { price = cur; reason = "in band: leave"; }
    ceilingBlocksBand = c.usd / rules.ceiling > hi + 1e-9;
  } else if (!isCleanPrice(cur)) {
    price = down95(cur) ?? up95(cur); reason = "cost unknown: make the price end in .95";
  }

  if (price < rules.floor) { price = rules.floor; reason += `; floor $${rules.floor}`; }
  if (price > rules.ceiling) { price = rules.ceiling; reason += `; ceiling $${rules.ceiling}`; }
  return { price: round2(price), reason, ceilingBlocksBand };
}

/* ---------------- compare-at tiers ---------------- */

/** Discount shown by a compare-at, in percent (unrounded), or null when there is no sale. */
export function discountPct(price, compareAt) {
  const p = Number(price), c = Number(compareAt);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || p <= 0 || c <= p) return null;
  return ((c - p) / c) * 100;
}

/** What the store's badge prints for this price/compare-at, in percent (null = no badge). */
export function badgePct(storeId, price, compareAt) {
  const rules = rulesFor(storeId);
  const pc = toCents(price), cc = toCents(compareAt);
  if (!rules || pc == null || cc == null || pc <= 0 || cc <= pc) return null;
  // Same sum, same order, in whole cents, exactly as the themes do it
  // ((cap - price) * 100.0 / cap). In float dollars an exact 22.5% comes out as 22.4999…
  // and rounds down where the live badge rounds up.
  return BADGE_MODELS[rules.badge.model](((cc - pc) * 100) / cc);
}

/**
 * The tier a price/compare-at pair is in: 0 for no sale, 10/20/30/40 when the badge prints one
 * of those exactly, or null when the badge prints something else (e.g. 0% or 50%) = wrong tier.
 */
export function tierOf(storeId, price, compareAt) {
  if (compareAt == null || Number(compareAt) <= 0 || Number(compareAt) <= Number(price)) return 0;
  const b = badgePct(storeId, price, compareAt);
  return b != null && TIERS.includes(b) && b > 0 ? b : null;
}

/**
 * The compare-at for a price and tier: a clean .95 whose badge prints the tier exactly, as close to
 * the tier as possible; .50 only if no .95 can print it. Tier 0 → null (no compare-at).
 */
export function compareAtFor(storeId, price, tier) {
  const rules = rulesFor(storeId);
  if (!rules || !TIERS.includes(tier)) return null;
  if (tier === 0) return null;
  const p = toCents(price);
  if (p == null || p <= 0) return null;
  const lo = Math.floor(p / (1 - Math.max(tier - 6, 0) / 100));
  const hi = Math.ceil(p / (1 - (tier + 6) / 100));
  let best = { 95: null, 50: null };
  for (let base = Math.floor(lo / 100) * 100; base <= hi + 100; base += 100) {
    for (const end of [95, 50]) {
      const c = base + end;
      if (c <= p) continue;
      if (badgePct(storeId, p / 100, c / 100) !== tier) continue;
      const dist = Math.abs(discountPct(p, c) - tier);
      if (!best[end] || dist < best[end].dist) best[end] = { c, dist };
    }
  }
  const pick = best[95] || best[50];
  return pick ? fromCents(pick.c) : null;
}

/** Count active products per tier ({0:n,10:n,...,wrong:n}) and the gap from 20% each. */
export function tierDistribution(tiers) {
  const counts = { 0: 0, 10: 0, 20: 0, 30: 0, 40: 0, wrong: 0 };
  for (const t of tiers) { if (t == null) counts.wrong++; else counts[t]++; }
  const total = tiers.length;
  const want = total * TIER_SHARE;
  const gap = Object.fromEntries(TIERS.map((t) => [t, Math.round((counts[t] - want) * 10) / 10]));
  return { total, counts, target_each: Math.round(want * 10) / 10, gap };
}

/** FNV-1a: a tiny stable hash so tier assignment is reproducible ("seeded") per product. */
export function stableHash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** The tier a new product should get: whichever tier is shortest; ties broken by the product's hash. */
export function assignTier(productId, counts) {
  const min = Math.min(...TIERS.map((t) => counts[t] || 0));
  const shortest = TIERS.filter((t) => (counts[t] || 0) === min);
  return shortest[stableHash(productId) % shortest.length];
}

/* ---------------- checking an existing price ---------------- */

/**
 * Check one price/compare-at against the rules.
 * @param {string} storeId
 * @param {{price:number, compareAt?:number|null, cost?:any}} input  cost: see costToUsd (unknown → omit)
 * @returns {null | {
 *   ok:boolean, issues:[{code, severity:'high'|'medium'|'low'|'info', message}],
 *   cogs:number|null, costUsd:number|null, fxEstimated:boolean, tier:number|null,
 *   proposed:{price, compareAt, tier, reason} | null   // null when nothing should change
 * }}
 */
export function validatePrice(storeId, { price, compareAt = null, cost = null } = {}, { fx = EUR_USD_ESTIMATE } = {}) {
  const rules = rulesFor(storeId);
  if (!rules) return null;
  const issues = [];
  const add = (code, severity, message) => issues.push({ code, severity, message });
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    add("no_price", "high", "No usable price");
    return { ok: false, issues, cogs: null, costUsd: null, fxEstimated: false, tier: null, proposed: null };
  }
  const c = costToUsd(cost, fx);
  const cogs = c ? cogsPct(c.usd, p) : null;
  const ca = compareAt == null || compareAt === "" ? null : Number(compareAt);

  // Price: floor, ceiling, ending.
  if (p < rules.floor - 1e-9) add("below_floor", "high", `$${p.toFixed(2)} is under the $${rules.floor} floor`);
  if (p > rules.ceiling + 1e-9) add("above_ceiling", "high", `$${p.toFixed(2)} is over the $${rules.ceiling} ceiling`);
  if (!isCleanPrice(p)) add("unclean_price", "medium", `$${p.toFixed(2)} does not end in .95`);

  // COGS band (only when the cost is known).
  let rec = recommendPrice(storeId, p, cost, { fx });
  if (c && cogs != null) {
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    if (cogs > rules.band.hi + 1e-9) add("cogs_above_band", "high", `COGS ${pct(cogs)} is above the ${pct(rules.band.hi)} band top`);
    else if (cogs < rules.band.lo - 1e-9 && !(rec.price === p)) {
      add("cogs_below_band", "medium", `COGS ${pct(cogs)} is under the ${pct(rules.band.lo)} band bottom`);
    } else if (rules.shape === "single" && rec.price !== p) {
      add("off_target", "low", `In band, but the single target is $${rec.price.toFixed(2)}`);
    }
    if (rec.ceilingBlocksBand) add("ceiling_blocks_band", "info", `Even $${rules.ceiling} leaves COGS ${pct(c.usd / rules.ceiling)}: needs Reilly's waiver or a cheaper source`);
  }

  // Minimum margin per unit (stores that have one). Known cost only: an unknown cost gives
  // met = null ("can't tell"), never a pass. No exemption for any product (Reilly: "no").
  const minMargin = checkMinMargin(rules, p, c);
  if (minMargin && minMargin.met === false) {
    add("below_min_margin", "medium", `Margin $${minMargin.margin.toFixed(2)} per unit is under the $${minMargin.required} minimum (price $${p.toFixed(2)} − cost $${c.usd.toFixed(2)})`);
  }

  // Compare-at: clean ending, above the price, badge prints an exact tier.
  let tier = 0;
  if (ca != null && ca > 0) {
    if (ca <= p) { add("compare_at_not_above_price", "medium", `Compare-at $${ca.toFixed(2)} is not above the price (no sale shows)`); tier = 0; }
    else {
      if (!isCleanCompareAt(ca)) add("compare_at_unclean", "medium", `Compare-at $${ca.toFixed(2)} does not end in .95 or .50`);
      tier = tierOf(storeId, p, ca);
      if (tier == null) {
        const b = badgePct(storeId, p, ca);
        add("compare_at_tier_wrong", rules.badge.verified ? "medium" : "info",
          `${b > 0 ? `Badge would print ${b}%, not a 10/20/30/40 tier` : "No badge would show (the discount rounds to 0%), but the price is struck through"}${rules.badge.verified ? "" : " (badge snippet not read yet)"}`);
      }
    }
  }
  if (ca != null && ca > p && !rules.badge.verified) add("badge_unverified", "info", rules.badge.source);

  // Proposal: new price (if the rules move it) and a compare-at recomputed to keep the tier.
  const keepTier = tier == null ? nearestTier(p, ca) : tier;
  const newPrice = rec.price;
  const newCompare = keepTier === 0 ? null : compareAtFor(storeId, newPrice, keepTier);
  const priceChanges = Math.abs(newPrice - p) > 0.004;
  const compareChanges = (newCompare == null) !== (ca == null || ca <= 0) ||
    (newCompare != null && Math.abs(newCompare - ca) > 0.004);
  const needsCompareFix = issues.some((i) => i.code.startsWith("compare_at_") && i.severity !== "info");
  const proposed = priceChanges || (needsCompareFix && compareChanges)
    ? { price: newPrice, compareAt: newCompare, tier: keepTier, reason: rec.reason }
    : null;

  const ok = !issues.some((i) => i.severity === "high" || i.severity === "medium");
  return { ok, issues, cogs, costUsd: c ? c.usd : null, fxEstimated: !!(c && c.fxEstimated), tier, proposed, minMargin };
}

/**
 * The store's minimum-margin check, or null when the store has no such rule.
 * @returns {null | {required:number, margin:number|null, met:boolean|null}}  margin/met null = cost unknown
 */
export function checkMinMargin(rules, price, costUsd) {
  if (!rules || rules.minMarginUsd == null) return null;
  const pc = toCents(price);
  if (!costUsd || pc == null) return { required: rules.minMarginUsd, margin: null, met: null };
  // Whole cents, and the cost already rounds UP (costToUsd), so the margin is never overstated.
  const marginCents = pc - Math.round(costUsd.usd * 100);
  return { required: rules.minMarginUsd, margin: fromCents(marginCents), met: marginCents >= Math.round(rules.minMarginUsd * 100) };
}

/** For a wrong-tier compare-at: the 10/20/30/40 tier its raw discount is closest to. */
function nearestTier(price, compareAt) {
  const d = discountPct(price, compareAt);
  if (d == null) return 0;
  return TIERS.slice(1).reduce((a, t) => (Math.abs(t - d) < Math.abs(a - d) ? t : a), 10);
}
