/**
 * The agent registry: every worker in the Store Brain, in one list.
 *
 * Mission Control draws the map from this list, and every event's `actor` should be
 * one of these ids. `kind` says whether a worker is plain code or uses Claude.
 * `level`: L0 proposes (Reilly approves) · L1 acts within limits, reports after ·
 * L2 runs quietly, shows in the digest.
 * `status`: planned → built → shadow → live. Only Reilly moves a worker to live.
 * Agents Reilly switched off are removed from AGENTS (and the dashboard) and kept in
 * RETIRED_AGENTS, so their old events still show who wrote them.
 */

export const DEPARTMENTS = Object.freeze([
  { id: "core", name: "Manager", short: "Core" },
  { id: "media", name: "Media Management", short: "Media" },
  { id: "cs", name: "Customer Service", short: "CS" },
  { id: "sup", name: "Supplier Relations", short: "Supplier" },
  { id: "pnl", name: "P&L & Finance", short: "P&L" },
  { id: "risk", name: "Risk & Disputes", short: "Risk" },
  { id: "ful", name: "Fulfillment & Tracking", short: "Fulfillment" },
  { id: "cat", name: "Catalog & Feed", short: "Catalog" },
]);

const a = (id, dept, name, kind, level, status = "planned") => ({ id, dept, name, kind, level, status });

export const AGENTS = Object.freeze([
  // Manager (around the Core)
  a("core.router", "core", "Router", "code", "L2", "built"),
  // Morning brief at 8:00 ET: numbers by code, words by Claude, plain fallback. Shadow until
  // Reilly sets BRIEF_PHONE_LIVE = "1".
  a("core.briefer", "core", "Briefer", "ai", "L2", "built"),
  a("core.approvals", "core", "Approvals Desk", "code", "L1", "built"),
  a("core.decisions", "core", "Decision Keeper", "code", "L2", "built"),
  a("core.librarian", "core", "Librarian", "ai", "L2", "built"),
  a("core.auditor", "core", "Auditor", "ai", "L2", "built"),
  a("core.incidents", "core", "Incident Desk", "ai", "L1", "built"),

  // Media
  a("media.performance", "media", "Performance Analyst", "ai", "L2", "built"),
  a("media.search_terms", "media", "Search Terms & Exclusions", "ai", "L0", "built"),
  a("media.budget", "media", "Budget Strategist", "ai", "L0", "built"),
  a("media.products", "media", "Product Performance", "code", "L0", "built"),
  a("media.season", "media", "Keyword & Season", "ai", "L2", "built"),
  a("media.guy_monitor", "media", "Guy Monitor", "code", "L1", "built"),
  a("media.conversions", "media", "Conversion Integrity", "code", "L0", "built"),
  a("media.spend_alarm", "media", "Spend Alarm", "code", "L2", "built"),
  a("media.billing", "media", "Billing Watch", "code", "L2", "built"),

  // Customer service
  a("cs.triage", "cs", "Inbox Triage", "ai", "L2", "built"),
  a("cs.order_context", "cs", "Order Context", "code", "L2", "built"),
  a("cs.reply_writer", "cs", "Reply Writer", "ai", "L0", "built"),
  a("cs.escalation", "cs", "Escalation Desk", "ai", "L0", "built"),
  a("cs.obligations", "cs", "Obligations Tracker", "code", "L1", "built"),
  a("cs.retention", "cs", "Retention", "ai", "L0", "built"),

  // Supplier
  a("sup.quote_desk", "sup", "Quote Desk", "code", "L1", "built"),
  a("sup.denial_sync", "sup", "Denial Sync", "code", "L0", "built"),
  a("sup.preflight", "sup", "Supply Pre-flight", "code", "L0", "built"),
  a("sup.similar_qc", "sup", "\"Similar ones\" QC", "ai", "L0", "built"),
  // Relay writes the KFB copy-paste messages. v1 (express asks) is plain code, shadow by default;
  // later asks from email (sizes, addresses) will use AI, hence kind "ai".
  a("sup.relay", "sup", "Relay", "ai", "L0", "built"),
  a("sup.digest", "sup", "Supplier Digest", "ai", "L2", "built"),
  a("sup.size_charts", "sup", "Size-Chart Checker", "ai", "L0", "built"),
  a("sup.scout", "sup", "Sourcing Scout", "ai", "L0"),
  a("sup.claims", "sup", "Claims & Credits", "code", "L0", "built"),

  // P&L
  // Built and running (orders, ads spend, backfill, Shopify funnel): marked built 2026-10-13.
  a("pnl.pullers", "pnl", "Data Pullers", "code", "L2", "built"),
  a("pnl.cogs", "pnl", "COGS Matcher", "code", "L2", "built"),
  a("pnl.refunds", "pnl", "Refund Reconciler", "code", "L2", "built"),
  // Daily P&L rows in the ledger (pnl_days). The workbooks are written by pnl.sheets.
  a("pnl.ledger", "pnl", "Ledger Keeper", "code", "L2", "built"),
  a("pnl.analyst", "pnl", "Analyst", "ai", "L2", "built"),
  a("pnl.money_map", "pnl", "Money Map", "code", "L2", "built"),
  a("pnl.calendar", "pnl", "Tax, Admin & Triggers", "code", "L1", "built"),
  // Built 2026-10-14 on Reilly's word ("make sure things like the google drive P&L sheets are all
  // updated by the brain automatically"): writes BLANK input cells only; SHEETS_WRITE = "0" stops it.
  // Live, not shadow: his words are the go-live (decision pnl.sheets_write).
  a("pnl.sheets", "pnl", "P&L Sheets", "code", "L1", "live"),

  // Risk
  a("risk.chargebacks", "risk", "Chargeback Agent", "ai", "L0", "built"),
  a("risk.account_health", "risk", "Account Health", "code", "L2", "built"),
  a("risk.claims_audit", "risk", "Claims Auditor", "ai", "L0", "built"),
  a("risk.fraud", "risk", "Fraud Screen", "code", "L0", "built"),

  // Fulfillment
  a("ful.order_watch", "ful", "Order-to-Supplier Watcher", "code", "L1", "built"),
  a("ful.exceptions", "ful", "Exception Fixer", "ai", "L0"),

  // Catalog
  a("cat.pricing", "cat", "Pricing", "code", "L0", "built"),
  a("cat.margin_guard", "cat", "Margin Guard", "code", "L0", "built"),
  a("cat.status", "cat", "Product Status", "code", "L1", "built"),
  a("cat.prepublish", "cat", "New-Product Check", "code", "L2", "built"),
  a("cat.hygiene", "cat", "Feed Hygiene", "code", "L0", "built"),
  a("cat.feed_health", "cat", "Merchant Center Health", "code", "L0"),
  // Dropped 2026-10-11 (Reilly): content & size notes, import builder, theme desk.
]);

