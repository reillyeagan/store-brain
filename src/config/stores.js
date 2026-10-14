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
/**
 * Parcel tracking (17TRACK + day-15/day-20 parcel flags): OFF.
 * Reilly, 2026-10-13: "we need to stop the parcel panel tracking its not worth it if its
 * going to fill up this much bullshit". Flip to true only on his word.
 */
export const PARCEL_TRACKING = false;
/** Tests switch it on with env.PARCEL_TRACKING = "1"; production follows the constant. */
export function parcelTrackingOn(env) { return PARCEL_TRACKING || !!(env && env.PARCEL_TRACKING === "1"); }
export const PARCEL_TRACKING_DECISION = Object.freeze({
  at: "2026-10-13T17:11:00Z",
  topic: "parcel_tracking",
  words: "we need to stop the parcel panel tracking its not worth it if its going to fill up this much bullshit",
});

export const GUY_FEE = Object.freeze({ rate: 0.10, start: "2026-09-07" });

/**
 * Spend alarm (media.spend_alarm): "money is going out and nothing is coming in", or "the
 * money stopped going out". Watch only: it raises one alarm per store per day, never touches
 * the ad account (Guy runs the ads). Numbers are in the ad account's currency (USD today).
 * Why each threshold (none came from Reilly; change them here, per store if needed):
 *  - noOrdersMinSpend 40: about two-thirds of a normal day's spend on one store (H&C ran ~$60/day
 *    in Aug-Sep, Vault Brain State 08-28). $40 gone with not one order is not noise.
 *  - noOrdersFromHour 15: "by mid-afternoon" in the STORE's timezone. Mornings are thin; by 3 pm
 *    a store spending $40+ has nearly always had an order.
 *  - usualMultiple 2 + usualDays 14: today's spend already over 2x a normal FULL day (median of
 *    the last 14 closed days) with no orders is an alarm at any hour: a budget doubled or a
 *    campaign ran away (Auberlane spent 85-95 clicks/day with 0 orders on 10-11/12, Memory Log 10-13).
 *  - stoppedMinUsual 15 + stoppedNormalDays 5 of 7: an account counts as "normally spending"
 *    when its median closed day is $15+ and at least 5 of the last 7 closed days spent anything.
 *    Then a closed day at $0, or $0 so far today after stoppedFromHour (13, account time), is an
 *    alarm: billing failed or a campaign was paused (Auberlane stopped spending 09-27 unnoticed).
 * A stale ads feed (or orders feed, for the zero-orders checks) is never judged: the alarm says
 * "can't check" instead (rule 4). Zero orders from a stale feed is not a claim.
 */
export const SPEND_ALARM = Object.freeze({
  noOrdersMinSpend: 40,
  noOrdersFromHour: 15,
  usualMultiple: 2,
  usualDays: 14,
  stoppedMinUsual: 15,
  stoppedNormalDays: 5,
  stoppedWindow: 7,
  stoppedFromHour: 13,
  perStore: {}, // e.g. { aub: { noOrdersMinSpend: 25 } } — overrides for one store only
});
/** The alarm thresholds for one store (defaults + that store's overrides). */
export function spendAlarmConfig(storeId) {
  const { perStore, ...base } = SPEND_ALARM;
  return { ...base, ...((perStore && perStore[storeId]) || {}) };
}

/**
 * Who each store sells to (`audience` on each store below): "men", "women", "both", or null
 * when unknown (null is "not told", never a default). The Size Checker reads it.
 * Reilly, 2026-10-13: "H&C is mens and womens. Auberlane is womens. Marlowe is mens."
 */
export const AUDIENCE_DECISION = Object.freeze({
  at: "2026-10-14T00:23:00Z",
  topic: "core.store_audiences",
  words: "H&C is mens and womens. Auberlane is womens. Marlowe is mens.",
});

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
    audience: "both", // see AUDIENCE_DECISION: sized per product, never assumed men's
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
    audience: "women", // see AUDIENCE_DECISION
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
    audience: "men", // see AUDIENCE_DECISION
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
    audience: null, // not told yet
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
    audience: null, // not told yet
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
