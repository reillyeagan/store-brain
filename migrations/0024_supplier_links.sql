-- Factory (1688) links for size charts (Reilly, 2026-10-20). Additive only: three new tables.
-- No semicolons in comments (the D1 remote splitter breaks on them).
--
-- supplier_links: the factory listing KFB buys each store product from, read from the KFB
-- quotation (product.order_items.goods_url). One row per store product and factory offer.
CREATE TABLE IF NOT EXISTS supplier_links (
  store          TEXT    NOT NULL,
  product_handle TEXT    NOT NULL,
  product_id     TEXT,                      -- gid://shopify/Product/<id> when KFB gave it
  offer_id       TEXT    NOT NULL,          -- the 1688 offer number
  offer_url      TEXT    NOT NULL,          -- https://detail.1688.com/offer/<offer_id>.html
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  PRIMARY KEY (store, product_handle, offer_id)
);
-- factory_variants: what the factory calls each store variant (e.g. store "Green / 2XL" is
-- factory "开衫-绿色-2XL"), so a size change names the factory size KFB will recognise.
CREATE TABLE IF NOT EXISTS factory_variants (
  store          TEXT    NOT NULL,
  variant_id     TEXT    NOT NULL,          -- Shopify variant id (number)
  product_handle TEXT,
  shop_spec      TEXT,
  factory_spec   TEXT,
  factory_sku    TEXT,
  offer_id       TEXT,
  seen_at        TEXT    NOT NULL,
  PRIMARY KEY (store, variant_id)
);
-- chart_fetches: the brain's attempts to read a product's size chart from its 1688 listing.
-- status: read | not_found | blocked | failed. Retried later with a growing gap, at most 4 tries.
CREATE TABLE IF NOT EXISTS chart_fetches (
  store          TEXT    NOT NULL,
  product_handle TEXT    NOT NULL,
  offer_id       TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  note           TEXT,
  intake_id      INTEGER,                   -- size_chart_intakes row when a chart was saved
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_try_at    TEXT    NOT NULL,
  next_try_at    TEXT,
  PRIMARY KEY (store, product_handle)
);
