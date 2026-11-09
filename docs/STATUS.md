# Status, decisions, next actions

_Update at the end of every task. Newest first._

## Current state (2026-11-08)

- Marketing site live at getshowups.com; Book a Demo embeds Google Calendar appointment schedule.
- Google Calendar OAuth onboarding live: single-use invites (D1), encrypted refresh tokens (KV).
- Customer **poolthru** connected; production health check `GET /api/admin/google-health?customer=poolthru`
  returned `healthy` (token refresh 200, freeBusy 200) on 2026-11-08 at deploy e780355.
- Development accelerator: `npm run verify`, `npm run verify:all`, GitHub Actions CI, Playwright smoke tests.
- Launch release incl. admin console, invitations, billing prep, analytics: **built and tested locally, not deployed**.

## In progress

### Launch release (awaiting approval — see docs/LAUNCH.md)
Everything below is **local and tested**, not in production.
- [x] Self-service onboarding, PoolThru linking, booking page, appointment engine, results dashboard
- [x] Hardening: rate limits, Google timeouts, idempotent event creation, stale-reservation recovery
- [x] Platform console `/admin`: customers, signup dates, sources, onboarding, calendar health (live check),
  booking activity, subscription/account status, attention flags, search, detail, audit trail
- [x] Onboarding ops: self-service, admin invitation, admin-assisted setup (one data model); expiring single-use
  invitations bound to one Google email; resend/revoke; follow-ups queued (email delivery not configured)
- [x] Billing prepared (inactive until Stripe keys + plans): Checkout with one-time trial, portal for
  upgrade/downgrade/cancel/reactivate, signed idempotent webhooks, out-of-order protection, statuses
  trialing/active/past_due/canceled + manual suspension (booking paused, billing still reachable)
- [x] Analytics events (deduplicated) + growth metrics: activation, first booking, conversion, show-up,
  retention, MRR/ARR/paying/trialing/revenue/churn from billing data; CAC/LTV/gross margin shown as unavailable
- [x] Tests: 108 unit/integration + 33 Playwright
- Not done: email provider, Stripe account/plans, public Google app verification, cancellation/reschedule,
  session/invite purge job, cron (follow-ups run when the admin console loads).

- Google Cloud migration M1+M2 done (new project `getshowups`, client `380394286094-cume4v…`); M3 (Cloudflare
  secrets) awaiting approval. Old project untouched. See docs/LAUNCH.md.

## Decisions

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-08 | No root wrangler config; bindings stay in the Cloudflare dashboard | A root config would override production bindings |
| 2026-11-08 | E2E runs real Functions on local workerd with fake creds; Google mocked; all external network blocked | Real runtime coverage without secrets or live calls |
| 2026-11-08 | CI uses no secrets; previews have no bindings | Safe for untrusted PRs |
| 2026-11-08 | D1 for invites, KV for encrypted tokens | D1 gives atomic single-use; KV is eventually consistent |
| 2026-11-08 | Scopes `calendar.events.owned` + `calendar.freebusy` | Least privilege, verified against Google docs |
| 2026-11-08 | Admin API = bearer `ADMIN_API_TOKEN` (stored in macOS Keychain `getshowups-admin-api-token`) | Simplest secure option until customer login exists |

## Known issues / gaps

- A direct link to `getshowups.com/#book-demo` does not scroll to the section (React renders after the
  browser's fragment scroll; the lazy calendar iframe then stays unloaded until scrolled). Low impact.
- `src/config/ghl.js` exports `isBookingConnected`/`isLeadFormConnected`, currently unused.
- No customer login yet; admin token is a single shared secret.
- GoHighLevel: only the `VITE_GHL_*` embed hooks exist. **No GHL account/API connection has been verified.**

## Next actions

1. **Customer dashboard & onboarding for PoolThru** (feature card to be written at PLAN step):
   login → connect Google Calendar → connection status → submit test lead → view availability → see bookings.
   First step: verify what GHL access actually exists before choosing CRM/SMS build-vs-reuse.
2. Then: lead capture → qualification → booking → reminders → show-up tracking.
