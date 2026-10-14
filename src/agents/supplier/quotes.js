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
 * Outputs: supplier_batches + supplier_plans rows, one approval per store batch, each matched
 *          quote's cost in core_facts (cost:product:<GID> / cost:sku:<SKU>, source kfb_quote), events.
 * Never:   writes to Shopify (no write scope, and no worker applies an approved batch: approving
 *          records Reilly's yes and he makes the change himself). Never touches KFB.
 *
 * Rules kept here (prices themselves come from the shared src/agents/catalog/pricingRules.js):
 *  - Match by store link HANDLE, never title or KFB SKU (spec).
 *  - Store prices come from Shopify, never KFB's stale un_good_price (spec).
 *  - "Similar" quotes are priced like exact matches (Reilly: "q4 always fine").
 *  - While a store's previous batch is still waiting on Reilly, new quotes wait too: no
 *    second approval for the same store. Newer quotes for products in that batch supersede it;
 *    a batch nobody answers expires after 3 days. Batch status follows its approval.
 *  - Holds (supplier_price_holds, H&C outerwear at $114.95) keep the cost at hold time and are
 *    proposed again once the cost changes.
 */
import { LIVE_STORE_IDS, STORES, getStore } from "../../config/stores.js";
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { createApproval } from "../../lib/approvals.js";
import { logEvent } from "../../lib/eventlog.js";
import { nowIso } from "../../lib/time.js";
import { EUR_USD_ESTIMATE } from "../../lib/pnl.js";
import { planVariantPrice, rulesFor } from "./pricing.js";
import { DEPT, handleFrom, logOnce, money } from "./common.js";
// Same outerwear test as Catalog's hold (plurals, topcoat, puffer, tags), so the two never disagree.
import { isOuterwear } from "../catalog/common.js";

const ACTOR = "sup.quote_desk";
const DENIAL_ACTOR = "sup.denial_sync";

/**
 * KFB quotation status codes (spec, Quote Desk).
 * 40 was "unknown (flag)" in the spec. Reilly, 2026-10-13: "FFG quote status 40 i think means i
 * just havent approved it". So 40 is "waiting on Reilly's approval", kept as its own status
 * (awaiting_reilly_guess) rather than merged into 25 because it is his best guess ("i think"),
 * not a confirmed meaning. It is not an error and is never flagged as one; like 25 it is never
 * planned (only quoted/denied rows are).
 */
export const STATUS_BY_CODE = Object.freeze({ 10: "pending", 25: "awaiting_reilly", 26: "denied", 30: "quoted", 40: "awaiting_reilly_guess" });
/** Plain-English meaning per status, for screens and the digest. */
export const STATUS_LABELS = Object.freeze({
  pending: "waiting on KFB to quote",
  awaiting_reilly: "waiting on Reilly's KFB confirmation (status 25)",
  awaiting_reilly_guess: "waiting on Reilly's approval — status 40 (Reilly: FFG, 'i think')",
  denied: "denied by KFB",
  quoted: "quoted",
  unknown: "unknown status",
});
const STATUS_WORDS = Object.freeze({
  pending: "pending", "to-quote": "pending", priority: "pending",
  awaiting: "awaiting_reilly", awaiting_reilly: "awaiting_reilly", confirm: "awaiting_reilly",
  awaiting_reilly_guess: "awaiting_reilly_guess",
  denied: "denied", quoted: "quoted", unknown: "unknown",
});

/** How many products one store's batch covers per run: one Shopify page of 25, with room for fuzzy extras. */
export const MAX_HANDLES_PER_RUN = 20;

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
  // THE matching key: the store product handle. Reilly, 2026-10-13: "product handle is prob best"
  // (decision sup.kfb_match_key). KFB's own ids (un_good_id, kfb_id) and SKUs are kept for
  // information only and are never a fallback: no code here matches on them.
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

/**
 * Rows imported before 2026-10-13 hold KFB's raw code 40 (status_code) but the old meaning
 * "unknown". Re-mapped to the new meaning; the raw code is kept, so this is exact, not a guess
 * about which rows were 40. OR IGNORE: if the same quote already exists under the new status,
 * the old row is left as it was rather than breaking the UNIQUE key.
 */
export async function remapStatus40(db, nowMs = Date.now()) {
  const r = await db.prepare(`UPDATE OR IGNORE kfb_quotes SET status = 'awaiting_reilly_guess' WHERE status_code = 40 AND status = 'unknown'`).run();
  const n = (r.meta && r.meta.changes) || 0;
  if (n) {
    await logEvent(db, { actor: ACTOR, kind: "quotes.status40_remapped", at: nowIso(nowMs),
      summary: `${n} KFB quote row${n === 1 ? "" : "s"} at status 40 re-labelled from "unknown" to "${STATUS_LABELS.awaiting_reilly_guess}"`, data: { rows: n } });
  }
  return n;
}

/* ---------------------------------------------------------------- Quote Desk run */

/**
 * Query size is bounded by Shopify's 1000-point requested-cost limit:
 * 2 + PRODUCTS_PAGE × (1 product + 1 variantsCount + (2 + VARIANTS_PAGE + 1 pageInfo)) = 877.
 * (The first version asked for 50 × 100 variants ≈ 5150 points and would have been refused.)
 * Products with more variants than VARIANTS_PAGE are paged with VARIANT_PAGE_QUERY.
 */
export const PRODUCTS_PAGE = 25;
export const VARIANTS_PAGE = 30;
/** Extra variant pages allowed per run (keeps the Worker's subrequests bounded). */
export const MAX_VARIANT_PAGES_PER_RUN = 6;

export const PRODUCTS_BY_HANDLE_QUERY = `query SupplierQuoteProducts($q: String!) {
  products(first: ${PRODUCTS_PAGE}, query: $q) {
    nodes { id handle title status productType tags
      variantsCount { count }
      variants(first: ${VARIANTS_PAGE}) { nodes { id title sku price compareAtPrice } pageInfo { hasNextPage endCursor } } }
  }
}`;

export const VARIANT_PAGE_QUERY = `query SupplierQuoteVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 100, after: $after) { nodes { id title sku price compareAtPrice } pageInfo { hasNextPage endCursor } } }
}`;

/**
 * One Shopify read for a list of handles (read_products), plus variant pages when a product has
 * more than VARIANTS_PAGE variants. Returns {map: handle → product, full: page was full,
 * truncated: Set of handles whose variants could not all be read this run}.
 */
async function readProducts(env, store, handles, fetchImpl, nowMs) {
  const q = handles.map((h) => `handle:${h}`).join(" OR ");
  const data = await shopifyGraphQL(env, store, PRODUCTS_BY_HANDLE_QUERY, { q }, { fetchImpl, nowMs });
  const nodes = (data && data.products && data.products.nodes) || [];
  const map = new Map();
  const truncated = new Set();
  let pagesLeft = MAX_VARIANT_PAGES_PER_RUN;
  for (const n of nodes) {
    // Shopify's search is fuzzy; only an exact handle counts as a match.
    if (!handles.includes(n.handle)) continue;
    const variants = [...((n.variants && n.variants.nodes) || [])];
    let page = n.variants && n.variants.pageInfo;
    while (page && page.hasNextPage) {
      if (pagesLeft-- <= 0) { truncated.add(n.handle); break; }
      const more = await shopifyGraphQL(env, store, VARIANT_PAGE_QUERY, { id: n.id, after: page.endCursor }, { fetchImpl, nowMs });
      const v = more && more.product && more.product.variants;
      variants.push(...((v && v.nodes) || []));
      page = v && v.pageInfo;
    }
    const count = n.variantsCount && Number(n.variantsCount.count);
    if (Number.isFinite(count) && count > variants.length) truncated.add(n.handle);
    map.set(n.handle, { ...n, variants: { nodes: variants } });
  }
  return { map, full: nodes.length >= PRODUCTS_PAGE, truncated };
}

const num = (x) => (x == null || x === "" ? null : Number(x));
const sameId = (a, b) => !!a && !!b && (a === b || String(a).split("/").pop() === String(b).split("/").pop());

/** H&C outerwear standing hold (Reilly 09-01): held at $114.95 under band. */
const HC_OUTERWEAR_HOLD = 114.95;
const HC_OUTERWEAR_WORDS = "H&C outerwear held at $114.95 under band (Reilly 09-01)";

/** A batch nobody answered lapses after this long, so a store is never blocked forever. */
export const BATCH_EXPIRE_DAYS = 3;

/**
 * Keep each store's batches in step with their approvals: approved / rejected / executed /
 * expired are copied onto the batch; a batch still pending after BATCH_EXPIRE_DAYS expires
 * (its approval too). Returns the id of the batch still waiting on Reilly, or null.
 */
export async function settleBatches(db, store, nowMs = Date.now()) {
  const at = nowIso(nowMs);
  const { results } = await db.prepare(
    `SELECT b.id, b.created_at, b.approval_id, a.status AS ap FROM supplier_batches b JOIN approvals a ON a.id = b.approval_id
      WHERE b.store = ? AND b.status = 'awaiting_approval'`
  ).bind(store).all();
  let waiting = null;
  for (const b of results || []) {
    if (b.ap === "pending") {
      if (Date.parse(b.created_at) <= nowMs - BATCH_EXPIRE_DAYS * 86400000) {
        await expireBatch(db, b, "expired", `not answered in ${BATCH_EXPIRE_DAYS} days`, at);
      } else waiting = b.id;
      continue;
    }
    const status = b.ap === "executed" ? "approved" : b.ap; // approved | rejected | expired | failed
    await db.prepare(`UPDATE supplier_batches SET status = ? WHERE id = ?`).bind(status, b.id).run();
  }
  return waiting;
}

async function expireBatch(db, b, status, why, at) {
  await db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`)
    .bind(at, JSON.stringify({ closed_by: ACTOR, not_reilly: true, outcome: status, reason: `Expired by the brain: ${why}` }), b.approval_id).run();
  await db.prepare(`UPDATE supplier_batches SET status = ? WHERE id = ?`).bind(status, b.id).run();
  await logEvent(db, {
    actor: ACTOR, kind: `quotes.batch_${status}`, target: "core.approvals", at,
    summary: `Supplier batch ${b.id} ${status} (${why}); nothing was changed in the store`, data: { batchId: b.id, approvalId: b.approval_id },
  });
}

/**
 * Newer quotes for products already in the waiting batch make that batch out of date: it is
 * superseded (approval expired) and its quotes re-opened, so the next batch carries everything
 * with the latest costs. Returns true when it superseded.
 */
async function supersedeIfStale(db, store, batchId, openHandles, nowMs) {
  const { results } = await db.prepare(`SELECT DISTINCT product_handle FROM supplier_plans WHERE batch_id = ? AND kind IN ('reprice','draft')`).bind(batchId).all();
  const overlap = (results || []).map((r) => r.product_handle).filter((h) => openHandles.has(h));
  if (!overlap.length) return false;
  const b = await db.prepare(`SELECT id, approval_id FROM supplier_batches WHERE id = ?`).bind(batchId).first();
  await expireBatch(db, b, "superseded", `newer KFB quotes for ${overlap.length} of its products`, nowIso(nowMs));
  await db.prepare(`UPDATE kfb_quotes SET processed_at = NULL, batch_id = NULL, outcome = NULL WHERE batch_id = ? AND outcome IN ('reprice','draft')`).bind(batchId).run();
  return true;
}

/**
 * Write a quote's cost into the Core as cost:product:<GID> (and cost:sku:<SKU>) so Catalog's
 * Margin Guard and the P&L can use it. EUR stays EUR in the fact ({"amount","currency"}) so
 * every reader applies its own FX rule (the P&L waits for the card rate; Catalog uses the
 * flagged 1.17 estimate). A fact from Reilly or the vault is never overwritten or outranked.
 */
export async function writeQuoteCost(db, store, key, q, nowMs = Date.now()) {
  const at = nowIso(nowMs);
  const value = String(q.currency).toUpperCase() === "USD"
    ? JSON.stringify({ usd: q.cost })
    : JSON.stringify({ amount: q.cost, currency: String(q.currency).toUpperCase() });
  const { results } = await db.prepare(`SELECT id, source FROM core_facts WHERE live = 1 AND (store = ? OR store IS NULL) AND key = ?`).bind(store, key).all();
  if ((results || []).some((f) => /reilly|vault/i.test(f.source || ""))) return "kept";
  const mine = (results || []).find((f) => /^kfb_quote/i.test(f.source || ""));
  if (mine) {
    await db.prepare(`UPDATE core_facts SET value = ?, observed_at = ?, source = ? WHERE id = ?`)
      .bind(value, q.quoted_at || at, `kfb_quote:${q.id}`, mine.id).run();
    return "updated";
  }
  await db.prepare(
    `INSERT INTO core_facts (store, area, key, value, kind, source, observed_at, live) VALUES (?, 'supplier', ?, ?, 'observation', ?, ?, 1)`
  ).bind(store, key, value, `kfb_quote:${q.id}`, q.quoted_at || at).run();
  return "inserted";
}

/**
 * Run the Quote Desk for every live store. Never throws for one store's problem.
 * @returns {Promise<object[]>} per-store results
 */
export async function runQuoteDesk(env, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const db = env.DB;
  await remapStatus40(db, nowMs);
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

const OPEN_SQL = `SELECT * FROM kfb_quotes WHERE store = ? AND processed_at IS NULL AND status IN ('quoted','denied') ORDER BY quoted_at, id LIMIT 500`;

async function quoteDeskForStore(env, store, { nowMs, fetchImpl }) {
  const db = env.DB;
  const at = nowIso(nowMs);
  const name = STORES[store].name;

  const waiting = await settleBatches(db, store, nowMs);

  let { results: open } = await db.prepare(OPEN_SQL).bind(store).all();
  if (!open || !open.length) return { store, open: 0 };
  // One approval at a time per store: wait while the last batch is undecided, unless newer
  // quotes for its products have made it out of date.
  if (waiting) {
    if (!(await supersedeIfStale(db, store, waiting, new Set(open.map((q) => q.product_handle)), nowMs))) {
      return { store, open: open.length, waiting: `batch ${waiting} still waiting on Reilly` };
    }
    ({ results: open } = await db.prepare(OPEN_SQL).bind(store).all());
  }

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

  const read = await readProducts(env, store, handles, fetchImpl, nowMs);
  const readAt = nowIso(nowMs);
  const { results: holdRows } = await db.prepare(`SELECT * FROM supplier_price_holds WHERE store = ?`).bind(store).all();
  const holds = new Map((holdRows || []).map((h) => [h.product_handle, h]));

  // A full page with a handle missing might just be crowded out: leave it open for next run.
  // A product whose variants couldn't all be read is not priced from part of them.
  const planned = handles.filter((h) => read.map.has(h) || !read.full);
  const plans = planned.map((h) => {
    const p = planProduct(store, h, byHandle.get(h), read.map.get(h), holds.get(h));
    return read.truncated.has(h) && ["reprice", "no_change", "held"].includes(p.kind)
      ? { ...p, kind: "cannot_price", reason: "more variants than could be read this run: not priced from part of them", seedHold: null }
      : p;
  });

  const reprices = plans.filter((p) => p.kind === "reprice");
  const drafts = plans.filter((p) => p.kind === "draft");
  const waivers = reprices.filter((p) => p.waiver_price != null);

  const batch = await db.prepare(
    `INSERT INTO supplier_batches (store, created_at, prices_read_at, reprice_count, draft_count, waiver_count, fx_rate, fx_source, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(store, at, readAt, reprices.length, drafts.length, waivers.length, FX.rate, FX.source,
    reprices.length + drafts.length ? "awaiting_approval" : "nothing_to_approve").run();
  const batchId = batch.meta.last_row_id;

  let costFacts = 0;
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
    if (p.seedHold) {
      // Remember the cost at hold time, so a later cost change re-opens the product.
      await db.prepare(`INSERT INTO supplier_price_holds (store, product_handle, held_price, cost_at_hold, words, at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(store, product_handle) DO UPDATE SET cost_at_hold = excluded.cost_at_hold WHERE supplier_price_holds.cost_at_hold IS NULL`)
        .bind(store, p.product_handle, p.seedHold.held_price, p.seedHold.cost_at_hold, p.seedHold.words, at).run();
    }
    // Every matched quote's cost goes to the Core for Margin Guard / P&L.
    if (p.product_id) {
      for (const q of byHandle.get(p.product_handle)) {
        if (q.status !== "quoted" || !(q.cost > 0)) continue;
        if (!q.variant_id) { await writeQuoteCost(db, store, `cost:product:${p.product_id}`, q, nowMs); costFacts++; }
        const skus = (p.variants || []).filter((x) => x.sku && (q.variant_id ? sameId(q.variant_id, x.id) : true)).map((x) => x.sku);
        for (const sku of [...new Set(skus)]) { await writeQuoteCost(db, store, `cost:sku:${sku}`, q, nowMs); costFacts++; }
      }
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
    summary: `${name}: ${plans.length} quoted product${plans.length === 1 ? "" : "s"} checked against Shopify prices → ` +
      `${reprices.length} reprice${reprices.length === 1 ? "" : "s"} proposed` + (waivers.length ? ` (${waivers.length} held by the $144.95 ceiling)` : "") +
      (counts.no_change ? `, ${counts.no_change} already right` : "") + (counts.held ? `, ${counts.held} held` : "") +
      (counts.unmatched ? `, ${counts.unmatched} not found in the store` : "") + " (shadow: nothing changed)",
    data: { batchId, approvalId, counts, fx: FX, costFacts },
  });
  if (drafts.length || counts.already_off) {
    await logEvent(db, {
      actor: DENIAL_ACTOR, kind: "denials.planned", store, target: approvalId ? "core.approvals" : "sys.shopify", at,
      summary: `${name}: KFB denied ${drafts.length + (counts.already_off || 0)} product${drafts.length + (counts.already_off || 0) === 1 ? "" : "s"}; ` +
        `${drafts.length} still active → proposed for draft in the same approval` + (counts.already_off ? `, ${counts.already_off} already off` : ""),
      data: { batchId, approvalId, handles: drafts.map((d) => d.product_handle) },
    });
  }
  return { store, open: open.length, batchId, approvalId, counts, remaining: byHandle.size - planned.length };
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
    rows.push({ id: v.id, title: v.title, sku: v.sku || null, cost_usd: round2(usd), old_price: price, new_price: p.newPrice, old_compare_at: cmp,
      new_compare_at: p.newCompareAt, tier: p.tier, change: p.change, cogs_old: round4(p.cogsOld), cogs_new: round4(p.cogsNew),
      waiver_price: p.waiverPrice, rule: p.rule, notes: p.notes, below_min_margin: p.belowMinMargin });
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
    below_min_margin: rows.some((r) => r.below_min_margin),
  });
  base.notes.push(...new Set(rows.flatMap((r) => r.notes)));
  if (q0 && String(q0.currency).toUpperCase() === "EUR") base.notes.push(`EUR→USD at ${fx.source}`);

  if (!rows.some((r) => r.change)) return { ...base, kind: "no_change" };

  // Standing holds: never re-proposed unless the cost changed since the hold.
  const atPrice = (x) => Math.round(Number(x) * 100) === Math.round(first.old_price * 100);
  if (hold && atPrice(hold.held_price)) {
    if (hold.cost_at_hold == null) {
      return { ...base, kind: "held", seedHold: { held_price: hold.held_price, cost_at_hold: first.cost_usd, words: hold.words },
        reason: `held at ${money(hold.held_price)}${hold.words ? ` ("${hold.words}")` : ""}; cost ${money(first.cost_usd)} recorded so a change re-opens it` };
    }
    if (Math.abs(hold.cost_at_hold - first.cost_usd) < 0.01) {
      return { ...base, kind: "held", reason: `held at ${money(hold.held_price)}${hold.words ? ` ("${hold.words}")` : ""}; cost unchanged` };
    }
    base.notes.push(`was held at ${money(hold.held_price)}; cost moved ${money(hold.cost_at_hold)} → ${money(first.cost_usd)}, so it is proposed again`);
  } else if (!hold && store === "hc" && atPrice(HC_OUTERWEAR_HOLD) && isOuterwear({ product_type: product.productType, tags: product.tags || [], title: product.title })) {
    return { ...base, kind: "held", seedHold: { held_price: HC_OUTERWEAR_HOLD, cost_at_hold: first.cost_usd, words: HC_OUTERWEAR_WORDS },
      reason: `${HC_OUTERWEAR_WORDS}: not re-proposed while the cost stays ${money(first.cost_usd)}` };
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

/** One product's lines for the approval: every changed variant, old → new (nothing summarised away). */
export function planLines(p) {
  const name = p.title || p.product_handle;
  if (p.kind === "draft") return [`${name}: draft it (${p.reason})`];
  const one = (v) => `${money(v.old_price)} → ${money(v.new_price)}, compare-at ${money(v.old_compare_at)} → ${money(v.new_compare_at)}` +
    (v.waiver_price != null ? ` (band needs ${money(v.waiver_price)})` : "") +
    (v.below_min_margin ? " (UNDER the minimum margin per unit: your call)" : "");
  const changed = (p.variants || []).filter((v) => v.change);
  if (!changed.length) return [`${name}: ${one(p)}`];
  return [`${name}:`, ...changed.map((v) => `  ${v.title || v.id}: ${one(v)}`)];
}

const lines = (plans) => plans.flatMap(planLines).join("\n");

/** Said plainly: no worker applies a supplier batch (there is no Shopify write scope). */
export const APPLY_NOTE = "Approving records your yes; nothing is written to Shopify. Change the prices / draft the products yourself.";

export function approvalOptions(reprices, drafts, waivers) {
  const opts = [];
  const all = [...reprices, ...drafts];
  opts.push({ id: "approve_all", label: batchTitle(reprices.length, drafts.length), detail: `${lines(all)}\n\n${APPLY_NOTE}` });
  if (reprices.length && drafts.length) {
    opts.push({ id: "reprice_only", label: `Reprice ${reprices.length} only`, detail: `${lines(reprices)}\n\n${APPLY_NOTE}` });
    opts.push({ id: "drafts_only", label: `Draft ${drafts.length} only`, detail: `${lines(drafts)}\n\n${APPLY_NOTE}` });
  }
  if (waivers.length) {
    opts.push({
      id: "approve_all_waive_ceiling",
      label: `Approve all, lifting the $144.95 ceiling for ${waivers.length}`,
      detail: `${waivers.map((p) => `${p.title || p.product_handle}: ${money(p.old_price)} → ${money(p.waiver_price)} (above the ceiling, reaches band)`).join("\n")}\n\nOnly on your word: the brain never waives the ceiling itself. ${APPLY_NOTE}`,
    });
  }
  return opts.slice(0, 4);
}
