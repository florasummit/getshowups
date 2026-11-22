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
  content/           Copy and data (site.js; demo.js = the homepage "See it work" demo, simulated, no API calls);
                     edit copy here, not in components. lib/analytics.js: homepage funnel events, in-page only (no sender)
  config/ghl.js      Public embed URLs from VITE_* env (booking calendar / GHL form)
  Root.jsx           Chooses marketing site, /dashboard, or /book/:id (app pages are lazy chunks)
  dashboard/         Sign-in → self-serve onboarding (Setup.jsx: business → plan → details → services → calendar →
                     hours → website → address → publish → launch; older businesses: business → calendar → hours) →
                     Home.jsx tabs: Overview · Appointments · Website (WebsiteTab, WebsiteEditor, DomainSettings) · Settings
  booking/           Public booking page /book/:id (details → time → booked)
  admin/             Platform console /admin (metrics, attention, customers, detail, invites, plans, email); Control
                     Center /admin/control: Control.jsx (shell + Overview), control/ (Incidents, Accounts, Integrations,
                     ui, lib: URL state), Qa.jsx (Testing), control.css. Labels/states come from server/ops/states.js
  lib/               api.js (fetch + formatting), connect.js (calendar connect hand-off)
  app.css            Styles for app pages (reuses index.css tokens)
