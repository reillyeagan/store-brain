-- Agent pages read an agent's events as actor OR target; index target so that
-- doesn't scan the whole events table (review finding, 2026-10-11).
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target, id);
