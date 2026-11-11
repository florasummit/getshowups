-- AI website usage per business per UTC day (server/ai-usage.js). Counts successful AI results only.
-- Additive and idempotent (new table only). Apply BEFORE deploying the code that uses it:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0011_website_ai_usage.sql
CREATE TABLE IF NOT EXISTS website_ai_usage (
  customer TEXT NOT NULL REFERENCES customers(id),
  day      INTEGER NOT NULL,                                        -- floor(epoch ms / 86 400 000), UTC
  kind     TEXT NOT NULL CHECK (kind IN ('generation', 'revision')),
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer, day, kind)
);
