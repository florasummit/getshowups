# AI receptionist: how it works, activation, personal test

## What it is

One shared engine (`server/receptionist/`) answers customers of every eligible business in **website chat**
(`/chat/<business id>`, linked from the business website) and **browser voice** (same page, "Talk instead").

- **Model:** Claude Opus 5.5 through the Anthropic API, real inference. It uses the GetShowUps-paid key
  `RECEPTIONIST_ANTHROPIC_API_KEY`, a separate secret so receptionist spend is separate and setting it switches nothing else on.
  - Effort is `low` for conversational latency.
  - The per-business system prompt is cached.
  - No server-side model fallback (owner decision 2026-11-16).
  - Voice: when the model's first move is a calendar lookup or a booking and it has said nothing yet, a fixed holding
    line ("One moment while I check the calendar." / "One moment, please.") is armed the moment the tool call starts
    and spoken ONLY if `HOLD_AFTER_MS` (700 ms) pass without the answer's first words (a quick lookup plus a quick
    second model call is heard as a direct answer; a slow Google free/busy gets the line once, before the tool returns),
    so the caller doesn't talk over seconds of silence (lost turns are recorded as `turn:talked_over`). It is never an
    answer by itself (`model:no_reply` still applies). `RECEPTIONIST_VOICE_MODEL` can point voice at a faster model
    (approval; cost is still estimated at Opus prices, so caps stay conservative).
  - Direct answers: checks are silent. The prompt forbids "let me check / I'll verify / thank you for providing /
    please wait / one moment", and the narration filter (`sentenceProblem` → `narration`) drops such a sentence on its
    own, in voice before it is spoken and in chat before it is shown, while the rest of the answer still goes out
    (`blocked_narration` event; the model is corrected on the next turn). When a check confirms the area the reply
    states it ("Yes, we service West Ashley. What's going on with your pool?") and moves on.
  - Memory: everything said once is never asked again. Every turn carries a "Known so far" note: details saved by the
    tools, the place the area check resolved, and (without live owner rules) a deterministic reading of the customer's
    words (`server/intelligence/understand.js`, no model, no I/O): place, problem/service, day or part of day, with
    corrections ("actually it's Mount Pleasant") replacing the old value and flagged. With live owner rules the rules'
    turn note carries the same facts. Receptionist lines in the transcript carry the turn's timings (numbers only).
- **Knowledge:** only the business's records: services and prices, ZIPs, towns, hours, appointment mode, phone,
  "what customers should know" and the owner's receptionist notes. A generic industry playbook (pool, HVAC, plumbing,
  cleaning) shapes which questions to ask and what counts as urgent.
