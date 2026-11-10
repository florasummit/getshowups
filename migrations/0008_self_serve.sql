-- Self-serve signup: businesses created from "Get started" (founding plan), their guided-onboarding
-- markers, and the business details collected during onboarding. Existing businesses (PoolThru,
-- invited or admin-created) have no self_signups row and keep their current setup flow.
-- Additive and idempotent. Production requires approval:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0008_self_serve.sql
CREATE TABLE IF NOT EXISTS self_signups (
  customer        TEXT PRIMARY KEY REFERENCES customers(id),
  plan_id         TEXT NOT NULL,          -- plan chosen at signup (plans.id)
  created_at      INTEGER NOT NULL,
  test_checked_at INTEGER,                -- owner checked availability / booking in onboarding
  onboarded_at    INTEGER                 -- owner finished guided onboarding
);

-- Business details shown on the landing page and used for drafts. Public: phone, description,
-- services (with optional price text) and towns served. No personal data about leads.
CREATE TABLE IF NOT EXISTS business_profiles (
  customer    TEXT PRIMARY KEY REFERENCES customers(id),
  phone       TEXT NOT NULL DEFAULT '',
  industry    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  services    TEXT NOT NULL DEFAULT '[]',  -- JSON [{ name, price }]
  cities      TEXT NOT NULL DEFAULT '[]',  -- JSON array of towns/cities served
  updated_at  INTEGER NOT NULL
);
