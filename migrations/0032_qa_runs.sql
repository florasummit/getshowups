-- QA history (Control Center B2, 2026-11-19; server/ops/qa.js). Automated runs (Playwright results posted by
-- scripts/qa-report.mjs from CI or a local run) and guided human QA runs share the journey/step ids of
-- server/ops/journeys.js. Bounded: automated runs keep registered (journey-linked) tests + failures only, 90 days;
-- human runs 365 days. Screenshots/traces stay as CI artifacts (artifacts_url), never in D1. Tester identity is a
-- ref (sha-256 prefix), never an email. Free text is length-capped and email/phone-redacted on write.
-- provider: 'mocked' (fake providers) vs 'real' (a real-provider verification) — never mixed in one run.
-- Additive and idempotent. Until applied, the QA views say "not available" and nothing else changes.
CREATE TABLE IF NOT EXISTS qa_runs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('automated', 'human')),
  source        TEXT NOT NULL,                 -- ci | local | human
  revision      TEXT,                          -- git commit the run tested
  journey       TEXT,                          -- human runs: the journey id
  customer      TEXT,                          -- human runs: the test business used (optional)
  provider      TEXT NOT NULL DEFAULT 'mocked' CHECK (provider IN ('mocked', 'real')),
  status        TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'blocked')),
  tester        TEXT,                          -- ref:<hash> of the admin who ran/recorded it
  summary       TEXT NOT NULL DEFAULT '{}',    -- counts (+ timing for timed journeys)
  artifacts_url TEXT,                          -- CI run page (screenshots, traces)
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS qa_runs_recent ON qa_runs (kind, started_at);
CREATE TABLE IF NOT EXISTS qa_results (
  run_id    TEXT NOT NULL,
  test_id   TEXT NOT NULL,                     -- registry test id, or <journey>.<step> for human runs
  journey   TEXT,
  step      TEXT,
  status    TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked', 'not_tested')),
  observed  TEXT,                              -- ≤ 500 chars, redacted (human observation / sanitized test error)
  answers   TEXT,                              -- human: JSON {question index: answer} ≤ 2 KB, redacted
  ms        INTEGER,                           -- automated: duration; human timed: time since the previous step
  at        INTEGER NOT NULL,
  PRIMARY KEY (run_id, test_id)
);
CREATE INDEX IF NOT EXISTS qa_results_test ON qa_results (test_id, at);
CREATE TABLE IF NOT EXISTS qa_findings (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  journey    TEXT,
  step       TEXT,
  type       TEXT NOT NULL CHECK (type IN ('defect', 'improvement')),
  severity   TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  text       TEXT NOT NULL,                    -- ≤ 1000 chars, redacted
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_findings_run ON qa_findings (run_id);
