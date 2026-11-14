-- Permanent audit log: append-only and hash-chained (server/auditlog.js). Each row's hash covers its own fields and
-- the previous row's hash, so any later change, removal or reordering is detectable (verifyAuditChain); the two
-- triggers make SQLite refuse every in-place change or removal. Holds NO personal data: customer/owner emails are
-- stored as one-way references (ref:<sha256 prefix>), so account deletion never needs to touch it. Staff (platform
-- admin) identities are kept as accountable actors. The business id is kept (not personal data).
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY,           -- 1, 2, 3, … (no gaps; assigned by the writer, UNIQUE guards races)
  at         INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'owner', 'system', 'stripe', 'customer')),
  actor      TEXT NOT NULL,                 -- admin email | ref:<hash> | system:<job> | stripe
  action     TEXT NOT NULL,                 -- e.g. customer.suspend, billing.payment_failed, ads.pause
  customer   TEXT,                          -- business id or NULL (platform-wide)
  capability TEXT,                          -- capability id (server/ops/registry.js), e.g. ads.google, billing.stripe
  resource_type TEXT,                       -- stable resource reference: campaign | subscription | website | customer | …
  resource_id   TEXT,
  outcome    TEXT NOT NULL DEFAULT 'info' CHECK (outcome IN ('success', 'failure', 'info')),
  correlation_id TEXT,                      -- ties related entries (a webhook and the pauses it caused, one deletion, …)
  details    TEXT NOT NULL DEFAULT '{}',    -- JSON, no personal data, no free text, no secrets
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_log_customer ON audit_log (customer, seq);
CREATE INDEX IF NOT EXISTS audit_log_capability ON audit_log (capability, seq);
CREATE INDEX IF NOT EXISTS audit_log_correlation ON audit_log (correlation_id);
CREATE TRIGGER IF NOT EXISTS audit_log_append_only_u BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_append_only_d BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
