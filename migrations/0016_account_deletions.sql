-- Account deletion jobs (server/deletion.js; owner decision 2026-11-14): permanent deletion run as a durable,
-- retryable workflow (lockout → ads → billing → integrations → data → verify). One row per deleted business; it is
-- also the record that the deletion happened (what was erased, what was kept and why) and the replay list if a
-- database backup is ever restored. No personal data: the requester is a one-way ref.
-- The workflow only runs when ACCOUNT_DELETION_ENABLED is exactly 'true' (approval).
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS account_deletions (
  customer        TEXT PRIMARY KEY,            -- the business id (kept as a tombstone in customers; never reused)
  requested_at    INTEGER NOT NULL,
  requested_by    TEXT NOT NULL,               -- owner:ref:<hash> | admin email | system
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  step            TEXT NOT NULL,               -- next step to run (or 'done')
  attempts        INTEGER NOT NULL DEFAULT 0,  -- attempts of the current step
  last_error      TEXT,                        -- allowlisted code of the last failure
  next_attempt_at INTEGER NOT NULL,
  completed_at    INTEGER,
  report          TEXT NOT NULL DEFAULT '{}'   -- JSON: per-step results, erased row counts, retained categories
);
CREATE INDEX IF NOT EXISTS account_deletions_due ON account_deletions (status, next_attempt_at);
