-- Incident register (QA & Account Operations Control Center, 2026-11-19; server/ops/incidents.js). One row per
-- incident EPISODE: a customer-impacting failure detected from existing records (audit_log failure events, messages,
-- outbox, calendar state), deduplicated by `fingerprint` (at most one OPEN row per fingerprint), updated on every
-- cron run (occurrences, last_seen, evidence) and resolved only on evidence (a later success, or no failures in the
-- rule's window — `resolution` says which). Causes are rule text, never inferred: cause = confirmed | suspected | unknown.
-- No personal data: ids, codes, counts, times, audit_log sequence numbers. Erased with the account (ERASED_TABLES).
-- Resolved rows are purged after 365 days. Additive and idempotent. Until applied, the register is simply empty.
CREATE TABLE IF NOT EXISTS ops_incidents (
  id           TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,                 -- stable dedupe key, e.g. availability:<business>
  customer     TEXT,                          -- business id, NULL = platform-wide
  feature      TEXT NOT NULL,                 -- feature registry id (capability id), e.g. calendar.google
  journey      TEXT NOT NULL,                 -- journey registry id, e.g. booking
  step         TEXT NOT NULL,                 -- journey step id, e.g. availability
  kind         TEXT NOT NULL,                 -- rule id: calendar | availability | comms | failure
  code         TEXT NOT NULL,                 -- allowlisted error code
  severity     TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  cause        TEXT NOT NULL CHECK (cause IN ('confirmed', 'suspected', 'unknown')),
  status       TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  is_test      INTEGER NOT NULL DEFAULT 0,    -- test business at detection (shown tagged, never counted as customer impact)
  evidence     TEXT NOT NULL DEFAULT '{}',    -- sanitized JSON (≤ 2 KB): codes, counts, times, event seqs
  occurrences  INTEGER NOT NULL DEFAULT 1,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  detected_at  INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolution   TEXT                           -- success_seen | no_new_failures | connected | not_applicable
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_incidents_open ON ops_incidents (fingerprint) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ops_incidents_customer ON ops_incidents (customer, status, last_seen);
CREATE INDEX IF NOT EXISTS ops_incidents_status ON ops_incidents (status, last_seen);
