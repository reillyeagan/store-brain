-- Store Brain ledger, v12: Media (Google Ads) — WATCH ONLY.
-- Reilly, 2026-10-11: "the media section is just watching more than anything ... eventually I
-- want to drop him as the mediabuyer and just use the store brain, but we need more data".
-- So these tables only hold what Google Ads REPORTS (read-only GAQL) plus what the brain
-- would have done. Nothing here is ever sent back to Google Ads.
-- Additive only: new tables, nothing existing is renamed, dropped or rewritten.

-- Campaign results per day, in the AD ACCOUNT's timezone (how Google reports segments.date).
-- The last 14 days are re-pulled and restated in place; older days are kept, because the
-- history is the data Reilly needs before he can replace Guy.
CREATE TABLE IF NOT EXISTS media_campaign_days (
  store         TEXT    NOT NULL,
  day           TEXT    NOT NULL,            -- YYYY-MM-DD, account timezone
  campaign_id   TEXT    NOT NULL,
  campaign_name TEXT,
  channel       TEXT,                        -- SEARCH | SHOPPING | PERFORMANCE_MAX ...
  status        TEXT,                        -- ENABLED | PAUSED | REMOVED (as of the pull)
  cost          REAL    NOT NULL,            -- account currency (cost_micros / 1e6)
  clicks        INTEGER NOT NULL,
  impressions   INTEGER NOT NULL,
  conversions   REAL    NOT NULL,            -- Google's claim, not Shopify's orders
  conv_value    REAL    NOT NULL,            -- Google's claim, not Shopify's revenue
  currency      TEXT,
  fetched_at    TEXT    NOT NULL,
  PRIMARY KEY (store, day, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_media_campaign_days_day ON media_campaign_days(store, day);

-- Search terms over the last pull window, one row per (term, campaign). Replaced per pull.
CREATE TABLE IF NOT EXISTS media_search_terms (
  store         TEXT    NOT NULL,
  term          TEXT    NOT NULL,
  campaign_id   TEXT    NOT NULL,
  campaign_name TEXT,
  term_status   TEXT,                        -- ADDED | EXCLUDED | NONE ... (Google's)
  window_from   TEXT    NOT NULL,
  window_to     TEXT    NOT NULL,
  cost          REAL    NOT NULL,
  clicks        INTEGER NOT NULL,
  impressions   INTEGER NOT NULL,
  conversions   REAL    NOT NULL,
  conv_value    REAL    NOT NULL,
  fetched_at    TEXT    NOT NULL,
  PRIMARY KEY (store, term, campaign_id)
);

-- Products in Shopping / Performance Max over the last pull window. Replaced per pull.
CREATE TABLE IF NOT EXISTS media_products (
  store         TEXT    NOT NULL,
  item_id       TEXT    NOT NULL,            -- segments.product_item_id (e.g. shopify_us_<product>_<variant>)
  title         TEXT,
  product_id    TEXT,                        -- Shopify product id parsed from item_id (null if not parseable)
  window_from   TEXT    NOT NULL,
  window_to     TEXT    NOT NULL,
  cost          REAL    NOT NULL,
  clicks        INTEGER NOT NULL,
  impressions   INTEGER NOT NULL,
  conversions   REAL    NOT NULL,
  conv_value    REAL    NOT NULL,
  fetched_at    TEXT    NOT NULL,
  PRIMARY KEY (store, item_id)
);

-- Keyword impressions per week (proxy for seasonal demand; true search volume needs Keyword Planner).
CREATE TABLE IF NOT EXISTS media_keyword_weeks (
  store         TEXT    NOT NULL,
  week          TEXT    NOT NULL,            -- Monday, YYYY-MM-DD (segments.week)
  keyword       TEXT    NOT NULL,
  impressions   INTEGER NOT NULL,
  clicks        INTEGER NOT NULL,
  cost          REAL    NOT NULL,
  fetched_at    TEXT    NOT NULL,
  PRIMARY KEY (store, week, keyword)
);

-- Google Ads change history (what Guy, Reilly or Google changed). Deduped by Google's own
-- change_event resource name; `logged` = an event has been written for it.
CREATE TABLE IF NOT EXISTS media_changes (
  store         TEXT    NOT NULL,
  change_id     TEXT    NOT NULL,            -- change_event.resource_name
  changed_at    TEXT    NOT NULL,            -- change_event.change_date_time (account time, as given)
  user_email    TEXT,
  client_type   TEXT,
  resource_type TEXT,                        -- CAMPAIGN_BUDGET | CAMPAIGN | AD_GROUP_CRITERION ...
  operation     TEXT,                        -- CREATE | UPDATE | REMOVE
  campaign_id   TEXT,
  summary       TEXT    NOT NULL,
  data          TEXT,                        -- JSON: changed fields old → new
  effect        TEXT,                        -- JSON: campaign 7 days before vs 7 days after (filled later)
  logged        INTEGER NOT NULL DEFAULT 0,
  seen_at       TEXT    NOT NULL,
  PRIMARY KEY (store, change_id)
);
CREATE INDEX IF NOT EXISTS idx_media_changes_at ON media_changes(store, changed_at);

-- What the brain found: flags that stay open while the condition holds.
-- One row per (store, agent, key); last_seen moves while it holds; cleared_at when it stops.
CREATE TABLE IF NOT EXISTS media_findings (
  store         TEXT    NOT NULL,
  agent         TEXT    NOT NULL,            -- media.performance | media.products | media.conversions | media.season
  key           TEXT    NOT NULL,            -- e.g. "campaign:123", "item:shopify_us_1_2", "tracking_broken"
  severity      TEXT    NOT NULL,            -- info | warn | bad
  summary       TEXT    NOT NULL,
  data          TEXT,
  first_seen    TEXT    NOT NULL,
  last_seen     TEXT    NOT NULL,
  cleared_at    TEXT,
  PRIMARY KEY (store, agent, key)
);

-- What the brain WOULD do (shadow): negatives, budget moves. Never applied.
-- Budget proposals carry their day in the key so each day is a separate call that can be
-- scored later (the track record Reilly needs before replacing Guy).
CREATE TABLE IF NOT EXISTS media_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store         TEXT    NOT NULL,
  agent         TEXT    NOT NULL,            -- media.search_terms | media.budget
  key           TEXT    NOT NULL,
  kind          TEXT    NOT NULL,            -- negative_keyword | budget_cut | budget_raise
  title         TEXT    NOT NULL,
  detail        TEXT,                        -- JSON: numbers and reasons (computed by code)
  status        TEXT    NOT NULL DEFAULT 'open', -- open | stale (condition no longer holds) | scored (budget call judged)
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  outcome       TEXT,                        -- right | wrong | unclear (scored later)
  outcome_data  TEXT,
  scored_at     TEXT,
  UNIQUE (store, agent, key)
);

-- Claude-written words (performance read, budget rationale), at most one per store/agent/day.
-- The primary key IS the daily cap.
CREATE TABLE IF NOT EXISTS media_reads (
  store         TEXT    NOT NULL,            -- store id, or 'all'
  agent         TEXT    NOT NULL,
  day           TEXT    NOT NULL,
  status        TEXT    NOT NULL,            -- pending | done | skipped | failed
  text          TEXT,
  note          TEXT,
  at            TEXT    NOT NULL,
  PRIMARY KEY (store, agent, day)
);
