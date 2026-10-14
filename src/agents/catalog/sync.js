/**
 * Catalog reader — keeps a read-only copy of each live store's products in `cat_products`.
 *
 * What: pages through Shopify's products (Admin GraphQL, read_products + read_inventory, via
 * Store Guard with each store's own credentials), oldest-updated first. A FULL read happens
 * once a day (it also finds products deleted in Shopify); between full reads, a DELTA read
 * asks only for products whose updated_at moved since the last completed read
 * (`updated_at:>='<watermark>'`).
 *
 * Only ACTIVE and DRAFT products are read (STATUS_FILTER), on both passes. Why: every catalog
 * check (Pricing, Margin Guard, Product Status, New-Product Check) judges live or about-to-go-
 * live products. The stores carry many old archived products, and reading them made the first
 * full read so slow it never finished (live 2026-10-14: 760 read, never fresh). Consequences,
 * on purpose: a product archived in Shopify drops out of the copy on the next completed full
 * read (it is not seen, so it is deleted like a product deleted in Shopify); until then the
 * copy still shows its last status, at most FULL_EVERY_HOURS + a pass old.
 *
 * Pace: each catalog run (about twice an hour: Catalog has 2 of the 12 department slots) reads
 * up to MAX_PAGES_PER_TICK pages per store, inside a budget shared by all stores
 * (SYNC_PAGE_BUDGET, set by the caller), and stops EARLY (no error, cursor kept) when Shopify's
 * cost bucket can't pay for the next page or Shopify answers THROTTLED. A throttle is a pause,
 * not a failure: it is recorded as last_pause, never as last_error.
 *
 * Why delta + daily full: inventory changes don't always move a product's updated_at, and a
 * deleted product never shows up in a delta, so the daily full read keeps the copy honest.
 * Shadow: read only. Never calls a mutation.
 */
import { shopifyGraphQLWithCost } from "../../lib/storeGuard.js";
import { nowIso } from "../../lib/time.js";

/** 10 products × (30 variants with inventoryItem + 3 collections + small objects) ≈ 720 requested
 *  cost per page: under Shopify's 1,000 single-query limit. */
export const PAGE_SIZE = 10;
/**
 * Pages per store per run (was 4). 12 × 10 = 120 products a run, ~240 an hour at two catalog
 * runs an hour, when Shopify's bucket allows; the cost check below stops sooner when it doesn't.
 */
export const MAX_PAGES_PER_TICK = 12;
/** Kept for callers/tests that read the old name. */
export const PAGES_PER_TICK = MAX_PAGES_PER_TICK;
/**
 * Total product pages per catalog run, across ALL stores (the caller splits it, see
 * pagesForStore). Why 30: the Worker may make at most 50 outbound subrequests per invocation
 * on the Free plan (paid allows far more; we size for the strict limit). A catalog run makes
 * 30 product pages + up to 3 Shopify token mints (only when a cached token expired) + Merchant
 * Center health (1 Google token + ≤ 2 pages × 3 stores = 7, once a day) = 40 at worst, leaving
 * 10 spare. D1 queries go through the binding and count against the separate internal-services
 * limit (1,000): 30 pages × (10 upserts + 1 progress update) = 330, plus the checks' reads.
 */
export const SYNC_PAGE_BUDGET = 30;
/** Shopify search syntax (products query, `status` filter takes a comma-separated list:
 *  shopify.dev/docs/api/admin-graphql/latest/queries/products → status:active,draft). */
export const STATUS_FILTER = "status:active,draft";
export const FULL_EVERY_HOURS = 24;
/** The copy is only trusted when a full read finished this recently ... */
export const FULL_MAX_AGE_HOURS = 48;
/** ... and some read (full or delta) finished this recently (rule 4: freshness before numbers). */
export const PASS_MAX_AGE_HOURS = 3;

