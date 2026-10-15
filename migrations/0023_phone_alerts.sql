-- Urgent phone alerts (go-live, 2026-10-14). Additive only: one new table.
-- No semicolons in comments (the D1 remote splitter breaks on them).
--
-- One row per alerted ITEM (a chargeback, a spend alarm for a store-type-day, a HIGH-risk
-- order, an incident ask, a Store Guard stop). item_key is UNIQUE, so an item can never be
-- alerted twice, even by two overlapping cron runs. The daily cap (6 per New York day) counts
-- the rows of that day that took a slot: claimed, sent, shadow and failed. A capped item is
-- recorded as capped so it is not tried again. The link is NOT stored: an approval link carries
-- a signature and is made fresh at send time from approval_id or hash.
CREATE TABLE IF NOT EXISTS phone_alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key     TEXT    NOT NULL UNIQUE,
  local_day    TEXT    NOT NULL,          -- New York day the alert counts against
  kind         TEXT    NOT NULL,          -- chargeback | spend_alarm | fraud | incident | store_guard
  store        TEXT,
  event_id     INTEGER,                   -- the event that raised it
  title        TEXT    NOT NULL,
  message      TEXT    NOT NULL,          -- the text sent (no names, no emails)
  approval_id  INTEGER,                   -- link to the signed approval page when set
  hash         TEXT,                      -- otherwise a dashboard route, e.g. #/agents/page/risk
  status       TEXT    NOT NULL,          -- claimed | sent | failed | shadow | capped
  attempts     INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  created_at   TEXT    NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_phone_alerts_day ON phone_alerts(local_day, status);
