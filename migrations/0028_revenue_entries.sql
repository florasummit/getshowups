-- Revenue recorded by the business against a visit/appointment, kept apart from the estimated job value
-- (appointment_outcomes.value_cents, self-reported when marking the visit). Two kinds:
--   invoiced: the amount billed for the job;   paid: money actually received.
-- Append-only: a correction is a new row (the latest row per appointment + kind is the current amount; amount_cents NULL
-- = cleared). Who recorded it is kept as a reference, never an email. Additive and idempotent.
CREATE TABLE IF NOT EXISTS revenue_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  customer       TEXT NOT NULL REFERENCES customers(id),
  kind           TEXT NOT NULL CHECK (kind IN ('invoiced', 'paid')),
  amount_cents   INTEGER CHECK (amount_cents IS NULL OR (amount_cents >= 0 AND amount_cents <= 100000000)),
  recorded_by    TEXT NOT NULL,
  recorded_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revenue_entries_appt ON revenue_entries (appointment_id, kind, id);
-- Current amounts per business: latest id per (appointment, kind) within one business (server/revenue.js).
CREATE INDEX IF NOT EXISTS revenue_entries_customer ON revenue_entries (customer, appointment_id, kind, id);
