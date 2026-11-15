-- Owner notices (server/notify.js) scan recent bookings and leads every cron run. These indexes keep that a range read
-- instead of a full table scan as the tables grow. Additive and idempotent; the code works (slower) without them.
CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at);
CREATE INDEX IF NOT EXISTS appointments_created ON appointments (created_at);
CREATE INDEX IF NOT EXISTS appointment_changes_changed ON appointment_changes (changed_at);
