-- Automated follow-ups, booking confirmations, reminders, and attendance confirmation.
-- Additive and idempotent (new tables only). Apply after 0003, BEFORE deploying the code that uses it
-- (production requires approval):
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0004_automation.sql

-- Consent to text messages, ticked on the booking page (offered only when SMS is configured).
-- One row per consenting lead; the timestamp and wording version are the consent record.
CREATE TABLE IF NOT EXISTS sms_consents (
  lead_id      TEXT PRIMARY KEY REFERENCES leads(id),
  customer     TEXT NOT NULL REFERENCES customers(id),
  wording      TEXT NOT NULL,                       -- version of the checkbox text shown
  consented_at INTEGER NOT NULL
);

-- "I'll be there": recorded when the customer confirms from a confirmation/reminder link.
CREATE TABLE IF NOT EXISTS appointment_confirmations (
  appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
  customer       TEXT NOT NULL REFERENCES customers(id),
  confirmed_at   INTEGER NOT NULL
);

-- Per-business settings. No row = defaults (automatic messages on; nothing sends without a provider).
CREATE TABLE IF NOT EXISTS customer_settings (
  customer    TEXT PRIMARY KEY REFERENCES customers(id),
  automations INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

-- Scheduled messages to a business's leads. Content is rendered at send time from current records,
-- and each message re-checks that it is still relevant (e.g. a follow-up is skipped once the lead books).
CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,                    -- dedupe key: <kind>:<channel>:<lead or appointment id>
  customer       TEXT NOT NULL REFERENCES customers(id),
  lead_id        TEXT NOT NULL REFERENCES leads(id),
  appointment_id TEXT REFERENCES appointments(id),
  kind           TEXT NOT NULL,                       -- lead_followup_1/2, confirmation, reminder_24h/2h, no_show_rebook
  channel        TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  send_at        INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,                                -- allowlisted code: not_needed, expired, no_provider, http_500, ...
  provider_id    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_due ON messages (status, send_at);
CREATE INDEX IF NOT EXISTS messages_customer ON messages (customer, created_at);
