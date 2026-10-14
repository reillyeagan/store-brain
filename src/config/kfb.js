/**
 * KungFuBuy (KFB) morning import: the one place for origins, endpoints and limits.
 *
 * How it works (Reilly logs in to KFB every morning anyway, CAPTCHA included):
 *   1. On the KFB site, logged in, he clicks the "KFB → Store Brain" bookmarklet
 *      (public/kfb-bookmarklet.js). It runs in HIS tab, on the KFB origin, and only GETs
 *      KFB's own JSON endpoints with his session. Nothing is written to KFB. The brain never
 *      sees his cookies, password or CAPTCHA.
 *   2. The bookmarklet opens the dashboard at #/import/kfb. The dashboard posts "ready", the
 *      bookmarklet answers with the rows (postMessage, exact origins both ways).
 *   3. Reilly presses Import. The dashboard POSTs to /api/import/kfb with its normal key.
 *
 * Where the endpoints come from (Eagano vault, 08 System/Brain State.md + Memory Log.md):
 *   - quotations: `GET /index/quotation/get.html?limit=500&page=1&output=layui.table&un_shop_url=`
 *     with `X-Requested-With: XMLHttpRequest`, no `status` param, returns every row (09-06,
 *     313 rows). Row status field: 10 to-quote/priority, 25 awaiting confirmation, 26 problem,
 *     30 quoted, 40 (Reilly 10-13: "i think means i just havent approved it").
 *     items[] carry un_good_url, un_good_id, un_variant_id, un_good_sku. Cost =
 *     product[0].manual_pricing.<Country>.nameOne in EUR. un_good_price is the STORE price, never a cost.
 *   - orders: `/index/order/get.html`, rows with `shopify_create_at` (true UTC), `order_no`,
 *     `un_shop_url`, `un_total_price`. Its query string is NOT in the vault: the quotation
 *     endpoint's layui paging is assumed.
 *   - bills: only the PAGE `/index/member/billOrder.html` is in the vault. The JSON endpoint
 *     behind it is a GUESS built from the quotation pattern (page /index/member/quotation.html
 *     → data /index/quotation/get.html). The bookmarklet tries each candidate and reports which
 *     one answered; the import page has a paste box when none does.
 *   - KFB origin: NOT in the vault notes. KFB's own privacy policy lives at
 *     https://www.kungfubuy.com/index/privacy/index.html (the same /index/... path style), so the
 *     origin is taken as https://www.kungfubuy.com, plus the bare domain in case it redirects.
 *     The bookmarklet refuses to run anywhere else and names the origin it saw, so a wrong
 *     guess shows up as a clear message, never as silent data.
 */

/** The ONLY origins the dashboard accepts KFB data from (exact string match). */
export const KFB_ORIGINS = Object.freeze(["https://www.kungfubuy.com", "https://kungfubuy.com"]);

/** Where the bookmarklet sends the data (exact origin, for postMessage both ways). */
export const DASHBOARD_ORIGIN = "https://store-brain.reillyworking26.workers.dev";

/** KFB pages Reilly opens (for the phone reminder link). Bills is where he pays every morning. */
export const KFB_BILLS_PAGE = "https://www.kungfubuy.com/index/member/billOrder.html";

/** Endpoint candidates the bookmarklet tries, in order (kept in step with public/kfb-bookmarklet.js). */
export const KFB_ENDPOINTS = Object.freeze({
  quotes: ["/index/quotation/get.html"],
  orders: ["/index/order/get.html"],
  bills: ["/index/billOrder/get.html", "/index/bill/get.html", "/index/member/billOrder/get.html"],
});

/** Request cap: the bookmarklet trims rows, so a real morning is well under this. */
export const KFB_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Rows per section; more means something is wrong with the read, not a busy morning. */
export const KFB_IMPORT_MAX_ROWS = 6000;
/**
 * A read older than this is not imported (rule 4: freshness before numbers). The same limit
 * as the kfb.morning_sweep feed (26 h in src/lib/freshness.js), so an import can never mark
 * the feed fresh with a read the feed itself would call stale.
 */
export const KFB_IMPORT_MAX_AGE_H = 26;
/** Raw payloads kept in R2 for audit this long; older ones are deleted on the next import (they hold order data). */
export const KFB_RAW_RETENTION_DAYS = 30;
/** The feed the Order-to-Supplier Watcher and the Freshness Sentinel read (src/lib/freshness.js). */
export const KFB_FEED = "kfb.morning_sweep";
/** Eastern clock time of the one phone reminder when no import has landed (minutes after midnight). */
export const KFB_REMINDER_AFTER_MIN = 9 * 60;
