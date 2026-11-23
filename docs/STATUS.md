# Status, decisions, next actions

_Update at the end of every task. Newest first._

## Google acquisition engine, step C: campaign templates (2026-11-23) — feat/ads-templates (uses 0037's ad_templates; curated templates work before it)

- Seven curated Search templates (pool cleaning/repair, HVAC maintenance/repair, plumbing, electrical, roofing) that
  pass the spec limits and the claims filter and are fitted to the business (name, town, ZIPs, exclusions, chosen
  budget); the trade's templates are suggested first. "Start with a template" sits beside "Draft my plan" in Review
  your campaign and produces ONE editable draft (one open draft per business; every later step unchanged). An imported
  Search campaign or a draft can be saved as the business's own template (normalized: no account identifiers, claims
  filtered; ≤ 20, removable). Route /api/dashboard/ads/templates. No performance is claimed for any template.
- Verified: unit test/ads-templates.test.js (4), browser Journey B (first-time advertiser, both projects) and the
  "Save as a template" step in Journey A. Nothing on Google, nothing spent.

## Google acquisition engine, steps A + B: existing campaigns and Local Services leads (2026-11-23) — feat/google-ads-import (migration 0037, NOT applied yet)

- Step B (Local Services Ads): leads of an imported Local Services campaign are read from `local_services_lead` into
  `lsa_leads` (per business + Google lead id; type, status, charged, credit state, category, creation time; contact
  details never selected), 90 days first then 30 days restated; the Ads tab shows leads by type, charged / credited /
  booked in Google, cost per charged lead (campaign spend ÷ charged leads) and recent leads; a business without a
  Local Services campaign gets a facts-only readiness checklist with Google's setup link (the API cannot create one).
  Unit test/ads-lsa.test.js; Journey A browser test extended. Step A below.

