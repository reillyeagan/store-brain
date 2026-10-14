/**
 * Claims Auditor (risk.claims_audit) — SHADOW. Reports only; never edits the store.
 *
 * Spec: "store promises vs reality — checkout delivery times vs measured 8–12 business days,
 * return/refund pages vs the CS Playbook (e.g. the page still requiring an RA number),
 * express timing." A promise the store can't keep loses chargebacks and breaks ads policy.
 *
 * What it does:
 *   1. Collect (weekly per store, one store per run to keep each run small): reads the LIVE
 *      theme's key files (read_themes, via GraphQL `themes(roles: MAIN) { files }`), the 20
 *      most recently updated active product descriptions, and the shop policies
 *      (`shop.shopPolicies`, which needs read_legal_policies: if Shopify refuses, policies are
 *      noted as not wired and the rest still runs). Code splits the text into snippets and
 *      keeps only those that look like a promise (delivery, returns, origin, urgency, ...).
 *      Each snippet is stored once (deduped by fingerprint).
 *   2. Classify (hourly while snippets wait): Claude judges small batches (15 snippets, at
 *      most 2 batches per run) against the measured reality. Code keeps the snippet text;
 *      Claude only labels it.
 *
 *   3. Personal details (personalDetails.js, plain code, high severity): the same read, plus the
 *      store's contact email and store address, is matched against Reilly's home / old Kansas
 *      addresses, personal Gmail and 913 phone. Stored in risk_personal_hits.
 *
 * Inputs: Shopify Admin GraphQL (Store Guard), core_facts policy notes.
 * Outputs: risk_claims (findings for Reilly), risk_personal_hits, events.
 */
import { LIVE_STORE_IDS, STORES } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { logEvent } from "../../lib/eventlog.js";
import { askJson } from "../../lib/ai.js";
import { nowIso } from "../../lib/time.js";
import { fingerprint, logProblem, logOnce, isAccessDenied, isNotWired } from "./shared.js";
import { SHOP_SETTINGS_QUERY, SETTINGS_SOURCES, scanItems, settingsItems, saveHits } from "./personalDetails.js";

export const ACTOR = "risk.claims_audit";
export const BATCH_SIZE = 15;
export const MAX_BATCHES_PER_RUN = 2;
export const MAX_NEW_PER_STORE = 120;

/** The live theme files most likely to carry promises (announcement bar, footer, product page). */
export const THEME_FILES = Object.freeze([
  "config/settings_data.json",
  "sections/header-group.json",
  "sections/footer-group.json",
  "templates/index.json",
  "templates/product.json",
  "templates/cart.json",
  "locales/en.default.json",
]);

/** Validated against Admin 2026-07 (scopes read_themes, read_products). */
export const STOREFRONT_QUERY = `query RiskClaimsText($files: [String!]!) {
  themes(first: 1, roles: [MAIN]) {
    nodes { id name files(first: 10, filenames: $files) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } }
  }
  products(first: 20, sortKey: UPDATED_AT, reverse: true, query: "status:active") { nodes { id title handle description } }
}`;
/** Separate on purpose: needs read_legal_policies, which the apps may not have. */
export const POLICIES_QUERY = `query RiskPolicies { shop { shopPolicies { type title body url } } }`;

/**
 * Words that mark a sentence as a promise worth checking. Code does this cheap filter so
 * Claude only sees likely claims (fewer tokens, fewer false alarms).
 */
export const CLAIM_RE = /\b(ship|ships|shipped|shipping|deliver|delivery|delivered|arrive|arrives|dispatch|business days?|\d+\s*-?\s*\d*\s*days?|express|overnight|tracked|tracking|return|returns|refund|refunds|exchange|money[- ]back|guarantee|guaranteed|warranty|free|made in|handmade|hand[- ]made|crafted in|designed in|italy|italian|france|french|england|british|usa|american|authentic|genuine|real leather|100%|cashmere|silk|merino|organic|limited|only \d+ left|last chance|sale ends|ends (today|tonight|soon)|hurry|selling fast|low stock|in stock|lifetime|certified|official|award|ra number|return authori[sz]ation)\b/i;

