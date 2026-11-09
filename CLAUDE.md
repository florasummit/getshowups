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
  dashboard/         Sign-in → Setup (business, calendar, hours) → Home (results, outcomes) + Settings
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
                     invite-action, status, plans. Every write is same-origin and audited.
  api/stripe/webhook Stripe events (signature verified, idempotent)
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
  email.js           Email outbox; delivers only via configured Resend (RESEND_API_KEY, EMAIL_FROM)
  stripe.js          Checkout, portal, webhook signature + idempotent event handling, MRR normalization
  events.js          track(): deduplicated analytics events (no personal data)
  metrics.js         Platform customer rows, attention flags, growth metrics (null when no data)
migrations/          D1 SQL, applied manually to production (see docs/WORKFLOW.md)
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
- Marketing copy: no testimonials, logos, or performance claims; pricing labeled proposed; simulation labeled fictional.

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
- Never mark an email as sent unless the provider accepted it. Never store card data or invent prices
  (plans reference Stripe Price ids). No automatic suspension; suspension is a manual, audited admin action.
- Metrics must be computed from real records; return null (shown as unavailable) when data is missing.
- Google ties one user's refresh tokens for a client to ONE grant: never revoke a token that a stored connection for the
  same Google account + client may still use. Use `revokeUnlessInUse()`; `revokeToken()` directly only when unshared.
- OAuth client migration: stored connections carry `clientId`; `oauthClient()` refreshes with the issuing client
  (GOOGLE_LEGACY_CLIENT_ID/SECRET for the previous one). Cross-client reconnects archive, never revoke.
- `GOOGLE_API_MOCK_ORIGIN` is test-only and honored only for http://127.0.0.1:port. Never set it in production.
- State-changing dashboard routes (POST) must check `isSameOrigin()`; GET routes must be read-only.
- Validate customer IDs with `CUSTOMER_RE` before any storage lookup.
- Google scopes are least-privilege (`calendar.events.owned`, `calendar.freebusy`). Adding a scope needs approval.
- Tests use the fake values in `test/e2e/fixtures.env` and mocked Google. Never real credentials.

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
