-- Single-use onboarding invites for connecting a customer's Google Calendar.
-- Apply once to the D1 database bound as ONBOARDING_DB:
--   Cloudflare dashboard → D1 → <database> → Console → paste this file, or
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0001_onboarding_invites.sql
CREATE TABLE IF NOT EXISTS onboarding_invites (
  token_hash    TEXT PRIMARY KEY,               -- SHA-256 of the invite token; raw token is never stored
  customer      TEXT NOT NULL,                  -- the only source of customer identity in the OAuth flow
  purpose       TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect')),
  created_at    INTEGER NOT NULL,               -- epoch ms
  expires_at    INTEGER NOT NULL,               -- epoch ms
  claim_session TEXT,                           -- the one browser session allowed to finish the flow
  claimed_at    INTEGER,
  used_at       INTEGER                         -- set once; a used invite can never be claimed again
);

CREATE INDEX IF NOT EXISTS onboarding_invites_customer ON onboarding_invites (customer);
