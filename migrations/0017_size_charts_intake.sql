-- Size-chart intake (Supplier, Size Checker). Additive only: one new table, nothing existing touched.
-- Safe to re-run: CREATE ... IF NOT EXISTS only.
-- Line comments only here: D1's remote splitter breaks on block comments and on semicolons inside comments.

-- One row per factory chart added through POST /api/size-charts (pasted by Reilly or read by the
-- brain from an image). Its sizes are written to size_charts with source "intake:<id> ...", so a
-- confirm can mark exactly these rows verified. Kept after a newer chart replaces it (history).
CREATE TABLE IF NOT EXISTS size_chart_intakes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store           TEXT    NOT NULL,
  product_id      TEXT    NOT NULL,              -- Shopify Product GID, or "handle:<handle>" until the handle resolves
  product_handle  TEXT,
  title           TEXT,                          -- the product title when the brain knows it
  kind            TEXT    NOT NULL,              -- paste | image
  unit_given      TEXT,                          -- cm | in (what was supplied, before converting to cm)
  flat_given      INTEGER NOT NULL DEFAULT 0,    -- 1 = chest/waist were supplied flat (half) and were doubled
  rows            TEXT    NOT NULL,              -- JSON: [{size, chest, shoulder, length, sleeve, waist}] in cm, as saved
  notes           TEXT,                          -- JSON array: conversions and auto-detections applied
  source          TEXT    NOT NULL,              -- who or what supplied it, in words
  verified        INTEGER NOT NULL DEFAULT 0,    -- 0 = not yet checked by Reilly, 1 = confirmed by Reilly
  created_at      TEXT    NOT NULL,
  confirmed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_size_chart_intakes_product ON size_chart_intakes(store, product_id);
