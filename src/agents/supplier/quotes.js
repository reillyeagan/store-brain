/**
 * Quote Desk (sup.quote_desk) + Denial Sync (sup.denial_sync) — plain code, SHADOW.
 *
 * What it does: takes KFB quotations that came in (table kfb_quotes), reads each product's
 * live prices from Shopify (read-only), and works out, per Reilly's pricing rules, the new
 * price and compare-at for every quoted product, and "draft this product" for every
 * product KFB denied. Each store's batch becomes ONE approval ("H&C: reprice 12 · draft 3").
 *
 * Reilly, 2026-10-11: "when quotes come back, I just auto approve all them and then adjust
 * the live store prices accordingly with what the quoted price is, and whatever products got
 * denied i draft them on the live store." · "yes i need to approve every price rewrite, as
 * well as draft products, etc"
 *
 * Inputs:  kfb_quotes (filled by the KFB Morning Session, planned, or importQuotes() below),
 *          Shopify products (read_products), supplier_price_holds.
 * Outputs: supplier_batches + supplier_plans rows, one approval per store batch, events.
 * Never:   writes to Shopify (no write scope; Catalog's Product Status applies an approved
 *          batch later with backup, Store Guard and verification). Never touches KFB.
 *
 * Rules kept here:
 *  - Match by store link HANDLE, never title or KFB SKU (spec).
 *  - Store prices come from Shopify, never KFB's stale un_good_price (spec).
 *  - "Similar" quotes are priced like exact matches (Reilly: "q4 always fine").
 *  - While a store's previous batch is still waiting on Reilly, new quotes wait too: no
 *    second approval for the same store (no flood, no conflicting price lists).
 */
import { LIVE_STORE_IDS, STORES, getStore } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { EUR_USD_ESTIMATE } from "../../lib/pnl.js";
import { planVariantPrice, rulesFor } from "./pricing.js";
import { DEPT, handleFrom, logOnce, money } from "./common.js";

const ACTOR = "sup.quote_desk";
const DENIAL_ACTOR = "sup.denial_sync";

/** KFB quotation status codes (spec, Quote Desk). */
export const STATUS_BY_CODE = Object.freeze({ 10: "pending", 25: "awaiting_reilly", 26: "denied", 30: "quoted", 40: "unknown" });
const STATUS_WORDS = Object.freeze({
  pending: "pending", "to-quote": "pending", priority: "pending",
  awaiting: "awaiting_reilly", awaiting_reilly: "awaiting_reilly", confirm: "awaiting_reilly",
  denied: "denied", quoted: "quoted", unknown: "unknown",
});

/** How many products one store's batch covers per run (one Shopify query of ≤ 25 handles). */
export const MAX_HANDLES_PER_RUN = 25;

/**
 * FX for EUR quotes. Spec: "EUR billed → USD at the actual card rate". The card-rate feed is
 * not wired, so the quoting-sheet rate (1.17, same constant the P&L uses) is used and every
 * batch says so. Reilly approves every price, so he sees it before anything changes.
 */
export const FX = Object.freeze({ rate: EUR_USD_ESTIMATE, source: "quoting-sheet rate 1.17 (estimate: card-rate feed not wired)" });

/**
 * Import quotes (from the KFB Morning Session, a CSV of Reilly's quote sheet, or by hand).
 * No network. Duplicates (same store + handle + variant + status + time) are ignored.
 *
 * Expected columns per row (case-insensitive keys):
 *   store       store id ("hc") or KFB shop code ("jmzjx1-it")          required
 *   link|handle the store product link (…/products/<handle>) or handle  required
 *   status      KFB code 10/25/26/30/40 or word quoted|denied|awaiting|pending|unknown  required
 *   cost        quoted unit cost (KFB manual_pricing…nameOne)           required when quoted
 *   currency    default EUR (KFB bills in EUR)
 *   quoted_at   when KFB quoted / changed status (ISO date)             required
 *   remark      KFB order_remark (denial reason, "only similar ones")
 *   variant_id  Shopify variant id, only for a one-variant quote
 *   sku, kfb_id information only (never used to match)
 *   similar     true/false; defaults to true when the remark mentions "similar"
 *
 * @returns {{inserted:number, duplicates:number, rejected:{row:number, reason:string}[]}}
 */
