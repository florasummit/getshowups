# Operational activation of the Control Center: runbook + approvals (prepared 2026-11-20, nothing activated)

Production: b3522b5f (main 005d162). Founder alerts are off, QA ingestion is off, and no activation run has been
recorded. Everything here needs approval. The checklist is at the end.

## 1. QA ingestion from CI

See docs/QA_CI_SETUP.md: the token script, the GitHub environment `qa-ingest` (main only), the proposed workflow in
docs/ci-with-qa-report.yml, verification, and rollback. The existing `verify` job is unchanged and secret-free.

## 2. Founder alerts: controlled delivery test

How delivery works:
- **Who receives alerts:** admins in `PLATFORM_ADMIN_EMAILS` that `recipientAllowed()` delivers to now. While
  `MESSAGES_LIVE` is off, that means only addresses in `MESSAGE_TEST_RECIPIENTS`.
- **What can trigger one:** only the three alert kinds (calendar broken, booking page without times, messages
  failing) on a non-test, non-deleted business.

As of the 2026-11-20 00:00 UTC cron (which included the hourly calendar check), no business matches any of the three
kinds. The open Twilio incident is a generic failure, not an alert kind. **Enabling alerts today should therefore
send nothing on its own.** That is why the test send exists: it proves delivery without breaking a real account.

### Steps
1. **Precondition:** PR feat/ops-activation is merged and deployed (approval).
2. **Read-only check, alerts still off:**
   - In `/admin/control`, the Founder alerts panel says "Off · N of M admins would receive alerts now".
   - If N = 0: the founder's address is not on `MESSAGE_TEST_RECIPIENTS`. Approve adding it (Pages secret; the full
     comma-separated list must be re-entered, because a secret can't be read back), then redeploy.
3. **Enable** (approval): set `FOUNDER_ALERTS_ENABLED=true` on Pages (production), then redeploy.
   - The next cron returns `alerts: {enabled: true, recipients: N, candidates: 0, queued: 0}`, visible in a
     deployment tail.
4. **Test:** Control Center → Founder alerts → **Send test alert** → **Send test email**.
   - Expected on screen: "Test sent to N admin(s)."
   - The founder confirms the inbox: subject "GetShowUps alert: TEST (no action needed)" from `EMAIL_FROM`. Check spam.
5. **Evidence (read-only):**
   - an `email_outbox` row `alert:test:…` with status `sent`;
   - an `admin_audit` entry `alerts.test_sent`;
   - an `audit_log` entry `alert.test`.

### Impact, rollback, failures
- **Impact:** one email per deliverable admin per test. Afterwards, real alerts go to the same people when a
  business's calendar or messages break: at most 1 per business and kind per 6 hours, at most 10 per run plus a
  digest.
- **Rollback:** delete `FOUNDER_ALERTS_ENABLED` (or set it to anything other than `true`), then redeploy. There is no
  data to undo.
- **If the test is not delivered:** the panel shows the code.
  - `test_mode`: the admin is not on `MESSAGE_TEST_RECIPIENTS`.
  - `http_4xx` / `http_5xx`: a Resend problem.

  Nothing retries later in a burst: the outbox closes stale mail.

## 3. Incident inc_SCQKj1CNys20: Twilio `bad_signature` (read-only investigation)

**Confirmed (evidence):**
- **The event:** exactly one `sms.webhook_rejected` (`bad_signature`), audit seq 60, 2026-11-17 01:42:36 UTC,
  inbound webhook, no business.
