-- AI spending limits set by a platform admin (server/ai-budget.js, docs/AI_SPENDING.md): daily ceilings in micro-dollars,
-- Retell minutes per day, and the platform-wide AI off switch. One row per setting; every change is also an audit_log
-- entry (who, from, to, reason). A missing row = the built-in default. Additive and idempotent.
CREATE TABLE IF NOT EXISTS ai_budget_settings (
  key        TEXT PRIMARY KEY CHECK (key IN ('platform_micros', 'public_micros', 'business_micros', 'retell_minutes', 'all_off')),
  value      INTEGER NOT NULL,
  updated_by TEXT NOT NULL,                 -- staff admin email (admin actions stay readable, like admin_audit)
  updated_at INTEGER NOT NULL
);