export async function importQuotes(db, rows, { source = "manual", nowMs = Date.now() } = {}) {
  const out = { inserted: 0, duplicates: 0, rejected: [] };
  const at = nowIso(nowMs);
  for (let i = 0; i < (rows || []).length; i++) {
    const r = lowerKeys(rows[i]);
    const v = validateQuoteRow(r);
    if (v.reason) { out.rejected.push({ row: i, reason: v.reason }); continue; }
    const res = await db.prepare(
      `INSERT OR IGNORE INTO kfb_quotes (store, product_handle, variant_id, sku, kfb_quote_id, status_code, status, cost, currency,
         quoted_at, remark, similar, source, imported_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(v.store, v.handle, v.variantId, r.sku ?? null, r.kfb_id ?? r.kfb_quote_id ?? null, v.code, v.status, v.cost, v.currency,
      v.quotedAt, r.remark ?? null, v.similar ? 1 : 0, source, at).run();
    if (res.meta && res.meta.changes) out.inserted++; else out.duplicates++;
  }
  if (out.inserted || out.rejected.length) {
    await logEvent(db, {
      actor: ACTOR, kind: "quotes.imported", target: "sys.kfb", at,
      summary: `Imported ${out.inserted} KFB quote row${out.inserted === 1 ? "" : "s"} (${source})` +
        (out.duplicates ? `, ${out.duplicates} already known` : "") + (out.rejected.length ? `, ${out.rejected.length} rejected` : ""),
      data: { ...out, rejected: out.rejected.slice(0, 20) },
    });
  }
  return out;
}

function lowerKeys(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[String(k).trim().toLowerCase()] = typeof v === "string" ? v.trim() : v;
  return out;
}

/** Validate one import row. Returns the clean values or {reason}. */
export function validateQuoteRow(r) {
  const storeRaw = String(r.store ?? "").toLowerCase();
  const store = getStore(storeRaw) ? storeRaw
    : (Object.values(STORES).find((s) => s.kfbShopCode && s.kfbShopCode === storeRaw) || {}).id;
  if (!store) return { reason: `unknown store "${r.store ?? ""}"` };
  if (!STORES[store].live) return { reason: `${STORES[store].name} is not live` };
  const handle = handleFrom(r.link ?? r.handle ?? r.product_handle);
  if (!handle) return { reason: "no store link / handle (quotes are matched by handle, never title or SKU)" };
  const st = String(r.status ?? "").trim().toLowerCase();
  const code = /^\d+$/.test(st) ? Number(st) : null;
  const status = code != null ? (STATUS_BY_CODE[code] || "unknown") : STATUS_WORDS[st];
  if (!status) return { reason: `unknown status "${r.status ?? ""}"` };
  const quotedAt = r.quoted_at && !Number.isNaN(Date.parse(r.quoted_at)) ? new Date(Date.parse(r.quoted_at)).toISOString() : null;
  if (!quotedAt) return { reason: "quoted_at missing or not a date" };
  let cost = null;
  if (r.cost != null && r.cost !== "") {
    cost = Number(String(r.cost).replace(/[€$,\s]/g, ""));
    if (!(cost > 0)) return { reason: `cost "${r.cost}" is not a positive number` };
  }
  if (status === "quoted" && cost == null) return { reason: "a quoted row needs its cost" };
  const currency = String(r.currency || "EUR").toUpperCase();
  if (!["EUR", "USD"].includes(currency)) return { reason: `currency ${currency} not supported (EUR or USD)` };
  const similar = r.similar != null && r.similar !== "" ? /^(1|true|yes|y)$/i.test(String(r.similar)) : /similar/i.test(String(r.remark || ""));
  const variantId = r.variant_id ? String(r.variant_id) : "";
  return { store, handle, code, status, quotedAt, cost, currency, similar, variantId };
}

/* ---------------------------------------------------------------- Quote Desk run */

export const PRODUCTS_BY_HANDLE_QUERY = `query SupplierQuoteProducts($q: String!) {
  products(first: 50, query: $q) {
    nodes { id handle title status productType
      variants(first: 100) { nodes { id title price compareAtPrice } } }
  }
}`;

/** One Shopify read for a list of handles (read_products). Returns Map handle → product. */
async function readProducts(env, store, handles, fetchImpl, nowMs) {
  const q = handles.map((h) => `handle:${h}`).join(" OR ");
  const data = await shopifyGraphQL(env, store, PRODUCTS_BY_HANDLE_QUERY, { q }, { fetchImpl, nowMs });
  const map = new Map();
  for (const n of (data && data.products && data.products.nodes) || []) {
    // Shopify's search is fuzzy; only an exact handle counts as a match.
    if (handles.includes(n.handle)) map.set(n.handle, n);
  }
  return map;
}

const num = (x) => (x == null || x === "" ? null : Number(x));
const sameId = (a, b) => !!a && !!b && (a === b || String(a).split("/").pop() === String(b).split("/").pop());

/** H&C outerwear standing hold (Reilly 09-01): held at $114.95 under band. */
const HC_OUTERWEAR_HOLD = 114.95;
const OUTERWEAR_RE = /\b(outerwear|coat|overcoat|jacket|parka|peacoat|trench)\b/i;

/**
 * Run the Quote Desk for every live store. Never throws for one store's problem.
 * @returns {Promise<object[]>} per-store results
 */
export async function runQuoteDesk(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  const results = [];
  for (const store of LIVE_STORE_IDS) {
    if (!rulesFor(store)) { results.push({ store, skipped: "no pricing rules" }); continue; }
    try {
      results.push(await quoteDeskForStore(env, store, { nowMs, fetchImpl }));
    } catch (err) {
      const notWired = err && err.code === "NOT_WIRED";
      await logOnce(db, {
        actor: ACTOR, kind: notWired ? "quotes.not_wired" : "error.quote_desk", store, target: "sys.shopify",
        summary: notWired ? `${STORES[store].name}: Shopify not wired, quotes wait (${err.message})`
          : `${STORES[store].name}: couldn't read Shopify prices for the quote batch; quotes stay open and retry (${String(err && err.message).slice(0, 160)})`,
      }, { withinMin: 360, nowMs });
      results.push({ store, [notWired ? "skipped" : "error"]: String(err && err.message) });
    }
  }
  return results;
}

