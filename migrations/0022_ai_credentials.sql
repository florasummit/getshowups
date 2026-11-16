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
  max_output   INTEGER,         -- the model's own output-token ceiling when lower than ours (NULL = ours applies)
  retires_at   TEXT,
  source       TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
-- Prices verified 2026-11-15 (Anthropic: claude-api model table; OpenAI: developers.openai.com/api/docs/pricing, standard).
-- max_output: the model's own output ceiling where it is below ours (GPT-4o and GPT-4o mini: 16,384 tokens).
-- status 'tested': verified live end to end with a real account (AI designer: first design + conversational revision,
-- validated output, 2026-11-15): claude-sonnet-5-5 and gpt-6.1-sol. Auto chooses only tested models, so without one a
-- new owner's first request would be refused (no_tested_model). Everything else stays 'supported' (manual choice only).
INSERT OR IGNORE INTO ai_model_registry (provider, model, status, quality, input_per_m, output_per_m, max_output, source, updated_at) VALUES
  ('anthropic', 'claude-opus-5-5', 'supported', 3, 4.00, 20.00, NULL, 'anthropic pricing 2026-11-15', 0),
  ('anthropic', 'claude-sonnet-5-5', 'tested', 2, 2.00, 10.00, NULL, 'anthropic pricing 2026-11-15', 0),
  ('anthropic', 'claude-haiku-5-5', 'supported', 1, 0.10, 0.50, NULL, 'anthropic pricing 2026-11-15', 0),
  ('openai', 'gpt-4o-mini', 'supported', 1, 0.15, 0.60, 16384, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4o', 'supported', 2, 2.50, 10.00, 16384, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4.1-mini', 'supported', 1, 0.40, 1.60, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-4.1', 'supported', 2, 2.00, 8.00, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5-nano', 'supported', 1, 0.05, 0.40, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5-mini', 'supported', 2, 0.25, 2.00, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5', 'supported', 3, 1.25, 10.00, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5.4-mini', 'supported', 2, 0.75, 4.50, NULL, 'openai pricing 2026-11-15', 0),
  ('openai', 'gpt-5.4-nano', 'supported', 1, 0.20, 1.25, NULL, 'openai pricing 2026-11-15', 0),
  -- OpenAI's "balance intelligence and cost" model (developers.openai.com/api/docs/models); short-context price (<272K).
  ('openai', 'gpt-6.1-sol', 'tested', 2, 2.00, 10.00, NULL, 'openai pricing 2026-11-15 (short context)', 0);

-- Every request made with a business's own key. Before sending, a row RESERVES the request's worst-case cost in one
-- atomic statement that also checks the monthly limit (so concurrent requests can't both slip under it); afterwards it is
-- settled to the cost of the tokens the provider reported. A request with no usage report keeps its worst case (it may
-- still have been billed). Estimates from published prices, not the provider's invoice. Tokens only: no prompts/output.
CREATE TABLE IF NOT EXISTS ai_key_usage (
  id            TEXT PRIMARY KEY,
  customer      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown')),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros   INTEGER NOT NULL DEFAULT 0, -- USD millionths: worst case while reserved/unknown, estimate once settled
  ok            INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_key_usage_customer ON ai_key_usage (customer, created_at);
