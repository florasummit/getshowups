-- Google customer acquisition engine (docs/GOOGLE_ACQUISITION.md). Additive and idempotent; no personal data.
-- Until this migration is applied every feature below stays hidden and reports "not available" (fail-soft).
--
-- ad_imported_campaigns: campaigns that already exist in a business's connected Google Ads account and were NOT
--   created by GetShowUps (those live in ad_campaigns). Read from Google, kept read-only; `settings` is a snapshot of
--   what Google reported (targeting counts, keywords, ad text, final URLs, bidding, goals), never contact details.
--   status/serving_status are Google's own words. A campaign Google no longer lists becomes status 'REMOVED'.
-- ad_imported_metrics_daily: Google-reported daily spend/clicks/impressions/conversions per imported campaign.
-- ad_import_state: when a business's account was last read and what happened (one row per business).
-- lsa_leads: Google Local Services leads (local_services_lead): type, status, whether charged, credit state, category
--   and Google's creation time. Never the consumer's contact details (Google exposes them; we do not store them).
-- ad_templates: a business's own saved campaign templates (normalized draft specs without account identifiers).
-- gbp_connections: the Google Business Profile location linked to the business (ids/names; tokens live in KV).
-- ad_change_requests: proposed edits to an imported campaign: current value, proposed value, approval and outcome.
CREATE TABLE IF NOT EXISTS ad_imported_campaigns (
  id                 TEXT PRIMARY KEY,
  customer           TEXT NOT NULL REFERENCES customers(id),
  platform           TEXT NOT NULL CHECK (platform IN ('google')),
  external_id        TEXT NOT NULL,
  name               TEXT NOT NULL DEFAULT '',
  channel_type       TEXT NOT NULL DEFAULT 'OTHER',
  status             TEXT NOT NULL DEFAULT 'OTHER',
  serving_status     TEXT,
  daily_budget_cents INTEGER,
  settings           TEXT NOT NULL DEFAULT '{}',
  first_seen_at      INTEGER NOT NULL,
  synced_at          INTEGER NOT NULL,
  UNIQUE (customer, platform, external_id)
);
CREATE INDEX IF NOT EXISTS ad_imported_campaigns_customer ON ad_imported_campaigns (customer, status);

CREATE TABLE IF NOT EXISTS ad_imported_metrics_daily (
  imported_id TEXT NOT NULL REFERENCES ad_imported_campaigns(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  date        TEXT NOT NULL,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (imported_id, date)
);
CREATE INDEX IF NOT EXISTS ad_imported_metrics_customer ON ad_imported_metrics_daily (customer, date);

CREATE TABLE IF NOT EXISTS ad_import_state (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  platform   TEXT NOT NULL DEFAULT 'google',
  synced_at  INTEGER NOT NULL,
  result     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS lsa_leads (
  id           TEXT NOT NULL,
  customer     TEXT NOT NULL REFERENCES customers(id),
  imported_id  TEXT REFERENCES ad_imported_campaigns(id),
  lead_type    TEXT NOT NULL DEFAULT 'UNKNOWN',
  lead_status  TEXT NOT NULL DEFAULT 'UNKNOWN',
  charged      INTEGER NOT NULL DEFAULT 0,
  credit_state TEXT,
  category_id  TEXT,
  created_at   INTEGER NOT NULL,
  synced_at    INTEGER NOT NULL,
  lead_id      TEXT REFERENCES leads(id),
  PRIMARY KEY (customer, id)
);
CREATE INDEX IF NOT EXISTS lsa_leads_customer ON lsa_leads (customer, created_at);

CREATE TABLE IF NOT EXISTS ad_templates (
  id         TEXT PRIMARY KEY,
  customer   TEXT NOT NULL REFERENCES customers(id),
  name       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('saved', 'imported')),
  spec       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_templates_customer ON ad_templates (customer, created_at);

CREATE TABLE IF NOT EXISTS gbp_connections (
  customer      TEXT PRIMARY KEY REFERENCES customers(id),
  account_name  TEXT,
  location_name TEXT,
  title         TEXT,
  verification  TEXT,
  extra         TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN ('connected', 'needs_location', 'reconnect_required')),
  connected_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_change_requests (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  imported_id TEXT REFERENCES ad_imported_campaigns(id),
  field       TEXT NOT NULL,
  current     TEXT NOT NULL DEFAULT '{}',
  proposed    TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed', 'cancelled')),
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER,
  result      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ad_change_requests_customer ON ad_change_requests (customer, created_at);
