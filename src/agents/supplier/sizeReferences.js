/**
 * US garment reference library for the Size Checker: audience → garment → fit → size → cm.
 *
 * Why it exists: Reilly, 2026-10-14: "we should have different size charts for different
 * products right? like a womens sweater might have different size measurements than a womens
 * coat or even a womens fitted blouse, etc". One men's tops chart could not size a women's
 * coat, and every women's line was left unsized.
 *
 * EVERY TABLE HERE IS A LABELLED INFERENCE, not an observation. Each one is built the same way:
 *   garment chest = US BODY chest (midpoint of the standard size range) + garment ease
 *   (+ a fit adjustment), plus typical US garment shoulder / length / sleeve. The `source`
 *   line on each reference says exactly what went in. Reilly can replace any table with a
 *   Core fact (see sizeChecker.js coreSizing), and customer complaints still override it.
 *
 * Body measurements (inches; the brief of 2026-10-14):
 *   women's missy XS 32–33, S 34–35, M 36–37, L 38.5–40, XL 41.5–43, 2XL 44.5–46,
 *   3XL / 4XL by progressive grading (inferred here: 48–49.5, 51.5–53).
 *   men's chest XS 32–34, S 34–36, M 38–40, L 42–44, XL 46–48, 2XL 50–52, 3XL 54–56, 4XL 58–60.
 * Ease (cm, the brief): fitted blouse +5–8 (6.5 used) · relaxed shirt/blouse +10 · women's
 *   knit +8–12 (10) · blazer +8–10 women's (9) / +12–14 men's (13) · women's coat +12–16 (14) ·
 *   men's coat/outerwear +16–20 (18) · men's shirt +10 · men's knit +12.
 *   Fit: relaxed adds +6–10 (8 used); fitted takes 4 off.
 *
 * Which measurements are COMPARED per (garment, fit) is declared here too (`key`). The CHEST
 * always decides the size; the others (coat shoulder, men's knit length, dress waist ...) are
 * reported as notes and never force a size-up on their own (a wrong size-up is the costly
 * error). A relaxed fit is chest only: a boxy, cropped or drop-shoulder cut is never judged on
 * its shoulder or length.
 */

export const REF_SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"]);
export const FITS = Object.freeze(["fitted", "regular", "relaxed"]);
export const AUDIENCES = Object.freeze(["women", "men"]);

const IN = 2.54;
const half = (x) => Math.round(x * 2) / 2; // tables are kept to 0.5 cm: finer would be false precision

/** US body chest/bust ranges in inches. 3XL/4XL women's are progressive-grading inferences. */
export const BODY_CHEST_IN = Object.freeze({
  women: { XS: [32, 33], S: [34, 35], M: [36, 37], L: [38.5, 40], XL: [41.5, 43], "2XL": [44.5, 46], "3XL": [48, 49.5], "4XL": [51.5, 53] },
  men: { XS: [32, 34], S: [34, 36], M: [38, 40], L: [42, 44], XL: [46, 48], "2XL": [50, 52], "3XL": [54, 56], "4XL": [58, 60] },
});
/** Women's body waist (inches), for dresses. Inference from standard missy charts, graded the same way. */
export const BODY_WAIST_IN = Object.freeze({ XS: [24.5, 25.5], S: [26.5, 27.5], M: [28.5, 29.5], L: [30.5, 32], XL: [33.5, 35], "2XL": [36.5, 38], "3XL": [40, 41.5], "4XL": [43.5, 45] });

/** Typical US garment shoulder seam-to-seam (cm), regular fit. */
const SHOULDER = Object.freeze({
  women: { XS: 36, S: 37, M: 38, L: 39.5, XL: 41, "2XL": 42.5, "3XL": 44, "4XL": 45.5 },
  men: { XS: 42, S: 44, M: 46, L: 48, XL: 50, "2XL": 52, "3XL": 54, "4XL": 56 },
});
/** Typical US sleeve (cm). */
const SLEEVE = Object.freeze({
  women: { XS: 58, S: 59, M: 60, L: 61, XL: 62, "2XL": 62.5, "3XL": 63, "4XL": 63.5 },
  men: { XS: 61, S: 62, M: 63.5, L: 65, XL: 66, "2XL": 67, "3XL": 68, "4XL": 69 },
});