functions/           Cloudflare Pages Functions. FILE PATH = ROUTE. Keep handlers thin
  api/admin/         Bearer ADMIN_API_TOKEN routes: google-invites (POST), google-health (GET), customers (POST: link existing business)
  api/google/oauth/  Customer Google Calendar connection: start (GET/POST), callback (GET)
  api/auth/          Dashboard sign-in: google/start, google/callback (openid+email), logout (POST)
  api/dashboard/     Session routes: me, calendar, overview (GET); business, hours, connect-link, outcome (POST)
  api/book/[customer]/  Public: index (GET slots), lead (POST), appointment (POST books on Google Calendar)
  api/platform/      Platform admin (Google session + PLATFORM_ADMIN_EMAILS): me, overview, customer, invites,
                     invite-action, status, plans, test-business, alerts (founder alert status + TEST email). Every write is same-origin and audited.
  api/stripe/webhook Stripe events (signature verified, idempotent)
  api/email/webhook  Resend delivery feedback (Svix signature, 5-min tolerance; 503 until RESEND_WEBHOOK_SECRET)
  api/appointment/confirm  Public signed "I'll be there" link (GET read-only page, POST records); &do=cancel: customer cancels
                     (same cancelAppointment; lead reopened; "Pick a new time" via the signed lead link)
  api/cron/run       Bearer CRON_SECRET: send due messages, onboarding follow-ups, outbox (called by workers/scheduler)
  api/dashboard/automations  POST: turn automatic messages on/off
  api/dashboard/followups/   Follow-ups: index (GET inbox+counts+setup; POST settings|automations), thread (GET; POST
                     reply|takeover|release|done|close), texting (POST save details | approve with confirm)
  api/sms/twilio/    inbound (signed; idempotent per MessageSid), status (signed + per-message signed token)
  api/platform/messaging  Admin: GET counts only; POST record provider-reported registration status / sender (audited)
  sms-terms/[customer]  Public texting program terms (A2P disclosures) from records
  api/dashboard/policies   What customers should know (GET/POST beforeVisit, cancellation ≤300 chars)
  api/dashboard/profile    Business details (phone, industry, description, services+prices, towns)
  api/dashboard/receptionist/voices  GET the active provider's voice catalog (admin: ?provider=, &refresh=1)
  api/receptionist/[customer]/voice-connect | voice-tool | voice-session  Customer voice sessions on OpenAI/ElevenLabs (server/voice/customer.js)
  api/platform/voice-provider  Admin Console voice-provider management for ANY business (server/voice/admin.js; /admin/voice-lab)
  api/dashboard/onboarding GET readiness checklist; POST check_availability | tested | finish
  api/dashboard/ads/  Ads: index (GET), profile, plan, budget, campaign (save/approve/validate/launch/pause/resume/remove), creative
  api/dashboard/ghl   GoHighLevel connection (GET status, POST save/disconnect); 404 unless GHL_ENABLED=true
  api/dashboard/ai-key  GET (provider + last 4) · POST save (validated) | remove
  api/dashboard/ai-rules Teach Your AI: GET state · POST save|teach|apply|simulate|publish|rollback|reset (404 unless released)
  api/dashboard/website/import  GET latest import; POST start (url, confirm) | apply (importId, fields, photos)
  api/dashboard/website/ Website: index (GET state; POST save|publish|unpublish|restore|regenerate), preview (owner-only
                     HTML), assets (image upload), export (owner's content + images as JSON)
  api/dashboard/domain   Own domain: connect | check | disconnect.  api/dashboard/test-mark: mark a lead test / not test
  p/[customer]       Public website (server-rendered).  site-assets/[id]: website images.  _middleware.js: domain routing
  api/ads/google/     Google Ads connect: start, callback, accounts (+ billing status), disconnect.  api/ads/meta/: start, callback, accounts, webhook (leads)
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
  policies.js        What customers should know (business_policies, 0019): booking page + confirmation/24 h reminder;
                     claims-filtered; public reads fail soft (policiesOrEmpty) so a missing table never breaks booking
  email-feedback.js  Resend webhook (Svix-signed): permanent bounce/complaint → email_suppressions (0020, hashes), message
                     failed/bounced, owner_bounce notice; sender skips suppressed addresses ('suppressed')
  notify.js          Owner notices (cron scan): new booking / customer cancellation / lead unbooked after 10 min → each member, once
  sms.js             Twilio credentials check (TWILIO_ACCOUNT_SID/AUTH_TOKEN) + E.164 normalization
  followups/         Lead-to-booking engine (migration 0024; everything no-ops until it is applied, existing flows unchanged):
                     settings (readiness, owner preferences, quiet hours, smsReadiness = the ONE rule for texting),
                     engine (ingestLead source adapter, inbound texts, replies, sendQueued with every check, owner inbox),
                     assistant (fixed STOP/START/HELP/human/cancel handling + constrained included-model replies, checked:
                     no invented numbers/prices, no commitments/times/links/claims; fallback = fixed safe reply + owner
                     asked), transport (Twilio with the business's OWN sender + signed status callbacks; email via Resend),
                     registration (A2P 10DLC facts + owner attestation; provider status recorded only by a platform admin),
                     twilio (ONE parent account, ONE subaccount PER BUSINESS, migration 0025: subaccount token sealed
                     AES-GCM/HKDF bound to business+SID; parent creds for v2010 resources of a subaccount, subaccount
                     creds for trusthub/messaging; webhooks verified per AccountSid), provisioning (A2P via Twilio APIs,
                     one audited admin step at a time: low_volume_standard (EIN) or sole_proprietor (no EIN, OTP);
                     submit/paid steps need TWILIO_REGISTRATION_SUBMIT=true + approve; unknown outcomes never resent;
                     'approved' only when Twilio reports the campaign VERIFIED), ops (admin counts, Business Review)
  links.js           HMAC-signed resume/confirm links (key derived from TOKEN_ENCRYPTION_KEY, nothing stored)
  intelligence/      Teach Your AI engine (schema, understand, decide, compile, teach, simulate, store, access, providers)
  ai-usage.js        AI website allowances per business/UTC day (tiers; AI_TESTING_BUSINESSES), 30-day cost ceiling
  stripe.js          Checkout, portal, webhook signature + idempotent event handling, MRR normalization
  events.js          track(): deduplicated analytics events (no personal data)
  metrics.js         Platform customer rows, attention flags, growth metrics (null when no data)
  ads/               access (who gets Ads: ADS_ENABLED + ADS_BUSINESSES), conversions (Data Manager feedback, flag), spec (validation + claims), strategy (AI plan), budget (owner ceiling), campaigns (service),
                     optimizer (pause/recommend only), google, meta, creative, connections, attribution
  ghl.js             GoHighLevel one-way sync (contacts, pipeline stages, optional SMS workflow)
  landing.js         approvedClaimsFor() (owner-approved claims). Legacy landing_pages rows still render as websites
  website.js         Website content (validate, generate), drafts, versions/rollback, hosting entitlement (hostingStatus)
  website-ai.js      AI website design: one Workers AI request (binding AI, model WEBSITE_MODEL) → copy + 3 designs;
                     revise (natural-language change) → 1 design. Facts from records only; claims + invented-number
                     filter; designs repaired via site-design.js; stored in website_generations; template fallback
  ai-credentials.js  Bring-your-own Claude/OpenAI key (0022): validated read-only before storing; AES-GCM under an HKDF
                     subkey of TOKEN_ENCRYPTION_KEY bound to (customer, provider); only provider + last 4 ever returned
  ai-providers.js    Own-key website writer: Claude (SDK, claude-opus-5-5, output_config json_schema; NO server-side fallback:
                     the chosen/reserved model is the only one that runs, recorded and priced as that model)
                     or OpenAI (strict json_schema); same mergeGenerated/claims/number/design-repair pipeline; own-key
                     errors are reported (never a silent fallback); cost recorded as 0 (billed to the owner's account)
  site-spec.js       AI-designed sites, spec v2 (content.site): pages, composed sections, theme tokens. validateSpec() is the
                     security boundary: enums/clamps, AA contrast repair, own-or-stock images, links only book/page/section,
                     services/prices/towns/phone from records, claims + invented-number filter, limits. site-render-v2.js
                     renders it (escaped, no scripts but JSON-LD, CSS-only motion, multi-page: /p/<id>/<page>, domain /<page>)
                     'composition' section: ≤10 blocks (heading/text/button/media/mark) on a 12-col grid for the first
                     screen + signature moments; phone layout derived (m.order/span/hide); text over photos made readable
                     (white+scrim inside, raised card partly over; desktop only); CSS only from validated numbers/enums and
                     only on pages that use it. Invalid model choices are REPORTED (invalid_choice/empty_block), never
                     silently defaulted. Nav Book button always on. spec.direction = one-line art direction (not rendered).
                     Services are referenced by STABLE ID (items[].serviceId → content.services[].id, AI-designed content
                     only), never by position: website.js assignServiceIds (kept / inherited by name from `prior` / new
                     random) and withServiceRefs (read-time, deterministic upgrade of pre-id drafts and versions). The
                     model still sees positions in FACTS.services; ai-designer.js servicesForModel converts at that edge.
                     Owner editing (src/dashboard/SiteStudio.jsx): the preview IS the editor: renderV2({editing:true}) (owner
                     preview route only, never public) marks data-edit / data-btn / data-img = "<section id>|<field path>"
                     (services: "svc|<service id>.<field>"); the dashboard edits text in place (contenteditable from outside
                     the frame), buttons/photos in a small panel, sections via a compact bar (name · ↑ ↓ · ⋯ menu); Preview
                     mode removes all of it. Sections may be `hidden` (not rendered publicly; the
                     first screen cannot be); contact `form` none|contact|quote posts to /api/site-form/<id>
                     (server/site-form.js: signed render time + trap field + rate limits → createLead, the existing
                     leads table); saves AND publishes carry baseUpdatedAt (409 conflict, never a silent overwrite; the classic
                     WebsiteEditor too); a version restore checkpoints the draft first (before_version_restore); live preview =
                     POST /api/dashboard/website/preview (validated, nothing stored). Owners may have 10 pages (AI: 5).
  ai-designer.js     Conversational designer on the owner's own key: one turn → { reply, site } → validateSpec →
                     design-checks.js (hard: unusable → error ai_design_incomplete, nothing saved; soft: generic first
                     screen / repeated sections / "different" not different) → at most ONE automatic revision (each call
                     reserved against the monthly limit) → PRIVATE draft (undo keeps the previous design). Raw answers kept
                     redacted in website_generations.content.raw, purged after 30 days (cron). design-blocks.js: the model's
                     place/look token form. action 'different' = fresh design that must differ. Imported text = quoted
                     data; turns in website_design_turns (0023). Route streams NDJSON progress (designer.js)
  site-design.js     The design system the AI chooses from: 8 palettes (AA-checked), 5 font pairings, 4 hero / 3
                     services / 3 about layouts, shapes, section order, image refs (asset:<id> | stock:<id>).
                     validateDesign(), presetDesigns(), diversify() (3 designs never share hero/palette/fonts)
  site-designed.js   Renderer for content.design (escaped, script-free, self-hosted fonts/photos). Content without
                     a design still uses site-render.js unchanged, so existing sites look exactly the same
  stock-photos.js    Licensed photo library manifest (CC0, StockSnap via Openverse; creator + source recorded)
  site-import.js     Website import: public pages of the owner's existing site (robots.txt honoured, same site only, public
                     hosts only via normalizeWebsiteUrl, ≤12 pages, size/time caps, manual redirects re-checked), tolerant
                     HTML extraction (no scripts), suggestContent (only text found on the site). website-import.js: stored
                     imports (0021) and applyImport → PRIVATE draft (fields through validateContent; photos only from that
                     import, via saveAsset). Imported text is untrusted data, never instructions
  site-render.js     The one renderer for business websites (escaped, script-free, CSP).  site-serve.js: public serving
  assets.js          Website images (byte-sniffed, size/count limits, published-only).  testdata.js: test-record rules
  url.js             normalizeWebsiteUrl(): the one rule for website URLs owners type (https default, safe hosts)
  testbusiness.js    Admin-marked test businesses (test_businesses): out of metrics; never live Ads/messaging/Stripe
  business-accounts.js Account types (0034, docs/ACCOUNT_TYPES.md): internal_live | sandbox | customer; billing
                     complimentary|stripe, environment production|sandbox, provider_spend allowed|blocked. Complimentary =
                     hosted, no checkout, no billing hold, lifecycle 'complimentary', never paying/MRR, never auto-resynced;
                     sandbox sets the test mark. Admin-only route /api/platform/account, audited from→to. PoolThru = internal_live
  domains.js         Own domains: normalize, TXT proof, Pages domains API attach/detach, CNAME + HTTPS check, cron
  onboarding.js      Self-serve signup plan, ordered onboarding steps (derived from data), business profile, readiness
migrations/          D1 SQL, applied manually to production (see docs/WORKFLOW.md). Additive + idempotent only (a test enforces it)
workers/scheduler/   Cron Worker (own wrangler.toml, NOT the root) that POSTs /api/cron/run every 5 min
test/*.test.js       node:test unit/integration tests for functions/ and server/
test/e2e/            Playwright specs, fake fixtures, local server script, test-only wrangler config.
                     journey.js + journey.spec.js: state-aware NEW-customer journey (detect → act → verify, fixture
                     testers listed in serve.sh, mock Google/Stripe); docs/LAUNCH_DECISION.md = readiness verdict
docs/                WORKFLOW.md (how we build), STATUS.md (decisions, progress, next actions)
```

Production bindings live in the **Cloudflare dashboard**, not in a file:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`,
`ADMIN_API_TOKEN`, `VITE_GHL_BOOKING_URL`, KV `GOOGLE_TOKENS`, D1 `ONBOARDING_DB`.
Preview deployments have **no** bindings or secrets (backend routes return 503 there, by design).

## Conventions

- Plain JavaScript (ESM), React 19, no TypeScript, no CSS framework. Styles in `src/index.css` with tokens on `:root`.
  Flagship visual system (2026-11-21): the orange logo is the only brand mark (never recolour or redraw Logo.jsx);
  one gradient "beam" token (`--beam`, logo orange → sky → lavender) used for the hero canvas and thin accent edges
  only; three soft tints (`--sky-*`, `--mint-*`, `--lav-*`) on the cool canvas `--cloud`; three shadow tiers
  (`--shadow-sm` / `--shadow-card` / `--shadow-float`); primary action = ink. Marketing sections explain with
  product-derived visuals built from site.js data (Story.jsx), copy one line per idea (flagship.spec guards the
  budget). No Prettier: single quotes, no semicolons, long lines (oxlint only).
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
- Sign-in routing (server/auth.js safeNext + api/auth/google/callback.js landing()): sign-in returns to an allowlisted
  area only (/admin or /dashboard[/appointments|website|ads|settings]; anything else → /dashboard, never an open
  redirect); errors return to where sign-in started. An admin account without a business lands on /admin from any
  entry point, and /dashboard offers it the console instead of starting onboarding. Landing grants nothing: /admin
  authorizes every request.
- Platform admin access comes only from PLATFORM_ADMIN_EMAILS; customer membership never grants it. Audit every
  privileged write with `audit()`.
- Permanent audit log (server/auditlog.js, migration 0015 `audit_log`): append-only (SQLite triggers refuse UPDATE/DELETE),
  hash-chained (verifyAuditChain; cron checkpoint daily; /admin shows the status and exports JSON). Written by
  `audit()` (admin), ad changes (logAction state-change kinds), Stripe billing changes, website publish/unpublish/restore.
  NO personal data: emails anywhere become `ref:<sha256 prefix>` (staff admin actors stay readable), so deletion never
  touches it. appendAudit never throws. Never add a migration or code path that edits or removes audit_log rows. Admin views show counts, never lead/appointment contact details.
- Opt-outs (server/optouts.js, migration 0014): every follow-up email (unbooked-lead, no-show) has a signed unsubscribe
  link (GET read-only, POST records) plus List-Unsubscribe/List-Unsubscribe-Post one-click headers (RFC 8058, same
  link); a Twilio 21610 records a text opt-out. Opted-out addresses get no follow-ups from that
  business; confirmations/reminders still go. Stored as hashes only. Before 0014 is applied, nothing is suppressed wrongly;
  any other lookup error skips the follow-up (`optout_unknown`, fails closed). Apply 0014 before deploying (else unsubscribe → 503).
- Never mark an email or text as sent unless the provider accepted it. Due messages without a provider are skipped
  (`no_provider`), never sent later in a burst. Texts only with recorded consent (sms_consents); the texting box is offered
  (and consent accepted) only via offerSmsFor(): automations on, owner approved submitting the texting registration,
  status ready/pending/approved, kill switch off (carriers review the live opt-in BEFORE approval; collecting consent
  sends nothing). Messages to leads re-check relevance at send time (`skipReason()`).
- Launch gate fails closed: unless `MESSAGES_LIVE` is exactly `true`, email/SMS go only to `MESSAGE_TEST_RECIPIENTS`
  (`recipientAllowed()` in server/email.js). Setting `MESSAGES_LIVE=true` requires approval. Account outbox mail the
  gate refuses is closed as failed/test_mode (never attempted, never sent later in a burst, never blocks the batch).
- Never store card data or invent prices
  (plans reference Stripe Price ids). No automatic suspension; suspension is a manual, audited admin action.
- Metrics must be computed from real records; return null (shown as unavailable) when data is missing.
- Revenue metrics (MRR/ARR/paying/revenue/churn) only when live billing is on (`stripeLiveEnabled`); in Stripe test mode
  they are null with `billing.mode: 'test'` (a count of test subscriptions), never shown as revenue. In live mode only
  subscriptions recorded live in `subscription_modes` (webhook `event.livemode`, migration 0013) and payments with
  `livemode: true` count. Apply 0013 before setting STRIPE_LIVE_ENABLED.
- Ads: campaigns are created PAUSED; live create/resume only with ADS_LIVE_LAUNCH=true (approval required), an owner
  budget approval, and room under it. With Stripe configured, LIVE launch/resume also needs an active subscription;
  sandbox (verified Google Ads test account) does not, so never-billed pilots (PoolThru) can test.
- Ads holds (server/ads/holds.js; owner decision 2026-11-14): a business on hold gets every running campaign paused
  on its platform immediately and read back from Google; launch/Start are refused (`ads_on_hold`) while it lasts.
  Holds are derived, never stored: admin suspension (customers.status), and for BILLED businesses only (self-serve
  signup or a Stripe subscription; never-billed pilots like PoolThru are exempt) while Stripe is configured: the first
  failed payment (payment_failed event newer than the last paid/good-standing time, or past_due/incomplete), or an
  ended subscription. Triggers: Stripe webhook (after the receipt, via waitUntil), admin suspend (inline, counts in the
  audit), and the 5-min cron sweep (retries). Decrease-only safety stop; nothing ever resumes automatically.
- Ads drafts: one open (unlaunched) draft per business and platform from "Draft my plan" (409 draft_exists; atomic
  INSERT … WHERE NOT EXISTS). Existing duplicates are shown with a notice, never removed automatically; removal is an
  explicit confirmed owner action (status 'removed', row kept). Services split on commas/newlines; starter ad text
  is fitted with fitText() (whole words, never mid-word).
- Ads after creation: every created campaign is read back from Google (verifyCampaign: status, budget, Search-only,
  PRESENCE geo, locations, negatives, ad group, keywords, ad text, final URL) right after creation and daily by cron
  (verifyLaunched); Google's paused/enabled/removed state wins (reconcile). Switching Google Ads accounts resets
  approvals of not-yet-created campaigns; a created campaign is never acted on in another account (account_changed).
  A lower budget approval lowers running campaigns on Google (enforceApproval) or pauses them. Bidding is Maximize
  clicks until conversions reach Google. The daily budget is an average (Google: up to 2×/day, ≤30.4×/month).
- Google Ads disconnect (owner, confirm): deletes our stored Ads token + connection, never revokes at Google (the grant
  may be shared with Calendar). Running campaigns: the owner chooses pause-first or leave-running; never implied
  stopped. Ad payments are set up in Google Ads; we only show billing status (ready/pending/missing/unknown).
- Conversion feedback (server/ads/conversions.js) is OFF unless ADS_CONVERSIONS_ENABLED is exactly 'true' (approval: it
  adds the sensitive Data Manager scope to the Ads sign-in). When on: click ids of GetShowUps Google campaign leads are
  kept encrypted ≤90 days (purged by cron); lead/booking/completed-job events go to the Data Manager API
  (events:ingest) per conversion action (created by ensureConversionActions at campaign creation; only the booking is
  primary), transactionId-deduplicated, test records excluded, ≤5 attempts, no consent claimed, no personal data.
  DATA_MANAGER_API_MOCK_ORIGIN is a loopback-only test var.
- Google Ads policy (docs/GOOGLE_ADS_COMPLIANCE.md): no unattended changes. The optimizer only recommends unless
  ADS_AUTOMATION_ENABLED is exactly 'true' (approval). Offline conversions need the Data Manager API (new sensitive
  scope = approval). Our Cloud project is Test-level: real accounts need Explorer access (external, approval).
  Automation may pause or recommend, never raise budgets or resume. Every spec goes
  through validateSpec(); AI output never reaches a platform unvalidated. Ad mock origins are loopback-only test vars.
- Self-serve billing: when Stripe is configured and a plan is active, every new self-serve business gets a self_signups
  row (same batch as the business) and must pay before onboarding; access follows the verified webhook. Businesses
  without that row (PoolThru, invited, admin-created) keep the legacy setup and are never asked to pay. After onboarding,
  billing problems are dashboard notices (no automatic lock-out). Checkout creates the Stripe customer first
  (idempotency key), refuses if Stripe already has a subscription, and resumes an open session.
  Sandbox checkout ≠ open sign-up: while STRIPE_LIVE_ENABLED is off, a test-card subscription would unlock the real
  product, so createCheckout refuses (403 billing_not_live; the plan step says online sign-up isn't open yet) unless
  sandboxCheckoutAllowed(): platform admin email, an email in MESSAGE_TEST_RECIPIENTS, or an admin-marked test business
  (readable mark only). /api/dashboard/me returns checkoutOpen, so a visitor who can't buy is told before naming a
  business ("Online sign-up opens soon"), and POST /api/dashboard/business refuses that billed signup (403
  signup_not_open: no orphan businesses). Existing subscriptions are never touched by this check (2026-11-18: bob-electrical, a test
  subscription from before the gate, is an open owner decision). Go-live: ACCESS reads billingSubscription(env, id), not getSubscription: with
  STRIPE_LIVE_ENABLED=true a subscription not recorded live (subscription_modes) is status 'sandbox' (not paid, not
  manageable, "choose a plan" notice) except for admin-marked test businesses; live checkout replaces a sandbox record
  with a new live Stripe customer (audited billing.sandbox_replaced) and checks an unrecorded stored customer with live
  Stripe first (only resource_missing replaces it; any other error stops, so no duplicate live customer). Stored rows
  are only changed by that owner-initiated checkout. hostingStatus(db, id, now, env) uses the same view (every caller
  passes env): not onboarded + sandbox only → 'unpaid'; onboarded businesses stay hosted (no automatic lock-out).
- STRIPE_API_MOCK_ORIGIN and STRIPE_LIVE_ENABLED: mock is loopback-only (e2e); live billing needs STRIPE_LIVE_ENABLED=true
  (approval). Only sk_test_/rk_test_ keys count as configured otherwise. Fails closed: billingMisconfigured(env) (a key
  set but billing unusable: live key without the flag, or no webhook secret) refuses NEW self-serve businesses (403
  signup_not_open, me.checkoutOpen false); existing businesses are unaffected. Never let a signup through unbilled.
- Release switches (off unless exactly 'true'): ADS_ENABLED (master switch for the Ads tab + /api/dashboard/ads/* +
  /api/ads/* connect) AND ADS_BUSINESSES (comma-separated business ids, no wildcard; empty = nobody). Both are checked
  per business via adsEnabledFor() in server/ads/access.js after the session is loaded. ADS_LIVE_LAUNCH (real campaign create/resume), GHL_ENABLED (GHL routes, sync and SMS hand-off).
  Website Studio (server/website-studio.js studioAccess(), owner decision 2026-11-16: every eligible business, no
  allowlist) = own Claude/OpenAI key, AI designer, website import (+ old-address redirects). Eligible: Studio not switched
  off (WEBSITE_STUDIO_ENABLED === 'false' is the emergency off switch; default on), business active (not suspended),
  hosting status 'active' (paid/trialing/past due, or a never-billed pilot), and Studio's tables exist (0021–0023; until
  then Studio stays hidden, never broken). Not eligible: those routes are 404, the dashboard/onboarding don't offer them,
  and a save can't add or change `site`/`redirects` (stored values kept). A STORED own key is never replaced by the
  included (GetShowUps-paid) model: unusable/invalid key → invalid_key, no access → ai_unavailable (website-ai.js
  ownCredential; the designer needs a usable key: key_required). Published content is never gated. Publishing is
  standard self-service for every eligible business (owner decision 2026-11-16): explicit confirmation for publish AND
  restore (confirmation_required), every page must render first (render_failed → live version untouched), version +
  live pointer stored in one batch. WEBSITE_STUDIO_PUBLISH === 'false' is the emergency pause for AI-designed `site` /
  `redirects` content (409 studio_publish_off); drafts/previews unaffected. Never publish a draft automatically.
- Appointment modes (service_settings.appointment_mode): 'at_business' (default; customer comes in) and 'at_customer'
  (business visits; service address required, stored in lead_addresses, put on the calendar event location).
  Service area (server/zipcode.js + server/coverage.js, migration 0029): lead eligibility ≠ booking eligibility. A lead
  is never discarded for its location. ZIPs: checkZip (malformed → ask again, form kept; well-formed but not a Census
  ZCTA → ask to confirm, then kept as uncertain; plain website forms never error, the ZIP state goes to review).
  areaFor: 'in' ONLY for an exact listed ZIP (or no list); numeric closeness, states, towns never count. Not 'in' →
  lead kept ('unqualified', attribution kept) + a pending coverage_requests row + owner_coverage notice; the visitor
  sees "We may be able to help in your area", never times. Owner approves (same lead becomes bookable; coverage_ok
  message with their link; link also shown to the owner) or declines (kept, never bookable). A decision never changes
  service_zips. Funnel counts these as stages.outsideArea, not qualified. scripts/build-zip-data.mjs regenerates
  server/zip-data.js (do not confuse server/zip.js, the .zip archive writer).
  Money per visit (server/revenue.js, migration 0028): estimated = appointment_outcomes.value_cents; invoiced and paid =
  revenue_entries (append-only; latest row per kind is current; only for 'showed' visits; recorded_by is a ref, never an
  email). Never present an estimate or an invoice as money received.
  Acquisition results have ONE definition: server/ads/funnel.js (cohort = leads created in the period, test records
  excluded; costs only with measured spend and a non-zero count; ROAS from PAID revenue only; unattributed leads counted
  as such). adResults/adSummary are views of it; diagnostics (diagnose) are deterministic with minimum samples and never
  recommend more spend. Ad attribution also rides through website forms (hidden utm/gclid fields) and the receptionist
  (conversation keeps campaign params + gclidPresent only, never a click id).
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
- Website URLs typed by owners go through `normalizeWebsiteUrl()` (server/url.js): example.com → https://example.com,
  explicit http(s) kept, other protocols / credentials / localhost / IPs / private names refused. UI fields use
  `inputMode="url"` (not `type="url"`, which rejects bare domains). Own-domain hostnames use normalizeHostname().
- Google scopes are least-privilege (`calendar.events.owned`, `calendar.freebusy`). Adding a scope needs approval.
- Tests use the fake values in `test/e2e/fixtures.env` and mocked Google. Never real credentials.

- One website content system (server/site-starter.js): imported or profile content becomes the multi-page site spec
  (content.site) the editor, preview, publishing and export use. A business without a site gets a deterministic starter
  site (no AI, no key) on import or "I'm starting fresh"; a business with one gets only missing pages added (never
  replaced) and a services section if approved services had nowhere to show. Precedence: owner edits > records >
  approved imported content > starter text. Nothing invents services, prices, claims or legal text.
  Conversion-first starter home (owner decision 2026-11-18, Phase 1): hero (area line only when the whole town list fits,
  Book online + Call), services, "How booking works" (bookingSteps: ONLY what the booking page does in production —
  details → open times → booked on screen; never emails/texts/reminders, never "coming soon"), about, hours + area,
  "Good to know" FAQ (faqFromPolicies: the owner's policies word for word), final CTA. Facts come from ONE builder,
  website-import.js starterFacts(); missing records → left out and returned as `starterMissing` (owner is told).
  Call = button target 'call' (hero/cta/imageText only, never composition blocks): the renderer dials and SHOWS the
  phone on record at request time and drops the button without one. area.showHours shows confirmed booking hours from
  the record; a showHours area with no towns and no hours renders nothing publicly. Their CSS (EXTRA_CSS) is emitted
  only on pages that use them, and showHours is stored only when true, so existing sites stay byte-identical.
- Legal pages (page.legal: privacy policy, terms): text sections only, escaped and length-limited but NOT run through
  the marketing-claims / invented-number filters (owner decision 2026-11-17: legal wording must be kept exactly).
  Set by import (word for word, provenance source {imported, url}), the starter (source starter) or the owner in the
  Studio ("Add a page" → Privacy Policy / Terms of Service, src/dashboard/site-templates.js, source starter); AI output
  can never set it and redesigns keep legal pages unchanged (keepLegalPages). /privacy and /terms; old addresses forward. An incomplete or over-long crawled policy is
  refused, never shortened. Publishing a draft with a legal page needs legalReviewed: true every time.
- Static export (server/site-export.js, GET /api/dashboard/website/export?format=static): the PUBLISHED site as a .zip
  for the owner's own hosting; same renderer; this business's images only; forms left out; booking/chat absolute links.
- Websites: one renderer, no scripts on business sites, every text through the claims filter (legal pages: see above), drafts private until
  an explicit publish (confirm: true). Images only via assets.js. Hosting follows hostingStatus(); never delete content
  (only exception: permanent account deletion, server/deletion.js).
  Live sites render per request from stored content, so a renderer change changes every live site. Guard:
  test/render-golden.test.js (frozen stored-content fixtures in test/fixtures/render/*.json → exact HTML goldens; never
  regenerate the .json) + test/e2e/site-layout.spec.js (desktop/phone: no sideways scroll, headline + booking button on
  the first screen, no clipped headings). A golden diff = "this PR changes live customer sites": only update it
  (UPDATE_RENDER_GOLDEN=1) when intended, and say so in the PR.
- Domain checks ask TWO public resolvers (Cloudflare + Google, server/domains.js dnsViews): a split answer is
  `propagating` (securing) or `dns_inconsistent` (connected), never "waiting"; the bare domain of a www hostname is
  checked read-only (apexStatus: forwards / forwards_http / other / none / points_here, keepsPath/keepsQuery) and the
  DNS provider named from the zone's nameservers; nothing of it is stored. GetShowUps never changes a customer's DNS.
- Domain records are shown with the provider-relative Host (`host`, e.g. `_getshowups.www`; providers append the zone) and
  the full `name`; checks report record_doubled / cname_doubled / wrong_value instead of an indefinite "waiting". A record
  at a doubled name is never accepted as proof.
- Old-site redirects: content.redirects [{from: path, to: '/' | '/#services' | '/#about' | '/#contact' | 'book'}] (≤30, fixed
  targets, suggested by the import), applied by functions/_middleware.js on a connected domain from the LIVE version only.
  www is the connected hostname; the bare domain stays with the owner's provider (UI tells them to forward it).
- Domain re-claims (claimDomain, one atomic upsert): the same business re-claiming a hostname it removed ≤30 days ago keeps
  its verify_token (verified_at/attached_at always reset: ownership re-proven by DNS); any other business, or after 30 days,
  gets a new random token. A business never holds two active domains; an active claim is never changed.
- Domains: never attach a hostname before its TXT proof; never claim "connected" without DNS pointing at us AND hosting reporting the domain active with a validated
  certificate (plus the HTTPS check where reachable); never touch
  a customer's DNS/MX. CF_API_TOKEN/CF_ACCOUNT_ID/CF_PAGES_PROJECT are production secrets (approval). DNS_API_MOCK_ORIGIN
  and CLOUDFLARE_API_MOCK_ORIGIN are loopback-only test vars.
- AI website design: the model only picks named options from site-design.js and writes prose; it never writes
  HTML/CSS/JS. Unknown options are repaired from presets. Stock photos: CC0 library only (public/site-stock,
  generic scenes, no identifiable people), never in the "Our work" gallery (owner photos only); the owner's
  uploaded main photo always beats a stock choice. The business logo is never a photo: generation never offers it as an image, and a saved
  design that placed it as hero/About falls back to the design's other photo (logo stays in the header). Fonts are self-hosted OFL files in public/site-fonts.
  "Logo" = current OR any earlier logo (website.js logoAssetIdsFor: draft + every version's content.logo; images carry no
  role). Both AI generators, the starter and the Studio photo pickers (listAssets marks logo: true) use it (PoolThru
  2026-11-16: an old logo became the first-screen photo). "No photo" in the editor removes the picture (a composition's
  photo block is removed). Display headlines have absolute ceilings (96/80/60px) besides the viewport cap.
  Industries (site-design.js INDUSTRIES, first match wins; wellness before pool so a day/med spa never gets pool photos)
  each have their own starter look (fonts, radius, buttons); professional + wellness have no licensed photos yet → text-led.
  App headers (functions/_middleware.js withAppHeaders): /dashboard and /admin are never frameable (X-Frame-Options DENY +
  frame-ancestors 'none'); HSTS on our host; WebSocket upgrades pass through untouched.
- Lazy app chunks use lazyPage() (src/lib/lazy.js): a page open across a deploy reloads once instead of going blank.
- Invented numbers: server/fact-numbers.js is the one check (whole numbers, never digit substrings of a phone/ZIP).
- AI website copy: the model writes prose only; names, services, prices, area and phone always come from records.
  Every field passes the claims filter and the invented-number check, otherwise the template text is used. A
  generation never changes the draft or live site (apply → private draft; publish → live). Previews, design
  switches, edits and site visits never call the model. Limits: 10/day (rate limit) + MONTHLY_GENERATIONS per business.
  The production `AI` binding on the Pages project needs approval. AI_API_MOCK_ORIGIN is a loopback-only test var.
- Pilot / invited / admin-created businesses are never billed: no plan card, checkout refused (no placeholder rows).
- Test records (testdata.js) are listed with a tag and excluded from every count; never deleted (except by account deletion).
- Test businesses (server/testbusiness.js, table test_businesses): marked/unmarked only by a platform admin via
  POST /api/platform/test-business (same-origin, confirm, audited). A marked business is listed with a Test tag but
  left out of every platform metric/count/MRR, and NEVER uses live operations whatever the global switches say:
  Google Ads test accounts only (liveFor() ignores ADS_LIVE_LAUNCH), messages only to MESSAGE_TEST_RECIPIENTS
  (recipientAllowed(..., { testOnly })), no Stripe checkout/portal with a live key. Unmarking never promotes sandbox
  data: anything created up to unmarked_at stays sandboxed and Ads connections must be chosen again. Fails closed
  (unreadable table → treated as test). Rows are never deleted. PoolThru and GetShowUps are real, never marked.
- Attendance changes are always reversible and recorded in appointment_changes.
- AI receptionist (server/receptionist/, migration 0026; docs/RECEPTIONIST.md): ONE engine for website chat
  (/chat/<id>, linked from the business site — still no script on the site) and voice (Retell custom LLM over
  /api/receptionist/llm/<call_id>; calls are created by our server and routed ONLY by that call id). Real Claude
  inference (RECEPTIONIST_ANTHROPIC_API_KEY, its own secret; RECEPTIONIST_ENABLED=false = kill switch); off per business
  until the owner turns it on. Knowledge = the business's records + owner notes only. Tools run server-side, bound to
  the conversation's business: availability only from openSlots, bookings only via bookAppointment, only for a time this
  conversation was shown, only with the customer's own confirming words in their latest message, ZIP/phone (+ email in
  chat) only from what the customer said, one booking per conversation; $ amounts not in the records are never shown.
  Every tool action/refusal/failure/hand-off is a receptionist_events row (codes only). Owner sees spoken/typed lines,
  never model internals. Cost caps per conversation and per business/day. Phone numbers/forwarding: not provisioned
  (routing.js is provider-neutral and simulated only). Never claim a booking the tool did not return.
  Customer details are saved once (save_customer_details, deterministic checks) and re-sent as known each turn: never
  re-ask. Email is optional for a booking (no email → no invitee, confirmation skipped no_email). One lead per
  conversation (lead id claimed on the conversation row first). NO live transfer exists: "a person" → a recorded
  receptionist_requests row (migration 0027; callback/message, owner Needs attention, Mark done) and the customer is told
  only that it was recorded — never a call time, never "the team was notified". Owner notification (owner_callback via
  the outbox) is tracked separately: recorded / pending / sent / failed / not_sent (held). Phone routing settings stay
  disabled and labelled "not connected" until a line exists. Voice: an interrupted turn that did nothing is never
  saved; a call continues the page's conversation; ending the conversation ends the call.
- Customer-facing voice on every provider (server/voice/customer.js, public routes api/receptionist/[customer]/voice,
  voice-connect, voice-tool, voice-session): the provider comes from receptionist_voice_settings (never the browser),
  sessions are pinned to their provider, tools run through runVoiceTool bound to the session's business (dry run only
  for admin test sessions: platform admin + admin-marked test business, /chat/<id>?test=<provider>), limits
  (RECEPTIONIST_VOICE_CONCURRENT 3, RECEPTIONIST_VOICE_DAILY_MINUTES 120, VOICE_PROVIDER_DAILY_MINUTES 600,
  VOICE_PROVIDERS_DISABLED off switch), no fallback ever. Activation needs EVIDENCE (providerEvidence: finished session
  with micLive + audioReceived + find_available_times + book_appointment ok, ≤ 30 days); never claim a provider is
  production-ready from credentials alone. scripts/voice-live-check.mjs = bounded real-provider check (keys from Keychain).
- Dashboard → Receptionist channel tiles (src/dashboard/Receptionist.jsx channelTiles): state + reason + next step from the
  API's capability facts only (voiceStatus available | testing = Retell not released for this business | not_configured);
  never a hardcoded "Active"; owners never see a provider name; phone calls are "Not available yet" (no line exists).
- Receptionist voice (server/voice/style.js + settings.js + catalog.js, migration 0035, docs/RECEPTIONIST.md "Voice
  management"): owners pick a voice from the ACTIVE provider's catalog (validated; provider sample previews; never a
  provider name), a personality preset (fixed prompt wording, style only) and a pace where supported; saves carry a
  version (409 stale). The provider is admin-only (PLATFORM_ADMIN_EMAILS, checked server-side on every action):
  checklist → consequences → confirm → one conditional write → audited → rollback. Only providers with a customer path
  can be activated (today Retell; OpenAI/ElevenLabs = Voice Lab only, "test only"); no provider has phone routing.
  No row = today's configuration (Retell, agent voice, Balanced). Never substitute a voice silently.
  Admin Console entry point (/admin/voice-lab → Businesses, GET/POST /api/platform/voice-provider, server/voice/admin.js):
  the same check/switch/rollback functions for ANY business (platform admins only, membership not needed), plus the
  business id typed back (`confirmCustomer`) before a switch or rollback; the view is facts, readiness and a
  codes-only session history (never transcripts or customer details). ProviderControl.jsx is the one UI for both.
  Global default provider (migration 0036, server/voice/global.js, console section "Global voice provider"): resolution
  explicit override (settings row without receptionist_voice_inherit) → global default (receptionist_voice_defaults,
  newest version; no row = retell) → retell. Owner saves keep a business following the default; admin switches make
  overrides. A global change checks EVERY inherited business with checkProviderSwitch: mode all refused while any is
  blocked, mode staged pins the blocked ones to today's provider (override, audited receptionist.provider_pinned) and
  switches only verified ones; overrides untouched; sessions in progress stay pinned; global rollback undoes exactly
  what the version did and reports what it kept. Never report a global switch as applied to everyone.
  Promote to 100% (checkGlobalPromotion / promoteGlobalProvider, actions global_promote_check / global_promote): one
  action for every business in scope (following + rollout pins; deliberate overrides only with includeOverrides;
  suspended excluded). PROVIDER-level verification (providerVerification: a finished production-path session on a
  test business with audio both ways, both booking tools, a clean end; Lab never counts) + automated per-business
  compatibility (checkProviderSwitch minus the evidence) stand in for per-business tests, which become the `unverified`
  WARNING acknowledged explicitly (never reported as tested); credentials, customer path, voice on another provider,
  catalog, tools, switched off stay BLOCKERS and refuse the whole promotion (all or nothing). Released pins and
  replaced overrides FOLLOW the default (inherit row), never a permanent override; the guarded defaults INSERT
  (provider NULL unless every in-scope row is unchanged) makes the batch all-or-nothing; rollback restores pins and
  overrides as they were. Rollout status = session records only (null = unavailable); never invent a metric.
  Production: the human admin runs the promotion; a deployment never changes the default or any business.
  Console UX (2026-11-22, ONE page: /admin/voice-lab = src/admin/VoiceLab.jsx; /admin/voice-providers lands there):
  Provider card (GlobalProvider.jsx + rollout-state.js) = provider tiles (picking another configured provider stages
  it: review → typed change), the target's rollout state (not configured · needs a test · ready to activate ·
  activating · active for every business · active for most · blocked · rolled back; from globalOverview facts, never
  from a click) and the one next action: Test <provider> (opens globalOverview.testPage, server/voice/testing.js
  testPageFor = first eligible admin-marked, bookable test business, those WITHOUT a service-area list first; the card
  then polls the facts until the session is recorded) → Activate for all businesses (checklist + ONE typed
  confirmation) → Rollout monitoring (records only, after a rollout) → Roll back (typed). When the newest finished
  production-path test did not verify, the card says what it showed/missed and why (providerVerification.latest:
  path area | no_tools | no_availability | no_booking | audio | connection + the failed tool codes) and what to retry
  (with the ZIP to say). Businesses (Businesses.jsx) and the Lab call (not the customer path, never verification) sit
  under disclosure; versions, counts by kind, the verification record and the test business under Advanced details.
  Test page access (server/voice/testing.js adminTestAccess, GET /api/receptionist/<id>?test=<p>): a test business
  whose receptionist is OFF still opens its chat page for the signed-in platform admin's ?test= (voice only, dry run,
  `testOnly`); customers/owners keep "Chat isn't available" (refusal as a code). Never turn a test business's
  receptionist on for customers to make a test possible.
  How a call ended is RECORDED, never guessed (2026-11-22): a non-clean end carries its failure code as the outcome
  plus a disconnect record (src/voice/elevenlabs.js disconnectInfo → voice-session end → sessions.js cleanDisconnect:
  phase start|live|reconnect, code, WebSocket closeCode, the provider's reason as printable ASCII ≤ 120 chars; never
  audio/transcript/credentials). The end is sent keepalive and on pagehide; the handshake times out (connect_timeout);
  an open receptionist_calls row counts at most the 15-min ceiling toward daily minutes; a resumed session returns the
  conversation's token again and keeps earlier attempts in state.voiceHistory. The page explains the code and keeps the
  microphone; an admin test page shows the record (data-test-diag); the Voice Lab's last-test line and providerVerification
  show/count it (path connection). Never map a failure to "The call dropped" without recording why.
- Teach Your AI (server/intelligence/, migration 0033, docs/INTELLIGENCE_STUDIO.md): owner AI rules as versioned
  structured config (never free-text prompts): draft → explicit publish → append-only versions → rollback (a copy
  published as a new version); every write carries its stamp (409, never a silent overwrite). Business facts stay in
  their own tables (read at decision time, re-validated). Platform rules (area check, offered slot + customer's yes,
  contact/address, safety, no invented prices, caps, tenant isolation) are not configurable: validateConfig refuses
  them, Teach a Change answers "Not changed: <reason>". Teach a Change = fixed patterns first, Claude (json_schema ops
  from the same catalog) only for the rest; proposals are applied server-side to the CURRENT draft on approval. "Test
  your AI" is a deterministic simulation (no model, no calendar, nothing stored). Gates: AI_STUDIO_BUSINESSES (owner
  editing, customers unaffected), AI_RULES_LIVE_BUSINESSES (receptionist uses the PUBLISHED version; chat + Retell
  voice through the same engine), AI_RULES_ENABLED=false kill switch; all empty = exactly the pre-rules behaviour.
  Retell needs no agent change (custom LLM served by our engine; providers.js is the adapter boundary).
- Follow-ups / texting (server/followups/, migration 0024; owner decision 2026-11-16, build 49): one engine for every
  eligible business, no allowlist. A text leaves only if: MESSAGING_KILL_SWITCH isn't 'true', Twilio credentials exist,
  the business has its OWN active Twilio subaccount (sms_accounts; sent at /Accounts/<sub>/Messages.json, never the
  parent's or another business's; a webhook from one business's subaccount never routes to another), its OWN sender (sms_registrations.messaging_service/sender_phone) AND its registration status is
  'approved' (recorded by a platform admin from the PROVIDER's decision; never inferred, never set by the owner, refused
  before the owner's explicit approval), the person consented (form box, or they texted first) and hasn't opted out,
  and recipientAllowed with testOnly = test business OR SMS_LIVE !== 'true'. SMS_LIVE, FOLLOWUP_AI (assistant on the
  included model) and MESSAGES_LIVE need approval. Automatic texts respect quiet hours (moved to morning); direct
  answers within 30 min may go. Limits: 3 automatic texts/person/day, 6 assistant answers/person/day, 300 texts and
  $0.20 assistant cost per business/day. Twilio's OptOutType (STOP/START/HELP) wins over our keyword list and we never send a second answer to a keyword
  Twilio answered. STOP (carrier keywords incl. CANCEL) suppresses immediately (queued and
  scheduled texts retired, provider confirms); START resubscribes; HELP and human requests get fixed replies; a
  cancel request gets the person's own signed cancel link (never cancels by itself). Owner pause stops every automatic
  message incl. fixed answers (owner is asked). Webhooks: Twilio signature required (an unsigned request is logged as info, never an incident); MessageSid unique; status updates
  forward-only. An unknown send outcome is never resent. Conversation text: owner inbox only, never logged or in admin
  views; purged after 365 days; erased with the account. Live SMS / registration submission / number purchase need
  approval (docs/TEXTING_ACTIVATION.md).
- Founder alerts (server/alerts.js): OFF unless FOUNDER_ALERTS_ENABLED is exactly 'true' (approval). Platform admins only,
  through the outbox and launch gate (queued only for admins recipientAllowed() delivers to now); one email per incident
  (deterministic outbox id), ≤ 1 per business + kind per 6 h (flapping), ≤ 10 per run + digest; test/deleted businesses never alert; codes and counts only.
- Owner notices (server/notify.js): only items from the last 2 h; queued only when recipientAllowed() would deliver now
  (nothing waits in the outbox to go out late); one per item + member (outbox id); body cleared once sent.
- Owner cancellation (POST /api/dashboard/appointment-cancel, server/booking.js cancelAppointment): upcoming bookings only;
  the Google event (ours, by id) is removed FIRST with sendUpdates=all, and only on success (or already gone) is the
  booking marked cancelled (slot freed, reminders stop via skipReason). Google unreachable → nothing changes, retry.
  Cancel + its appointment_changes row are one batch; a save failure after Google removed the event returns
  cancel_incomplete and records an open failure (retry finds the event gone and completes).
  Customers cancel from the link in their confirmation/reminder emails (GET never cancels; POST does, by: 'customer',
  audit actor type customer); the owner gets an owner_cancel notice.
- Test businesses' public sites always send noindex (meta + X-Robots-Tag; testStatus fails closed).
- Account deletion (server/deletion.js, migration 0016, docs/DATA_RETENTION.md; owner decision 2026-11-14): permanent, no undo
  window, no founder approval. Owner (Settings, typed business name) or platform admin (typed id, on a verified request).
  Steps lockout → ads (pause + read back; never skipped) → billing (Stripe canceled now + confirmed; customer deleted) →
  integrations (tokens deleted, grant revoked unless shared, domain detached, creatives) → data (ERASED_TABLES; tombstone;
  admin_audit emails → refs) → verify. Idempotent steps, cron retries with backoff, audited. Deleted ids are never reused
  and are left out of metrics. OFF unless ACCOUNT_DELETION_ENABLED is exactly 'true' (approval of implementation AND
  retention policy). Never delete production data any other way. New tables holding business data must be added to
  ERASED_TABLES or to the retained list in docs/DATA_RETENTION.md.
- Lifecycle (server/lifecycle.js): one view of stage (subscribed / payment problem / cancel scheduled / canceled-recoverable /
  recovery over / deleting / deleted), hosting, ads hold, recovery, deletion (admin detail "Lifecycle"). Cancellation without
  deletion: billed accounts stay fully recoverable 90 days after the paid period ends (owner Billing card + admin attention).
  Day 90 is NOT authorization to delete: the expiry is recorded (lifecycle.recovery_expired); data is removed only by the
  separately approved retention schedule (RETENTION_SCHEDULE_ENABLED AND ACCOUNT_DELETION_ENABLED; never pilots/test).
- Billing reconciliation (server/reconcile.js): daily cron + /admin "Run now": Stripe subscriptions + 35 days of paid
  invoices vs our records (status, amount, cancellation, mode, missing either side, payments, billing after deletion).
  Read-only toward Stripe; recorded in audit_log. Auto-applies ONE thing (owner decision 2026-11-18): a subscription we
  treat as paid (active/trialing/past_due) that Stripe reports ENDED is resynced (decrease-only; `applied` in the run),
  so a missed cancellation webhook can't keep a business hosted. Stamped with Stripe's ended_at (never the run time, so
  a later real webhook still wins); skipped (other_subscription_running) when Stripe lists another running/pending
  subscription for that business; a failed confirming fetch changes nothing. Everything else is report-only. "Resync from Stripe" (admin, confirm, audited) applies
  Stripe's current subscription like a webhook (refused for live mode while live billing is off).

## Business Review and operational events (/admin/review)

- Control Center (/admin/control, docs/CONTROL_CENTER.md): incident register (server/ops/incidents.js, migration 0031,
  cron step) = one OPEN row per fingerprint; resolved only on evidence (success_seen | connected | no_new_failures;
  quiet ≠ recovered); causes ONLY from the fixed CAUSES table (confirmed/suspected/unknown, never inferred); evidence
  allowlisted codes/counts/times (≤ 2 KB); test businesses tagged, never customer impact. Account Inspector
  (server/ops/inspector.js) reads records only; support never impersonates; "Diagnose calendar" is read-only, not
  recorded as an availability event, rate-limited (supportDiagnose), audited. Journey/feature ids (server/ops/journeys.js)
  are stable: rename = new title, replace = RETIRED entry; every step's feature must be a registered capability.
  QA history (server/ops/qa.js, migration 0032): automated runs only via POST /api/qa/runs (Bearer QA_INGEST_TOKEN,
  off when unset), registry-linked tests + failures only, provider mocked|real never mixed, errors redacted; guided
  human QA records observations only (never changes a business). Activation is "measured" ONLY from a finished
  observer-recorded `activation` run — never from automated tests, never claimed otherwise.
- Every feature registers a capability (server/ops/registry.js `registerCapability`, imported from server/ops/catalog.js):
  id, name, journey step, dependsOn, external service, `state(env)` (live|sandbox|disabled|missing|unknown + note +
  approval), optional read-only `verify(env, now)` (database evidence of real activity, no outside calls) and
  `business(env, id)` (per-business status, no personal data), optional `blockers`. Business Review shows it with no UI
  change. Statuses: live_verified (live + seen working recently), built_tested, sandbox, disabled, missing, unknown.
- Consequential actions, failures and retry outcomes use `recordEvent` (server/auditlog.js) with capability, resource,
  outcome and correlation id. A failure stays an open incident until a later success for the same capability +
  resource. Never put free text or contact details in events (they are fingerprinted anyway).
- Change history: dist/build.json (scripts/build-info.mjs, commit + migration tables) and cron `recordChanges`
  (platform.release / platform.config: switch names and on/off only). docs/OPERATIONS.md.
- Conversation providers (server/conversations/): adapters only propose actions (validateAction); GetShowUps executes
  them. One controller per conversation (control.js, migration 0017): a person always wins; providers hold leases.

## Release state (verified 2026-11-20; details in docs/STATUS.md and docs/OPERATIONS.md)

- Production: deployment b3522b5f (main 005d162, QA Control Center: #83 founder alerts, #85 incidents + Account
  Inspector, #86 QA history), migrations through 0032 applied. Rollback target for that release: c378384e (main
  0be8bf2); the 0031/0032 tables stay (older code ignores them). Backup:
  ~/getshowups-backups/prod-20261119T233412Z-pre-pr83.sql (verified: integrity ok, 72 tables = production).
- Off / not configured (each needs approval): FOUNDER_ALERTS_ENABLED (unset: cron reports alerts disabled),
  QA_INGEST_TOKEN (unset: /api/qa/runs answers 503) + the CI qa-report job, MESSAGES_LIVE, SMS_LIVE,
  STRIPE_LIVE_ENABLED, ADS_LIVE_LAUNCH; enrollment closed ({"open":false}). Voice:
  RECEPTIONIST_VOICE_BUSINESSES=poolthru-llc,bob-electrical.
- Releases: apply a PR's migration before merging it, never out of order; merge pinned to the reviewed head
  (--match-head-commit); after each deploy diff the live customer HTML against a pre-release capture.
- Each system exists once: audit = server/auditlog.js (audit_log); ads safety stop = server/ads/holds.js; deletion =
  server/deletion.js; lifecycle/recovery = server/lifecycle.js; reconciliation = server/reconcile.js; scheduler =
  workers/scheduler → /api/cron/run. The other agent's business-review.patch was reviewed, not merged (see
  docs/OPERATIONS.md §7): never add audit_events, lifecycle_states, deletion_requests, ads/shutdown.js or a second 0015.
- Cron batch sizes come from measurements (scripts/scale-bench.mjs): keep a cron run well under D1's ~1,000 queries
  per request; admin views must not do per-business KV reads (Workers ~1,000 KV ops per request). Observability
  steps (incident register, QA retention) run LAST in the cron and are bounded per run (≤150 open, ≤50 new
  incidents), so they can never use up the budget of delivery, ads safety-stop or billing steps.

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