/**
 * Retired agents: switched off by Reilly and taken off the map and the counts (his words,
 * 2026-10-13: "if theyve been deleted, just remove them. dont leave them crossed off").
 * Their code stays dormant behind PARCEL_TRACKING; the ids stay known so history reads right.
 */
export const RETIRED_AGENTS = Object.freeze([
  { id: "ful.tracking", dept: "ful", name: "Tracking Sync", retired: "2026-10-13: parcel tracking switched off" },
  { id: "ful.late", dept: "ful", name: "Late-Shipment Watcher", retired: "2026-10-13: parcel tracking switched off" },
]);

/** Shared safety services — plain code every agent runs through. */
export const SERVICES = Object.freeze([
  { id: "svc.store_guard", name: "Store Guard", status: "built" },
  { id: "svc.write_verifier", name: "Write-Verifier", status: "built" },
  { id: "svc.freshness", name: "Freshness Sentinel", status: "built" },
  { id: "svc.backup_vault", name: "Backup Vault", status: "built" },
  { id: "svc.sheets_writer", name: "Sheets Writer", status: "built" }, // inside pnl.sheets (src/agents/pnl/sheets.js)
  { id: "svc.kfb_session", name: "KFB Morning Session", status: "built" }, // the one-click import (src/lib/kfbImport.js)
  { id: "svc.event_log", name: "Event Log", status: "built" },
]);

/** Outside systems the agents touch (outer nodes on the map). */
export const SYSTEMS = Object.freeze([
  { id: "sys.shopify", name: "Shopify" },
  { id: "sys.gmail", name: "Gmail" },
  { id: "sys.ads", name: "Google Ads" },
  { id: "sys.gmc", name: "Merchant Center" },
  { id: "sys.kfb", name: "KungFuBuy" },
  { id: "sys.sheets", name: "P&L Sheets" },
  { id: "sys.whatsapp", name: "WhatsApp" },
  { id: "sys.phone", name: "Your phone" },
  { id: "sys.17track", name: "17TRACK" },
  { id: "sys.claude", name: "Claude API" },
]);

const KNOWN = new Set([...AGENTS.map((x) => x.id), ...RETIRED_AGENTS.map((x) => x.id), ...SERVICES.map((x) => x.id), ...SYSTEMS.map((x) => x.id)]);

export function isKnownActor(id) {
  return KNOWN.has(id);
}

/**
 * One line per agent: what it does, in plain words. Shown on its page in the dashboard.
 * Planned agents describe the job they will do once built (from the department specs).
 */
