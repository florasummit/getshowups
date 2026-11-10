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

### Managed websites + simpler dashboard (branch release/managed-websites, NOT deployed) (2026-11-10)
- Website engine: one server-side renderer (server/site-render.js) for /p/:id, connected domains and the owner's
  private preview. Script-free HTML with a strict CSP, mobile-first, SEO tags + LocalBusiness JSON-LD. Three styles,
  seven accent colours, logo/hero/gallery images, services with prices/descriptions, about, area, facts, search text.
  Every text goes through the claims filter.
- Content model: websites (private draft) + website_versions (every publish kept; restore = rollback).
  Unpublish keeps the content. A business's published legacy landing page stays live as version 1 when it first
  saves. The old landing API and React page were retired (one system).
- Images: browser-resized, byte-sniffed JPEG/PNG/WebP ≤ 1 MB, 30 per business, stored in D1 (no new
  infrastructure). Public only while a live version uses them.
- Hosting follows the plan: pilots are always hosted. Self-serve sites are hosted while paid (including past_due),
  then for 14 days after the paid period ends, then show "unavailable" (content kept; resubscribing restores).
- Domains: TXT ownership proof (_getshowups.<host>) → attach via the Cloudflare Pages domains API → CNAME → certificate
  + HTTPS check → Connected. Hostnames are globally unique; nothing is attached before proof; apex domains are steered
  to www with a forward. Middleware routes connected hosts; other paths redirect. Cron re-checks (bounded). Owners can
  disconnect, which detaches it while the content stays. **Live provider not configured** (needs CF_API_TOKEN /
  CF_ACCOUNT_ID / CF_PAGES_PROJECT, approval). Until then a verified domain waits in "verifying" and admin is flagged.
- Dashboard: Overview (website status, 3 stats, one next step, outcomes to record, upcoming), Appointments,
  Website, Settings. No internal counters; reminders read "activating soon". Billing appears only for billed businesses.
- PoolThru billing alert fixed at the root: an abandoned checkout had left an 'incomplete' placeholder (no
  subscription) and readiness treated it as a plan to fix. Billing now applies only to self-serve signups or real
  subscriptions, and checkout is refused for pilots (no placeholder rows). No financial records were changed.
- Attendance: showed ↔ no-show ↔ "not sure yet" (clear), always correctable. An Undo follows each mark.
  appointment_changes keeps the history, and counts come from the current status (no double counting).
- Test data: leads from @getshowups.com, platform admins or the business's own users count as tests automatically,
  and owners can mark or unmark them (test_marks). Tests are listed with a "Test" tag and excluded from dashboard and
  admin metrics. Nothing is deleted. PoolThru's 2 existing internal test bookings are excluded with no data change.
- Migration 0009 (additive): websites, website_versions, website_assets, website_domains, appointment_changes,
  test_marks, onboarding_marks.
- Onboarding: … hours → website (generated, edit + live preview) → address (GetShowUps / own domain / buy) →
  preview & publish (consent; or keep private) → done.
- PoolThru pilot: draft in docs/poolthru/website-draft.json; review and cutover plan in docs/poolthru/MIGRATION.md.
- Tests: 251 unit, 55 Playwright. Mocked: DNS, hosting provider, HTTPS probe, Stripe, Google. Not live-verified: the
  custom-domain provider calls.

### Customer-ready MVP: self-serve signup → checkout → guided onboarding (local, NOT deployed) (2026-11-10)
- Homepage: one Get started path (/dashboard?plan=founding), Sign in for existing customers, honest copy (no AI
  texting / missed-call / simulation claims; SMS and ads labelled coming soon), founding plan $499/month, no trial,
  ad spend separate. Meta descriptions updated.
- Account: Google sign-in (existing auth; Google-verified email, no passwords). Plan survives the OAuth round trip.
  Business name only, then checkout; one business per account.
- Billing: Stripe customer created first (idempotency key), duplicate-subscription guard against Stripe, open-session
  resume, cancel/decline handled, access follows the signed webhook; existing businesses unaffected.
- Onboarding (resumable, server-derived): details (phone, industry, towns, ZIPs, description, mode, timezone) →
  services (suggested, with prices) → calendar (existing OAuth; live health check, reconnect) → hours → landing page
  (draft from profile, live preview, publish only with explicit consent) → availability check → launch checklist.
- Dashboard: Next step card (readiness), plan-ended notice; admin attention flags: checkout_abandoned,
  cancel_scheduled, subscription_ended.
- Migration 0008 (additive): self_signups, business_profiles. Tested on the latest production backup: 2 new tables,
  33 existing unchanged, integrity ok; PoolThru has no self_signups row.
- Tests: 233 unit, 54 Playwright (selfserve.spec: full journey on desktop and phone with a local Stripe stand-in that
  sends Stripe-signed webhooks). Real Stripe sandbox: customer-first checkout, resume, duplicate guard all PASS.
  e2e mock calendars are now per business (fixed cross-spec slot races at the root).
- Needs approval: deploy + migration 0008; then a production sandbox journey with a temporary test business.


### Launch completion: release candidate on branch release/ads-mvp (2026-11-09), NOT pushed or deployed
- Production D1 backup taken (read-only export, 39 rows, kept locally in the session scratchpad, not committed).
  Migrations 0006 + 0007 applied twice to a restored copy: 12 new tables, all 21 existing tables byte-identical,
  integrity ok.
- Release switches added so deploying changes nothing customers see: ADS_ENABLED, GHL_ENABLED (plus the existing
  ADS_LIVE_LAUNCH, MESSAGES_LIVE). With all of them unset, the only visible change is the landing page card in Settings.
- Landing page: /p/:id from one template (headline, intro, services, area, owner-confirmed facts), the claims
  filter is shared with ads, and the owner publishes. Public only while published AND the business is bookable.
  "Book" opens the existing /book/:id with utm parameters kept. Ads drafts point to it once published.
- GoHighLevel Settings card (GHL_ENABLED only).
- Tests: 223 unit tests, 53 Playwright tests (landing.spec added).
- Release plan, each step needs approval: push branch (CI) → merge to main (auto-deploys) → apply 0006 then
  0007 on production → smoke checks (/, /dashboard, /book/poolthru-llc, /api/dashboard/ads → 404, /p/poolthru-llc → 404 until published) →
  PoolThru: publish landing page, one live test booking.


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
