# Status, decisions, next actions

_Update at the end of every task. Newest first._

## Launch readiness audit (2026-11-14) — branch feature/launch-readiness, NOT deployed

Production = `main` dcc15f1. Open PRs: #17 (sign-in routing, CI green, reviewed safe to merge), #16 (journey runner).
Read-only production checks only (business ids, email domains, counts, key presence; no customer data printed).

**Accounts and tenants (verified from production records):**

| Identity / tenant | Intended role | Actual today |
| --- | --- | --- |
| Developer account (Flora Summit domain) | GitHub, Claude Code, infrastructure only | Also the only member of the test business `gsu-stripe-test-pools`. No code dependency (only the GitHub repo name). |
| Founder account (getshowups.com) | Platform admin (`PLATFORM_ADMIN_EMAILS`) | Admin; member of no business. Also the Google account behind the test business's Calendar and Ads connections (chosen on Google's screen during the OAuth video). |
| `poolthru-llc` | First real tenant | Owner on the poolthru.com domain; not test-marked; on-site (`at_customer`); Calendar + Google Ads connected; 1 paused + 4 removed campaigns; never billed (a stale `incomplete` placeholder row from 2026-11-10, no Stripe subscription). |
| `gsu-stripe-test-pools` | Test tenant | Test-marked; Calendar + Ads connected; 1 paused test-account campaign; Stripe test subscription. |
| `toys-for-us` | ? | Self-serve, gmail.com owner, **not** test-marked, Stripe test-mode "active" subscription, Calendar connected. Owner to confirm whether it is a test (then mark it as test in /admin). |

**Developer account off the test tenant (safest path, needs approval):** keep the business and its history; owner
picks a dedicated demo Google identity (not the founder or developer account); admin invites it to
`gsu-stripe-test-pools` from /admin (existing audited invite-to-existing-business); after it signs in, remove the
developer membership with one approved D1 statement (no remove-member feature exists; deliberately not built). Calendar
and Ads connections stay as they are (they belong to the business, not the member) until the owner chooses to reconnect.

**Fixed on this branch:** platform metrics no longer report Stripe test-mode subscriptions as revenue. Until
`STRIPE_LIVE_ENABLED=true` every subscription is test mode (the webhook refuses live events), so MRR/ARR/paying/revenue/
churn are null with `billing.mode: 'test'` and a test-subscription count; the console says "Test mode (no revenue)".
Before switching live billing on, record `livemode` per subscription so old test rows never count (follow-up).
The main metrics row shows job completion instead of the always-empty show-up rate when only on-site data exists.

**Verified already implemented (no change needed):** on-site outcomes (visit happened, job completed, self-reported
value), paused-only campaign creation + read-back + budget ceiling + no automatic increases, idempotent checkout (no
duplicate subscriptions), pilots never billed, messages gated to test recipients unless `MESSAGES_LIVE`, scopes match
the OAuth submission (docs/GOOGLE_OAUTH_VERIFICATION.md).

**Readiness:** sign-in/admin routing — ready after PR #17 deploy; self-serve signup + Stripe — ready in test mode,
live billing blocked on approval; Calendar booking — live for PoolThru; on-site outcomes — ready; Google Ads — sandbox
only (Explorer access; live launch switch off; PoolThru live ads would also need a billing decision); messaging — test
recipients only (MESSAGES_LIVE off; SMS not configured); founder console — ready for a pilot (metrics now honest).

**Next actions:** approve PR #17 merge/deploy; this branch's PR; decide toys-for-us test mark; pick demo identity for
the test tenant; live billing plan (livemode column first); wait for Google OAuth verification.

## Current state (2026-11-08)

- Marketing site live at getshowups.com; Book a Demo embeds Google Calendar appointment schedule.
- Google Calendar OAuth onboarding live: single-use invites (D1), encrypted refresh tokens (KV).
- Customer **poolthru** connected; production health check `GET /api/admin/google-health?customer=poolthru`
  returned `healthy` (token refresh 200, freeBusy 200) on 2026-11-08 at deploy e780355.
- Development accelerator: `npm run verify`, `npm run verify:all`, GitHub Actions CI, Playwright smoke tests.
- Launch release incl. admin console, invitations, billing prep, analytics: **built and tested locally, not deployed**.

## In progress

## Product roadmap (source of truth; set 2026-11-10)

