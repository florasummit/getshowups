# Release: PRs #32 → #33 → #34 (owner notices, customer cancel, policies, Resend feedback)

Baseline: main 1546ed1, production deployment 0be05d2b, migrations 0001–0017. Each step needs the owner's approval.
The new tables and indexes don't exist in production yet, and every column the code uses does (checked read-only 2026-11-15).

## Order (stop on any failure)

| Step | Action | Verify |
| --- | --- | --- |
| 0 | Record the D1 restore point: `wrangler d1 time-travel info getshowups-onboarding` | bookmark noted |
| 1 | Apply **0018** (indexes only) with `--remote` | `leads_created`, `appointments_created`, `appointment_changes_changed` exist |
| 2 | Merge **#32** at its reviewed head (`--match-head-commit`) → Pages deploys | smoke (below) + `GET /api/appointment/confirm?a=bad&k=x` → 404 |
| 3 | Retarget #33 to main (`gh pr edit 33 --base main`); CI green. Apply **0019**. Merge **#33** | `/api/book/poolthru-llc` has `policies`; `/api/dashboard/policies` → 401 |
| 4 | Retarget #34 to main; CI green. Apply **0020**. Merge **#34** | `POST /api/email/webhook` → 503 `not_configured` |
| 5 | Resend: add webhook `https://getshowups.com/api/email/webhook`, events `email.bounced` + `email.complained`. Put its signing secret into the Cloudflare **secret** `RESEND_WEBHOOK_SECRET`, then redeploy (Pages applies secrets to new deployments) | unsigned POST → 401; Resend "send test" → 200; Business Review `messaging.email_feedback` = live |

Smoke after every deploy (read-only):
- `build.json` commit is the expected one;
- `/` returns 200 and `/dashboard/appointments` returns 200;
- `/api/dashboard/me` and `/api/dashboard/appointment-cancel` return 401;
- `/api/book/poolthru-llc` returns 200;
- `/p/poolthru-llc` returns 200 with no noindex, and `/p/gsu-journey-test` returns 404;
- Business Review loads with no new incidents.

Unchanged: `MESSAGES_LIVE` stays off, so owner notices and customer messages reach `MESSAGE_TEST_RECIPIENTS` only. No other switch or secret changes.

## Rollback
- **Code:** in Cloudflare Pages, roll back to the previous production deployment (0be05d2b = before #32). The migrations stay, because they're additive and old code ignores the new tables and indexes. Never drop them.
- **Webhook:** disable the endpoint in Resend, or delete `RESEND_WEBHOOK_SECRET` and redeploy (the endpoint then returns 503 and Resend retries, then disables it).
- **Records written by the release stay:**
  - `email_outbox` rows, which are deduplicated and don't resend under old code;
  - `email_suppressions` rows, which old code ignores;
  - messages marked failed/bounced;
  - cancellations, which are real and are recorded in `appointment_changes` and `audit_log`.

## Known behaviour and residual risks (accepted)
- **Google removed the event, but saving the cancellation failed twice:**
  - the booking stays `booked` and the owner or customer sees "try again" (`cancel_incomplete`);
  - an open failure event shows in Business Review;
  - a retry finds the event gone and completes;
  - until that retry, reminders could still go out for that booking.
- **Cancel link:**
  - it's the HMAC-signed confirm link (tampered tokens get 404);
  - it works only while the appointment is booked and in the future, so it expires at the start time;
  - opening the link never cancels, only pressing the button does;
  - anyone holding the customer's email link can cancel, the same exposure as the existing confirm link;
  - it's rate-limited per IP.
- **Owner notices:**
  - one per item and member (outbox primary key);
  - overlapping cron runs share Resend's idempotency key, so only one email goes out;
  - only the last 2 hours are scanned: if the cron is down for more than 2 hours, older notices are skipped rather than sent late.
- **Webhook replays:**
  - outside 5 minutes they're refused;
  - inside 5 minutes they're harmless, because every write is conditional or `INSERT OR IGNORE`.
- **Suppression:**
  - it applies per business, as an address hash;
  - Resend's own suppression list is account-wide, and a send it suppresses comes back as `email.bounced` / Permanent (subType Suppressed), so it's handled the same way;
  - there's no unsuppress tool: a customer with a new address books with that address.

## Controlled live journey test (after step 5; GSU Journey Test only)

**Prerequisite (approval):** `MESSAGE_TEST_RECIPIENTS` includes the GSU owner account and a test inbox you control. Optionally add `bounced@resend.dev` and `complained@resend.dev` (Resend's test addresses) for steps 7–8.

GSU Journey Test is test-marked, so every message goes to test recipients only, whatever the switches say. Watch `email_outbox.to_email` and `messages`: no other address may receive anything.

1. Owner: Settings → *What customers should know* → save both notes.
2. `/book/gsu-journey-test`:
   - *Good to know* is shown;
   - book with the test inbox.
3. Within about 5 minutes:
   - the test inbox gets the confirmation (notes + "Can't make it?" link);
   - the owner gets **New booking**;
   - the Google event exists.
4. Click *Can't make it?* in the test inbox:
   - the page asks first, and no change happens on open;
   - **Yes, cancel**: the Google event is gone, and Google emails the attendee a cancellation;
   - the owner gets **Cancelled**;
   - `appointment_changes.changed_by = 'customer'`.
5. *Pick a new time*:
   - book again, with no details re-entered;
   - the owner gets **New booking**.
6. Details only, no booking: about 10–15 minutes later the owner gets **New lead … hasn't picked a time yet**.
7. Book as `bounced@resend.dev`:
   - the webhook fires and the message becomes `failed/bounced`;
   - an `email_suppressions` row is written;
   - the owner gets **Email … bounced**;
   - the next reminder is `skipped/suppressed`.
8. Book as `complained@resend.dev`:
   - suppression `complained`;
   - the owner gets **… asked not to get our emails**.
9. Cleanup: the owner cancels every remaining GSU booking from Appointments.

**Pass when:**
- every step matches;
- Business Review shows no new incidents;
- no PoolThru record changed.

GSU is a test business, so the new capabilities correctly stay "built and tested", not live-verified.

**Stop immediately if:**
- anything is sent to a non-test address;
- PoolThru data changes;
- a 5xx appears in the smoke checks.
