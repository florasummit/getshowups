-- Advertising: business ad profile, owner-approved spending ceilings, ad platform connections,
-- campaigns (validated specs), normalized daily metrics, an audit log of every automated action,
-- generated creatives with cost, AI usage for quotas, lead attribution, and GoHighLevel sync links.
-- Additive and idempotent. Production requires approval:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0006_ads.sql

-- What GetShowUps needs to know to plan ads for a business.
CREATE TABLE IF NOT EXISTS ad_profiles (
  customer            TEXT PRIMARY KEY REFERENCES customers(id),
  website             TEXT NOT NULL DEFAULT '',
  industry            TEXT NOT NULL DEFAULT '',
  services            TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  service_area        TEXT NOT NULL DEFAULT '{}',   -- JSON {zips:[], cities:[], radiusMiles, centerZip}
  exclusions          TEXT NOT NULL DEFAULT '',
  customer_value_cents INTEGER,                     -- typical first-job value the owner states
  objective           TEXT NOT NULL DEFAULT 'leads',
  monthly_budget_cents INTEGER,                     -- what the owner asked for (not an approval)
  approved_claims     TEXT NOT NULL DEFAULT '[]',   -- JSON array: the only claims ads may make
  updated_at          INTEGER NOT NULL
);

-- The owner's explicit spending ceiling. Automation never raises it; only a new owner approval can.
CREATE TABLE IF NOT EXISTS ad_budget_approvals (
  id            TEXT PRIMARY KEY,
  customer      TEXT NOT NULL REFERENCES customers(id),
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents > 0),
  approved_by   TEXT NOT NULL,
  approved_at   INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ad_budget_approvals_customer ON ad_budget_approvals (customer, approved_at);

-- Which ad account a business uses on each platform. Tokens live encrypted in KV, never here.
CREATE TABLE IF NOT EXISTS ad_connections (
  customer     TEXT NOT NULL REFERENCES customers(id),
  platform     TEXT NOT NULL CHECK (platform IN ('google', 'meta')),
  account_id   TEXT,
  account_name TEXT,
  currency     TEXT,
  extra        TEXT NOT NULL DEFAULT '{}',          -- e.g. Meta page id, Google login-customer-id
  status       TEXT NOT NULL CHECK (status IN ('connected', 'needs_account', 'reconnect_required')),
  connected_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, platform)
);

-- One campaign per platform launch. spec is a validated JSON campaign specification.
CREATE TABLE IF NOT EXISTS ad_campaigns (
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
CREATE INDEX IF NOT EXISTS ad_campaigns_customer ON ad_campaigns (customer, status);

-- Normalized daily performance per campaign (both platforms), money in cents of the account currency.
CREATE TABLE IF NOT EXISTS ad_metrics_daily (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  date        TEXT NOT NULL,                        -- YYYY-MM-DD in the account time zone
  spend_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,              -- platform-reported
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, date)
);

-- Every automated or owner action on a campaign, with its reason. id is an idempotency key.
CREATE TABLE IF NOT EXISTS ad_actions (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  campaign_id TEXT,
  actor       TEXT NOT NULL,                         -- 'optimizer' | 'owner:<email>' | 'system'
  kind        TEXT NOT NULL,                         -- e.g. pause, resume, budget_down, alert, launch
  status      TEXT NOT NULL CHECK (status IN ('applied', 'recommended', 'failed', 'skipped')),
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '{}',
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_actions_customer ON ad_actions (customer, at);

-- Generated ad creatives (copy, image, video). Assets live in object storage under storage_key.
CREATE TABLE IF NOT EXISTS ad_creatives (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  campaign_id TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'approved', 'rejected')),
  prompt      TEXT NOT NULL,
  provider_job TEXT,
  storage_key TEXT,
  mime        TEXT,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_creatives_customer ON ad_creatives (customer, created_at);

-- AI spend per business, for hard monthly quotas.
CREATE TABLE IF NOT EXISTS ai_usage (
  id         TEXT PRIMARY KEY,
  customer   TEXT NOT NULL REFERENCES customers(id),
  kind       TEXT NOT NULL,                          -- strategy | image | video
  provider   TEXT NOT NULL,
  cost_cents INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_customer ON ai_usage (customer, at);

-- Where a lead came from (booking page, a Meta lead form, a Google ad click).
CREATE TABLE IF NOT EXISTS lead_attribution (
  lead_id     TEXT PRIMARY KEY REFERENCES leads(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  source      TEXT NOT NULL,                         -- booking_page | meta_lead_form | google_ads
  campaign_id TEXT,
  details     TEXT NOT NULL DEFAULT '{}',            -- utm parameters / platform lead id (no personal data)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_attribution_campaign ON lead_attribution (campaign_id);

-- GoHighLevel record links (one row per synced local record) to keep sync idempotent.
CREATE TABLE IF NOT EXISTS ghl_links (
  customer  TEXT NOT NULL REFERENCES customers(id),
  entity    TEXT NOT NULL CHECK (entity IN ('contact', 'opportunity')),
  local_id  TEXT NOT NULL,                           -- our lead id
  ghl_id    TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (customer, entity, local_id)
);

-- Meta lead-form webhooks are retried; one row per Meta leadgen id makes ingestion idempotent.
CREATE TABLE IF NOT EXISTS meta_lead_events (
  leadgen_id  TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  lead_id     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('received', 'created', 'failed', 'ignored')),
  received_at INTEGER NOT NULL
);
