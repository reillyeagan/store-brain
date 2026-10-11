-- Store Brain ledger, v1.
-- One database for every department. Agents talk to each other through these
-- tables (tickets, events), never by chatting. Every row says where it came from.

-- Every action by every worker. Mission Control draws only from this table.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,              -- ISO timestamp (UTC)
  actor       TEXT    NOT NULL,              -- worker id, e.g. "cs.inbox_triage", "svc.store_guard"
  kind        TEXT    NOT NULL,              -- e.g. "ticket.opened", "write.verified", "feed.stale"
  store       TEXT,                          -- hc | aub | mar | cc | tund | null
  target      TEXT,                          -- other worker/system involved (draws a line on the map)
  ticket_id   INTEGER,
  summary     TEXT    NOT NULL,              -- one plain-English line
  data        TEXT,                          -- JSON detail (never secrets)
  cost_usd    REAL    DEFAULT 0              -- AI cost of this action, 0 for plain code
);
CREATE INDEX IF NOT EXISTS idx_events_at    ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);

-- Work items passed between departments.
CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at   TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  store       TEXT,
  dept        TEXT    NOT NULL,              -- owning department
  assignee    TEXT,                          -- worker id
  parent_id   INTEGER,                       -- a sub-ticket points at the ticket waiting on it
  status      TEXT    NOT NULL DEFAULT 'open', -- open | waiting | needs_reilly | done | cancelled
  title       TEXT    NOT NULL,
  detail      TEXT,                          -- JSON
  source      TEXT,                          -- e.g. "gmail:<message id>", "shopify:order:1231"
  due_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- Everything waiting on Reilly. Nothing in here executes without his yes.
CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  decided_at  TEXT,
  store       TEXT,
  dept        TEXT    NOT NULL,
  requested_by TEXT   NOT NULL,              -- worker id
  ticket_id   INTEGER,
  title       TEXT    NOT NULL,
  options     TEXT    NOT NULL,              -- JSON array of {id,label,detail}
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired | executed | failed
  choice      TEXT,                          -- option id chosen
  note        TEXT,                          -- Reilly's words, verbatim
  executed_at TEXT,
  result      TEXT                           -- JSON outcome after execution + verification
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Reilly's decisions, in his own words. No agent may claim a decision without one.
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  topic       TEXT    NOT NULL,
  words       TEXT    NOT NULL,              -- verbatim
  scope       TEXT,                          -- store id or "all"
  supersedes  INTEGER,                       -- previous decision id on the same topic
  settled     INTEGER NOT NULL DEFAULT 1     -- settled topics are never re-raised
);

-- Promises made to customers or by suppliers, with due dates.
CREATE TABLE IF NOT EXISTS obligations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  store       TEXT,
  kind        TEXT    NOT NULL,              -- refund | exchange | replacement | supplier_credit | reply
  party       TEXT,                          -- customer email / order number / KFB
  order_ref   TEXT,
  amount      REAL,
  currency    TEXT,
  due_at      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open', -- open | done | cancelled
  done_at     TEXT,
  ticket_id   INTEGER,
  note        TEXT
);

-- Every data feed and when it last delivered. The Freshness Sentinel reads this.
CREATE TABLE IF NOT EXISTS feeds (
  id          TEXT    PRIMARY KEY,           -- e.g. "shopify.orders.hc"
  store       TEXT,
  label       TEXT    NOT NULL,
  max_age_min INTEGER NOT NULL,
  last_ok_at  TEXT,                          -- last successful delivery
  last_try_at TEXT,
  last_error  TEXT,
  wired       INTEGER NOT NULL DEFAULT 0,    -- 0 = not wired yet (null), 1 = wired
  state       TEXT                           -- last evaluated state, so alerts fire on change only
);

-- Orders as Shopify reports them (from webhooks + reconciliation pulls).
CREATE TABLE IF NOT EXISTS orders (
  store       TEXT    NOT NULL,
  order_id    TEXT    NOT NULL,              -- Shopify GID
  name        TEXT,                          -- e.g. "#1231"
  created_at  TEXT    NOT NULL,              -- Shopify time (UTC)
  local_day   TEXT    NOT NULL,              -- YYYY-MM-DD in the store's timezone
  currency    TEXT,
  subtotal    REAL,
  discounts   REAL,
  total       REAL,
  financial_status TEXT,
  raw         TEXT,                          -- JSON
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (store, order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(store, local_day);

-- Refund events (not aggregates). Includes PENDING.
CREATE TABLE IF NOT EXISTS refunds (
  store       TEXT    NOT NULL,
  refund_id   TEXT    NOT NULL,
  order_id    TEXT    NOT NULL,
  processed_at TEXT,
  local_day   TEXT,
  amount      REAL,
  status      TEXT,                          -- SUCCESS | PENDING | FAILURE ...
  raw         TEXT,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (store, refund_id)
);

-- One closed (or estimated) P&L row per store per day.
CREATE TABLE IF NOT EXISTS pnl_days (
  store       TEXT    NOT NULL,
  day         TEXT    NOT NULL,
  revenue     REAL, cogs REAL, cogs_estimated_share REAL,
  ads REAL, services REAL, fees REAL, refunds REAL, chargebacks REAL,
  profit REAL, real_profit REAL,
  orders INTEGER, clicks INTEGER, sessions INTEGER,
  status      TEXT    NOT NULL DEFAULT 'partial', -- partial | closed | restated
  sources     TEXT,                          -- JSON: where each number came from + when
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (store, day)
);

-- Supplier conversations (WhatsApp + KFB), one row per message.
CREATE TABLE IF NOT EXISTS supplier_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,
  direction   TEXT    NOT NULL,              -- in | out
  channel     TEXT    NOT NULL,              -- whatsapp | kfb
  store       TEXT,
  ticket_id   INTEGER,
  body        TEXT,
  attachments TEXT,                          -- JSON
  status      TEXT                           -- draft | approved | sent | received
);

-- THE CORE: everything known about every store. One fact per row, with provenance.
CREATE TABLE IF NOT EXISTS core_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store       TEXT,                          -- null = applies to all stores
  area        TEXT    NOT NULL,              -- profile | pricing | policy | product | supplier | rule | sizing ...
  key         TEXT    NOT NULL,              -- e.g. "pricing.band", "sku:HC-WBLZ-006:size_chart"
  value       TEXT    NOT NULL,              -- JSON or text
  kind        TEXT    NOT NULL DEFAULT 'observation', -- observation | rule | decision | inference
  source      TEXT    NOT NULL,              -- where it came from (file, API, Reilly's words)
  observed_at TEXT    NOT NULL,
  stale_after TEXT,                          -- when it must be re-checked
  live        INTEGER NOT NULL DEFAULT 1,    -- 1 = part of Core State (read first); 0 = archive
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_core_key  ON core_facts(store, key);
CREATE INDEX IF NOT EXISTS idx_core_live ON core_facts(live);
