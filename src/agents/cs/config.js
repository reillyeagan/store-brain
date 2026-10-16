/**
 * Customer Service — fixed settings in one place.
 *
 * Source: docs/specs/customer-service.md (Reilly's decisions 2026-10-11) and the
 * fulfillment/risk specs for delivery timings. Change a rule here, not in the agents.
 */
import { STORES, LIVE_STORE_IDS } from "../../config/stores.js";

/**
 * Store addresses as the spec lists them ("info@holtandcrane.com, info@auberlane.com,
 * info@marlowestandard.com ... arrives in reillyworking26@gmail.com"). Matched by domain so
 * orders@ / support@ on the same domain count too.
 */
export const STORE_MAIL_DOMAINS = Object.freeze({
  hc: "holtandcrane.com",
  aub: "auberlane.com",
  mar: "marlowestandard.com",
});

/**
 * Other names a store goes by in mail. Shopify's contact-form mail comes from "<name> (Shopify)"
 * where <name> is the shop's own short name (Marlowe's is "MS", live 2026-10-15), and customers
 * reply to mail signed "Holt & Crane", "H&C" and so on.
 */
export const STORE_ALIASES = Object.freeze({
  hc: ["Holt & Crane", "Holt and Crane", "H&C", "HC"],
  aub: ["Auberlane", "AUB"],
  mar: ["Marlowe Standard", "Marlowe", "MS"],
});

/** The fixed set of ticket categories. Anything the AI answers outside it becomes "other". */
export const CATEGORIES = Object.freeze([
  "where_is_order", "size_question", "size_complaint", "exchange", "address_change",
  "colour_change", "cancel", "return_refund", "chargeback_or_scam_angry", "product_question", "other",
]);

/**
 * Categories that are always Reilly's (spec: "Escalations (refunds, reships, replacements,
 * chargebacks, angry/'scam', anything uncovered) stay Reilly's"). No reply is drafted for these.
 * cancel is here because a cancelled paid order means a refund, and refunds are Reilly's (rule 12).
 */
export const ESCALATE_CATEGORIES = Object.freeze(["return_refund", "chargeback_or_scam_angry", "cancel", "other"]);

/** Categories where a reply can be drafted (subject to the per-ticket checks in routing.js). */
export const DRAFT_CATEGORIES = Object.freeze([
  "where_is_order", "size_question", "size_complaint", "exchange", "address_change", "colour_change", "product_question",
]);

/** Retention ideas are proposed for these (cs.retention). */
export const RETENTION_CATEGORIES = Object.freeze(["cancel", "return_refund"]);

/** Per-run caps. The Worker has subrequest/CPU limits; work is spread across runs. */
export const CAPS = Object.freeze({
  subrequests: 28,           // every Gmail / Shopify / Claude call in one run counts against this
  readPerInbox: 8,           // Gmail messages fetched per inbox per run (the main inbox search is wider since 2026-10-15)
  listPage: 500,             // ids per Gmail list page (Gmail's maximum)
  listMaxPages: 5,           // list pages followed per inbox per run (nextPageToken)
  classifyPerTick: 5,        // AI classifications per run
  contextPerTick: 10,        // tickets matched to orders per run (D1 only)
  shopifyLookupsPerTick: 2,  // live Shopify order lookups when the ledger has no match
  draftsPerTick: 3,          // AI reply drafts per run
  retentionPerTick: 2,       // AI retention suggestions per run
  escalationsPerTick: 5,     // approvals created per run
  threadChecksPerTick: 5,    // Gmail threads re-read per run for Reilly's sent replies
});

/** First read of an inbox only looks this far back (bounded, so a first run can't flood). */
export const FIRST_READ_DAYS = 3;

/** Cadences (minutes) for claimJob. CS comes round in the department rotation about every 20 minutes. */
export const CADENCE = Object.freeze({ read: 15, work: 15, obligations: 20 }); // obligations every 20 min so a flag drops off soon after Reilly replies

/**
 * Days a money/goods promise in Reilly's sent mail may stay open before it goes to Waiting on
 * you (promises.js). Not Reilly's numbers, so change them freely:
 *  - refund 3: a Shopify refund is a few clicks; 3 days covers a weekend. (#1019 waited 30+.)
 *  - replacement / exchange 7: the replacement has to be ordered (Shopify or KFB) first.
 */
export const PROMISE_DAYS = Object.freeze({ refund: 3, replacement: 7, exchange: 7 });

/**
 * Delivery facts the reply writer may quote. From the CS Playbook measurement quoted in
 * docs/specs/fulfillment.md (96 parcels, Aug–Sep) and docs/specs/risk.md ("measured 8–12
 * business days"). Express: Reilly 2026-10-11 "express is fine its all been good and getting
 * delivered on time" → can be called the faster option, never a guaranteed date.
 */
export const DELIVERY_FACTS = Object.freeze([
  "Orders usually ship within 3-8 business days.",
  "Standard delivery usually takes about 8-12 business days from the order date.",
  "Express shipping is the faster option; never give a guaranteed delivery date.",
]);

/**
 * Which inbox serves which store. A store with its own connected inbox is read there; every
 * other live store is read from Reilly's main inbox (spec: "Until a store has its own inbox,
 * its mail is read from reillyworking26@gmail.com").
 * @param {Set<string>} connectedSlots oauth_tokens providers that are verified
 */
export function inboxPlan(connectedSlots) {
  const own = [];
  const viaMain = [];
  for (const id of LIVE_STORE_IDS) {
    const slot = `google:${id}`;
    if (STORES[id].mailbox && connectedSlots.has(slot)) own.push({ slot, stores: [id], own: true });
    else viaMain.push(id);
  }
  return [...own, { slot: "google", stores: viaMain, own: false }];
}

/** The Gmail account a slot must belong to (Store Guard for Gmail writes). */
export function expectedSlotAccount(env, slot) {
  if (slot === "google") return String(env.GOOGLE_ACCOUNT || "").trim().toLowerCase() || null;
  const id = slot.replace(/^google:/, "");
  return STORES[id] && STORES[id].mailbox ? String(STORES[id].mailbox).toLowerCase() : null;
}

export const storeName = (id) => (STORES[id] ? STORES[id].name : null);
