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
functions/           Cloudflare Pages Functions. FILE PATH = ROUTE. Keep handlers thin
  api/admin/         Bearer ADMIN_API_TOKEN routes: google-invites (POST), google-health (GET)
  api/google/oauth/  Customer Google Calendar OAuth: start (GET/POST), callback (GET)
server/              Shared backend modules imported by functions/ (bundled by Pages)
  google-oauth.js    Config check, crypto (AES-GCM, PKCE, SHA-256), admin auth, token refresh, HTML/JSON responses
  invites.js         Single-use onboarding invites in D1 (atomic UPDATE…RETURNING)
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
- Customer identity comes from server-side records (invite row, KV key), never from client input alone.
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
