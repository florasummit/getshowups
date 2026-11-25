-- Booking experience: which service a request was for (a snapshot, so renaming or removing a service never changes
-- history or reporting) and the business's booking-page options. The service list itself stays in
-- business_profiles.services (one catalog for the booking page, receptionist, assistant and website seed).
-- Additive. Until applied: requests keep only their free-text need and "Other / Not sure" is offered (as before:
-- the page asked an open question).
CREATE TABLE IF NOT EXISTS lead_services (
  lead_id      TEXT PRIMARY KEY REFERENCES leads(id),
  customer     TEXT NOT NULL REFERENCES customers(id),
  service_id   TEXT,                               -- the service's stable id; NULL = "Other / Not sure"
  service_name TEXT NOT NULL,                      -- the name as the customer saw it when asking
  minutes      INTEGER,                            -- the appointment length it was booked with (NULL = business default)
  flow         TEXT NOT NULL DEFAULT 'book' CHECK (flow IN ('book', 'request')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_services_customer ON lead_services (customer, service_id);

CREATE TABLE IF NOT EXISTS booking_options (
  customer    TEXT PRIMARY KEY REFERENCES customers(id),
  allow_other INTEGER NOT NULL DEFAULT 1 CHECK (allow_other IN (0, 1)),
  updated_at  INTEGER NOT NULL
);
