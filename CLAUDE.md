# GetShowUps: instructions for Claude Code

AI appointment-conversion platform for service businesses. Production: https://getshowups.com
(Cloudflare Pages project `getshowups`, deploys automatically from `main`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (frontend only; `/api/*` Functions do not run here) |
| `npm run verify` | **Run before every handoff.** Lint (warnings fail) → unit tests → production build → Functions compile |
| `npm run verify:all` | `verify` + Playwright browser smoke tests. Run before asking to commit |
| `npm test` | Unit/integration tests (`node --test`, real handlers, SQLite-backed fake D1, mocked Google) |
| `npm run test:e2e` | Playwright: full site + Functions on local workerd, fake credentials, Google mocked |
| `npm run check:functions` | `wrangler pages functions build` with the production compatibility date |

First-time setup: `npm ci && npx playwright install chromium`. Node ≥ 22.13 (CI uses 24).

## Architecture

```
src/                 React marketing site (Vite → dist/). Browser code only.
  components/        One component per section; reuse SectionHeading, Icon
  content/           Copy and data (site.js, simulation.js); edit copy here, not in components
  config/ghl.js      Public embed URLs from VITE_* env (booking calendar / GHL form)
  Root.jsx           Chooses marketing site, /dashboard, or /book/:id (app pages are lazy chunks)
  dashboard/         Sign-in → self-serve onboarding (Setup.jsx: business → plan → details → services → calendar →
                     hours → website → address → publish → launch; older businesses: business → calendar → hours) →
                     Home.jsx tabs: Overview · Appointments · Website (WebsiteTab, WebsiteEditor, DomainSettings) · Settings
  booking/           Public booking page /book/:id (details → time → booked)
  admin/             Platform console /admin (metrics, attention, customers, detail, invites, plans, email)
  lib/               api.js (fetch + formatting), connect.js (calendar connect hand-off)
  app.css            Styles for app pages (reuses index.css tokens)
functions/           Cloudflare Pages Functions. FILE PATH = ROUTE. Keep handlers thin
  api/admin/         Bearer ADMIN_API_TOKEN routes: google-invites (POST), google-health (GET), customers (POST: link existing business)
  api/google/oauth/  Customer Google Calendar connection: start (GET/POST), callback (GET)
  api/auth/          Dashboard sign-in: google/start, google/callback (openid+email), logout (POST)
  api/dashboard/     Session routes: me, calendar, overview (GET); business, hours, connect-link, outcome (POST)
  api/book/[customer]/  Public: index (GET slots), lead (POST), appointment (POST books on Google Calendar)
  api/platform/      Platform admin (Google session + PLATFORM_ADMIN_EMAILS): me, overview, customer, invites,
                     invite-action, status, plans, test-business. Every write is same-origin and audited.
  api/stripe/webhook Stripe events (signature verified, idempotent)
  api/appointment/confirm  Public signed "I'll be there" link (GET read-only page, POST records)
  api/cron/run       Bearer CRON_SECRET: send due messages, onboarding follow-ups, outbox (called by workers/scheduler)
  api/dashboard/automations  POST: turn automatic messages on/off
  api/dashboard/profile    Business details (phone, industry, description, services+prices, towns)
  api/dashboard/onboarding GET readiness checklist; POST check_availability | tested | finish
  api/dashboard/ads/  Ads: index (GET), profile, plan, budget, campaign (save/approve/validate/launch/pause/resume/remove), creative
  api/dashboard/ghl   GoHighLevel connection (GET status, POST save/disconnect); 404 unless GHL_ENABLED=true
  api/dashboard/website/ Website: index (GET state; POST save|publish|unpublish|restore|regenerate), preview (owner-only
                     HTML), assets (image upload), export (owner's content + images as JSON)
  api/dashboard/domain   Own domain: connect | check | disconnect.  api/dashboard/test-mark: mark a lead test / not test
  p/[customer]       Public website (server-rendered).  site-assets/[id]: website images.  _middleware.js: domain routing
  api/ads/google/     Google Ads connect: start, callback, accounts.  api/ads/meta/: start, callback, accounts, webhook (leads)
  api/invite         Public invitation preview; api/dashboard/{accept-invite,billing} for owners
server/              Shared backend modules imported by functions/ (bundled by Pages)
  google-oauth.js    Config check, crypto (AES-GCM, PKCE, SHA-256), admin auth, token refresh, HTML/JSON responses
  invites.js         Single-use onboarding invites in D1 (atomic UPDATE…RETURNING)
  auth.js            Sessions (SHA-256 in D1), requireSession({needCustomer, write}), same-origin check
  calendar.js        Google access: connect, freeBusy, createEvent/deleteEvent, checkConnection, slot math
  customers.js       Business validation/creation (ids never collide with stored connections), progress
  booking.js         Leads, qualification, double-booking-safe booking, outcomes, results
  public.js          Guard for the public booking API (only fully set-up businesses)
  ratelimit.js       D1 fixed-window rate limits (hashed IP / business keys, fails open)
  platform.js        Platform-admin authorization (PLATFORM_ADMIN_EMAILS) + audit()
  accounts.js        Account invitations (issue/peek/accept/resend/revoke) + onboarding follow-ups
  email.js           Email outbox + sendEmail(); delivers only via configured Resend (RESEND_API_KEY, EMAIL_FROM)
  messages.js        Lead follow-ups, confirmation, reminders, no-show rebook: schedule rows, re-check at send time
  sms.js             Twilio SMS (TWILIO_ACCOUNT_SID/AUTH_TOKEN + MESSAGING_SERVICE_SID or FROM); E.164 normalization
  links.js           HMAC-signed resume/confirm links (key derived from TOKEN_ENCRYPTION_KEY, nothing stored)
  ai-usage.js        AI website allowances per business/UTC day (tiers; AI_TESTING_BUSINESSES), 30-day cost ceiling
  stripe.js          Checkout, portal, webhook signature + idempotent event handling, MRR normalization
  events.js          track(): deduplicated analytics events (no personal data)
  metrics.js         Platform customer rows, attention flags, growth metrics (null when no data)
  ads/               access (who gets Ads: ADS_ENABLED + ADS_BUSINESSES), spec (validation + claims), strategy (AI plan), budget (owner ceiling), campaigns (service),
                     optimizer (pause/recommend only), google, meta, creative, connections, attribution
  ghl.js             GoHighLevel one-way sync (contacts, pipeline stages, optional SMS workflow)
  landing.js         approvedClaimsFor() (owner-approved claims). Legacy landing_pages rows still render as websites
  website.js         Website content (validate, generate), drafts, versions/rollback, hosting entitlement (hostingStatus)
  website-ai.js      AI website design: one Workers AI request (binding AI, model WEBSITE_MODEL) → copy + 3 designs;
                     revise (natural-language change) → 1 design. Facts from records only; claims + invented-number
                     filter; designs repaired via site-design.js; stored in website_generations; template fallback
  site-design.js     The design system the AI chooses from: 8 palettes (AA-checked), 5 font pairings, 4 hero / 3
                     services / 3 about layouts, shapes, section order, image refs (asset:<id> | stock:<id>).
                     validateDesign(), presetDesigns(), diversify() (3 designs never share hero/palette/fonts)
  site-designed.js   Renderer for content.design (escaped, script-free, self-hosted fonts/photos). Content without
                     a design still uses site-render.js unchanged, so existing sites look exactly the same
  stock-photos.js    Licensed photo library manifest (CC0, StockSnap via Openverse; creator + source recorded)
  site-render.js     The one renderer for business websites (escaped, script-free, CSP).  site-serve.js: public serving
  assets.js          Website images (byte-sniffed, size/count limits, published-only).  testdata.js: test-record rules
  testbusiness.js    Admin-marked test businesses (test_businesses): out of metrics; never live Ads/messaging/Stripe
  domains.js         Own domains: normalize, TXT proof, Pages domains API attach/detach, CNAME + HTTPS check, cron
  onboarding.js      Self-serve signup plan, ordered onboarding steps (derived from data), business profile, readiness
migrations/          D1 SQL, applied manually to production (see docs/WORKFLOW.md). Additive + idempotent only (a test enforces it)
workers/scheduler/   Cron Worker (own wrangler.toml, NOT the root) that POSTs /api/cron/run every 5 min
test/*.test.js       node:test unit/integration tests for functions/ and server/
test/e2e/            Playwright specs, fake fixtures, local server script, test-only wrangler config
docs/                WORKFLOW.md (how we build), STATUS.md (decisions, progress, next actions)
```

Production bindings live in the **Cloudflare dashboard**, not in a file:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`,
`ADMIN_API_TOKEN`, `VITE_GHL_BOOKING_URL`, KV `GOOGLE_TOKENS`, D1 `ONBOARDING_DB`.
Preview deployments have **no** bindings or secrets (backend routes return 503 there, by design).

## Conventions

- Plain JavaScript (ESM), React 19, no TypeScript, no CSS framework. Styles in `src/index.css` with tokens on `:root`.
- New API route → `functions/api/<area>/<name>.js` exporting `onRequestGet`/`onRequestPost`; logic in `server/`.
- Unexported methods do NOT get 405 from Pages: GET falls through to `index.html` (200), POST gets 405.
- Every new backend behaviour gets tests in `test/` (auth, isolation, failure paths, leak checks).
- Every new user-facing flow gets a Playwright smoke test in `test/e2e/`. Import `test` from `./test.js`
  (it blocks all external network). Mock Google with `context.route`.
- No new dependencies without a clear reason stated in the PR/summary.
- Marketing copy: no testimonials, logos, or performance claims. Describe only what works today; label anything not live
  as coming soon. Founding plan $499/month, no trial, ad spend separate. Get started → /dashboard?plan=founding.

## Security rules (non-negotiable)

- **Never add a root `wrangler.toml`/`wrangler.json`**: Pages would switch to file-based config and override dashboard bindings.
- Nothing secret in `VITE_*` or `src/`: it ships to browsers. Secrets live only in Cloudflare secrets.
- Never print, log, or return tokens, keys, client secrets, customer emails, or calendar/event data.
  Error responses use allowlisted codes only. Logs: status codes and error codes, never payloads.
- Customer identity comes from server-side records (session → customer_users, invite row, KV key), never from
  client input. Dashboard routes take NO customer parameter; use `requireSession()` and `session.customer.id`.
- Public booking: a lead can only be booked with its secret leadToken; slots must be offered by booking hours;
  the partial UNIQUE index on appointments(customer, start_at) is the double-booking guard. Never remove it.
- Every call to Google goes through `googleFetch()` (8 s timeout). Event creation uses our own event id so one
  retry is safe; on an unknown outcome the event is deleted before the slot is released.
- Public and sign-in endpoints call `hitByIp()` / `hit()` from server/ratelimit.js; add a rule for new ones.
- Platform admin access comes only from PLATFORM_ADMIN_EMAILS; customer membership never grants it. Audit every
  privileged write with `audit()`. Admin views show counts, never lead/appointment contact details.
- Never mark an email or text as sent unless the provider accepted it. Due messages without a provider are skipped
  (`no_provider`), never sent later in a burst. Texts only with recorded consent (sms_consents); consent is offered only
  when SMS is configured. Messages to leads re-check relevance at send time (`skipReason()`).
- Launch gate fails closed: unless `MESSAGES_LIVE` is exactly `true`, email/SMS go only to `MESSAGE_TEST_RECIPIENTS`
  (`recipientAllowed()` in server/email.js). Setting `MESSAGES_LIVE=true` requires approval.
- Never store card data or invent prices
  (plans reference Stripe Price ids). No automatic suspension; suspension is a manual, audited admin action.
- Metrics must be computed from real records; return null (shown as unavailable) when data is missing.
- Ads: campaigns are created PAUSED; live create/resume only with ADS_LIVE_LAUNCH=true (approval required), an owner
  budget approval, and room under it. With Stripe configured, LIVE launch/resume also needs an active subscription;
  sandbox (verified Google Ads test account) does not, so never-billed pilots (PoolThru) can test. Automation may pause or recommend, never raise budgets or resume. Every spec goes
  through validateSpec(); AI output never reaches a platform unvalidated. Ad mock origins are loopback-only test vars.
- Self-serve billing: when Stripe is configured and a plan is active, every new self-serve business gets a self_signups
  row (same batch as the business) and must pay before onboarding; access follows the verified webhook. Businesses
  without that row (PoolThru, invited, admin-created) keep the legacy setup and are never asked to pay. After onboarding,
  billing problems are dashboard notices (no automatic lock-out). Checkout creates the Stripe customer first
  (idempotency key), refuses if Stripe already has a subscription, and resumes an open session.
- STRIPE_API_MOCK_ORIGIN and STRIPE_LIVE_ENABLED: mock is loopback-only (e2e); live billing needs STRIPE_LIVE_ENABLED=true
  (approval). Only sk_test_/rk_test_ keys count as configured otherwise.
- Release switches (off unless exactly 'true'): ADS_ENABLED (master switch for the Ads tab + /api/dashboard/ads/* +
  /api/ads/* connect) AND ADS_BUSINESSES (comma-separated business ids, no wildcard; empty = nobody). Both are checked
  per business via adsEnabledFor() in server/ads/access.js after the session is loaded. ADS_LIVE_LAUNCH (real campaign create/resume), GHL_ENABLED (GHL routes, sync and SMS hand-off). Turning one on
  in production requires approval.
- Appointment modes (service_settings.appointment_mode): 'at_business' (default; customer comes in) and 'at_customer'
  (business visits; service address required, stored in lead_addresses, put on the calendar event location).
  appointments.status 'showed'/'no_show' = it happened or not; appointment_outcomes.work = job completed or not
  (arrival is never completion). value_cents is self-reported booking value: never call it revenue caused by
  GetShowUps. Service addresses never go to logs, events, or platform admin views. Booked times are start times
  (no arrival windows).
- Google ties one user's refresh tokens for a client to ONE grant: never revoke a token that a stored connection for the
  same Google account + client may still use. Use `revokeUnlessInUse()`; `revokeToken()` directly only when unshared.
- OAuth client migration: stored connections carry `clientId`; `oauthClient()` refreshes with the issuing client
  (GOOGLE_LEGACY_CLIENT_ID/SECRET for the previous one). Cross-client reconnects archive, never revoke.
- `GOOGLE_API_MOCK_ORIGIN` is test-only and honored only for http://127.0.0.1:port. Never set it in production.
- State-changing dashboard routes (POST) must check `isSameOrigin()`; GET routes must be read-only.
- Validate customer IDs with `CUSTOMER_RE` before any storage lookup.
- Google scopes are least-privilege (`calendar.events.owned`, `calendar.freebusy`). Adding a scope needs approval.
- Tests use the fake values in `test/e2e/fixtures.env` and mocked Google. Never real credentials.

- Websites: one renderer, no scripts on business sites, every text through the claims filter, drafts private until
  an explicit publish (confirm: true). Images only via assets.js. Hosting follows hostingStatus(); never delete content.
- Domains: never attach a hostname before its TXT proof; never claim "connected" without DNS pointing at us AND hosting reporting the domain active with a validated
  certificate (plus the HTTPS check where reachable); never touch
  a customer's DNS/MX. CF_API_TOKEN/CF_ACCOUNT_ID/CF_PAGES_PROJECT are production secrets (approval). DNS_API_MOCK_ORIGIN
  and CLOUDFLARE_API_MOCK_ORIGIN are loopback-only test vars.
- AI website design: the model only picks named options from site-design.js and writes prose; it never writes
  HTML/CSS/JS. Unknown options are repaired from presets. Stock photos: CC0 library only (public/site-stock,
  generic scenes, no identifiable people), never in the "Our work" gallery (owner photos only); the owner's
  uploaded main photo always beats a stock choice. Fonts are self-hosted OFL files in public/site-fonts.
- AI website copy: the model writes prose only; names, services, prices, area and phone always come from records.
  Every field passes the claims filter and the invented-number check, otherwise the template text is used. A
  generation never changes the draft or live site (apply → private draft; publish → live). Previews, design
  switches, edits and site visits never call the model. Limits: 10/day (rate limit) + MONTHLY_GENERATIONS per business.
  The production `AI` binding on the Pages project needs approval. AI_API_MOCK_ORIGIN is a loopback-only test var.
- Pilot / invited / admin-created businesses are never billed: no plan card, checkout refused (no placeholder rows).
- Test records (testdata.js) are listed with a tag and excluded from every count; never deleted.
- Test businesses (server/testbusiness.js, table test_businesses): marked/unmarked only by a platform admin via
  POST /api/platform/test-business (same-origin, confirm, audited). A marked business is listed with a Test tag but
  left out of every platform metric/count/MRR, and NEVER uses live operations whatever the global switches say:
  Google Ads test accounts only (liveFor() ignores ADS_LIVE_LAUNCH), messages only to MESSAGE_TEST_RECIPIENTS
  (recipientAllowed(..., { testOnly })), no Stripe checkout/portal with a live key. Unmarking never promotes sandbox
  data: anything created up to unmarked_at stays sandboxed and Ads connections must be chosen again. Fails closed
  (unreadable table → treated as test). Rows are never deleted. PoolThru and GetShowUps are real, never marked.
- Attendance changes are always reversible and recorded in appointment_changes.

## GitHub automation (PRs and CI)

All GitHub calls go through `scripts/gh.sh` (GitHub CLI + the credential git already uses, for one process).
Never run `gh auth login`, print the token, or put it in a file, URL, or commit. The repo is public.

```
git push -u origin <feature-branch>                       # never push to main without deploy approval
scripts/gh.sh pr create --base main --head <branch> --title "…" --body-file <file>   # body ends with the Claude Code line
scripts/gh.sh pr checks <n> --watch --fail-fast           # CI: "verify" job (lint, unit, build, Functions, Playwright)
scripts/gh.sh run view <run-id> --log-failed              # read the first failure, fix, push again (CI re-runs on push)
scripts/gh.sh pr view <n> --json headRefOid,mergeable,statusCheckRollup   # release readiness
```

- Allowed without asking (when the task asks for PR work): push feature branches, open/update PRs, comment on PRs,
  watch CI, read logs, push fixes. Still needs approval: merge, push to main (= production deploy), closing others' PRs,
  deleting branches, repo settings, token changes.
- Token: fine-grained PAT, repo florasummit/getshowups only. Needed: Contents R/W, Pull requests R/W, Actions read
  (+ Metadata read, automatic). Not needed: Administration, Secrets, Workflows, Actions write.
  "Resource not accessible by personal access token" = a permission above is missing; ask the owner, never work around it.
- CI runs on pull_request and on push to main/release/**. A feature branch without a PR has no CI.

## Requires explicit human approval

Commit · push · production deploy · `--remote` D1/KV writes · migrations on production ·
secret creation/rotation · Google Cloud changes · paid-service activation · deleting data or files ·
new OAuth scopes · live requests that touch customer data (read-only health check excepted when asked).

## Definition of done

1. Acceptance criteria in the task are met (see docs/WORKFLOW.md template).
2. `npm run verify:all` passes locally with zero warnings.
3. New behaviour has unit tests; new UI flows have Playwright coverage.
4. No secrets/customer data in code, tests, logs, or output; `git status` shows only intended files.
5. docs/STATUS.md updated (what changed, decisions, next action).
6. Summary to the human: files changed, test results, **mocked vs live-verified** clearly separated, what needs approval.

## Autonomous loop

CODE → `npm run verify` → read the first failure → DIAGNOSE root cause (do not weaken tests) → FIX →
re-run → repeat until green → `npm run verify:all` → report. Stop and ask only for the approval items above
or a genuinely ambiguous product decision.
