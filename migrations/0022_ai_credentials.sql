-- Bring-your-own AI API key per business (server/ai-credentials.js): Claude or OpenAI, for website generation.
-- `sealed` is AES-GCM ciphertext under a key derived from TOKEN_ENCRYPTION_KEY and bound to (customer, provider);
-- the raw key is never stored or returned. `hint` = last 4 characters for display. Additive, idempotent.
CREATE TABLE IF NOT EXISTS ai_credentials (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  provider     TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  sealed       TEXT NOT NULL,
  hint         TEXT NOT NULL,
  model        TEXT,            -- 'auto' or a model id from the discovered catalog (server/ai-models.js)
  auto_model   TEXT,            -- what Auto resolved to last (never moved to a more expensive model automatically)
  catalog      TEXT,            -- JSON: models discovered with this key (refreshed when older than a day)
  catalog_at   INTEGER,
  monthly_budget_cents INTEGER, -- owner's monthly limit for AI website work on this key (hard stop)
  status       TEXT NOT NULL CHECK (status IN ('ok', 'invalid')),
  validated_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Models GetShowUps supports, editable without a deployment (platform admin, audited): price per million tokens
-- (standard tier, from the provider's pricing page), a quality rank for Auto, and whether it's been TESTED end to end.
-- Auto picks only 'tested' models; 'supported' ones can be chosen by hand; anything not here is shown but not selectable.
CREATE TABLE IF NOT EXISTS ai_model_registry (
  provider     TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  model        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('tested', 'supported', 'blocked')),
  quality      INTEGER NOT NULL DEFAULT 1,
  input_per_m  REAL NOT NULL,
  output_per_m REAL NOT NULL,
  retires_at   TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
-- Prices verified 2026-11-15 (Anthropic: claude-api model table; OpenAI: developers.openai.com/api/docs/pricing, standard).
INSERT OR IGNORE INTO ai_model_registry (provider, model, status, quality, input_per_m, output_per_m, source, updated_at) VALUES
  ('anthropic', 'claude-opus-5-5', 'supported', 3, 4.00, 20.00, 'anthropic pricing 2026-11-15', 0),
  ('anthropic', 'claude-sonnet-5-5', 'supported', 2, 2.00, 10.00, 'anthropic pricing 2026-11-15', 0),
  ('anthropic', 'claude-haiku-5-5', 'supported', 1, 0.10, 0.50, 'anthropic pricing 2026-11-15', 0),
  ('openai', 'gpt-4o-mini', 'supported', 1, 0.15, 0.60, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4o', 'supported', 2, 2.50, 10.00, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4.1-mini', 'supported', 1, 0.40, 1.60, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4.1', 'supported', 2, 2.00, 8.00, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5-nano', 'supported', 1, 0.05, 0.40, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5-mini', 'supported', 2, 0.25, 2.00, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5', 'supported', 3, 1.25, 10.00, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5.4-mini', 'supported', 2, 0.75, 4.50, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5.4-nano', 'supported', 1, 0.20, 1.25, 'openai pricing 2026-11-15', 0);
