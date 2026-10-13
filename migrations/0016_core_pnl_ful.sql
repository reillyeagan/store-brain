-- Store Brain ledger: Core (Decision Keeper, Librarian, Auditor, Incident Desk, Router),
-- P&L extras (Analyst, Tax/Admin & Triggers, COGS Matcher, Shopify funnel) and the
-- Fulfillment Order-to-Supplier Watcher.
-- Additive only: CREATE TABLE IF NOT EXISTS. Nothing existing is renamed, dropped or rewritten.

/* ---------------- Core ---------------- */

-- Everything the Store Brain learns that must also reach Eagano's vault (Reilly 2026-10-11:
-- Eagano "is the TRUE ultimate data hub for EVERYTHING"). The worker only QUEUES; Claude on
-- Reilly's PC reads the queue, files each item in the vault, and marks it copied.
CREATE TABLE IF NOT EXISTS vault_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,              -- decision | fact | brief
  ref_id      TEXT    NOT NULL,              -- id of the row it came from (decisions.id, core_facts.id, briefs.id)
  title       TEXT    NOT NULL,
  body        TEXT,                          -- JSON copy of the row, exactly as stored
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | copied
  copied_at   TEXT,
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_vault_outbox_status ON vault_outbox(status, id);

-- Auditor findings, one row per distinct finding, so a finding that persists is logged
-- once every few hours instead of every run (no flooding the activity feed).
CREATE TABLE IF NOT EXISTS audit_findings (
  key            TEXT    PRIMARY KEY,         -- kind + subject, e.g. "audit.pnl_profit_without_inputs:hc:2026-10-12"
  kind           TEXT    NOT NULL,
  subject_actor  TEXT,                        -- the agent whose work was checked
  store          TEXT,
  summary        TEXT    NOT NULL,
  detail         TEXT,                        -- JSON
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL,
  last_logged_at TEXT,
  times_seen     INTEGER NOT NULL DEFAULT 1,
  open           INTEGER NOT NULL DEFAULT 1   -- 0 once a later audit no longer finds it
);
CREATE INDEX IF NOT EXISTS idx_audit_findings_open ON audit_findings(open, last_seen);

