-- ChatGPT Ads (OpenAI Ads API) as a third ad platform: allow platform 'openai' in ad_connections and ad_campaigns.
-- SQLite cannot change a CHECK constraint in place, so this is a TABLE REBUILD, the one reviewed exception to
-- "additive only" (test/migration-0039.test.js proves it keeps every row, column, index and foreign key, and that it
-- is safe to run twice). Every column is copied by name; nothing is transformed or dropped.
--
-- Foreign keys stay enforced throughout: ad_metrics_daily is the only table that references ad_campaigns, so it is
-- rebuilt pointing at the new table first; the old tables then have no dependants and are dropped; the RENAME of the
-- new table rewrites ad_metrics_daily's reference to the final name (SQLite ≥ 3.26, legacy_alter_table off: D1).
--
-- Production (approval required, in this order):
--   1. Backup:   npx wrangler d1 export getshowups-onboarding --remote --output ~/getshowups-backups/prod-<UTC>-pre-0039.sql
--   2. Counts:   SELECT (SELECT count(*) FROM ad_connections), (SELECT count(*) FROM ad_campaigns), (SELECT count(*) FROM ad_metrics_daily)
--   3. Apply:    npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0039_ads_platform_openai.sql
--   4. Verify:   the same counts; PRAGMA foreign_key_check (no rows); SELECT sql FROM sqlite_master WHERE name = 'ad_campaigns'
-- Rollback: scripts/rollback/0039_ads_platform_openai.down.sql (refuses while any 'openai' row exists).

-- The working tables (*_0039) are created with a plain CREATE TABLE on purpose: they are renamed away, so they must not
-- be listed as this migration's tables (scripts/build-info.mjs reads "CREATE TABLE IF NOT EXISTS"). The marker below is
-- what Business Review checks to know 0039 is applied: the platforms ad_connections and ad_campaigns accept.
CREATE TABLE IF NOT EXISTS ad_platforms (
  platform TEXT PRIMARY KEY CHECK (platform IN ('google', 'meta', 'openai'))
);
INSERT OR IGNORE INTO ad_platforms (platform) VALUES ('google'), ('meta'), ('openai');

-- 1. ad_connections (no table references it).
CREATE TABLE ad_connections_0039 (
  customer     TEXT NOT NULL REFERENCES customers(id),
  platform     TEXT NOT NULL CHECK (platform IN ('google', 'meta', 'openai')),
  account_id   TEXT,
  account_name TEXT,
  currency     TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL CHECK (status IN ('connected', 'needs_account', 'reconnect_required')),
  connected_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, platform)
);
INSERT OR IGNORE INTO ad_connections_0039 (customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at)
  SELECT customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at FROM ad_connections;
DROP TABLE ad_connections;
ALTER TABLE ad_connections_0039 RENAME TO ad_connections;

-- 2. ad_campaigns and its one dependant, ad_metrics_daily.
CREATE TABLE ad_campaigns_0039 (
  id                  TEXT PRIMARY KEY,
  customer            TEXT NOT NULL REFERENCES customers(id),
  platform            TEXT NOT NULL CHECK (platform IN ('google', 'meta', 'openai')),
  status              TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'launching', 'paused', 'active', 'error', 'removed')),
  spec                TEXT NOT NULL,
  daily_budget_cents  INTEGER NOT NULL CHECK (daily_budget_cents > 0),
  platform_campaign_id TEXT,
  platform_ids        TEXT NOT NULL DEFAULT '{}',
  approved_by         TEXT,
  approved_at         INTEGER,
  launched_at         INTEGER,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
INSERT OR IGNORE INTO ad_campaigns_0039 (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, approved_by, approved_at, launched_at, last_error, created_at, updated_at)
  SELECT id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, approved_by, approved_at, launched_at, last_error, created_at, updated_at FROM ad_campaigns;

CREATE TABLE ad_metrics_daily_0039 (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns_0039(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  date        TEXT NOT NULL,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, date)
);
INSERT OR IGNORE INTO ad_metrics_daily_0039 (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at)
  SELECT campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at FROM ad_metrics_daily;

DROP TABLE ad_metrics_daily;
DROP TABLE ad_campaigns;
ALTER TABLE ad_campaigns_0039 RENAME TO ad_campaigns;
ALTER TABLE ad_metrics_daily_0039 RENAME TO ad_metrics_daily;
CREATE INDEX IF NOT EXISTS ad_campaigns_customer ON ad_campaigns (customer, status);
