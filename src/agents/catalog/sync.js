/**
 * Catalog reader — keeps a read-only copy of each live store's products in `cat_products`.
 *
 * What: pages through Shopify's products (Admin GraphQL, read_products + read_inventory, via
 * Store Guard with each store's own credentials), oldest-updated first. A FULL read happens
 * once a day (it also finds products deleted in Shopify); between full reads, a DELTA read
 * asks only for products whose updated_at moved since the last completed read
 * (`updated_at:>='<watermark>'`). Each tick reads at most PAGES_PER_TICK pages per store, so
 * a big catalog is spread over several ticks; the cursor is saved between ticks.
 * Why delta + daily full: inventory changes don't always move a product's updated_at, and a
 * deleted product never shows up in a delta, so the daily full read keeps the copy honest.
 * Shadow: read only. Never calls a mutation.
 */
import { shopifyGraphQL } from "../../lib/storeGuard.js";
import { nowIso } from "../../lib/time.js";

export const PAGE_SIZE = 10;          // 10 products × (30 variants + 3 collections) keeps query cost well under 1,000
export const PAGES_PER_TICK = 3;      // per store per tick → ≤ 9 Shopify calls a tick for 3 stores
export const FULL_EVERY_HOURS = 24;
/** The copy is only trusted when a full read finished this recently ... */
export const FULL_MAX_AGE_HOURS = 48;
/** ... and some read (full or delta) finished this recently (rule 4: freshness before numbers). */
export const PASS_MAX_AGE_HOURS = 3;

export const PRODUCTS_QUERY = `query CatalogProducts($first: Int!, $after: String, $query: String) {
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
    return { ready: false, reason: sync && sync.pass_kind === "full"
      ? `first full read in progress (${sync.pass_read} products so far)` : "products not read yet" };
  }
  const fullAgeH = (nowMs - Date.parse(sync.last_full_at)) / 3600000;
  const passAgeH = (nowMs - Date.parse(sync.last_pass_at || sync.last_full_at)) / 3600000;
  if (fullAgeH > FULL_MAX_AGE_HOURS) return { ready: false, reason: `last full read is ${Math.round(fullAgeH)}h old (limit ${FULL_MAX_AGE_HOURS}h)` };
  if (passAgeH > PASS_MAX_AGE_HOURS) return { ready: false, reason: `last read is ${Math.round(passAgeH)}h old (limit ${PASS_MAX_AGE_HOURS}h)` };
  return { ready: true, reason: null };
}

/**
 * Read up to `pages` pages for one store. Never throws for "not wired"; other errors throw
 * after saving them on the sync row (the cursor is kept, so the next tick resumes).
 * @returns {{status:'ok'|'not_wired', read:number, completed:boolean, kind:string|null, reason?:string}}
 */
export async function syncStore(env, storeId, { nowMs = Date.now(), fetchImpl = fetch, pages = PAGES_PER_TICK } = {}) {
  const db = env.DB;
  const at = nowIso(nowMs);
  let s = await getSync(db, storeId);
  if (!s) {
    await db.prepare(`INSERT OR IGNORE INTO cat_sync (store) VALUES (?)`).bind(storeId).run();
    s = await getSync(db, storeId);
  }

  // Start a pass if none is in progress.
  if (!s.pass_kind) {
    const fullDue = !s.last_full_at || (nowMs - Date.parse(s.last_full_at)) / 3600000 >= FULL_EVERY_HOURS || !s.watermark;
    const kind = fullDue ? "full" : "delta";
    const query = kind === "full" ? null : `updated_at:>='${s.watermark}'`;
    await db.prepare(
      `UPDATE cat_sync SET pass_kind = ?, pass_query = ?, pass_cursor = NULL, pass_started_at = ?, pass_max_updated = NULL, pass_read = 0 WHERE store = ?`
    ).bind(kind, query, at, storeId).run();
    s = await getSync(db, storeId);
  }

  let cursor = s.pass_cursor, maxUpd = s.pass_max_updated, read = 0, done = false;
  try {
    for (let i = 0; i < pages && !done; i++) {
      const data = await shopifyGraphQL(env, storeId, PRODUCTS_QUERY, { first: PAGE_SIZE, after: cursor, query: s.pass_query }, { fetchImpl, nowMs });
      const conn = data && data.products;
      if (!conn || !Array.isArray(conn.nodes)) throw new Error("Shopify returned no products connection");
      for (const n of conn.nodes) {
        await upsertProduct(db, rowFromNode(storeId, n, at));
        if (n.updatedAt && (!maxUpd || n.updatedAt > maxUpd)) maxUpd = n.updatedAt;
        read++;
      }
      cursor = conn.pageInfo && conn.pageInfo.endCursor ? conn.pageInfo.endCursor : cursor;
      done = !(conn.pageInfo && conn.pageInfo.hasNextPage);
      // Save progress after every page, so a failure on the next page loses nothing.
      await db.prepare(`UPDATE cat_sync SET pass_cursor = ?, pass_max_updated = ?, pass_read = pass_read + ? WHERE store = ?`)
        .bind(cursor, maxUpd, conn.nodes.length, storeId).run();
    }
  } catch (err) {
    if (err && err.code === "NOT_WIRED") return { status: "not_wired", read, completed: false, kind: s.pass_kind, reason: err.message };
    await db.prepare(`UPDATE cat_sync SET last_error = ?, last_error_at = ? WHERE store = ?`)
      .bind(String(err && err.message).slice(0, 300), at, storeId).run();
    throw err;
  }

  if (done) {
    const newWatermark = maxUpd && (!s.watermark || maxUpd > s.watermark) ? maxUpd : s.watermark;
    if (s.pass_kind === "full") {
      // Anything not seen in a completed full read no longer exists in Shopify.
      await db.prepare(`DELETE FROM cat_products WHERE store = ? AND read_at < ?`).bind(storeId, s.pass_started_at).run();
    }
    await db.prepare(
      `UPDATE cat_sync SET watermark = ?, pass_kind = NULL, pass_query = NULL, pass_cursor = NULL, pass_started_at = NULL,
         pass_max_updated = NULL, pass_read = 0, last_pass_at = ?, last_full_at = CASE WHEN ? = 'full' THEN ? ELSE last_full_at END,
         last_error = NULL WHERE store = ?`
    ).bind(newWatermark, at, s.pass_kind, at, storeId).run();
  }
  return { status: "ok", read, completed: done, kind: s.pass_kind };
}