const mid = ([a, b]) => ((a + b) / 2) * IN;

/**
 * Per audience, per garment: the ease by fit (cm), shoulder allowance, body length at M and
 * its step per size, whether sleeve applies, and which measurements matter by fit.
 * `label` is what the reason says ("vs US women's coat (regular fit) reference").
 */
const G = (label, regularEase, o = {}) => ({
  label,
  ease: { fitted: regularEase - 4, regular: regularEase, relaxed: regularEase + 8, ...(o.ease || {}) },
  shoulderAdd: o.shoulderAdd || 0,
  lengthM: o.lengthM, lengthStep: o.lengthStep ?? 1.5,
  sleeve: o.sleeve !== false,
  waistEase: o.waistEase ?? null,
  key: { fitted: o.key, regular: o.key, ...(o.keyByFit || {}), relaxed: ["chest"] },
  aliases: o.aliases || [],
});

export const GARMENT_SPECS = Object.freeze({
  men: {
    shirt: G("shirt", 10, { lengthM: 76, lengthStep: 2, key: ["chest", "shoulder"] }),
    knit: G("knit/sweater", 12, { lengthM: 72, lengthStep: 2, key: ["chest", "length"] }),
    // Men's cardigan: same ease and measurements as men's knit (inference; the brief names
    // chest + length for men's knit and is silent on men's cardigans).
    cardigan: G("cardigan", 12, { lengthM: 72, lengthStep: 2, key: ["chest", "length"] }),
    // Hoodies are cut roomier than a knit: +14 is an inference between knit (+12) and blazer.
    hoodie: G("hoodie/sweatshirt", 14, { shoulderAdd: 1, lengthM: 72, lengthStep: 2, key: ["chest", "length"] }),
    blazer: G("blazer/jacket", 13, { lengthM: 76, key: ["chest", "shoulder"] }),
    coat: G("coat/outerwear", 18, { shoulderAdd: 1, lengthM: 82, lengthStep: 2, key: ["chest", "shoulder"] }),
  },
  women: {
    // One "top" garment covers the brief's two rows. A blouse with no fit word is held to the
    // fitted-blouse ease (+5–8 → 6.5): holding it to the relaxed-shirt allowance made a true-size
    // blouse read as "runs small" (review of 1e5fd64). Only a title that says relaxed/oversized/
    // boxy gets the relaxed shirt/blouse allowance (+10).
    top: G("blouse/top", 6.5, { ease: { fitted: 6.5, regular: 6.5, relaxed: 10 }, lengthM: 64, key: ["chest", "shoulder"] }),
    knit: G("knit/sweater", 10, { lengthM: 62, key: ["chest"] }),
    // Women's cardigan: knit ease (inference); chest only, length informational (crops vary).
    cardigan: G("cardigan", 10, { lengthM: 64, key: ["chest"] }),
    blazer: G("blazer/jacket", 9, { shoulderAdd: 0.5, lengthM: 68, key: ["chest", "shoulder"] }),
    coat: G("coat/outerwear", 14, { shoulderAdd: 1, lengthM: 85, key: ["chest", "shoulder"] }),
    // Dress: +6 bust and waist ease at regular (inference; bodycon/fitted −4 = +2). Sized on the
    // chest only: the waist is a note (smocked / elastic waists stretch).
    dress: G("dress", 6, { lengthM: 95, sleeve: false, waistEase: 6, key: ["chest", "waist"] }),
  },
});

export const GARMENTS_BY_AUDIENCE = Object.freeze({
  men: Object.freeze(Object.keys(GARMENT_SPECS.men)),
  women: Object.freeze(Object.keys(GARMENT_SPECS.women)),
});

