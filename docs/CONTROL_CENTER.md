# QA & Account Operations Control Center

`/admin/control` (platform admins only). It finds customer-impacting failures, explains them with evidence, shows
where each customer is in their journey, and records automated and human QA results. It reads from records the
product already writes; it never changes a customer's account.

| PR | Contents | Migration |
| --- | --- | --- |
| #83 | Founder alerts (detectors: calendar, availability, comms); OFF by default | — |
| B1 (this) | Incident register, Account + Journey Inspector, overview, feature/journey registry, demo e2e | 0031 |
| B2 | Automated QA run history (Playwright results), guided human QA, activation timer, demo steps 6, 9, 11 | 0032 |
| Experience | Redesign + navigation (Overview · Incidents · Accounts · Integrations · Testing), investigation pages, step-by-step QA sessions with pause/resume and usability feedback | — |

## The founder experience (feat/control-center-experience)

Every screen is a URL, so Back, deep links and new tabs work: `?view=incidents|accounts|integrations|qa`,
`?incident=<id>`, `?business=<id>`, `?integration=<capability id>`, `?session=<qa run id>` (in progress),
`?run=<qa run id>` (review). After a navigation the page heading takes focus. Code: src/admin/Control.jsx (shell +
Overview), src/admin/control/ (Incidents, Accounts, Integrations, ui, lib), src/admin/Qa.jsx (Testing), styles in
src/admin/control.css (scoped `.cc`, existing tokens).

- **One vocabulary, defined and tested in server/ops/states.js** (the UI only displays it):
  - Integrations: Healthy (seen working recently) · Degraded · Failed (open failure or failed check) · Disabled (off on
    purpose, never "failed") · Setup required · Testing (test mode only) · Not verified (on, no evidence). Credentials
    alone are never "healthy".
  - Incidents: Active failure (failure in the last 24 h) · No new failures, awaiting verification (open, quiet, no
    success) · Recovered, success confirmed (`success_seen` / `connected`) · Closed, no new failures, not confirmed
    fixed (`no_new_failures`).
  - Triage: Act now vs Monitor, with the reason. A real customer's critical/high incident is never "monitor"; test
    accounts and medium platform-wide incidents with no business are.
  - Account readiness per area: Verified working · Configured, not verified · Enabled · Eligible · Test mode · Not set
    up · Disabled · Failed · Not applicable. Only a recorded success is "verified".
- **Overview:** status banner, clickable metrics (each opens the filtered list), **Needs attention** = every open
  incident + every flagged account in priority order (never "nothing needs action" while something is open),
  integrations that fail, testing status, "Before real customers" (approvals from the capability registry + the
  activation test), founder alerts, recent recoveries.
- **Incident investigation** (GET /api/platform/incidents?id=…): plain-English title (server/ops/explain.js), scope
  (platform-wide incidents get a platform next step, never "open the account"), first/last failure, occurrences, impact,
  confirmed cause vs "not determined" (hypotheses labelled), recovery explanation + incident history, the underlying
  audit events as codes, raw evidence only on request.
- **Accounts:** search by name or id, filters (needs help, affected, production, test), 25 per page. Inspector:
  readiness tiles, journey with plain reasons, open incidents, read-only calendar diagnosis, owner checklist + public
  pages, recent activity, links to Business Review and to a QA session for the account.
- **Integrations:** grouped by state; detail = what it does, configured / enabled / tested, last success and failure,
  affected incidents and businesses, the safe diagnostic where one exists (none invented).
- **Testing:** activation ("Not measured yet" until an observer finishes a real-person run) with the safe checklist,
  sessions in progress (Resume), journeys with their purpose, completed sessions, automated runs (or "CI isn't
  connected yet"). A session shows one step at a time (what to do, expected, what happened, Pass/Fail/Blocked/Not
  tested, usability Keep/Simplify/Change/Remove/Add + note, context questions, defects/improvements), saves each step
  on the server, can be paused and resumed at the first unrecorded step, and is finished explicitly (unrecorded steps =
  not tested → Incomplete). Usability is stored in the step's `answers` JSON (`u`, `un`): no migration.

## Incident register (server/ops/incidents.js, cron step `incidents`)

- **Detection** uses the founder-alert rules (`detectIncidents` in server/alerts.js) plus every other open failure
  event in `audit_log`, grouped by feature + business + action. Follow-up text failures count once, under the comms
  rule.
- **Deduplication:** at most one open row per `fingerprint` (a partial unique index). Repeat failures update
  `occurrences`, `last_seen` and `evidence`; they never add rows.
- **Resolution needs evidence.** The `resolution` field records which evidence:
  - `success_seen`: a later success for the same resource.
  - `connected`: the hourly calendar check found a calendar again.
  - `no_new_failures`: messages, which have no success signal. This is "no new failures in the window", not "fixed".
  - A quiet period with no traffic is **not** recovery.
- **Cause** comes from a fixed table (`CAUSES`) keyed by error code: `confirmed`, `suspected` or `unknown`. No cause
  is ever inferred. Impact and suggested recovery are also fixed text, per rule.
- **Evidence** is allowlisted: codes, counts, times and audit_log seqs, at most 2 KB. There is never free text or
  contact data.
- **Test businesses** are recorded and tagged `is_test`. They are never counted as customer impact. An unreadable
  test list means every new incident is tagged test.
- **Audit trail:** each open and resolve writes an `incident.opened` / `incident.resolved` event (capability
  `platform.incidents`).
- **Only real failures count.** An event becomes an incident only with outcome `failure`.
  - A request that was never from the provider is recorded as `info` and opens nothing. Example: a Twilio webhook
    with no `X-Twilio-Signature`, i.e. a probe or our own smoke test.
  - A signed request we can't verify (`bad_signature`, `unknown_account`) stays a failure: it may be a misconfigured
    number.
  - Incidents have no manual close. The first one (inc_SCQKj1CNys20, our own smoke test) resolves as "no new
    failures" after the 14-day window.

