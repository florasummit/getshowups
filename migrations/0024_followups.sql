-- Follow-ups (server/followups/): one conversation thread per lead, its messages (both directions), each business's
-- follow-up preferences, and its US texting (A2P 10DLC) setup. Leads stay in `leads`; scheduled automatic messages stay
-- in `messages`; opt-outs stay in `message_optouts`; SMS consent stays in `sms_consents`; control stays in
-- `conversation_control`. Additive and idempotent.

-- One row per lead that entered the follow-up engine (source adapter: website_form, booking_page, …).
CREATE TABLE IF NOT EXISTS lead_threads (
  lead_id         TEXT PRIMARY KEY REFERENCES leads(id),
  customer        TEXT NOT NULL REFERENCES customers(id),
  source          TEXT NOT NULL,                 -- website_form | booking_page | google_ads | gbp | call | other
  stage           TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'replied', 'booked', 'closed', 'opted_out')),
  needs_owner     TEXT,                          -- allowlisted reason the owner should look (human_requested, ai_unsure, …)
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  next_action     TEXT,                          -- reply (an inbound text awaits an answer) | replying | NULL
  next_action_at  INTEGER,
  ai_replies      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_threads_customer ON lead_threads (customer, updated_at);

-- Conversation messages. Body is kept for the owner's inbox only (never logged, never in admin views; purged after
-- 365 days by cron; erased with the account). provider_id is the provider's message id (Twilio MessageSid / Resend id).
CREATE TABLE IF NOT EXISTS thread_messages (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  lead_id     TEXT NOT NULL REFERENCES leads(id),
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel     TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'note')),
  author      TEXT NOT NULL CHECK (author IN ('lead', 'ai', 'auto', 'owner', 'system')),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'received')),
  error       TEXT,                              -- allowlisted code
  provider_id TEXT,
  segments    INTEGER,
  cost_micros INTEGER,                           -- estimate until the provider reports a price
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_messages_lead ON thread_messages (customer, lead_id, created_at);
CREATE INDEX IF NOT EXISTS thread_messages_status ON thread_messages (status, updated_at);
-- A provider message id is recorded once: a repeated webhook can't create a second inbound message.
CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_provider ON thread_messages (channel, provider_id) WHERE provider_id IS NOT NULL;

-- Follow-up preferences. No row = defaults.
CREATE TABLE IF NOT EXISTS followup_settings (
  customer      TEXT PRIMARY KEY REFERENCES customers(id),
  acknowledge   INTEGER NOT NULL DEFAULT 1,      -- reply right away to website-form leads
  ai_replies    INTEGER NOT NULL DEFAULT 1,      -- answer texts with the assistant (when the platform allows it)
  nudges        INTEGER NOT NULL DEFAULT 2,      -- "pick a time" follow-ups for unbooked leads (0-2)
  after_visit   INTEGER NOT NULL DEFAULT 0,      -- thank-you message after a completed visit
  quiet_start   INTEGER NOT NULL DEFAULT 21,     -- no automatic texts from 21:00 …
  quiet_end     INTEGER NOT NULL DEFAULT 8,      -- … to 08:00 (business time zone)
  updated_at    INTEGER NOT NULL
);

-- US business texting setup (A2P 10DLC). Facts the OWNER provides, the owner's explicit approval to submit, and the
-- status the PROVIDER reported (recorded by a platform admin or a provider sync). Never "approved" without the provider.
CREATE TABLE IF NOT EXISTS sms_registrations (
  customer          TEXT PRIMARY KEY REFERENCES customers(id),
  legal_name        TEXT,
  business_type     TEXT,                        -- sole_proprietor | llc | corporation | partnership | nonprofit
  ein               TEXT,                        -- optional for sole proprietors
  address           TEXT,
  website           TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  use_case          TEXT,
  sample_messages   TEXT,                        -- JSON array of strings
  approved_by       TEXT,                        -- ref:<sha256 prefix> of the owner who approved submission
  approved_at       INTEGER,
  status            TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'ready', 'pending', 'approved', 'rejected', 'suspended')),
  status_note       TEXT,                        -- provider's reason / next action (short, no personal data)
  status_at         INTEGER,
  messaging_service TEXT,                        -- provider sender pool for this business (e.g. Twilio MG…)
  sender_phone      TEXT,                        -- E.164 number texts come from
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_registrations_sender ON sms_registrations (sender_phone) WHERE sender_phone IS NOT NULL;
