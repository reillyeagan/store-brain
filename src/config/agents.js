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
  a("core.briefer", "core", "Briefer", "ai", "L2"),
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
  a("sup.relay", "sup", "Relay", "ai", "L0"),
  a("sup.digest", "sup", "Supplier Digest", "ai", "L2"),
  a("sup.size_charts", "sup", "Size-Chart Checker", "ai", "L0"),
  a("sup.scout", "sup", "Sourcing Scout", "ai", "L0"),
  a("sup.claims", "sup", "Claims & Credits", "code", "L0"),

  // P&L
  a("pnl.pullers", "pnl", "Data Pullers", "code", "L2"),
  a("pnl.cogs", "pnl", "COGS Matcher", "code", "L2"),
  a("pnl.refunds", "pnl", "Refund Reconciler", "code", "L2"),
  a("pnl.ledger", "pnl", "Ledger Keeper", "code", "L2"),
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
  a("ful.tracking", "ful", "Tracking Sync", "code", "L1"),
  a("ful.late", "ful", "Late-Shipment Watcher", "ai", "L0"),
  a("ful.exceptions", "ful", "Exception Fixer", "ai", "L0"),

  // Catalog
  a("cat.pricing", "cat", "Pricing", "code", "L0"),
  a("cat.margin_guard", "cat", "Margin Guard", "code", "L0"),
  a("cat.status", "cat", "Product Status", "code", "L1"),
  a("cat.prepublish", "cat", "Pre-Publish Gate", "code", "L0"),
  a("cat.feed_health", "cat", "Feed Health", "code", "L0"),
  a("cat.content", "cat", "Content & Size Notes", "ai", "L0"),
  a("cat.imports", "cat", "Import Builder", "code", "L0"),
  a("cat.themes", "cat", "Theme Release Desk", "code", "L0"),
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
]);

const KNOWN = new Set([...AGENTS.map((x) => x.id), ...SERVICES.map((x) => x.id), ...SYSTEMS.map((x) => x.id)]);

export function isKnownActor(id) {
  return KNOWN.has(id);
}
