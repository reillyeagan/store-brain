-- Store Brain ledger: Risk & Disputes (spec docs/specs/risk.md, v1 2026-10-11).
-- Additive only: new tables. Nothing existing is renamed, dropped or rewritten.
-- Everything here is SHADOW: the brain reads Shopify, drafts, flags and asks Reilly.
-- Reilly submits dispute evidence and cancels orders himself, in Shopify.

-- Shopify Payments disputes (chargebacks and inquiries), one row per dispute, as Shopify
-- last reported it. Read hourly by the Chargeback Agent.
CREATE TABLE IF NOT EXISTS risk_disputes (
  store            TEXT    NOT NULL,
  dispute_id       TEXT    NOT NULL,          -- ShopifyPaymentsDispute GID
  legacy_id        TEXT,
  order_id         TEXT,                      -- Order GID (null if Shopify didn't link one)
  order_name       TEXT,                      -- e.g. "#1053"
  status           TEXT,                      -- NEEDS_RESPONSE | UNDER_REVIEW | ACCEPTED | WON | LOST (verbatim)
  type             TEXT,                      -- CHARGEBACK | INQUIRY (verbatim)
  reason           TEXT,                      -- e.g. FRAUDULENT, PRODUCT_NOT_RECEIVED (verbatim)
  network_reason_code TEXT,
  amount           REAL,
  currency         TEXT,
  initiated_at     TEXT,
  evidence_due_by  TEXT,                      -- YYYY-MM-DD as Shopify gives it
  evidence_sent_on TEXT,
  finalized_on     TEXT,
  approval_id      INTEGER,                   -- the ONE "respond to this dispute" approval
  reminders        TEXT,                      -- JSON array of reminder thresholds already sent, e.g. [7,2]
  overdue_noted_at TEXT,                      -- set once if the due date passes with no response
  order_snapshot   TEXT,                      -- JSON: the order as the dispute query returned it
  first_seen_at    TEXT    NOT NULL,
  fetched_at       TEXT    NOT NULL,          -- last time Shopify answered for this dispute
  PRIMARY KEY (store, dispute_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_disputes_status ON risk_disputes(status);

-- The evidence pack DRAFT per dispute: facts gathered by code + a rebuttal drafted by
-- Claude (once per dispute). Never submitted by the brain: Reilly submits in Shopify.
CREATE TABLE IF NOT EXISTS risk_evidence_packs (
  store            TEXT    NOT NULL,
  dispute_id       TEXT    NOT NULL,
  status           TEXT    NOT NULL,          -- facts_only | waiting_ai | draft | ai_failed
  facts            TEXT,                      -- JSON: everything code gathered (order, tracking, delivery, emails, policies)
  missing          TEXT,                      -- JSON array: evidence we could not find (Reilly should add it)
  rebuttal         TEXT,                      -- Claude's draft response text
  ai_model         TEXT,
  ai_attempted_at  TEXT,                      -- set once a real AI attempt was made (success or failure)
  ai_error         TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  PRIMARY KEY (store, dispute_id)
);

-- Every order the Fraud Screen looked at, so it is screened once (re-checked only while
-- Shopify's own assessment is still PENDING).
CREATE TABLE IF NOT EXISTS risk_order_screens (
  store            TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  order_name       TEXT,
  order_created_at TEXT,
  shopify_level    TEXT,                      -- highest Shopify riskLevel: HIGH | MEDIUM | LOW | NONE | PENDING | null
  recommendation   TEXT,                      -- Shopify: ACCEPT | INVESTIGATE | CANCEL | NONE
  level            TEXT,                      -- our verdict: HIGH | MEDIUM | null (not flagged)
  reasons          TEXT,                      -- JSON array of plain-English reasons
  final            INTEGER NOT NULL DEFAULT 0, -- 1 = verdict settled (not re-screened)
  approval_id      INTEGER,                   -- HIGH only
  screened_at      TEXT    NOT NULL,
  PRIMARY KEY (store, order_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_order_screens_level ON risk_order_screens(level, screened_at);

-- Account health per store, latest check (the history lives in the events table).
CREATE TABLE IF NOT EXISTS risk_account_health (
  store            TEXT    PRIMARY KEY,
  checked_at       TEXT    NOT NULL,
  state            TEXT,                      -- ok | watch | bad | null (could not judge)
  payments_activated INTEGER,                 -- 1/0, null = unknown
  payout_interval  TEXT,
  failed_payouts   INTEGER,                   -- FAILED among the last 10 payouts (null = unknown)
  orders_90d       INTEGER,
  orders_precision TEXT,                      -- EXACT | AT_LEAST
  disputes_90d     INTEGER,
  disputes_at_least INTEGER NOT NULL DEFAULT 0, -- 1 = more pages existed, count is a floor
  dispute_rate     REAL,                      -- disputes_90d / orders_90d (null when unknown)
  refund_rate      REAL,                      -- refunded orders / orders over 90 days (null when not covered)
  detail           TEXT                       -- JSON: reasons and notes
);

-- Storefront text snippets the Claims Auditor found (theme, product descriptions, policies)
-- and Claude's verdict on each. Reports only; the brain never edits the store.
CREATE TABLE IF NOT EXISTS risk_claims (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store            TEXT    NOT NULL,
  source           TEXT    NOT NULL,          -- theme:<file> | product:<handle> | policy:<type>
  text             TEXT    NOT NULL,          -- the snippet, verbatim (trimmed)
  hash             TEXT    NOT NULL,
  verdict          TEXT    NOT NULL DEFAULT 'pending', -- pending | risky | ok | unclear (AI answer unusable)
  category         TEXT,                      -- delivery | returns | origin | urgency | quality | other
  why              TEXT,                      -- one line from Claude
  found_at         TEXT    NOT NULL,
  last_seen_at     TEXT    NOT NULL,          -- last weekly read that still found it on the store
  classified_at    TEXT,
  model            TEXT,
  UNIQUE (store, hash)
);
CREATE INDEX IF NOT EXISTS idx_risk_claims_verdict ON risk_claims(verdict, store);
