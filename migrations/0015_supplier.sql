-- Supplier Relations (dept "sup"): input tables the KFB Morning Session (or a manual
-- import) fills, and the ledger of what each supplier agent proposed. Additive only.
--
-- KFB has no API and a CAPTCHA login, so the brain cannot read KFB yet. Every table marked
-- INPUT below stays empty until the KFB Morning Session service (or an import) fills it;
-- the agents report "waiting on KFB session" until then, never zero.

-- INPUT: one row per KFB quotation status seen. Matched to the store by product HANDLE
-- (spec: "match by store link handle, never title or KFB SKU").
CREATE TABLE IF NOT EXISTS kfb_quotes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,              -- hc | aub | mar ...
  product_handle TEXT    NOT NULL,              -- from the store link KFB holds
  variant_id     TEXT    NOT NULL DEFAULT '',   -- optional: a quote for one variant only ('' = whole product; '' not NULL so UNIQUE works)
  sku            TEXT,                          -- KFB/Shopify SKU, information only (never used to match)
  kfb_quote_id   TEXT,                          -- KFB's own id, if known
  status_code    INTEGER,                       -- 10 to-quote · 25 awaiting Reilly · 26 denied · 30 quoted · 40 unknown
  status         TEXT    NOT NULL,              -- pending | awaiting_reilly | denied | quoted | unknown
  cost           REAL,                          -- quoted unit cost (null unless quoted)
  currency       TEXT,                          -- EUR (KFB bills in EUR) | USD
  quoted_at      TEXT    NOT NULL,              -- when KFB quoted / changed status
  remark         TEXT,                          -- KFB order_remark (denial reason, "only similar ones" ...)
  similar        INTEGER NOT NULL DEFAULT 0,    -- 1 = quoted with an "only similar ones" remark
  source         TEXT    NOT NULL,              -- kfb_session | manual | sheet
  imported_at    TEXT    NOT NULL,
  processed_at   TEXT,                          -- when Quote Desk turned it into a plan (or superseded it)
  batch_id       INTEGER,                       -- supplier_batches.id it went into
  outcome        TEXT,                          -- planned | superseded | unmatched | no_change | ...
  UNIQUE (store, product_handle, variant_id, status, quoted_at)
);
CREATE INDEX IF NOT EXISTS idx_kfb_quotes_open ON kfb_quotes(store, processed_at);
CREATE INDEX IF NOT EXISTS idx_kfb_quotes_handle ON kfb_quotes(store, product_handle);

-- One batch per store per Quote Desk run that found work: ONE approval ("Reprice 12 · draft 3").
CREATE TABLE IF NOT EXISTS supplier_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  prices_read_at TEXT    NOT NULL,              -- when Shopify prices were read (executor must re-read)
  approval_id    INTEGER,                       -- approvals.id (null when nothing needed approval)
  reprice_count  INTEGER NOT NULL DEFAULT 0,
  draft_count    INTEGER NOT NULL DEFAULT 0,
  waiver_count   INTEGER NOT NULL DEFAULT 0,
  fx_rate        REAL,                          -- EUR→USD used for the costs
  fx_source      TEXT,
  status         TEXT    NOT NULL               -- awaiting_approval | nothing_to_approve
);
CREATE INDEX IF NOT EXISTS idx_supplier_batches_store ON supplier_batches(store, status);

-- One row per product in a batch: what the brain proposes, old → new. Never applied here.
CREATE TABLE IF NOT EXISTS supplier_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL,
  store          TEXT    NOT NULL,
  kind           TEXT    NOT NULL,              -- reprice | draft | no_change | held | unmatched | not_active | already_off
  quote_id       INTEGER,
  product_id     TEXT,
  product_handle TEXT    NOT NULL,
  title          TEXT,
  product_type   TEXT,
  shop_status    TEXT,                          -- ACTIVE | DRAFT | ARCHIVED (as read)
  cost           REAL,                          -- quoted cost, original currency
  currency       TEXT,
  cost_usd       REAL,
  old_price      REAL,                          -- first variant's, for the list; all variants in `variants`
  new_price      REAL,
  old_compare_at REAL,
  new_compare_at REAL,
  cogs_old       REAL,
  cogs_new       REAL,
  waiver_price   REAL,                          -- price needed to reach band if the ceiling stopped it
  variants       TEXT,                          -- JSON [{id, old_price, new_price, old_compare_at, new_compare_at, tier}]
  reason         TEXT,                          -- one plain line (KFB remark for drafts)
  notes          TEXT,                          -- JSON flags
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_plans_batch ON supplier_plans(batch_id);
CREATE INDEX IF NOT EXISTS idx_supplier_plans_handle ON supplier_plans(store, product_handle);

