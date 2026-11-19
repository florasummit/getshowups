# Proposal: founder alerts for critical operational failures

Status: **built in feat/founder-alerts (2026-11-19), OFF by default, nothing switched on.** Owner decision requested: approve the
scope below, then one small PR implements it behind an off-by-default switch. Activating it needs separate approval.

## Problem

Today every failure is **pull-only**: it appears in /admin/review (Business Review incidents) or on the owner's
dashboard, and only when someone looks. A paying customer can silently stop receiving bookings (e.g. a revoked Google
grant: the booking page shows no times; the owner sees "Needs reconnecting" only if they open the dashboard).

## Scope (three alert kinds, nothing else)

| Kind | Trigger (from existing records) | Debounce | Source today |
| --- | --- | --- | --- |
| **Calendar connection broken** | An active, onboarded, non-test business whose calendar status is `reconnect_required` or `token_refresh_failed`, or Business Review attention `calendar_disconnected` | Open ≥ 10 min (one cron cycle confirms it) | server/calendar.js status, server/metrics.js attention, server/ops/review.js incidents |
| **Booking slots unavailable because of an integration failure** (not "no free time") | ≥ 3 failed slot lookups for one business in 30 min, with no success since | 30-min window | **Gap:** GET /api/book/:id returns `unavailable` but records no event. Needs `recordEvent({ capability: 'calendar.google', resource: {type:'availability'}, outcome: 'failure' })`, at most one per business per 5 min (Agent B's area: functions/api/book/**) |
| **Communications delivery failure** | An open Business Review failure for the email/SMS/voice capabilities (provider rejected, bounced, unknown outcome, outbox stuck past its retry budget) | ≥ 3 failures/hour per capability, or 1 for a booking confirmation | recordEvent from Agent B's PR (capability ids and outcome codes listed in its report) |

Out of scope: owner-facing alerts (need `MESSAGES_LIVE`), SMS/phone paging, third-party monitoring services, uptime
pings, any automatic remediation.

## Design (reuses what exists; no new service, no new cost, no migration)

- **Where:** one step in the existing 5-minute cron (`/api/cron/run`), after the current scans: `founderAlerts(env, now)`
  in a new `server/alerts.js`. It reads the same data Business Review reads (it doesn't re-implement incident rules).
- **Who receives:** `PLATFORM_ADMIN_EMAILS` only. Never business owners, never leads.
- **How it sends:** the existing account outbox (server/email.js), so the launch gate applies unchanged:
  while `MESSAGES_LIVE` is off, it delivers only to addresses in `MESSAGE_TEST_RECIPIENTS` (add the founder's address
  there; config change, approval). Refused mail is closed as `test_mode`, never sent later.
- **Deduplication:** deterministic outbox id `alert:<kind>:<business>:<incident opened at>`. One email per incident,
  not per cron run. A "resolved" email when the incident closes (optional, same id scheme with `:resolved`).
- **Volume cap:** at most 10 alert emails per cron run; beyond that, one digest ("12 more open incidents") linking to
  /admin/review.
- **Content (no personal data):** kind, business id and name, capability, outcome code, first seen, last seen, link to
  `/admin/review` for that business. Never lead/customer names, emails, phones, addresses, event details, tokens.
- **Switch:** `FOUNDER_ALERTS_ENABLED` exactly `'true'` to run; default off (no behaviour change at deploy).
- **Observability:** each sent/suppressed alert is a `recordEvent({ capability: 'platform.alerts', outcome })`.
- **Cost:** within the existing Resend plan (a few emails a day at most). Queries: bounded by Business Review's
  measured cost (docs/OPERATIONS.md §6, 92 queries at 1,000 businesses); runs once per cron.

## Tests (in the implementing PR)

Per kind: fires once after the debounce; doesn't fire for test businesses, pilots in setup, or "no free time";
dedupes across runs; resolved notice once; cap + digest; recipients only from `PLATFORM_ADMIN_EMAILS`; gate refusal
is closed as `test_mode`; body contains no email/phone/name of a lead (leak check); switch off = nothing queued.

## Coordination

server/notify.js, functions/api/cron/run.js and functions/api/book/** are Agent B's (comms) area. Build after Agent
B's PR is reviewed, as a separate PR, so the two don't overlap. Estimated effort: about 1 engineering day including
tests.

## Approvals needed

1. Approve this scope (owner).
2. Add the founder's alert address to `MESSAGE_TEST_RECIPIENTS` (config) and set `FOUNDER_ALERTS_ENABLED=true`
   (production switch) after the PR is merged and deployed.
