-- AI receptionist (server/receptionist/): one shared engine for website chat and voice. Leads and bookings stay in
-- `leads` / `appointments` (created through the existing booking functions); this only stores the receptionist's
-- settings, conversations, actions and voice calls. Additive and idempotent.

-- Owner settings. No row = receptionist off (an owner turns it on; nothing changes for a business that doesn't).
CREATE TABLE IF NOT EXISTS receptionist_settings (
  customer       TEXT PRIMARY KEY REFERENCES customers(id),
  enabled        INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL DEFAULT 'ai_first' CHECK (mode IN ('ai_first', 'human_first', 'after_hours')),
  greeting       TEXT,                           -- first line customers see/hear (owner-written)
  knowledge      TEXT,                           -- owner-approved answers (FAQ, what's included, emergencies)
  transfer_phone TEXT,                           -- E.164 number staff answer (phone routing; not used by web calls)
  updated_at     INTEGER NOT NULL
);

-- One conversation per chat session or voice call. transcript = the model conversation (kept unchanged so it can be
-- replayed), state = offered slots + collected details. Personal data: owner views only; erased with the account;
-- purged after 365 days.
CREATE TABLE IF NOT EXISTS receptionist_conversations (
  id             TEXT PRIMARY KEY,
  customer       TEXT NOT NULL REFERENCES customers(id),
  channel        TEXT NOT NULL CHECK (channel IN ('chat', 'voice')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'handoff', 'closed')),
  outcome        TEXT,                           -- allowlisted: booked | handoff_urgent | handoff | out_of_area | info | error
  lead_id        TEXT,
  appointment_id TEXT,
  summary        TEXT,                           -- built from recorded facts, never model-written
  state          TEXT NOT NULL DEFAULT '{}',
  transcript     TEXT NOT NULL DEFAULT '[]',
  turns          INTEGER NOT NULL DEFAULT 0,     -- also the optimistic-concurrency version
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receptionist_conversations_customer ON receptionist_conversations (customer, updated_at);

-- What the receptionist did: every tool action, refusal, failure and escalation (allowlisted codes, no free text).
CREATE TABLE IF NOT EXISTS receptionist_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer        TEXT NOT NULL REFERENCES customers(id),
  conversation_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  ok              INTEGER NOT NULL,
  detail          TEXT,
  at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receptionist_events_conversation ON receptionist_events (conversation_id, id);

-- Voice calls created by GetShowUps (the provider connects back with this call id; nothing else routes a call).
CREATE TABLE IF NOT EXISTS receptionist_calls (
  call_id         TEXT PRIMARY KEY,
  customer        TEXT NOT NULL REFERENCES customers(id),
  conversation_id TEXT NOT NULL,
  provider        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