/** Strip HTML and collapse spaces. */
export function plainText(s) {
  return String(s || "")
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, ". ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/([.!?])\s*\.(\s|$)/g, "$1$2") // "days!." from a closing tag → "days!"
    .replace(/^[.\s]+|[\s.]+(?=\.$)/g, "")
    .trim();
}

/** Split text into sentence-sized snippets. */
export function sentences(text) {
  return plainText(text).split(/(?<=[.!?])\s+|\s*[•|]\s*/).map((s) => s.trim()).filter(Boolean);
}

/** Theme JSON files may start with a /* comment *\/ header; then walk every string value. */
export function themeStrings(content) {
  const src = String(content || "").replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
  let json;
  try { json = JSON.parse(src); } catch { return []; }
  const out = [];
  const walk = (v, depth) => {
    if (depth > 12 || out.length > 2000) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(json, 0);
  return out;
}

/** Keep snippets that read like a customer-facing promise. */
export function claimSnippets(texts) {
  const seen = new Set();
  const out = [];
  for (const t of texts) {
    for (const s of sentences(t)) {
      if (s.length < 12 || s.length > 400) continue;
      if (s.split(" ").length < 3) continue; // ids, handles, colours, urls
      if (/^(https?:|\/|#|\{\{|shopify:\/\/)/i.test(s)) continue;
      if (!CLAIM_RE.test(s)) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Pure: every candidate snippet for one store from the Shopify answers. */
export function snippetsFromStorefront(storefront, policies) {
  const items = [];
  const theme = storefront && storefront.themes && storefront.themes.nodes && storefront.themes.nodes[0];
  for (const f of (theme && theme.files && theme.files.nodes) || []) {
    const content = f && f.body && f.body.content;
    if (!content) continue;
    for (const s of claimSnippets(themeStrings(content))) items.push({ source: `theme:${f.filename}`, text: s });
  }
  for (const p of (storefront && storefront.products && storefront.products.nodes) || []) {
    for (const s of claimSnippets([p.description])) items.push({ source: `product:${p.handle}`, text: s });
  }
  for (const p of policies || []) {
    for (const s of claimSnippets([p.body])) items.push({ source: `policy:${String(p.type || p.title).toLowerCase()}`, text: s });
  }
  return { items, themeName: theme ? theme.name : null };
}

/** Pure: every raw text read (whole theme strings, descriptions, policies), for the personal-details scan. */
export function rawStorefrontItems(storefront, policies) {
  const out = [];
  const theme = storefront && storefront.themes && storefront.themes.nodes && storefront.themes.nodes[0];
  for (const f of (theme && theme.files && theme.files.nodes) || []) {
    const content = f && f.body && f.body.content;
    if (!content) continue;
    const strings = themeStrings(content);
    // A theme file that isn't JSON (or has no strings) is scanned as plain text.
    out.push({ source: `theme:${f.filename}`, text: strings.length ? strings.join(" \n ") : content });
  }
  for (const p of (storefront && storefront.products && storefront.products.nodes) || []) {
    out.push({ source: `product:${p.handle}`, text: plainText(p.description) });
  }
  for (const p of policies || []) out.push({ source: `policy:${String(p.type || p.title).toLowerCase()}`, text: plainText(p.body) });
  return out;
}

/** Collect one store's snippets. */
export async function collectStore(env, storeId, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const name = STORES[storeId].name;
  const notes = [];
  const sf = await shopifyGraphQL(env, storeId, STOREFRONT_QUERY, { files: [...THEME_FILES] }, { fetchImpl, nowMs });
  let policies = [];
  try {
    const p = await shopifyGraphQL(env, storeId, POLICIES_QUERY, {}, { fetchImpl, nowMs });
    policies = (p && p.shop && p.shop.shopPolicies) || [];
  } catch (err) {
    if (!(isAccessDenied(err) || isNotWired(err))) throw err;
    notes.push("store policies not read (the app needs read_legal_policies); theme and product text still checked");
    await logOnce(db, { actor: ACTOR, kind: "risk.not_wired", store: storeId,
      summary: `${name}: policy pages not readable (needs the read_legal_policies scope). Theme and product text are still audited.` },
    { windowMin: 7 * 24 * 60, nowMs }).catch(() => {});
  }
  const { items, themeName } = snippetsFromStorefront(sf, policies);
  if (!themeName) notes.push("no live theme files readable; product and policy text only");

  // Personal-details scan (plain code, high severity) over ALL the text read, not just the
  // promise-like snippets, plus the store's customer-facing settings.
  let shop = null;
  try {
    const s = await shopifyGraphQL(env, storeId, SHOP_SETTINGS_QUERY, {}, { fetchImpl, nowMs });
    shop = (s && s.shop) || null;
  } catch (err) {
    if (!(isAccessDenied(err) || isNotWired(err))) throw err;
    notes.push("store contact settings not readable for the personal-details scan (not wired)");
  }
  // Exactly what was read this run: only these sources can have an old hit cleared.
  const raw = rawStorefrontItems(sf, policies);
  const readSources = new Set(raw.map((it) => it.source));
  if (shop) for (const s of SETTINGS_SOURCES) readSources.add(s);
  const personal = await saveHits(db, storeId, scanItems([...raw, ...settingsItems(shop)]), { nowMs, readSources });
  let added = 0;
  for (const it of items) {
    const hash = await fingerprint(it.text);
    const existing = await db.prepare(`SELECT id FROM risk_claims WHERE store = ? AND hash = ?`).bind(storeId, hash).first();
    if (existing) {
      await db.prepare(`UPDATE risk_claims SET last_seen_at = ?, source = ? WHERE id = ?`).bind(at, it.source, existing.id).run();
      continue;
    }
    if (added >= MAX_NEW_PER_STORE) continue;
    await db.prepare(`INSERT INTO risk_claims (store, source, text, hash, verdict, found_at, last_seen_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(storeId, it.source, it.text.slice(0, 400), hash, at, at).run();
    added++;
  }
  await logEvent(db, {
    actor: ACTOR, kind: "risk.claims_collected", store: storeId, target: "sys.shopify",
    summary: `${name} storefront read${themeName ? ` (theme "${themeName}")` : ""}: ${items.length} promise-like snippet${items.length === 1 ? "" : "s"}, ${added} new to check${notes.length ? `. Note: ${notes.join("; ")}` : ""}`.slice(0, 480),
    data: { snippets: items.length, added, policies: policies.length, notes, personal }, at,
  });
  return { snippets: items.length, added, notes, personal };
}

const CLASSIFY_SYSTEM = `You audit an online clothing store's storefront text for promises that could lose a chargeback or break Google Ads / Merchant Center policy.
Reality: orders are fulfilled by a supplier in China; measured delivery is 8-12 business days; express is faster but not overnight. Products are not made in Europe or the USA unless a fact below says so.
Flag as risky: delivery times shorter than reality, "free returns"/"easy returns" if not backed by the policy facts, origin claims (made in Italy, handmade...), fake urgency or scarcity (countdowns, "only 2 left", "sale ends tonight"), unverifiable material/quality claims, guarantees the store can't honour, and return pages asking for things the store doesn't do (e.g. an RA number).
Not risky: neutral descriptions, sizing info, honest timing.
Reply as {"items":[{"n":<number>,"risky":true|false,"category":"delivery|returns|origin|urgency|quality|other","why":"<one short line>"}]} with one entry per snippet.`;

const CATEGORIES = new Set(["delivery", "returns", "origin", "urgency", "quality", "other"]);

/** Classify waiting snippets in small batches. */
export async function classifyPending(env, { nowMs = Date.now(), fetchImpl = fetch, maxBatches = MAX_BATCHES_PER_RUN } = {}) {
  const db = env.DB;
  const out = { batches: 0, risky: 0, ok: 0, unclear: 0, waiting: null };
  for (let b = 0; b < maxBatches; b++) {
    const { results } = await db.prepare(`SELECT * FROM risk_claims WHERE verdict = 'pending' ORDER BY store, id LIMIT ?`).bind(BATCH_SIZE).all();
    const rows = (results || []).filter((r) => r.store === (results[0] && results[0].store)); // one store per batch: its own policy facts
    if (!rows.length) break;
    const storeId = rows[0].store;
    const { results: facts } = await db.prepare(
      `SELECT key, value FROM core_facts WHERE live = 1 AND area = 'policy' AND (store = ? OR store IS NULL) ORDER BY id DESC LIMIT 5`
    ).bind(storeId).all();
    const user = JSON.stringify({
      store: STORES[storeId] ? STORES[storeId].name : storeId,
      policy_facts: (facts || []).map((f) => `${f.key}: ${String(f.value).slice(0, 300)}`),
      snippets: rows.map((r, i) => ({ n: i + 1, source: r.source, text: r.text })),
    });
    let r;
    try {
      r = await askJson(env, { system: CLASSIFY_SYSTEM, user, maxTokens: 900, actor: ACTOR, label: `Claims check (${rows.length} snippets)`, store: storeId }, { fetchImpl, nowMs });
    } catch (err) {
      // An unusable answer: mark the batch "unclear" so it isn't re-sent (and re-paid) every hour.
      await markRows(db, rows, "unclear", null, `AI answer unusable: ${String(err && err.message).slice(0, 120)}`, null, nowMs);
      out.unclear += rows.length;
      await logOnce(db, { actor: ACTOR, kind: "error.risk", store: storeId, target: "sys.claude",
        summary: `Claims check: Claude's answer was unusable for ${rows.length} snippets; they are listed as "unclear" for Reilly` }, { nowMs });
      out.batches++;
      continue;
    }
    if (r.skipped) { out.waiting = r.skipped; break; }
    const byN = new Map();
    for (const it of (r.json && Array.isArray(r.json.items) ? r.json.items : [])) {
      if (it && Number.isInteger(it.n) && typeof it.risky === "boolean") byN.set(it.n, it);
    }
    let risky = 0;
    for (let i = 0; i < rows.length; i++) {
      const it = byN.get(i + 1);
      if (!it) { await markRows(db, [rows[i]], "unclear", null, "Claude gave no verdict for this snippet", r.model, nowMs); out.unclear++; continue; }
      const cat = CATEGORIES.has(it.category) ? it.category : "other";
      await markRows(db, [rows[i]], it.risky ? "risky" : "ok", cat, String(it.why || "").slice(0, 240), r.model, nowMs);
      if (it.risky) { risky++; out.risky++; } else out.ok++;
    }
    out.batches++;
    await logEvent(db, {
      actor: ACTOR, kind: "risk.claims_classified", store: storeId,
      summary: `${STORES[storeId] ? STORES[storeId].name : storeId}: checked ${rows.length} storefront snippets, ${risky} risky promise${risky === 1 ? "" : "s"} listed for Reilly (nothing changed on the store)`,
      data: { checked: rows.length, risky }, at: nowIso(nowMs),
    });
  }
  return out;
}

async function markRows(db, rows, verdict, category, why, model, nowMs) {
  for (const row of rows) {
    await db.prepare(`UPDATE risk_claims SET verdict = ?, category = ?, why = ?, model = ?, classified_at = ? WHERE id = ? AND verdict = 'pending'`)
      .bind(verdict, category, why, model, nowIso(nowMs), row.id).run();
  }
}

/** Run collection for the first live store whose weekly read is due (claimed by the caller). */
export async function collectDue(env, claim, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  for (const storeId of LIVE_STORE_IDS) {
    if (!(await claim(storeId))) continue;
    try {
      return { store: storeId, ...(await collectStore(env, storeId, { nowMs, fetchImpl })) };
    } catch (err) {
      return { store: storeId, error: await logProblem(env.DB, ACTOR, storeId, err, `${STORES[storeId].name} claims read`, nowMs) };
    }
  }
  return null;
}
