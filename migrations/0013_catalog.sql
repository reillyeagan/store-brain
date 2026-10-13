-- Catalog & Feed department (shadow). Additive only: new tables, nothing existing touched.

-- A read-only copy of each live store's products, refreshed from Shopify (read_products).
-- Later reads only fetch products whose Shopify updated_at moved (query filter), so the
-- copy stays current without re-reading the whole catalog every tick.
CREATE TABLE IF NOT EXISTS cat_products (
  store            TEXT    NOT NULL,
  product_id       TEXT    NOT NULL,           -- Shopify Product GID
  handle           TEXT,
  title            TEXT,
  status           TEXT,                       -- ACTIVE | DRAFT | ARCHIVED | UNLISTED
  product_type     TEXT,
  tags             TEXT,                       -- JSON array
  created_at       TEXT,
  shopify_updated_at TEXT,                     -- Shopify's updatedAt (the delta watermark)
  published_at     TEXT,
  description_len  INTEGER,                    -- length of the (truncated) description; 0 = empty
  seo_title        TEXT,
  seo_description  TEXT,
  image_count      INTEGER,
  option_names     TEXT,                       -- JSON array, e.g. ["Size","Color"]
  tracks_inventory INTEGER,
  total_inventory  INTEGER,
  collections_count INTEGER,                   -- 0..3 (we only read the first 3)
  variants_count   INTEGER,                    -- all variants, even if we read fewer
  variants         TEXT,                       -- JSON: [{id, sku, title, price, compareAt, qty, policy, tracked}]
  read_at          TEXT    NOT NULL,           -- when the brain last read this product
  PRIMARY KEY (store, product_id)
);
CREATE INDEX IF NOT EXISTS idx_cat_products_status ON cat_products(store, status);

-- Where each store's product read is up to.
CREATE TABLE IF NOT EXISTS cat_sync (
  store            TEXT    PRIMARY KEY,
  watermark        TEXT,                       -- newest Shopify updatedAt fully read (null = never)
  pass_kind        TEXT,                       -- full | delta | null (no pass in progress)
  pass_query       TEXT,                       -- the Shopify search filter of the pass in progress
  pass_cursor      TEXT,                       -- page cursor of the pass in progress
  pass_started_at  TEXT,
  pass_max_updated TEXT,                       -- newest updatedAt seen in the pass in progress
  pass_read        INTEGER NOT NULL DEFAULT 0, -- products read in the pass in progress
  last_full_at     TEXT,                       -- when a full read last COMPLETED
  last_pass_at     TEXT,                       -- when any read (full or delta) last completed
  last_error       TEXT,
  last_error_at    TEXT
);

-- One row per agent per store: the latest run's results (findings capped), read by the page.
CREATE TABLE IF NOT EXISTS cat_runs (
  agent            TEXT    NOT NULL,           -- cat.pricing | cat.margin_guard | ...
  store            TEXT    NOT NULL,
  day              TEXT    NOT NULL,           -- store-local day the run belongs to
  ran_at           TEXT    NOT NULL,
  status           TEXT    NOT NULL,           -- ok | not_wired | waiting | error
  note             TEXT,                       -- e.g. the not-wired reason
  summary          TEXT,                       -- JSON counts
  findings         TEXT,                       -- JSON array (worst first, capped)
  PRIMARY KEY (agent, store)
);

-- Standing price holds (H&C outerwear at $114.95, Reilly 09-01) with the cost at hold time:
-- "A held product is never re-proposed unless its cost changes."
CREATE TABLE IF NOT EXISTS cat_holds (
  store            TEXT    NOT NULL,
  product_id       TEXT    NOT NULL,
  price            REAL    NOT NULL,           -- the held price
  cost_usd         REAL,                       -- cost when held (null = unknown then; first known cost fills it)
  held_at          TEXT    NOT NULL,
  cost_seen_at     TEXT,
  PRIMARY KEY (store, product_id)
);

-- Once-a-day claims, so a daily check runs exactly once per store-local day even when two
-- cron runs overlap (atomic: the row only moves forward to a later day).
CREATE TABLE IF NOT EXISTS cat_daily (
  job              TEXT    PRIMARY KEY,
  day              TEXT    NOT NULL,
  claimed_at       TEXT    NOT NULL
);