function buildTable(audience, garment, fit) {
  const spec = GARMENT_SPECS[audience][garment];
  const ease = spec.ease[fit];
  const mIdx = REF_SIZES.indexOf("M");
  const out = {};
  REF_SIZES.forEach((s, i) => {
    const row = { chest: half(mid(BODY_CHEST_IN[audience][s]) + ease) };
    // Relaxed / drop-shoulder: the seam sits off the shoulder, so no shoulder (or sleeve) reference.
    row.shoulder = fit === "relaxed" ? null : half(SHOULDER[audience][s] + spec.shoulderAdd - (fit === "fitted" ? 1 : 0));
    row.length = spec.lengthM == null ? null : half(spec.lengthM + (i - mIdx) * spec.lengthStep);
    row.sleeve = spec.sleeve && fit !== "relaxed" ? SLEEVE[audience][s] : null;
    if (spec.waistEase != null && fit !== "relaxed") {
      row.waist = half(mid(BODY_WAIST_IN[s]) + spec.waistEase + (fit === "fitted" ? -4 : 0));
    }
    out[s] = Object.freeze(row);
  });
  return Object.freeze(out);
}

function sourceLine(audience, garment, fit) {
  const spec = GARMENT_SPECS[audience][garment];
  const body = audience === "women" ? "US women's missy bust (3XL/4XL graded progressively)" : "US men's chest";
  const waist = spec.waistEase != null && fit !== "relaxed" ? ` and missy waist + ${spec.waistEase + (fit === "fitted" ? -4 : 0)}cm` : "";
  return `INFERENCE: ${body} midpoint + ${spec.ease[fit]}cm ${fit} ${spec.label} ease${waist}; typical US shoulder/length/sleeve. Not observed; override with a Core sizing fact.`;
}

/** US_REFERENCES[audience][garment][fit] = { table, key, label, source }. */
export const US_REFERENCES = Object.freeze(Object.fromEntries(AUDIENCES.map((a) => [a, Object.freeze(Object.fromEntries(
  GARMENTS_BY_AUDIENCE[a].map((g) => [g, Object.freeze(Object.fromEntries(FITS.map((f) => [f, Object.freeze({
    table: buildTable(a, g, f),
    key: Object.freeze([...GARMENT_SPECS[a][g].key[f]]),
    label: GARMENT_SPECS[a][g].label,
    source: sourceLine(a, g, f),
  })])))])
))])));

/** One reference, or null when the library has none for that (audience, garment, fit). */
export function referenceFor(audience, garment, fit = "regular") {
  const a = US_REFERENCES[audience];
  const g = a && a[garment];
  return (g && g[FITS.includes(fit) ? fit : "regular"]) || null;
}

/** "US women's coat (regular fit)" */
export function referenceName(audience, garment, fit) {
  const spec = GARMENT_SPECS[audience] && GARMENT_SPECS[audience][garment];
  return `US ${audience === "women" ? "women's" : "men's"} ${spec ? spec.label : garment} (${fit} fit)`;
}

/** Short list for the dashboard: which references exist. */
export function librarySummary() {
  return AUDIENCES.map((a) => `${a === "women" ? "women's" : "men's"}: ${GARMENTS_BY_AUDIENCE[a].map((g) => GARMENT_SPECS[a][g].label).join(", ")}`).join(" · ") +
    ` · fits: ${FITS.join("/")} · sizes ${REF_SIZES[0]}–${REF_SIZES[REF_SIZES.length - 1]}`;
}

/* ---------------------------------------------------------------- detection */

