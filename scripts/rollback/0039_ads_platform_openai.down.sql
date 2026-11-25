-- Rollback of migrations/0039_ads_platform_openai.sql: restores CHECK (platform IN ('google', 'meta')).
-- Run only with approval, after a fresh backup, and only when NO 'openai' rows exist (ChatGPT Ads disconnected and its
-- drafts removed). If any exist, the guard below aborts before anything changes:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=scripts/rollback/0039_ads_platform_openai.down.sql
-- Code older than 0039 works with either schema (it never writes 'openai'), so a code rollback does not need this.

CREATE TABLE rollback_0039_guard (n INTEGER CHECK (n = 0));
INSERT INTO rollback_0039_guard (n) SELECT (SELECT count(*) FROM ad_connections WHERE platform = 'openai') + (SELECT count(*) FROM ad_campaigns WHERE platform = 'openai');

CREATE TABLE ad_connections_down (
  customer     TEXT NOT NULL REFERENCES customers(id),
  platform     TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
  account_id   TEXT,
  account_name TEXT,
  currency     TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL CHECK (status IN ('connected', 'needs_account', 'reconnect_required')),
  connected_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, platform)
);
INSERT INTO ad_connections_down SELECT customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at FROM ad_connections;
DROP TABLE ad_connections;
ALTER TABLE ad_connections_down RENAME TO ad_connections;

CREATE TABLE ad_campaigns_down (
  id                  TEXT PRIMARY KEY,
  customer            TEXT NOT NULL REFERENCES customers(id),
  platform            TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
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
INSERT INTO ad_campaigns_down SELECT id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, approved_by, approved_at, launched_at, last_error, created_at, updated_at FROM ad_campaigns;
CREATE TABLE ad_metrics_daily_down (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns_down(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  date        TEXT NOT NULL,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, date)
);
INSERT INTO ad_metrics_daily_down SELECT campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at FROM ad_metrics_daily;
DROP TABLE ad_metrics_daily;
DROP TABLE ad_campaigns;
ALTER TABLE ad_campaigns_down RENAME TO ad_campaigns;
ALTER TABLE ad_metrics_daily_down RENAME TO ad_metrics_daily;
CREATE INDEX IF NOT EXISTS ad_campaigns_customer ON ad_campaigns (customer, status);
DROP TABLE IF EXISTS ad_platforms; -- the 0039 marker: Business Review then shows 0039 as not applied
DROP TABLE rollback_0039_guard;