/** productsCount (same filter) tells us how big the pass is, for the time-to-complete estimate. */
export const PRODUCTS_QUERY = `query CatalogProducts($first: Int!, $after: String, $query: String) {
  productsCount(query: $query) { count precision }
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status productType tags createdAt updatedAt publishedAt
      description(truncateAt: 120)
      seo { title description }
      mediaCount { count }
      options { name }
      tracksInventory totalInventory
      collections(first: 3) { nodes { id } }
      variantsCount { count }
      variants(first: 30) { nodes { id sku title price compareAtPrice inventoryQuantity inventoryPolicy inventoryItem { tracked } } }
    }
  }
}`;

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/** Shopify product node → a cat_products row. */
export function rowFromNode(storeId, n, readAt) {
  const variants = ((n.variants && n.variants.nodes) || []).map((v) => ({
    id: v.id, sku: v.sku || null, title: v.title || null,
    price: num(v.price), compareAt: num(v.compareAtPrice),
    qty: v.inventoryQuantity == null ? null : Number(v.inventoryQuantity),
    policy: v.inventoryPolicy || null,
    tracked: v.inventoryItem ? !!v.inventoryItem.tracked : null,
  }));
  return {
    store: storeId, product_id: n.id, handle: n.handle || null, title: n.title || "",
    status: n.status || null, product_type: n.productType || null,
    tags: JSON.stringify(n.tags || []),
    created_at: n.createdAt || null, shopify_updated_at: n.updatedAt || null, published_at: n.publishedAt || null,
    description_len: String(n.description || "").trim().length,
    seo_title: (n.seo && n.seo.title) || null, seo_description: (n.seo && n.seo.description) || null,
    image_count: n.mediaCount ? Number(n.mediaCount.count) : null,
    option_names: JSON.stringify((n.options || []).map((o) => o.name)),
    tracks_inventory: n.tracksInventory == null ? null : (n.tracksInventory ? 1 : 0),
    total_inventory: n.totalInventory == null ? null : Number(n.totalInventory),
    collections_count: ((n.collections && n.collections.nodes) || []).length,
    variants_count: n.variantsCount ? Number(n.variantsCount.count) : variants.length,
    variants: JSON.stringify(variants),
    read_at: readAt,
  };
}

async function upsertProduct(db, r) {
  const cols = Object.keys(r);
  await db.prepare(
    `INSERT INTO cat_products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT(store, product_id) DO UPDATE SET ${cols.filter((c) => c !== "store" && c !== "product_id").map((c) => `${c} = excluded.${c}`).join(", ")}`
  ).bind(...cols.map((c) => r[c])).run();
}

export async function getSync(db, storeId) {
  return db.prepare(`SELECT * FROM cat_sync WHERE store = ?`).bind(storeId).first();
}

/** Is the copy fresh enough to judge from? {ready, reason} */
export function cacheReady(sync, nowMs) {
  if (!sync || !sync.last_full_at) {
    if (!(sync && sync.pass_kind === "full")) return { ready: false, reason: "products not read yet" };
    const of = sync.pass_total != null ? ` of ${sync.pass_total_precision === "AT_LEAST" ? "at least " : ""}${sync.pass_total}` : "";
    return { ready: false, reason: `first full read in progress (${sync.pass_read}${of} active/draft products so far)` };
  }
  const fullAgeH = (nowMs - Date.parse(sync.last_full_at)) / 3600000;
  const passAgeH = (nowMs - Date.parse(sync.last_pass_at || sync.last_full_at)) / 3600000;
  if (fullAgeH > FULL_MAX_AGE_HOURS) return { ready: false, reason: `last full read is ${Math.round(fullAgeH)}h old (limit ${FULL_MAX_AGE_HOURS}h)` };
  if (passAgeH > PASS_MAX_AGE_HOURS) return { ready: false, reason: `last read is ${Math.round(passAgeH)}h old (limit ${PASS_MAX_AGE_HOURS}h)` };
  return { ready: true, reason: null };
}

/** The Shopify search filter for a pass: always active + draft; a delta also by updated_at. */
export function passQuery(kind, watermark) {
  return kind === "full" ? STATUS_FILTER : `${STATUS_FILTER} AND updated_at:>='${watermark}'`;
}

/**
 * Can Shopify's bucket pay for another page like the last one? Uses the last response's
 * extensions.cost: the requested cost of the page just read is the best estimate of the next
 * one (same query, same page size). Unknown cost → go ahead; if Shopify then throttles, that
 * is caught as a pause too.
 */
