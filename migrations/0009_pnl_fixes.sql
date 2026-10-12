-- Store Brain ledger: P&L fixes after review (2026-10-11).
-- Additive only: two new tables and one new column. 0001-0008 are left exactly as they were.

-- Which days each store's order history is COMPLETE for. Webhooks only deliver orders
-- placed after they were connected, and the 15-minute pull only reads the 25 most recently
-- updated, so the ledger can miss older orders. The orders backfill (src/lib/orderBackfill.js)
-- pages every order since the first day of the previous month; when it has read them all it
-- writes this row. The P&L treats any day before covered_from (or a store with no row yet)
-- as incomplete, with profit null: a missing order hides a loss as easily as a gain.
CREATE TABLE IF NOT EXISTS order_coverage (
  store        TEXT PRIMARY KEY,
  covered_from TEXT NOT NULL,                 -- earliest fully-covered day (YYYY-MM-DD, store timezone)
  completed_at TEXT NOT NULL                  -- when the backfill finished reading (UTC)
);

-- Progress of the orders backfill, per store, so a run that stops half-way resumes
-- from its cursor instead of starting again.
CREATE TABLE IF NOT EXISTS order_backfill (
  store             TEXT PRIMARY KEY,
  query_from        TEXT NOT NULL,            -- the day it reads from (first day of the previous month, store timezone)
  cursor            TEXT,                     -- Shopify endCursor of the last page stored (null = start)
  pages             INTEGER NOT NULL DEFAULT 0,
  orders            INTEGER NOT NULL DEFAULT 0, -- orders read so far
  added             INTEGER NOT NULL DEFAULT 0, -- of which were not in the ledger before
  started_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  completed_at      TEXT,                     -- set once the first full pass is done
  inc_since         TEXT,                     -- incremental pass: re-read orders updated since this (UTC)
  last_full_read_at TEXT                      -- every order change up to this moment (UTC) has been read:
                                              -- the orders input's "last successful pull" for day completeness
);

-- 1 when every $-amount, %-figure, ROAS, order name and date in the brief's text matches
-- a figure or reference code gave the model; 0 when any doesn't (they're listed at the
-- top as "Unverified numbers"). Null = rows from before this column.
ALTER TABLE briefs ADD COLUMN checked INTEGER;

-- From which day a derived input (refunds, Shopify fees) is complete for a store. Before
-- this day the input was never read, so the P&L must show it as unknown (null), never as
-- $0: a missing refund or fee makes profit look better than it was (rule 5).
CREATE TABLE IF NOT EXISTS feed_coverage (
  store        TEXT NOT NULL,
  feed         TEXT NOT NULL,                 -- 'refunds'
  start_day    TEXT NOT NULL,                 -- first day the first full read reaches back to
  covered_from TEXT,                          -- set once that first read finished (= start_day)
  cursor_at    TEXT,                          -- full read in progress: orders updated up to here are done
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (store, feed)
);
