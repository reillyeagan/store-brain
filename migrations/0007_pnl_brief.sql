-- Store Brain ledger, v7: daily P&L ledger detail + the 8:00 morning brief.
-- Additive only: new columns on pnl_days (all nullable or with a safe default) and one
-- new table. Nothing existing is renamed, dropped or rewritten.

-- pnl_days already holds revenue, cogs, cogs_estimated_share, ads, services, fees, refunds,
-- chargebacks, profit, real_profit, orders, clicks, sessions, status, sources, updated_at.
-- `services` = Guy's fee (the only service cost wired so far); kept in its own column too.
ALTER TABLE pnl_days ADD COLUMN refunds_success REAL;     -- refunds whose transactions settled (SUCCESS)
ALTER TABLE pnl_days ADD COLUMN refunds_pending REAL;     -- refunds still PENDING (counted in `refunds`, rule 7)
ALTER TABLE pnl_days ADD COLUMN guy_fee REAL;             -- media buyer's fee (rate x ad spend, from his start date)
ALTER TABLE pnl_days ADD COLUMN cogs_est REAL;            -- COGS estimated by the brain (KFB bills not wired yet)
ALTER TABLE pnl_days ADD COLUMN cogs_actual REAL;         -- COGS from KFB bills (null until the COGS Matcher exists)
ALTER TABLE pnl_days ADD COLUMN cogs_source TEXT;         -- estimate | actual | mixed | null (no orders)
ALTER TABLE pnl_days ADD COLUMN cogs_basis TEXT;          -- JSON: how the estimate was made (rate, its source, per-product count)
ALTER TABLE pnl_days ADD COLUMN profit_partial REAL;      -- profit leaving out the costs that are not wired (see notes.missing)
ALTER TABLE pnl_days ADD COLUMN margin REAL;              -- (revenue - COGS) / revenue
ALTER TABLE pnl_days ADD COLUMN roas REAL;                -- revenue / ad spend
ALTER TABLE pnl_days ADD COLUMN breakeven_roas REAL;      -- 1 / [margin x (1 - 0.119) - 0.0334]
ALTER TABLE pnl_days ADD COLUMN complete INTEGER NOT NULL DEFAULT 0; -- 1 = closed day, every input fresh
ALTER TABLE pnl_days ADD COLUMN freshness TEXT;           -- JSON: state of each input feed when computed
ALTER TABLE pnl_days ADD COLUMN notes TEXT;               -- JSON: flags (assumed rate, excluded orders, missing inputs...)
ALTER TABLE pnl_days ADD COLUMN computed_at TEXT;         -- when this row was last recomputed
CREATE INDEX IF NOT EXISTS idx_pnl_days_day ON pnl_days(day);

-- One morning brief per Eastern day. The row itself is the claim: UNIQUE(day) means two
-- overlapping cron runs can't both compose (same idea as kfb_runs).
CREATE TABLE IF NOT EXISTS briefs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL UNIQUE,      -- Eastern day the brief is FOR (composed that morning)
  created_at    TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'composing', -- composing | ready
  mode          TEXT    NOT NULL,             -- shadow | live (live = also sent to the phone)
  body_md       TEXT,                         -- the brief (small markdown subset)
  data          TEXT,                         -- JSON: every number the brief was given
  model         TEXT,                         -- Claude model id, or null for the plain code-built brief
  composer      TEXT,                         -- ai | plain
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  ai_error      TEXT,                         -- why the AI version wasn't used (never contains a key)
  unverified    TEXT,                         -- JSON: numbers in the AI text that the data doesn't contain
  phone         TEXT                          -- JSON: phone notification result (live mode only)
);
