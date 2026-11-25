-- Acceptance testing of the deployed dashboard without Google sign-in (server/acceptance.js, docs/INTELLIGENCE.md §8).
-- Only for admin-marked test businesses; off unless ACCEPTANCE_SESSIONS_ENABLED is exactly 'true'. Hashes only: no code,
-- secret or session token is stored. No personal data (approved_by is a ref). Additive and idempotent.
CREATE TABLE IF NOT EXISTS acceptance_pairings (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS acceptance_grants (
  id           TEXT PRIMARY KEY,
  customer     TEXT NOT NULL REFERENCES customers(id),
  secret_hash  TEXT NOT NULL UNIQUE,
  approved_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS acceptance_grants_customer ON acceptance_grants (customer, revoked_at);
CREATE TABLE IF NOT EXISTS acceptance_sessions (
  token_hash TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES acceptance_grants(id),
  customer   TEXT NOT NULL REFERENCES customers(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