- Journey A (the business already advertises): the campaigns in the connected Google Ads account are read with GAQL
  searches only into `ad_imported_campaigns` / `ad_imported_metrics_daily` (type, Google status + serving status,
  budget, settings snapshot: locations by name, languages, schedules, negatives, ad groups, keywords, responsive search
  ads, final URLs, conversion goals; Google's daily spend/clicks/impressions/conversions) and shown read-only in the
  Ads tab ("Your Google Ads campaigns": period 7/30/90, status in words, each row opens its settings). GetShowUps'
  own campaigns are skipped; removed campaigns are marked and kept; no mutate ever; no contact details.
- Reads happen after the account choice (waitUntil), on Refresh, and by the cron `imports` step (20 h gap, failures
  retried after 1 h, 5 businesses per run; `ad_import_state`). First read 90 days, later 3 days restated.
- Migration 0037 creates these tables and the ones for steps B–E (`lsa_leads`, `ad_templates`, `gbp_connections`,
  `ad_change_requests`); everything fails soft until it is applied (section hidden, route `{ ready: false }`, cron
  `not_ready`). Account deletion erases the new tables (ERASED_TABLES). **Applying 0037 to production needs approval.**
- Google facts verified 2026-11-23 (docs/GOOGLE_ACQUISITION.md): API v26.2; standalone Local Services campaigns
  cannot be created through the API (status/budget mutable; leads read-only, no cost field); Business Profile API
  access is an application to Google (0 QPM until approved) with its own OAuth scope.
- Verified: unit 6 new tests (test/ads-imports.test.js) + full suite; browser "Journey A" (connect with the
  ads-existing stand-in → auto-selected account → Refresh → two campaigns with status/budget/numbers → settings in
  words → 7-day period → read-only → isolation). Against Google's real API: nothing (Test access).
- Next: step B (Local Services leads + cost per charged lead), C (templates), D (Business Profile), E (edits with
  approval, recommendations, KPIs).

## Product UX refinement after inspection (2026-11-23) — fix/ux-refinement (no migration)

- Inspected the authenticated product on the seeded e2e server (desktop 1440, phone 390, 320): Overview, Appointments,
  Follow-ups, Receptionist, Teach Your AI, Ads (fresh, connected, with campaigns), Settings, onboarding, sign-in.
  Left unchanged on purpose: Appointments, Follow-ups, Settings, onboarding, sign-in, Teach Your AI (already compact,
  the four-step strip answers knows → does → test → publish), the Ads editor/review/budget cards.
- Four demonstrated problems fixed, smallest change each: (1) Overview "Needs your attention" rows on phones wrapped
  the sentence into a three-word column beside the button → the action now sits beneath the sentence ≤560px;
  (2) a business that never advertised saw seven dashes with "no ad spend recorded" → the note now says what to do
  ("connect an ad account in the Ads tab …"), tiles unchanged; (3) Receptionist: the on/off switch, greeting and notes
  sat under the voice card ("Turn it on below" pointed 1,400px down) → Settings now precedes Receptionist voice;
  (4) Ads: with a campaign in place the nine-field business form pushed the campaign card below the fold → it folds to
  one line of facts (industry · services · ZIPs · budget, "Edit" opens the form; `data-profile-fold`).
- Homepage: NOT changed. The requested paragraph ("Get your ads, AI receptionist, and bookings running in under an
  hour…") promises ads running, which no customer can do today (ADS_LIVE_LAUNCH off, Google Ads API at Test access,
  no Meta app); hands-on setup of the receptionist, booking page and an ad draft in under an hour IS supported by the
  journey runner. Alternative wording awaits the founder's approval (see the report).
- Tests: browser assertions for all four changes (ads.spec fold + note, dashboard-receptionist.spec order,
  tour.spec attention layout per project); unit 829.

## Self-service tools for every eligible business (2026-11-22) — feat/self-service-tools (no migration)

- Owner decision: Ads and Teach Your AI are part of the product for every eligible business, with no per-business
  allowlist and no platform-admin activation; new businesses see both the moment their dashboard opens.
- Root cause of "hidden": two pilot allowlists (`ADS_BUSINESSES`, `AI_STUDIO_BUSINESSES`, each empty = nobody) gated the
  tabs and routes; production listed only the pilot businesses, so a new business, the GetShowUps workspace and most
  test businesses had neither tab. Meta's missing Connect is a different cause: no Meta app exists (see below).
- Change: ONE eligibility rule (server/eligibility.js): `hostingActive` (paid/trialing/past due, never-billed pilot,
  complimentary account; not a self-serve sign-up before payment, not an ended subscription) for Ads (a suspended
  business keeps the tab so the hold notice says why its ads are paused), `businessEligible` (+ active business) for
  Teach Your AI and Website Studio (which already used this rule). The allowlists are ignored; emergency off switches
  (default on): `ADS_ENABLED=false`, `AI_STUDIO_ENABLED=false`, `WEBSITE_STUDIO_ENABLED=false`. Live use is unchanged:
  `ADS_LIVE_LAUNCH` (off), `AI_RULES_LIVE_BUSINESSES` (empty), test businesses never live, holds, budget approval,
  subscription rule. The Ads tab shows the connection card from day one (no business details needed to connect);
  the Meta row's "Not available yet" wording now says the platform isn't set up (there is no app to "approve"), and
  every Meta sign-in outcome has a plain notice (not_configured, rate_limited, reconnect_required, transient,
  permission_denied, app_not_approved, invalid_request, signin_required). Teach Your AI says when the receptionist is
  off (rules can be prepared and tested meanwhile). Business Review's Teach Your AI state reads the new rule.
- GetShowUps workspace: the `getshowups` business already exists in production (created 2026-11-22 by the console's
  one-click sales setup; one member = the founder's platform-admin sign-in; receptionist on; profile and hours set; no
  website, ad profile or AI rules yet; no billing rows, so hosting is 'active' as a never-billed pilot; excluded from
  metrics as SALES_BUSINESS). With this release it gets Ads and Teach Your AI like PoolThru, nothing created or changed.
- Verified: unit 829 (new test/eligibility.test.js: standing by billing status, suspended, switches, old allowlists
  ignored, fail-closed; rewritten Ads/Google/Teach/overview/results/readiness gate tests), browser (see the PR):
  every-business Ads tab with both platforms disconnected + the Meta-unconfigured row + sign-in outcome notices,
  Teach Your AI first screen for a business that never set up its receptionist, the journey's paid business sees both
  tabs, suspension keeps Ads and withdraws Teach Your AI, dashboard tab list, 320 px without sideways scroll.
- Meta connection (investigated 2026-11-22, read-only): no Meta app exists anywhere (repo, docs, Keychain by name,
  Cloudflare secrets/vars: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_SANDBOX_AD_ACCOUNTS`
  all absent); no Meta connection, campaign, lead event or audit row in D1; the live routes answer 503 not_configured
  and the webhook handshake 403. Real OAuth cannot work until the founder creates the app (docs/META_ADS.md "Exact
  next action"); nothing about Meta is verified against the real API.
- Production: no secret or setting changed; `ADS_BUSINESSES` / `AI_STUDIO_BUSINESSES` stay set but are ignored (may be
  removed at leisure). No Google campaign, voice, messaging or PoolThru setting touched.

## Meta Ads sandbox-to-launch workflow (2026-11-22) — feat/meta-ads-sandbox (no migration)

- Already built before this task (PR feat/meta-ads-testing, 2026-11-21, mocked): Meta OAuth with state cookie and
  long-lived exchange, ad account + Page auto-selection, encrypted token storage, the Meta spec/editor/preview/review,
  dry run, PAUSED-only creation (idempotent, partial failures keep ids), read-back verification, Start/Pause/budget,
  insights, the signed + idempotent lead webhook with per-Page routing and attribution, tenant-isolation tests.
- Newly completed (docs/META_ADS.md "Added 2026-11-22"): token refresh by re-exchange (cron `metaTokens`; expired →
  reconnect_required); the Ads tab's Meta account + Page picker; sandbox ad accounts (`META_SANDBOX_AD_ACCOUNTS`;
  "Sandbox account · no spend"; create/start/change without the live switch, like Google test accounts); Meta's
  official test-lead API from the card ("Send a test lead" → `POST /{form}/test_leads`, delivered through the webhook,
  matched by `platform_ids.testLeadIds`, marked test data, attributed to the campaign, never counted); Meta leads
  enter the follow-ups engine with source `meta_lead_form`; `verifyLaunched` reads back Meta campaigns daily (it was
  Google-only); the browser suite now has a deterministic Graph stand-in (OAuth, accounts, objects, read-back, status,
  insights, test leads delivered to the app's webhook signed with the app secret) and a full Meta sandbox test.
- Verified: unit (token refresh due/not due/expired/refused + cron counts; sandbox account start/refusal; daily
  verification + reconcile for Meta; test lead creation/replacement/refusals + webhook marks test + attribution;
  existing OAuth, launch, read-back, errors, webhook replay/isolation tests) and the browser test above. Against
  Meta's REAL API: nothing (no app exists); documented as such in docs/META_ADS.md with the exact external steps.
- Meta API facts re-checked 2026-11-22: live doc pages show Graph v27.0 as latest while the changelog index lists
  v26.0 (keep v27.0, `META_API_VERSION` overrides); test leads are organic, one per form, no API flag (hence our id
  matching); long-lived tokens re-exchange while valid, an expired token cannot; sandbox accounts have no API flag.
- Production: nothing changes for owners (Meta stays "Not available yet" until the app secrets exist); no Google
  campaign, voice setting or customer-facing setting touched; no spend anywhere.
- Next (human): docs/META_ADS.md "Exact next action": create the Meta app + set the three secrets, create the app's
  sandbox ad account + set `META_SANDBOX_AD_ACCOUNTS`, run the sandbox flow on a test business, then Business
  verification + App Review; `ADS_LIVE_LAUNCH` and a real campaign only with a separate approval.

## Voice cost controls and provider comparison (2026-11-22) — feat/voice-cost-controls (no migration)

- Usage so far (production records, 2026-11-22, every kind of session): ElevenLabs 6 sessions / 3.2 min (2 Lab,
  4 admin tests; one 70 s test with audio both ways, no booking), OpenAI 4 Lab sessions / 3.4 min (80k input tokens,
  3.2k output tokens measured by the adapter), Retell 4 customer-path rows / 9.7 min + 1 Lab call / 4 min. Estimated
  cost of all of it: about $0.27 (OpenAI) + $0.24 (ElevenLabs) at the public per-minute prices; Retell is not
  estimated. No verified charge exists yet: nothing was ever read back from a provider.
- What the providers can report (docs read 2026-11-22): Retell `GET /v2/get-call/{call_id}` → `call_cost.combined_cost`
  in cents with product lines; NO balance endpoint (a 402 on call creation = credit balance exhausted, our code
  `voice_billing`). ElevenLabs `GET /v1/convai/conversations/{id}` → `metadata.cost` (credits) and `cost_fiat` (USD,
  optional) + `charging.llm_charge`; `GET /v1/user/subscription` → `character_count` / `character_limit` (credits used
  / allowed this billing period). OpenAI: the organization costs API needs an admin key; a project key gets nothing;
  only the adapter-measured tokens exist.
- Built (server/voice/budgets.js, charges.js, compare.js, src/admin/Comparison.jsx; details in docs/RECEPTIONIST.md
  "Cost controls"):
  - Limits that refuse a start at the ceiling, customer path AND Lab: per provider per day
    (`VOICE_PROVIDER_DAILY_MINUTES`, per-provider `_OPENAI | _ELEVENLABS | _RETELL`; Retell only when its own switch is
    set), per test business per day (`VOICE_TEST_DAILY_MINUTES`, default 30, admin tests + Lab calls), the existing Lab
    and per-business ceilings. Ended rows count their full length, open rows at most 15 min. The Lab shows every
    budget with ok / near the limit (80%) / used up and the switch that sets it.
  - Verified charges on the admin's request ("Fetch verified charges": ≤ 20 sessions per run, one business when given,
    audited): Retell cents and ElevenLabs credits (+ USD when reported) stored on the session as the provider's
    numbers; failed lookups are codes retried after an hour; credits are never converted to dollars; OpenAI is
    reported as unsupported. The ElevenLabs conversation id the browser SDK reports on connect is now recorded
    (`providerSessionId`, session action `provider`) so a charge can be looked up; sessions before this release have no
    id and stay "no provider id recorded".
  - "Check provider balances": ElevenLabs' subscription read only on request; Retell/OpenAI say they have none.
  - "Providers compared (last 30 days)": sessions, connection failures (rate), booking tool (bookings of sessions
    that reached the availability lookup), latency (lower median of adapter medians; Retell not measured), minutes,
    estimated cost, verified charges, estimated cost per finished session and per booking; connection failures and
    incomplete bookings under disclosure as codes.
- Tests: test/voice-budgets.test.js (limits per provider/test business/Lab with warnings and refusals, isolation
  between businesses; charges attributed to the right session, errors as codes, business filter never touches another
  business, audited, owners/anonymous refused; provider ids recorded once; comparison numbers; balances only where an
  API exists; status route). 822 unit pass; browser suite unchanged.
- Not changed by this release: no provider setting, no call started, no customer-facing setting. Nothing is monitored
  continuously; every provider read is an admin's click. NOTE (post-release check of the records, 2026-11-22): the
  provider configuration itself changed BEFORE this release by the founder's own console actions, audited
  `receptionist.global_provider_switched` (22:11 UTC, ElevenLabs → OpenAI, mode all, version 2) and
  `receptionist.global_provider_promoted` (22:13 UTC, version 3): all six businesses, PoolThru included, moved from
  Retell to OpenAI Realtime and follow the default. "ElevenLabs staged, six businesses on Retell" is no longer the
  state; Retell is the previous provider the console can roll back to.
- Next decision (human): whether to fetch the verified charges now (one click; reads Retell/ElevenLabs records for the
  last 30 days' sessions) and whether the default test ceiling (30 min per test business per day) and the provider
  ceilings (600 min/day OpenAI and ElevenLabs; Retell uncapped) are the numbers you want; a Retell cap needs
  `VOICE_PROVIDER_DAILY_MINUTES_RETELL` set on the Pages project (approval).

## ElevenLabs test calls dropping on the customer path: diagnosis + diagnostics (2026-11-22) — fix/elevenlabs-disconnect-diagnostics (no migration)

- Report: `/chat/gsu-stripe-test-pools?test=elevenlabs&from=admin` showed "The call dropped" on every attempt.
- Production records (codes and timings only; no logs exist for the browser side): three ElevenLabs admin-test
  sessions on gsu-stripe-test-pools (20:10, 21:21, 21:22 UTC) each got a signed URL (POST /voice 200, a
  receptionist_calls row) and ended 3–5 s later with metrics turns 0 · micLive 0 · audioReceived 0 · reconnects 0,
  connects 1, outcome null, no receptionist_events. Two "Talk again" attempts on the same conversations never ended at
  all (no metrics); the third attempt was a NEW conversation. The 19:30 session on gsu-journey-test (same code, same
  agent) ran 70 s. Both businesses' connection payloads have the same shape and size (prompt 6.0 KB vs 6.7 KB, the same
  four dynamic variables, no voice override), and PR #123 touched nothing on the connect path.
- What the records could NOT say: why. The SDK rejects `startSession` with `SessionConnectionError { closeCode,
  closeReason }` when the provider closes the WebSocket during the handshake (its own reason text, e.g. an override the
  agent does not allow → 1008), and the adapter threw both away: it reported `connect_failed` → the page's generic
  "The call dropped", sent the end WITHOUT an outcome (so the verification record called it a clean end with "audio not
  measured"), and stored no disconnect record. Confirmed root cause of the diagnosis gap: a client lifecycle bug (lost
  close code), not a session limit (0 of 3 concurrent, minutes under the cap at the time) and not a tool failure (no
  tool ran). Whether the provider's 3–5 s close is a 1008 policy refusal (agent/overrides/account) or a transport
  failure is exactly what the next test will now record; it cannot be read from the existing rows.
- Three more defects confirmed from the same rows and reproduced in tests:
  1. **Retry lost its token**: `startCustomerVoiceSession` returned `token: existing?.token || conv.token`, but a loaded
     conversation carries no token (it is derived, never stored) → a "Talk again" on the same conversation handed the
     page `token: undefined`; every later request of that session (tools, transcript, END, refresh) answered 404, the
     session stayed open, and the page's refresh dropped the conversation → the next attempt was a new conversation.
     Fix: the token is derived again for a resumed conversation (`conversationToken`); the page also keeps its own.
  2. **Open rows ate the day**: `businessMinutesToday` / `providerMinutesToday` / `labMinutesToday` counted a row
     without `ended_at` as running "until now": the two open rows would have exhausted gsu-stripe-test-pools' 120 min
     by ~21:41 UTC (`voice_limit` for the rest of the UTC day) and the provider's 600 min overnight. Fix: an open row
     counts at most the session ceiling (15 min).
  3. **No end on page close, no handshake bound**: the end request was a plain fetch (cancelled on unload) and a
     socket that opened but never confirmed left "Connecting…" forever. Fix: the end is sent `keepalive`, `pagehide`
     ends the provider session and records `page_closed`, the handshake times out after 20 s (`connect_timeout`) and a
     late session is ended, never kept.
- Diagnostics now recorded on every non-clean end (src/voice/elevenlabs.js `disconnectInfo` → voice-session `end`
  `{ outcome, disconnect: { phase: start|live|reconnect, code, closeCode, reason } }` → server/voice/sessions.js
  `cleanDisconnect`, stored on `state.voice.disconnect`; the Lab's end carries it too): codes map RFC 6455 close codes
  (1000 before the handshake → closed_before_start, 1006 → socket_closed, 1008 → provider_refused, 1009 →
  payload_too_large, 1011–1013 → provider_error, other → provider_closed, no code → socket_error / connect_failed),
  the reason is the provider's close text as printable ASCII ≤ 120 chars (never audio, transcript or a credential).
  `providerVerification.latest` / `voiceSessionHistory` / rollout `connectionFailures` treat a disconnect record or a
  failure outcome as a connection failure; a retry on the same conversation keeps earlier attempts in
  `state.voiceHistory` (the console history lists them as `<id>#n`).
- UX: the chat page says what happened per code (refused before start / hung up before start / connection closed /
  didn't answer in time / …) and keeps the microphone for a retry; on an ADMIN test page a line under the call bar
  shows the record (`data-test-diag`: code, phase, close code, reason, the session id) and keeps it across a retry
  until a new call ends. The Voice Lab's "Last test" line adds the connection record in words + the close code and
  reason (`rollout-state.js DISCONNECT`); Advanced details show "Last session ending".
- Reproduced in a real browser against the local e2e server (temporary ElevenLabs stand-in + Playwright
  `routeWebSocket`, not committed): a 1008 close → page "The voice service refused this call before it started", record
  `provider_refused` 1008 + reason, retry on the same conversation with its token, both attempts ended and listed;
  1006 → `socket_closed`; a hanging handshake → `connect_timeout` after 20 s. The browser suite cannot carry this
  (four specs assert ElevenLabs is "Not configured" there); the adapter is covered in node with the SDK's error shape.
- Tests: 818 unit (3 new/extended: adapter disconnect records, timeout, pagehide, keepalive; customer path record,
  sanitising, history, verification path, token on retry, capped minute sums); browser suite unchanged.
- Production state untouched: ElevenLabs staged, six businesses on Retell, no promotion, no booking, no message.
- Next (human): open the Voice Lab → Test ElevenLabs on gsu-stripe-test-pools once more. If it drops again, the card
  and the test page now show the close code and the provider's reason; a 1008 with an "Override … not allowed" or
  "Missing required dynamic variables" text is an agent-configuration fix (scripts/elevenlabs-setup.mjs --agent-id …
  --apply), a quota text is an ElevenLabs account matter, 1006/socket_error is the network path.

## ElevenLabs verification diagnosis + Voice Lab consolidation (2026-11-22) — feat/voice-lab-consolidation (no migration)

- Diagnosis (production records, codes only): the founder's ElevenLabs test on 2026-11-22 17:37 UTC (conversation on
  gsu-journey-test, provider elevenlabs, admin test, 70 s, mic live + AI audio received, outcome ended) WAS recorded and
  attributed correctly, but its tools were check_service_area ✓, save_customer_details ✓✓, request_coverage ✗
  (zip_missing): the receptionist took the service-area path (gsu-journey-test lists ZIPs 29401/29403; the caller's
  place was not served) and never ran find_available_times / book_appointment. providerVerification therefore stayed
  "missing tools, booking" and the console said "Needs verification" without saying why. Nothing was lost or rejected;
  the test was incomplete for the verification's requirements. Two contributing choices of ours: the console picked
  gsu-journey-test (alphabetical) although gsu-stripe-test-pools has no service-area list, and the instructions never
  said which ZIP to give.
- Fix: providerVerification now returns `latest` (the newest finished production-path session: audio / availability /
  booking / clean end, the tool list, the failed tool codes from receptionist_events, and a `path` code) and the
  console says what the last test showed and missed and exactly what to retry, with the ZIP to say; eligible test
  businesses without a service-area list come first (production now picks gsu-stripe-test-pools); after Test is
  opened the card polls the facts (8 s, on focus, ≤ 15 min) until the session is recorded, so no manual refresh.
  Verification rules unchanged (audio both ways + availability + simulated booking + clean end in one session).
- Consolidation: /admin/voice-lab is the one voice page (src/admin/VoiceLab.jsx): Provider card (tiles to choose the
  target, state, counts, one next action: Test → Activate for all businesses → monitoring → Roll back), Businesses
  under disclosure (Businesses.jsx, the per-business control unchanged), Lab call under disclosure (compare providers,
  voices, latency; not the customer path). The Voice providers tab is retired; /admin/voice-providers[?customer=]
  lands on /admin/voice-lab with the deep link. Owners/anonymous: unchanged (403/401, no tab).
- Tests: test/voice-testing.test.js (latest-session record incl. the production shape, test-business order);
  test/e2e/voice-rollout.spec.js (renamed; tiles, redirect, Activate flow), voice-lab.spec.js (disclosure),
  admin-layout.spec.js (tab list, redirect keeps the layout).

## Voice provider rollout UX + test-page access (2026-11-22) — feat/voice-rollout-ux (no migration)

- Root cause of the unusable test page: `/chat/gsu-stripe-test-pools?test=elevenlabs` showed "Chat isn't available
  right now" because the public info route (`GET /api/receptionist/<id>`) answers `enabled: false` whenever the
  business's receptionist is off for customers, and both production test businesses (gsu-stripe-test-pools,
  gsu-journey-test: active, test-marked, calendar connected, no receptionist_settings row) are off by design. The chat
  page stops there, before its `?test=` logic; the voice route itself already accepted admin tests regardless of the
  receptionist switch. So no test session could ever start without exposing a sandbox receptionist to customers.
- Fix (smallest): `server/voice/testing.js adminTestAccess` = signed-in platform admin + admin-marked test business +
  configured, not-switched-off provider; the info route honours `?test=<provider>` through it: the page renders
  voice-only for that admin (`testOnly`: typed chat stays off, dry run, "Back to the Admin Console"), everyone else
  keeps the unavailable page plus the refusal code (test_not_allowed / not_test_business / voice_not_configured /
  voice_unavailable / invalid_provider) explained on the page. Customers' availability unchanged; no business turned on.
- Console: `globalOverview` now carries `verification` (providerVerification of the current default, records only)
  and `testPage` (`testPageFor`: the first eligible test business = admin-marked, active, bookable, receptionist-on
  first; none → reason). /admin/voice-providers redesigned (src/admin/GlobalProvider.jsx, VoiceProviders.jsx,
  rollout-state.js, voice-providers.css): one card per situation (provider, state badge, "X of N using it · 6 still
  using Retell", verification line, ONE next action: Test <provider> → Promote to 100% → monitoring → Roll back);
  promotion = checklist + one typed confirmation (acknowledgement for untested businesses kept; blockers by name);
  Advanced details holds versions, counts by kind, the verification record, the test business; Businesses = compact
  table (name, provider, follows the default / business-specific, readiness, Manage); Rollout monitoring only after a
  rollout. ProviderControl (per business) and the server-side safeguards (checks, atomic batch, audit, rollback) unchanged.
- Tests: test/voice-testing.test.js (info route access matrix incl. live business and switched-off provider; eligible
  test businesses; verification record flips only on a qualifying session); test/e2e/voice-providers.spec.js rewritten
  for the new UI (+ the test page on a receptionist-off test business for admin vs anonymous/owner/live business, 320px
  and tablet layout with the review open, rollback from the monitoring section).
- Production after deploy: ElevenLabs still staged (version 1), 6 businesses on Retell pins, 0 promoted. Next action:
  Test ElevenLabs from the console (opens /chat/gsu-stripe-test-pools?test=elevenlabs&from=admin), then Promote to 100%.

## Dashboard → Receptionist: honest channel statuses (2026-11-22) — fix/receptionist-status (no migration)

- Root cause of the misleading page: the "Browser voice" tile mapped the server's `voiceStatus: 'testing'` (the
  business's ACTIVE provider is Retell and the business is not on the Retell release list RECEPTIONIST_VOICE_BUSINESSES)
  to "In testing, not available yet", which reads as a product still in testing; the voice integrations are
  production-capable (#117), the state is a per-business release switch. The headline said "Working" without saying
  which channel; "Phone calls: Not connected" implied the owner could connect one (no line can exist yet); "Team
  notifications: Test mode" gave no reason.
- Fix (src/dashboard/Receptionist.jsx channelTiles): every tile = state + reason + next step from the capability facts
  the API already returns (chat = model configured; voiceStatus available | testing | not_configured, resolved
  server-side from the business's active provider; staffEmail = MESSAGES_LIVE gate; phoneLine false). Browser voice:
  Active (voice really answers customers) · "Not turned on yet" (reason: released business by business; admins viewing
  the page also see the release list / console next step; owners never see a provider name) · "Not available"
  (provider not configured). Headline: "Answering on website chat" / "Answering on chat and browser voice" / "Not
  answering" / "Off". Phone calls: "Not available yet". Team notifications: test mode + why. The customer chat page's
  two "in testing" lines say "isn't available for this business yet". Provider controls stay admin-only (unchanged).
- Regression: test/e2e/dashboard-receptionist.spec.js (owner not released vs released, traced to the API; no provider
  name/control for owners; every dashboard tab by click both ways, direct links, back, tablet width; desktop + phone).
  e2e: RECEPTIONIST_VOICE_BUSINESSES now lists the mobile voice business so one business shows Active.
- Production facts: RECEPTIONIST_VOICE_BUSINESSES=poolthru-llc,bob-electrical → those two show Active; getshowups
  shows "Not turned on yet" (Retell, not on the list) until it is added or its provider is switched/promoted.

## Promote the staged provider to 100% + Admin Console layout (2026-11-22) — feat/global-promotion (no migration)

- Production before this work: global default ElevenLabs version 1 (staged), all 6 businesses pinned to Retell, 0
  switched: the staged rollout worked as designed but nothing could release the pins without 6 individual tests.
- Promotion (server/voice/global.js checkGlobalPromotion / promoteGlobalProvider, route actions global_promote_check /
  global_promote, console block "Promote <provider> to 100%"): ONE action for every business in scope. Evidence policy
  split: PROVIDER-level verification (providerVerification: a finished production-path session on the target in the
  last 30 days with audio both ways, availability + booking tools through our server, a clean end; Lab sessions do not
  count; done on a test business) + automated BUSINESS-level compatibility (checkProviderSwitch minus the evidence:
  configuration, customer path, switched off, eligibility, tools, voice on this provider valid or absent, catalog).
  A missing per-business test is a WARNING (`unverified`) the admin acknowledges explicitly (`acknowledgeUnverified`,
  recorded in the audit as a count; nobody is reported as individually tested); booking not ready / receptionist off
  are warnings (the promotion doesn't change them); everything else blocks and the whole promotion is refused (all or
  nothing, blockers by name). Scope: businesses that follow the default + rollout pins (pinOrigins: an override on the
  provider a version pinned it to, no admin switch since) ; deliberate overrides only with `includeOverrides` (shown as
  untouched otherwise); suspended businesses excluded (a suspended one that follows the default follows the new one).
  Released pins and replaced overrides get an inherit row (they FOLLOW the default; no permanent override on the new
  provider); their previous provider is recorded in the version's `switched[].kind/from` for the rollback.
- Atomicity: the defaults row is inserted first with provider = CASE WHEN every in-scope business still has the
  settings version + inheritance the checklist saw THEN provider ELSE NULL (NOT NULL violation → the whole batch rolls
  back; test proves nothing applied). Version PK stops concurrent promotions; a repeat finds no_change. Rollback
  (global_rollback, same guard) restores the previous default, moved rows, released pins (kept recognisable as pins)
  and replaced overrides, keeps a business whose owner chose a voice on the new provider (reported), audited.
- Monitoring (globalRolloutStatus in the overview): sessions on the current default since its version (newest 500),
  businesses, connection failures (session outcomes connect_failed / reconnect_failed / connection_lost / disconnected /
  microphone), tool + booking failures (the engine's tool outcomes), minutes + cost estimate; null = "unavailable".
- Layout bug: /admin/voice-providers rendered as a ~220px column after a tab click (fine after reload only when the
  Voice Lab chunk's CSS was present): `.cc--single` lived in voice-lab.css, which Voice providers never imports, so the
  one-column modifier existed only when that chunk had loaded. Moved next to `.cc` in control.css. Regression:
  test/e2e/admin-layout.spec.js clicks through every admin tab both ways without reloading, direct links, back/forward,
  desktop + phone, measuring the rendered column width and sideways scroll.
- e2e seed: every seeded business is now a rollout pin on Retell (defaults v1 staged ElevenLabs + v2 rollback; rows on
  Retell); behaviour is Retell everywhere as before, and the promotion spec has pins to release.
- CI note: PR #120's first verify run failed only on the known studio-editor mobile flake (Add a section options 11 ≠ 2
  after the legal-page switch; the retry inherits the first attempt's state); 234 passed; local gate green. Re-run by a
  docs-only push (the token cannot re-run CI). Still open: make that spec's page switch + publish step idempotent.
- Production: default unchanged by the deployment (ElevenLabs v1, 6 pins). Still needed before a promotion: a finished
  ElevenLabs test session on the production path (/chat/<test business>?test=elevenlabs by a signed-in admin), then
  Promote to 100% → acknowledge → type `elevenlabs` → confirm.

## Global default AI voice provider (2026-11-22) — feat/global-voice-provider (migration 0036)

- Resolution: explicit business override → global default (receptionist_voice_defaults; no row = Retell) → Retell.
  receptionist_voice_inherit marks settings rows that only hold owner preferences (they follow the default).
- Console section "Global voice provider": current default, who follows it, who overrides; choose → Review all
  businesses (platform checks + every inherited business through its own checklist, blockers by name) → all at once
  (only with nobody blocked) or staged rollout (unverified businesses pinned to today's provider, by name) → provider
  id typed → Change; global rollback likewise. Audited (global_provider_switched / _blocked / _rolled_back,
  provider_pinned). Sessions in progress stay pinned; overrides untouched.
- Production: migration 0036 applied; no defaults row → Retell stays the default until the founder confirms another
  provider in the console. Tests: test/voice-global.test.js (sequence Retell → OpenAI → ElevenLabs → Retell, inherit,
  overrides, pins, "all" refused, rollback incl. kept businesses, sessions pinned, concurrent isolation, route auth +
  typed provider), existing voice tests updated for the resolution; e2e voice-providers.spec global section.
- CI note: the first verify run of PR #119 failed only on the known studio-editor flake (click timeout at 90 s, retry sees
  the first attempt's state); the local gate passed 235/235. Still open: make that spec's publish step idempotent.

## Admin Console: voice-provider management for any business (2026-11-22) — feat/admin-voice-providers (no migration)

- Why: the provider control lived only in the business dashboard, and an admin can be a member of one business
  (customer_users.email), so providers of other businesses could not be managed.
- /admin/voice-providers + GET/POST /api/platform/voice-provider (server/voice/admin.js): pick a business → facts,
  stored configuration, readiness/evidence/blockers (providerOverview), voice-session history (codes only) → the SAME
  ProviderControl (Select → Test now → Review → Activate → Rollback) bound to the platform route, with the business
  named on the page and its id typed back before a switch or rollback (server-enforced `confirmCustomer`).
- Unchanged: checkProviderSwitch / switchProvider / rollbackProvider and their audit records; dashboard authorization;
  no business's provider switched; no phone routing, billing or unrelated features touched.
- Tests: test/voice-admin.test.js (authorization, membership not needed, deleted businesses excluded, view + history
  without personal data, typed-id guard, blocked/passing switch audited, rollback, other business untouched),
  test/e2e/voice-providers.spec.js (live business blocked; test business with evidence: Review → Activate typed →
  audited → Roll back typed), seeded business e2e-voice-switch.
- Next: run the admin test sessions on a test business from /admin/voice-providers (Test now) to collect production
  evidence for OpenAI/ElevenLabs; grant `voices_read` on the ElevenLabs key.

## Universal AI receptionist: customer-facing voice on Retell, OpenAI Realtime and ElevenLabs (2026-11-22) — feat/universal-voice (no migration; PR for approval)

- server/voice/customer.js + public routes voice / voice-connect / voice-tool / voice-session: provider decided
  server-side, sessions pinned, tools through our runner (real for customers, dry run for admin tests), limits, lifecycle;
  the chat page runs the provider the server returns. Readiness is evidence-based (finished session with audio both
  ways + availability + booking tools); admin flow Select → Test now → Review → Activate → Confirm; rollback kept.
- Live: scripts/voice-live-check.mjs ran one real session per provider (OpenAI, ElevenLabs) through the customer-path
  functions: greeting, price, area check, availability, details and (adaptive) booking confirmation, audio both ways.
- Unchanged: Retell default for every business without a row; PoolThru untouched; no phone routing; no fallback.

## Receptionist voice management (2026-11-22) — feat/receptionist-voice (migration 0035; PR for approval)

- Owners: Dashboard → Receptionist → "Receptionist voice": voice from the active provider's catalog (provider samples
  as previews, one at a time, labelled), personality preset (style only), pace where supported, Save/Cancel, versioned
  saves. Admins (platform list, server-checked): "AI voice provider" control with honest readiness, a checked +
  confirmed + audited + reversible switch; OpenAI/ElevenLabs are test only (no customer path) and cannot be activated;
  no provider has phone routing. docs/RECEPTIONIST.md "Voice management".
- Facts: customer-facing voice = Retell browser calls only; Retell accepts a per-call voice/pace override
  (`agent_override.agent`, API accepted live 2026-11-22; audible result to confirm in a joined Lab call);
  ElevenLabs tts overrides enabled on the agent (setup script); OpenAI voices fixed, no samples, no pace.
- Existing businesses (no row) are unchanged: same Retell call body, same prompt (Balanced = no personality block).
- Tests: test/voice-settings.test.js (catalog, cache, validation, owner preferences, concurrency, isolation, routes,
  admin switch/blockers/rollback/audit, per-provider application, prompt), test/e2e/receptionist-voice.spec.js
  (owner desktop+phone, admin desktop), voice-lab.spec updated (Retell faked in e2e).

## ElevenLabs in the Voice Lab: connect the published agent in place (2026-11-22) — feat/elevenlabs-existing-agent (no migration; PR for approval)

- The ElevenLabs path (adapter, signed-URL route, shared tool runner, metrics, cost estimate) already existed; what
  was missing is a credential and a way to use the owner's dashboard-published agent. `scripts/elevenlabs-setup.mjs
  --agent-id` now configures an existing agent in place (model/temperature/voice/language kept; our tools, overrides,
  auth, events, ceiling set; name untouched; never a second agent; agent_not_found / invalid_agent_id refused);
  `scripts/voice-provision.sh elevenlabs --agent-id <id> --apply` does key check → agent → both secrets.
- 2026-11-22 connected: key `getshowups-elevenlabs-api-key-v2` (Conversational AI read+write), agent
  agent_8901m80mefhme349tzxvbeh9hrjd configured in place (7 tools, overrides, auth, {{greeting}} first message), secrets
  ELEVENLABS_API_KEY/ELEVENLABS_AGENT_ID set (effective on the next deployment = this PR's merge). Live session verified
  from the server module (signed URL → WebSocket → greeting spoken). Fixes found live: ElevenLabs refuses a first_message
  override (greeting is now a dynamic variable) and tool parameters without a description (422). OpenAI remains the Lab
  default; nothing customer-facing; PoolThru untouched. PR #114 released separately (main f89f4fd).
## Receptionist location policy: ZIP only when needed (2026-11-22) — fix/receptionist-zip-policy (no migration; PR for approval)

- Prompt (server/receptionist/knowledge.js): "answer first, location only when needed, a town is fine, one ask, a
  declined or deferred ZIP is respected"; the job line no longer leads with checking the area.
- Engine (server/receptionist/engine.js): `zipDeferral` / `noteZipDeferral` remember a refusal or deferral
  (phrase about the ZIP, or any refusal right after a ZIP question; five digits are never a refusal); the per-turn
  note then says "do NOT ask for it again … say once when they want a visit booked"; area-check notes say "answer
  what they asked; when they want a visit or ask whether you serve them, ask once"; `save_customer_details` returns
  `zip_deferred` for provider paths; the shared voice tool runner records the deferral from the caller's words.
- Unchanged: booking still requires a ZIP (missingForBooking), areaFor decides out-of-area, coverage never claimed
  from a place, OpenAI Realtime audio path and latency (instructions built once per session).
- Tests: test/receptionist.test.js "location policy" (pricing first, refusal remembered across turns and in the
  provider path, place as context, out of area, booking readiness, phrase rules).

## Website Studio legal pages + complete domain setup (2026-11-22) — feat/legal-pages-domain-setup (no migration; PR for approval)

- **PoolThru findings (read-only):** the "broken Privacy Policy link" is not on our site. Authoritative DNS (Google
  Cloud DNS at Squarespace Domains) has www → getshowups.pages.dev, but Cloudflare's public resolver still answers the
  old `ext-sq.squarespace.com` (TTL ≈ 3.5 h, re-learned repeatedly), so visitors on that resolver get the OLD
  Squarespace site, whose footer links /privacy-policy and whose unknown paths answer a 301 loop (server: Squarespace).
  On GetShowUps hosting (resolved directly to Cloudflare), / , /privacy and /privacy-policy → /privacy all answer 200;
  PoolThru's imported privacy page exists; there is no terms page. Our domain checks used only Cloudflare's resolver,
  which is why the dashboard said "Waiting for your DNS change" for days while the site worked elsewhere (row now
  `connected` since 02:30 UTC). The bare domain poolthru.com points at Squarespace's A records and Squarespace forwards
  it to https://www.poolthru.com (301, path kept, query string dropped).
- Studio: "Add a page" offers Privacy Policy and Terms of Service as legal pages (text only, kept as written, footer
  links, kept through redesigns, explicit review before publish); old addresses for terms forward.
- Domains: two-resolver checks with `propagating` / `dns_inconsistent` details; root-domain state (forwards / http
  only / other / none / points here; path + query kept?); DNS provider from nameservers; provider-specific forwarding
  steps; six-line checklist; Check now always available. Nothing stored beyond the existing row; DNS never changed.
- Owner actions for PoolThru: in Squarespace Domains → DNS make sure only ONE www record exists (disconnect the old
  Squarespace site from the domain so its default www record disappears), keep MX/TXT; the forwarding for poolthru.com
  already works but drops ?utm/gclid (Squarespace forwarding); optionally add a Terms page in the Studio.

## Business account types + PoolThru internal live (2026-11-22) — feat/business-accounts (MIGRATION 0034, needs approval)

- docs/ACCOUNT_TYPES.md. New table business_accounts (0034): classification (internal_live | sandbox | customer),
  billing (complimentary | stripe), environment (production | sandbox), provider_spend (allowed | blocked), note,
  set_by, set_at. No row = paying customer (unchanged behaviour); reads fail soft before the migration.
- Enforced server-side: hostingStatus active for complimentary; createCheckout refused; owner billing route "not
  billed, complimentary" (Plan card "Complimentary GetShowUps account"); legacy onboarding path; no billing holds;
  lifecycle stage `complimentary`, no recovery; reconciliation never auto-resyncs them; metrics never count them as
  paying/MRR/test subscriptions; provider_spend blocked → public receptionist off + liveFor() false. Sandbox =
  test_businesses mark set/cleared with the environment.
- Admin → customer → "Account type" (classification, entitlement, environment, spend, subscription state, estimated
  provider costs per source, audited history, confirmed reclassification with reason) and Admin → Platform → "Create
  an internal or sandbox business" (optional owner; never a payment step). /api/platform/account: platform admins
  only, same-origin, confirm, audited once (admin_audit + audit_log) with from → to. A LIVE Stripe subscription still
  running blocks a move away from "paying customer" (nothing cancelled automatically).
- PoolThru (poolthru-llc) production facts read-only: no self_signups row (already exempt by absence), subscriptions
  `incomplete` with a Stripe test customer and no subscription id (checkout opened, never paid), no modes row, not a
  test business, domain www.poolthru.com row `securing`, 6 leads / 3 appointments / 5 conversations. Migration in
  place = one audited classification to internal_live after 0034 + deploy; Stripe records untouched.
- Owner approvals: apply 0034; merge/deploy; classify PoolThru (console, audited).

## OpenAI Voice Lab: silent audio fixed (2026-11-22) — fix/openai-voice-lab-audio (no migration; awaiting deploy approval)

- Root causes: (1) src/admin/VoiceLab.jsx handled adapter events as one object while every adapter emits
  `(name, payload)` → the page ignored every status/transcript/error (shared Lab bug: affected Retell and ElevenLabs
  displays too; the adapters themselves are unchanged); (2) src/voice/openai.js played the remote track only into an
  injected `<audio>` element the Lab never passed → nothing was ever played; (3) nothing proved audio flowed.
- Fix: the adapter creates its own hidden audio element inside the Start click, plays the remote stream, reports
  `audio_blocked` with an "Enable sound" retry, meters the microphone and the remote stream (status `mic` /
  `audio`), reports a silent microphone after 8 s; the Lab accepts `(name, payload)`, labels every adapter state,
  shows "Mic: … / AI audio: …" badges and plain-language errors (never credentials).
- Evidence: one real gpt-realtime session through the actual adapter in Chromium (fake microphone with a synthesized
  caller; server pieces in node; dry run): greeting spoken, caller transcribed, 2 interruptions handled, first reply
  165 ms, remote level peak 0.22, no errors, no key leak. Tests: test/voice-openai.test.js (+2: element creation,
  playback, blocked autoplay, levels, mic_silent, audio_unavailable), e2e voice-lab + voice-mic.
- Not changed: Retell path, ElevenLabs adapter, billing, limits (dry run default, admin-only, one call, 15 min, daily
  minutes). Deploy needs the owner's approval (PR open).

## Voice providers provisioned the Retell way (2026-11-21/22) — feat/voice-provisioning (no migration)

- `scripts/voice-provision.sh <provider> [--apply]`: Keychain (`getshowups-<provider>-api-key`) → read-only check
  against the provider → Pages secret by pipe; never prints the value. ElevenLabs `--apply` also creates/updates the
  Lab agent through the API (scripts/elevenlabs-setup.mjs) and sets `ELEVENLABS_AGENT_ID`.
- OpenAI Realtime: the key already in Keychain (demo item from 2026-11-16) lists every `gpt-realtime*` model and
  minted a 10-second client secret (HTTP 200, no usage) → `OPENAI_API_KEY` set on the Pages project 2026-11-22;
  applies on the next deployment. The Lab then shows OpenAI "Configured"; sessions are server-issued ephemeral
  secrets (server/voice/openai.js), tools run server-side with dry run, the permanent key never reaches the browser.
- ElevenLabs: no key in Keychain or Cloudflare. Owner creates the account + an API key with Conversational AI
  permissions, stores it once, runs the script with `--apply`; the agent is created by API (no dashboard work).
- Lab test business for the sales knowledge: `getshowups-lab` is not created yet in production (one click, Admin →
  Platform) and would have no calendar (no owner row: an email owns one business). Availability lookups in the Lab
  need a test business with a calendar: link a second email to `getshowups-lab` (admin customers route / invite) and
  connect a calendar from its dashboard, or use another admin-marked test business that has one.
- Retell unchanged. Nothing customer-facing, no phone routing, no unattended usage.

## Operational launch sprint, step 4: Admin → Growth (Measure | Simulate | Decide) (2026-11-21) — feat/admin-growth (no migration)

- **Measure** (server/growth.js, GET /api/platform/growth): the admin overview's own queries, each figure labelled
  live / test / estimated / unavailable with its sample and the 30-day range (leads, qualified, prospects,
  consultations booked/attended, paying customers and MRR live-only, conversion rates, synced ad spend, CAC
  unavailable until spend and closes coincide, retention). Test businesses, test leads, internal addresses excluded.
- **Simulate** (server/growth-model.js, pure; src/admin/Growth.jsx): straight-line funnel with spend, churn and
  months; baseline vs scenario, new customers, new and total MRR vs existing, cost per customer, payback,
  sensitivity; prefilled from measured data only above minimum samples (10 leads / 8 qualified / 5 booked / 5
  attended), otherwise labelled assumptions. Price is modeling only: never touches Stripe (e2e asserts no billing
  request). Labelled scenario with limitations, never a forecast.
- **Decide**: deterministic rules with minimum samples along the funnel; too few leads → a no-spend volume
  experiment; the first stage under its threshold → one concrete experiment with modeled upside, cost, effort and
  evidence strength; never recommends spend, never acts.
- Platform metrics keep their operational figures; the commercial sales line links to Growth. Sign-in may return to
  /admin/growth and /admin/voice-lab. Customer dashboards unchanged.

## Operational launch sprint, step 3: Meta ads for controlled testing (2026-11-21) — feat/meta-ads-testing (no migration)

- On the existing Ads architecture (same drafts, approvals, budget ceiling, holds, attribution): the Meta spec gains
  placements (facebook / instagram; both = automatic), an age range (18–65) and an optional stop date (ad set
  end_time; the owner sees "most it can spend" = daily × days). Payloads carry publisher_platforms / age_min /
  age_max / end_time.
- **Read-back verification for Meta** (server/ads/meta.js verifyCampaign): campaign, ad set and ad are read back and
  compared with the approved draft (status, objective, daily budget, ZIPs, placements, ages, optimization goal, end
  date, ad present); runs right after creation (campaigns.launch now verifies for every adapter that can) and daily
  (verifyLaunched); a deleted campaign reconciles to "removed"; a provider failure is a failure, never "removed".
- **Owner photos as creatives**: POST /api/dashboard/ads/creative { action: 'from_asset', assetId } turns one of the
  business's own website photos (never a logo, never another business's) into an ad image (storage_key asset:<id>,
  no AI, no cost); still needs the owner's explicit approval; the Ads tab lists the photos (ids only).
- **Meta editor in the Ads tab**: goal (leads, instant form), where (ZIPs) and who (placements, ages), the ad (texts,
  description, button, form questions), image (approved creatives or a website photo), budget (daily + stop date +
  total), preview with image and button, and a review list the approval covers; "Check (no spend)" builds the exact
  payloads without any Meta call. Wording is platform-aware (no more "Google" on Meta cards). The connection row says
  honestly that Meta isn't connectable yet and why.
- Business Review: ads.meta describes the workflow, names the external blocker (Meta app + Business verification +
  App Review) and the switches. docs/META_ADS.md = readiness report + the founder's external steps + the smallest test.
- Production: nothing changes for owners until META_APP_ID/SECRET exist (approval); creating a paused campaign also
  needs ADS_LIVE_LAUNCH=true (approval); starting one is a separate owner action. No spend anywhere.
## Operational launch sprint, step 2: Voice Lab provider readiness (2026-11-21) — feat/voice-lab-readiness (no migration)

- The Lab answers the owner's eight provider questions per provider from configuration only (providerReadiness:
  built / credentials (missing setting NAMES) / account or billing to set up / can a browser session run now / tools
  safe / transcripts + latency recorded / cost estimate / smallest authorized test, plus voice settings and blockers),
  shown as "Readiness: <provider>" under the setup and returned by the status route. Production today: Retell ready
  (configured, Lab on); OpenAI needs OPENAI_API_KEY; ElevenLabs needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID (both
  are paid-service activations: approval).
- OpenAI sessions take a per-session voice (allowlisted OPENAI_VOICES; stored on the Lab conversation, used when the
  client secret is minted, audited). Retell/ElevenLabs take voice from their agent (stated in the panel).
- Tests: test/voice-readiness.test.js; voice-openai (voice override + fallback); e2e voice-lab (panel per provider,
  blockers named, voice select only for OpenAI).
## Operational launch sprint, step 1: Business Review in plain language + reconciliation scopes (2026-11-21) — feat/operational-readiness (no migration)

- **Business Review → "What this means for operating"**: the same capabilities grouped as Broken right now / Works
  now / Can be tested now / Needs configuration / Needs your approval / Not built (server/ops/review.js `groupOf`,
  derived from status + health + state), each with a one-line next step and a link to the existing setup screen
  (registry `action`, same-site only). Tiers (registry `tier`): needed to operate now / before live payments / before
  live advertising / optional / not needed now, with each tier's blockers (capabilities neither working nor testable).
  Status badges, evidence, incidents and approvals unchanged.
- **Reconciliation differences are classified** (server/reconcile.js `scopeOf`): `real` (a business in our records),
  `test_business`, `unknown_record` (an id that doesn't exist here). Only real differences are a problem: the Business
  Review evidence and the admin card say "No differences for real businesses; N for test or unknown records (sandbox
  leftovers)". Production 2026-11-21: all four differences are `unknown_record` ids (`gsu-billing-test-a`,
  `gsu-billing-test-temp`, `gsu-sandbox-check-…`) from sandbox checks against Stripe test mode: not lost revenue, no
  webhook defect (those ids were never businesses here). Nothing in Stripe was changed.
- Production facts gathered read-only (D1/KV names and counts only): the `getshowups` sales business EXISTS and its
  calendar is connected (enrollment `salesChat: true`); a clean visitor session on the live site saw the homepage
  entry, an accurate $499/month answer, "ad spend is separate", and two real open consultation times (nothing booked).
  PoolThru: active, hours confirmed, `at_customer`, website live (version 13), receptionist on, 6 leads, 3
  appointments, 2 outcomes recorded, 5 conversations, no ZIP list (every area counts as in).

## Voice Lab usable by the owner + one-click sales records (2026-11-21) — feat/voice-lab-usable (no migration)

- **LIVE 2026-11-21**: PR #103 merged pinned (head 8d9087b) → main 48ea7c7 → production deployment
  48b0da36-5316-4cad-ab44-f180b7d1ef1d. Rollback target: 466866fa-fc7f-48ea-8731-7872b08c41b6 (main 1caf455; the
  VOICE_LAB_ENABLED secret would stay set but that code has no Lab routes). `VOICE_LAB_ENABLED=true` was set on the
  project before the merge, so this deployment carries it. Verified after deploy: Lab routes answer 401 signed-out
  (404 before the flag), sales-business route 401 signed-out, enrollment {open:false, salesChat:false},
  /api/receptionist/getshowups 404 (record not created yet), homepage without the sales entry, 7 of 8 customer pages
  byte-identical to the pre-release capture; the 8th (PoolThru home) differs only in its <title>/og:title ("PoolThru
  Pool Care"), a content change by the owner between captures: the previous deployment renders the same page and no
  renderer file changed in the release.
- Founder's next clicks: Admin → Platform → "GetShowUps sells itself" → Create the Voice Lab test business; Admin →
  Voice Lab → Retell → Start (dry run). Then Create the sales business and connect its Google Calendar from the
  dashboard to open /chat/getshowups and the homepage entry.

- **VOICE_LAB_ENABLED=true** set on the Pages project for restricted administrator testing (owner approval in the
  brief of 2026-11-21), after re-checking the safeguards: every Lab route is platform-admin only (401/403 otherwise),
  sessions run only on admin-marked TEST businesses, dry-run by default, a daily minute budget, one Lab call at a time
  (new `lab_busy`), ≤ 15 minutes per session, nothing starts without the admin's Start, and no customer configuration
  or the live Retell agent is touched. Ordinary customer accounts never see the Lab (the admin shell authorizes).
- **Retell in the Lab = the production path on a test business**: `POST /api/platform/voice-lab/retell` creates the
  Retell web call for the Lab session with the shared agent (key server-side; browser gets the per-call token); the
  custom-LLM socket answers a `retell-lab` call for an admin-marked test business while the Lab is on, even if the
  business is not in RECEPTIONIST_VOICE_BUSINESSES (never a real business this way). src/voice/retell.js is a real
  adapter now (retell-client-js-sdk: speech, barge-in, transcript, browser-measured first/median/p95 reply). A Lab
  conversation's dry-run now reaches the engine on every path (`respond()` reads `conv.state.lab.dryRun`), so a
  Retell Lab booking is simulated; tool outcomes for Retell come from the engine's events into the summary.
- The Lab says what each provider bills and the limits before Start; new error codes (lab_busy, reconnect_limit,
  voice_billing, voice_unreachable).
- **One click in Admin → Platform → "GetShowUps sells itself"**: creates the sales business `getshowups` (real;
  Software playbook, Founding plan $499/month, Mon–Fri 9–5 Eastern, 20-minute consultations, receptionist on with the
  greeting and approved answers from server/sales.js; the admin is its owner) and/or the Lab test business
  `getshowups-lab` (admin-marked test, same configuration). Idempotent, audited. The founder still connects the
  Google Calendar from the dashboard; until then the public sales chat (bookableCustomer) and the homepage entry stay
  off and the console says so.
- Tests: test/voice-retell-lab.test.js (call creation, row, socket authorization incl. Lab off / real business,
  gates, reconnect cap, busy, dry-run simulated booking, tools from events), test/sales-business.test.js, e2e
  voice-lab (one click → Lab offers the test business, sales record real, chat still closed).
- Still not in production (approval): OPENAI_API_KEY, ELEVENLABS_API_KEY/AGENT_ID (those providers stay "Not
  configured"), any phone number or telephony, outreach.

## Revenue-first: GetShowUps sells itself (2026-11-21) — feat/sales-agent (no migration; nothing switched on)

- Audit (docs/SALES_PLAYBOOK.md §1): the funnel already works end to end for an owner-operated pilot; the two gaps for a
  first sale were a sales conversation and a founder's view of the sales stages. Target market chosen: residential pool
  service companies, Charleston area first (§2); the offer, demo path and objection answers are in §3–§5.
- AI sales assistant = the existing receptionist on a GetShowUps business record: industry "Software" selects a new
  `sales` playbook (server/receptionist/knowledge.js) that changes the questions and the wording only (sales assistant,
  free consultation call instead of a visit, no ZIP/address, never promise results or invent features, ad spend
  separate). Every guard is unchanged (listed price only, confirming words, one booking per conversation). Setup is a
  5-minute founder task in the product (§6); no code or data change on our side. Test: a prospect conversation books a
  consultation without a ZIP, "$499/month" allowed, "$299" blocked.
- Homepage: GET /api/enrollment now also returns `salesChat` (server/public.js salesChatAvailable: the `getshowups`
  business is bookable AND its receptionist is on); the early-access section then offers "Ask our AI about GetShowUps"
  → /chat/getshowups. Absent today → nothing shown (e2e covers both).
- Admin growth metrics gained a sales funnel row (leads · qualified · callback requests · consultations booked · attended
  · paying · activated, 30 days) counted from the getshowups business's own records; null ("set up the GetShowUps
  business") until it exists, never zeros that look like data.
- Release 3 (customer value summary) skipped on purpose: Overview "Last 30 days", Appointments money per visit and Ads
  results already answer "should I keep paying".
- Not done (approval): sending outreach (drafts in §7), any ad spend (§7, prepared), creating the GetShowUps business
  record and connecting the founder's calendar (owner, §6).

## Release record: logo lifecycle, designer intents, Voice Lab, Retell conversation (2026-11-21) — PRs #98, #99, #100

- **Live:** main `896beee`, deployment `a418d208-7d0f-466b-a16b-8d7e0442626c`. Rollback target before all three:
  `fbc9d1ce-1fcd-4083-a4f7-c4b48440695c` (main `912a351`); intermediate checkpoints `2d0c984a` (after #98, main
  `2a2b6d0`) and `9e59a001` (after #99, main `d3c58e3`). No migration (0033 is still the newest); no binding, secret
  or flag changed; nothing sent, charged, launched or activated. Dependency added: `@elevenlabs/client` 1.37.1
  (lazy-loaded on the Lab page only).
- **Release A (#98, website and logo):** `content.logo === null` is "no logo, on purpose" and the current website is
  authoritative; Remove / Replace / Upload / Choose controls in the Studio and classic editor; permanent delete
  (`assets { action: 'destroy' }`) refused while live or in the draft, otherwise history invalidated in one batch;
  AI designer precise operations (remove/restore/replace logo, set headline, remove image, set section text) decided
  before any model call, with verified results and adversarial tests; a draft WITH a logo designs again.
- **Release B (#99, Voice Lab):** shared tool runner (server/voice/tools.js) with dry-run; Lab sessions on test
  businesses in the existing receptionist tables; admin-only routes `/api/platform/voice-lab/*` (404 unless
  `VOICE_LAB_ENABLED=true`); OpenAI Realtime and ElevenLabs adapters with server-only keys and short-lived session
  credentials; `/admin/voice-lab` tab; 46 scenarios + SIMULATED benchmark (no audio latency measured anywhere);
  docs/VOICE_LAB.md, docs/VOICE_PILOT.md.
- **Release C (#100, Retell):** direct answers (narration filter widened), `check_service_area { zip, place }` with
  fully-served towns from PUBLISHED live rules only, deterministic memory of place/problem/day, holding line only after
  700 ms, per-turn timings recorded, hesitant confirmations never book, tuned Retell profile for a TEST agent only
  (never applied).
- **Verified:** each PR green in CI; combined main `npm run verify:all` after the last merge (unit 760, Playwright
  219 passed / 2 skipped at the A+B+C checkpoint; final run on merged main `896beee`: lint clean, unit 760/760,
  build, Functions compile, Playwright 219 passed / 2 skipped); production after each deploy:
  all eight customer pages byte-identical (cf-email obfuscation aside), signed-out 401/403 on dashboard, platform and
  Lab routes, cross-origin writes 403, unsigned Stripe 400, PoolThru chat page loads with its greeting and sends
  nothing, booking page loads, 0 console errors; a 75 s production log sample captured no requests (so no errors
  observed, and no traffic either).
- **Not done (approval / external):** provider accounts and keys (OPENAI_API_KEY, ELEVENLABS_API_KEY/AGENT_ID),
  VOICE_LAB_ENABLED=true, ElevenLabs agent creation (`scripts/elevenlabs-setup.mjs --apply`), the Retell test agent
  (`scripts/retell-setup.mjs --tuned --test-agent … --apply`), any phone number or telephony, a real-audio
  benchmark with a human caller, the first owner-operated voice session. Provider recommendation therefore remains
  open: the simulated benchmark exercises the engine and guards equally for every provider; only real audio can
  rank them.

## Voice Lab tab + simulated voice benchmark (2026-11-21) — feat/voice-lab (on feat/voice-core; nothing switched on)

- `/admin/voice-lab` (src/admin/VoiceLab.jsx, lazy like Control/Review; Control Center tokens, one column, fits 390px):
  provider cards with honest status from GET /api/platform/voice-lab/status (configured / "Unavailable: not configured
  (which variables)"), daily minute budget used/left, test-business selector (server's list only), dry run ON by
  default with a warning when off, Start disabled with the reason (unconfigured provider, adapter missing from the
  build, no test business, budget used up), microphone asked inside the click (honest error, no session created),
  live connection state, transcript / tool results / latency / usage as the ADAPTER reports them, end-of-session
  summary from the engine (outcome, booked/simulated, estimated cost labelled "estimate, <source>" or "Not estimated"),
  recent sessions. Adapters load through `import.meta.glob('../voice/*.js')`: a missing module says "adapter
  unavailable in this build" (Agents D/E add openai.js / elevenlabs.js; coded against D's `create<Provider>Adapter()`
  shape). Retell = production path only: src/voice/retell.js opens `/chat/<test business>` in a new tab; its metrics
  come from engine events, no second Retell path. Nothing added to customer routes. The tab is shown to every admin
  (the page says "switched off" when VOICE_LAB_ENABLED isn't true). Note: server/auth.js safeNext doesn't list
  /admin/voice-lab (the console's sign-in link uses next=/admin, so sign-in lands on /admin); left for the owner.
- server/voice/scenarios.js: 46 realistic home-service calls (pool/HVAC/plumbing, visits at the customer's address)
  in 22 categories incl. every required one; lines carry what a competent listener would extract (the engine still
  verifies every digit). scripts/voice-bench.mjs: SIMULATED runner through the real `respond()` text path with a
  scripted stand-in or an adversarial model (fake Google; nothing external). test/voice-bench.test.js asserts the
  set and the invariants. Result: scripted 46/46 (25/25 bookings, 0 unauthorized / without a yes / duplicates,
  coverage 46/46, 0 repeated questions, 0 invented prices/times/promises, 0 leaks, 6/6 hand-offs, 2/2 interruptions
  dropped); adversarial 239 guard refusals, 0 violations. Engine timings only (p50 5 ms, p95 55 ms per turn); audio
  latency is NOT measured anywhere yet. The benchmark stays CLI-only (no /api/platform/voice-lab/bench route).
- Observation for the engine owner (not changed here, engine.js isn't in this workstream): `book_appointment` accepts
  any AFFIRM word contained in the caller's latest message as the confirmation quote, so "okay, let me think about
  it" would pass the confirmation check once a slot was offered and details are complete; the benchmark's hesitation
  scenario avoids that wording on purpose. Also unoffered times are not filtered by the engine on their own: in the
  adversarial run they were suppressed only because the same reply carried an invented price.
- e2e: test/e2e/voice-lab.spec.js (`--binding VOICE_LAB_ENABLED=true` added to serve.sh): statuses honest, start
  disabled with reason, only test businesses offered, dry-run warning, non-admin 403/401 + no tab, server refuses an
  unconfigured provider (409), @mobile no sideways scroll. docs/VOICE_LAB.md written (provider sections for D/E).
- Needs real measurement (credentials + a human caller): speech recognition on accents/noise, barge-in, response
  latency, voice quality, provider cost. The scenarios are written to be read aloud for that.

## Voice Lab: ElevenLabs adapter (2026-11-21) — feat/voice-elevenlabs (on feat/voice-core; no migration; nothing switched on)

- ElevenLabs Conversational AI as a Voice Lab provider (docs/VOICE_LAB.md §ElevenLabs; docs read 2026-11-21):
  server/voice/elevenlabs.js mints a 15-minute signed URL per connection with the server-only `ELEVENLABS_API_KEY`
  (`GET /v1/convai/conversation/get-signed-url`, header `xi-api-key`) and returns OUR per-conversation overrides
  (engine prompt from voiceInstructions + the business greeting, English), public dynamic variables and the seven
  client tool names; ≤ 3 connections per session (`reconnect_limit`); provider failures are codes and change nothing.
  Route POST /api/platform/voice-lab/elevenlabs (platform admin, same-origin, rate limit `voiceLabConnect`; 404 when
  the Lab is off or ElevenLabs is not configured). Browser adapter src/voice/elevenlabs.js (interface documented in
  src/voice/adapter.js: start/stop/state, events status · transcript · tool · metrics · error) on the official
  `@elevenlabs/client` 1.37.1 (exact, lazy-loaded on the Lab page only): WebSocket conversation with barge-in, every
  client tool call forwarded to /api/platform/voice-lab/tool with the caller's latest words, refused calls answered
  honestly (never thrown), transcript lines batched to the session, browser metrics (first/median/p95 response,
  interruptions, tools, reconnects), up to 2 reconnects with fresh signed URLs.
- scripts/elevenlabs-setup.mjs (key on STDIN; read-only unless `--apply`; never auto-run) creates/updates the Lab
  agent: seven client tools (`POST/PATCH /v1/convai/tools`, attached via `tool_ids`), overrides enabled for
  prompt/first_message/language, `enable_auth` + hostname allowlist, the client events the adapter needs, 15-minute
  ceiling, placeholder prompt ("This line is not set up yet") so a conversation without our override says nothing.
- COST_ESTIMATES.elevenlabs = $0.08/min (estimate; additional-minute rate on every Agents plan, LLM billed separately;
  elevenlabs.io/pricing/agents, 2026-11-21).
- Not live-verified: no ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID exist in production, so no real conversation was
  run; shapes come from the docs + SDK source and are covered with the API mocked (test/voice-elevenlabs.test.js).
- Next (approval items): create the ElevenLabs account/key, run the setup script with `--apply`, set the two secrets
  on the Pages project, VOICE_LAB_ENABLED=true, then one admin dry-run conversation on a test business.
## AI designer: precise actions (2026-11-21) — feat/designer-intents (no migration; nothing switched on; merges feat/logo-lifecycle)

- Problem: the conversational designer treated "remove my logo" or "change the headline to X" as a whole-site redesign,
  and the model could claim logo changes it cannot make.
- server/designer-intents.js: the message is read on the server BEFORE any model call (like Teach a Change). Fixed
  patterns → ONE operation from an explicit allowlist with schema-checked arguments: remove_logo, restore_logo
  (explicit "put my logo back" only; only an image this business owns and used as its logo), replace_logo (never picks
  or uploads: points to the Logo control), set_headline (first-screen heading or classic headline), remove_image (one
  referenced picture; ambiguity → the candidates are listed, nothing changes; a section's only content is protected),
  set_section_text (one field of one section). Owner text goes through the same gates (claims, invented numbers,
  limits) and refusals are named. Applied to a copy of the CURRENT draft → validateContent → saved → re-read →
  reported as found ({ applied, notApplied } in the NDJSON `done` event and in the reply). No model, no key, no daily
  allowance for these. Everything else (and `different`) is the unchanged designTurn.
- Logo persistence: the model answer can never set logo/hero/photos (siteOnly + validateSpec); content fields are carried
  from the current draft (`logo: ctx.draft.logo ?? null`); undo of a design turn restores the design only. Fixed on the
  way: designTurn/undoTurn validated the whole document against owned-minus-logos, so any draft WITH a logo failed with
  ai_invalid_output; now validateContent(…, owned, { photoIds }) (Agent A's option).
- Undo of a precise change = the draft checkpoint taken before it (website-history.js, reason before_designer_change;
  Agent A's SiteStudio REASON map should label it).
- Tests: test/designer-intents.test.js (13), test/designer-security.test.js (5: tenant, asset ownership, no execution /
  secrets, poisoned history / imported text / model replies, allowlist at schema and route), shared
  test/designer-harness.js; test/e2e/designer.spec.js "Remove my logo" through the UI (desktop + phone), logo stays
  removed through a later design turn. All mocked; nothing live-verified.
- Next: founder review of the pattern list in a real conversation (PoolThru); extend the allowlist only with new
  schema-checked operations, never free-form instructions.

## Flagship design: less text, more product (2026-11-21) — feat/flagship-design (frontend only; nothing switched on)

- Reference study: stripe.com, /payments, /billing, /payments/checkout, /pricing rendered at 1440 and 390 with
  Playwright (screenshots + computed styles in the session scratchpad; notes in the PR). Techniques taken as
  principles, not copied: one angled gradient canvas, product UI as the hero image, layered negative-spread shadows,
  bento cells with one line of copy, ink + slate two-tone headings on a cool `#f6f9fc`-style canvas, one accent for
  actions, phone layouts re-composed rather than shrunk.
- Visual system (src/index.css tokens, scoped use in src/app.css): the orange logo unchanged (byte-identical,
  flagship.spec asserts the SVG); `--beam` gradient (logo orange → sky → lavender) as the hero canvas, the setup/sign-in
  canvas and 4–5 px accent edges; tints sky / mint / lavender on the `--cloud` canvas; three shadow tiers.
- Homepage: hero beam; the dark stage now floats on a light sky-to-lavender wash (header stays light; flagship.spec
  updated). The problem section is one inquiry on two timelines (answered late → "Booked someone else"; answered now →
  "Booked · on your calendar"), labelled as an example. How it works = six cards drawn as the product state each step
  produces (website, chat reply, area/rule checks, open times, the appointment, the counts). Teach Your AI = the
  owner's rules beside the reply one of them decides ("Rule 3 applied"). Industries = three cards. Pricing card with a
  beam edge on the canvas. Copy cut to a line per idea: visible words 1,269 → 1,159 at 1440 (problem/industries/teach
  copy −35–45 %), no paragraph over 240 characters; flagship.spec guards both.
- Teach Your AI (src/dashboard/TeachAI.jsx, presentation only): a flow strip answers "what it knows → what it does →
  test it → publish" with live counts and the draft/published state; the editor sits left, the test conversation and
  publish panel right and sticky on wide screens (≥1100 px; the tab is now wide like Website); hints shortened; the
  draft-vs-published description is collapsed behind a summary; every control, validation message, platform-rule note
  and confirmation unchanged (teach-ai.spec unchanged and green). Rule engine, API and persistence untouched.
- App shell: cool canvas with a full-width white header band, cards with the small shadow tier, the Next step card as
  the one dark surface (beam edge, orange action), stage-coloured edges on the 30-day figures and attention rows,
  sign-in/setup on the beam canvas with a pill step bar. Semantic colours unchanged.
- Test clock fixes found on the way: test/release.test.js rate-limit tests now start away from a fixed-window edge (CI straddled 20:10:00 UTC and saw the per-IP count reset: 201 instead of 429); test/control-center.test.js freezes NOW at 2026-11-20 15:05 UTC but
  `incidentDetail` read the real clock for the phase label, so from 2026-11-21 15:05 UTC the open incident read
  "quiet" instead of "active" and `npm run verify` failed on main. `incidentDetail(db, id, now = Date.now())` now
  takes the clock (production call unchanged) and the test passes NOW. No behaviour change.
- Verification: unit 701/701, lint clean, build, Functions, Playwright full suite; three screenshot critique passes at 1440/1024/768/390/320
  (homepage) and 1440/390 (overview, appointments, follow-ups, receptionist, Teach Your AI, website, ads, settings,
  onboarding) in the scratchpad (design/baseline, pass1, pass2, pass3). Contrast (approximate AA script): homepage 0
  failures on opaque backgrounds after fixing the taken-slot colour; Teach Your AI and overview 0 failures.
- Untouched by design: customer websites (render goldens unchanged, live HTML compared after deploy), the customer
  booking page (.booking), the public chat page (.rcp; its pre-existing 22 px overflow at 320 px is noted, not changed).

## Launch readiness and first paying customer (2026-11-21) — feat/launch-readiness (no migration; nothing switched on)

- Decision page: docs/LAUNCH_DECISION.md. **Owner-operated pilot: GO with conditions** (founder alerts on,
  founder present at the Calendar step, support mailbox monitored). **Self-serve paid launch: NO-GO** until the
  non-engineering blockers clear (terms/refund/tax wording, accountant's sales-tax answer, Stripe live settings,
  Google sensitive-scope verification). No P0 defect in the product.
- Autonomous customer journey (test/e2e/journey.js + journey.spec.js, desktop + phone): a state-aware runner reads
  the real backend, names the next step, acts with fixture identities (two new listed testers in serve.sh /
  fixtures.env), waits for the state to move and diagnoses stuck steps. Proven MOCKED: sign_in → create_business →
  payment (declined/retry handled elsewhere; signed webhook) → details → services → calendar (real OAuth handlers)
  → hours → starter website → address → publish → launch → bookable; sign-out mid-way resumes at the pending step;
  half-set-up business is 404 publicly; duplicate checkout 409; Ads / Teach Your AI 404 when not allowlisted;
  invalid ZIP / honeypot / forged token / cross-site refused; booking lands on the mock calendar and the dashboard;
  same slot and never-offered time refused; other owner sees nothing and cannot cancel; signed-out 401; revoked
  Google grant → `calendar_reconnect` (owner told, founder live check `reconnect_required`, customer told honestly,
  request saved) → new grant → ready; returning customer straight to the dashboard; founder console: live, paid,
  1 booking, no flags. A non-tester is stopped at `create_business` ("Online sign-up opens soon"), nothing created.
- Fixed (found by the runner): (1) after sign-out or session expiry a customer who first arrived via the sign-up
  link saw "Online enrollment isn't open yet" with "Book a call" first, because the remembered plan was never
  cleared once a business existed (Dashboard.jsx); (2) the booking page said "No open times right now" when the
  calendar connection was broken, identical to a full calendar: it now says "Online booking isn't available right
  now" and the request is still saved (BookingPage.jsx; customer websites untouched, renderer unchanged).
- Read-only production checks: enrollment closed, dashboard/platform APIs 401 signed out, cross-origin writes 403,
  HSTS + frame-ancestors 'none' on /dashboard, early-access appointment page reachable, customer pages unchanged.
- Not done here (approvals): founder alerts on, pilot emails in MESSAGE_TEST_RECIPIENTS, legal/tax/Stripe live,
  Google verification. Follow-ups (P2): 401 mid-session returns to sign-in; acquisition funnel strip in /admin;
  inquiry record for early-access calls.

## Product-wide polish: one brand for the site and the signed-in app (2026-11-21) — feat/product-polish (frontend only)

- Shared design system, incrementally: src/app.css gained a "Platform design system" block scoped to the dashboard /
  setup / admin shell (.app) and the platform's own sign-in and gate screens (.center-page that is not the customer
  booking page). Inside that scope the warm neutral scale becomes the site's cool scale, surfaces are white with
  hairlines, cards/inputs/buttons use the site's 10–12 px radii, the primary action is black (orange stays for focus,
  the current step and dark surfaces), text actions are dark underlined links (no orange link text), small labels use
  Space Grotesk, grouped figures are one bordered strip (no tile rows), semantic status colours unchanged (ok / warn /
  bad / info / test-mode purple kept), Follow-ups' indigo bubbles and open row now use the brand dark. Customer-facing
  surfaces are untouched by design: the customer booking page (/book/:id) renders pixel-identically before/after
  (checked at 1440 and 390), the public chat page (.rcp) and customer websites (server-rendered) keep the global tokens.
  No component logic, API, permission, validation or persistence change.
- Homepage refinements on the v2 foundation: full-width two-line headline; one row beneath it (what it does on the
  left; one dominant black primary + a text-link "See it answer a customer" with the price line subordinate on the
  right); the stage directly under. Demo entry state lighter: the simulation label sits once in the stage bar, the
  trade row says only which example business is shown, a one-line "You're the customer…" hint sits beside the first
  Send, and the Booking stage of the trace now ends with "On your dashboard: Booked · …" (the business outcome).
- Three screenshot critique passes at 1440/1024/768/390/320 (homepage) and 1440/390 (sign-in, setup, overview,
  appointments, settings, website, receptionist, follow-ups, Teach Your AI, Ads, admin, Control Center, booking page)
  in the scratchpad (v2/app/before|pass1|pass2|pass3, v2/shots/pp1|pp3). Fixed along the way: ragged stats rows showing
  filler cells, admin text-valued stat inflating, setup body grey under a white header, sign-in primary keeping the
  orange glow, four-line headline at 1440.
- Measured (Playwright; Lighthouse/axe not installed): homepage unchanged in weight (7 requests, 0 external hosts,
  script 274 KB, fonts 69 KB), 0 console errors on every app screen, 0 sideways scroll, computed AA contrast on the
  homepage 0 failures on visible text.
- Tests: flagship.spec.js updated (one primary button in the hero, secondary is a text link; simulation label in the
  stage bar); every other spec unchanged.
- Not changed (needs a behavioural release, documented for follow-up): the dashboard's 880 px column and tab bar are
  styled, not re-architected (no sidebar); Control Center keeps its own link colour; the Website Studio editor keeps its
  indigo selection outline (a tool highlight over customer sites).

## Marketing website v2: Cinematic Intelligence (2026-11-20) — feat/site-v2 (frontend only; marketing site, no app/backend change)

- The editorial direction released earlier today (Fraunces serif, italic orange line, warm-white "notebook" strip)
  was judged generic/magazine-like by the founder. Reset: three rendered concepts (scratchpad, not deployed) scored on
  nine criteria — A Monochrome Precision 65/90, B Cinematic Intelligence 71/90 (selected), C The Job Card 62/90. B is the
  only one that puts the product itself in the first viewport on desktop and phone.
- Visual system: white editorial sections + charcoal product surfaces (#101114 / #17181c / #22242a); Inter for all
  display and body type (bold, upright, no italics), Space Grotesk for small labels and numerals; both already
  self-hosted (OFL) and preloaded; Fraunces no longer referenced. Orange is a signal only: the primary action on dark
  surfaces, the current trace step, the booked state, focus. Primary actions on white are black. The logo
  (src/components/Logo.jsx) is byte-identical to main and renders identically (SVG, "GetShowUps", 28×28, stroke
  rgb(255,106,26)); only its surroundings changed. App-page token VALUES are unchanged (marketing-only tokens added).
- First viewport: text-only hero (headline, one primary + one secondary CTA, price) and the product stage rising out of
  the white into the charcoal (section `data-dark-from` keeps the header light until it is over the dark surface).
- The stage = Mode A (AI conversation) / Mode B (booking page + dashboard, Demo.jsx unchanged in behaviour). Mode A
  redesigned for progressive disclosure: chat on the left (customer, a one-line check caption, the reply, the next
  customer line as a ghost bubble); on the right the trace of what the AI is doing — Inquiry → Understanding (facts
  accumulate per turn) → Qualification (the owner's rule) → Action (per-turn `action` in content/conversation.js) →
  Booking — one stage current at a time. Scripted, deterministic, offline, labelled a simulation; unchanged scripts.
- Journey: the six-step strip is now one rail (`.jr-*`, avoiding app.css's `.journey-step`, which the previous
  release's CSS leaked into); problem and industries are editorial split-heads with hairline rows; pricing is a split
  card (dark price panel + inclusions); early access list counter fixed (every step showed "1").
- Measured (Playwright; Lighthouse/axe not installed): 7 requests, 0 external hosts, script 274 KB (unchanged), fonts
  69 KB, CLS 0.034 desktop / 0.026 phone (header CTA relabel + enrollment note after /api/enrollment), 0 console errors,
  computed AA contrast 0 failures on visible text at 1440 and 390, heading order clean, min font 11.2 px, 0 sideways
  scroll at 320–1440. Three screenshot critique passes (pass1/pass2/pass3/final in the scratchpad) fixed: section order
  (stage was below the problem section), a four-line headline, a chat column overflowing under the trace, a collapsed
  phone compose box, inconsistent status chips on the rail, a todo-step contrast of 3.7, 10 px labels, h2→h4 jump.
- Tests: flagship.spec.js updated for the new structure (stage in the first viewport, five-stage trace progression,
  industry switching from the stage + industries section, dark header only past the white strip, typography system:
  Inter + Space Grotesk only, no italics, no external requests); home.spec.js / site.spec.js unchanged and passing.

## Flagship marketing website (2026-11-20) — feat/flagship-site (frontend only; marketing site, no app/backend change)

- Direction A "Editorial Intelligence" chosen from three rendered prototypes (scratchpad, not deployed): Fraunces +
  Inter (both already self-hosted, OFL), warm-white editorial sections, dark product demonstrations, orange restrained
  to the logo, the italic "Less chasing." and the primary action. The logo (src/components/Logo.jsx) is byte-identical
  to main and renders identically (SVG, wordmark, 28×28, stroke rgb(255,106,26)); only its surroundings changed.
- AI conversation simulation restored as the flagship demo (src/components/Conversation.jsx + content/conversation.js):
  scripted, deterministic, offline (no API, no storage, no model); pool / HVAC / roofing (roofing labelled upcoming);
  facts recognized → check or owner rule → reply, booked only after the customer's own yes; owner's view afterwards.
  The booking-page + dashboard walkthrough (Demo.jsx) stays as Mode B behind a tab. #demo and #simulation both land here.
- New story: problem → showcase → how it works (Attract → Answer → Qualify → Book → Notify → Measure, each "Live today")
  → Teach Your AI (labelled "In pilot with founding customers": released 2026-11-20 for the first pilot business, live
  rules per business still gated) → industries → pricing ($499/month, ad spend separate, no trial) → early access → FAQ.
- Header adapts (dark over dark sections); mobile action panel is inline (no sticky overlap); fonts preloaded (CLS → 0).
- Measured (Playwright; Lighthouse/axe not installed): 7 requests, 0 external hosts, script 274 KB (unchanged), fonts
  82 KB, 0 console errors, computed AA contrast 0 failures at 1440 and 390, 0 sideways scroll at 320–1440.
- Tests: test/e2e/flagship.spec.js (logo preservation, first viewport + CTAs, pool end-to-end, industry switching, all
  three scenarios, mode switch, keyboard, reduced motion, mobile menu, sections/CTA destinations/dark header, honest
  claims); home.spec.js and site.spec.js updated for the new layout (nothing weakened). Analytics allowlist gained the
  conversation/mode events (in-page only, still sent nowhere).

## Teach Your AI / Business Intelligence Studio (2026-11-20) — feat/teach-your-ai (migration 0033; nothing released)

- Phase 0 audit (docs/INTELLIGENCE_STUDIO.md §1): one shared Retell Custom-LLM agent, routed by our call id, prompt and
  tools entirely ours → owner rules need NO Retell change; measured voice latency p50 first chunk 4.7 s (model-bound).
- Built: provider-neutral intelligence engine (server/intelligence/: versioned config, understanding, decisions,
  compile, Teach a Change, simulation, recommendations, store, adapter boundary), owner API (/api/dashboard/ai-rules),
  dashboard tab (About / How it works / Teach a change / Test / Publish with history + rollback), receptionist
  integration (rules block, per-turn note, tool guards, note_answer) for chat AND voice through the same engine.
- Gates (all off): migration 0033 (approval), AI_STUDIO_BUSINESSES (owner editing), AI_RULES_LIVE_BUSINESSES (live
  use), AI_RULES_ENABLED=false (kill switch). Before 0033 the tab is hidden and the API answers 404.
- Tests: 19 unit/integration (incl. mocked Retell socket), 51-scenario evaluation (51/51), 4 Playwright flows
  (desktop + phone); existing receptionist/eval/deletion/review suites unchanged and passing.
- Released 2026-11-20 (founder approval, steps 1–3 of the sequence): backup prod-20261120T223537Z-pre-pr92.sql
  (verified: integrity ok, fk 0, 76 tables = production); migration 0033 applied (78 tables, 0 rows, fk 0, existing
  counts unchanged); PR #92 merged as 95e0a50 (deployment 47d786dc); AI_STUDIO_BUSINESSES=poolthru-llc set (this
  commit redeploys to apply it). AI_RULES_LIVE_BUSINESSES is NOT set: published rules reach no conversation.
  Rollback: deployment cbaf53de (6b34c5a); remove the secret to hide the Studio; tables stay.
- Next: founder reviews PoolThru's first published version → decide on AI_RULES_LIVE_BUSINESSES (approval).

## Homepage conversion experience (2026-11-20) — feat/homepage-2027, PR #90 (frontend only; no migration)

- Hero: "More booked jobs. Less chasing.", $499/month + ad spend separate visible, Request early access (enrollment
  closed → #book-demo, the existing Google Calendar appointment embed) + See it work (→ #demo), "Try the demo as a"
  pool / HVAC / electrical. Illustrative product preview on desktop (labelled Example).
- "See it work" (#demo, alias #simulation): interactive simulation, configured per trade in src/content/demo.js, mirrors
  the live product only (booking page → lead saved → ZIP check: in area → times / outside → owner approves or declines
  → booked on Google Calendar + Google invitation → owner records Job done / Visited, not done / Couldn't visit +
  optional own estimate). No API calls, nothing stored. The scripted SMS simulation was removed (texting isn't live).
- How it works: six steps kept, each labelled Live today / Partly live. Features grid removed (covered by steps + plan).
- Funnel events (src/lib/analytics.js) are in-page only: there is no browser analytics endpoint. Sending them needs
  approval (public rate-limited POST into the existing events table, allowlisted names, no personal data).
- Built 2026-11-20 but left as a draft, so production kept the old homepage. Founder then asked for it to be finished
  and released under the release gates: merged with main (b9db2ce), verify 682/682, Playwright 184 passed / 1 skipped,
  before/after screenshots at 1440 and 390 px reviewed. Rollback: Pages → previous deployment (no data involved).
- Next: funnel analytics endpoint (approval); real product screenshots once a non-customer demo business exists.

## Editing during deploys (2026-11-20) — fix/deploy-safety (no migration; nothing deployed)

- Audit question: do owners editing websites, bookings and settings stay safe while we deploy? Read-only production
  checks + local tests. Deploys never write data; migrations are additive; live sites render from the stored live
  version only (drafts never reach visitors); bookings keep the double-booking index; all 31 saved production backups
  restore with integrity ok and 0 foreign-key violations (71 FK constraints, checked with enforcement on).
- PoolThru's draft change at 2026-11-11 02:27:59 UTC (during the 44a59ca deploy) was the owner's own dashboard
  session (generate → save → revise → publish v2 at 02:34). Owner edits during deploys are normal; never restored.
- Fixed (verified gaps):
  - Publish had no stale check: a page showing an older draft published it over newer work. Publish now sends
    baseUpdatedAt → 409 conflict (nothing published; latest state returned). Pages without it still publish.
  - publish() set updated_at back to the publish clock (could repeat an earlier stamp); it now keeps the save's stamp.
  - The classic editor (WebsiteEditor: non-Studio drafts, onboarding) saved without baseUpdatedAt (last write won);
    it now sends it and stops with an explanation on 409.
  - Restoring a published version replaced the draft with no copy; the draft is now checkpointed first
    (`before_version_restore`, History: "Before going back to a published version"), and the confirmation says the draft changes.
  - A page loaded before a deploy went blank opening a not-yet-loaded tab (old chunk → HTML). src/lib/lazy.js
    lazyPage reloads once (30 s loop guard).
  - Invented-number check matched digit substrings ("15 years" passed via ZIP 33156, "12 technicians" via the phone):
    server/fact-numbers.js compares whole numbers (phones in any format). Generation-time only; live sites unchanged.
  - Business settings (profile, policies, booking hours) were last-write-wins: the Settings forms now send `base` (the
    values they loaded) → 409 conflict, nothing replaced (server/stale.js; value based, no migration; base-less
    requests from older pages and onboarding still save).
  - The classic editor dropped a change typed < 700 ms before leaving (tab switch, reload after a deploy): it now sends
    it on unmount/pagehide (keepalive).
- Documented: rollback limit for website content using section types/options newer than the rollback target
  (docs/OPERATIONS.md §4).
- Not changed (reported): AI copy filters still allow superlatives ("the best … in Miami"), unverifiable product claims
  and promises of reminders/texts; inner AI-site pages without a hero have no h1.

## Control Center experience (2026-11-20) — feat/control-center-experience (stacked on #88; no migration; nothing deployed)

- Audit (real browser, isolated e2e environment) found: every admin `btn-ghost` button invisible (white on white:
  QA Fail/Blocked/Not tested, Start, Diagnose calendar, Save), "hosting [object Object]" in the Account Inspector,
  calendar shown "Ready" while failing, a medium platform incident shown next to "Nothing needs action", platform
  incidents told to "open the event … for this business", incident rows / metrics / integrations not clickable, raw
  JSON evidence, no account search, QA as one long form with no way to resume a session, no usability feedback.
- Rebuilt the front end on the same APIs (docs/CONTROL_CENTER.md "The founder experience"). Server: read-only
  additions only (states.js vocabulary, explain.js titles/next steps, incident detail, overview attention/approvals,
  readiness), QA usability inside `answers` (no migration), journey purpose text. Engine untouched.
- Original HTML prototype: not found (repo, local folders, artifacts, transcripts); comparison not possible.
- Next: founder review of the draft PR; merge order #87 → #88 → this.

## Operational activation prep (2026-11-20) — feat/ops-activation (no migration; nothing activated)

- Founder alerts panel in the Control Center Overview (GET/POST /api/platform/alerts): switch, deliverable admin count
  (counts only), last alert; "Send test alert" (only while FOUNDER_ALERTS_ENABLED is on; confirm; ≤1/10 min, 3/h per
  admin; audited) sends one TEST email at once through the real outbox + gate + Resend. No incident, no business.
- Twilio webhook: an unsigned request (never Twilio; probe or our smoke test) is recorded as `info` with
  reason `unsigned` and opens no incident; signed-but-invalid stays a failure (`bad_signature` / `unknown_account`).
  inc_SCQKj1CNys20 was exactly that (our PR #55 smoke test, 2026-11-17 01:42:30 UTC); it resolves itself ~2026-12-01.
- CI ingestion prepared: playwright.config.js writes qa-report.json in CI; docs/ci-with-qa-report.yml = proposed
  workflow (secret-free verify unchanged; qa-report job on main pushes only, environment qa-ingest, pinned actions,
  no npm install); scripts/qa-ingest-token.sh (dry-run default, never prints the token).
- Runbook + numbered approval checklist: docs/OPERATIONAL_ACTIVATION.md (alerts test, Twilio findings, activation-run
  approvals A1–A5). Next: owner works through the checklist.

## Release 2026-11-19/20: QA Control Center (#83 → #85 → #86, migrations 0031 + 0032) — owner-approved

- Pre-checks passed: PR heads + CI green; 0031/0032 additive (CREATE … IF NOT EXISTS only); the expected incident
  traced to a real record; FOUNDER_ALERTS_ENABLED and QA_INGEST_TOKEN absent; rollback target c378384e (main 0be8bf2).
- Fix found by the pre-checks and made before merging (check 5): the incident sync ran before the outbox flush and
  the ads safety stop. It now runs last (QA retention too), ≤150 open / ≤50 new incidents per run (+ test). New heads
  #85 936426c, #86 0053501; merged trees identical to the CI-tested heads.
- Backup ~/getshowups-backups/prod-20261119T233412Z-pre-pr83.sql (sha256 d9c5d721…): restored, integrity ok, 72
  tables / 676 rows = production. Migrations 0031 → 0032 applied: 4 tables + 7 indexes, empty.
- Deploys: #83 → 8dcd23b / 3c6bd755; #85 → 20ac738 / bf349d53; #86 → 005d162 / **b3522b5f** (live).
- Verified after each deploy (read-only): PoolThru ×5, bob-electrical, toys-for-us HTML byte-identical to the
  pre-release capture; enrollment {"open":false}; voice available for poolthru-llc + bob-electrical only;
  /api/platform/{control,incidents,inspector,qa} 401 signed out; /api/qa/runs 503 not_configured; cron 200, no
  errors in a full tail; no alert outbox rows; no new outbox mail.
- Incident register: one open incident, inc_SCQKj1CNys20 (followups.sms_inbound, sms.webhook_rejected,
  bad_signature, medium). **Cause confirmed: our own deliberate unsigned POST** in the PR #55 post-release smoke test
  (2026-11-17 01:42:30 UTC, check "twilio inbound unsigned (403)", 43 s after the first build with Twilio
  credentials). The webhook rejected it correctly. Not from Twilio; no business has a Twilio subaccount or sender;
  no inbound text ever existed; no customer impact. Incidents have no manual close (by design): it resolves itself as
  "no new failures" after the 14-day window (~2026-12-01). Follow-up: unsigned requests should not count as failures.
- Not activated (separate approvals): founder alert delivery, QA ingestion token + CI job, real-person activation run.

## Control Center B2: QA history + guided human QA (2026-11-19) — feat/control-center-qa (stacked on B1, migration 0032)

- Automated run ingest (POST /api/qa/runs, QA_INGEST_TOKEN, off when unset; scripts/qa-report.mjs from Playwright
  JSON), run detail (failed first, redacted errors, related incidents by feature, retest history), guided human QA on
  the same journeys (observed result, status, context questions, defects vs improvements), activation timer
  (server-clock splits). Activation is "measured" ONLY from a finished observer run — none exists yet.
- Demo now covers all 11 directive steps (control-center.spec.js). CI hookup needs a workflow change (owner; token
  has no Workflows permission) + QA_INGEST_TOKEN secret (approval).

## Control Center B1: incidents + Account/Journey Inspector (2026-11-19) — feat/control-center-incidents (stacked on #83, migration 0031)

- Incident register from existing records (alert detectors + open failure events), deduplicated, evidence-based
  recovery, fixed causes; Account Inspector (readiness, voice gate, comms, billing, journey steps, incidents,
  history, customer view, read-only calendar diagnosis); overview at /admin/control. Details: docs/CONTROL_CENTER.md.
- Demo e2e (control-center.spec.js): injected invalid grant → incident → dedupe → diagnosis → fix → recovered.
- Next: B2 (QA run history + guided human QA + activation timer, migration 0032). Apply 0031 before merging (approval).

## Founder alerts (2026-11-19) — feat/founder-alerts (stacked on #81, no migration, OFF by default)

- server/alerts.js `founderAlerts` (cron step before the outbox flush), scope as approved-for-review in
  docs/FOUNDER_ALERTS_PROPOSAL.md: calendar broken (connection error on a lookup: invalid grant at once, others open
  ≥ 10 min; or hours confirmed with no calendar, checked hourly, once/day), booking page without times (≥ 3 failed
  lookups in 30 min, no success since), messages failing (1 failed confirmation or ≥ 3 failures/hour per business).
- Recipients: PLATFORM_ADMIN_EMAILS that recipientAllowed() delivers to now (MESSAGE_TEST_RECIPIENTS while
  MESSAGES_LIVE is off); nothing held to burst later. One email per incident (outbox id), ≤ 1 per business + kind per 6 h, ≤ 10/run + digest. "No free time" never alerts. Test and
  deleted businesses never alert; unreadable test list = nothing alerts. Codes/counts only. Capability platform.alerts.
- Not built (proposal optional): "resolved" emails. Next: owner approves scope → merge after #81 → set
  FOUNDER_ALERTS_ENABLED=true and add the founder address to MESSAGE_TEST_RECIPIENTS (approval).

## Release 2026-11-19 evening: #80, #81, #82 (owner-approved plan, docs/RELEASE_PLAN.md)

- Backup ~/getshowups-backups/prod-20261119T203844Z-pre-pr80.sql (integrity ok; 12 table counts = production; no
  pending outbox). Rollback target: deployment b6ba40a5 (main 425d311). Migration 0030 applied (table + index).
- #80 → merge 37951e8, deployment 4650e0aa. RECEPTIONIST_VOICE_BUSINESSES=poolthru-llc,bob-electrical set BEFORE #81
  (authoritative: production served voice to exactly these two; all others unchanged). #81 → merge 54536db,
  deployment 8e903802: voice still on for both, off for the rest. Live HTML of PoolThru ×5, bob-electrical,
  toys-for-us (+ www.poolthru.com control) identical to the pre-release capture after each deploy.
- #82: deployment id recorded in the release report. #83 (founder alerts) NOT merged, NOT activated.

## Launch readiness + enrollment notice (2026-11-19) — docs/launch-readiness (#82, no migration)

- Visitors are told enrollment isn't open BEFORE Google sign-in: GET /api/enrollment ({open}, mirrors the server's
  signup gate; rate-limited), "Request early access" CTAs + note, /dashboard?plan=founding notice with Book a call.
  Sign-in unchanged for existing owners, invitations, admins, testers. Help link on owner screens; /#book → /#book-demo.
- Docs: LAUNCH_READINESS (journey QA, readiness matrix, 20-minute target vs measured), ACCOUNTANT_PACKAGE,
  legal/ATTORNEY_REVIEW, FOUNDER_ALERTS_PROPOSAL (built in feat/founder-alerts, off), RELEASE_PLAN (#80 → #81 → #82,
  backup/migration/smoke/rollback; not executed), ACTIVATION_TEST (real-person run script; not run).
- Next: owner approves RELEASE_PLAN; voice allowlist `poolthru-llc,bob-electrical` before #81 deploys.
## Comms reliability (Agent B, 2026-11-19)

- Branch feat/comms-reliability (draft PR), no migration. Detail: docs/COMMS_RELIABILITY.md.
- Voice: 8 defects in our Retell socket/engine fixed (barge-in now aborts the stale Claude answer; a failed turn no
  longer silences the call; Retell reconnects are accepted without a second greeting; talked-over words kept; holding
  line at tool start; 10 s voice model timeout). Mocked harness + per-turn `voice_turn` timings (numbers only).
- Voice release gate `RECEPTIONIST_VOICE_BUSINESSES` (no wildcard, empty = nobody), server-enforced; Beta label.
  **At deploy, unlisted businesses lose the voice button (chat unchanged): owner decides which ids to list.**
- Email: outbox backoff, stale/past-idempotency mail closed (`expired`), 400/422 permanent; confirmation + owner
  new-booking notice sent right after booking (waitUntil). Booking: orphan Google events tracked + cron retry;
  booking/availability failures are open `calendar.google` incidents until the next success.
- Not live-verified: any real call. Next: approved live test call with and without `scripts/retell-setup.mjs --tuned`.
## Studio UX hardening (Agent A, 2026-11-19)

- Branch feat/studio-ux-hardening, draft PR; details, defects and renderer notes in docs/STUDIO_UX_HARDENING.md.
- Photos: "Used on" per photo (draft page · section, live site, saved versions, History, logos); Replace everywhere
  in the draft (undoable; live changes only on publish); Delete only when nothing recoverable uses it (phone copy goes
  with it); Hide for history-only photos (bytes kept for restores). Fix: `content.design` photos were not counted as
  used (deletable while live, and refused by /site-assets publicly).
- Migration **0030** `website_asset_hidden` (additive, idempotent, in ERASED_TABLES) — NOT applied to production;
  until applied, Hide answers not_available and everything else works.
- Editor: full screen / photo-button panel / section menu are browser-history layers (Back closes the top one, Forward
  never re-opens it); Escape from inside the preview; full screen fixed on phones; page, section, panel tab, mode,
  preview size and scroll remembered per business (sessionStorage); unsaved edits auto-restored when the server copy
  is unchanged, otherwise asked + 409 conflict; preview keeps its scroll after edits.
- Phone-sized photos for older-format (`content.design`) sites: opt-in `responsiveImages: true` stored with new
  uploads; render goldens unchanged (no fixture or golden edited).
- Next: review + merge the draft PR (approval); apply 0030 to production (approval) before Hide is offered for real.

## Sales-tax analysis for the $499 plan (2026-11-19) — docs/sales-tax-analysis (docs only)

- docs/SALES_TAX_ANALYSIS.md: what the $499 buys today (SaaS, generated website, hosting, support; ad management,
  messaging and voice NOT included; ad spend paid directly to Google/Meta), general state treatment per component,
  the bundle consequences (recommendation: one SaaS business-use product, tax-exclusive), state-specific nexus thresholds (17–84 customers per
  state), California SB 122 from CDTFA L-1036, WA/MD 2025 changes, the information package and 13 questions; each statement labelled verified / preliminary / open.
- No tax configuration changed; the live price stays blocked (docs/LAUNCH_CHECKLIST.md §B).
- **Next:** the owner supplies the §7 facts (formation state, operating location, where people work) and sends §7–§8 to the accountant.

## Release 2026-11-19: Phase 1 starter live (#76), docs #77/#78

- #76 merged 126dcba, deployment c5258264 (rollback target 95f0a6ba / a9a334e). Added before merge (owner decisions):
  "Online booking hours" label; HVAC starters text-led. Backup ~/getshowups-backups/prod-20261119T143234Z-pre-pr76.sql
  (integrity ok, counts match). After deploy: PoolThru, bob-electrical and toys-for-us HTML byte-identical to the
  pre-release captures; subscriptions, customers, websites, counts unchanged; booking, sign-in, admin, webhook smoke ok.

## Website Studio Phase 1: conversion-first starter (2026-11-18) — feat/studio-starter-phase1 (no migration)

- **Approved scope (owner, 2026-11-18):** Book online + Call, service cards, 3-step booking explanation (production
  behaviour only, no messaging promises, no "coming soon"), booking hours, service area, owner-sourced FAQ, final CTA;
  records only; missing → omitted and the owner is asked; existing renders unchanged.
- **Built:** server/site-starter.js (new home, bookingSteps, faqFromPolicies, `missing`); website-import.js
  starterFacts() (the one facts builder: phone, towns, confirmed hours, policies); site-spec.js (`call` target on regular
  buttons, area `showHours`); site-render-v2.js (Call shows + dials the CURRENT phone on record, dropped without one;
  hours line; CSS only where used); Studio editor (Call target, "Show your booking hours"); Website tab notice listing
  what's missing.
- **2026-11-19 (owner):** hours labelled "Online booking hours" (heading "Online booking hours" / "Service area and
  online booking hours"); HVAC starters text-led (textLedStarter: hvac / heating / air conditioning / furnace / heat
  pump in industry, services, description or name; owner photo still wins).
- **Compatibility:** all 10 existing render goldens byte-identical (no golden regenerated); new fixtures
  v2-starter-full / v2-starter-minimal; layout spec checks Book + Call together on the first screen (desktop + phone).
  Applies only to NEW starter sites ("I'm starting fresh" / import without a site). Nothing published automatically.
- **Next:** Phase 2 (onboarding produces this format) and Phase 3 (imagery) need separate approval.

## Reconciliation applies missed cancellations (2026-11-18) — fix/reconcile-ended-subscriptions (no migration)

- **Finding:** delayed webhooks (Stripe retries ~3 days; older events ignored) and duplicates (idempotent per event)
  were already handled. A webhook missed for good was only REPORTED (daily `status_mismatch`); the business stayed
  "active" and hosted until an admin clicked Resync.
- **Fix:** the daily reconciliation applies exactly one case automatically: Stripe says ended, we say paid → the
  existing `resyncFromStripe` (Stripe asked again; audited; ads hold check). Never-paid placeholders and every other
  difference stay report-only. Reflected within ≤ 1 day of the cancellation.
- **Safety review before merge:** (1) stamped with Stripe's `ended_at`, not the run time: a resubscription whose webhook
  was delayed past the run is no longer ignored as "older"; (2) skipped, report-only, when Stripe lists another
  running/pending subscription for the business; (3) transient Stripe errors (listing or confirming fetch) change
  nothing; (4) a scheduled cancellation stays active and hosted until Stripe ends it, then 14-day grace. Tested.

## Billing fails closed when Stripe is half-configured (2026-11-18) — fix/billing-fail-closed (no migration)

- Found in the live-billing readiness review: with a key set but billing unusable (live key without
  STRIPE_LIVE_ENABLED, or no webhook secret) `signupPlan` returned null, so new self-serve businesses were created
  UNBILLED (never asked to pay). Now refused (403 signup_not_open, page shows "opens soon"); existing businesses keep
  working. No production behaviour change today (test key + webhook secret = configured).

## Published-site protection: render goldens + layout checks (2026-11-18) — test/render-goldens (tests only)

- **Why:** public sites render per request from stored content (site-serve → renderSite), so every renderer PR changes
  every live customer site at once with no review signal (PR #62 changed PoolThru's live CSS this way).
- **Added:** 9 frozen content fixtures (legacy, content.design, v2 starter sites for wellness / pool / cleaning / lawn /
  trades / professional, both appointment modes, a 5-page site) → 13 exact-HTML goldens; plus a desktop + phone
  Playwright layout check of every golden page (26 runs). No production code changed.
- **Proposed next (not built): renderer versioning.** Smallest compatible step: record `rendererVersion` on each
  published version; site-serve keeps rendering stored versions with the renderer revision they were published with
  only where a golden had to change (frozen CSS blocks keyed by version), and the owner's next publish adopts the
  current renderer. Build it the first time a golden must change for an existing content system.

## Voice: holding line before slow tools (2026-11-18) — fix/voice-holding-line (no migration)

- **Cause of lost voice turns (from code + the 2026-11-18 production call):** a calendar question is model call →
  Google freeBusy → second model call before any speech. Several seconds of silence; the caller speaks again, Retell
  issues a newer response id and the turn is discarded (bob-electrical call: 2 turns lost to talk-over; which step
  was slow isn't recorded, so the silence before tools is the likeliest cause, not a proven one).
- **Fix:** voice speaks a fixed holding line before `find_available_times` / `book_appointment` when nothing was said
  yet this turn; logged in the transcript; not counted as an answer. Chat unchanged.
- **Not verified live:** needs one real browser call (Retell + Anthropic) to confirm. Faster voice model
  (`RECEPTIONIST_VOICE_MODEL`) remains an approval item.

## Account outbox: refused mail is closed, not held (2026-11-18) — fix/outbox-held-mail (no migration)

- **Problem:** `flushOutbox` left mail the launch gate refused (test mode, or a test business writing to a real
  address) `pending` forever. Turning MESSAGES_LIVE on would send it days or weeks late in one burst (production
  backup: one setup reminder pending since 2026-11-12), and once 20+ such rows existed they filled every batch
  (`ORDER BY created_at LIMIT 20`) so no other account email (invites, recovery, owner notices) would ever send.
- **Fix:** refused mail becomes `failed` / `test_mode` with 0 attempts (shown truthfully in /admin), never sent later.
- **After deploy:** the one old pending setup reminder in production is closed as test_mode by the next cron run (not sent).
- Tests: held → closed; going live later sends nothing; 25 refused rows don't starve a deliverable one (fails on old code).

## Go-live billing: sandbox subscriptions stop counting as paid (2026-11-18) — fix/golive-sandbox-subscriptions (no migration)

- **Problem (found in review, not yet reachable in production):** once STRIPE_LIVE_ENABLED=true, a test-card
  subscription (bob-electrical, toys-for-us, test businesses) would still count as paid for onboarding, Ads live
  launch and the billing card, and live checkout would refuse (`use_portal`) or send a test-mode Stripe customer id to
  live Stripe (fails). So a sandbox business could never become a real paying one.
- **Fix:** `billingSubscription(env, id)` (server/stripe.js) is the access view: under live billing a subscription not
  recorded live is `sandbox` (admin-marked test businesses excepted). Used by onboarding steps/readiness, the billing
  route, portal, checkout and `billingAllowsAds`. Checkout replaces a sandbox record with a new live customer (audited)
  and verifies an unrecorded stored customer with live Stripe first. Hosting is unchanged (onboarded businesses stay up).
- **Live billing off (today):** no behaviour change. Tests: 3 new unit tests (578 pass).
- **Next:** approval to merge; at go-live, owners of sandbox businesses see "Choose a plan" (no charge until they do).

## Launch readiness: sandbox billing gate + voice diagnostics (2026-11-18) — fix/sandbox-billing-access (no migration)

- **Released before this:** PR #62 merged (f9aca6d) and deployed (5a57c9ff). PoolThru's DRAFT had the old-logo block
  removed (guarded UPDATE, backup prod-20261118T023415Z-pre-pr62.sql); live v9 untouched. Live PoolThru pages changed
  in CSS only (headline ceilings), verified by diff; toys-for-us byte-identical.
- **P1 found (production, read-only):** with test keys and live billing off, ANY self-serve signup could unlock the
  full product with Stripe's public test card. `bob-electrical` (2026-11-18 02:36 UTC) did: Stripe sandbox, $499 test
  invoice paid, one subscription, DB matches Stripe, onboarding done at 6:25, booking at 7:59. Not marked test.
- **Fix:** createCheckout → sandboxCheckoutAllowed (admin / MESSAGE_TEST_RECIPIENTS email / admin-marked test business);
  others get 403 billing_not_live and an honest notice. Existing subscriptions untouched.
- **Voice receptionist:** bob-electrical's call answered 1 of ~5 turns. Turns the caller talked over were logged as
  `model:no_reply` and generated a fallback; now `turn:talked_over` (no fallback). Root cause of the slowness is NOT
  confirmed (likely answer latency: Opus 5.5 + tool round trips); RECEPTIONIST_VOICE_MODEL exists for a faster model
  (approval + a live test call).
- **Not done:** a fresh human-timed production journey (no browser control this session); Ads is allowlist-only
  (ADS_BUSINESSES), so new businesses can't prepare campaigns; onboarding "Create a new website" still uses the older
  design system, not Website Studio; public sites are not edge-cached (TTFB 0.6–1.9 s).
- **Next:** owner decisions (bob-electrical access; voice model; Ads allowlist), then a human-timed run.

## Product completion pass (2026-11-18) — feat/product-completion (no migration)

- **PoolThru graphic, root cause** (traced in production data, read-only):
  - The purple/orange/green PNG (asset 6a63…, uploaded 2026-11-11) was PoolThru's LOGO (content.logo in v2–v4).
  - By v5 it was no longer the logo but stayed in the image library.
  - The AI designer (2026-11-16 16:34 UTC) offered "all assets except the CURRENT logo" as owner photos and placed it on the first screen. Every later save, import and redesign carried it.
  - The editor's "No photo" was ignored for those pictures (PhotoPop: `v && change`), so the owner could swap but never remove it.
- **Fixes:**
  - Every past logo is excluded from photo choices everywhere.
  - "No photo" removes the picture (composition: its photo block).
  - The photo picker shows the picture in use.
  - Headline ceilings 96/80/60px: was 158px at 1440px, 211px at 1920px.
  - Spacing under the first-screen heading; a content-height first screen without a photo.
  - The header Book button never wraps.
- **Industries:** professional + wellness added (text-led); the spa→pool misclassification is fixed; per-industry starter looks.
- **Editor:** full screen (/dashboard/website?full=1, Esc), tablet view. Root cause of the "editor stuck in a box": `.enter{animation: … both}` kept an identity transform that confines fixed-position children → `backwards`.
- **Security headers:** /dashboard and /admin could be framed by any site (clickjacking) → X-Frame-Options DENY + frame-ancestors 'none'. HSTS added.
- **NOT changed:** PoolThru's draft or live site (needs approval); no AI calls; no migrations.
- **Open:**
  - Section-scoped AI editing (P2).
  - Full CSP for app pages (P2).
  - WAF/DDoS settings not inspectable with the current token.
  - Licensed photos for professional/wellness.
  - A timed human onboarding run.
  - The receptionist and Ads are not part of onboarding (dashboard tabs after it).

## Service-area requests (2026-11-17) — feat/service-area-requests; migration 0029 (NOT applied)

- **Root cause of lost leads:**
  - **Booking page:** an out-of-area visitor got a dead end ("We don’t serve your area online yet").
  - **AI receptionist:** an out-of-area conversation never created a lead at all.
  - **Owner:** got no notice; leads with status 'unqualified' were excluded from owner notices and follow-ups.
  - **Booking:** the lead could never book, even if the owner would serve it.
  - **ZIP check:** a typo or ZIP+4 counted as "outside".
- **Fix:**
  - **Lead vs booking eligibility separated:** the ZIP rule is server/zipcode.js (U.S. Census ZCTA list); coverage requests live in server/coverage.js (table coverage_requests).
  - **Visitor journey:** "We may be able to help in your area…"; the ZIP check never clears the form.
  - **Receptionist:** new request_coverage tool.
  - **Website forms:** never lose the lead.
  - **Owner:** notice (owner_coverage), then "We serve this area" / "We can’t serve this area" in Appointments. Approval lets the same lead book from its own link (coverage_ok message + copyable link). The ZIP list never changes.
  - **Results:** outsideArea stage, plus an outside_area diagnostic.
- **Not done (needs a decision):**
  - City/radius/travel-time areas: the ZIP centroid data exists in the Census file, but distance is not service area.
  - One-click "add this ZIP to my list".
- Needs approval: migration 0029, merge/deploy. PoolThru's ZIP list was not touched.

## Acquisition engine, phase 3 (2026-11-17) — feat/acquisition-engine; migration 0028 (NOT applied)

- Audit (already built before this phase, unchanged):
  - Google Ads OAuth (separate adwords scope) and account selection with billing status.
  - Validated Search specs; campaigns created PAUSED and read back.
  - Owner budget approvals + ceilings; holds; deterministic optimizer (pause/recommend only).
  - Data Manager conversion feedback (off); booking-page UTM/gclid attribution.
- Gaps closed:
  - **One results definition** (server/ads/funnel.js), replacing two diverging summaries (one counted test leads). Cohort = leads created in the period. Stages: spend → leads → qualified → booked → attended → completed → estimated / invoiced / paid money. Cost per step only with measured spend; ROAS from paid revenue only; staleness, attribution coverage, 7/30/90 days.
  - **Money kept apart:** estimated (existing) vs invoiced vs paid (revenue_entries, append-only, migration 0028); POST /api/dashboard/revenue; Appointments shows Estimated / Invoiced / Paid per visit.
  - **Diagnostics** (deterministic, minimum samples, ordered along the funnel): tracking, stale spend, lead→booking, visits not marked, attendance, payments missing. Never recommends more spend; never acts.
  - **Attribution through the website:** ads land on the published website; its forms (hidden utm/gclid) and the receptionist chat (campaign params only) now credit the campaign. Previously those leads were unattributed.
  - **Ads tab:** Results panel (GET /api/dashboard/results); "Who pays what" at budget approval (Google bills ad spend; plan excludes it; owner-approved wording 2026-11-17: no additional percentage of ad spend, checked against the only plan = flat $499/month licensed Stripe price, no meter).
- Tests: unit (test/acquisition.test.js: funnel, honesty/nulls, diagnostics, routes, website + receptionist attribution); browser (ads.spec results + who pays; modes.spec estimated/invoiced/paid; tour screens incl. Ads).
- Blocked externally (unchanged, approvals):
  - Google Ads developer token at Test level (real accounts need Explorer/Basic access).
  - ADS_LIVE_LAUNCH, ADS_CONVERSIONS_ENABLED (Data Manager scope), ADS_AUTOMATION_ENABLED.
- Needs approval: migration 0028, merge/deploy.
- Release audit (2026-11-17):
  - **Fixed: the funnel counted appointments, not leads.** 'pending' reservations were counted as bookings, and a lead that cancelled and rebooked was counted both booked and cancelled. Stages now count each lead once at its furthest real step; money stays per visit.
  - Revenue index changed to (customer, appointment_id, kind, id) (covering).
  - Results header follows the data shown.
  - Added a regression test and spend-guardrail tests.
  - Migration 0028, tested on production's exported schema (structure only) with 50k synthetic leads: adds 1 table + 2 indexes, changes nothing existing, is idempotent, and existing rows are byte-identical. Constraints refuse bad kinds, negative amounts and orphan rows.
  - Old code (main) never touches revenue_entries, so it runs on the migrated schema. Recovery rehearsed: full dump → restore identical; dropping 0028's objects restores the exact schema. D1 Time Travel is available.
  - Correction: Google retired developer tokens (2026-09-09). Live use is blocked by the Cloud project's Google Ads API access level (Test), not by a token.

## Website Studio: one content system, legal pages, starter sites, own hosting (2026-11-17) — feat/website-studio-complete; no migration

- Audit (before):
  - Imported content landed in fields the AI-designed site didn't necessarily render. A design without a services section showed no services (PoolThru's Services page).
  - A business without an own AI key could only get the one-page template site: no About/Contact/Privacy pages, no kept addresses.
  - Legal text would have lost sentences to the marketing-claims filter.
  - The privacy link went to GetShowUps' policy.
  - No "use my own hosting" path.
- Built:
  - **site-starter.js:** a deterministic multi-page site from records + approved content. Industry look from site-design presets; neutral industries lead with Graphite.
  - **Page builders:** Services / About / Contact / Privacy. `ensureServices` and `withPages` never replace and never duplicate.
  - **Import:** offers pages with their source (imported / records / starter); privacy is copied word for word with headings, refused if incomplete. Old addresses are planned against the site the owner will have and re-planned against the saved one. Services/about found on "Menu", "Treatments", "Pricing", "About us" pages too.
  - **Legal pages:** validateSpec `legal` (exempt from the claims filter, text only, provenance); renderer shows them as one readable document, out of the main nav and linked in the footer. Publish requires `legalReviewed`.
  - **Renderer:** service descriptions shown in every layout.
  - **"I'm starting fresh":** POST website action `starter`.
  - **Start chooser** (WebsiteStart), **hosting choice** (WebsiteHosting) and **static .zip export** (site-export.js, zip.js, rate-limited).
- Fixed along the way:
  - The import confirmation vanished as the site became designed.
  - The journey's step 1 stayed stale after an import.
  - The start choice was below the fold.
  - The salon's /menu services weren't found.
- Tests: unit 551 (incl. website-flow.test.js: pool / HVAC / salon end to end, repeated + selective import, fresh start, legal text, isolation); browser 110 (website-flow.spec.js: HVAC journey on desktop and phone, import.spec repeat path).
- Not done:
  - Terms pages (only privacy is detected/offered).
  - Editing navigation labels/visibility of pages in the editor (pages can be added; legal pages stay footer-only).
  - Own-hosting export of contact forms (by design).
  - Logo/brand colours are not imported.
- Needs approval: merge/deploy. PoolThru content is not touched (the owner imports and publishes in the app).

## Website migration journey, phase 2 (2026-11-17) — feat/website-journey; no migration; nothing published, no DNS change

- PoolThru's production state (read-only check, 2026-11-17):
  - AI-designed site live at /p/poolthru-llc (version 8). No import ever run.
  - www.poolthru.com is verified and attached to hosting, but waiting for the www CNAME, which still points at Squarespace.
- A read-only importer run against www.poolthru.com from a dev machine (nothing stored):
  - Squarespace detected; 8 pages, 12 photos.
  - Suggested 8 old-address redirects (/services, /about, /contact, /careers, /privacy-policy, /request-service, /new-page, /home).
  - Flags: /request-service is empty; /careers has a template title.
- Website tab: "Your website, step by step" (WebsiteJourney.jsx + pure journey.js). Five steps, each computed from real state, with one primary action that jumps to the section that does it:
  1. Bring your content
  2. Review, edit and preview
  3. Publish
  4. Connect your domain
  5. Check it's live
- "Recommended before switching" when a domain is being connected but no old addresses were imported.
- Journey Publish follows the same guard as the status card (no unkept AI revision, nothing unsaved, publishing not paused).
- Import into a business that already has a website pre-ticks only "Old page addresses" (no text, no photos), so moving a domain never replaces the current copy unless the owner ticks it.
- Domain step 2:
  - Says where www points today (live DNS read, never stored; known platforms named, e.g. Squarespace) and to CHANGE that existing CNAME, not add a second one.
  - Before-switch checklist: site published; old addresses kept.
  - After-switch advice: keep the domain registration, cancel only the old website plan after checking.
  - "Waiting for your DNS change" replaces "Securing…" before the record exists (honest status).
- Also: the stray unlabelled "Details" toggle is gone; publish and domain statuses use the shared pills; "Not published" is neutral, not red.
- Tests:
  - test/journey.test.js (5 states, incl. PoolThru's exact state).
  - website.test.js: current pointer (Squarespace / unknown / none once connected, platform matching not fooled by look-alike hosts).
  - website-journey.spec.js: PoolThru-like seeded business, desktop and phone; Squarespace instruction; import defaults; nothing changed.
- Old addresses (planAddresses in server/site-import.js):
  - Each old page is classified by its own address, then its real title (template titles like "Contact 3" ignored) and headings.
  - Destinations in order: kept (the new site has the same address) → the matching page (/privacy-policy → /privacy) → booking (request/schedule pages) → home only when nothing is related, saying which page to add to keep the address.
  - Redirects may target the site's own pages; a page removed later falls back to home and never blocks saving.
  - The middleware sends common old addresses (/about-us, /contact-us, /privacy-policy, /faqs, …) to a matching page added after the import.
  - The import review lists every old address, what it was, and where it goes.
- PoolThru address plan (read-only crawl, 2026-11-17):
  - /services kept. /contact → booking until a Contact page exists. /request-service (empty) → booking.
  - /about and /privacy-policy → home until an About / Privacy page exists.
  - /careers and /new-page ("Our App") → home (nothing similar). /home → home.
- PoolThru content audit (live = draft, version 8): no placeholder text; booking (4 links), chat link and privacy link work. Missing or uncertain:
  - no services/prices (profile and site);
  - no phone/email/address anywhere;
  - no About, Contact or own Privacy page (the footer links to the GetShowUps policy);
  - no logo;
  - name "Poolthru" vs "PoolThru Pool Care";
  - service area Charleston and ZIP 29403 only vs "Charleston & Surrounding Areas";
  - generic copy (an odd "Do I need to bring my pool anywhere?" FAQ).
  - Owner reviews and fixes these in the app; nothing was changed for them.
- Needs approval: merge/deploy. Then PoolThru, in the app:
  1. Import www.poolthru.com, keeping old addresses (+ any photos).
  2. Publish.
  3. Change the www CNAME at Squarespace (owner's DNS change).
  4. Forward the bare domain.
  5. Verify; then cancel only the Squarespace website plan.

## Product experience, phase 1: receptionist dashboard, customer chat, Overview, design tokens (2026-11-17) — feat/ux-phase-1; no migration

- Design system:
  - Semantic tokens in `src/index.css` cover status tones, surfaces, focus, spacing and type.
    The tones are ok / warn / bad / info / neutral, each with text, background and dot.
  - `src/dashboard/ui.jsx` holds Pill, PageHeader, Section and Ago.
  - Classes are namespaced `ui-` because `.section` (marketing) and `.page-head` (admin) already existed.
  - Shared `phoneText()` and `timeAgo()` live in `lib/api.js`.
  - Inside the app the primary button is calm (no glow or jump), with a consistent focus ring.
- Receptionist (owner):
  - Overall status; channel tiles (Website chat / Browser voice / Phone calls: Not connected / Team notifications: Test mode).
  - Needs attention inbox: who, what, phone, when received, notification state; Call / View conversation / Mark done; a "Done" history.
  - Booked-by-receptionist list.
  - Conversations with filters and a side-by-side detail: outcome, collected details, timed transcript, and plain-language "What the receptionist did" (internal events and AI cost hidden).
  - Settings grouped: Answering / What it says and knows (prices etc. stay in Settings) / When someone asks for a person / Phone calls (not connected).
  - Save is enabled only when something changed.
- Customer chat:
  - Full-height layout with the composer docked at the bottom, safe-area aware, 16px input (no iOS zoom).
  - Mic button beside Send; call bar with End call.
  - Booking card (service, time, address), shown only after the server confirmed the booking. Callback card.
  - End and new conversation; a "Website" link only when the site is live.
- Overview: Needs your attention first (open callbacks incl. urgent, people who haven't booked), then 30-day results.
  - Show-up and completion rates say when they will appear, instead of showing 0.
  - Then Upcoming, then the website as a normal card (it is no longer a black hero).
- Shell: the active tab is accented; on phones the tab bar fades at the edge and keeps the current tab in view. Phone numbers are formatted.
- API (additive):
  - Receptionist list: `need`, `bookedAt`. Detail: `collected`, `bookedAt`, `request`, transcript `at`.
  - Public state: `booked.service/address`. Info route: `website` (only when live). Overview: `requests` (null when unavailable).
- Tests: unit 537, browser 106. New: a visual tour of 8 screens × desktop and phone, with a fictional seeded business
  (`test/e2e/seed-tour.mjs`). It checks one h1, no sideways scroll and no page errors; `TOUR_SHOTS=<dir>` saves screenshots.
- Not done yet: dark mode (tokens are ready, components are not themed); Appointments / Follow-ups / Settings / Ads restyle.
  Phase 2 is the website import → domain → publish flow (PoolThru target Nov 20–23).

## Receptionist repair after the first real test (2026-11-17) — fix/receptionist-journey; migration 0027 (NOT applied)

- Root causes, from the production transcript and Retell call data (no customer contact details recorded here):
  - "Hello?" ~22 s after the first message: the first answer took about 22 s (Retell llm p50 2.9 s, e2e p50 4.6 s,
    max 6.3 s), with no streaming.
  - The caller's words were duplicated in the model's history: replies that Retell discarded (the caller talked over
    them) were saved anyway.
  - Phone asked repeatedly: no saved-details state, so every turn re-collected; the caller never actually said digits
    (Retell transcript: "Call me at let's see."). Spoken digits ("two nine four…") would also have failed the check.
  - No booking: email was required, which is hard by voice.
  - "A person will call back": the hand-off tool returned "a team member will follow up", but no notice existed.
    It was called 3 times.
  - Dashboard showed 0: it loaded once, before the conversations existed.
  - Voice "no symbols" let a price in words bypass the $ check; pre-tool narration showed in the owner transcript.
- Fixes: save_customer_details + known-details note each turn + targeted re-checks + spoken digits; optional email;
  streamed voice with sentence checks; interrupted turns dropped; request_callback / leave_message →
  receptionist_requests (0027) + owner_callback notice with tracked state; end / new conversation, voice↔text in one
  conversation, text usable during calls; owner screen with real statuses, Needs attention, auto-refresh, phone
  routing disabled until connected; knowledge conflicts flagged (Settings win); one lead per conversation under
  concurrent turns.
- Tests: unit 537 (18 receptionist incl. regressions for each root cause; 100-scenario adversarial eval), browser 90
  (receptionist journey desktop + phone). Model, Google and Retell MOCKED; no new paid run.
- Needs approval: migration 0027, then deploy. Then a real chat + voice test (costs reported before).

## AI receptionist: real chat + voice, real calendar booking (2026-11-17) — feature/receptionist; migration 0026 (NOT applied)

- Built (docs/RECEPTIONIST.md): one multi-tenant engine (server/receptionist/) for website chat (/chat/<id>, linked
  from the business site) and browser voice (Retell, custom LLM = our engine). Claude Opus 5.5, real inference,
  server-side tools on the existing booking code (openSlots / bookAppointment / createLead), owner Receptionist tab
  (on/off, answering mode, greeting, approved answers, team phone, every conversation with actions + outcome), GHL notes
  on booking/hand-off (existing connector), provider-neutral routing (AI first / human first / after hours).
- Guards (all tested): only shown times bookable; customer's own confirming words required; ZIP/phone(/email) must come
  from the customer; one booking per conversation; out of area refused; invented $ never shown; cost/turn limits;
  tenant-bound tools; prompt-injection text never in the system prompt.
- Tests: unit 530 (11 receptionist + 100-scenario adversarial eval: 0 unauthorized bookings, 0 unoffered times, 0
  invented prices shown, 0 cross-tenant exposure), browser 90 (receptionist journey desktop + phone). Model and
  Retell are MOCKED in tests; no real-model or real-voice run yet.
- Blocked on approvals/accounts: migration 0026, RECEPTIONIST_ANTHROPIC_API_KEY (paid), Retell account + agent
  (RETELL_API_KEY / RETELL_AGENT_ID, paid), production deploy, the paid real-model eval. Phone numbers/forwarding not
  provisioned (routing simulated only). GHL: no account connected (connector tested with mocks only).

## Paid launch preparation (2026-11-17) — docs/PAID_LAUNCH.md; nothing activated

- Twilio trial (real, read-only): credentials valid, account active, type Trial, 0 owned numbers, 0 verified caller IDs
  visible via API, 0 subaccounts. Credentials stored as production secrets (not active until the next deploy). Real
  SMS through GetShowUps is blocked on the trial (shared numbers, template-only bodies, A2P needs a paid account).
  Texting is not needed for launch.
- Stripe (sandbox, read-only): founding price verified $499.00 USD monthly; sandbox webhook has exactly the 6 handled
  events; portal cancels at period end. No live account connected; live configuration steps in docs/PAID_LAUNCH.md.
- Verified (simulated): billing/webhook/access/cancellation/recovery/isolation unit tests 33/33; browser journey
  get started → pay → onboard → Calendar → publish → book → billing 12/12; CI green on main 4bc81f8.
- Finding (decision, no code change): access does not depend on Stripe mode, so toys-for-us (self-serve, not the
  founder, SANDBOX "active" subscription) keeps free access after live billing and its portal would fail.
- Monitoring: Cloudflare "Project updates" (Pages deployment failed), Incident/Maintenance alerts, Workers Observability
  Issues on the scheduler; no push alert exists for a silently stopped scheduler (Business Review shows it stale).
- Needs approval: live Stripe secrets + STRIPE_LIVE_ENABLED + deploy + live price; the $499 real-payment test (~$14.77
  Stripe fee kept after refund); MESSAGES_LIVE.

## Migration 0025 applied (2026-11-16, founder approval) — production 66a294d

- Applied the reviewed file (SHA-256 e073a335…076d) to `getshowups-onboarding` (8137dd39-53c5-4bad-8a46-3d20a43670bd).
  Before: dry run on a local replica of the production schema (no data): 104 existing objects unchanged,
  idempotent, constraints refuse a shared subaccount, a second subaccount per business, unknown businesses, invalid
  status/path, duplicate provider objects per business.
- After: `sms_accounts`, `sms_provider_objects`, `sms_registration_extra` exist (FK customer → customers(id);
  UNIQUE account_sid; one subaccount per business), all empty; schema objects 167 → 174 (3 tables + 4 key indexes);
  every existing table/index definition identical; counts identical (4 businesses, 8 leads, 6 appointments,
  31 messages, 0 registrations, 0 consents, 1 thread).
- Health: pages, booking (144/72/71 slots), PoolThru website, terms, privacy 200; auth/cross-site refusals as
  expected; Twilio webhooks 503 (not configured); texting box off everywhere; 0 sent since 0024.
- Switches: MESSAGES_LIVE off (last change 18:30 UTC); SMS_LIVE, FOLLOWUP_AI, TWILIO_* and
  TWILIO_REGISTRATION_SUBMIT not set. Nothing created at Twilio; nothing submitted or bought.
- Next (founder, Twilio Console): docs/TEXTING_ACTIVATION.md §1 — upgrade, Primary ISV profile, secrets.

## Twilio: one subaccount per business, A2P through Twilio's APIs (2026-11-16) — PR #52 (66a294d); migration 0025 applied 2026-11-16

- Founder decision: ONE GetShowUps parent account, ONE Twilio subaccount PER business (Twilio's preferred ISV
  architecture). Reuses the Build 49 engine unchanged except where it talks to Twilio.
- server/followups/twilio.js: subaccount create/recover (stable FriendlyName, adopted after a lost response, only
  subaccounts of our parent), token sealed (AES-GCM, HKDF subkey, AAD business|SID), usage (provider records),
  close on account deletion. Sending: parent creds on `/Accounts/<sub>/Messages.json`; a business without an active
  subaccount never texts (`no_account`). Webhooks: verified with the token of the AccountSid Twilio names; a sender
  is accepted only from its own business's subaccount (`account_mismatch` otherwise). Dead `sendSms` (parent
  account) removed; the test-mode check now also runs at the provider call.
- server/followups/provisioning.js: both paths through Twilio's APIs, one confirmed + audited admin step at a time
  (/admin → Twilio setup): low_volume_standard (EIN: Secondary profile → A2P profile → brand SkipAutomaticSecVet →
  LOW_VOLUME campaign) and sole_proprietor (no EIN: Starter profile → sole-prop trust product → SOLE_PROPRIETOR brand +
  owner OTP, resend → SOLE_PROPRIETOR campaign). Submitting/paid steps need TWILIO_REGISTRATION_SUBMIT=true (off)
  AND an approval tick; unknown outcomes recorded and never resent; noncompliant evaluations stop before submitting;
  'approved' only when Twilio reports the campaign VERIFIED (Sync + hourly cron). Number bought in the business's
  subaccount and attached to its Messaging Service.
- Owner form: structured address, representative (name, title, position), industry; path derived from business type.
- Unverified until the first real run (not in Twilio's docs): a subaccount profile referencing the parent's Primary
  profile SID; failure stops before submission (docs/A2P_REGISTRATION.md "If the first real run fails").
- Tests: unit 518 (8 new), browser 88 (Twilio setup panel). Nothing real was created, submitted or bought.
- **Needs approval**: migration 0025; then docs/TEXTING_ACTIVATION.md §1 (Twilio upgrade, Primary ISV profile,
  secrets) and §2 per business. SMS_LIVE / FOLLOWUP_AI / MESSAGES_LIVE stay off.

## Texting onboarding: opt-in before approval, A2P registration prep (2026-11-16) — PR #51 (8a5bba3)

**Production then**: release e2cde29 (PR #50) + PR #51; migration 0024 APPLIED 2026-11-16 (founder approval):
4 tables + 5 indexes verified; existing leads/appointments/messages/outbox/opt-outs/consents unchanged (counts
identical). Production test on the sandboxed `gsu-journey-test` (fake example.invalid lead): conversation record
created, follow-ups scheduled, booking → stage booked, retry 409, wrong token / other business 404, confirmation
`test_mode` (not a test recipient), first follow-up `not_needed` after booking. That test lead + its 19 Nov 14:00 UTC
booking + calendar event remain (test business). Logs: cron 200, no errors. Switches: MESSAGES_LIVE off, SMS_LIVE /
FOLLOWUP_AI / TWILIO_* not set. No Twilio account configured, no registration submitted, no number bought.

- Fixed the circular dependency: the texting box needed provider approval, but carriers review the live opt-in BEFORE
  approving. Now offerSmsFor(): shown (and consent accepted) once the owner approved submitting the registration
  (status ready/pending/approved; rejected/suspended/kill switch hide it). Texts still need the provider's approval +
  own sender + SMS_LIVE. Consent can no longer be recorded through the API where the box isn't offered.
- /sms-terms/<id>: public opt-in evidence (both boxes, exact wording, unchecked, inactive), booking link, who sends.
  Website-form box now also links Privacy. Privacy policy: "or text the business first", HELP, 12-month inbox retention.
- Registration content shown to the owner and used for the campaign: description, message flow (every opt-in path,
  public URLs, both box wordings), 4 samples = the real templates with [variables] and real links (no "…").
- Twilio keyword handling: OptOutType (STOP/START/HELP) from Twilio wins; we never send a second answer to a keyword
  Twilio answered (previously START/HELP would have been answered twice under Twilio's default handling).
- docs/A2P_REGISTRATION.md: ISV path (Primary profile "ISV Reseller or Partner" → per-business Secondary profile →
  brand → campaign), brand type per business (EIN → Low-Volume Standard; no EIN → sole prop, API-only for ISVs, not
  supported by our manual flow yet), PoolThru checklist, fees (usage verified; registration fees ESTIMATES), review,
  pre-approval testing, controlled website-form acknowledgment test on gsu-journey-test.
- Decision pending (founder, before the 3rd business): Twilio prefers a subaccount per business; we run one account
  with a Messaging Service per business (supported, riskier). Subaccounts need per-business credentials (not built).
- Remaining dependencies, in order (each needs approval): Twilio account upgrade + secrets → GetShowUps Primary
  Customer Profile → PoolThru owner approves its registration in Follow-ups → Texting → admin submits brand +
  campaign (fees) → record pending/approved in /admin → buy number + Messaging Service → test recipients → SMS_LIVE.
  Customer emails stay test-only until MESSAGES_LIVE (approval). Assistant: FOLLOWUP_AI (approval).

## Post-Build-49 checks (2026-11-16) — fix/quiet-hours-order; no migration

- PoolThru /p/poolthru-llc 404: NOT the release. audit_log seq 53 `website.unpublish` by an owner session at 20:00:52
  UTC (two-click "Take website offline"), 10 min after publishing v7 and 51 min before b5a7f86 deployed. v7 intact;
  the draft holds unpublished edits (palette, hero focus), so Restore (overwrites draft) and Publish (puts them live)
  are owner decisions. Founder decision: leave it offline; nothing written.
- Fix: quiet hours deferred a text before the permanent skip checks, so a text that could never go (GHL owns texting,
  not ready, opted out) was postponed nightly instead of skipped; it also made a CI test fail between 21:00 and 08:00
  UTC. The deferral now runs last. Regression test with a fixed night clock. Only reachable after 0024 + Twilio.
- Runbook: production D1 is `getshowups-onboarding` (docs/TEXTING_ACTIVATION.md said ONBOARDING_DB, the binding).
- 0024 re-reviewed: 4 tables + 5 indexes, all IF NOT EXISTS, no ALTER/DROP/UPDATE/DELETE/INSERT; none exist in prod.

## Build 49: follow-up engine, two-way texts, A2P 10DLC readiness (2026-11-16) — PR #49 (b5a7f86); migration 0024 applied 2026-11-16

- One engine for every eligible business (server/followups/): source adapter (website_form, booking_page, sms; ready
  for google_ads/gbp/call) → consent → immediate acknowledgment (website forms) → conversation → booking → follow-ups
  stop. Reuses leads, messages (new kinds lead_ack, interested_followup, after_visit), the scheduler, Resend, opt-outs,
  consent, conversation_control, the audit log. New: lead_threads, thread_messages, followup_settings, sms_registrations.
- Texts only from the business's OWN sender with a provider-APPROVED registration + consent + SMS_LIVE (else test
  recipients only). Existing confirmation/reminder texts now follow the same rule (prod had no Twilio configured).
- Two-way texts: signed Twilio webhooks, MessageSid idempotency, forward-only delivery updates, fixed STOP/START/HELP/
  human/cancel handling, assistant on the included model (FOLLOWUP_AI, off) with strict checks and a fixed fallback.
- Dashboard Follow-ups tab: counts, inbox, conversation, takeover/hand back/reply/stop, pause, preferences, texting
  registration (details + explicit approval). Website forms and booking page offer the texting box only when ready;
  public /sms-terms/<id>. Admin: counts, failures, stuck work, spikes, costs, registrations, record provider status.
- Tests: unit 509 (19 new follow-up tests), browser Follow-ups journey on desktop + phone.
- 0024 applied 2026-11-16 (founder approval). Remaining activation: see the A2P onboarding entry above.

## Website Studio UX overhaul (2026-11-16) — feature/studio-ux; no migration, no paid calls

- The website preview is the editing surface: click text to type in place; click a button (text + destination) or a
  photo (choose, shape, focus point, description) for a small panel; hover/selected sections show a compact bar
  (name, ↑, ↓, ⋯ = settings / add below / duplicate / hide-show / remove with confirmation). Edit | Preview mode,
  Desktop | Phone, icon undo/redo (typing coalesced into one step), unobtrusive save status.
- Side panel: contextual (selected section's settings) + Sections (compact rows, drag to reorder, arrows, ⋯) · Style ·
  Photos · History. Concise section names (Hero, Services, Benefits, How it works, FAQ, Booking, Service areas…).
  "+ Add a page…" in the page menu.
- Website tab: a slim publish bar, then the editor (wider page); import + AI designer in one collapsible row above it
  (kept mounted so a designer conversation isn't lost).
- Rendering: hero photo heights capped (min(560px, 64vh); stacked 480px/56vh). AI designs that open a page twice get a
  soft `repeated_opening` revision; the editor can't add or duplicate a second opening. Stored content untouched.
- Tests: unit 490; browser 85 (in-place headline, button panel, price in place, add/hide/show/duplicate/move sections,
  brand colour, add page from the page menu, phone + Preview mode, reload persistence, undo/redo, keyboard menu,
  photo panel framing, history restore, publish/republish/restore, two-tab conflict).

## Website publishing for every eligible business (2026-11-16) — feature/publishing-on; no paid calls; no migration

- Publishing is standard self-service (no allowlist, no per-business flag): studioPublishAllowed is ON unless
  WEBSITE_STUDIO_PUBLISH === 'false' (emergency pause). No Cloudflare setting needed: the code release turns it on.
- Safety added: restore now requires confirmation like publish (UI asks first); every page must render before going
  live (422 render_failed, live untouched); version insert + live pointer in one D1 batch (all or nothing, tested by
  failing the store mid-publish); Publish is held while the Studio editor has unconfirmed edits.
- Unchanged: publish needs the owner (session, same-origin), explicit confirmation, a bookable business (calendar +
  hours) and active hosting; per-business data; audit (website.publish / website.restore events); versions + rollback;
  GetShowUps address /p/<id> and connected domains; no AI key needed to publish.
- Tests: unit 488, browser (editor journey now publishes, republishes and restores on the GetShowUps address).

## Website Studio closing pass (2026-11-16) — feature/studio-finish; no paid calls; no migration

- Production migrations 0021–0023 VERIFIED applied (read-only sqlite_master + pragma_table_info): all 8 tables/indexes
  present, columns identical to a fresh migration build, ai_model_registry has the 13 seeded rows. Studio is live for
  eligible businesses. No production migration needed or added.
- Photo framing: hero / photo-and-text / booking-banner photos take `imageFocus` [x,y] and `imageAspect` (validated,
  stored only when changed, rendered as object-position + aspect-ratio crop); composition photos use their existing
  focus/aspect. Editor: click the photo (or arrow keys) for the point to keep, pick a shape.
- Phone-sized photos: each owner photo can have a ≤800 px copy (made in the browser on upload, or "Make phone versions"
  for older photos); content.variants { photoId: smallId } (validated, own photos only); pages use srcset 800w/1600w;
  copies are public only with their photo (usedBy). PoolThru home on throttled 4G: 367 KB, LCP 2.2 s (was ~655 KB/3.6 s).
- Draft checkpoints (server/website-history.js): server copies of the draft in website_generations kind 'checkpoint'
  (no new table): on save at most every 10 min, on publish, before a restore; newest 20 kept per business; restore via
  the History tab (Studio + owner only; the restore itself is undoable). getGeneration ignores designer/checkpoint rows.
- Unused photos: "Remove unused photos" deletes only what nothing recoverable shows (draft, live, saved versions, AI
  undo, checkpoints: read as content, not text search); per business; 120 files incl. phone copies, 50 MB.
- R2: not needed yet. Production has 5 photos / 1.46 MB across 2 businesses (D1, ~10 GB capacity); per-site budget
  50 MB. Revisit at ~2 GB total media or ~40 sites near their budget (needs a bucket binding: approval).
- Tests: unit 487/487, browser 85/85 (photos/framing/history test desktop + phone), PoolThru acceptance 26/26 (local).

## Website Studio completion: direct editing, pages, forms, SEO, media (2026-11-16) — feature/studio-editor; no paid calls

- Editor (src/dashboard/SiteStudio.jsx) for AI-designed sites (Studio access): click anything in the live preview to
  edit that section (headings, text, buttons + destinations, photos + alt, services/prices/descriptions, FAQ, steps,
  highlights, gallery, contact form); section list (move, hide/show, duplicate, remove, add from 10 types); pages (add
  About/Services/one service/Service area/Contact/FAQ/Privacy from the business's own details, menu order, menu name,
  Google title/description, delete); look (background tone, brand colour, 7 approved font pairs, buttons, corners,
  footer); photos (upload ≤10 MB originals, resized in the browser; remove only if nothing recoverable uses it).
  No AI call for any of it. Preview = POST /api/dashboard/website/preview (validated like a save, nothing stored).
- Persistence: debounced autosave, server-confirmed status, retries with backoff, local copy of unsaved edits offered
  after a reload, undo/redo (50 steps), optimistic concurrency (baseUpdatedAt → 409 conflict with "load latest / keep
  mine"; saveDraft { expect }). One editor per draft (the older form is hidden for AI-designed Studio sites).
- Spec: sections `hidden` (left out of the site, dimmed in the editor; the first screen can't be hidden), contact
  `form` none|contact|quote, owner page cap 10 (the AI is still asked for ≤5), 160 KB spec.
- Forms (server/site-form.js, POST /api/site-form/<id>): plain HTML (no script), CSP form-action 'self' + GetShowUps,
  trap field, signed render time (3 s–24 h, HMAC, no storage), rate limits per IP and business, validateLead + createLead
  (the existing leads table, owner notices and follow-up scheduling; no second lead store), 303 back to the page with
  ?sent=1 / ?form=<reason> (result pages not cached).
- SEO: canonical per page, Open Graph + Twitter card with the page's photo, per-site favicon (logo or /site-icon/<id>.svg
  letter mark), LocalBusiness with confirmed hours + FAQPage JSON-LD, sitemap with every published page (+lastmod).
- Media (server/assets.js): 60 photos / 50 MB per website in D1 (2 MB row limit, 10 GB database: 250 MB needs R2 =
  bucket binding, production change with approval); quota error; delete refused while the draft, live site, any
  saved version or an AI undo uses the photo.
- Tests: unit 483/483 (conflicts, preview, hidden, forms incl. bots/expired/forged/cross-business tokens, sitemap, SEO,
  favicon, photo protection/quota, isolation); browser 83/83 (editor desktop + phone, keyboard reachability, two-tab
  conflict; desktop/phone runs use their own seeded businesses). PoolThru acceptance (real content and photos, LOCAL
  server with publishing enabled only there): 22/22 incl. form → lead stored, publish, booking links, second-business
  isolation. Production publishing remains off.

## Website Studio for every eligible business (2026-11-16) — feature/studio-access; no paid calls

- Root cause (PoolThru saw no Claude/OpenAI controls after #43): Studio was an internal pilot behind
  WEBSITE_STUDIO_ENABLED=true AND an explicit WEBSITE_STUDIO_BUSINESSES list; neither is set in production, so every
  Studio route was 404 and the dashboard hid the cards. Not a #43 code defect (the deployed bundle had the UI).
- Now (owner decision): server/website-studio.js studioAccess(env, session.customer): on by default
  (WEBSITE_STUDIO_ENABLED=false = emergency off), business active, hosting status 'active' (paid/trialing/past due or a
  never-billed pilot), and Studio's tables present (0021–0023; hidden, not broken, until applied: deploying needs no
  migration). The allowlist is gone. Session, same-origin, tenant scoping, rate limits and the AI allowance unchanged.
- No silent platform AI: the older writer used to treat a stored key marked invalid (or unreadable) as "no key" and fall
  back to the included GetShowUps-paid model. Now a stored key is used or its problem reported (invalid_key /
  ai_unavailable); the included model runs only when no key is stored (website-ai.js ownCredential, storedCredential).
- Wording: the "N of 400 AI changes left today" line gets a second line: with an own key "a GetShowUps daily safety
  limit, not your Anthropic/OpenAI credit … billed by them"; without one, "the daily limit of the AI writer included with
  GetShowUps". (400 = the testing tier: a platform admin signed in.)
- Business Review: capability website.studio (live / missing until 0021–0023 / disabled, plus the publish switch);
  WEBSITE_STUDIO_PUBLISH recorded on/off in change history. Publishing unchanged: off unless exactly 'true'.
- CI flake fixed (modes.test.js): it booked slots[0], which can start within a second (a slot on the hour booked at
  hh:59:59), then sent messages "1 s later" to an appointment that had started → confirmations correctly skipped. Now the
  first slot ≥10 min ahead (as automation.test.js slotAfter). Reproduced and verified with a shifted clock.

## Website Studio: stable service ids in AI-designed sites (2026-11-16) — PR #43; no paid calls; draft, NOT merged

- Defect (on main since the pilot, found in the release review): the AI design pointed at services by list position, so
  deleting the first service showed "Weekly Pool Care" with the one-time service's description. Now the design refers
  to `content.services[].id` (AI-designed content only; content without an AI design keeps its exact shape).
- Ids: kept if valid and unique; else inherited from the saved service with the same name (`prior`: save route, import
  apply), so a page or import that drops ids keeps descriptions; else a new random id (never a position, never reused).
- Backward compatible, no migration: drafts and versions saved before ids are upgraded at READ time, deterministically
  (s1, s2, … against the same stored list their positions were written for), so they show the right descriptions,
  compare equal draft vs live, and are never rewritten by reading. A pre-id page saving positions is read against the
  saved list. The model still sees positions in FACTS.services (servicesForModel converts at that edge only).
- Other positional references checked: photos (asset/stock ids), links (section ids, page slugs), redirects (paths) are
  already stable. Remaining best effort: an undo stored BEFORE this change resolves positions against today's list.
- Tests: delete first + middle, add, reorder, a page without ids, save + reload, pre-id draft + published version,
  model positions ↔ stored ids, import by name, dangling id dropped. The 3 new tests fail on the old code.

- Cap: actual settled spend in this test + the next request's worst case ≤ $0.50, checked before every request (the
  product's own limit can't express a combined $0.50: $1 minimum, per provider). GPT ran first ($0.057 + $0.059 =
  $0.116, revision included), then Claude ($0.068, no revision needed). Nothing blocked.
- `same_lead` triggered LIVE on GPT: its first answer kept "Less upkeep. More pool time."; the revision request carried
  the note and the saved design has a new headline ("Good days start with water."), lead photo, structure (one wide photo,
  words inside), fonts (Syne/Inter) and palette (graphite/mint); no soft issues left. Claude's answer was different on
  its own (collage, "Charleston pools, kept crystal clear", Syne/Inter, cobalt), so nothing triggered.
- `buried_photo` did NOT trigger live (neither answer layered a card over most of a photo): untested live; covered by the
  unit test built from GPT's earlier live layout.
- Visual inspection found one more renderer defect, fixed + regression test: a solid button in a dark ("ink") section
  took the section's light text colour (`.bg-ink a{color:inherit}` outranks `.btn`), so GPT's mint Book button read
  white-on-mint. Now `.bg-ink .btn:not(.ghost)` keeps the button's own label colour.
- Comparison sheet (full pages, desktop + phone, before/after per provider): scratchpad validation2/final-compare.png.
- Unit 474/474, browser 79/79.

## Website Studio: live re-validation for PR #43 (2026-11-16) — both providers pass; $0.497 spent; draft, NOT merged

- Claude compatibility call (approved, $0.40 cap, enforced in the harness as a worst-case-before-send guard): passed,
  1 request, $0.077. The compact 58-property schema compiles; the composition came back valid with no check issues.
  That call is Claude's turn 1 (same brief), counted inside Claude's $2.50 product limit.
- Three turns per provider (design → different direction → owner change request), approved $5 combined:
  Claude Sonnet 5.5 $0.077 + $0.153 (1 revision) + $0.062 = $0.292; GPT-6.1 Sol $0.051 + $0.095 (1 revision) + $0.059 =
  $0.205. Total $0.497. Every turn produced a valid design; no provider/schema errors.
- Both models now use the composition system: Claude type poster → full-bleed photo with the headline inside; GPT type
  poster with a large mark → three-photo collage with an overlapping headline card. Brand "PoolThru" everywhere.
- Visual inspection found renderer defects (fixed, regression tests): a full-width photo under words kept its 21:9
  proportion as a grid item (grew past the page edge as type grew; sat inside the margins on a dark band) → now a
  backdrop (design-blocks.js compositionRoles) that fills the section/content area; a photo beside a stack spread its
  extra height between rows (button far below its text) → two flexible spacer rows centre the stack; on phones photo
  boxes took their width from their height and overflowed the screen (GPT's page measured 10,003px, now 5,342px) →
  width:100%; footer "PoolThru: pool cleaning…" lost the brand but started lower-case, and "PoolThru. Pool care…"
  repeated it → fixed. The balance estimator follows the same roles; a ragged text stack is no longer a "hole".
- New soft checks (one revision): `buried_photo` (a photo mostly hidden under a layered card — GPT's revision left a
  sliver) and `same_lead` ("different" kept the previous headline or lead photo — GPT kept "Less upkeep. More pool time."
  and the hat photo). Both were applied to the saved live outputs offline, not yet with a live call.
- Remaining weaknesses: GPT leads with the same owner photo it likes best; below-the-fold sections are still mostly
  preset patterns (services rows, steps, area chips, CTA band); the collage's paragraph and button sit below a 900px
  desktop first screen (the nav Book stays visible); the poster's large top padding.
- Unit 473/473, browser 79/79, lint/build/Functions clean. Next: owner review of the screenshots; optional one more paid
  "different direction" turn per provider to see `same_lead`/`buried_photo` trigger their revision live.

## Website Studio: design quality pass for PR #43 (2026-11-16) — paid re-validation BLOCKED (Keychain), $0 spent

- Root cause of generic AI first screens: the prompt described composition options abstractly and nothing pushed back
  on the safe split. Now: four FIRST-SCREEN RECIPES in the exact token form (server/design-blocks.js RECIPES: editorial
  overlap, immersive full-bleed, type poster, collage; each validated + rendered by test/design-recipes.test.js and
  inspected visually with PoolThru's photos), craft rules (alignment, rows ending together, photo choice, a different
  direction leads with a different photo), and a soft check `conventional_first_screen` (new designs only, never owner
  revisions) that asks for the one revision.
- Balance check (server/design-checks.js layoutComposition/compositionBalance): estimated desktop layout → mostly_empty,
  empty_band (≥3 columns), misaligned (stacked edges off by one column; layered cards exempt). Showcases pass; the live
  GPT signature section is flagged. Soft → one revision.
- Brand: AI-designed sites show displayBrand() (legal suffix removed, the owner's own spelling from their reviewed text:
  "PoolThru"); footer names it once. Legacy renderers unchanged.
- Claude compatibility call (approved, $0.40 cap) NOT made: reading the key from Keychain timed out twice (an access
  prompt on the Mac waiting for Allow). No request sent. Next: owner clicks Allow, then the compatibility call, then
  the three-turn validation for both providers.
- Unit 470/470, browser 79/79.

- Claude Sonnet 5.5: STOPPED at turn 1. Anthropic refused the schema ("compiled grammar is too large"; $0, request
  req_011Ch64roW2E444i4ZRqLVbx). Fixed: Claude's compact schema is back to main's 58 properties (the size that compiled
  live): composition blocks ride in `items` (title = kind + place/look tokens), the design idea in `name`. NOT re-verified
  live (stop rule); needs one approved Claude call before merge.
- GPT-6.1 Sol: 3/3 turns ok, no revisions, $0.0437 + $0.0466 + $0.0568 = $0.147. Found and fixed: "size display" tokens
  reported invalid (now accepted); a 184-char design idea was dropped (now shortened); the "different" design was the
  first one mirrored with a serif (check now compares first-screen structure, so it would get the one revision).
- Visual verdict: clean, legible, booking prominent on phones, but generic: all three first screens are photo + headline
  side by side; the model used none of the overlap/scale/mark/treatment controls; below the fold is presets; the brand
  shows as "Poolthru LLC" (record name), footer repeats it. Not "professionally art-directed" yet.
- Centered nav fixed (logo centred, Book right, links below; phones: logo left, Book right) + regression test.
- Unit 466/466, browser 79/79. Next: owner review; prompt work for bolder compositions needs another paid run.

## Website Studio: composition section + design quality (2026-11-16) — draft PR, NOT merged; no paid calls

- PR #42 (hero/nav/phone headlines) merged and deployed (f8239b2, 05:02 UTC): PoolThru's live page hash unchanged,
  booking 160 slots.
- New: `composition` section type in v2 (server/site-spec.js + site-render-v2.js, string renderer kept): ≤10 blocks on a
  12-column grid; phone layout derived; readable overlaps; CSS from validated values only, sent only when used.
- Generic fallbacks: invalid choices and empty blocks are reported; server/design-checks.js decides (hard → one revision
  → error `ai_design_incomplete`, nothing saved; soft → one revision → saved). Raw answers redacted, kept 30 days.
- Art direction (`direction`), prompt guidance for compositions and phone order, "Show me a different direction".
- Fixes: CTA card on an accent background now readable; nav Book button ≥44px.
- Evidence: three directions with identical PoolThru info + photos (test/fixtures/design-directions.js) differ on
  desktop and phone, incl. as neutral wireframes; responsive checks pass at 320/390/768/1024/1440; saved AI designs
  render with identical page bodies (CSS: only the two fixes). Bundle +25 KB (+1.1%).
- Found by the browser test: the Claude path converted twice and dropped composition buttons silently; fixed
  (idempotent parsing, empty blocks reported) with a regression test.
- Unit 463/463, browser 79/79. Next: paid validation (approval) — Anthropic grammar size + real AI compositions.

## AI-designed sites: hero height, nav and phone headline fixes (2026-11-16) — draft, NOT merged

- Production pilot design (GPT-6.1 Sol): hero 1,054px tall on a 900px screen, 353px empty above the copy, headline at
  y=462. Cause: the hero's inner container inherited the section's min-height, so section padding was added on top,
  and "tall" ignored the nav. Fixed: one flex box, height measured below the 72px nav (svh), padding capped. Now 693px,
  headline at y=281. Phones unchanged (content-sized).
- One-page sites put the nav's Book button next to the logo (no links to push it). Fixed.
- Large type scales or wide display fonts ran headlines off a 390px screen (preferred fluid size ≈120px). Both ends of
  the fluid size are now capped by viewport width; overlong words may wrap. Desktop sizes unchanged.
- Diagnosis of "generic designs" and the architecture proposal: in the owner report (awaiting approval).

## Website Studio release candidate (2026-11-16) — `release/website-studio` (= #37–#40 + below), draft, NOT merged

- Production verified READ-ONLY (schema names from sqlite_master, no rows): every table/index/trigger of migrations
  0001–0020 exists (incl. both audit_log triggers); nothing outside the migrations; 0021–0023 absent. Production code:
  main e3af1fc, Pages deployment 1aff1e8f (from build.json + the commit's Pages check).
- No server-side fallback for own-key requests (owner decision): only the chosen/reserved model runs; usage is recorded
  and priced as that model even if a response names another. Regression test (one request, no `fallbacks`, no fallback
  beta header, Sonnet prices on an "Opus" response, refusal not re-run). Ads strategy (GetShowUps' key) unchanged.
- Internal pilot gate: WEBSITE_STUDIO_ENABLED + WEBSITE_STUDIO_BUSINESSES (server/website-studio.js). Tests: switch,
  routes 404, no key use, no hand-crafted site/redirects, published sites keep serving; browser: non-pilot sees nothing.
- Restore of an earlier AI-designed version (pages + booking links, live + draft): regression test.
- Rollback measured with production code on Claude's real PoolThru design: renders the older template from the same
  content (imported headline; booking link intact); extra pages (/p/<id>/services) show the GetShowUps marketing page
  (production's fallback, checked read-only); a dashboard save during rollback drops `site` and `redirects`.
- One merge = one deploy: merging #37–#40 one by one would put three ungated intermediate states in production.
- Unit 447/447, browser 79/79. Local journey re-run on the candidate (PoolThru in the local pilot): all steps pass.
- Preflight (read-only, 2026-11-16): `poolthru-llc` = PoolThru (real, not test-marked; its one owner account is NOT the
  GetShowUps owner's); `gsu-stripe-test-pools` = internal test business (test-marked, owned by the GetShowUps owner).
  PoolThru's live website (v5, not AI) renders byte-identically with production code and this candidate (our address and
  own domain); no booking/Ads/cron/messaging/billing/auth/domain code changes. D1 Time Travel bookmark recorded; production
  deployment 1aff1e8f confirmed via `wrangler pages deployment list`.
- WEBSITE_STUDIO_PUBLISH (off by default): AI-designed sites and Studio redirects can't be published or restored during
  the pilot (409 studio_publish_off; dashboard explains it; drafts and previews work). Unit + browser tests. 448/448, 79/79.

## Website Studio customer-journey validation (2026-11-16) — #38 → #40, draft, NOT merged; no paid calls

- Walked the whole PoolThru journey in a real browser, UI only, on a local build (throwaway DB; local stand-ins for
  Google sign-in/Calendar and for Claude, which replays Claude Sonnet 5.5's real saved PoolThru designs): sign in →
  Website → connect key → design → desktop/phone preview → revision → publish (local /p/poolthru-llc) → a customer books
  from the site's "Book a visit" on a phone → the owner sees it under Appointments. All steps work after the fixes.
- Found and fixed:
  - Auto dead end (#38, migration 0022 seed, unapplied): no model was 'tested', so a new owner's first request on the
    default Auto was refused. claude-sonnet-5-5 and gpt-6.1-sol (verified live 2026-11-15) are now 'tested'.
  - Data loss: the older "Create with AI" tools (Describe a change / three new designs / standard designs) build drafts
    without the AI design; keeping one silently dropped it. Hidden for AI-designed drafts, and the server refuses such an
    apply (409 designed_site, e.g. from an old tab). Regression test.
  - Dead controls on AI-designed drafts: style, colours, logo and Google fields saved but changed nothing. Hidden, with
    a note on what the remaining fields do (services/prices show directly; the rest is what the designer writes from).
  - The applied import kept its full review ("Use this in my draft") → one-line summary with "Review again".
  - Duplicate key panel ("Your own AI key") removed: the designer card holds key, model and limit.
  - Two identical "Publish website" buttons while confirming → one, plus "Not yet". Designer chips were Title Cased.
- Website tab after a design: 3,802 px (was 5,737). Unit 444/444, browser 79/79 (designer + import specs updated).
- Not changed (noted): the older "N of 40 AI changes left today" allowance also counts designer turns but is now only
  shown before an AI design; business name shows as "Poolthru LLC" (owner can rename in Settings).

## Live A/B test diagnosis (2026-11-15) — #38 → #40, draft, NOT merged; no paid calls since

- Test run (approved): Claude Sonnet 5.5 → HTTP 400, 0 tokens; GPT-6.1 Sol → HTTP 429 insufficient_quota /
  credit_balance_exhausted ("no credits remaining"), 0 tokens. $0 charged. No designs, so no revisions. Keys deleted.
- Claude root cause (ours): the designer's strict schema had 29 union-typed (nullable) parameters; Anthropic's
  structured outputs allow 16 and return 400 "Schema is too complex for compilation". Not billing (Anthropic billing is
  402 billing_error). The provider's message was not captured on that call; the cause is established from the schema
  and the documented limit. Fixed: no unions ("not used" = ""/[]/-1/0/empty button, mapped back by fromStrict before
  validateSpec, proven equivalent by test). Regression test for both schemas (test/schema-limits.js).
- OpenAI root cause (account): no API credit. Our bug: only code === 'insufficient_quota' counted as billing, so it was
  shown as a rate limit. Fixed: openAiError/claudeError → provider_billing (402, released, not retried); provider
  status/type/code kept on events/logs (identifiers only).
- Next: fund the OpenAI API account; re-run the same approved test (approval needed).
- Second live run (keys recovered into Keychain, read with --keychain): Claude 400 "The compiled grammar is too large …
  Simplify your tool schemas" (req_011Ch5gsxM43xB4hLPaicRSF) — so removing unions was necessary but not sufficient.
  OpenAI 429 credit_balance_exhausted again (the key's organization has no credit). $0, 0 tokens.
- Fix A (owner-approved): choices are described strings, not enums (18 enums → 1: section type). validateSpec already
  enforces every list with a safe default (test). Grammar size can't be measured locally; needs a live call to confirm.
- Third live run: GPT-6.1 Sol design + revision succeeded (7,781 in / 5,993 out tokens, ≈$0.0755; nothing removed by
  validation). Claude still 400 "compiled grammar is too large" (req_011Ch5hhHLNWBx7VbHCWkrxZ).
- Option B (owner-approved): Claude gets a compact section shape (13 fields instead of 28; 58 properties instead of
  79): style/option tokens, one image list, one button list, FAQ via title/text. fromCompact() → standard shape →
  unchanged validateSpec; toCompact() for revisions. Round-trip test: every section type and control comes back
  identical. OpenAI keeps the standard schema.
- Renderer: wide sections now share the header/footer content edge (were 160px wider → 20px vs 80px at 1440).
  Measured in Chrome: 80px = header at 1440; mobile unchanged (20px), no horizontal overflow.
- Fourth live run (Option B, Claude only, approved): Claude Sonnet 5.5 design + revision both succeeded. Design 6,060 in /
  5,345 out ≈ $0.0656 (validation removed one too-long SEO description); revision 9,896 in / 3,536 out ≈ $0.0552 (nothing
  removed). Total ≈ $0.121 (our estimate from list prices). Booking link in the first screen of every page, desktop and
  phone. Artifacts and the side-by-side comparison with GPT are local only (scratchpad demo-live4).
- Renderer: full-width sections had NO gutter (text at 0px; header at 120px desktop / 20px phone), found on Claude's
  full-width overlay hero; every section type had it. Fixed: `.w-full .wrap` padding = the container edge, min 20px.
  Backgrounds and overlay photos stay edge to edge. Measured in Chrome at 1440/1024/390, all 6 hero layouts and every
  section type: text at 120/20/20 = header; no overflow. Regression test.
- e2e automation.spec "can't make it … picks a new time" (was failing in the evening): test-fixture race, not a product
  bug. The booking page lists one day at a time; from 20:00 to 21:00 New York (01:00–02:00 UTC in winter) only one slot is
  left today, so this test's "last slot" and the parallel resume test's "first slot" (same business) were the same slot
  and the double-booking guard rightly refused one ("That time was just taken"). Failures were at 01:12–01:14 UTC. Fixed
  in the test: book on the last offered day. Product unchanged.

## Website Studio: own-key models discovered per account, Auto, hard limit (2026-11-15) — #38 → #39 → #40, draft, NOT merged

- Both providers end to end, tested with mocks: connect key → model list from the customer's account → design → revision
  → publish (Claude streaming + OpenAI strict json_schema). No real provider call made yet.
- Models: discovered with the customer's key (free `GET /v1/models`); Anthropic filtered by
  `capabilities.structured_outputs`, OpenAI by text-model family rules (no audio/image/embedding/realtime/dated snapshots).
  Catalog stored per key, refreshed when older than a day or on "Check for new models". `ai_model_registry` (0022, editable
  without deploying) holds verified prices (2026-11-15), quality rank, status tested/supported/blocked and the model's own
  output ceiling. Unpriced new models are shown but not selectable (spend must be boundable).
- Selection kept; a model the account stops offering is reported and refused, never swapped. Auto (default) uses only
  `tested` models, best quality within the limit, never moves to a more expensive model. **No model is `tested` yet**:
  until the approved real demo marks some, owners pick a model by hand.
- Hard monthly limit per key (default $10, owner $1–$1,000): month-to-date spend from `ai_key_usage` (every own-key call,
  failed ones too; tokens only) + this request's worst case (measured prompt, the output cap actually sent) must fit, else
  refused before sending. SDK retries off for own-key calls.
- Fixed: GPT-4o / GPT-4o mini output ceiling 16,384 (asking for more would have been a 400).
- Next: approval for the real two-provider PoolThru demo (estimate in the PR thread / summary), then mark the demoed
  models `tested` in the registry.

## Integration checkpoint (2026-11-14) — PRs #24–#28, all draft, CI green, NOT merged or deployed

**Verified now:** production deployment 0020f305 (main d426fef); production has migrations through 0014 (0015–0017
absent). PR heads: #24 66a1c5c, #25 1447980, #26 8d23a95, #27 3becc96, #28 ab27c29: `verify` and Cloudflare Pages
checks pass on each; no failures. Local on #28: 375 unit, 72 Playwright, lint, build, Functions compile.

**business-review.patch (other agent):** not the source of #28 (both built independently; patch based on d426fef).
Four ideas adopted in commit ab27c29: (1) health as a separate axis + 4 s check timeout (server/ops/review.js,
src/admin/Review.jsx); (2) payment-recovery email, one per invoice per owner via the outbox/launch gate
(server/billing-recovery.js, server/stripe.js); (3) per-capability event drill-down (functions/api/platform/audit.js
`?capability=`, Review.jsx); (4) docs/DATA_REQUESTS.md note pointing business deletion at the workflow. Everything
else in the patch duplicated existing systems or contradicted owner decisions and was not merged. A scan of #28 finds
the patch's tables/modules (audit_events, lifecycle_states, deletion_requests, shutdownAdvertising, 0015_operations_core)
only in docs/OPERATIONS.md §7. One module per system (see CLAUDE.md "Release state").

**Migrations:** 0001–0017 unique and ordered. 0015–0017 applied twice to an exported copy of the production schema
(schema only, read-only export): idempotent, integrity ok, 0 FK violations, audit_log UPDATE/DELETE blocked, no name
clashes. Still to verify in production after applying: the two audit_log triggers exist and refuse a change.

**Scalability (measured at 10/100/1,000 synthetic businesses):** admin list 2 D1 + 1 KV, Business Review 92 + 3,
one business 43 + 2 (all independent of size after fixes; before: 472/918/513 queries and 1,000 KV reads each).
Fairness fixes for the ads hold sweep and recovery expiry; cron batches 25 recovery / 2 deletions per run.

**Release order (approval required for every step):** #24 → apply 0015 → #25 → apply 0016 → #26 → #27 → apply 0017 →
#28, then read-only checks (docs/OPERATIONS.md §3). Ship as a set (the scalability fixes live in #28).
**Rollback:** Cloudflare Pages → Rollback to 0020f305 (or `git revert -m 1` per merge); never drop the new tables or
edit audit_log; switches off stops new work (deletion has no undo).

**Decisions open (owner):** retention policy and deleting the Stripe customer (docs/DATA_RETENTION.md); retention
schedule after day 90 (until then canceled accounts' data is kept indefinitely); enabling ACCOUNT_DELETION_ENABLED;
privacy/FAQ wording; Google confirmation of the automatic pause (safety stop) before real spend; whether /admin should
open on Business Review; optional off-Cloudflare anchoring of the audit head hash.
**External blockers:** Google Ads API access (Cloud project at Test level), Google OAuth verification (sensitive scopes,
under review), Twilio account + A2P 10DLC for texts, live Stripe keys/price/webhook (and STRIPE_LIVE_ENABLED approval),
MESSAGES_LIVE approval, Cloudflare API token for own domains, Workers AI binding approval.
**Production verification after release:** /admin/review loads and shows "Migrations: 17 of 17 applied", audit log
intact, a reconciliation result (Stripe test mode, read-only), daily checkpoint appears within 24 h; PoolThru page and
booking smoke as in the last release; no business with "Ads still running while on hold".
**Not built (next, after release):** one-person data erasure (lead asks to be forgotten; manual today), incident
acknowledgement/notifications in Business Review, first real conversation provider, splitting the cron if busy runs
approach the D1 query limit, batching audit writes at high volume.

## Business Review + review fixes to #24–#27 (2026-11-14) — branch feature/business-review (stacked on #27), NOT deployed

Review fixes pushed to each PR: #24 no budget increases on hold, disconnect-on-hold must pause first, unreachable
(orphaned) campaigns escalated + cleared only by audited confirmation; #25 standard events (capability, resource,
outcome, correlation id; free text fingerprinted; docs/AUDIT.md limits); #26 unpublish at lockout, unreachable ads block
deletion until confirmed, stuck escalation, staff-log free text erased; #27 day 90 records expiry only, separate
retention schedule switch, retention policy rewritten (draft), webhook idempotency test.
Business Review (/admin/review): capability registry + catalog (server/ops), generic engine (statuses from config +
production evidence, dependencies, open failures, incidents, approvals, change history from dist/build.json + cron),
Platform and Business views. Conversation providers extension point + control lock (migration 0017). docs/OPERATIONS.md.
Tests: 369 unit, 72 Playwright (incl. a never-seen capability rendering from data alone; 320/390 px no overflow).

## Lifecycle, 90-day recovery, billing reconciliation (2026-11-14) — branch feature/lifecycle-reconcile (stacked on #26), NOT deployed

server/lifecycle.js (stage view; admin "Lifecycle" card), 90-day recovery for canceled billed accounts (owner Billing card
shows the date; admin attention recovery_ending/ended; after it the cron starts deletion only when deletion is enabled;
never pilots/test businesses). server/reconcile.js: Stripe ↔ records daily + on demand, read-only, all difference types,
audited runs, admin resync (audited; live mode refused). No migration. Tests: 354 unit, 70 Playwright. In production the
daily reconciliation would read Stripe test mode (2 subscriptions) once deployed.

## Account deletion workflow (2026-11-14) — branch feature/account-deletion (stacked on #25), NOT deployed, OFF

Owner policy 2026-11-14: permanent, no undo window, no founder approval; durable/retryable/audited; retained records
documented (docs/DATA_RETENTION.md, DRAFT for approval). Migration 0016 `account_deletions`. server/deletion.js steps:
lockout → ads (pause + read back) → billing (Stripe canceled now + confirmed, customer deleted) → integrations → data →
verify; cron retries with backoff; admin status + retry; deleted ids never reused, left out of metrics ("Deleted
accounts" in /admin). Owner UI: Settings → Delete account (typed business name). Gate: ACCOUNT_DELETION_ENABLED
(unset in production; set only in the local e2e server). Guard test: every table with a customer column is erased or
documented as retained. Revoke now goes through googleApi() (mockable in e2e; production URL unchanged).
Tests: 349 unit, 70 Playwright (owner deletes in the browser; admin sees the record). Found + fixed in e2e: the admin
detail crashed for deleted rows (missing createdVia).
Next: 90-day cancellation recovery → Stripe ↔ records reconciliation.

## Permanent audit log (2026-11-14) — branch feature/audit-log (stacked on #24), NOT deployed

Migration 0015 `audit_log` (CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS only; the release test now exempts exactly the
pure `BEFORE UPDATE|DELETE … RAISE(ABORT)` guard triggers). Hash chain + append-only triggers; no personal data
(emails → refs). Producers: admin audit(), ad state changes, Stripe billing (status, cancellation scheduled/withdrawn,
payment failed/succeeded), website publish/unpublish/restore. Cron: daily chain verification checkpoint. Admin: Audit
log card (chain status, newest entries, JSON export); customer detail reads audit_log (falls back before 0015).
Apply 0015 before deploying (until then appendAudit logs `table_missing` and the action proceeds).

## Ads safety stop (2026-11-14) — branch feature/ads-billing-hold, NOT deployed

Defect: running campaigns kept running after a failed payment, an ended subscription, or an admin suspension (only
launch/resume checked billing). Fix (owner decision 2026-11-14): server/ads/holds.js derives a hold from records and
pauses every running campaign on its platform, then reads it back from Google; launch/Start refused (`ads_on_hold`).
Triggers: Stripe webhook (waitUntil after the receipt), admin suspend (inline; counts in audit + admin UI), cron sweep
every 5 min (retries). Billing holds only for billed businesses (PoolThru exempt). No migration. Tests: 333 unit
(+7), 69 Playwright (+1: admin suspension pauses a running test-account campaign; owner notice; Start refused;
reactivation restarts nothing). All Google calls mocked; no production Ads change. Compliance doc: open item 4 (confirm
the pause-only safety stop with Google before real spend).
Next: permanent audit log → deletion workflow (gated) → 90-day cancellation recovery → reconciliation → admin views.

## Released 2026-11-14: PRs #17, #18, #19 (merge commits 90e9057, be8224a, feb34f1)

Production deployment **14afca51** (feb34f1); intermediate a5b3c698 (#17), e5f794a1 (#18). Rollback target:
f0e4ebad (dcc15f1) via Cloudflare dashboard → Deployments → Rollback, or `git revert -m 1` of the three merges.
Before: combined suite 317/317 unit, 68/68 Playwright; main tree identical to the tested merge. After (read-only
production smoke): cancelled sign-in from /admin → /admin, from /dashboard/ads → /dashboard, external `next` → /dashboard;
/api/platform/me and /api/dashboard/me 401 signed out; PoolThru booking API 200 (160 slots, at_customer); homepage
sections incl. simulation, controls, labels, no unsupported live claims, honest meta; /admin shows the login error;
deployed admin code renders test-mode billing as "Test mode (no revenue)". Secret names unchanged; migration 0013 NOT
applied; no live billing, messaging or ads switched on. Not verified live: the signed-in admin metrics view (needs the
founder's Google sign-in).

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
Live/test is now recorded per subscription and payment (branch feature/billing-livemode, stacked on this one: migration
0013 `subscription_modes`, new table only; webhook stores `event.livemode`; live revenue counts live-marked records only;
missing table → webhooks still succeed, nothing counts). Apply 0013 on production (approval) before STRIPE_LIVE_ENABLED.
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
- Sign-in routing fix (2026-11-14, PR #17, NOT deployed): admins were sent to /dashboard customer onboarding unless
  they started at /admin; errors and deep links lost their destination. Now: admin-only → /admin from anywhere,
  /dashboard shows an admin notice, errors return to the starting area, dashboard deep links survive, "No platform
  access" links to the dashboard. Allowlisted destinations only.
- Ads review UX: DEPLOYED 2026-11-13 (dcc15f1, deployment f0e4ebad): one owner step "Approve and create (paused)" when the account
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

## 2026-11-15: customer journey gaps (draft PRs #32 → #33 → #34, stacked; NOT merged/deployed)

- #32 Owner notices (new booking / customer cancellation / lead unbooked after 10 min) + customers cancel and pick a
  new time from their email link. Migration 0018 (indexes, optional).
- #33 What customers should know (before-the-appointment + cancellation notes) on the booking page and in the
  confirmation / day-before reminder. Migration 0019 (public reads fail soft without it).
- #34 Resend delivery feedback: signed webhook; permanent bounce/complaint → address suppressed, owner asked to call.
  Migration 0020 + Resend endpoint + RESEND_WEBHOOK_SECRET (approval).
- Evidence: local only (verify:all 390 unit / 74 Playwright on #34's tip). Nothing live-verified yet.
- Next: approve merge/deploy in order #32, #33, #34 with migrations 0018–0020; then Stripe live + MESSAGES_LIVE
  per docs/LAUNCH_READINESS.md (PR #29).