export function canAffordNextPage(cost) {
  if (!cost) return true;
  const need = cost.requestedQueryCost;
  const have = cost.throttleStatus && cost.throttleStatus.currentlyAvailable;
  if (need == null || have == null) return true;
  return have >= need;
}

/**
 * Split the run's page budget fairly: each store gets an equal share of what is left, capped
 * at MAX_PAGES_PER_TICK, so pages a finished (or paused) store didn't use go to the next one.
 */
export function pagesForStore(budgetLeft, storesLeft) {
  if (budgetLeft <= 0 || storesLeft <= 0) return 0;
  return Math.max(1, Math.min(MAX_PAGES_PER_TICK, Math.floor(budgetLeft / storesLeft)));
}

/**
 * Pass progress for the dashboard: products read so far, how many the pass will read
 * (Shopify's productsCount for the same filter), and an estimate of time to completion from
 * this pass's own pace so far (null until there is a pace to go on: never a guess).
 */
export function passProgress(sync, nowMs) {
  if (!sync || !sync.pass_kind) return null;
  const read = Number(sync.pass_read || 0);
  const total = sync.pass_total == null ? null : Number(sync.pass_total);
  const startedMs = Date.parse(sync.pass_started_at || "");
  const hours = Number.isFinite(startedMs) ? (nowMs - startedMs) / 3600000 : null;
  const perHour = hours && hours > 0 && read > 0 ? read / hours : null;
  const left = total == null ? null : Math.max(0, total - read);
  const etaHours = perHour && left != null ? left / perHour : null;
  return {
    kind: sync.pass_kind, read, total, total_is_floor: sync.pass_total_precision === "AT_LEAST",
    started_at: sync.pass_started_at,
    products_per_hour: perHour == null ? null : Math.round(perHour),
    eta_hours: etaHours == null ? null : Math.round(etaHours * 10) / 10,
    eta_at: etaHours == null ? null : nowIso(nowMs + etaHours * 3600000),
    eta_note: etaHours == null
      ? (total == null ? "total not known yet" : "no pace yet (nothing read in this pass)")
      : "estimate from this pass's pace so far; Shopify throttling can slow it",
    last_pause: sync.last_pause_reason ? { reason: sync.last_pause_reason, at: sync.last_pause_at } : null,
  };
}

/**
 * Read up to `pages` pages for one store. Never throws for "not wired" or a Shopify throttle
 * (a throttle is a pause: it stops the tick, keeps the cursor and is NOT written as an error).
 * Other errors throw after saving them on the sync row (the cursor is kept, so the next tick
 * resumes).
 * @returns {{status:'ok'|'not_wired', read:number, calls:number, completed:boolean, kind:string|null,
 *            paused?:'throttled'|'cost', reason?:string}}
 */
