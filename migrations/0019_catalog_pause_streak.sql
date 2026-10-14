-- Catalog reader: how many runs in a row a pass paused for Shopify's rate limit without
-- reading a single product. Three or more puts one line a day in the Event Log, so a store
-- throttled on every run can't stall silently. Additive only, no semicolons in comments
-- (the D1 remote splitter breaks on them).
ALTER TABLE cat_sync ADD COLUMN pause_streak INTEGER NOT NULL DEFAULT 0;
