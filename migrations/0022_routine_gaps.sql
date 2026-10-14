-- Routine-audit gaps (2026-10-14). Additive only: new nullable columns and new tables.
-- Nothing existing is renamed, dropped or rewritten. No semicolons in comments (the D1
-- remote splitter breaks on them).

-- CS promise tracker: a refund, replacement or exchange promised in Reilly's SENT mail is an
-- obligation tied to the ticket's VERIFIED order (order_id, never a number the email merely
-- mentions). It closes only when the system of record shows it happened. approval_id is the
-- Waiting-on-you question raised once it is overdue.
ALTER TABLE obligations ADD COLUMN order_id TEXT;
ALTER TABLE obligations ADD COLUMN approval_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_obligations_status_kind ON obligations(status, kind);

-- Risk: Reilly's personal details found in customer-facing text (theme, product descriptions,
-- policies, store contact settings). Plain-code matches, always high severity. A hit stays open
-- until a later weekly read of the same source no longer finds it (cleared_at).
CREATE TABLE IF NOT EXISTS risk_personal_hits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store         TEXT    NOT NULL,
  source        TEXT    NOT NULL,          -- theme:<file> | product:<handle> | policy:<type> | settings:<field>
  pattern       TEXT    NOT NULL,          -- which personal detail matched (PERSONAL_PATTERNS id)
  label         TEXT,
  excerpt       TEXT,                      -- a short piece of the text around the match
  severity      TEXT    NOT NULL DEFAULT 'high',
  found_at      TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  cleared_at    TEXT,                      -- set when a later read no longer finds it
  UNIQUE (store, source, pattern)
);
CREATE INDEX IF NOT EXISTS idx_risk_personal_open ON risk_personal_hits(store, cleared_at);
