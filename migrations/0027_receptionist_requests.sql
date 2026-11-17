-- AI receptionist: callback requests and messages a customer leaves for the business (server/receptionist/engine.js).
-- A durable, owner-visible "needs attention" item — never a promise that someone was told. Notification state is NOT
-- stored here: it is read from email_outbox (owner_callback:<request id>:<member>) — queued / sent / failed — and
-- `held` records that no notification could be sent (e.g. messaging test mode). Additive and idempotent.
CREATE TABLE IF NOT EXISTS receptionist_requests (
  id              TEXT PRIMARY KEY,
  customer        TEXT NOT NULL REFERENCES customers(id),
  conversation_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('callback', 'message')),
  name            TEXT,
  phone           TEXT,                          -- E.164, validated from what the customer said
  email           TEXT,
  note            TEXT,                          -- what they need / their message (customer's words via the receptionist)
  urgent          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  held            INTEGER NOT NULL DEFAULT 0,    -- 1 = no staff notification could be sent (shown to the owner)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
-- One callback and one message per conversation: a repeated request revises the same row instead of piling up.
CREATE UNIQUE INDEX IF NOT EXISTS receptionist_requests_conversation ON receptionist_requests (conversation_id, kind);
CREATE INDEX IF NOT EXISTS receptionist_requests_customer ON receptionist_requests (customer, status, created_at);