async function quoteDeskForStore(env, store, { nowMs, fetchImpl }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const name = STORES[store].name;

  // One approval at a time per store: wait while the last batch is undecided.
  const waiting = await db.prepare(
    `SELECT b.id FROM supplier_batches b JOIN approvals a ON a.id = b.approval_id
      WHERE b.store = ? AND b.status = 'awaiting_approval' AND a.status = 'pending' LIMIT 1`
  ).bind(store).first();

  const { results: open } = await db.prepare(
    `SELECT * FROM kfb_quotes WHERE store = ? AND processed_at IS NULL AND status IN ('quoted','denied')
      ORDER BY quoted_at, id LIMIT 500`
  ).bind(store).all();
  if (!open || !open.length) return { store, open: 0 };
  if (waiting) return { store, open: open.length, waiting: `batch ${waiting.id} still waiting on Reilly` };

  // Latest quote per (handle, variant) wins; older ones are superseded.
  const latest = new Map();
  const superseded = [];
  for (const q of open) {
    const k = `${q.product_handle}|${q.variant_id || ""}`;
    if (latest.has(k)) superseded.push(latest.get(k).id);
    latest.set(k, q);
  }
  const byHandle = new Map();
  for (const q of latest.values()) {
    if (!byHandle.has(q.product_handle)) byHandle.set(q.product_handle, []);
    byHandle.get(q.product_handle).push(q);
  }
  const handles = [...byHandle.keys()].slice(0, MAX_HANDLES_PER_RUN);

  const products = await readProducts(env, store, handles, fetchImpl, nowMs);
  const readAt = nowIso(nowMs);
  const { results: holdRows } = await db.prepare(`SELECT * FROM supplier_price_holds WHERE store = ?`).bind(store).all();
  const holds = new Map((holdRows || []).map((h) => [h.product_handle, h]));

  const plans = handles.map((h) => planProduct(store, h, byHandle.get(h), products.get(h), holds.get(h)));

  const reprices = plans.filter((p) => p.kind === "reprice");
  const drafts = plans.filter((p) => p.kind === "draft");
  const waivers = reprices.filter((p) => p.waiver_price != null);

  const batch = await db.prepare(
    `INSERT INTO supplier_batches (store, created_at, prices_read_at, reprice_count, draft_count, waiver_count, fx_rate, fx_source, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(store, at, readAt, reprices.length, drafts.length, waivers.length, FX.rate, FX.source,
    reprices.length + drafts.length ? "awaiting_approval" : "nothing_to_approve").run();
  const batchId = batch.meta.last_row_id;

  for (const p of plans) {
    await db.prepare(
      `INSERT INTO supplier_plans (batch_id, store, kind, quote_id, product_id, product_handle, title, product_type, shop_status,
         cost, currency, cost_usd, old_price, new_price, old_compare_at, new_compare_at, cogs_old, cogs_new, waiver_price,
         variants, reason, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(batchId, store, p.kind, p.quote_id, p.product_id, p.product_handle, p.title, p.product_type, p.shop_status,
      p.cost, p.currency, p.cost_usd, p.old_price, p.new_price, p.old_compare_at, p.new_compare_at, p.cogs_old, p.cogs_new,
      p.waiver_price, JSON.stringify(p.variants || []), p.reason, JSON.stringify(p.notes || []), at).run();
    for (const q of byHandle.get(p.product_handle)) {
      await db.prepare(`UPDATE kfb_quotes SET processed_at = ?, batch_id = ?, outcome = ? WHERE id = ?`).bind(at, batchId, p.kind, q.id).run();
    }
  }
  for (const id of superseded) {
    await db.prepare(`UPDATE kfb_quotes SET processed_at = ?, batch_id = ?, outcome = 'superseded' WHERE id = ? AND processed_at IS NULL`)
      .bind(at, batchId, id).run();
  }

  let approvalId = null;
  if (reprices.length || drafts.length) {
    approvalId = await createApproval(db, {
      dept: DEPT, requestedBy: ACTOR, store,
      title: `${name}: ${batchTitle(reprices.length, drafts.length)} (KFB quotes)`,
      options: approvalOptions(reprices, drafts, waivers),
    });
    await db.prepare(`UPDATE supplier_batches SET approval_id = ? WHERE id = ?`).bind(approvalId, batchId).run();
  }

  const counts = plans.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
  await logEvent(db, {
    actor: ACTOR, kind: "quotes.planned", store, target: approvalId ? "core.approvals" : "sys.shopify", at,
    summary: `${name}: ${handles.length} quoted product${handles.length === 1 ? "" : "s"} checked against Shopify prices → ` +
      `${reprices.length} reprice${reprices.length === 1 ? "" : "s"} proposed` + (waivers.length ? ` (${waivers.length} held by the $144.95 ceiling)` : "") +
      (counts.no_change ? `, ${counts.no_change} already right` : "") + (counts.held ? `, ${counts.held} held` : "") +
      (counts.unmatched ? `, ${counts.unmatched} not found in the store` : "") + " (shadow: nothing changed)",
    data: { batchId, approvalId, counts, fx: FX },
  });
  if (drafts.length || counts.already_off) {
    await logEvent(db, {
      actor: DENIAL_ACTOR, kind: "denials.planned", store, target: approvalId ? "core.approvals" : "sys.shopify", at,
      summary: `${name}: KFB denied ${drafts.length + (counts.already_off || 0)} product${drafts.length + (counts.already_off || 0) === 1 ? "" : "s"}; ` +
        `${drafts.length} still active → proposed for draft in the same approval` + (counts.already_off ? `, ${counts.already_off} already off` : ""),
      data: { batchId, approvalId, handles: drafts.map((d) => d.product_handle) },
    });
  }
  return { store, open: open.length, batchId, approvalId, counts, remaining: byHandle.size - handles.length };
}

/**
 * Plan one product from its latest quotes and its Shopify record. Pure.
 * kinds: reprice | no_change | draft | already_off | not_active | held | unmatched | cannot_price
 */
export function planProduct(store, handle, quotes, product, hold = null, fx = FX) {
  const base = {
    product_handle: handle, quote_id: null, product_id: null, title: null, product_type: null, shop_status: null,
    cost: null, currency: null, cost_usd: null, old_price: null, new_price: null, old_compare_at: null, new_compare_at: null,
    cogs_old: null, cogs_new: null, waiver_price: null, variants: [], reason: null, notes: [],
  };
  const productQuote = quotes.find((q) => !q.variant_id) || null;
  const lead = productQuote || quotes[0];
  base.quote_id = lead.id;
  if (lead.similar) base.notes.push('KFB quoted "only similar ones": priced like an exact match (Reilly: "q4 always fine")');

  if (!product) return { ...base, kind: "unmatched", reason: `no product with handle "${handle}" in ${STORES[store].name} (quote kept for the record, not guessed by title)` };
  Object.assign(base, { product_id: product.id, title: product.title, product_type: product.productType || null, shop_status: product.status });

  // Denial Sync: a whole-product denial → draft (zeroing inventory does nothing on these stores).
  if (productQuote && productQuote.status === "denied") {
    const why = productQuote.remark ? `KFB: "${productQuote.remark}"` : "KFB denied the quote (no reason given)";
    if (product.status === "ACTIVE") return { ...base, kind: "draft", reason: why };
    return { ...base, kind: "already_off", reason: `${why}; already ${String(product.status).toLowerCase()}` };
  }
  if (product.status !== "ACTIVE") return { ...base, kind: "not_active", reason: `product is ${String(product.status).toLowerCase()}: not repriced` };

  const variants = (product.variants && product.variants.nodes) || [];
  const rows = [];
  for (const v of variants) {
    const vq = quotes.find((q) => q.variant_id && sameId(q.variant_id, v.id));
    const q = vq || productQuote;
    if (!q) continue;
    if (q.status === "denied") { base.notes.push(`variant ${v.title || v.id} denied by KFB (variants are not drafted one by one)`); continue; }
    const usd = toUsd(q.cost, q.currency, fx);
    if (usd == null) return { ...base, kind: "cannot_price", reason: `cost ${q.cost} ${q.currency} can't be converted` };
    const price = num(v.price); const cmp = num(v.compareAtPrice);
    const p = planVariantPrice(store, { costUsd: usd, price, compareAt: cmp });
    rows.push({ id: v.id, title: v.title, cost_usd: round2(usd), old_price: price, new_price: p.newPrice, old_compare_at: cmp,
      new_compare_at: p.newCompareAt, tier: p.tier, change: p.change, cogs_old: round4(p.cogsOld), cogs_new: round4(p.cogsNew),
      waiver_price: p.waiverPrice, rule: p.rule, notes: p.notes });
  }
  if (!rows.length) return { ...base, kind: "cannot_price", reason: "no variant has a usable quote" };

  const first = rows[0];
  const q0 = productQuote || quotes.find((q) => q.status === "quoted");
  Object.assign(base, {
    cost: q0 ? q0.cost : null, currency: q0 ? q0.currency : null, cost_usd: first.cost_usd,
    old_price: first.old_price, new_price: first.new_price, old_compare_at: first.old_compare_at, new_compare_at: first.new_compare_at,
    cogs_old: first.cogs_old, cogs_new: first.cogs_new, variants: rows,
    waiver_price: rows.reduce((m, r) => (r.waiver_price != null && r.change ? Math.max(m ?? 0, r.waiver_price) : m), null),
    reason: first.rule,
  });
  base.notes.push(...new Set(rows.flatMap((r) => r.notes)));
  if (q0 && String(q0.currency).toUpperCase() === "EUR") base.notes.push(`EUR→USD at ${fx.source}`);

  if (!rows.some((r) => r.change)) return { ...base, kind: "no_change" };

  // Standing holds: never re-proposed unless the cost changed.
  if (hold && Math.round(hold.held_price * 100) === Math.round(first.old_price * 100) &&
      (hold.cost_at_hold == null || Math.abs(hold.cost_at_hold - first.cost_usd) < 0.01)) {
    return { ...base, kind: "held", reason: `held at ${money(hold.held_price)}${hold.words ? ` (Reilly: "${hold.words}")` : ""}; cost unchanged` };
  }
  if (!hold && store === "hc" && Math.round(first.old_price * 100) === Math.round(HC_OUTERWEAR_HOLD * 100) &&
      OUTERWEAR_RE.test(`${product.productType || ""} ${product.title || ""}`)) {
    return { ...base, kind: "held", reason: "H&C outerwear is held at $114.95 under band (Reilly 09-01): not re-proposed. Add it to supplier_price_holds with its cost so a cost change re-opens it." };
  }
  return { ...base, kind: "reprice" };
}

export function toUsd(cost, currency, fx = FX) {
  const c = Number(cost);
  if (!(c > 0)) return null;
  const cur = String(currency || "EUR").toUpperCase();
  if (cur === "USD") return c;
  if (cur === "EUR") return c * fx.rate;
  return null;
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const round4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

export function batchTitle(r, d) {
  const parts = [];
  if (r) parts.push(`reprice ${r}`);
  if (d) parts.push(`draft ${d}`);
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Old → new list for the approval (the full list is on the Supplier page). */
function lines(plans, max = 12) {
  const out = plans.slice(0, max).map((p) => p.kind === "draft"
    ? `${p.title || p.product_handle}: draft (${p.reason})`
    : `${p.title || p.product_handle}: ${money(p.old_price)} → ${money(p.new_price)}` +
      (p.old_compare_at !== p.new_compare_at ? `, compare-at ${money(p.old_compare_at)} → ${money(p.new_compare_at)}` : "") +
      (p.waiver_price != null ? ` (band needs ${money(p.waiver_price)})` : ""));
  if (plans.length > max) out.push(`+${plans.length - max} more on the Supplier page`);
  return out.join("\n");
}

const APPLY_NOTE = "Nothing changes until you approve. Catalog applies it with an R2 backup, Store Guard, and checks every variant against Shopify after.";

export function approvalOptions(reprices, drafts, waivers) {
  const opts = [];
  const all = [...reprices, ...drafts];
  opts.push({ id: "approve_all", label: batchTitle(reprices.length, drafts.length), detail: `${lines(all)}\n\n${APPLY_NOTE}` });
  if (reprices.length && drafts.length) {
    opts.push({ id: "reprice_only", label: `Reprice ${reprices.length} only`, detail: lines(reprices) });
    opts.push({ id: "drafts_only", label: `Draft ${drafts.length} only`, detail: lines(drafts) });
  }
  if (waivers.length) {
    opts.push({
      id: "approve_all_waive_ceiling",
      label: `Approve all, lifting the $144.95 ceiling for ${waivers.length}`,
      detail: `${waivers.map((p) => `${p.title || p.product_handle}: ${money(p.old_price)} → ${money(p.waiver_price)} (above the ceiling, reaches band)`).slice(0, 12).join("\n")}\n\nOnly on your word: the brain never waives the ceiling itself.`,
    });
  }
  return opts.slice(0, 4);
}
