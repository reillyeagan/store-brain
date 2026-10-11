-- Which Google account a "Connect" click was for: 'main' (Reilly's account) or a store id
-- (that store's own customer-service Gmail). Additive only.
ALTER TABLE oauth_states ADD COLUMN target TEXT;
