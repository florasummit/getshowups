-- Managed websites: private drafts, published versions (rollback), uploaded images, customer-owned
-- domains, attendance change history, test-record marks, and onboarding choices.
-- Additive and idempotent. Production requires approval:
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0009_websites.sql

-- One website per business. `draft` is private until published; the public site shows `live_version`.
CREATE TABLE IF NOT EXISTS websites (
  customer      TEXT PRIMARY KEY REFERENCES customers(id),
  draft         TEXT NOT NULL,             -- JSON content (server/website.js validateContent)
  live_version  INTEGER,                   -- website_versions.version shown publicly; NULL = not published
  published_at  INTEGER,
  updated_at    INTEGER NOT NULL
);

-- Every publish is a new immutable version, so any earlier version can be restored.
CREATE TABLE IF NOT EXISTS website_versions (
  customer   TEXT NOT NULL REFERENCES customers(id),
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (customer, version)
);

-- Owner-uploaded logo/photos (resized in the browser, type-checked on the server). Served from
-- /site-assets/:id only when a published version uses it, or to the signed-in owner.
CREATE TABLE IF NOT EXISTS website_assets (
  id           TEXT PRIMARY KEY,
  customer     TEXT NOT NULL REFERENCES customers(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes        BLOB NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS website_assets_customer ON website_assets (customer, created_at);

-- Customer-owned domains. hostname is globally unique, so two businesses can never claim the same
-- address; a removed row can be claimed again only after DNS ownership is proven anew.
CREATE TABLE IF NOT EXISTS website_domains (
  hostname     TEXT PRIMARY KEY,
  customer     TEXT NOT NULL REFERENCES customers(id),
  verify_token TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'verifying', 'securing', 'connected', 'needs_attention', 'removed')),
  detail       TEXT,                       -- allowlisted code only
  verified_at  INTEGER,
  attached_at  INTEGER,                    -- added to hosting
  connected_at INTEGER,
  checked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS website_domains_customer ON website_domains (customer, status);
CREATE INDEX IF NOT EXISTS website_domains_due ON website_domains (status, checked_at);

-- Attendance history: every change an owner makes to an appointment's outcome.
CREATE TABLE IF NOT EXISTS appointment_changes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL,
  customer       TEXT NOT NULL REFERENCES customers(id),
  from_status    TEXT NOT NULL,
  to_status      TEXT NOT NULL,
  work           TEXT,
  changed_by     TEXT NOT NULL,
  changed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_changes_appt ON appointment_changes (appointment_id, changed_at);

-- Explicit test / not-test marks on leads (and so their appointments). Without a mark, a lead is a
-- test when its email belongs to GetShowUps, the business's own users, or the platform test list.
-- Test records are never deleted; they are only left out of results.
CREATE TABLE IF NOT EXISTS test_marks (
  lead_id   TEXT PRIMARY KEY,
  customer  TEXT NOT NULL REFERENCES customers(id),
  is_test   INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  marked_by TEXT NOT NULL,
  marked_at INTEGER NOT NULL
);

-- Choices made during onboarding that have no other record (e.g. "use the GetShowUps address").
CREATE TABLE IF NOT EXISTS onboarding_marks (
  customer TEXT NOT NULL REFERENCES customers(id),
  step     TEXT NOT NULL,
  value    TEXT,
  at       INTEGER NOT NULL,
  PRIMARY KEY (customer, step)
);
