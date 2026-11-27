-- Business phone lines (server/telephony/, docs/TELEPHONE.md): a Twilio number in the business's OWN subaccount (0025),
-- who it rings, what happens when nobody answers, and a record of each call. Recording does not exist (no column, no setting).
-- Additive and idempotent. Until applied, the Phone card says "Not available yet" and the call webhooks answer 503.

-- The numbers customers call. One business may have several (e.g. one shown on the website, one on ads): `source` is the
-- owner's own label for where it is shown, the ONLY attribution a call gets. `forwarded_from` = the owner's existing number
-- when it forwards to this line (never dialled by us: that would loop). forward_mode: 'all' = every call forwards here,
-- 'no_answer' = only calls the owner missed (their phone already rang, so we skip the team and go to the fallback).
CREATE TABLE IF NOT EXISTS phone_lines (
  id             TEXT PRIMARY KEY,
  customer       TEXT NOT NULL REFERENCES customers(id),
  number         TEXT NOT NULL,                    -- E.164
  provider       TEXT NOT NULL DEFAULT 'twilio',
  provider_sid   TEXT,                             -- Twilio IncomingPhoneNumber sid (PN…)
  account_sid    TEXT,                             -- the business's subaccount that owns it
  source         TEXT NOT NULL DEFAULT 'general',
  forwarded_from TEXT,
  forward_mode   TEXT NOT NULL DEFAULT 'none' CHECK (forward_mode IN ('none', 'all', 'no_answer')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  released_at    INTEGER
);
-- A number answers for one business at a time.
CREATE UNIQUE INDEX IF NOT EXISTS phone_lines_number ON phone_lines (number) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS phone_lines_customer ON phone_lines (customer, status);

-- Who answers. answer: 'team' (ring verified numbers, then the fallback) | 'fallback' (straight to the fallback).
-- fallback: 'ai' (the AI receptionist, when it is on and available) | 'callback' (a short message; the caller's number goes
-- to Needs attention). after_hours: 'same' | 'fallback'. version = optimistic concurrency (409 on a stale save).
CREATE TABLE IF NOT EXISTS phone_settings (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  answer       TEXT NOT NULL DEFAULT 'team' CHECK (answer IN ('team', 'fallback')),
  ring_seconds INTEGER NOT NULL DEFAULT 20,
  fallback     TEXT NOT NULL DEFAULT 'callback' CHECK (fallback IN ('ai', 'callback')),
  after_hours  TEXT NOT NULL DEFAULT 'same' CHECK (after_hours IN ('same', 'fallback')),
  screen       INTEGER NOT NULL DEFAULT 1,       -- the team member presses 1 to take the call (their voicemail never "answers")
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
);

-- Numbers we may ring. Only VERIFIED ones are ever dialled: verification is a call to that number where the person types
-- the code shown on their screen (proves it is theirs; stops forwarding to someone else's or a premium number).
CREATE TABLE IF NOT EXISTS phone_destinations (
  id           TEXT PRIMARY KEY,
  customer     TEXT NOT NULL REFERENCES customers(id),
  number       TEXT NOT NULL,                      -- E.164, +1 only
  label        TEXT NOT NULL DEFAULT '',
  code_hash    TEXT,                               -- SHA-256 of the verification code, cleared once verified
  code_expires INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  verified_at  INTEGER,
  created_at   INTEGER NOT NULL,
  removed_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS phone_destinations_number ON phone_destinations (customer, number) WHERE removed_at IS NULL;

-- One row per call (Twilio CallSid = idempotency key). caller = E.164 when Twilio gave a real number, NULL when withheld or
-- unknown (caller_state says which). Matched to a customer record only on an exact number in this business that points to ONE
-- person (match: single | ambiguous | none); never a new record automatically. outcome moves forward only.
CREATE TABLE IF NOT EXISTS phone_calls (
  call_sid        TEXT PRIMARY KEY,
  customer        TEXT NOT NULL REFERENCES customers(id),
  line_id         TEXT NOT NULL,
  caller          TEXT,
  caller_state    TEXT NOT NULL CHECK (caller_state IN ('known', 'withheld', 'unknown')),
  forwarded       INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'general',
  route           TEXT,                             -- 'team' | 'fallback' | 'limited' | 'off'
  outcome         TEXT,                             -- answered | ai | callback | missed | failed | limited | off
  answered_by     TEXT,                             -- destination id, 'ai' or NULL
  dial_status     TEXT,                             -- Twilio DialCallStatus of the team leg
  duration_seconds INTEGER,
  ai_call_id      TEXT,                             -- receptionist_calls.call_id of the AI leg
  conversation_id TEXT,                             -- the receptionist conversation (its lead/booking is the evidence)
  lead_id         TEXT,
  match           TEXT,
  request_id      TEXT,                             -- receptionist_requests row (callback task)
  price_micros    INTEGER,                          -- provider-reported price when fetched (never an estimate)
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_calls_customer ON phone_calls (customer, started_at);
