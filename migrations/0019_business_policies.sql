-- What customers should know, written by the owner (Settings → What customers should know). Shown on the booking page
-- and in confirmation/24 h reminder emails. Its own table so saving the profile never touches it. Additive, idempotent.
CREATE TABLE IF NOT EXISTS business_policies (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  before_visit TEXT NOT NULL DEFAULT '',   -- e.g. "Please unlock the gate and keep pets inside."
  cancellation TEXT NOT NULL DEFAULT '',   -- e.g. "Please cancel at least 24 hours ahead."
  updated_at   INTEGER NOT NULL
);
