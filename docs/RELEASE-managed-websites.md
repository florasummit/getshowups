# Release: managed websites (branch release/managed-websites)

Every production step below needs explicit approval. Nothing has been pushed, merged, migrated or deployed.

## What changes in production

- New: website engine (/p/:id server-rendered, /site-assets/:id, hostname middleware), Website tab and editor,
  domain flow, Appointments tab with reversible outcomes, test-record tagging, website steps in onboarding.
- PoolThru: its published page stays live exactly as it is (it becomes version 1 when the owner first saves).
  The "Fix your plan" alert disappears. Its 2 internal test bookings are tagged "Test" and no longer counted.
  Legacy setup is still complete, so it stays on its dashboard. Booking page and calendar connection unchanged.
- Unchanged code: Stripe (server/stripe.js, webhook), messaging (messages, email, sms), ads, GHL, Google
  OAuth/calendar, auth, the public booking API, the scheduler worker. Billing behaviour change: checkout is
  refused (409 not_billed) for businesses that are not billed (pilots); self-serve billing is unchanged.
- Switches stay off: STRIPE_LIVE_ENABLED, MESSAGES_LIVE, ADS_ENABLED, ADS_LIVE_LAUNCH, GHL_ENABLED.
- Custom domains: the flow works up to "verified". Attaching to hosting needs CF_API_TOKEN, CF_ACCOUNT_ID and
  CF_PAGES_PROJECT (not set). Without them nothing is attached and the admin sees "domain_activation".

## Migration 0009 (additive)

- Adds 7 tables: websites, website_versions, website_assets, website_domains, appointment_changes, test_marks,
  onboarding_marks. No ALTER/UPDATE/DELETE/DROP (enforced by test).
- Verified 2026-11-10 on a fresh read-only export of production (35 tables): applied twice (idempotent),
  7 new empty tables, 35 existing tables byte-identical, integrity ok, 0 foreign-key violations. The release
  code run against that copy gives PoolThru: setup complete, no billing item, 0 counted / 2 tagged test leads,
  hosting exempt, live page unchanged.
- **Order:** migrate BEFORE deploying. The new code reads these tables on every dashboard load. The old code
  (6086128) never reads them, so migrating first is safe while the old code is still live.
- Risk: low. The only failure mode is a partial apply if the command is interrupted. Re-running is safe
  (IF NOT EXISTS).

## Steps

1. `git push -u origin release/managed-websites` → CI green (lint, unit, build, Functions, Playwright).
2. Backup: `npx wrangler d1 export getshowups-onboarding --remote --output=<backup>.sql`. Restore-test it
   locally (35 tables, integrity ok).
3. Confirm the target: `getshowups-onboarding` (uuid 8137dd39…), the database bound to the Pages project.
4. `npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0009_websites.sql`
5. Verify: 42 app tables, 7 new tables empty, integrity_check ok, PoolThru counts unchanged
   (2 appointments, 2 leads, landing page published).
6. Fast-forward main to the release head and push → Pages deploys automatically. Confirm the deployment succeeded.

## Production smoke tests (read-only; no bookings, no data changes)

| Check | Expected |
| --- | --- |
| GET / | 200; "website" copy present |
| GET /dashboard, /dashboard/website | 200 (app shell) |
| GET /p/poolthru-llc | 200, server-rendered HTML, CSP `default-src 'none'`, canonical https://getshowups.com/p/poolthru-llc, current headline ("Service") |
| GET /p/does-not-exist | 404 "This website isn't available" |
| GET /site-assets/0000…(32 hex) | 404 |
| GET /book/poolthru-llc, GET /api/book/poolthru-llc | 200, slots offered, mode at_business (no booking made) |
| Unauthenticated GET /api/dashboard/{website,domain,overview}, /api/dashboard/website/preview | 401 |
| Cross-site POST /api/dashboard/{website,domain,test-mark,outcome} | 403 |
| POST /api/stripe/webhook unsigned | 400 invalid_signature (unchanged) |
| /api/dashboard/ads, GHL routes | 404 (switches off) |
| Unknown Host header to the Pages project | not reachable (Pages serves only attached hostnames) |
| Production DB after deploy | PoolThru rows identical to the pre-deploy export; 0 rows in website_domains |
| Cron run (scheduler) | 200 with `domains: {}` |

## Rollback

- Code: redeploy 6086128 (Cloudflare dashboard → Pages → getshowups → Deployments → that deployment →
  Rollback), or revert the merge on main. The 0009 tables can stay; 6086128 ignores them.
- Data: nothing existing is modified by the release. If needed, restore from the step-2 export (only after a
  failure that touched data, which this release does not do).
- Domains: no domain can be attached without the provider credentials, so a rollback has no DNS impact.

## Activating real custom domains (separate approval)

Missing:
1. An API token scoped to **Account → Cloudflare Pages → Edit** for this account only. Store it as the Pages
   secret `CF_API_TOKEN`, plus vars `CF_ACCOUNT_ID` and `CF_PAGES_PROJECT=getshowups`.
2. One real end-to-end check with a domain you control (e.g. a spare subdomain): TXT proof → attach →
   CNAME to getshowups.pages.dev → status active → "Connected". Not done yet: mock-tested only.

Cloudflare facts (docs read 2026-11-10):
- Pages custom domains: limit per project Free 100 / Pro 250 / Business 500 / Enterprise 500+. No price is
  listed for Pages custom domains.
- Subdomains on any DNS host: CNAME to `<project>.pages.dev`, added in Pages first. Adding the CNAME before
  the domain is attached gives a 522 error, so the product asks for the CNAME only after attaching.
- Bare (apex) domains work only if the domain is a zone on our Cloudflare account, so the product uses www plus
  a forward.
- Certificates are issued automatically (Google Trust Services or Let's Encrypt). Customer CAA records must
  allow them.
- Beyond the per-project limit: Cloudflare for SaaS includes 100 hostnames, then $0.10/hostname/month.
  Apex proxying there is an Enterprise add-on.
- Not verifiable from here: the account's plan and the live domains API response. wrangler's saved login is
  not accepted for direct API calls (401/403). The Pages project currently serves getshowups.pages.dev and
  getshowups.com.