export const AGENT_DOES = Object.freeze({
  "core.router": "Sends each new event to the agent that should handle it.",
  "core.briefer": "Writes the 8:00 morning brief: numbers by code, words by Claude, every number checked against the ledger.",
  "core.approvals": "Holds everything that needs Reilly's yes, sends it to his phone, and records his answer.",
  "core.decisions": "Records Reilly's decisions word for word so every agent follows them.",
  "core.librarian": "Keeps the Core (store facts and rules) up to date and in sync with the Eagano vault.",
  "core.auditor": "Checks other agents' work; the author never audits its own.",
  "core.incidents": "Catches errors and failures, retries, and raises an alarm only when it's real.",
  "media.performance": "Reads Google Ads results per store: spend, ROAS against break-even, trends.",
  "media.search_terms": "Finds wasted search terms and proposes exclusions.",
  "media.budget": "Proposes budget moves between campaigns and stores.",
  "media.products": "Spots which products earn and which burn ad spend.",
  "media.season": "Watches keywords and seasonal demand.",
  "media.guy_monitor": "Watches what Guy changes in the ad accounts and logs it.",
  "media.conversions": "Checks that conversion tracking matches real orders.",
  "media.billing": "Reads each ad account's status, billing setup and account budget, and flags a suspension, a held billing setup or a budget nearly used up (watch only).",
  "media.spend_alarm": "Raises one alarm a day when a store spends with no orders, or an account that normally spends stops (watch only).",
  "cs.triage": "Reads every store inbox and sorts each email by what it needs.",
  "cs.order_context": "Matches each email to its order, tracking and history.",
  "cs.reply_writer": "Drafts replies into Gmail for Reilly to review and send.",
  "cs.escalation": "Flags angry, risky or unusual emails for Reilly.",
  "cs.obligations": "Tracks promises made to customers until they are kept.",
  "cs.retention": "Proposes how to keep a customer who wants to cancel or return.",
  "sup.quote_desk": "Turns KFB quotes into reprices and drafts for Reilly to approve.",
  "sup.denial_sync": "Drafts products KFB denied, with Reilly's approval.",
  "sup.preflight": "Checks supply problems before they hit orders.",
  "sup.similar_qc": "Checks KFB's \"similar items\" before they ship.",
  "sup.relay": "Writes the daily KFB message for Reilly to copy and paste: express orders, parcels no carrier picked up, and later size, colour and address changes.",
  "sup.digest": "Summarises supplier activity for the brief.",
  "sup.size_charts": "Checks every order's size against the supplier chart and customer complaints, and suggests the right size to send.",
  "sup.scout": "Flags product categories that keep failing at KFB (finding new suppliers is out of scope for now).",
  "sup.claims": "Tracks claims and credits owed by KFB.",
  "pnl.pullers": "Pulls orders, ad spend, refunds and fees into the ledger.",
  "pnl.cogs": "Matches real KFB costs to orders so COGS stops being an estimate (waiting on KFB bills).",
  "pnl.refunds": "Books refunds on the day they were processed, PENDING included.",
  "pnl.ledger": "Computes each store's daily P&L, marks days final only when every input is in.",
  "pnl.analyst": "Explains why profit moved.",
  "pnl.money_map": "Tracks Shopify payouts, balances and fees.",
  "pnl.calendar": "Tracks tax, admin deadlines and money triggers.",
  "pnl.sheets": "Every morning from 07:00 fills yesterday's row in the Google Sheets P&L workbooks (blank cells only), corrects its own recent cells, and fills the brain's missing days from the sheets.",
  "risk.chargebacks": "Prepares chargeback evidence before the deadline.",
  "risk.account_health": "Watches Shopify Payments health, the 90-day dispute rate and the refund rate.",
  "risk.claims_audit": "Checks storefront promises (delivery times, returns, origin, urgency) against reality.",
  "risk.fraud": "Screens Shopify orders for fraud (rarely needs Reilly).",
  "ful.order_watch": "Checks every order reached KFB (waiting on the KFB morning session).",
  "ful.tracking": "Syncs tracking numbers with 17TRACK and flags parcels stuck, waiting for pickup or failed.",
  "ful.late": "Flags day-15 and day-20 parcels and asks Reilly: reship or refund.",
  "ful.exceptions": "Proposes fixes for delivery problems.",
  "cat.pricing": "Checks prices against Reilly's rules (floors, $144.95 ceiling, compare-at tiers).",
  "cat.margin_guard": "Flags products whose cost makes the price unprofitable.",
  "cat.status": "Keeps product status in line with supplier availability.",
  "cat.prepublish": "Checks new products before they go live.",
  "cat.hygiene": "Monthly feed report from the course: zombie products, best-sellers not on sale, SKU count vs ad spend (proposals only).",
  "cat.feed_health": "Watches Merchant Center for disapprovals and feed errors.",
});
