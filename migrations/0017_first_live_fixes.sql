-- Fixes from the first live runs (2026-10-14). Additive only: new nullable columns.
-- Nothing existing is renamed, dropped or rewritten.

-- Catalog reader: how big the pass in progress is (Shopify productsCount for the same filter,
-- for the time-to-complete estimate) and the last time it paused for Shopify's rate limit.
-- A pause is not an error, so it gets its own columns instead of last_error.
ALTER TABLE cat_sync ADD COLUMN pass_total INTEGER;           -- products the pass will read (null = not known yet)
ALTER TABLE cat_sync ADD COLUMN pass_total_precision TEXT;    -- EXACT | AT_LEAST (Shopify's own word)
ALTER TABLE cat_sync ADD COLUMN last_pause_reason TEXT;
ALTER TABLE cat_sync ADD COLUMN last_pause_at TEXT;

-- Chargeback evidence: a draft written by CODE from this order's own facts, so a draft exists
-- even when the AI rebuttal can't be written; how many AI attempts were made (a failed attempt
-- is retried a few times, spaced out, instead of never); and, when no draft can be built at
-- all, exactly what is missing.
ALTER TABLE risk_evidence_packs ADD COLUMN code_draft TEXT;
ALTER TABLE risk_evidence_packs ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE risk_evidence_packs ADD COLUMN blocked TEXT;
