-- Store Brain ledger: Customer Service (dept `cs`). Additive only: new tables, nothing existing touched.
-- All CS agents run in SHADOW: they read mail, classify, draft into these tables and flag Reilly.
-- Nothing is sent. A Gmail draft is created only when CS_DRAFTS_LIVE = "1" (default off).

-- One row per connected inbox the brain reads (slot = oauth_tokens.provider: "google" or "google:hc").
-- cursor_ms = newest Gmail internalDate already read, so each email is read once.
CREATE TABLE IF NOT EXISTS cs_inboxes (
  slot          TEXT    PRIMARY KEY,
  account       TEXT,                        -- the Gmail account behind the slot
  cursor_ms     INTEGER,                     -- newest internalDate read (null = never read)
  last_read_at  TEXT,                        -- last time a read was attempted
  last_ok_at    TEXT,                        -- last time a read finished without a fault
  last_error    TEXT,                        -- plain-English reason of the last failure ("not wired", HTTP ...)
  read_count    INTEGER NOT NULL DEFAULT 0   -- emails looked at, all time
);

-- Every Gmail message the brain has looked at, with what it decided. Stops re-reading the
-- same message when the time cursor overlaps (Gmail's after: search is not exact).
CREATE TABLE IF NOT EXISTS cs_mail_seen (
  slot          TEXT    NOT NULL,
  gmail_id      TEXT    NOT NULL,
  seen_at       TEXT    NOT NULL,
  outcome       TEXT    NOT NULL,            -- ticket | ignored:<reason>
  PRIMARY KEY (slot, gmail_id)
);

-- One customer email = one CS ticket. (The shared `tickets` table is a generic cross-department
-- queue with a JSON detail field; CS needs many searchable columns, so it keeps its own table.)
CREATE TABLE IF NOT EXISTS cs_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at       TEXT    NOT NULL,          -- when the brain read it
  updated_at      TEXT    NOT NULL,
  slot            TEXT    NOT NULL,          -- which inbox it came from (replies go back to the same inbox)
  gmail_id        TEXT    NOT NULL,
  thread_id       TEXT,
  rfc_message_id  TEXT,                      -- Message-ID header (threading the reply + cross-inbox dedupe)
  received_at     TEXT,                      -- Gmail internalDate (UTC)
  store           TEXT,                      -- hc | aub | mar | null (unknown)
  from_email      TEXT,                      -- the customer's reply address (Reply-To for contact forms)
  from_name       TEXT,
  to_addr         TEXT,
  subject         TEXT,
  body            TEXT,                      -- the customer's words (quoted history stripped, capped)
  via             TEXT,                      -- email | contact_form
  -- cs.triage (AI classification; code validates every field)
  status          TEXT    NOT NULL DEFAULT 'new', -- new | open | drafted | needs_reilly | replied | superseded | ignored
  category        TEXT,
  urgency         TEXT,                      -- low | normal | high
  order_ref       TEXT,                      -- order number mentioned, digits only
  summary         TEXT,                      -- one line, AI
  triage          TEXT,                      -- JSON: the validated classification
  classified_at   TEXT,
  classify_note   TEXT,                      -- why classification is waiting / failed
  -- cs.order_context
  order_store     TEXT,
  order_id        TEXT,
  order_name      TEXT,
  context         TEXT,                      -- JSON: status, items, express, shipments, refunds, source
  context_at      TEXT,
  context_note    TEXT,                      -- e.g. "no order matched"
  feeds_at        TEXT,                      -- size complaint / KFB ask recorded (once)
  -- cs.reply_writer
  draft_body      TEXT,
  draft_at        TEXT,
  draft_status    TEXT,                      -- stored | gmail_draft | blocked | escalated
  draft_note      TEXT,
  gmail_draft_id  TEXT,
  -- cs.escalation
  escalated_at    TEXT,
  approval_id     INTEGER,
  -- cs.retention
  retention       TEXT,                      -- JSON suggestion (never sent)
  retention_at    TEXT,
  -- cs.obligations
  thread_checked_at TEXT,
  replied_at      TEXT,                      -- Reilly's sent reply seen in the thread
  UNIQUE (slot, gmail_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_tickets_msgid ON cs_tickets(rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_status ON cs_tickets(status);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_thread ON cs_tickets(slot, thread_id);

-- Things KFB must be asked for an order because of a customer email (size / colour / address
-- change, exchange, cancellation). Relay (the KFB copy-paste message) reads these later; CS
-- never writes the KFB message itself. One ask per ticket per kind.
CREATE TABLE IF NOT EXISTS cs_kfb_asks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  store       TEXT,
  ticket_id   INTEGER NOT NULL,
  order_id    TEXT,                          -- null = the email named no order we could match
  order_name  TEXT,
  kind        TEXT    NOT NULL,              -- size | colour | address | exchange | cancel
  detail      TEXT,                          -- one plain line, e.g. "M → L" (address text is never copied here)
  shipped     INTEGER,                       -- 1 = already shipped when asked (KFB may not be able to change it); null = unknown
  status      TEXT    NOT NULL DEFAULT 'open', -- open | included | done | cancelled
  UNIQUE (ticket_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_cs_kfb_asks_status ON cs_kfb_asks(status);

-- Overdue obligations already flagged, so each one is flagged once.
CREATE TABLE IF NOT EXISTS cs_overdue_flags (
  obligation_id INTEGER PRIMARY KEY,
  flagged_at    TEXT    NOT NULL
);
