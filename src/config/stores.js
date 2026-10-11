/**
 * The five stores. One place, one truth.
 *
 * - `domain` is the store's permanent myshopify domain. Store Guard compares the
 *   domain Shopify reports back against this value before any write.
 * - `secrets` names the Cloudflare secrets holding that store's Dev Dashboard app
 *   credentials. Each prefix is unique and cannot be mistaken for another store's
 *   (the Eagano dash once nearly cross-wired a store through a loose prefix match).
 * - `live: false` means no P&L rows, no workers, no alerts for that store yet.
 */
/**
 * Guy's media-buying fee, applied per store as rate x that day's ad spend, from his
 * start date on (days before it carry no fee).
 * Source: docs/specs/pnl-finance.md, Data Pullers: "Guy fee: 10% of spend from his start
 * date, per store (config)". Start date 2026-09-07 as given in the P&L build brief
 * (2026-10-11); confirm it against Guy's first invoice before the P&L leaves shadow.
 * Per store on purpose: if one store's terms ever differ, change only that store.
 */
const GUY_FEE = Object.freeze({ rate: 0.10, start: "2026-09-07" });

export const STORES = Object.freeze({
  hc: {
    id: "hc",
    name: "Holt & Crane",
    domain: "jmzjx1-it.myshopify.com",
    kfbShopCode: "jmzjx1-it",
    adsCustomerId: "710-814-3649",
    // The store's own customer-service Gmail, connected separately (Reilly, 2026-10-11:
    // "it has its own gmail, we need to connect it. also, eventually all the stores will have their own gmails").
    mailbox: "info@holtandcrane.com",
    live: true,
    timezone: "America/New_York",
    secrets: { clientId: "SB_HC_CLIENT_ID", clientSecret: "SB_HC_CLIENT_SECRET" },
    // Guy (media buyer) fee: see GUY_FEE below.
    guyFeeRate: GUY_FEE.rate,
    guyStart: GUY_FEE.start,
  },
  aub: {
    id: "aub",
    name: "Auberlane",
    domain: "3as2ya-dw.myshopify.com",
    kfbShopCode: "3as2ya-dw",
    adsCustomerId: "148-187-2496",
    live: true,
    timezone: "America/New_York",
    secrets: { clientId: "SB_AUB_CLIENT_ID", clientSecret: "SB_AUB_CLIENT_SECRET" },
    // Guy (media buyer) fee: see GUY_FEE below.
    guyFeeRate: GUY_FEE.rate,
    guyStart: GUY_FEE.start,
  },
  mar: {
    id: "mar",
    name: "Marlowe Standard",
    domain: "806080-g8.myshopify.com",
    kfbShopCode: "806080-g8",
    adsCustomerId: "774-220-2674",
    live: true,
    timezone: "America/New_York",
    secrets: { clientId: "SB_MAR_CLIENT_ID", clientSecret: "SB_MAR_CLIENT_SECRET" },
    // Guy (media buyer) fee: see GUY_FEE below.
    guyFeeRate: GUY_FEE.rate,
    guyStart: GUY_FEE.start,
  },
  cc: {
    id: "cc",
    name: "Colette & Claire",
    domain: null, // filled in when the store goes live
    kfbShopCode: null,
    adsCustomerId: null,
    live: false,
    timezone: "America/New_York",
    secrets: { clientId: "SB_CC_CLIENT_ID", clientSecret: "SB_CC_CLIENT_SECRET" },
  },
  tund: {
    id: "tund",
    name: "Tundrelle",
    domain: "mek6yu-91.myshopify.com",
    kfbShopCode: "mek6yu-91",
    adsCustomerId: null,
    live: false,
    timezone: "America/New_York",
    secrets: { clientId: "SB_TUND_CLIENT_ID", clientSecret: "SB_TUND_CLIENT_SECRET" },
  },
});

export const STORE_IDS = Object.freeze(Object.keys(STORES));
export const LIVE_STORE_IDS = Object.freeze(STORE_IDS.filter((id) => STORES[id].live));

/** Returns the store config or null. Never guesses, never defaults to a store. */
export function getStore(id) {
  return Object.prototype.hasOwnProperty.call(STORES, id) ? STORES[id] : null;
}

/** Find a store by its myshopify domain (used to route incoming webhooks). */
export function storeByDomain(domain) {
  if (!domain) return null;
  const d = String(domain).toLowerCase().trim();
  return STORE_IDS.map((id) => STORES[id]).find((s) => s.domain === d) || null;
}

/**
 * Shopify scopes granted to each store's app. All READ-ONLY: write scopes are added
 * per department as each one goes live, never earlier. Read scopes are granted up
 * front so later departments don't need another app version just to look.
 */
export const SHOPIFY_SCOPES_READ = Object.freeze([
  "read_orders",                              // orders, refunds (P&L, CS)
  "read_all_orders",                          // history beyond 60 days (if Shopify allows it for this app)
  "read_products",                            // catalog, prices, compare-at
  "read_inventory",                           // tracked/continue settings
  "read_reports",                             // ShopifyQL sessions/sales
  "read_shopify_payments_payouts",            // exact payouts + balance transactions
  "read_shopify_payments_accounts",           // balance
  "read_shopify_payments_disputes",           // chargebacks (Risk)
  "read_customers",                           // order history for CS replies
  "read_fulfillments",                        // tracking (Fulfillment)
  "read_merchant_managed_fulfillment_orders", // fulfillment status
  "read_returns",                             // returns/exchanges
  "read_discounts",                           // volume ladder (Margin Guard)
  "read_themes",                              // what the storefront claims (Claims Auditor)
]);
