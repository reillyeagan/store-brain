-- Store Brain ledger, v5: money feeds (Google Ads spend, Shopify Payments, refund pulls).
-- Additive only: new tables, nothing existing is renamed, dropped or rewritten.

-- Daily Google Ads totals per store, in the AD ACCOUNT's own timezone (that is how
-- Google reports `segments.date`). The last 7 days are re-pulled every hour and
-- restated in place, because Google keeps adjusting recent days.
CREATE TABLE IF NOT EXISTS ad_spend_days (
  store       TEXT    NOT NULL,
  day         TEXT    NOT NULL,              -- YYYY-MM-DD in account_tz
  cost        REAL    NOT NULL,              -- account currency (cost_micros / 1e6)
  clicks      INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  conv_value  REAL    NOT NULL,              -- metrics.conversions_value
  currency    TEXT,                          -- customer.currency_code
  account_tz  TEXT,                          -- customer.time_zone
  fetched_at  TEXT    NOT NULL,              -- when Google last answered for this day
  PRIMARY KEY (store, day)
);

-- Shopify Payments payouts. Deduped by payout id, never by amount:
-- two identical $67.62 payouts are normal.
CREATE TABLE IF NOT EXISTS payouts (
  store       TEXT    NOT NULL,
  payout_id   TEXT    NOT NULL,              -- Shopify GID
  issued_at   TEXT,
  status      TEXT,                          -- SCHEDULED | PAID | FAILED | CANCELED
  net         REAL,
  currency    TEXT,
  check_result TEXT,                         -- match | mismatch | unverified | null (not checked yet)
  checked_at  TEXT,
  fetched_at  TEXT    NOT NULL,
  PRIMARY KEY (store, payout_id)
);
CREATE INDEX IF NOT EXISTS idx_payouts_issued ON payouts(store, issued_at);

-- Every Shopify Payments balance transaction (charge, refund, fee, adjustment, reserve...).
CREATE TABLE IF NOT EXISTS balance_txns (
  store       TEXT    NOT NULL,
  txn_id      TEXT    NOT NULL,              -- Shopify GID
  type        TEXT,
  date        TEXT,                          -- transactionDate (UTC)
  amount      REAL,
  fee         REAL,
  net         REAL,
  currency    TEXT,
  payout_id   TEXT,                          -- associatedPayout.id (null until it is in a payout)
  payout_status TEXT,
  order_id    TEXT,                          -- associatedOrder.id when there is one
  test        INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT    NOT NULL,
  PRIMARY KEY (store, txn_id)
);
CREATE INDEX IF NOT EXISTS idx_balance_txns_payout ON balance_txns(store, payout_id);

-- Current balances, one row per (source, store). Shopify now; PayPal/bank (typed in by
-- Reilly) later. `as_of` makes a stale balance obvious.
CREATE TABLE IF NOT EXISTS money_balances (
  source      TEXT    NOT NULL,              -- e.g. 'shopify_payments'
  store       TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  currency    TEXT,
  as_of       TEXT    NOT NULL,
  PRIMARY KEY (source, store)
);

-- Throttle for jobs that ride on the 15-minute cron but should run less often.
-- A run is claimed atomically, so two overlapping cron runs can't both run it.
CREATE TABLE IF NOT EXISTS job_runs (
  job         TEXT    PRIMARY KEY,           -- e.g. 'ads.spend', 'payouts', 'refunds'
  last_run_at TEXT    NOT NULL,
  last_result TEXT                           -- short plain-English outcome of the last run
);

CREATE INDEX IF NOT EXISTS idx_refunds_day ON refunds(store, local_day);
