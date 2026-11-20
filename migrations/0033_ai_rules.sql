-- Teach Your AI (server/intelligence/, docs/INTELLIGENCE_STUDIO.md): the owner's AI rules as structured, versioned
-- configuration. Business facts are NOT copied here (services, towns, ZIPs, hours, mode, policies stay in their own
-- tables); only how the AI should work with them. Additive and idempotent. No row = no rules: the receptionist
-- behaves exactly as before, and published rules affect real conversations only for businesses listed in
-- AI_RULES_LIVE_BUSINESSES (approval).

-- One editable draft per business. draft_updated_at is the version stamp every save/publish must carry
-- (stale-save protection: a page showing an older draft gets 409, never a silent overwrite).
CREATE TABLE IF NOT EXISTS ai_rules (
  customer         TEXT PRIMARY KEY REFERENCES customers(id),
  draft            TEXT NOT NULL,              -- JSON, schema v1 (server/intelligence/schema.js validateConfig)
  draft_updated_at INTEGER NOT NULL,
  live_version     INTEGER,                    -- NULL = nothing published
  updated_at       INTEGER NOT NULL
);

-- Every published version, append-only (rollback publishes a copy of an older version as a new one).
CREATE TABLE IF NOT EXISTS ai_rule_versions (
  customer     TEXT NOT NULL REFERENCES customers(id),
  version      INTEGER NOT NULL,
  config       TEXT NOT NULL,                  -- JSON, validated at publish time
  note         TEXT,                           -- plain-language summary of what changed (built by the server)
  published_by TEXT,                           -- ref:<sha256 prefix> of the owner's email, never the email
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (customer, version)
);