## Founder alerts panel (Overview; GET/POST /api/platform/alerts)

- **Status:** shows the switch and how many admins the launch gate would deliver to now (counts only, never
  addresses), plus the last alert email and its status.
- **Send test alert:** shown only while `FOUNDER_ALERTS_ENABLED` is on, after an inline confirm.
  - Sends one email labelled TEST to each deliverable admin, at once, through the real outbox, gate and Resend.
  - Creates no incident and touches no business.
  - At most one per 10 minutes, and 3 per hour per admin. Audited as `alerts.test_sent`.
- **Not delivered:** the panel shows the provider's error code. The runbook is in docs/OPERATIONAL_ACTIVATION.md.

## Account Inspector + Journey Inspector (server/ops/inspector.js, GET/POST /api/platform/inspector)

- **Contents:** identity, readiness (booking, calendar, website/hosting, messages gate and 7-day counts, voice gate,
  billing), open and resolved incidents, recent audit history, and a customer view. The customer view shows the
  owner's checklist exactly as the owner sees it, plus links to the public pages. Support never signs in as the
  customer.
- **Journey type** (`new` / `existing` / `invited` / `test`, plus incomplete and recovery flags) comes from records.
- **Step states:** completed, current, blocked, failed, skipped or unknown, each with a reason code.
- **"Diagnose calendar"** is read-only. It runs the booking engine's own lookup (token refresh + freeBusy) and
  returns a code and a count of open times. It never returns events or the account email, and it is **not**
  recorded as an availability event, so a support check never opens or closes an incident. It requires same-origin,
  is limited to 6 per 10 min per business, and is audited (`support.diagnose_calendar`).

## Registry (server/ops/journeys.js)

- Journeys and steps have stable ids. Each step names a registered feature (a capability id) and has its human-QA
  questions.
- Automated tests are linked by spec file + title prefix. The test id is `journey:spec:title-slug`, never a line
  number.
- Renaming means changing the title and keeping the id. A replaced id goes to `RETIRED` with `replacedBy`, so
  stored results keep their meaning.

## Demonstration (test/e2e/control-center.spec.js; local workerd, mocked Google, test business `e2e-cc`)

1. The booking page offers times.
2. A reversible fault is injected through the Google mock (`/__faults`, invalid grant).
3. The cron opens one critical incident: cause confirmed, evidence `reconnect_required`, tagged Test.
4. More failing lookups and two more cron runs still give the same single incident.
5. The account journey shows `booking_live` failed, and the diagnosis returns `reconnect_required`.
6. The fault is cleared: the lookup succeeds, the incident is resolved, and the UI shows "Recovered (success seen)".
7. A freeBusy fault is injected and diagnosed (`calendar_error`).

## Resource use (estimates, not measurements)

| Item | Estimate |
| --- | --- |
| `ops_incidents` row | ~0.5–1 KB. At 100 incidents/month that is under 1.2 MB/year; resolved rows are purged after 365 days |
| Cron step | Runs LAST in the cron. ~6 + 2×(open incidents) D1 queries per run; at most 150 open and 50 new incidents handled per run (the rest next run). The KV list runs once an hour (reused by alerts). Well under D1’s ~1,000 queries/request |
| Overview page | Same cost as Business Review (capability checks + customer rows), on demand only |
| Inspector | ~15 queries per account view; diagnosis = 1 token refresh + 1 freeBusy call, rate-limited |
| New services, AI agents, vendors | None |

## Activation / rollback

- **Activation:** apply 0031 (additive), then merge. Before 0031 is applied, the cron step returns
  `{ ready: false }` and every view shows an empty register.
- **Rollback:** redeploy the previous version. The table stays and is unused; nothing else changes.

## B2: QA history and guided human QA (server/ops/qa.js, migration 0032)

- **Automated runs:** `scripts/qa-report.mjs` reads Playwright's own JSON report and posts it to `POST /api/qa/runs`.
  - Auth is Bearer `QA_INGEST_TOKEN`. If it is unset the endpoint returns 503 and is off.
  - Stored: registry-linked tests plus failures, with the code revision, source (ci/local), provider
    (**mocked** vs **real**, never mixed), duration, a redacted error, and the CI run URL. Screenshots and traces stay
    as CI artifacts.
  - The run view shows failed results first, their related open incidents (matched by feature), and per-test retest
    history.
- **Guided human QA** runs on the same journey definitions. Each step shows the action and the expected result; the
  observer records what happened, a status (Pass / Fail / Blocked / Not tested) and answers to the context
  questions. Defects and improvements are captured separately.
  - The timed journey `activation` stores server-clock step splits and the total.
  - The tester is stored as a ref, never an email. Free text is capped and email/phone/token-redacted.
- **Activation** appears as measured only when an observer has finished an `activation` run. Automated tests never
  fill it.
- **CI hookup (needs the owner; exact safe setup in docs/QA_CI_SETUP.md):**
  1. Add to the CI workflow: `PLAYWRIGHT_JSON_OUTPUT_NAME=qa-report.json npx playwright test --reporter=list,json`,
     then `node scripts/qa-report.mjs qa-report.json`, with the secrets `QA_INGEST_URL` and `QA_INGEST_TOKEN`.
  2. Set `QA_INGEST_TOKEN` on Pages.

  Our GitHub token has no Workflows permission, so I did not change `.github/workflows`. Both steps need approval.
- **Retention:** automated runs 90 days, human runs 365 days; purged by the cron. Size estimate: about 15 stored rows
  per CI run (~3 KB), so 20 runs/day is about 5 MB over 90 days. Human runs are negligible.
