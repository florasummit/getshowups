-- Stored AI website generations (one model request each). Applying one only changes the private draft;
-- the live site changes only on an explicit publish. Usage and cost are recorded per generation.
-- Additive and idempotent. Production requires approval:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0010_website_generations.sql
CREATE TABLE IF NOT EXISTS website_generations (
  id            TEXT PRIMARY KEY,
  customer      TEXT NOT NULL REFERENCES customers(id),
  content       TEXT NOT NULL,              -- validated website content (server/website.js)
  source        TEXT NOT NULL CHECK (source IN ('ai', 'template')),
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_micros   INTEGER NOT NULL DEFAULT 0, -- USD millionths
  latency_ms    INTEGER,
  rejected      TEXT,                       -- JSON list of fields replaced by template text (claims/number checks)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS website_generations_customer ON website_generations (customer, created_at);