-- Standing price holds (Reilly's words). A held product is not re-proposed unless its cost changes.
CREATE TABLE IF NOT EXISTS supplier_price_holds (
  store          TEXT    NOT NULL,
  product_handle TEXT    NOT NULL,
  held_price     REAL    NOT NULL,
  cost_at_hold   REAL,                          -- cost (USD) when the hold was set; a different cost re-opens it
  words          TEXT,                          -- Reilly's words, verbatim
  at             TEXT    NOT NULL,
  PRIMARY KEY (store, product_handle)
);

-- INPUT: KFB "only similar ones" offers. context quote = a quotation; order = an order line.
CREATE TABLE IF NOT EXISTS kfb_similar_offers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  context        TEXT    NOT NULL,              -- quote | order
  product_handle TEXT    NOT NULL DEFAULT '',
  order_name     TEXT    NOT NULL DEFAULT '',
  remark         TEXT,
  photo_url      TEXT,
  cost           REAL,
  currency       TEXT,
  received_at    TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  verdict        TEXT,                          -- accepted | ask_reilly | (null = not judged yet)
  verdict_reason TEXT,
  judged_at      TEXT,
  UNIQUE (store, context, product_handle, order_name, received_at)
);

-- Size Checker: one recommendation per order line (ordered size → size to ship).
CREATE TABLE IF NOT EXISTS size_recommendations (
  store          TEXT    NOT NULL,
  line_id        TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  order_name     TEXT,
  product_id     TEXT,
  product_handle TEXT,
  title          TEXT,
  ordered_size   TEXT,
  send_size      TEXT,                          -- null when no recommendation (no chart, no fit ...)
  verdict        TEXT    NOT NULL,              -- as_ordered | size_up | runs_large | no_chart | no_reference | no_fit | complaints_only
  reason         TEXT    NOT NULL,              -- the reasoning, incl. any measurement conflict
  conflict       INTEGER NOT NULL DEFAULT 0,
  chart_verified INTEGER,                       -- 1 checked chart · 0 read by the brain, unchecked · null no chart
  complaints     INTEGER NOT NULL DEFAULT 0,
  checked_at     TEXT    NOT NULL,
  PRIMARY KEY (store, line_id)
);
CREATE INDEX IF NOT EXISTS idx_size_recs_verdict ON size_recommendations(verdict, checked_at);

-- What Relay may include later in the KFB message: "#1234 ordered M → please ship L".
CREATE TABLE IF NOT EXISTS kfb_size_asks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  line_id        TEXT    NOT NULL,
  order_name     TEXT,
  title          TEXT,
  ordered_size   TEXT    NOT NULL,
  send_size      TEXT    NOT NULL,
  why            TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending | included (Relay put it in a message) | cancelled
  created_at     TEXT    NOT NULL,
  UNIQUE (store, line_id)
);

-- Supply Pre-flight flags on order lines likely to fail at KFB.
CREATE TABLE IF NOT EXISTS supply_flags (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  order_id       TEXT,
  order_name     TEXT,
  line_id        TEXT    NOT NULL,
  product_handle TEXT,
  title          TEXT,
  kind           TEXT    NOT NULL,              -- denied | drafted | size_complaints | no_fit | no_quote
  detail         TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  UNIQUE (store, line_id, kind)
);

-- INPUT + ledger: money KFB owes back (credits, never returns: "i never return things to KFB").
CREATE TABLE IF NOT EXISTS kfb_credits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT    NOT NULL,
  kind           TEXT    NOT NULL,              -- cancelled_billed | defective | wrong_item | missing_item | other
  order_name     TEXT,
  order_id       TEXT,
  amount         REAL,                          -- null = amount not known yet (never 0 as a guess)
  currency       TEXT,
  opened_at      TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open', -- open | claimed | credited | written_off
  claimed_at     TEXT,
  credited_at    TEXT,
  credit_ref     TEXT,                          -- the bill the credit appeared on
  note           TEXT,
  source         TEXT    NOT NULL,
  last_flagged_at TEXT,                         -- aging flag throttle (once a week per credit)
  UNIQUE (store, kind, order_name)
);

-- INPUT: KFB bills (the KFB session reads them; Reilly pays them).
-- Bills to pay each morning (amount, paid or not). Named supplier_bills: kfb_bills (0016)
-- holds the line-level bill detail the COGS Matcher uses.
CREATE TABLE IF NOT EXISTS supplier_bills (
  bill_id        TEXT    PRIMARY KEY,
  store          TEXT,
  amount         REAL    NOT NULL,
  currency       TEXT    NOT NULL,
  billed_at      TEXT    NOT NULL,
  paid_at        TEXT,
  status         TEXT    NOT NULL DEFAULT 'unpaid', -- unpaid | paid
  source         TEXT    NOT NULL,
  imported_at    TEXT    NOT NULL
);

-- Sourcing Scout: categories that are failing at KFB (flag only; Reilly 2026-10-11 Q7).
CREATE TABLE IF NOT EXISTS sourcing_flags (
  store          TEXT    NOT NULL,
  category       TEXT    NOT NULL,
  signal         TEXT    NOT NULL,              -- denials | over_ceiling
  count          INTEGER NOT NULL,
  examples       TEXT,                          -- JSON handles
  first_at       TEXT    NOT NULL,
  last_at        TEXT    NOT NULL,
  PRIMARY KEY (store, category, signal)
);

-- Supplier Digest: one per Eastern day, for the 8:00 brief.
CREATE TABLE IF NOT EXISTS supplier_digests (
  local_day      TEXT    PRIMARY KEY,
  created_at     TEXT    NOT NULL,
  body           TEXT    NOT NULL,
  data           TEXT                           -- JSON numbers (null = not wired)
);
