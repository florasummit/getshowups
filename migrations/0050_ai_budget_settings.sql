-- AI spending limits set by a platform admin (server/ai-budget.js, docs/AI_SPENDING.md): daily ceilings in micro-dollars,
-- voice minutes per provider per day (Retell, OpenAI, ElevenLabs), and the platform-wide AI off switch. One row per
-- setting; every change is also an admin_audit entry (who, from, to, reason). A missing row = the built-in default.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS ai_budget_settings (
  key        TEXT PRIMARY KEY CHECK (key IN ('platform_micros', 'public_micros', 'business_micros', 'retell_minutes', 'openai_minutes', 'elevenlabs_minutes', 'all_off')),
  value      INTEGER NOT NULL,
  updated_by TEXT NOT NULL,                 -- staff admin email (admin actions stay readable, like admin_audit)
  updated_at INTEGER NOT NULL
);
