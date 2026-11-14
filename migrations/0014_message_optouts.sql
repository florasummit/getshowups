-- Opt-outs from a business's automatic follow-up messages (email unsubscribe link, or a carrier STOP reported by
-- Twilio as error 21610). Per business and channel; the address is stored only as a SHA-256 hash (lowercased email,
-- or E.164 phone), so no contact details are kept here. Follow-ups (unbooked-lead and no-show) are skipped for an
-- opted-out address; booking confirmations and reminders still go out. Rows are never deleted automatically.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS message_optouts (
  customer     TEXT NOT NULL REFERENCES customers(id),
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  address_hash TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('unsubscribe_link', 'carrier_stop')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, channel, address_hash)
);
