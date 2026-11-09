-- Appointment mode per business, service addresses for on-site visits, and visit/work outcomes.
-- Additive and idempotent; existing businesses default to 'at_business' with unchanged behavior.
-- Apply after 0004 (production requires approval):
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0005_appointment_modes.sql

-- Where appointments happen. No row = 'at_business' (the customer comes to the business).
CREATE TABLE IF NOT EXISTS service_settings (
  customer         TEXT PRIMARY KEY REFERENCES customers(id),
  appointment_mode TEXT NOT NULL DEFAULT 'at_business' CHECK (appointment_mode IN ('at_business', 'at_customer')),
  updated_at       INTEGER NOT NULL
);

-- Service address for leads of 'at_customer' businesses. Kept apart from `leads` so it is read only
-- where needed (owner dashboard, the lead's own messages, the calendar event) and is easy to purge.
CREATE TABLE IF NOT EXISTS lead_addresses (
  lead_id    TEXT PRIMARY KEY REFERENCES leads(id),
  customer   TEXT NOT NULL REFERENCES customers(id),
  street     TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL,
  state      TEXT NOT NULL,                 -- US two-letter code
  zip        TEXT NOT NULL,                 -- 5-digit or ZIP+4
  created_at INTEGER NOT NULL
);

-- What the owner reported after an appointment. appointments.status says whether the visit or
-- appointment happened ('showed') or not ('no_show'); `work` says whether the job was done, which is
-- a separate fact (arriving is not completing). value_cents is optional, self-reported, and describes
-- what a booked job was worth, not revenue caused by GetShowUps.
CREATE TABLE IF NOT EXISTS appointment_outcomes (
  appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
  customer       TEXT NOT NULL REFERENCES customers(id),
  work           TEXT CHECK (work IN ('completed', 'not_completed')),
  value_cents    INTEGER CHECK (value_cents IS NULL OR (value_cents >= 0 AND value_cents <= 100000000)),
  reported_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_outcomes_customer ON appointment_outcomes (customer, reported_at);
