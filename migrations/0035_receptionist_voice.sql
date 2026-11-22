-- Receptionist voice management (docs/RECEPTIONIST.md "Voice management"). Additive and idempotent.
-- One row per business that changed something; NO row = today's effective configuration (provider retell, the shared
-- agent's own voice, standard manner, normal pace), so existing businesses keep exactly what they have.
--   provider     the provider customer-facing browser voice uses (admin-only switch; only providers with a customer
--                path can be activated: today retell). openai / elevenlabs = Voice Lab only ("test only").
--   voice_id     the chosen voice on that provider (validated against the provider's catalog); NULL = provider default
--   personality  conversational style preset (fixed texts in server/voice/settings.js, never free prompt text)
--   pace         speaking pace where the provider supports it (retell voice_speed, elevenlabs speed)
--   previous     JSON of the configuration before the last provider switch (rollback), cleared by a rollback
--   version      optimistic concurrency: every write carries the version it read (409 on a stale write)
CREATE TABLE IF NOT EXISTS receptionist_voice_settings (
  customer     TEXT PRIMARY KEY REFERENCES customers(id),
  provider     TEXT NOT NULL DEFAULT 'retell' CHECK (provider IN ('retell', 'openai', 'elevenlabs')),
  voice_id     TEXT,
  voice_name   TEXT,
  personality  TEXT NOT NULL DEFAULT 'standard' CHECK (personality IN ('standard', 'warm', 'professional', 'calm', 'upbeat')),
  pace         TEXT NOT NULL DEFAULT 'normal' CHECK (pace IN ('slower', 'normal', 'faster')),
  language     TEXT NOT NULL DEFAULT 'en',
  previous     TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Provider voice catalogs, cached (one JSON list per provider, refreshed after 24 h or on demand). No business data.
CREATE TABLE IF NOT EXISTS voice_catalog_cache (
  provider   TEXT PRIMARY KEY,
  voices     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
