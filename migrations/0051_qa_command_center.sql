-- QA Command Center + Product Improvement Backlog (server/ops/qa-*.js, docs/QA_CI_SETUP.md). Builds on 0032 (qa_runs /
-- qa_results / qa_findings stay as they are and stay readable). Platform data only: no business id, no names, contact
-- details or secrets (actors are refs, free text is redacted on write). Additive and idempotent. Until applied, the QA
-- Command Center says "not available" and nothing else changes.
--
-- Executions: one QA run (CI dispatch, production verification by the cron, a manual session, or a report that
-- arrived by itself: a main-branch CI run or an admin's import, recorded as a finished execution). Status
-- moves forward only (server/ops/qa-executions.js); every transition is ALSO a qa_execution_events row (append-only).
CREATE TABLE IF NOT EXISTS qa_executions (
  id              TEXT PRIMARY KEY,
  requested_by    TEXT NOT NULL,                   -- ref:<hash> of the platform admin, or system:<name>
  requested_at    INTEGER NOT NULL,
  environment     TEXT NOT NULL CHECK (environment IN ('ci', 'production', 'manual', 'local')),  -- local = an imported report
  preset          TEXT,                            -- all_safe | smoke | regression | affected | failed | manual_continue | production_verify | null (custom)
  scope           TEXT NOT NULL DEFAULT '{}',      -- JSON { tests: [ids], journeys: [ids], files: {unit, e2e}, evals }
  estimate        TEXT NOT NULL DEFAULT '{}',      -- JSON { ms, usdMicros, approvals }
  status          TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'running', 'passed', 'failed', 'partial', 'cancelled', 'refused', 'expired')),
  revision        TEXT,                            -- git commit tested (CI: the dispatched ref's commit; production: build.json)
  deployment      TEXT,                            -- Cloudflare deployment id when known
  run_id          TEXT,                            -- qa_runs.id of the stored report
  gh_run_id       TEXT,                            -- GitHub Actions run id (reported by the workflow when it starts)
  run_url         TEXT,                            -- https://github.com/<repo>/actions/runs/<id>
  progress        TEXT NOT NULL DEFAULT '{}',      -- JSON { done, total, pass, fail, blocked, skipped }
  attempts        INTEGER NOT NULL DEFAULT 0,      -- dispatch attempts (bounded)
  reason          TEXT,                            -- refusal / cancel / expiry code
  reserved_micros INTEGER NOT NULL DEFAULT 0,      -- paid evals: worst case reserved against the QA budget before dispatch
  reserved_at     INTEGER,
  cost_micros     INTEGER,                         -- recorded cost (sum of the results' reported costs)
  unchanged       TEXT,                            -- JSON { files: [hash keys], tests: [ids] }: tests that passed again with
                                                   -- identical hashes in this run (no row each; "last verified" stays derivable)
  dedupe_key      TEXT,                            -- environment + revision + scope hash: one ACTIVE execution per key
  started_at      INTEGER,
  finished_at     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_executions_recent ON qa_executions (requested_at);
CREATE INDEX IF NOT EXISTS qa_executions_active ON qa_executions (status, environment);
CREATE UNIQUE INDEX IF NOT EXISTS qa_executions_dedupe ON qa_executions (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'dispatched', 'running');

CREATE TABLE IF NOT EXISTS qa_execution_events (
  id           INTEGER PRIMARY KEY,
  execution_id TEXT NOT NULL,
  at           INTEGER NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,                      -- ref:<hash> | system:<name>
  detail       TEXT NOT NULL DEFAULT '{}'          -- codes and counts only (≤ 1 KB)
);
CREATE INDEX IF NOT EXISTS qa_execution_events_exec ON qa_execution_events (execution_id, at);
CREATE TRIGGER IF NOT EXISTS qa_execution_events_append_only_u BEFORE UPDATE ON qa_execution_events BEGIN SELECT RAISE(ABORT, 'qa_execution_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS qa_execution_events_append_only_d BEFORE DELETE ON qa_execution_events BEGIN SELECT RAISE(ABORT, 'qa_execution_events is append-only'); END;

-- One test outcome. Append-only: a retest is a NEW row (retest_of = the earlier row), so a failure is never overwritten.
CREATE TABLE IF NOT EXISTS qa_test_results (
  id           TEXT PRIMARY KEY,
  execution_id TEXT,
  run_id       TEXT,                               -- qa_runs.id when it came with an automated report
  test_id      TEXT NOT NULL,                      -- inventory id (server/ops/qa-inventory.generated.js)
  environment  TEXT NOT NULL CHECK (environment IN ('ci', 'production', 'manual', 'local')),
  revision     TEXT,
  deployment   TEXT,
  def_hash     TEXT,                               -- the test definition's hash when it ran
  deps_hash    TEXT,                               -- the hash of what it depends on when it ran
  status       TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked', 'skipped', 'unverified', 'retest_required')),
  expected     TEXT,                               -- ≤ 500 chars
  actual       TEXT,                               -- ≤ 1 KB, redacted
  ms           INTEGER,
  cost_micros  INTEGER,                            -- paid API cost the run reported for this test (null = none reported)
  model        TEXT,                               -- model / provider version for AI evaluations
  provider     TEXT CHECK (provider IN ('mocked', 'real')),
  reviewer     TEXT,                               -- ref:<hash> of the human who recorded / confirmed it
  confirmed_at INTEGER,
  evidence     TEXT NOT NULL DEFAULT '[]',         -- JSON [qa_evidence ids]
  retest_of    TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_test_results_test ON qa_test_results (test_id, at);
CREATE INDEX IF NOT EXISTS qa_test_results_exec ON qa_test_results (execution_id);
CREATE INDEX IF NOT EXISTS qa_test_results_at ON qa_test_results (at);
CREATE TRIGGER IF NOT EXISTS qa_test_results_append_only_u BEFORE UPDATE ON qa_test_results BEGIN SELECT RAISE(ABORT, 'qa_test_results is append-only'); END;
CREATE TRIGGER IF NOT EXISTS qa_test_results_append_only_d BEFORE DELETE ON qa_test_results BEGIN SELECT RAISE(ABORT, 'qa_test_results is append-only'); END;

-- Defects AND backlog entries in one table. Status lives here (current); its whole history is qa_item_events.
-- A defect becomes 'verified' only from a passing qa_test_results row recorded after its fix (never from a merge).
-- Backlog entries never start work: their status changes only by a platform admin.
CREATE TABLE IF NOT EXISTS qa_items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('bug', 'regression', 'feature', 'ux', 'ai', 'performance', 'cost', 'tech_debt', 'observation')),
  title           TEXT NOT NULL,
  description     TEXT,
  expected        TEXT,
  actual          TEXT,
  steps           TEXT,
  area            TEXT,
  feature         TEXT,
  severity        TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  priority        TEXT CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  customer_impact TEXT,
  status          TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'fixed_pending_qa', 'verified', 'wont_fix', 'inbox', 'under_review', 'planned', 'awaiting_qa', 'released', 'deferred')),
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  test_ids        TEXT NOT NULL DEFAULT '[]',
  refs            TEXT NOT NULL DEFAULT '{}',      -- JSON { pr, commit, release }
  source_result   TEXT,                            -- the result it was created from
  fixed_at        INTEGER,                         -- when it entered fixed_pending_qa (verification needs a pass after this)
  verified_by     TEXT                             -- the passing qa_test_results id that verified it
);
CREATE INDEX IF NOT EXISTS qa_items_status ON qa_items (kind, status);
CREATE INDEX IF NOT EXISTS qa_items_recent ON qa_items (created_at);

