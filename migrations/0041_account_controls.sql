-- Account controls: booking notice and closed dates, notification choices, per-business feature restrictions.
-- Additive. Until applied: no minimum notice, no closed dates, every notice on, no restrictions (exactly as before).
CREATE TABLE IF NOT EXISTS booking_rules (
  customer           TEXT PRIMARY KEY REFERENCES customers(id),
  min_notice_minutes INTEGER NOT NULL DEFAULT 0 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS business_closures (
  customer   TEXT NOT NULL REFERENCES customers(id),
  date       TEXT NOT NULL,                       -- YYYY-MM-DD in the business's time zone
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (customer, date)
);
-- A row = this member turned this kind of owner notice off.
CREATE TABLE IF NOT EXISTS owner_notice_off (
  customer   TEXT NOT NULL REFERENCES customers(id),
  email      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (customer, email, kind)
);
-- A row = a platform admin switched this feature off for one business (audited; reason required).
CREATE TABLE IF NOT EXISTS business_restrictions (
  customer TEXT NOT NULL REFERENCES customers(id),
  feature  TEXT NOT NULL,
  reason   TEXT NOT NULL,
  set_by   TEXT NOT NULL,
  set_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, feature)
);