- **Tools, run on our server and bound to the conversation's business:**
  - `save_customer_details`: name, phone, email (optional), ZIP, address (visits at the customer), need. Checked
    deterministically (phone/ZIP digits must be in what the customer typed or said, spoken digits like "two nine four
    zero three" included; email must be typed) and kept in the conversation's state. Every turn tells the model what is
    already known, so nothing is asked twice; a value that fails a check gets a targeted re-ask of just that value;
  - `check_service_area {zip, place}` (one of them, the other empty): called the moment the customer says where they
    are, without demanding a ZIP. Resolution, authoritative sources only: a 5-digit ZIP → `areaFor` (the ZIP rule,
    unchanged: an exact listed ZIP, otherwise the service-area request path); a `place` (town, neighbourhood, street
    address, description) → served when the business has no ZIP list, or when the place is one of the owner's
    PUBLISHED fully served towns (Teach Your AI `coverage.cityWide`, only while rules are live for that business:
    basis `town_fully_served`, a ZIP is asked once with the booking details); a listed town that is not fully served →
    not resolved, the tool tells the model to ask exactly ONE clarification ("What part of Charleston?", or the ZIP when
    the place already names a part); anything else → not resolved, ask for the ZIP. It never claims coverage from
    closeness or from one listed ZIP, and never rejects a place: only a ZIP can be outside. "North Charleston" never
    matches "Charleston" (direction prefixes; the longest listed town wins). Booking validation is unchanged: a booking
    still records a ZIP and `areaFor` decides at booking, so a fully served town whose ZIP is not on the list still
    becomes a service-area request, never a booking;
  - `find_available_times`: real Google free/busy through `openSlots` (labels carry the time zone); the options are
    offered plainly ("I have Tuesday at 10 or Wednesday at 2. Does either work?"), never narrated;
  - `book_appointment {slot_id, confirmation_quote}`: uses the saved details; the existing `bookAppointment`, with its
    double-booking guard, Google event, confirmation and reminders. Email is optional (no email → no invitee, no
    confirmation email, `no_email`);
  - `request_callback {reason, urgent}` / `leave_message {message, urgent}` (migration 0027, `receptionist_requests`):
    a durable record the owner sees under **Needs attention**. One per kind per conversation (a repeat revises it).
- **People, honestly:** the receptionist cannot transfer anyone (no phone line is connected). Asked for a person, it
  says so and offers a callback request, a message, or booking. It never promises when someone will call or that
  anyone was notified. Owner notification is separate and tracked (`owner_callback` notice through the outbox):
  recorded → pending → sent | failed, or not_sent (`held`: nobody could be emailed, e.g. messaging test mode).
  Before 0027 the receptionist gives the business phone instead.
- **Guards the model can't bypass:**
  - only times this conversation was shown can be booked;
  - the customer's own confirming words must be in their latest message;
  - ZIP and phone (and the email, in chat) must come from what the customer said;
  - one booking and one lead per conversation, even when two turns land at once (the lead id is claimed on the
    conversation row before the lead is created);
  - out-of-area bookings are refused;
  - a $ amount not in the records, or a price said in words, is never shown or spoken (voice is checked sentence by
    sentence before it is spoken; the model is corrected on the next turn); a note that contradicts a listed price is
    flagged to the owner and the listed price wins (Settings are authoritative, notes supplement);
  - narration about tools or rules is never shown, and the owner's transcript shows only what the customer saw/heard;
  - cost caps: $1 per conversation and $5 per business per day (`RECEPTIONIST_DAILY_MICROS`);
  - 60 turns per conversation, plus rate limits.
- **Voice:** Retell handles speech recognition, the voice, turn-taking and interruptions. Our engine is Retell's
  *custom LLM*: GetShowUps creates each web call server-side (`RETELL_API_KEY`, `RETELL_AGENT_ID`) and records the call
  id. Retell then connects to `wss://getshowups.com/api/receptionist/llm/<secret>/<call_id>`, and that id alone routes the call.
  - A call continues the page's chat conversation (same record, no second greeting); typing during a call goes into
    the same conversation; replies stream sentence by sentence.
  - A turn the caller talked over is dropped unless it acted (booked / recorded a request), so the next turn hears
    the caller's words once.
  - Ending the conversation from the page ends the call. "Start a new conversation" starts a clean record.
- **Routing** (`routing.js`, provider-neutral): AI first, human first (AI on no-answer), or AI after hours. Web chat and
  browser voice are always AI. **Phone numbers, forwarding and transfers are not provisioned**; routing is unit-tested
  only (simulated).
- **CRM (GoHighLevel, existing connector):**
  - leads and bookings sync as before (contact, opportunity, stage);
  - the receptionist adds a note per booking and per hand-off (idempotent);
  - everything stays off unless `GHL_ENABLED=true` and the business has connected GHL.
- **Owner:** Dashboard → Receptionist.
  - Real statuses first: chat, browser voice, "Phone calls: no phone number connected yet", what happens when
    someone asks for a person.
  - Needs attention: callback requests/messages with how the team was (or wasn't) told; Mark done.
  - Conversations (Booked / Needs attention / Completed, customer name, channel), refreshed on focus and every 20 s.
    Each one: what was said and heard, what the receptionist did, cost.
  - Settings: on/off, greeting, notes (with conflict warnings). Phone routing and the transfer number sit under
    "Phone calls (not connected)", disabled, until a line exists. Nothing is ever dialed.
- **Data:** stored in `receptionist_*` tables (migrations 0026, 0027), kept 365 days (purged by the scheduler) and erased with
  the account. The privacy policy names Anthropic and Retell.

## Owner rules (Teach Your AI)

Owners can configure how the receptionist works (intake order, exclusions, fully served towns, urgent situations,
hand-offs, after hours, prices, tone) in Dashboard → Teach Your AI: `server/intelligence/`, docs/INTELLIGENCE_STUDIO.md.
Published rules reach conversations only for businesses in `AI_RULES_LIVE_BUSINESSES`; without that the engine is
exactly as described above. Rules add a short block to the cached system prompt, one deterministic note per turn (what
is known, the one thing to ask next) and extra tool guards; they never remove a platform guard.

## Customer-facing voice on every provider (2026-11-22, PR #117)

One routing layer, `server/voice/customer.js`, behind the public routes `POST /api/receptionist/:id/voice` (start),
`voice-connect` (reconnect: OpenAI re-mint / ElevenLabs new signed URL, ≤ 3 per session), `voice-tool` (every tool the
provider's model calls, run by our server bound to the session's business; dry run for admin tests, real for
customers) and `voice-session` (transcript batches, end). The provider is decided server-side from
`receptionist_voice_settings` (no row = Retell); the browser never chooses one. Each session is PINNED to the
provider it started with (`conv.state.voice.provider`), so an admin switch affects new sessions only. No fallback:
an active provider that cannot start answers a clear error (`voice_not_configured`, `voice_unavailable`,
`voice_busy`, `voice_limit`) and the customer keeps typing. Limits: 15 min per session, 3 concurrent sessions per
business (`RECEPTIONIST_VOICE_CONCURRENT`), 120 min per business per day (`RECEPTIONIST_VOICE_DAILY_MINUTES`),
600 min per provider per day platform-wide for OpenAI/ElevenLabs (`VOICE_PROVIDER_DAILY_MINUTES`), the public per-IP
rate limits; `VOICE_PROVIDERS_DISABLED` (comma list) is the emergency off switch per provider. The chat page
(src/receptionist/ChatPage.jsx) runs Retell's SDK or the shared adapters (src/voice/openai.js, elevenlabs.js) with the
customer routes; OpenAI's short-lived client secret and ElevenLabs' signed URL are the only credentials the browser sees.

**How a call ended is recorded** (2026-11-22, after three ElevenLabs test calls dropped with nothing to read): a session
that does not end cleanly ends with its failure code as the outcome AND a disconnect record (`state.voice.disconnect`,
`server/voice/sessions.js cleanDisconnect`): `phase` start | live | reconnect, `code`, the WebSocket `closeCode` (RFC
6455) and the provider's close `reason` as printable ASCII ≤ 120 chars. The ElevenLabs adapter derives it from the
SDK's `SessionConnectionError` / `onDisconnect` details (`disconnectInfo`: 1000 before the handshake →
`closed_before_start`, 1006 → `socket_closed`, 1008 → `provider_refused` (an override the agent does not allow, a
missing dynamic variable, an unauthorized agent, a plan limit — the reason text says which), 1009 → `payload_too_large`,
1011–1013 → `provider_error`, no code → `socket_error` / `connect_failed`; a handshake unanswered for 20 s →
`connect_timeout`, the page closing → `page_closed`). The end request is sent `keepalive` and on `pagehide`, so no
session stays open; an open `receptionist_calls` row counts at most the 15-minute ceiling toward the daily minutes. A
retry on the same conversation returns the conversation's token again and keeps the earlier attempt in
`state.voiceHistory` (console history: `<id>#n`). The chat page tells the caller what happened per code and keeps the
microphone; an admin test page also shows the record (`data-test-diag`); the Voice Lab's "Last test" line shows it in
words with the close code and reason, and `providerVerification` / rollout monitoring count it as a connection failure.

**Admin test sessions on the customer path**: `/chat/<id>?test=<provider>[&voice=<id>]` for a signed-in platform
admin on an admin-marked TEST business (server-checked; anyone else: 403): the real customer path with that provider,
dry-run tools, not gated by the Retell release list or the receptionist on/off switch. The chat page opens for that
test too (2026-11-22, `server/voice/testing.js adminTestAccess`, honoured by `GET /api/receptionist/<id>?test=<p>`):
a test business normally has its receptionist OFF for customers, which also hides the page ("Chat isn't available");
for the admin's `?test=` the page renders voice-only (`testOnly`, typed chat stays off, dry run, a way back to the
console) and for everyone else it stays unavailable with the refusal as a code (`test_not_allowed`,
`not_test_business`, `voice_not_configured`, `voice_unavailable`, `invalid_provider`), never a change for customers.
The console opens it without a hand-made URL (**Test <provider>**, `testPageFor`: the first eligible test business =
admin-marked, active, bookable, receptionist-on first; none → the reason). **Evidence**
(`providerEvidence`): a finished session (customer-path test or Lab) of the last 30 days on that provider for THIS
business whose adapter measured audio both ways (`micLive`, `audioReceived`) and whose availability + booking tools
both succeeded. Readiness states: active · ready (configured, on, evidence complete) · needs_test · not_configured ·
disabled. Activation (Select → Test now → Review checklist → Activate → Confirm) is refused without evidence.

