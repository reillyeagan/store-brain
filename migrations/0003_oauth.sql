-- Google connection (Gmail, Google Ads, Merchant Center, Sheets).
-- The refresh token is stored ENCRYPTED (AES-GCM). The key is derived inside the
-- worker from a Cloudflare secret, so a copy of this database alone can't use it.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider    TEXT    NOT NULL,          -- 'google'
  account     TEXT    NOT NULL,          -- the Google account that consented
  scopes      TEXT    NOT NULL,          -- space-separated scopes Google actually granted
  enc_token   TEXT    NOT NULL,          -- base64 AES-GCM ciphertext of the refresh token
  iv          TEXT    NOT NULL,          -- base64 nonce
  created_at  TEXT    NOT NULL,
  verified_at TEXT,                      -- last time a real API call with it succeeded
  PRIMARY KEY (provider)
);

-- One-time "Connect Google" attempts, so a consent link can be used once only.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  used_at    TEXT
);
