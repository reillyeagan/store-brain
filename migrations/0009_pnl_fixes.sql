-- Store Brain ledger: P&L fixes after review (2026-10-11).
-- Additive only: two new tables and one new column. 0001-0008 are left exactly as they were.

-- Which days each store's order history is COMPLETE for. Webhooks only deliver orders
-- placed after they were connected, and the 15-minute pull only reads the 25 most recently
-- updated, so the ledger can miss older orders. The orders backfill (src/lib/orderBackfill.js)
-- pages every order since the first day of the previous month; when it has read them all it
-- writes this row. The P&L treats any day before covered_from (or a store with no row yet)
-- as incomplete, with profit null: an understated revenue would hide a loss.
CREATE TABLE IF NOT EXISTS order_coverage (
  store        TEXT PRIMARY KEY,
  covered_from TEXT NOT NULL,                 -- earliest fully-covered day (YYYY-MM-DD, store timezone)
  completed_at TEXT NOT NULL                  -- when the backfill finished reading (UTC)
);

-- Progress of the orders backfill, per store, so a run that stops half-way resumes
-- from its cursor instead of starting again.
CREATE TABLE IF NOT EXISTS order_backfill (
  store        TEXT PRIMARY KEY,
  query_from   TEXT NOT NULL,                 -- the day it reads from (first day of the previous month)
  cursor       TEXT,                          -- Shopify endCursor of the last page stored (null = start)
  pages        INTEGER NOT NULL DEFAULT 0,
  orders       INTEGER NOT NULL DEFAULT 0,    -- orders read so far
  added        INTEGER NOT NULL DEFAULT 0,    -- of which were not in the ledger before
  started_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  completed_at TEXT,                          -- set once the first full pass is done
  inc_since    TEXT                           -- incremental pass: re-read orders updated since this (UTC)
);

-- false (0) when the AI text holds a $-amount, %-figure, ROAS, order number or date that
-- isn't one of the figures code gave it. 1 = every such number checked. Null = older rows.
ALTER TABLE briefs ADD COLUMN checked INTEGER;