## Cost controls and provider comparison (2026-11-22, no migration)

**Limits that refuse a start at the ceiling** (server/voice/budgets.js; enforced in `startCustomerVoiceSession` and
`startLabSession`; codes `voice_limit`, `test_limit`, `lab_daily_limit`; nothing queues): per provider per UTC day
platform-wide (`VOICE_PROVIDER_DAILY_MINUTES`, default 600 for OpenAI/ElevenLabs, or one provider's own
`VOICE_PROVIDER_DAILY_MINUTES_OPENAI | _ELEVENLABS | _RETELL`; Retell, the production path, is capped only when its own
switch is set), per TEST business per day (`VOICE_TEST_DAILY_MINUTES`, default 30: admin tests on the customer path +
Lab calls on that business; customer sessions never count), the Lab across admins (`VOICE_LAB_DAILY_MINUTES`, 60) and
every session of a business (`RECEPTIONIST_VOICE_DAILY_MINUTES`, 120). Minutes come from `receptionist_calls` rows; a
row never ended counts at most the 15-minute ceiling. The Voice Lab shows every budget with its state (ok · near the
limit at 80% · used up) and the switch that sets it (`budgetOverview`).

**Verified charges vs estimates** (server/voice/charges.js): `estimatedMicros` on a session is the public per-minute
price (server/voice/providers.js COST_ESTIMATES) and is labelled an estimate everywhere. A verified charge is the
provider's own record, fetched read-only on the admin's "Fetch verified charges" (POST voice-lab/session `charges`,
≤ 20 sessions per run, one business when given, audited `voice_lab.charges_fetched`) and stored on the session
(`state.voice.charge` / `state.lab.charge`): Retell `GET /v2/get-call/{call_id}` → `call_cost.combined_cost` in cents
(+ product lines); ElevenLabs `GET /v1/convai/conversations/{id}` → `metadata.cost` in credits and `cost_fiat` in USD
when ElevenLabs reports one (the conversation id is what the browser SDK reports on connect, recorded as
`providerSessionId` via session action `provider` / with the end). OpenAI keeps no per-session record for a project
key (the organization costs API needs an admin key): unsupported, said so. Credits are never converted to dollars; a
failed lookup is a code (`auth_failed`, `not_found`, `not_ended`, `no_cost_yet`, `http_<n>`, `unreachable`) and
retried after an hour, never a number.

