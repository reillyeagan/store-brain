-- Store Brain ledger, v2: order detail + supplier (KFB) messages + size library.
-- Additive only: new columns get safe defaults, new tables are created if missing.
-- Nothing existing is renamed, dropped or rewritten, so this is safe on the live ledger.

-- Shipping method the customer paid for. `express` is derived in code
-- (isExpressShipping in src/lib/orderLines.js) so the rule lives in one place.
ALTER TABLE orders ADD COLUMN shipping_title TEXT;
ALTER TABLE orders ADD COLUMN shipping_code  TEXT;
ALTER TABLE orders ADD COLUMN express        INTEGER NOT NULL DEFAULT 0;
-- Which version of the order (Shopify updated_at) the stored line items reflect.
-- Lets the 15-minute pull re-read lines only for orders whose lines are behind.
ALTER TABLE orders ADD COLUMN lines_for_updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_express ON orders(express, local_day);

-- One row per order line (what was bought, which size/colour, how many).
CREATE TABLE IF NOT EXISTS order_lines (
  store          TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,           -- Shopify Order GID
  line_id        TEXT    NOT NULL,           -- Shopify LineItem GID
  product_id     TEXT,
  product_handle TEXT,                       -- only the GraphQL pull knows it; webhooks keep what's there
  variant_id     TEXT,
  sku            TEXT,
  title          TEXT,
  variant_title  TEXT,                       -- e.g. "Navy / L"
  size           TEXT,                       -- picked from the options; null if none looks like a size
  color          TEXT,
  quantity       INTEGER,
  price          REAL,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (store, line_id)
);
CREATE INDEX IF NOT EXISTS idx_order_lines_order   ON order_lines(store, order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_product ON order_lines(store, product_id);

-- Copy-paste messages for the KFB group (Reilly sends them himself; decided 2026-10-11).
CREATE TABLE IF NOT EXISTS kfb_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  local_day   TEXT    NOT NULL,              -- Eastern day it was composed
  mode        TEXT    NOT NULL,              -- shadow | live
  body        TEXT    NOT NULL,              -- exactly what Reilly pastes
  items       TEXT,                          -- JSON array of the items in the message
  status      TEXT    NOT NULL DEFAULT 'draft', -- draft | notified | sent
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_kfb_messages_day ON kfb_messages(local_day);

-- Every ask made of KFB, per order. UNIQUE so an order is never asked for twice.
CREATE TABLE IF NOT EXISTS kfb_message_items (
  message_id  INTEGER NOT NULL,
  store       TEXT    NOT NULL,
  order_id    TEXT    NOT NULL,
  order_name  TEXT,
  kind        TEXT    NOT NULL,              -- express | (later) size | address | colour ...
  detail      TEXT,
  UNIQUE (store, order_id, kind)
);

-- One composer run per Eastern day, claimed atomically, so two overlapping cron
-- runs can't both compose and an empty day still counts as "checked".
CREATE TABLE IF NOT EXISTS kfb_runs (
  local_day   TEXT    PRIMARY KEY,
  ran_at      TEXT    NOT NULL,
  message_id  INTEGER,                       -- null when there was nothing to ask
  item_count  INTEGER NOT NULL DEFAULT 0
);

-- Size-chart library (Size Checker; logic arrives later). Measurements in cm.
CREATE TABLE IF NOT EXISTS size_charts (
  store          TEXT    NOT NULL,
  product_id     TEXT    NOT NULL,
  product_handle TEXT,
  factory_link   TEXT,
  size_label     TEXT    NOT NULL,
  measurements   TEXT,                       -- JSON: {chest, length, shoulder, sleeve, ...}
  source         TEXT,                       -- where the chart came from (image URL, Reilly, ...)
  verified       INTEGER NOT NULL DEFAULT 0, -- 0 = read by the brain, unchecked; 1 = checked
  checked_at     TEXT,
  PRIMARY KEY (store, product_id, size_label)
);

-- Sizing complaints from customers, logged against the product.
CREATE TABLE IF NOT EXISTS size_complaints (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  order_id       TEXT,
  product_id     TEXT,
  size_ordered   TEXT,
  size_that_fits TEXT,
  said           TEXT,                       -- the customer's words, verbatim
  source         TEXT,                       -- e.g. "gmail:<message id>"
  at             TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_size_complaints_product ON size_complaints(store, product_id);
