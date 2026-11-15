-- Bring-your-own AI API key per business (server/ai-credentials.js): Claude or OpenAI, for website generation.
-- `sealed` is AES-GCM ciphertext under a key derived from TOKEN_ENCRYPTION_KEY and bound to (customer, provider);
-- the raw key is never stored or returned. `hint` = last 4 characters for display. Additive, idempotent.
CREATE TABLE IF NOT EXISTS ai_credentials (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  provider     TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  sealed       TEXT NOT NULL,
  hint         TEXT NOT NULL,
  model        TEXT,            -- chosen model from the allowlist (server/ai-credentials.js MODELS); NULL = provider default
  status       TEXT NOT NULL CHECK (status IN ('ok', 'invalid')),
  validated_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