**Balances** (`providerBalances`, only on "Check provider balances" → status `?balances=1`): ElevenLabs' subscription
read (`character_count` / `character_limit` = the plan's credits used and allowed this billing period, the pool Agents
conversations draw from, with the reset time); Retell has no balance endpoint (a 402 on call creation = credit balance
exhausted, code `voice_billing`); OpenAI exposes none to a project key. Nothing is monitored continuously.

**Providers compared** (server/voice/compare.js `providerComparison`, Voice Lab "Providers compared"): per provider from
the session records of the last 30 days, every kind (customer sessions, admin tests, Lab calls): sessions / finished,
connection failures (outcome or disconnect record) and rate, booking tool (bookings of sessions that reached the
availability lookup), response latency (lower median of the adapters' per-session medians; Retell's path does not
measure it), minutes, estimated cost, verified charges (USD where reported, credits otherwise), estimated cost per
finished session and per booking (verified per booking only when every finished session carries a verified USD
charge). Connection failures and incomplete bookings (no tool ran · times offered but no booking) sit under disclosure
as codes with the WebSocket close code when there is one.

**Live checks without a browser**: `node scripts/voice-live-check.mjs openai|elevenlabs` runs ONE bounded session
against the real provider through the same server functions (in-memory D1, Google mocked, keys from Keychain, caller =
synthesized speech), prints greeting/answers/tools/audio bytes/latency/cost and whether it counts as evidence. It
proves the integration, not a human's listening experience; a human microphone test is still the final word on quality.

## Voice management (2026-11-22, migration 0035)

**Principle: customers choose the voice experience; GetShowUps manages the technology.**

- **Owner (Dashboard → Receptionist → "Receptionist voice")**: a voice from the ACTIVE provider's catalog (with the
  provider's own public preview samples, played one at a time and labelled as samples), a personality preset
  (Balanced = today's manner, Warm & Friendly, Professional & Polished, Calm & Reassuring, Upbeat & Energetic: fixed
  prompt wording in `server/voice/style.js`, style only; facts, prices, area, booking guards and tools are untouched)
  and a speaking pace where the provider supports it (Retell `voice_speed`, ElevenLabs `speed`; OpenAI: control
  disabled with the reason). Language: English only today (shown, not editable). Owners never see a provider name.
  Saves carry a `version` (409 `stale`, never a silent overwrite); every save is a `receptionist.voice` event.
- **Catalog (`server/voice/catalog.js`)**: Retell `GET /list-voices` (gender/accent/age as Retell states them,
  `preview_audio_url`), ElevenLabs `GET /v2/voices` (labels, `preview_url`), OpenAI = the documented ten voices
  (no metadata, no samples). Cached in `voice_catalog_cache` for 24 h; a provider failure serves the last list as
  stale; nothing is inferred from a name; only https sample URLs are offered; a stored voice id must be in the list.
- **Where it applies**: Retell customer calls and Lab calls send `agent_override.agent.{voice_id, voice_speed}` on
  `create-web-call` (one shared agent, per-business voice; verified live 2026-11-22: the API accepts the shape; the
  audible result is confirmed in a joined Lab call). ElevenLabs sessions send `tts.{voice_id, speed}` overrides
  (enabled on the agent by `scripts/elevenlabs-setup.mjs`). OpenAI sessions take the voice. The Lab lets an admin
  pick a candidate voice of any provider (validated against the catalog) to test before a switch.
