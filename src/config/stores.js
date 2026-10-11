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
export const STORES = Object.freeze({
  hc: {
    id: "hc",
    name: "Holt & Crane",
    domain: "jmzjx1-it.myshopify.com",
    kfbShopCode: "jmzjx1-it",
    adsCustomerId: "710-814-3649",
    live: true,
    secrets: { clientId: "SB_HC_CLIENT_ID", clientSecret: "SB_HC_CLIENT_SECRET" },
  },
  aub: {
    id: "aub",
    name: "Auberlane",
    domain: "3as2ya-dw.myshopify.com",
    kfbShopCode: "3as2ya-dw",
    adsCustomerId: "148-187-2496",
    live: true,
    secrets: { clientId: "SB_AUB_CLIENT_ID", clientSecret: "SB_AUB_CLIENT_SECRET" },
  },
  mar: {
    id: "mar",
    name: "Marlowe Standard",
    domain: "806080-g8.myshopify.com",
    kfbShopCode: "806080-g8",
    adsCustomerId: "774-220-2674",
    live: true,
    secrets: { clientId: "SB_MAR_CLIENT_ID", clientSecret: "SB_MAR_CLIENT_SECRET" },
  },
  cc: {
    id: "cc",
    name: "Colette & Claire",
    domain: null, // filled in when the store goes live
    kfbShopCode: null,
    adsCustomerId: null,
    live: false,
    secrets: { clientId: "SB_CC_CLIENT_ID", clientSecret: "SB_CC_CLIENT_SECRET" },
  },
  tund: {
    id: "tund",
    name: "Tundrelle",
    domain: "mek6yu-91.myshopify.com",
    kfbShopCode: "mek6yu-91",
    adsCustomerId: null,
    live: false,
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
 * Shopify scopes requested in Phase 1: read-only. Write scopes are added per
 * department as each one goes live, never earlier.
 */
export const SHOPIFY_SCOPES_PHASE1 = Object.freeze([
  "read_orders",
  "read_products",
  "read_reports",
  "read_shopify_payments_payouts",
  "read_shopify_payments_accounts",
]);
