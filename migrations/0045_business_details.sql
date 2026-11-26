-- Business details the owner sets in Settings: different booking hours on some days, and the business's own address.
-- Additive. Until applied: every booking day uses customers.day_start/day_end and no address exists (exactly as before).
--
-- booking_day_hours: one row per business that keeps different hours on some days. hours = JSON
-- { "<weekday 0-6>": { "start": "HH:MM", "end": "HH:MM" } }, overriding customers.day_start/day_end for those weekdays
-- only while they are booking days (customers.workdays). The customers columns stay the default and are never rewritten
-- by this table. No row = every booking day uses the default range. Closed dates and minimum notice still apply on top.
CREATE TABLE IF NOT EXISTS booking_day_hours (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  hours      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- business_addresses: where customers come for an appointment. Shown to customers ONLY when public = 1 AND the business's
-- appointment mode is at_business (a business that visits its customers never has its address shown).
CREATE TABLE IF NOT EXISTS business_addresses (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  street     TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL,
  state      TEXT NOT NULL,
  zip        TEXT NOT NULL,
  public     INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  updated_at INTEGER NOT NULL
);