// Order matters. Each rule is tried in turn; the first that matches wins. Comments say why.
const BOTTOMS_RE = /\b(pants|trousers|jeans|chinos?|shorts|joggers|slacks|skirts?|skorts?|leggings|culottes)\b/i;
const KNIT_OUTER_RE = /\b(sweater|knit(?:ted)?|cardigan)[- ](jacket|coat)\b/i;          // "Sweater Jacket" is a knit, not outerwear
const KNIT_VEST_RE = /\b(sweater|knit(?:ted)?)[- ]vest\b/i;                             // "Sweater Vest" is a knit, not a waistcoat
const DRESS_SHIRT_RE = /\bdress[- ]shirts?\b/i;                                         // a men's dress shirt is a shirt
const DRESS_RE = /\b(dress|dresses|gown)\b/i;
const COAT_RE = /\b(coats?|overcoat|topcoat|peacoat|trench|parka|puffer|down[- ]jacket|quilted|padded|sherpa|anorak|gilet|winter[- ]jacket|outerwear)\b/i;
const SHIRT_JACKET_RE = /\b(shirt[- ]jacket|shacket)\b/i;                                // "Shirt Jacket" is a jacket
const BLAZER_RE = /\b(blazer|jacket|bomber|suit|waistcoat|vest)\b/i;
const CARDIGAN_RE = /\bcardigans?\b/i;
const HOODIE_RE = /\b(hoodie|hoody|sweatshirt)\b/i;
const KNIT_RE = /\b(sweater|knit|knitted|knitwear|jumper|pullover|crewneck|turtleneck|mock[- ]neck|quarter[- ]zip)\b/i;
const MEN_SHIRT_RE = /\b(shirt|tee|t-shirt|polo|henley|oxford|flannel|overshirt|top)\b/i;
const WOMEN_TOP_RE = /\b(blouse|top|shirt|tee|t-shirt|cami|camisole|tank|bodysuit|tunic|polo|henley|overshirt)\b/i;

/**
 * The garment a title names, for an audience. "bottoms" for pants/skirts (no reference),
 * null when nothing matches. Women's hoodies/sweatshirts are read as knits (no women's
 * hoodie table). A dress is women's only; a men's title with "dress" is not a dress.
 */
export function garmentOf(title, audience = "men") {
  const t = String(title || "");
  if (BOTTOMS_RE.test(t)) return "bottoms";
  if (KNIT_OUTER_RE.test(t)) return "cardigan";
  if (KNIT_VEST_RE.test(t)) return "knit";
  if (DRESS_SHIRT_RE.test(t)) return audience === "women" ? "top" : "shirt";
  if (audience === "women" && DRESS_RE.test(t)) return "dress";
  if (COAT_RE.test(t)) return "coat";             // before blazer: "Blazer Coat" is a coat
  if (SHIRT_JACKET_RE.test(t)) return "blazer";   // before shirt
  if (BLAZER_RE.test(t)) return "blazer";
  if (CARDIGAN_RE.test(t)) return "cardigan";     // before knit: "Knit Cardigan ... Sweater"
  if (HOODIE_RE.test(t)) return audience === "women" ? "knit" : "hoodie";
  if (KNIT_RE.test(t)) return "knit";
  if (audience === "women" ? WOMEN_TOP_RE.test(t) : MEN_SHIRT_RE.test(t)) return audience === "women" ? "top" : "shirt";
  return null;
}

const FITTED_RE = /\b(fitted|slim(?:[- ]fit)?|tailored|bodycon|skinny|form[- ]fitting)\b/i;
const RELAXED_RE = /\b(oversized?|relaxed|boxy|loose|drop(?:ped)?[- ]shoulders?|chunky|baggy|slouchy)\b/i;

/**
 * Fit from the title and tags: "fitted", "relaxed" or "regular".
 * Both kinds of word present → "regular" with `mixed: true` (no guess either way).
 */
export function fitOf(title, tags = null) {
  let t = tags;
  if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = [t]; } }
  const text = [title, ...(Array.isArray(t) ? t : [])].filter(Boolean).map(String).join(" | ");
  const f = FITTED_RE.test(text), r = RELAXED_RE.test(text);
  if (f && r) return { fit: "regular", mixed: true };
  return { fit: r ? "relaxed" : f ? "fitted" : "regular", mixed: false };
}

/** Old one-word Core override names (men's) → the garments they now cover. */
export const LEGACY_GARMENT = Object.freeze({ jacket: ["blazer", "coat"], sweater: ["knit", "cardigan", "hoodie"], shirt: ["shirt"] });
