/**
 * Personal-details scan (part of risk.claims_audit) — plain code, SHADOW: reports only, never
 * edits the store.
 *
 * Why: Reilly's own details have leaked onto the storefronts before (vault: "Home Address
 * Removal - H&C - 2026-08-18"; Memory Log 2026-10-13: the Kansas entity address on H&C,
 * Auberlane and Marlowe, Tundrelle's terms citing "the laws of Kansas", the 913 phone on every
 * store, the personal Gmail as contact / sender on Marlowe and Auberlane). Each one links the
 * stores to a private person and to each other, which Google can read as one operator.
 *
 * What it does: on the same weekly read as the Claims Auditor (theme files, recent product
 * descriptions, policies), plus the store's customer-facing settings (contact email and the
 * store address shown on invoices and order emails: `shop.contactEmail`, `shop.billingAddress`,
 * read-only), every text is matched against PERSONAL_PATTERNS. Every match is a HIGH-severity
 * finding, kept open until a later weekly read no longer finds it.
 * Settings Shopify refuses to show (missing scope) are "not wired", never "clean".
 */
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { STORES } from "../../config/stores.js";

export const ACTOR = "risk.claims_audit";

/**
 * Reilly's personal details that must never be customer-facing. Plain patterns, deliberately
 * broad (a false alarm costs a glance; a miss can cost a Merchant Center account).
 */
export const PERSONAL_PATTERNS = Object.freeze([
  { id: "olathe", label: "home town (Olathe)", re: /\bOlathe\b/i },
  { id: "overland_park", label: "old Kansas address (Overland Park)", re: /\bOverland\s+Park\b/i },
  { id: "indian_creek", label: "home address (Indian Creek)", re: /\bIndian\s+Creek\b/i },
  { id: "169th", label: "home street (169th)", re: /\b169th\b/i },
  { id: "kansas", label: "Kansas", re: /\bKansas\b/i },
  { id: "ks_zip", label: "Kansas ZIP (KS 66...)", re: /\bKS[,.]?\s*66\d{0,3}\b/i },
  { id: "personal_gmail", label: "personal Gmail (reillyworking26@gmail.com)", re: /reillyworking26@gmail\.com/i },
  { id: "phone_913", label: "personal phone (913 area code)", re: /(?:\+?1[\s.\-]?)?(?:\(913\)|\b913)[\s.\-]?\d{3}[\s.\-]?\d{4}\b/ },
]);

/** Settings Shopify shows customers (read-only). Validated fields of Admin GraphQL `Shop`. */
export const SHOP_SETTINGS_QUERY = `query RiskShopSettings { shop { name contactEmail billingAddress { address1 address2 city province zip country phone } } }`;

/** Pure: every personal-detail match in one text, with a short excerpt around it. */
export function scanText(text) {
  const s = String(text || "");
  const hits = [];
  for (const p of PERSONAL_PATTERNS) {
    const m = p.re.exec(s);
    if (!m) continue;
    const a = Math.max(0, m.index - 40), b = Math.min(s.length, m.index + m[0].length + 40);
    hits.push({ pattern: p.id, label: p.label, excerpt: `${a > 0 ? "…" : ""}${s.slice(a, b).replace(/\s+/g, " ").trim()}${b < s.length ? "…" : ""}` });
  }
  return hits;
}

/** Pure: scan many {source, text} items; one hit per (source, pattern). */
export function scanItems(items) {
  const out = new Map();
  for (const it of items || []) {
    for (const h of scanText(it.text)) {
      const k = `${it.source}|${h.pattern}`;
      if (!out.has(k)) out.set(k, { source: it.source, ...h });
    }
  }
  return [...out.values()];
}

/** Pure: the customer-facing settings as scannable items. */
export function settingsItems(shop) {
  if (!shop) return [];
  const items = [];
  if (shop.contactEmail) items.push({ source: "settings:contact_email", text: shop.contactEmail });
  const a = shop.billingAddress;
  if (a) items.push({ source: "settings:store_address", text: [a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone].filter(Boolean).join(", ") });
  return items;
}

/** Store this week's hits: new ones opened, ones no longer found closed. Returns {found, added}. */
export async function saveHits(db, storeId, hits, { nowMs = Date.now(), scannedSources = null } = {}) {
  const at = nowIso(nowMs);
  let added = 0;
  for (const h of hits) {
    const had = await db.prepare(`SELECT id, cleared_at FROM risk_personal_hits WHERE store = ? AND source = ? AND pattern = ?`).bind(storeId, h.source, h.pattern).first();
    await db.prepare(
      `INSERT INTO risk_personal_hits (store, source, pattern, label, excerpt, severity, found_at, last_seen_at, cleared_at)
       VALUES (?, ?, ?, ?, ?, 'high', ?, ?, NULL)
       ON CONFLICT(store, source, pattern) DO UPDATE SET excerpt = excluded.excerpt, label = excluded.label, last_seen_at = excluded.last_seen_at,
         found_at = CASE WHEN risk_personal_hits.cleared_at IS NOT NULL THEN excluded.found_at ELSE risk_personal_hits.found_at END, cleared_at = NULL`
    ).bind(storeId, h.source, h.pattern, h.label, h.excerpt.slice(0, 300), at, at).run();
    if (!had || had.cleared_at) added++;
  }
  // Close hits not found this time, but only in sources that were actually read this time
  // (a source Shopify didn't show is unknown, not clean).
  const { results } = await db.prepare(`SELECT id, source, pattern FROM risk_personal_hits WHERE store = ? AND cleared_at IS NULL`).bind(storeId).all();
  const seen = new Set(hits.map((h) => `${h.source}|${h.pattern}`));
  for (const r of results || []) {
    if (seen.has(`${r.source}|${r.pattern}`)) continue;
    const kind = String(r.source).split(":")[0];
    if (scannedSources && !scannedSources.has(kind)) continue;
    await db.prepare(`UPDATE risk_personal_hits SET cleared_at = ? WHERE id = ?`).bind(at, r.id).run();
  }
  if (added) {
    const name = STORES[storeId] ? STORES[storeId].name : storeId;
    const fresh = hits.slice(0, 6).map((h) => `${h.label} in ${h.source}`).join("; ");
    await logEvent(db, {
      actor: ACTOR, kind: "risk.personal_details", store: storeId, target: "sys.shopify", at,
      summary: `${name}: Reilly's personal details are customer-facing (${added} new, high severity): ${fresh}${hits.length > 6 ? "; more on the Risk page" : ""}. Report only: nothing was changed on the store.`.slice(0, 480),
      data: { added, found: hits.length, patterns: [...new Set(hits.map((h) => h.pattern))] },
    });
  }
  return { found: hits.length, added };
}
