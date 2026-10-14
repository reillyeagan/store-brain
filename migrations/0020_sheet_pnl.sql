-- Store Brain ledger, v20: the P&L Sheets agent (pnl.sheets) and the history fixes behind it.
-- Additive only. Only line comments and no semicolons inside comments (the D1 remote
-- splitter breaks on block comments and on semicolons inside comments).

-- One row per store-day as read from Reilly's P&L workbook (store 'all' = the combined Ecom P&L).
-- Every money column is NULL when the cell is blank (blank is not zero).
-- formulas = JSON list of the columns whose cell holds a formula (never written by the brain).
-- cog_ok / fee_ok / ads_ok: 1 when that value may fill a gap in the brain, 0 when not, and the
-- matching *_why says why (an estimate named in SETUP, a $0 COG on a day with orders, too recent).
-- applied_at = when the P&L last recomputed the day after this row changed (NULL = due).
CREATE TABLE IF NOT EXISTS sheet_pnl_days (
  store        TEXT NOT NULL,
  day          TEXT NOT NULL,
  sheet_id     TEXT NOT NULL,
  tab          TEXT NOT NULL,
  row_no       INTEGER NOT NULL,
  revenue      REAL,
  cog_usd      REAL,
  adspend      REAL,
  services     REAL,
  employee     REAL,
  fee          REAL,
  profit       REAL,
  orders       INTEGER,
  clicks       INTEGER,
  sessions     INTEGER,
  cog_eur      REAL,
  fx_rate      REAL,
  formulas     TEXT,
  cog_ok       INTEGER NOT NULL DEFAULT 0,
  cog_why      TEXT,
  fee_ok       INTEGER NOT NULL DEFAULT 0,
  fee_why      TEXT,
  ads_ok       INTEGER NOT NULL DEFAULT 0,
  ads_why      TEXT,
  read_at      TEXT NOT NULL,
  applied_at   TEXT,
  PRIMARY KEY (store, day)
);

-- One row per workbook: what was read, the SETUP facts the brain uses, and the last write.
CREATE TABLE IF NOT EXISTS sheet_workbooks (
  store          TEXT PRIMARY KEY,
  sheet_id       TEXT NOT NULL,
  title          TEXT,
  fx_rate        REAL,
  revenue_tz     TEXT,
  services_ended TEXT,
  setup          TEXT,
  tabs           TEXT,
  last_read_at   TEXT,
  last_ok_at     TEXT,
  last_error     TEXT,
  full_read_at   TEXT,
  last_write_at  TEXT,
  last_write     TEXT
);

-- A disagreement between the sheet and the brain, logged once per store, day and field.
CREATE TABLE IF NOT EXISTS sheet_mismatches (
  store        TEXT NOT NULL,
  day          TEXT NOT NULL,
  field        TEXT NOT NULL,
  sheet_value  REAL,
  brain_value  REAL,
  brain_source TEXT,
  note         TEXT,
  logged_at    TEXT NOT NULL,
  PRIMARY KEY (store, day, field)
);

-- Every cell the brain wrote into a workbook, with the R2 backup taken before it and whether
-- the re-read confirmed it.
CREATE TABLE IF NOT EXISTS sheet_writes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store       TEXT NOT NULL,
  sheet_id    TEXT NOT NULL,
  tab         TEXT NOT NULL,
  cell        TEXT NOT NULL,
  day         TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       REAL NOT NULL,
  backup_key  TEXT NOT NULL,
  written_at  TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sheet_writes_at ON sheet_writes(written_at);

-- Where a day of ad spend came from: 'api' (Google Ads, the authority) or 'sheet' (Reilly's
-- workbook, used only for a day the API never answered for). For a 'sheet' row impressions
-- and conv_value are not known (stored as 0 because the columns are NOT NULL, never read as data).
ALTER TABLE ad_spend_days ADD COLUMN source TEXT NOT NULL DEFAULT 'api';

-- One-time Google Ads history backfill, chunked over runs. cursor_day = next day to read.
CREATE TABLE IF NOT EXISTS ads_backfill (
  store            TEXT PRIMARY KEY,
  from_day         TEXT NOT NULL,
  cursor_day       TEXT NOT NULL,
  first_spend_day  TEXT,
  days_written     INTEGER NOT NULL DEFAULT 0,
  done_at          TEXT,
  last_error       TEXT,
  updated_at       TEXT NOT NULL
);

-- Order history extension: read orders created before the first pass's start, then move
-- order_coverage.covered_from back. ext_* = the orders read, ref_* = the matching refund read.
ALTER TABLE order_backfill ADD COLUMN ext_from TEXT;
ALTER TABLE order_backfill ADD COLUMN ext_to TEXT;
ALTER TABLE order_backfill ADD COLUMN ext_cursor TEXT;
ALTER TABLE order_backfill ADD COLUMN ext_all_orders INTEGER;
ALTER TABLE order_backfill ADD COLUMN ext_orders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_backfill ADD COLUMN ext_done_at TEXT;
ALTER TABLE order_backfill ADD COLUMN ref_ext_cursor TEXT;
ALTER TABLE order_backfill ADD COLUMN ref_ext_done_at TEXT;
ALTER TABLE order_backfill ADD COLUMN ext_note TEXT;