CREATE TABLE IF NOT EXISTS qa_item_events (
  id      INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  type    TEXT NOT NULL,                           -- created | status | link | note | edit | retest | verified | reopened
  from_status TEXT,
  to_status   TEXT,
  detail  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS qa_item_events_item ON qa_item_events (item_id, at);
CREATE TRIGGER IF NOT EXISTS qa_item_events_append_only_u BEFORE UPDATE ON qa_item_events BEGIN SELECT RAISE(ABORT, 'qa_item_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS qa_item_events_append_only_d BEFORE DELETE ON qa_item_events BEGIN SELECT RAISE(ABORT, 'qa_item_events is append-only'); END;

-- Evidence for a result or an item. Text ≤ 8 KB redacted; screenshots ≤ 1 MB (byte-sniffed PNG/JPEG/WebP, base64).
-- Retention: images expire after qa_settings.evidence_days (default 90); the cron clears the bytes and keeps the row
-- (purged_at), so the record that evidence existed stays. CI artifacts are links only.
CREATE TABLE IF NOT EXISTS qa_evidence (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('result', 'item')),
  owner_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('screenshot', 'log', 'transcript', 'link', 'record', 'ai_assessment')),
  mime       TEXT,
  text       TEXT,
  data       TEXT,                                 -- base64 image bytes (cleared at expiry)
  bytes      INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  purged_at  INTEGER
);
CREATE INDEX IF NOT EXISTS qa_evidence_owner ON qa_evidence (owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS qa_evidence_expiry ON qa_evidence (expires_at);

-- QA settings (platform admins, reason + confirm, audited). A missing row = the default (all paid QA OFF).
CREATE TABLE IF NOT EXISTS qa_settings (
  key        TEXT PRIMARY KEY CHECK (key IN ('eval_daily_micros', 'eval_monthly_micros', 'paid_evals', 'evidence_days', 'schedule_production')),
  value      INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