- **Timing:** it came 43 s after the first build with Twilio credentials went live.
  - Build 784bf11 (PR #55) was built at 01:41:53 UTC.
  - The config record (seq 62) shows `twilio: false → true` for that build.
  - Before that build the route answered 503 and recorded nothing.
- **The source:** the post-release smoke test of PR #55 ran
  `curl -X POST https://getshowups.com/api/sms/twilio/inbound` at 01:42:30 UTC, with no body and no signature. Its
  checklist line was "twilio inbound unsigned (403)", and it got 403. The time and the expected result match.
- **No real traffic exists:**
  - no Twilio subaccounts (`sms_accounts` = 0), registrations (0) or senders;
  - no texting consents;
  - no inbound text ever stored (`thread_messages` holds 1 row, an email follow-up that was skipped);
  - no other webhook rejection, and no `sms.inbound_unrouted`, in the audit log.
- **No customer impact.** The rejection was correct behaviour.

**Hypotheses considered and why they are not needed:**
- **A Twilio number pointed at us with a URL or token mismatch.** No business number exists. A parent-account number
  would be signed with the parent token, pass verification and show up as `sms.inbound_unrouted`, and none exists.
  It would also recur; it hasn't in 3 days.
- **An internet probe.** Possible in general, but the exact match to our own command makes it unnecessary.

**What would add certainty (optional, read-only, owner):** Twilio Console → Monitor → Errors for 2026-11-17 01:40–01:45
UTC. Expected: no 11200/403 entry for getshowups.com. Our token has no Twilio access, and I did not use the
production credentials.

**Actions:**
- No Twilio change, and SMS stays off.
- The incident cannot be closed by hand (by design). It resolves itself as "no new failures" at about 2026-12-01
  01:42 UTC.
- Fix in feat/ops-activation: an unsigned request is recorded with outcome `info` (`reason: unsigned`) and never
  opens an incident. Signed-but-invalid (`bad_signature`) and `unknown_account` stay failures. Our smoke tests keep
  checking the 403.

## 4. Real-person 20-minute activation test

The script is docs/ACTIVATION_TEST.md: guided QA in the Control Center (journey `activation`), with a paper fallback.

**Exact approvals needed before the session:**

| # | Approval | Why | Effect / rollback |
| --- | --- | --- | --- |
| A1 | **Tester:** name, their own Google account email, written consent to screen recording. They have never seen GetShowUps. The business must be fictional or their own, never a customer's | The run measures a first-time owner | — |
| A2 | **Add the tester's email to `MESSAGE_TEST_RECIPIENTS`** (Pages secret; re-enter the full list), then redeploy | Lets their sandbox checkout through (Stripe test mode, card 4242…) and lets confirmation and owner emails reach them. Nobody else changes; public signup stays closed (`/api/enrollment` `{"open":false}`) | Remove the address and redeploy afterwards |
| A3 | **Date, time and observer** | The observer runs the guided QA timer on a separate screen | — |
| A4 | **Google Cloud:** confirm the OAuth consent screen is "In production" (unverified, 100-user cap). If it is "Testing", the tester's Google account must be added as a test user (a Google Cloud change) | Otherwise the tester can't connect their calendar | — |
| A5 | **Data created in production** (approved by running the test): one self-serve business, a Stripe **test** customer and subscription, a lead, an appointment, a Google event on the tester's own calendar, and a published site | It is the real flow | Afterwards: an admin marks the business test (audited; out of metrics, noindex). Nothing is deleted |

**During and after the session:**
1. Control check from a signed-out browser: `/api/enrollment` returns `{"open":false}`.
2. Afterwards, the admin marks the business test.
3. Remove the tester from `MESSAGE_TEST_RECIPIENTS` (A2 rollback).
4. Fill in docs/LAUNCH_READINESS.md §2a with the **measured** times. The Control Center Overview then shows
   "Activation: N min in the latest observer-recorded run".

## 5. Approval checklist (in order; each line is one approval)

| # | Action | Expected impact | Verification | Rollback |
| --- | --- | --- | --- | --- |
| 1 | Merge docs PR #87 | Redeploy of identical code (docs only) | build.json = merge commit; 7 customer pages byte-identical; cron 200 | Pages rollback to b3522b5f |
| 2 | Merge PR feat/ops-activation | New Founder alerts panel + `/api/platform/alerts` (admin only); unsigned Twilio requests stop counting as failures; CI writes qa-report.json (CI only) | Same smoke as #1; `/api/platform/alerts` 401 signed out; panel shows "Off"; inbound unsigned POST → 403 + `info` row | Pages rollback to the #1 deployment |
| 3 | GitHub environment `qa-ingest` (main only) + `QA_INGEST_URL` variable (owner, browser) | None until a token exists | Settings page shows the branch rule | Delete the environment |
| 4 | `scripts/qa-ingest-token.sh --apply`, then a redeploy (ride along with #2 if done first) | `/api/qa/runs` accepts the CI token | POST without token → 401 (was 503); no data written | Delete the Pages secret + redeploy → 503 |
| 5 | Commit docs/ci-with-qa-report.yml as `.github/workflows/ci.yml` (owner) | Each main push adds one mocked-provider QA run | PR CI has no `qa-report` job; on main: `201`, run visible in QA; re-run → `duplicate` | Revert the workflow commit |
| 6 | If the panel shows 0 deliverable: add the founder's address to `MESSAGE_TEST_RECIPIENTS` + redeploy | Founder becomes a test recipient (gets test-mode mail) | Panel: "1 of N admins would receive alerts now" | Remove + redeploy |
| 7 | `FOUNDER_ALERTS_ENABLED=true` + redeploy, then **Send test alert** | One TEST email now; real alerts from then on | Founder receives the TEST email; outbox row `sent`; audit `alerts.test_sent` | Unset + redeploy |
| 8 | Activation run approvals A1–A5 (§4) | One sandbox business created by the tester | Guided QA run finished; Overview shows measured minutes | Mark test; remove tester from `MESSAGE_TEST_RECIPIENTS` |
| 9 | Inc_SCQKj1CNys20: no action (optional Twilio console check) | — | Resolves by itself ~2026-12-01 | — |

Batching: each secret takes effect on the next deployment. Steps 4, 6 and 7 can be set before the merge in step 2 so
that one deployment picks them all up. Verify each item separately afterwards.