- **Provider (admin only, `server/voice/settings.js`)**: the business's provider for customer-facing voice is stored
  in `receptionist_voice_settings.provider` (no row = Retell = today). The control under Receptionist is rendered
  only for platform admins (server-checked on every action; membership never grants it). Capabilities are stated
  from the code AND from evidence: every provider has the customer-facing browser path (PR #117); a provider may be
  ACTIVATED for a business only with a verified test session on it (see above); NO provider has phone routing (no
  numbers, routing.js is simulated). Switching runs a checklist (configured, live-capable, business active, phone routing n/a, tools,
  voice valid or explicitly the provider default — a voice is never substituted silently, booking ready, a finished
  session on that provider in the last 30 days), shows the consequences, requires `confirm: true` and the current
  version, writes once (atomic conditional update), keeps the previous provider/voice/pace for a one-click rollback,
  and audits `receptionist.provider_switched` / `_switch_blocked` / `_rolled_back` (admin_audit + audit_log). A
  blocked switch changes nothing. Calls in progress stay on the provider that created them (the route only affects
  new calls). Live telephone switching does not exist and is not claimed.
- **Admin Console entry point (`/admin/voice-lab` → Businesses; the former `/admin/voice-providers` address lands there, 2026-11-22)**: the dashboard control needs the admin to be a
  member of the business (one business per member email), so the console carries the same control for ANY business.
  `GET /api/platform/voice-provider` lists businesses (name, id, test mark, receptionist on/off, provider; deleted ones
  excluded); `?customer=<id>` answers the business facts, the stored configuration, `providerOverview` (the same
  states, evidence and blockers the dashboard shows) and the voice-session history (`voiceSessionHistory`: provider,
  kind admin test | Lab | customer, timing, the adapter's audio evidence, tool outcomes, outcome code, cost estimate,
  whether it counts as evidence; codes only, never a transcript or a customer's details); `&catalog=<provider>` the
  replacement-voice list. `POST { action: check | switch | rollback, customer, … }` calls `checkProviderSwitch` /
  `switchProvider` / `rollbackProvider` unchanged (readiness, blockers, `confirm`, version, one write, audit, rollback)
  and, for switch and rollback, requires the business id typed back (`confirmCustomer` = `customer`, else 400
  `confirm_customer_mismatch` before anything is checked or audited). Platform admins only (`requirePlatformAdmin`,
  same-origin writes, `voiceProviderAdmin` rate limit); business membership is neither required nor consulted; the
  dashboard's tenant authorization is unchanged. The UI (src/admin/Businesses.jsx) names the selected business
  (name, id, Test / Live badge) on the page and again in the typed confirmation; `ProviderControl`
  (src/dashboard/ProviderControl.jsx) is the one component behind both places. Test now links to
  `/chat/<id>?test=<provider>` (test businesses only, as before).

## Global default provider (2026-11-22, migration 0036)

The provider a business's customer-facing browser voice uses is resolved as **explicit business override → global
default → Retell** (`server/voice/style.js getVoiceSettings`, one read: settings row + inherit flag + newest
`receptionist_voice_defaults` version). Storage: `receptionist_voice_defaults` (append-only history of the platform
default: version, provider, previous, mode all | staged | rollback, the businesses the version pinned and the rows it
moved; NO row = Retell, backward compatible) and `receptionist_voice_inherit` (presence = this business's settings row
exists only because the owner chose a voice/personality/pace, so it FOLLOWS the default; a settings row without it is an
explicit override, which is what every admin switch writes; a business without any row follows too). Owner saves never
change inheritance; `switchProvider` makes an override; `rollbackProvider` returns to following only if the business
followed before and the default still is that provider.

**One action for every business that follows the default** (`server/voice/global.js`, console section "Global voice
provider", `POST /api/platform/voice-provider` actions `global_check` | `global_switch` | `global_rollback`, platform
admins only, provider id typed back as `confirmProvider`, global version carried, 409 stale): the checklist runs the
platform checks (configured, customer path, not switched off, a real change, ≤ 200 businesses) and then EVERY inherited
business through `checkProviderSwitch` on the new provider (eligible, booking ready, a voice chosen on this provider
valid or no voice, VERIFIED by a finished test session on that business). Mode `all` is refused while any business is
blocked; mode `staged` switches the verified ones (their settings row, if any, moves to the new provider), PINS the
blocked ones to the provider they have today (an explicit override, listed by name with blockers, audited
`receptionist.provider_pinned`) and leaves explicit overrides untouched; businesses created later follow the new
default. The UI reports exactly those counts; it never claims the switch applied to everyone. Sessions in progress stay
on the provider they started with (pinned per session). Global rollback (`receptionist.global_provider_rolled_back`)
inserts a new version with the previous provider, un-pins the businesses the rolled-back version pinned (if unchanged
since), moves rows it moved back (if unchanged, or if no voice was chosen on the new provider meanwhile; a business
whose owner chose a voice on the new provider is kept there as an override and reported), and cannot itself be rolled
back. Production (2026-11-22): no defaults row, so the default is Retell until a platform admin selects and confirms
another provider in the console.

### Promote to 100% (2026-11-22, no migration)

A staged rollout leaves unverified businesses pinned; `Promote <provider> to 100%` (console, `server/voice/global.js`
`checkGlobalPromotion` / `promoteGlobalProvider`, `POST /api/platform/voice-provider` actions `global_promote_check` |
`global_promote`, provider typed back, global version carried) releases them in ONE action. Evidence is split in two:

- **Provider-level verification** (`providerVerification`): a finished session on the PRODUCTION path (customer-facing
  voice, admin test or real customer; Voice Lab sessions never count) on the target in the last 30 days with audio both
  ways, the availability and booking tools succeeding through our server (a simulated booking on a test business
  counts) and a clean end (no connection outcome). Performed on a designated test business
  (`/chat/<test business>?test=<provider>`, opened from the console's **Test <provider>** action), it stands for the
  provider, never for a business's own test. `globalOverview` carries this record (`verification`) and the test page
  (`testPage`) so the console can show the state and the one next action without a click.
- **Business-level compatibility**, automated for every business in scope: the per-business checklist minus the
  evidence (configuration, customer path, switched off, eligibility, the seven tools, a voice chosen on this provider
  valid in its catalog or no voice, booking readiness). A voice chosen on another provider, a missing catalog entry,
  missing credentials, a switched-off provider block (never bypassed); a missing per-business test session is the
  `unverified` WARNING the admin acknowledges explicitly (`acknowledgeUnverified: true`; the audit records the count;
  nobody is reported as individually tested); booking not ready / receptionist off are warnings the promotion does not
  change. ANY blocker refuses the whole promotion (all or nothing, blockers by name).

Scope: every business that follows the default plus every **rollout pin** (`pinOrigins`: an override on the provider
a version pinned it to, no admin switch since; the version's `pinned[]` entries carry `provider`), deliberate overrides
only with `includeOverrides` (shown as untouched otherwise, their previous provider kept for the rollback), suspended
businesses excluded (one that follows the default follows the new default when reactivated). Released pins and
replaced overrides get an inherit row: they FOLLOW the default again, no permanent override is created on the new
provider. The new version (mode `all`) records `switched[] = { customer, version, from, kind: inherited | pin | override }`.
The batch is guarded: the defaults row is inserted first with `provider = CASE WHEN every in-scope business still has
the settings version and inheritance the checklist saw THEN … ELSE NULL`, so a business changed under the checklist
makes the whole batch roll back (nothing applied, `stale`). Audits: `receptionist.global_provider_promoted` (counts,
acknowledged count), `receptionist.provider_promoted` per business, `receptionist.global_promotion_blocked`.
Rollback (`global_rollback`, same guard) restores the previous default, moved rows, released pins (still recognisable
as pins) and replaced overrides, keeps a business whose owner chose a voice on the new provider meanwhile (reported),
and cannot restore conversations already held or provider charges. Rollout status (`globalRolloutStatus`, console):
sessions on the current default since its version (newest 500), businesses, connection failures (session outcomes),
tool and booking failures (the engine's tool outcomes), minutes and the cost estimate; anything the records cannot give
is shown as unavailable. Production (2026-11-22): default ElevenLabs version 1 (staged) with 6 pins on Retell; the
deployment changed nothing; the promotion is the human admin's action after an ElevenLabs production-path test.

## Location policy (2026-11-22)

The receptionist answers questions about services, prices, hours and how soon it can usually come without asking
where the customer is. Location comes up only when it is needed: the customer asks whether the business serves them,
wants a visit or a time, or booking details are being collected. A town or neighbourhood is accepted as context
(`check_service_area` with `place`; coverage is never claimed from it: the tool decides, and the backend ZIP rule
decides again at booking). If the customer declines, defers or doesn't know their ZIP ("I'd rather not", "why do you
need that?", "later" right after a ZIP question), the engine remembers it (`state.zipDeferred`, deterministic, no
model) and every later note says so: not asked again; when they want a visit booked, the ZIP is named once as what is
needed to confirm the area and book, or a service-area request is offered. Provider paths (OpenAI Realtime,
ElevenLabs) get the same memory through the shared tool runner and the `save_customer_details` result
(`zip_deferred`). Nothing changes in the booking guards, the service-area configuration or the OpenAI audio path (the
instructions are a few lines longer; they are built once per session).

## Activation (each step needs approval)

1. **Migration 0026** (4 additive tables):
   `npx wrangler d1 execute getshowups-onboarding --remote --file migrations/0026_receptionist.sql` (applied)
   **Migration 0027** (1 additive table, `receptionist_requests`; apply before deploying the callback build; until
   then callbacks are not offered and the phone number is given instead):
   `npx wrangler d1 execute getshowups-onboarding --remote --file migrations/0027_receptionist_requests.sql`
2. **Model key** (paid usage): create an Anthropic API key (console.anthropic.com → API keys), then store it the same
   way as the other secrets, so it is never shown:
   ```
   security add-generic-password -a getshowups -s getshowups-receptionist-anthropic-key -w
   security find-generic-password -a getshowups -s getshowups-receptionist-anthropic-key -w | npx wrangler pages secret put RECEPTIONIST_ANTHROPIC_API_KEY --project-name getshowups
   ```
   Estimated cost: about $0.01–0.03 per customer message on Claude Opus 5.5 with prompt caching, capped at $5 per
   business per day.
3. **Voice** (paid usage when calls are made): Retell account (retellai.com). The dashboard only offers Single-Prompt /
   Conversational Flow agents; a **Custom LLM** agent is created through Retell's API by `scripts/retell-setup.mjs`
   (`POST /create-agent` with `response_engine: { type: 'custom-llm', llm_websocket_url }`).
   - Retell sends no authentication on the LLM WebSocket, so the agent's URL carries a secret path segment:
     `wss://getshowups.com/api/receptionist/llm/<RETELL_WS_SECRET>`. Retell appends the call id; the server checks the
     secret, then routes only by a call id it created. Optional `RETELL_WS_IPS` (Retell documents 100.20.5.228)
     restricts the source IP.
   - Store the Retell API key (dashboard → API Keys) in Keychain: `security add-generic-password -a getshowups -s getshowups-retell-api-key -w`.
   - Setup (dry run first; `--apply` creates once or updates the draft; never publishes, calls or buys):
     ```
     S=$(openssl rand -hex 32)
     printf %s "$S" | npx wrangler pages secret put RETELL_WS_SECRET --project-name getshowups
     { security find-generic-password -a getshowups -s getshowups-retell-api-key -w; printf '%s\n' "$S"; } | node scripts/retell-setup.mjs --apply
     unset S
     security find-generic-password -a getshowups -s getshowups-retell-api-key -w | npx wrangler pages secret put RETELL_API_KEY --project-name getshowups
     printf %s agent_… | npx wrangler pages secret put RETELL_AGENT_ID --project-name getshowups
     ```
     Re-running rotates the socket secret (both places are updated together).
   - Web calls use `agent_version: 'latest'` (the draft); set `RETELL_AGENT_VERSION` after publishing a version.
   - **Cost:** roughly $0.07–0.15 per minute of calls (Retell platform plus voice; check your plan). Creating the agent
     is free. Model cost as above.
4. **Deploy** production (new secrets apply to the next deployment).

Kill switch: `RECEPTIONIST_ENABLED=false` hides chat and voice everywhere. Owners can also switch their own off.

Voice release gate (2026-11-19): voice is offered only to businesses listed in `RECEPTIONIST_VOICE_BUSINESSES`
(comma-separated ids, no wildcard; empty = nobody). Others see "voice is in testing"; chat is unaffected. Details and
the proposed Retell settings: docs/COMMS_RELIABILITY.md and "Latency: where the time goes" below.

## Latency: where the time goes (Retell voice path, 2026-11-21)

One caller turn travels: caller stops speaking → Retell end-of-turn detection → `response_required` frame over the
WebSocket → our handler (`attachRetellSocket` → `respond`) → D1 reads → first model call (Claude, streaming) → tool
(Google free/busy or a booking) → second model call → sentences streamed back → Retell TTS → audio. Only the middle of
that chain runs on our side; what we can measure without a real call is exactly that middle, with the model mocked.

**Measured locally (mocked model, in-memory SQLite as D1; `VOICE_BENCH=1 VOICE_BENCH_N=40 node --test
test/voice-reliability.test.js`, 2026-11-21).** These are our own overhead, not Retell's and not Claude's:

| What | Number |
| --- | --- |
| Work before the model request leaves (D1 reads, prompt build, SDK) | P50 3 ms, P95 5 ms |
| Model first token → first whole sentence handed to Retell | P50 6 ms |
| Total overhead over the model's first token until the first chunk reaches Retell | P50 9 ms, P95 11 ms, max 24 ms |
| D1 statements per voice turn | 7 (plain answer), 9 (calendar lookup: + availability record and tool event) |
| Cached system prompt / tools JSON | ≈5.5k chars (≈1.4k tokens) / ≈4.5k chars (≈1.1k tokens) |
| Whole turn with a zero-latency model | ≈55 ms (40 ms of it is the mock's first token) |

Event rows are now written off the critical path (settled before the save, never awaited one by one between the model
and its tools). In production each D1 statement is a network round trip (not measured here), so the 7–9 statements
per turn are the one part of our overhead that grows outside the harness.

**Cannot be measured without a real call** (no numbers are claimed): Retell's end-of-turn delay (speech recognition
`stt_mode`, endpointing, `responsiveness`), the WebSocket hop, Claude's time to first token for Opus 5.5 at effort
`low` with a ≈2.5k-token cached prefix plus history, Google free/busy latency, and Retell's TTS start. Per-turn
numbers for all of this are recorded for every real call as `voice_turn` events (`q` queue wait, `tok` model first
token, `first` first chunk to Retell, `hold` holding line or -1, `total`, `model`, `tools`, `calls`), and the owner's
transcript lines carry `firstTokenMs / firstTextMs / holdMs / toolMs / modelMs / modelCalls / totalMs`. The first real
calls with these events are the measurement.

**Where to expect the time, from the design:** (1) Claude's first token on each model call: a tool turn has two of
them (one before, one after the tool); the holding line covers the gap only when it exceeds 700 ms. (2) Google
free/busy (8 s timeout) inside `find_available_times`. (3) Retell end-of-turn detection before the frame even reaches
us. (4) D1 round trips (7–9 per turn). Levers, in order: `RECEPTIONIST_VOICE_MODEL` (a smaller current-generation model
for voice turns; approval, cost still estimated at Opus prices), keep effort `low` (Opus 5.5 cannot switch thinking
off; effort is the only control), the Retell agent profile below, and fewer D1 reads per turn (knowledge is re-read
every turn; a per-call cache would remove several statements but is not done here).

**Proposed Retell agent profile (test agent only; unmeasured):** `scripts/retell-setup.mjs --tuned` sends
`TUNED_SETTINGS` (responsiveness 1, interruption_sensitivity 0.8, backchannel off, stt_mode fast, background-speech
denoising, reminders 10 s × 2, end call after 60 s of silence, 15 min max, PII-free storage kept 30 days, signed URLs).
Retell has no separate end-of-turn field: end-of-turn is `responsiveness` + the STT endpointing
(`--endpointing-ms <n>` → `custom_stt_config` with Deepgram, 10–3000 ms) + `interruption_sensitivity`. `--tuned` is
refused for the live agent: it needs `--test-agent "<name>"`, which creates or updates a second agent with its own name
(same engine URL, same secret), so defaults and profile can be compared call for call. Nothing is sent without
`--apply`; nothing is published. Not run; approval needed (paid voice usage):

```
{ security find-generic-password -a getshowups -s getshowups-retell-api-key -w; printf '%s\n' "$RETELL_WS_SECRET"; } \
  | node scripts/retell-setup.mjs --tuned --test-agent "GetShowUps receptionist (test)"            # dry run
{ …same stdin… } | node scripts/retell-setup.mjs --tuned --test-agent "GetShowUps receptionist (test)" --apply
{ …same stdin… } | node scripts/retell-setup.mjs --tuned --test-agent "GetShowUps receptionist (test)" --endpointing-ms 300 --apply
```

Pointing a test business's calls at the test agent needs a way to choose the agent per business (today one
`RETELL_AGENT_ID`); that is not built here.

## Personal end-to-end test (after activation)

You, as a new business owner (Stripe stays in sandbox):

1. https://getshowups.com/dashboard?plan=founding → sign in with Google → create "<Your> Test Pools" →
   pay with Stripe test card `4242 4242 4242 4242` (any future date and CVC). This is a sandbox subscription; no real charge.
2. Onboarding: services and prices (e.g. "Weekly pool cleaning $160/month"), ZIP codes, hours, appointment mode,
   Google Calendar connect, website publish (add a contact section if you like).
3. Dashboard → Receptionist → tick "Answer customers…", add approved answers, Save → "Try it as a customer".
4. In a private window: open your website (`/p/<id>`), then "Chat or talk with us":
   - ask about services and prices, challenge them, change your mind;
   - give your ZIP, ask for times, give your name, phone and email, then confirm with "yes, book it";
   - "Talk instead": the same over voice (interrupt it, ask for a person, ask for pricing, book).
5. Check Google Calendar (the event, with you invited), Dashboard → Appointments, and Dashboard → Receptionist (the
   transcript, the actions, the outcome).
6. Emails: production is in test mode (`MESSAGES_LIVE` off), so confirmations go only to `MESSAGE_TEST_RECIPIENTS`.
   Use an address on that list as the customer email to receive them.

## Quality evaluation

`test/fixtures/receptionist-scenarios.js`: 106 scenarios: 100 (pool, HVAC, plumbing, cleaning × 25) covering bookings,
corrections, price objections, emergencies, frustration, unclear needs, wrong assumptions, unavailable and invented
times, double booking, out of area, human requests, outages, prompt injection and cross-tenant attempts, plus 6
conversation-quality scenarios (pool, with West Ashley published as fully served): direct coverage answer, ambiguous
city → one clarification, no unnecessary ZIP request, no narration, memory across one message, a correction.

- **Simulated (free, in CI):** `test/receptionist-eval.test.js` runs all 106 scenarios against an adversarial model that
  attacks on every turn. It requires 0 unauthorized bookings, 0 unoffered times shown, 0 invented prices shown and 0
  cross-tenant exposure. This measures the guards, not conversation quality.
- **Real model (paid, approval):** `ANTHROPIC_API_KEY=… node scripts/receptionist-eval.mjs --real --yes-spend` measures
  booking success, escalation, factual accuracy, latency and cost per scenario, and the quality counters
  (`narration_shown`, `zip_asked_unnecessarily`, `clarification_missing/repeated`, `coverage_claimed`,
  `coverage_not_stated`, `reasked_location/problem/day`). Estimated $3–10 for all 106.
