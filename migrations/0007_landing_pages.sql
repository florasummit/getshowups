-- Business landing pages generated from a reusable template. One per business. A page is public only
-- while published = 1 AND the business is bookable (calendar connected, hours saved, active).
-- Additive and idempotent. Production requires approval:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0007_landing_pages.sql
CREATE TABLE IF NOT EXISTS landing_pages (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  headline     TEXT NOT NULL,
  intro        TEXT NOT NULL,
  services     TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  area         TEXT NOT NULL DEFAULT '',    -- plain-language service area
  highlights   TEXT NOT NULL DEFAULT '[]',  -- JSON array: owner-confirmed facts only (claims filter applies)
  published    INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  published_at INTEGER,
  updated_at   INTEGER NOT NULL
);
