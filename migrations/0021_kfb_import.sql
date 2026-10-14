-- KFB morning import (svc.kfb_session). Reilly clicks a bookmarklet on the KFB site while
-- logged in. It reads KFB JSON with GET only and the dashboard posts the rows to
-- /api/import/kfb. The rows land in the existing tables (kfb_quotes, kfb_orders, kfb_bills,
-- kfb_bill_lines, supplier_bills). These two tables only record each import.
-- Additive only. CREATE TABLE IF NOT EXISTS. Nothing existing is renamed or dropped.

-- One row per import. The same rows imported twice on the same Eastern day are refused as a
-- duplicate (UNIQUE below), so a double click changes nothing.
CREATE TABLE IF NOT EXISTS kfb_imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_hash  TEXT    NOT NULL,              -- SHA-256 of the rows, not of the fetch time
  local_day     TEXT    NOT NULL,              -- Eastern day of the import
  fetched_at    TEXT    NOT NULL,              -- when the bookmarklet read KFB (UTC)
  imported_at   TEXT    NOT NULL,
  origin        TEXT    NOT NULL,              -- the KFB origin the rows came from
  sections      TEXT    NOT NULL,              -- JSON per section, read ok or the error the bookmarklet saw
  counts        TEXT    NOT NULL,              -- JSON inserted, updated, unchanged and refused per table
  r2_key        TEXT,                          -- audit copy of the raw payload in BACKUPS
  UNIQUE (payload_hash, local_day)
);
CREATE INDEX IF NOT EXISTS idx_kfb_imports_day ON kfb_imports(local_day, id);

-- Rows read per KFB shop per section in one import. The Order-to-Supplier Watcher uses it to
-- tell "this sweep read no orders for the store" from "the order is missing" (rule 6).
CREATE TABLE IF NOT EXISTS kfb_import_shops (
  import_id     INTEGER NOT NULL,
  kfb_shop_code TEXT    NOT NULL,
  section       TEXT    NOT NULL,              -- quotes or orders or bills
  rows          INTEGER NOT NULL,
  PRIMARY KEY (import_id, kfb_shop_code, section)
);
