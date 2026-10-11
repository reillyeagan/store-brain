/**
 * The agent registry: every worker in the Store Brain, in one list.
 *
 * Mission Control draws the map from this list, and every event's `actor` should be
 * one of these ids. `kind` says whether a worker is plain code or uses Claude.
 * `level`: L0 proposes (Reilly approves) · L1 acts within limits, reports after ·
 * L2 runs quietly, shows in the digest.
 * `status`: planned → built → shadow → live. Only Reilly moves a worker to live.
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
  a("core.router", "core", "Router", "code", "L2"),
  // Morning brief at 8:00 ET: numbers by code, words by Claude, plain fallback. Shadow until
  // Reilly sets BRIEF_PHONE_LIVE = "1".
  a("core.briefer", "core", "Briefer", "ai", "L2", "built"),
  a("core.approvals", "core", "Approvals Desk", "code", "L1", "built"),
  a("core.decisions", "core", "Decision Keeper", "code", "L2"),
  a("core.librarian", "core", "Librarian", "ai", "L2"),
  a("core.auditor", "core", "Auditor", "ai", "L2"),
  a("core.incidents", "core", "Incident Desk", "ai", "L1"),

  // Media
  a("media.performance", "media", "Performance Analyst", "ai", "L2"),
  a("media.search_terms", "media", "Search Terms & Exclusions", "ai", "L0"),
  a("media.budget", "media", "Budget Strategist", "ai", "L0"),
  a("media.products", "media", "Product Performance", "code", "L0"),
  a("media.season", "media", "Keyword & Season", "ai", "L2"),
  a("media.guy_monitor", "media", "Guy Monitor", "code", "L1"),
  a("media.conversions", "media", "Conversion Integrity", "code", "L0"),

  // Customer service
  a("cs.triage", "cs", "Inbox Triage", "ai", "L2"),
  a("cs.order_context", "cs", "Order Context", "code", "L2"),
  a("cs.reply_writer", "cs", "Reply Writer", "ai", "L0"),
  a("cs.escalation", "cs", "Escalation Desk", "ai", "L0"),
  a("cs.obligations", "cs", "Obligations Tracker", "code", "L1"),
  a("cs.retention", "cs", "Retention", "ai", "L0"),

  // Supplier
  a("sup.quote_desk", "sup", "Quote Desk", "code", "L1"),
  a("sup.denial_sync", "sup", "Denial Sync", "code", "L0"),
  a("sup.preflight", "sup", "Supply Pre-flight", "code", "L0"),
  a("sup.similar_qc", "sup", "\"Similar ones\" QC", "ai", "L0"),
  // Relay writes the KFB copy-paste messages. v1 (express asks) is plain code, shadow by default;
  // later asks from email (sizes, addresses) will use AI, hence kind "ai".
  a("sup.relay", "sup", "Relay", "ai", "L0", "built"),
  a("sup.digest", "sup", "Supplier Digest", "ai", "L2"),
  a("sup.size_charts", "sup", "Size-Chart Checker", "ai", "L0"),
  a("sup.scout", "sup", "Sourcing Scout", "ai", "L0"),
  a("sup.claims", "sup", "Claims & Credits", "code", "L0"),

  // P&L
  a("pnl.pullers", "pnl", "Data Pullers", "code", "L2"),
  a("pnl.cogs", "pnl", "COGS Matcher", "code", "L2"),
  a("pnl.refunds", "pnl", "Refund Reconciler", "code", "L2"),
  // Daily P&L rows in the ledger (pnl_days). Sheets writing comes later, after the shadow gate.
  a("pnl.ledger", "pnl", "Ledger Keeper", "code", "L2", "built"),
  a("pnl.analyst", "pnl", "Analyst", "ai", "L2"),
  a("pnl.money_map", "pnl", "Money Map", "code", "L2"),
  a("pnl.calendar", "pnl", "Tax, Admin & Triggers", "code", "L1"),

  // Risk
  a("risk.chargebacks", "risk", "Chargeback Agent", "ai", "L0"),
  a("risk.account_health", "risk", "Account Health", "code", "L2"),
  a("risk.claims_audit", "risk", "Claims Auditor", "ai", "L0"),
  a("risk.fraud", "risk", "Fraud Screen", "code", "L0"),

  // Fulfillment
  a("ful.order_watch", "ful", "Order-to-Supplier Watcher", "code", "L1"),
  // Tracking Sync: Shopify tracking numbers → 17TRACK, stuck-pickup / failed-delivery flags,
  // proof of delivery to R2. Shadow-safe (nothing reaches a customer).
  a("ful.tracking", "ful", "Tracking Sync", "code", "L1", "built"),
  // Day-15 / day-20 flags and the reship-or-refund approval are plain code today; the
  // customer emails it will draft later need AI, hence kind "ai".
  a("ful.late", "ful", "Late-Shipment Watcher", "ai", "L0", "built"),
  a("ful.exceptions", "ful", "Exception Fixer", "ai", "L0"),

  // Catalog
  a("cat.pricing", "cat", "Pricing", "code", "L0"),
  a("cat.margin_guard", "cat", "Margin Guard", "code", "L0"),
  a("cat.status", "cat", "Product Status", "code", "L1"),
  a("cat.prepublish", "cat", "New-Product Check", "code", "L2"),
  a("cat.feed_health", "cat", "Merchant Center Health", "code", "L0"),
  // Dropped 2026-10-11 (Reilly): content & size notes, import builder, theme desk.
]);

/** Shared safety services — plain code every agent runs through. */
export const SERVICES = Object.freeze([
  { id: "svc.store_guard", name: "Store Guard", status: "built" },
  { id: "svc.write_verifier", name: "Write-Verifier", status: "built" },
  { id: "svc.freshness", name: "Freshness Sentinel", status: "built" },
  { id: "svc.backup_vault", name: "Backup Vault", status: "built" },
  { id: "svc.sheets_writer", name: "Sheets Writer", status: "planned" },
  { id: "svc.kfb_session", name: "KFB Morning Session", status: "planned" },
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

const KNOWN = new Set([...AGENTS.map((x) => x.id), ...SERVICES.map((x) => x.id), ...SYSTEMS.map((x) => x.id)]);

export function isKnownActor(id) {
  return KNOWN.has(id);
}