-- Incident Desk: error.* events grouped by actor + kind.
CREATE TABLE IF NOT EXISTS incidents (
  key          TEXT    PRIMARY KEY,           -- "<actor>|<kind>"
  actor        TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  first_seen   TEXT    NOT NULL,              -- first error of this episode
  last_seen    TEXT    NOT NULL,
  count        INTEGER NOT NULL,              -- errors in this episode
  last_summary TEXT,
  status       TEXT    NOT NULL DEFAULT 'open', -- open (ongoing) | resolved
  approval_id  INTEGER,                       -- the ONE approval raised for this episode (null = none raised)
  opened_at    TEXT    NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT                           -- recovered | quiet
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

-- Cursors for agents that walk the events table (Router): last event id handled.
CREATE TABLE IF NOT EXISTS agent_cursors (
  name        TEXT    PRIMARY KEY,
  value       INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL
);

/* ---------------- P&L extras ---------------- */

-- Analyst: the code-computed explanation of profit change, per store (or 'all') per day.
CREATE TABLE IF NOT EXISTS pnl_analysis (
  store        TEXT    NOT NULL,              -- store id or 'all'
  day          TEXT    NOT NULL,              -- the day explained (yesterday when it ran)
  figures      TEXT    NOT NULL,              -- JSON: every number, computed in code
  words        TEXT,                          -- AI paragraph, only if every number in it is in `figures`
  words_model  TEXT,
  words_rejected TEXT,                        -- JSON: numbers the AI wrote that the figures don't contain
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (store, day)
);

-- Tax, Admin & Triggers: one row per reminder already given, so each is given once.
CREATE TABLE IF NOT EXISTS calendar_reminders (
  key         TEXT    PRIMARY KEY,            -- e.g. "fed_est_tax:2027-01-15:7d", "trigger:refund_rate:hc:2026-10-12"
  due_day     TEXT,
  sent_at     TEXT    NOT NULL
);

-- KFB bills, as the KFB morning session will read them (view only). Empty until then.
CREATE TABLE IF NOT EXISTS kfb_bills (
  bill_id       TEXT    PRIMARY KEY,
  kfb_shop_code TEXT,                         -- e.g. jmzjx1-it; the ONLY way a bill is tied to a store
  billed_at     TEXT,
  currency      TEXT    NOT NULL DEFAULT 'EUR',
  total_eur     REAL,                         -- bill total; null = sum of its lines
  usd_charged   REAL,                         -- exact USD the card was charged for this bill (decision 3); null = not known yet
  fx_source     TEXT,                         -- e.g. "wf_alert:<gmail id>"
  paid_at       TEXT,
  imported_at   TEXT    NOT NULL,
  matched_sig   TEXT                          -- COGS Matcher: the bill's state (lines, EUR, card amount) last matched; differs = re-match
);

-- Every line on a KFB bill: parent orders AND all suborders (never filtered by price > 0).
CREATE TABLE IF NOT EXISTS kfb_bill_lines (
  bill_id       TEXT    NOT NULL,
  line_no       INTEGER NOT NULL,
  kfb_shop_code TEXT,                         -- falls back to the bill's code when null
  order_ref     TEXT,                         -- the Shopify order number as KFB shows it ("1234" or "#1234")
  kfb_order_id  TEXT,
  parent_kfb_order_id TEXT,                   -- set on suborders
  sku           TEXT,
  quantity      INTEGER,
  cost_eur      REAL,
  fees_eur      REAL,
  shipping_eur  REAL,
  PRIMARY KEY (bill_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_kfb_bill_lines_ref ON kfb_bill_lines(kfb_shop_code, order_ref);

-- The COGS Matcher's result per Shopify order. The P&L uses cost_usd (status 'matched') in
-- place of the estimate for that order.
CREATE TABLE IF NOT EXISTS cogs_matches (
  store        TEXT    NOT NULL,
  order_id     TEXT    NOT NULL,
  order_name   TEXT,
  local_day    TEXT    NOT NULL,              -- the order's store day (the P&L day it lands on)
  cost_eur     REAL    NOT NULL,              -- parent + all suborders, incl. fees and shipping
  cost_usd     REAL,                          -- at the exact card rate; null while waiting on FX
  fx_rate      REAL,
  status       TEXT    NOT NULL,              -- matched | waiting_fx | low_hold (under half the estimate: held as estimate until a later bill or Reilly confirms)
  bill_ids     TEXT,                          -- JSON array
  line_count   INTEGER NOT NULL,
  matched_at   TEXT    NOT NULL,
  applied_at   TEXT,                          -- when the P&L day was last recomputed with it (or skipped: store not live)
  estimate_usd REAL,                          -- what the estimate would have been, for the low-cost check
  hold_approval_id INTEGER,                   -- the approval asking Reilly about a low_hold cost
  confirmed_cost_usd REAL,                    -- the low cost Reilly confirmed (only that exact amount counts as confirmed)
  PRIMARY KEY (store, order_id)
);
CREATE INDEX IF NOT EXISTS idx_cogs_matches_day ON cogs_matches(store, local_day);

-- Shopify funnel per store per day (ShopifyQL `FROM sessions`, read_reports scope).
-- A missing row means "not known", never zero sessions.
CREATE TABLE IF NOT EXISTS funnel_days (
  store              TEXT    NOT NULL,
  day                TEXT    NOT NULL,         -- store day (Shopify reports in the shop's timezone)
  sessions           INTEGER,
  cart_sessions      INTEGER,                  -- sessions_with_cart_additions
  checkout_sessions  INTEGER,                  -- sessions_that_reached_checkout
  converted_sessions INTEGER,                  -- sessions_that_completed_checkout
  partial            INTEGER NOT NULL DEFAULT 0, -- 1 = today (still moving)
  fetched_at         TEXT    NOT NULL,
  PRIMARY KEY (store, day)
);

-- The funnel feed's own state per store (not the shared feeds table, whose list is fixed in
-- freshness.js): wired / not_wired / error, with the reason.
CREATE TABLE IF NOT EXISTS funnel_runs (
  store        TEXT    PRIMARY KEY,
  state        TEXT    NOT NULL,              -- wired | not_wired | error
  reason       TEXT,
  last_ok_at   TEXT,
  last_try_at  TEXT    NOT NULL
);

/* ---------------- Fulfillment ---------------- */

-- Orders as KFB lists them (filled by the KFB morning session, view only). Empty until then.
CREATE TABLE IF NOT EXISTS kfb_orders (
  kfb_order_id   TEXT    PRIMARY KEY,
  kfb_shop_code  TEXT    NOT NULL,            -- ties the order to a store; never the order number alone
  order_ref      TEXT    NOT NULL,            -- Shopify order number as KFB shows it
  kfb_created_at TEXT,
  status         TEXT,
  imported_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kfb_orders_ref ON kfb_orders(kfb_shop_code, order_ref);

-- Order-to-Supplier Watcher: paid orders not (yet) seen in KFB.
CREATE TABLE IF NOT EXISTS order_watch (
  store         TEXT    NOT NULL,
  order_id      TEXT    NOT NULL,
  order_name    TEXT,
  created_at    TEXT    NOT NULL,             -- Shopify order time (UTC)
  state         TEXT    NOT NULL,             -- suspect (missed by one sweep) | flagged (also missed by a newer sweep) | found | cancelled
  first_missing_at TEXT NOT NULL,
  sweep_at      TEXT,                         -- the KFB sweep (feed last_ok_at) that first missed it
  checked_at    TEXT    NOT NULL,
  flagged_at    TEXT,
  found_at      TEXT,
  PRIMARY KEY (store, order_id)
);
CREATE INDEX IF NOT EXISTS idx_order_watch_state ON order_watch(state);
