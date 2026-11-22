-- Global default AI voice provider (docs/RECEPTIONIST.md "Global default provider"). Additive and idempotent.
-- Resolution for a business's customer-facing browser voice: explicit business override → global default → retell.
--
-- receptionist_voice_defaults: the platform-wide default, append-only history (the newest version is current). NO row
--   = retell (today's behaviour, backward compatible). Each change records the provider before it (`previous`), how it
--   was applied (`mode`: all | staged | rollback), the businesses a staged rollout PINNED to the previous provider
--   because they were not verified on the new one, and the businesses whose settings row was moved to the new provider
--   (`switched`), both as JSON lists of { customer, version } so a rollback can undo exactly what it did. No personal data.
-- receptionist_voice_inherit: a business whose receptionist_voice_settings row exists only because the owner chose a
--   voice/personality/pace, and which therefore FOLLOWS the global default. Presence = inherits. A business with no
--   settings row inherits too. A settings row WITHOUT an inherit row is an explicit admin override (an admin switch
--   or a staged-rollout pin), exactly as every row before this migration (all of which came from admin switches).
CREATE TABLE IF NOT EXISTS receptionist_voice_defaults (
  version   INTEGER PRIMARY KEY,
  provider  TEXT NOT NULL CHECK (provider IN ('retell', 'openai', 'elevenlabs')),
  previous  TEXT NOT NULL CHECK (previous IN ('retell', 'openai', 'elevenlabs')),
  mode      TEXT NOT NULL CHECK (mode IN ('all', 'staged', 'rollback')),
  pinned    TEXT NOT NULL DEFAULT '[]',
  switched  TEXT NOT NULL DEFAULT '[]',
  set_by    TEXT NOT NULL,
  set_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receptionist_voice_inherit (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  updated_at INTEGER NOT NULL
);