export async function syncStore(env, storeId, { nowMs = Date.now(), fetchImpl = fetch, pages = MAX_PAGES_PER_TICK } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  let s = await getSync(db, storeId);
  if (!s) {
    await db.prepare(`INSERT OR IGNORE INTO cat_sync (store) VALUES (?)`).bind(storeId).run();
    s = await getSync(db, storeId);
  }

  // A pass started before the status filter existed (pass_query without it) pages a different
  // list, so its cursor means nothing under the new filter: start that pass again. Products it
  // already read stay in the copy and are simply read again.
  if (s.pass_kind && !String(s.pass_query || "").startsWith(STATUS_FILTER)) {
    await db.prepare(`UPDATE cat_sync SET pass_kind = NULL, pass_query = NULL, pass_cursor = NULL WHERE store = ?`).bind(storeId).run();
    s = await getSync(db, storeId);
  }

  // Start a pass if none is in progress.
  if (!s.pass_kind) {
    const fullDue = !s.last_full_at || (nowMs - Date.parse(s.last_full_at)) / 3600000 >= FULL_EVERY_HOURS || !s.watermark;
    const kind = fullDue ? "full" : "delta";
    await db.prepare(
      `UPDATE cat_sync SET pass_kind = ?, pass_query = ?, pass_cursor = NULL, pass_started_at = ?, pass_max_updated = NULL, pass_read = 0,
         pass_total = NULL, pass_total_precision = NULL WHERE store = ?`
    ).bind(kind, passQuery(kind, s.watermark), at, storeId).run();
    s = await getSync(db, storeId);
  }

  let cursor = s.pass_cursor, maxUpd = s.pass_max_updated, read = 0, calls = 0, done = false, paused = null, cost = null;
  try {
    for (let i = 0; i < pages && !done; i++) {
      if (!canAffordNextPage(cost)) { paused = "cost"; break; }
      let r;
      calls++;
      try {
        r = await shopifyGraphQLWithCost(env, storeId, PRODUCTS_QUERY, { first: PAGE_SIZE, after: cursor, query: s.pass_query }, { fetchImpl, nowMs });
      } catch (err) {
        if (err && err.code === "THROTTLED") { paused = "throttled"; break; }
        throw err;
      }
      cost = r.cost;
      const data = r.data;
      const conn = data && data.products;
      if (!conn || !Array.isArray(conn.nodes)) throw new Error("Shopify returned no products connection");
      for (const n of conn.nodes) {
        await upsertProduct(db, rowFromNode(storeId, n, at));
        if (n.updatedAt && (!maxUpd || n.updatedAt > maxUpd)) maxUpd = n.updatedAt;
        read++;
      }
      cursor = conn.pageInfo && conn.pageInfo.endCursor ? conn.pageInfo.endCursor : cursor;
      done = !(conn.pageInfo && conn.pageInfo.hasNextPage);
      const pc = data.productsCount;
      const total = pc && Number.isFinite(Number(pc.count)) ? Number(pc.count) : null;
      // Save progress after every page, so a failure on the next page loses nothing.
      await db.prepare(
        `UPDATE cat_sync SET pass_cursor = ?, pass_max_updated = ?, pass_read = pass_read + ?,
           pass_total = COALESCE(?, pass_total), pass_total_precision = COALESCE(?, pass_total_precision) WHERE store = ?`
      ).bind(cursor, maxUpd, conn.nodes.length, total, total == null ? null : (pc.precision || null), storeId).run();
    }
  } catch (err) {
    if (err && err.code === "NOT_WIRED") return { status: "not_wired", read, calls, completed: false, kind: s.pass_kind, reason: err.message };
    await db.prepare(`UPDATE cat_sync SET last_error = ?, last_error_at = ? WHERE store = ?`)
      .bind(String(err && err.message).slice(0, 300), at, storeId).run();
    throw err;
  }

  if (paused) {
    // Recorded as a pause (shown on the page), never as last_error: nothing is wrong.
    const why = paused === "throttled"
      ? "Shopify said THROTTLED; resuming next run from the saved cursor"
      : "Shopify's query budget couldn't pay for another page; resuming next run from the saved cursor";
    await db.prepare(`UPDATE cat_sync SET last_pause_reason = ?, last_pause_at = ? WHERE store = ?`).bind(why, at, storeId).run();
    return { status: "ok", read, calls, completed: false, kind: s.pass_kind, paused };
  }

  if (done) {
    const newWatermark = maxUpd && (!s.watermark || maxUpd > s.watermark) ? maxUpd : s.watermark;
    if (s.pass_kind === "full") {
      // Anything not seen in a completed full read no longer exists in Shopify.
      await db.prepare(`DELETE FROM cat_products WHERE store = ? AND read_at < ?`).bind(storeId, s.pass_started_at).run();
    }
    await db.prepare(
      `UPDATE cat_sync SET watermark = ?, pass_kind = NULL, pass_query = NULL, pass_cursor = NULL, pass_started_at = NULL,
         pass_max_updated = NULL, pass_read = 0, pass_total = NULL, pass_total_precision = NULL, last_pass_at = ?,
         last_full_at = CASE WHEN ? = 'full' THEN ? ELSE last_full_at END, last_error = NULL WHERE store = ?`
    ).bind(newWatermark, at, s.pass_kind, at, storeId).run();
  }
  return { status: "ok", read, calls, completed: done, kind: s.pass_kind };
}
