-- Store Brain ledger: tracking fixes after review (2026-10-11).
-- Additive only: new columns and one new table. 0006 is left exactly as it was.

-- What Shopify itself says about the fulfillment (Admin API 2026-07 `Fulfillment.displayStatus`
-- and `Fulfillment.deliveredAt`). A parcel Shopify already reports as DELIVERED is not worth
-- one of the 200 free 17TRACK registrations.
ALTER TABLE shipments ADD COLUMN shopify_status TEXT;        -- FulfillmentDisplayStatus, verbatim
ALTER TABLE shipments ADD COLUMN shopify_delivered_at TEXT;  -- Fulfillment.deliveredAt

-- Stuck-pickup is judged per PARCEL (an order can have several), one row per tracking
-- number. shipment_flags keeps one 'stuck_pickup' row per order for Mission Control and
-- the brief; it stays open while any of the order's parcels here is open.
CREATE TABLE IF NOT EXISTS parcel_pickup_flags (
  tracking_number TEXT    PRIMARY KEY,
  store           TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  order_name      TEXT,
  detail          TEXT,
  raised_at       TEXT    NOT NULL,
  resolved_at     TEXT                         -- set once the carrier has scanned it (or it's delivered)
);
CREATE INDEX IF NOT EXISTS idx_parcel_pickup_flags_order ON parcel_pickup_flags(store, order_id);

-- A plain counter per stage (used for refused 17TRACK pushes: counted, summarised at most hourly).
ALTER TABLE tracking_runs ADD COLUMN count INTEGER NOT NULL DEFAULT 0;
