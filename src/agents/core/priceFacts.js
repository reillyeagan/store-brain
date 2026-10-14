/**
 * Reading a store's RETAIL price floor / ceiling out of a Core fact, for the Librarian's
 * "contradicts the spec" check. Plain code.
 *
 * Live 2026-10-14 it raised false contradictions:
 *  - fact 263 `pricing.price_floor_ceiling` states both numbers; the old check took the FIRST
 *    number in the value as the floor AND as the ceiling, so it said "ceiling 44.95" for all
 *    three stores (and gave H&C's 44.95 floor to Marlowe).
 *  - fact 384 `kfb.price_tier_supply_ceiling` is a KFB supply price tier, not a retail ceiling,
 *    but its key contains "price" and "ceiling".
 *
 * So, like with like only:
 *  - the key must be about the store's retail price floor/ceiling (no kfb / supply / tier /
 *    cost / cogs / band / target / compare-at / fee keys);
 *  - floor and ceiling are read separately, each from the number next to its own label;
 *  - a number is tied to a store only when the text says which store (or "all stores"), or
 *    the fact itself belongs to one store;
 *  - anything that can't be read with confidence is returned as `unparsed`, never compared.
 *    A missed contradiction is reported as unreadable; a made-up one wastes Reilly's time.
 */
import { LIVE_STORE_IDS } from "../../config/stores.js";

const FLOOR_WORDS = new Set(["floor", "min", "minimum", "lowest"]);
const CEIL_WORDS = new Set(["ceiling", "max", "maximum", "cap", "highest"]);
/** Key words that mean "not the store's retail price rule". */
const NOT_RETAIL = /kfb|supply|supplier|tier|cost|cogs|band|target|compare|quote|shipping|margin|fee|discount|bid|budget|roas|ads?(?:[._-]|$)/;

const STORE_RX = [
  ["hc", /\b(?:h\s?&\s?c|h\s?and\s?c|holt\s*(?:&|and)\s*crane|hc)\b/i],
  ["aub", /\b(?:auberlane|aub)\b/i],
  ["mar", /\b(?:marlowe(?:\s+standard)?|mar|ms)\b/i],
];
const ALL_RX = /\b(?:all\s+(?:\d+\s+|three\s+|the\s+)?stores?|every\s+store|each\s+store|all\s+(?:3|three))\b/i;
const LABEL_RX = /\b(floor|min(?:imum)?|lowest|ceiling|max(?:imum)?|cap(?:ped)?|highest)\b/gi;