One product: Advertising → Website → Lead → (optional) Qualification → Booking → Confirmation → Reminders →
Show-up → Reporting. $499/month founding plan; ad spend separate; no guaranteed results. Priorities: real paying
customer first, then a complete simple experience, automation, low cost, reliability. Milestones in order (each:
inspect, build only what's missing, test, safe preview, report blockers, stop for approvals):

- **A. AI website generation**: built on branch release/ai-websites (see below). Needs: AI binding approval + deploy.
- **B. Live Stripe payments and the full paying-customer journey**: code exists (sandbox verified). Needs: live keys,
  live price, STRIPE_LIVE_ENABLED, one real payment test (approval).
- **C. Lead capture, optional qualification, follow-up**: booking, outcomes and email automation exist
  (MESSAGES_LIVE off). To do: direct vs qualify vs route-to-human setting and an industry playbook (PoolThru first).
  Evaluate GHL conversations before any custom messaging. SMS needs A2P registration. Rescheduling/cancel links and
  missed-call follow-up (telephony) are still missing.
- **D. Google Ads**: OAuth, accounts, plan drafts, budget approval, paused-campaign creation, optimizer and
  attribution exist behind ADS_ENABLED / ADS_LIVE_LAUNCH. Needs: Explorer/Basic access on the Google Cloud project (developer
  tokens were sunset 2026-09-09), OAuth verification for the adwords scope, a real test account; then spend → leads → bookings → show-ups reporting.
- Onboarding target: sign up/pay → confirm details → keep or generate website → calendar → (optional) Google Ads →
  direct booking or qualification → review. Dashboard answers leads, booked, showed, spend, attention.




### Milestone B: Stripe sandbox journey COMPLETE (2026-11-11, production, Stripe TEST mode)
- Real run on production with an isolated test business (gsu-stripe-test-pools, owner@example.com (test owner)):
  Get started → Google sign-in → business name → $499/month Stripe test Checkout (abandoned → same session
  resumed; owner entered test cards) → signed webhooks (checkout.session.completed, customer.subscription.created,
  invoice.paid; each once) → subscription active → details/services/calendar/hours/website → onboarding complete
  → dashboard → portal cancellation (customer.subscription.updated → cancel at period end, access until Dec 11).
- Verified: paid steps locked before payment; second checkout refused (409 use_portal); webhook idempotency;
  tenant isolation from PoolThru; PoolThru billing exemption and data unchanged. STRIPE_LIVE_ENABLED off.
- Email: 4 automated emails delivered to the test recipient's Inbox via Resend (MESSAGES_LIVE still off).
- Cleanup: test website unpublished (was published during onboarding); test business calendar record deleted
  (it had connected PoolThru's Google account (owner@poolthru.example); the shared Google grant was NOT revoked; PoolThru's record unchanged).
  The test business remains (active test subscription, ends Dec 11); reconnect only to a separate test calendar.
- Fix LIVE (99be975, deployment 72b6fb33): public booking now requires an active plan (same rule as the public
  website: pilots exempt, paid/past_due yes, canceled within the 14-day grace, unpaid never).
- Remaining before live billing (owner): Stripe live activation; live $499/month Price; live webhook (6 events:
  checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed)
  + customer portal; live STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET set by the owner; then (approval)
  STRIPE_LIVE_ENABLED=true + founding plan price update + one real payment and refund. Google OAuth consent
  screen "In production" (status unconfirmed; console needs the owner's password). A declined test card was not
  observable server-side (declines create no records by design).

### Google Ads sandbox (2026-11-11): built on feature/ads-overview, NOT deployed (needs approval)
- Test-account guard: without ADS_LIVE_LAUNCH, create (paused), resume and budget changes only on an account
  Google reports as a test account (customer.test_account, re-read before each change; unknown → refused).
  Pausing never blocked. Read-only GET /api/ads/google/campaigns (status, budget, 30-day metrics). Owner budget
  changes within the approved ceiling. Test-account data labelled on the Ads screen and Overview.
- **Verified against Google's real API (2026-11-12, local run, test accounts only)**: Cloud project 380394286094
  (Test access; production OAuth client's project, confirmed from the public client id), separate local Desktop OAuth
  client in that project, no developer token. Test manager 554-785-3090 and test client 642-666-3252 (under it):
  customer.test_account = true for both; status CLOSED, which Google documents as normal for test accounts.
  The app's real adapter (server/ads/google.js), 12/12 PASS: test-account guard, geoTargetConstants:suggest (ZIPs),
  create PAUSED Search campaign in one atomic mutate, read back (direct GAQL + app searchStream), relaunch returns the
  existing campaign (no duplicate), enable, pause, daily budget $10 → $15, final state PAUSED. Test campaign
  24455347866 "GSU lifecycle TEST [gsu:lcmwe636hv]" left PAUSED in the test client (test accounts never serve/charge).
  Not live-verified: daily metrics (test accounts have none), production OAuth client + deployed callback, real accounts.
- 2026-11-11: Google sunset developer tokens on 2026-09-09 (access is per Cloud project; the header is ignored
  now and will be rejected in a future version). We no longer send it. The GOOGLE_ADS_DEVELOPER_TOKEN secret
  stored in production on 2026-11-11 is unused and can be deleted later (with approval).
- Per-business flag (2026-11-12): Ads needs ADS_ENABLED=true AND the business id in ADS_BUSINESSES (no wildcard;
  unset = nobody). Applies to every Ads route, both OAuth callbacks, me.features.ads, Overview and onboarding
  readiness. Cron metrics sync / optimizer still act on already-launched campaigns (read + pause only).
- Sandbox UI (2026-11-12, not deployed): the Ads page follows Your business → Connect your ad account → Review your
  campaign → Approve your monthly ad budget → Launch (approve → create paused → start). Accounts are found
  automatically (listAccessibleCustomers + customer_client hierarchy of each accessible manager, managers left out);
  the owner clicks one; the server works out the manager path (login-customer-id) and never sends manager ids to the
  browser. One choosable account → auto-selected in the callback. Without ADS_LIVE_LAUNCH only accounts Google flags
  as test accounts are offered or accepted (others counted, not shown; POST 409 test_account_required). Created
  campaigns get a daily-budget control and "Check on Google" (live status + budget read-back). Images moved under
  "More options"; the Meta row is hidden until Meta is configured. Browser test covers connect → choose → approve →
  create paused → start → pause → budget → read-back against a stateful MOCK Google Ads stand-in.
- Deployed 2026-11-13 (approved): main fast-forwarded 99be975 → 4355bb5 (Pages deployment a2a02e07). Backup
  ~/getshowups-backups/prod-20261113T011808Z-pre-ads-sandbox.sql (restore-tested, 44 tables). ADS_ENABLED=true and
  ADS_BUSINESSES=gsu-stripe-test-pools set before the push (verified the old deployment stayed 404). ADS_LIVE_LAUNCH,
  STRIPE_LIVE_ENABLED, MESSAGES_LIVE unset. Smoke checks passed; PoolThru rows identical across 40 tables. No migrations.
  Rollback: delete ADS_ENABLED + redeploy, or roll back to deployment 72b6fb33 (99be975).
- Sandbox polish (branch feature/ads-sandbox-polish, NOT deployed): Google/Meta sign-in now returns to the Ads tab with a
  visible result (connected, cancelled, timed out, access not granted, production account refused, …) instead of the
  Overview with nothing shown; "Testing mode" note (test accounts only, nothing charged); account-list errors get Try
  again; reconnect/error texts no longer mention typing account or manager IDs. Browser test now also covers a
  production-only Google sign-in (refused, clear message, recover by reconnecting), server refusal of non-test /
  manager / production / unknown account ids, duplicate create prevention, cross-business isolation, 360px width.
  Real-API check of the discovery code against the sandbox is pending an owner sign-in (read-only script prepared).
- Test-business isolation: DEPLOYED 2026-11-13 (8ac2392, deployment 482358a5; migration 0012 applied before deploy,
  integrity ok, PoolThru identical). gsu-stripe-test-pools NOT yet marked (needs the admin signed in to /admin).
- Ads review UX (2026-11-13, branch feature/ads-review-ux): one owner step "Approve and create (paused)" when the account
  is connected (Start stays separate); "Where: people in ZIP …"; every result tile says where its number comes from.
- Google Ads conversion feedback: DEPLOYED OFF 2026-11-13 (9565e99, deployment 6281da42): conversion actions via the
  Google Ads API at campaign creation; Data Manager events:ingest uploader (lead/booked/completed, deduped, retries);
  encrypted 90-day click ids; privacy text. Turning it on needs approval (new sensitive scope + OAuth verification).
- Google Ads connection management: DEPLOYED 2026-11-13 (207af88, deployment 0b341010): Disconnect (pause-first or
  leave-running, honest notice, no revoke), guided setup when a sign-in has no Ads account, payment status from Google,
  in-app data-use disclosure, privacy policy now describes Google Ads use.
- Google Ads verification + safety + compliance gate: DEPLOYED 2026-11-13 (60e94fe, deployment 0e4a154a): read-back of created
  campaigns (after creation + daily), Google state reconciliation, account-switch approval reset, lower-budget
  enforcement on running campaigns, Maximize clicks bidding, accurate charging wording, optimizer recommend-only by
  default (policy). docs/GOOGLE_ADS_COMPLIANCE.md: verified Google facts + our Test-level status + launch blockers.
- First PoolThru sandbox campaign (2026-11-13): NOT created. The owner approved a $500/month budget and ran Check (no
  spend), but never approved the campaign itself (draft umfJ…, no approver), and its daily budget ($20) is above the
  approved ceiling ($16.44/day). Creating it needs the owner to set ≤ $16.44/day and press Approve, then Create. Audit
  fixes on branch feature/ads-campaign-quality: towns split on commas (keywords were "… charleston mount pleasant"),
  owner exclusions → negative keywords, near-me/local keywords, campaigns target people located in the ZIPs (PRESENCE).
  Next missing piece: conversions back to Google (store gclid per lead, a conversion action, upload booked/completed).
- Ads connection status polish: DEPLOYED 2026-11-13 (1eae80e, deployment a144ea2c).
- Ads connection status polish (details): four states in words +
  icon (✓ Connected / • Choose an ad account / ! Reconnect required / ○ Not connected); primary button only for Connect
  or Reconnect required, otherwise a muted secondary Reconnect link; "Test mode" badge note + "Test account · no spend"
  badge; duplicate-draft notice neutral (was the red error style), "Google Ads is connected" success in green.
- Campaign review: DEPLOYED 2026-11-13 (f95717e, deployment c2e89690). Root causes found in PoolThru's data:
  services saved as one comma-joined item → template headline cut to "Weekly pool cleaning, Pool mai"; two identical
  drafts 12.5 s apart = "Draft my plan" clicked twice (no guard). Launch was already duplicate-safe (atomic claim +
  tagged-name lookup on Google). Fix: services split on commas/newlines; whole-word headlines; one open draft per
  platform (atomic, before any AI cost); review UI with preview, budget summary, per-field counters/inline errors,
  explained Check/Approve/Create, confirm steps for Create and Remove. PoolThru's existing 2 drafts are kept (notice).
- Google Ads account selection UX: DEPLOYED 2026-11-13 (d466e3c, deployment 7c7c96e6).
- Google Ads account selection UX (details): Google sign-in and
  the chosen Ads account shown separately; selected account shown once with a checkmark; Change account only when
  another eligible account exists; exactly one eligible + nothing chosen before → selected automatically (not after a
  test-business unmark reset). Frontend + e2e mock scenarios only; server rules unchanged.
- Website URL input: DEPLOYED 2026-11-13 (3f870cf, deployment e2122dce). server/url.js normalizeWebsiteUrl()
  for every business; Ads profile website accepts example.com / www / http / https (https default), refuses unsafe.
- PoolThru Ads sandbox: DEPLOYED 2026-11-13 (c46662a, deployment 8b69546f; ADS_BUSINESSES = gsu-stripe-test-pools,
  poolthru-llc). Owner connect (step 6) pending.
- PoolThru Ads sandbox prep (2026-11-13, branch feature/ads-sandbox-pilot, NOT deployed): sandbox launch/resume on a
  verified Google Ads test account no longer requires a GetShowUps subscription (pilots are never billed); live keeps
  the rule. Enabling PoolThru = add poolthru-llc to ADS_BUSINESSES (secret) + redeploy (approval). PoolThru stays a
  REAL business (never marked test); ADS_LIVE_LAUNCH off keeps it on test accounts only.
- Admin console layout: DEPLOYED 2026-11-13 with PR #5 (0f6e2dd, deployment 7205a098).
- Admin console layout (2026-11-13, branch feature/admin-test-businesses-section, NOT deployed): the Customers list
  shows real businesses only; marked businesses appear only under a separate "Test businesses" section (frontend only,
  same API/metrics). Admin e2e MRR check made race-safe (selfserve.spec can add a real $0 subscription in parallel).
- Test-business isolation (2026-11-13, branch feature/test-business-isolation, NOT deployed): migration
  0012_test_businesses.sql (new table only; dry-run on a production copy: applied twice, integrity + FK ok, PoolThru
  identical). Admin marks/unmarks in the console (confirm + audit). Marked: Test tag, out of customer counts / MRR /
  rates; Google Ads test accounts only even with ADS_LIVE_LAUNCH; only MESSAGE_TEST_RECIPIENTS even with
  MESSAGES_LIVE (lead messages, outbox, SMS, GHL workflows); Stripe checkout/portal refused with a live key. Unmark:
  records created up to that moment stay sandboxed; Ads connections reset to "choose an account". Business
  structure: PoolThru (real pilot) and GetShowUps (real pilot) never marked; gsu-stripe-test-pools to be marked after
  deploy. Order: migrate BEFORE deploy (the overview reads the table; other paths fail closed).
- Production OAuth (2026-11-12, owner): Ads callback URI registered on the production Web client (verified by a
  no-sign-in authorize probe), adwords scope listed, consent screen In production / External, user cap 3/100.
- Single-business pilot still needs (each an approval): deploy PR #1 (migrations: none new);
  ADS_ENABLED=true + ADS_BUSINESSES=<pilot id>; a test connection first. Real (non-test) accounts additionally need
  Explorer/Basic access on the Cloud project and ADS_LIVE_LAUNCH=true + an owner budget approval before any spend.

### Ads Overview (2026-11-11): built on feature/ads-overview, NOT deployed (needs approval)
- Overview "Advertising" row when ADS_ENABLED: ad spend, clicks, leads from ads, bookings, show-ups, cost per
  booking, cost per show-up (server/ads/campaigns.js adSummary). Real data only: spend/clicks from
  ad_metrics_daily (null until recorded), leads from lead_attribution for the business's own campaigns, test
  leads excluded; costs null without spend or a denominator ('—' in the UI).
- Website → booking attribution: the website already carries utm_*/gclid onto booking links; now covered end to
  end (ad click on /p/:id → booking link → lead credited to the campaign). No Google Ads API calls.

### AI website usage policy (2026-11-11): LIVE (e3f4ebe, deployment 378c4c67; migration 0011 applied)
- Was: rate rule websiteGenerate 10/day per business (UTC-midnight window) shared by generations AND revisions,
  counting failed attempts; plus 40 AI results per rolling 30 days. Every 429 showed "several versions today".
- Now (server/ai-usage.js, table website_ai_usage): per business per UTC day, only successful AI results count.
  testing (platform-admin sign-in or AI_TESTING_BUSINESSES) 200 generations / 400 revisions; paying (hosting
  active incl. pilots) 20 / 40; not yet paying 5 / 10. 30-day AI cost ceiling $10 / $2 / $0.50 (measured avg
  $0.0005 per AI result). Burst guard websiteAi 30 attempts / 10 min. Manual edits unlimited. The dashboard
  shows "N of M left today · resets at <local time>" and specific limit messages.

### Dashboard preview showed an unkept revision (2026-11-11): LIVE (e94c0e8, deployment 0f8e2bac)
- Cause: Website tab kept a "Describe a change" revision pinned in the Preview after "Start over with three new
  designs" (the revision box unmounted without clearing it), so the preview showed a design that was not the
  draft while Publish sent the draft. Not caching, stale data or a renderer difference: generation option,
  saved draft, preview and live site were verified byte-identical in production.
- Fix: the pending revision is cleared on start-over and on apply; an unsaved revision is labelled
  "New version · not saved yet" and publishing waits until it is kept or discarded. Regression: website.spec.js.

### Website images and headlines fix (2026-11-10): LIVE (f1a2128, deployment 7ec4f896)
- Cause: PoolThru has no business_profiles row in production → industry null → stockFor() fell back to generic
  home- photos (house, kitchen, living room); a ZIP-only area ("ZIP codes 29403") was given to the AI as the area.
- Fix: industryKey() from industry → service names → description → name; each industry has only its own photos,
  palettes, names and art direction; unknown industry → no stock photo (text-led). Stock refs outside the
  business's industry are rejected on generate and revise. Headlines: brand (legal suffix dropped) + service + city;
  ZIP codes rejected unless the owner asks; ZIP-only areas aren't shown as copy.
- Existing drafts and published sites are not modified (PoolThru's live site keeps its current design until a new
  one is generated and published). Tests: test/website-images.test.js (pool, cleaning, lawn, trades, unknown).

### AI website design upgrade (branch release/ai-design, NOT deployed; awaiting visual approval) (2026-11-10)
- The AI now makes structured design decisions, not just copy. One request (Mistral Small 3.1 on Workers AI)
  returns the copy plus three designs chosen from a safe design system (server/site-design.js): palette (8,
  AA-checked, 2 dark), typography (5 self-hosted OFL pairings), hero layout (split / immersive / stacked /
  typographic), services (cards / numbered rows / tiles), about (split / statement band / plain), shape, section
  order and photo placement. The server forces the three to differ (hero, palette, fonts) and repairs any invalid
  choice. No AI-written HTML/CSS/JS.
- Photos: the owner's uploads first (the main photo always wins), otherwise a curated CC0 stock library of 20 photos
  in 5 industry groups (public/site-stock, 1600 px + 900 px versions, licence records in server/stock-photos.js).
  The "Our work" gallery shows only the owner's photos.
- Revisions: "Describe a change" (free text or suggestions such as "Make it more modern" or "Use my photos") → one
  request → a pending version shown in the preview → Keep this / Go back. The draft and live site change only when
  kept and published.
- Existing sites: content without a design renders through the original renderer unchanged (PoolThru live and
  draft are unaffected until the owner chooses a design).
- Measured with the real model through the app (local workerd): create 12.5–14.3 s, 817 in / ~530 out tokens,
  $0.00058; revise 6.5–9.6 s, ~1,240 in / 320–383 out tokens, $0.00061–0.00065. Limits: 10/day plus 40 per
  30 days per business; edits, previews, design switches and visits never call the model.
- Known limitation: the copy can still contain vague, unverifiable phrasing ("our dedicated team", "you can trust")
  that passes the claims and number filters. The owner reviews everything before publishing.
- Tests: 265 unit (website-ai.test.js 13), 55 Playwright (design picker, revision keep, owner photo on the public
  site). Screenshot review gallery generated locally from the running app (session scratchpad, not committed).

### Milestone A: AI website generation (branch release/ai-websites, NOT deployed) (2026-11-10)
- Flow: Create my website → one Workers AI request (Mistral Small 3.1 24B) → choose a design from 3 side-by-side
  previews of the stored result → private draft → large desktop preview with a phone toggle → simple editor and
  photos → publish. Onboarding also offers "I already have a website" (keeps it; booking link shown at the end).
- Model choice (real Workers AI evaluation, 3 business profiles, 2 prompt rounds): mistral-small-3.1 had 3/3
  valid JSON, ~5 s and the best copy. llama-3.3-70b: valid JSON but flat copy and 9x the output price. llama-4-scout:
  11–21 s. gpt-oss-120b and qwen3/3.8: unreliable JSON. Through the app on local workerd with the real model: 2/2
  ai, 3.8–4.8 s, ~440 in / ~230 out tokens, $0.00028 per generation, 0 fields rejected.
- Safety: facts only from records; the claims filter plus the invented-number check, falling back to the template
  per field; never changes the draft or live site without the owner applying or publishing.
- Migration 0010 (additive): website_generations (content, tokens, cost_micros, latency, rejected fields).
- Tests: 259 unit (website-ai.test.js +7), 55 Playwright (generator flow, AI stand-in that also checks the filter).
- Needs approval: the Workers AI binding `AI` on the Pages project (production), migration 0010, deploy.

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
- Release verification (2026-11-10): fixed onboarded self-serve businesses being sent back into setup, a
  domain status that could get stuck at "Securing" when the HTTPS check can't reach the domain, and readiness
  counting test bookings. 0009 was verified on a fresh production export. Real image upload is e2e-tested on workerd.
  Local PoolThru preview: `npm run preview:poolthru`. Runbook: docs/RELEASE-managed-websites.md.
- Tests: 252 unit, 55 Playwright. Mocked: DNS, hosting provider, HTTPS probe, Stripe, Google. Not live-verified: the
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
