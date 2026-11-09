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

### Advertising engine: built and tested locally, NOT deployed, no live ad calls (2026-11-09)
- Migration 0006 (new tables only): ad_profiles, ad_budget_approvals, ad_connections, ad_campaigns, ad_metrics_daily,
  ad_actions (audit + idempotency), ad_creatives, ai_usage, lead_attribution, ghl_links, meta_lead_events.
- Campaign spec (server/ads/spec.js) is the only input adapters accept: platform text limits, ZIP geo, https URL,
  and an unapproved-claims filter (guarantees, discounts, credentials, superlatives, reviews, before/after, speed).
- AI planner (server/ads/strategy.js): claude-opus-5-5, structured JSON output, refusal fallback, cost recorded against
  a $20/month per-business AI cap. Output is filtered, then drafts are validated. Without ANTHROPIC_API_KEY a
  labelled starter template is used (this is what e2e exercises).
- Spend guardrails: owner approves a monthly ceiling (checkbox), and approved campaigns' combined daily budgets can't
  exceed it. Editing an approved campaign returns it to draft. Live create/resume requires ADS_LIVE_LAUNCH=true
  (operator switch, needs approval), an approved campaign, budget room, monthly spend under the ceiling, and an active
  or trialing subscription once Stripe is configured. Campaigns are always created PAUSED; the owner presses Start.
- Non-spending path: "Check (no spend)" = Google validateOnly / Meta dry run.
- Optimizer (server/ads/optimizer.js, cron): deterministic; pauses on monthly ceiling, overspend or a missing approval;
  alerts on stale data or missing tracking; recommends budget cuts. Never raises spend, never resumes. Idempotent
  per campaign/rule/day, and an owner resume overrides it for that day.
- Adapters: Google Ads v26 (server/ads/google.js + /api/ads/google/*), Meta v27 (server/ads/meta.js +
  /api/ads/meta/* incl. lead webhook), creatives (OpenAI images, Runway video, R2 AD_ASSETS, quotas). All mocked in
  tests. Payload shapes marked UNVERIFIED in the code need a sandbox/test account.
- GoHighLevel (server/ghl.js): one-way copy of contacts and pipeline stage; GHL can own SMS (then our SMS is skipped
  as ghl_sms); workflow enrollment respects the message test gate. docs/DATA_OWNERSHIP.md.
- Attribution: ad links carry utm_campaign=<our campaign id>; booking-page leads are attributed only to the same
  business's campaign. Results: spend, qualified leads, booked, completed jobs, reported job value, cost per
  booking and per completed job (null when unmeasurable); verified payments and incremental revenue not measured.
- Pricing copy: proposed $499/month (labelled proposed). Billing uses the existing Stripe plan infra; it needs a
  $499 Stripe Price id.
- Tests: 217 unit tests (ads 21, ads-google 20, ads-meta 22, ghl 14) and 51 Playwright tests (ads.spec 3). Fixed a
  cross-spec slot race in modes.spec.
- Needs approval, in order: migration 0006 on production → deploy → Google OAuth redirect URIs + adwords scope +
  Ads API access → Meta app + App Review → ANTHROPIC_API_KEY / OPENAI_* / R2 bucket → GHL PIT → Stripe $499 Price
  → ADS_LIVE_LAUNCH=true (first real spend).


### Appointment modes: at_business / at_customer (local only, not deployed)
- [x] Migration 0005 (additive): service_settings, lead_addresses, appointment_outcomes
- [x] Business setting "Where do appointments happen?"; existing businesses stay at_business
- [x] at_customer: validated US service address; ZIP from the address drives service area; address on the
  Google Calendar event location; kept out of logs, events, and platform admin views
- [x] Mode-specific booking page, confirmation/reminder/rebook emails, confirm page, dashboard labels
- [x] Outcome model: visit happened (showed/no_show) separate from work completed; optional reported job value
  labelled as association, never as revenue caused by GetShowUps; platform shows incremental revenue as not measured
- [x] Tests: modes.test.js (14) + modes.spec.js (5); at_business regression suites unchanged
- Needs approval: run 0005 on production, deploy, set PoolThru (poolthru-llc) to at_customer.

## In progress

### Revenue engine (Level 2): built and tested locally, NOT deployed (2026-11-09)
- Lead follow-ups (+15 min, +24 h) with a signed "pick a time" link that resumes booking for the same lead.
- Booking confirmation + reminders (24 h, 2 h) with a signed "confirm I'll be there" link → appointment_confirmations.
- No-show: reopens the lead and sends a rebook invitation after 30 min (skipped if the owner corrects the outcome).
- Email via Resend (code existed; reused). SMS via Twilio (new; consent checkbox shown only when configured).
- Scheduler: workers/scheduler cron (every 5 min) → POST /api/cron/run (CRON_SECRET). Also runs onboarding follow-ups.
- Dashboard: Leads, Booked, Booking rate, Confirmed, Showed, No-shows, Show rate, Messages sent; automation card + toggle.
- Migration 0004 (new tables only). Privacy policy + DATA_REQUESTS.md updated for messages/SMS.
- Launch gate (fails closed): without MESSAGES_LIVE=true, messages go only to MESSAGE_TEST_RECIPIENTS (a secret);
  others are skipped as test_mode (lead messages) or held pending (account outbox). Dashboard shows "in testing".
- Tests: 127 unit (12 new in test/automation.test.js) + 39 Playwright (4 new). No live message has been sent.
- To go live (each needs approval): migration 0004 → deploy → Resend domain + RESEND_API_KEY/EMAIL_FROM →
  CRON_SECRET on Pages + scheduler Worker deploy → (later) Twilio + A2P 10DLC approval.

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

- 2026-11-09 00:53Z: launch release `9c1bcef` LIVE (deployment 2c7f07ff). D1 migrations 0002/0003 applied (14 tables);
  pre-release backup: Time Travel bookmark 0000000b-00000000-0000511e-1d9da13728f07191fe8dfeb5f824b61a + local export.
  New Google client active for sign-in/connect; PoolThru health `healthy`, `oauthClient: legacy`.
  Privacy requests: manual runbook in docs/DATA_REQUESTS.md (contact brandon@getshowups.com).
  2026-11-09: PoolThru on new client (M4 done). Canonical customer = `poolthru-llc` (self-serve duplicate of `poolthru`).
  Test booking verified + cleaned up; /admin verified. /privacy live; Google app In production; grant-safety fix
  (4b8c48f); poolthru-llc reconnected on production token; legacy fallback code removed (5f04af9).
  Next: after 2026-11-16 01:00Z verify poolthru-llc health, then remove legacy credentials (checklist in LAUNCH.md).

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
