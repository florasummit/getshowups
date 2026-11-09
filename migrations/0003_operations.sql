-- Operations: admin invitations, audit log, analytics events, email outbox, billing (Stripe).
-- Additive and idempotent. Apply after 0002 (production requires approval):
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0003_operations.sql

-- Invitations for a person (by email) to join a business. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS account_invites (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,                 -- the only Google account that can accept it
  customer     TEXT NOT NULL REFERENCES customers(id),
  created_by   TEXT NOT NULL,                 -- platform admin email
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  revoked_at   INTEGER,
  sent_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS account_invites_customer ON account_invites (customer);

-- Every privileged action by a platform admin.
CREATE TABLE IF NOT EXISTS admin_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  customer TEXT,
  details  TEXT NOT NULL DEFAULT '{}'        -- JSON, never secrets
);
CREATE INDEX IF NOT EXISTS admin_audit_customer ON admin_audit (customer, at);

-- Product and business events. id is a deterministic dedupe key where one exists.
CREATE TABLE IF NOT EXISTS events (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL,
  customer TEXT,
  at       INTEGER NOT NULL,
  props    TEXT NOT NULL DEFAULT '{}'        -- JSON, no personal data
);
CREATE INDEX IF NOT EXISTS events_type_at ON events (type, at);
CREATE INDEX IF NOT EXISTS events_customer ON events (customer, at);

-- Outgoing email. Delivered only when a provider is configured; otherwise stays visible as not sent.
CREATE TABLE IF NOT EXISTS email_outbox (
  id         TEXT PRIMARY KEY,                -- dedupe key, e.g. followup:setup:<customer>
  to_email   TEXT NOT NULL,
  customer   TEXT,
  template   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS email_outbox_status ON email_outbox (status, created_at);

-- Plans map to Stripe Prices. Amounts live in Stripe; nothing here invents a price.
CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL UNIQUE,
  trial_days      INTEGER NOT NULL DEFAULT 0,
  entitlements    TEXT NOT NULL DEFAULT '{}',
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- One subscription per business, mirrored from Stripe webhooks. No card data is ever stored.
CREATE TABLE IF NOT EXISTS subscriptions (
  customer               TEXT PRIMARY KEY REFERENCES customers(id),
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT,
  plan_id                TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled')),
  mrr_cents              INTEGER NOT NULL DEFAULT 0,
  currency               TEXT,
  current_period_end     INTEGER,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  last_event_at          INTEGER NOT NULL DEFAULT 0,   -- Stripe event time; older events are ignored
  updated_at             INTEGER NOT NULL
);

-- Processed Stripe webhook events (idempotency).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