const keyTokens = (key) => String(key || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** Is this fact key about a store's retail price floor and/or ceiling? Returns the kinds it names. */
export function retailPriceKinds(key) {
  const k = String(key || "").toLowerCase();
  if (!/pric/.test(k) || NOT_RETAIL.test(k)) return null;
  const t = keyTokens(k);
  const kinds = [];
  if (t.some((x) => FLOOR_WORDS.has(x))) kinds.push("floor");
  if (t.some((x) => CEIL_WORDS.has(x))) kinds.push("ceiling");
  return kinds.length ? kinds : null;
}

const labelKind = (word) => (FLOOR_WORDS.has(word.toLowerCase().replace(/ped$/, "")) ? "floor" : "ceiling");

/** A plausible retail price. */
const okPrice = (n) => Number.isFinite(n) && n >= 1 && n <= 10000;

/** Store mentions in a piece of text, in order: [{at, stores:[...]}]. */
function storeMentions(text) {
  const out = [];
  const all = new RegExp(ALL_RX.source, "gi");
  for (const m of text.matchAll(all)) out.push({ at: m.index, end: m.index + m[0].length, stores: [...LIVE_STORE_IDS] });
  for (const [id, rx] of STORE_RX) {
    for (const m of text.matchAll(new RegExp(rx.source, "gi"))) {
      if (out.some((o) => m.index >= o.at && m.index < o.end)) continue;
      out.push({ at: m.index, end: m.index + m[0].length, stores: [id] });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Price-looking numbers in a segment: "$44.95", "44.95", and the number right after the label. */
function segmentNumbers(seg, labelLen) {
  const out = [];
  // The number right after the label, past filler words ("min price 44.95", "ceiling: 150").
  const near = /^[\s:=\-–]*(?:(?:retail|price|prices|is|of|at|set|to|now|usd|of|=|:)[\s:=]+){0,3}\$?\s?(\d+(?:\.\d+)?)\b/i.exec(seg.slice(labelLen));
  if (near) out.push({ at: labelLen + near.index + near[0].length - near[1].length, value: Number(near[1]) });
  for (const m of seg.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|\b(\d{1,5}\.\d{2})\b/g)) {
    const at = m.index + m[0].length - (m[1] || m[2]).length;
    if (out.some((o) => o.at === at)) continue;
    out.push({ at, value: Number(String(m[1] || m[2]).replace(/,/g, "")) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Read the retail price rules a fact states.
 * @returns {{claims: Array<{kind:"floor"|"ceiling", store:string, value:number}>} | {unparsed:string} | null}
 *          null = not a retail price floor/ceiling fact at all.
 */
export function readPriceFact(fact) {
  const kinds = retailPriceKinds(fact && fact.key);
  if (!kinds) return null;
  const own = fact.store && LIVE_STORE_IDS.includes(fact.store) ? fact.store : null;
  if (fact.store && !own) return { unparsed: `fact belongs to ${fact.store}, which is not a live store` };
  let v = fact.value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* plain text */ } }
  return readValue(v, kinds, own);
}

function readValue(v, kinds, own) {
  if (v == null || v === "") return { unparsed: "no value" };
  if (typeof v === "number") return bare(v, kinds, own);
  if (typeof v === "object" && !Array.isArray(v)) {
    // Per-store objects: {"hc": {...}, "mar": {...}}.
    const storeKeys = Object.keys(v).filter((k) => LIVE_STORE_IDS.includes(k.toLowerCase()));
    if (storeKeys.length) {
      const claims = [];
      for (const k of storeKeys) {
        const r = readValue(v[k], kinds, k.toLowerCase());
        if (r.unparsed) return { unparsed: `${k}: ${r.unparsed}` };
        claims.push(...r.claims);
      }
      return { claims };
    }
    // Labelled objects: {"floor": 44.95, "ceiling": 144.95} / {"min":..., "max":...}.
    const claims = [];
    for (const [k, x] of Object.entries(v)) {
      const t = keyTokens(k);
      const kind = t.some((w) => FLOOR_WORDS.has(w)) ? "floor" : t.some((w) => CEIL_WORDS.has(w)) ? "ceiling" : null;
      if (!kind) continue;
      const n = typeof x === "number" ? x : Number(String(x).replace(/[$,\s]/g, ""));
      if (!okPrice(n)) return { unparsed: `"${k}" is not a price` };
      for (const s of own ? [own] : LIVE_STORE_IDS) claims.push({ kind, store: s, value: n });
    }
    if (claims.length) return { claims };
    const plain = v.usd ?? v.amount ?? v.price ?? v.value ?? null;
    if (plain == null) return { unparsed: "no floor, ceiling or price field" };
    return readValue(typeof plain === "string" ? plain : Number(plain), kinds, own);
  }
  if (typeof v !== "string") return { unparsed: "unexpected value type" };
  return readText(v, kinds, own);
}

/** One bare number: only meaningful when the key names exactly one of floor / ceiling. */
function bare(n, kinds, own, stores = null) {
  if (!okPrice(n)) return { unparsed: `${n} is not a plausible price` };
  if (kinds.length !== 1) return { unparsed: "one number, but the key names both a floor and a ceiling" };
  return { claims: (stores || (own ? [own] : LIVE_STORE_IDS)).map((s) => ({ kind: kinds[0], store: s, value: n })) };
}

function readText(text, kinds, own) {
  // Dates, times and percentages are never prices.
  const t = String(text).replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ").replace(/\d+(?:\.\d+)?\s*%/g, " ");
  const anyStoreNamed = STORE_RX.some(([, rx]) => rx.test(t));
  const defaultStores = own ? [own] : anyStoreNamed ? null : [...LIVE_STORE_IDS];
  const labels = [...t.matchAll(new RegExp(LABEL_RX.source, "gi"))];

  if (!labels.length) {
    // No floor/ceiling word in the text: a single price, read by the key's meaning.
    const nums = segmentNumbers(` ${t}`, 0).filter((x) => okPrice(x.value));
    if (!nums.length) return { unparsed: `no price and no "floor"/"ceiling" word in the text` };
    if (kinds.length !== 1) return { unparsed: `no "floor"/"ceiling" word in the text, and the key names both` };
    const mentions = storeMentions(` ${t}`);
    if (nums.length === 1) {
      const named = [...new Set(mentions.flatMap((m) => m.stores))];
      const stores = named.length ? named : defaultStores;
      if (!stores) return { unparsed: `the ${kinds[0]} ${nums[0].value} isn't tied to a store` };
      return bare(nums[0].value, kinds, own, stores);
    }
    // "$44.95 H&C, $49.95 Marlowe": each price with its own store(s).
    const per = perStore(nums, mentions, ` ${t}`.length, kinds[0]);
    return per.unparsed ? per : { claims: per.claims };
  }

  // Clauses (";", new line, "|", end of sentence) bound what a label and a store name reach:
  // "ceiling 144.95; Marlowe floor 49.95" must not give Marlowe the ceiling.
  const clauses = [];
  let start = 0;
  for (const m of t.matchAll(/[;\n|]|\.\s+(?=[A-Za-z])/g)) { clauses.push([start, m.index]); start = m.index + m[0].length; }
  clauses.push([start, t.length]);
  const clauseOf = (at) => clauses.find(([a, b]) => at >= a && at <= b) || [0, t.length];

  const claims = [];
  for (let i = 0; i < labels.length; i++) {
    const kind = labelKind(labels[i][1]);
    const [cStart, cEnd] = clauseOf(labels[i].index);
    const nextLabel = i + 1 < labels.length && labels[i + 1].index < cEnd ? labels[i + 1].index : cEnd;
    const seg = t.slice(labels[i].index, nextLabel);
    const nums = segmentNumbers(seg, labels[i][0].length).filter((x) => okPrice(x.value));
    if (!nums.length) {
      // "Floor and ceiling: 44.95 / 144.95": which number is which can't be told.
      if (seg.length - labels[i][0].length < 8) return { unparsed: `"${labels[i][1]}" is listed with another label and no number of its own` };
      continue; // a label used in passing ("no ceiling on sale items"): nothing claimed
    }
    const mentions = storeMentions(seg);
    // Stores named at the start of the clause, before any label ("H&C floor 44.95, ceiling 144.95").
    const firstLabelInClause = labels.find((l) => l.index >= cStart && l.index < cEnd).index;
    const lead = [...new Set(storeMentions(t.slice(cStart, firstLabelInClause)).flatMap((m) => m.stores))];
    if (nums.length === 1) {
      const named = [...new Set(mentions.flatMap((m) => m.stores))];
      const stores = named.length ? named : lead.length ? lead : defaultStores;
      if (!stores) return { unparsed: `the ${kind} ${nums[0].value} isn't tied to a store` };
      for (const s of stores) claims.push({ kind, store: s, value: nums[0].value });
      continue;
    }
    const per = perStore(nums, mentions, seg.length, kind);
    if (per.unparsed) return per;
    claims.push(...per.claims);
  }
  if (!claims.length) return { unparsed: "no price next to a floor/ceiling word" };
  // The same store and kind read twice with different numbers: not confident.
  const seen = new Map();
  for (const c of claims) {
    const k = `${c.kind}:${c.store}`;
    if (seen.has(k) && Math.abs(seen.get(k) - c.value) >= 0.005) return { unparsed: `two different ${c.kind}s for ${c.store}` };
    seen.set(k, c.value);
  }
  return { claims };
}

/**
 * Several prices in one stretch of text: each needs its own store(s). Stores written before
 * the first price belong to the price after them ("H&C 44.95, MAR 49.95"); otherwise to the
 * price before them ("44.95 H&C, 49.95 MAR"). A price with no store: unparsed.
 */
function perStore(nums, mentions, length, kind) {
  const claims = [];
  const before = mentions.length && mentions[0].at < nums[0].at;
  for (let j = 0; j < nums.length; j++) {
    const lo = before ? (j ? nums[j - 1].at : 0) : nums[j].at;
    const hi = before ? nums[j].at : (j + 1 < nums.length ? nums[j + 1].at : length);
    const stores = [...new Set(mentions.filter((m) => m.at >= lo && m.at < hi).flatMap((m) => m.stores))];
    if (!stores.length) return { unparsed: `the ${kind} ${nums[j].value} isn't tied to a store` };
    for (const s of stores) claims.push({ kind, store: s, value: nums[j].value });
  }
  return { claims };
}
