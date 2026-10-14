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
