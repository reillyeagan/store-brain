-- Store Brain ledger: parcel tracking (Fulfillment — Tracking Sync, 17TRACK).
-- Additive only: three new tables, nothing existing is touched.

-- One row per tracking number Shopify holds for a fulfillment. Shopify only stores the
-- number; real carrier events come from 17TRACK and are summarised here.
CREATE TABLE IF NOT EXISTS shipments (
  store            TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,          -- Shopify Order GID
  order_name       TEXT,                      -- e.g. "#1231"
  order_created_at TEXT,                      -- Shopify order time (UTC); day-15/day-20 count from it (Eastern)
  fulfillment_id   TEXT,                      -- Shopify Fulfillment GID
  tracking_number  TEXT    NOT NULL,          -- normalised: trimmed, upper case, no spaces
  carrier_hint     TEXT,                      -- the carrier name Shopify/KFB gave (may be blank or wrong)
  tracking_url     TEXT,
  shipped_at       TEXT,                      -- Shopify fulfillment createdAt (when KFB marked it shipped)
  registered_at    TEXT,                      -- when 17TRACK accepted it (each number is registered ONCE)
  register_error   TEXT,                      -- 17TRACK's rejection, if any (never retried automatically)
  carrier_code     INTEGER,                   -- 17TRACK carrier key it detected
  state            TEXT,                      -- internal status (see mapStatus in src/lib/track17.js)
  last_status      TEXT,                      -- 17TRACK main status, verbatim (NotFound, InTransit, ...)
  last_sub_status  TEXT,                      -- 17TRACK sub-status, verbatim
  last_event_at    TEXT,
  last_event_text  TEXT,
  last_event_location TEXT,
  pickup_at        TEXT,                      -- first carrier scan (null = not picked up yet, or unknown)
  delivered_at     TEXT,
  pod              TEXT,                      -- R2 key of the saved proof of delivery
  polled_at        TEXT,                      -- last time 17TRACK answered for this number
  push_at          TEXT,                      -- a verified 17TRACK push asked for a re-check
  updated_at       TEXT    NOT NULL,
  UNIQUE (tracking_number)
);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(store, order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_state ON shipments(state);

-- Things a person must look at, once per order per kind:
--   stuck_pickup | failed_delivery | pickup_ready | day15 | day20
CREATE TABLE IF NOT EXISTS shipment_flags (
  store           TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  order_name      TEXT,
  kind            TEXT    NOT NULL,
  tracking_number TEXT,
  detail          TEXT,                       -- one plain-English line
  raised_at       TEXT    NOT NULL,
  resolved_at     TEXT,                       -- set when the parcel is delivered
  approval_id     INTEGER,                    -- day20 only: the reship/refund approval
  UNIQUE (store, order_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_shipment_flags_open ON shipment_flags(resolved_at);

-- Self-throttling state for the tracking stages (the cron runs every 15 minutes, but
-- collection is hourly). Also holds the last 17TRACK quota reading.
CREATE TABLE IF NOT EXISTS tracking_runs (
  stage        TEXT PRIMARY KEY,              -- collect | quota
  last_run_at  TEXT,                          -- claimed when a run starts
  last_ok_at   TEXT,                          -- the run finished without a fault
  detail       TEXT                           -- JSON
);
