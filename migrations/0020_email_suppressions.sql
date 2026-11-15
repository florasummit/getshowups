-- Delivery feedback from Resend (signed webhook, server/email-feedback.js): addresses that permanently bounced or whose
-- owner marked our email as spam. Hashes only (same scheme as message_optouts). We stop emailing them; the owner is told
-- (bounce) so they can call instead. Additive, idempotent.
CREATE TABLE IF NOT EXISTS email_suppressions (
  customer     TEXT NOT NULL,                 -- the business whose message triggered it
  address_hash TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('bounced', 'complained')),
  message_id   TEXT,                          -- our messages.id
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, address_hash)
);
-- Webhooks find our message by Resend's email id.
CREATE INDEX IF NOT EXISTS messages_provider ON messages (provider_id);
