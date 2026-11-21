# Voice Lab: putting the receptionist on a voice call, provider by provider

`/admin/voice-lab` (platform admins only; every request is authorized server-side). The Lab runs the SAME
receptionist (server/receptionist/engine.js: knowledge from records, tools bound to one business, every guard) on a
voice call through a provider, against an admin-marked TEST business, dry-run by default, and shows honestly what
happened. It exists to compare providers on realistic calls before any customer hears one. Nothing in it changes a
customer's account, a customer route or the production Retell agent.

Code: src/admin/VoiceLab.jsx (+ voice-lab.css, the Control Center's tokens), server/voice/ (providers = status and
cost estimates, sessions = Lab sessions on the existing receptionist tables, tools = the provider-independent tool
runner with dry-run), functions/api/platform/voice-lab/ (status GET; session + tool POST, same-origin, audited),
src/voice/<provider>.js (browser adapters), server/voice/scenarios.js + scripts/voice-bench.mjs (simulated benchmark).

## Gates and flags (all off unless set; each needs approval)

| Flag / secret | Effect |
| --- | --- |
| `VOICE_LAB_ENABLED=true` | The Lab exists: tab content and `/api/platform/voice-lab/*`. Anything else → 404 everywhere; the tab says "switched off". |
| `VOICE_LAB_DAILY_MINUTES` | Minutes of provider time per UTC day across all admins (default 60, max 600). Counted from `receptionist_calls` rows of Lab conversations; a session cannot start once it is used up (`lab_daily_limit`). |
| `OPENAI_API_KEY` (+ optional `OPENAI_REALTIME_MODEL`) | OpenAI Realtime configured (Agent D's adapter and route; see its section below). |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | ElevenLabs configured (Agent E's adapter and route). |
| `RETELL_API_KEY` + `RETELL_AGENT_ID` + `RETELL_WS_SECRET` | Retell configured: the production browser voice. The Lab never creates a second Retell path. |

What is always true, whatever the flags: a session starts only for a business in `test_businesses` (never a real
customer, `not_test_business`), only for a configured provider (`<provider>_not_configured`, 409), only by a platform
admin, and it is audited (`voice_lab.session_started` / `voice_lab.session_ended`). Provider keys never reach the
browser: the status route returns booleans and reason codes, the provider routes issue short-lived connection details.

## Dry run

On by default. Every tool runs with every guard (digits must have been said, only offered times can be booked, the
caller's own confirming words, one booking per conversation, area check) but nothing is created: no lead, appointment,
request, coverage row or email. Results carry `simulated: true` and the Lab tags them. Turning dry run off shows a
warning: a confirmed booking then creates a REAL appointment on the test business's calendar and sends its
confirmation (messages still obey the launch gate; test businesses only reach `MESSAGE_TEST_RECIPIENTS`).

## Using it

1. Pick a provider. Each card shows "Configured" or "Unavailable: not configured (which variables)". Start is disabled
   until the provider is configured AND its adapter is in this build.
2. Pick the test business (only businesses the server lists), keep dry run on, press Start. The browser asks for the
   microphone first; a blocked microphone is reported before any session exists.
3. Talk. The transcript, tool results (name, ok/error code, simulated tag, ms) and connection state are what the
   adapter reports. Stop ends the session: the transcript is stored as text on the conversation, the adapter's metrics
   are saved (numbers only), and the engine's summary is shown (outcome, booked/simulated, estimated cost).
4. Retell: "Open browser voice test" opens the public chat page of the test business (`/chat/<id>`) in a new tab, the
   production path. Metrics for Retell come from the engine's recorded events (`voice_turn` timings, tool outcomes),
   not from this browser. The Talk button appears there only for businesses in `RECEPTIONIST_VOICE_BUSINESSES`.

Recent sessions list provider, business, outcome, booked/simulated, duration and the saved metrics.

## Reading the metrics

- **First / median / p95 response**: measured by the adapter in the browser, from the end of the caller's speech to
  the first audio of the reply. These are the only latency numbers that mean anything for voice; the Lab labels where
  they came from. "—" means the adapter didn't report them.
- **Turns, interruptions, tool calls / failures, reconnects**: counted by the adapter; tool outcomes are also in
  `receptionist_events` (codes only).
- **Usage and estimated cost**: `estimatedMicros` = duration × the provider's per-minute ESTIMATE in
  server/voice/providers.js `COST_ESTIMATES` (price list + date recorded by the provider agent). Shown as "estimate,
  <source>"; "Not estimated" when the provider has no entry. Never presented as measured spend.
- **Outcome**: the engine's own record (booked / coverage request / callback / message / info), never the model's claim.

## The simulated benchmark (no audio, no provider, no network)

```
node scripts/voice-bench.mjs                      # scripted stand-in model: accuracy + repeated questions
node scripts/voice-bench.mjs --model adversarial  # a model that tries every violation: the guards must hold
node scripts/voice-bench.mjs --model both --only safety --json
node --test test/voice-bench.test.js              # the same runs as a test (invariants + every expectation)
```

`server/voice/scenarios.js` holds 46 realistic home-service calls (pool, HVAC, plumbing; the business visits the
customer) in 22 categories, including every required one: simple yes, "Charleston" (a city only partly covered → one
clarifying question), West Ashley (a listed town → accepted plainly), missing ZIP, full address, unsupported location,
caller interruption, caller correction, details out of order, accent (spoken digits, fillers, spelled names),
background noise (garbled fragments), unavailable time, duplicate booking, human hand-off, safety-sensitive equipment
(gas smell, sparking pump, burst pipe), plus prices, hours, cross-tenant, prompt injection, no confirmation, calendar
outage. Each line carries what a competent listener would extract from it; the ENGINE still verifies every digit
against the words, so a hint that isn't in the line is refused.

The runner drives each call through the real `respond()` text path (every migration in an in-memory D1, real tools and
booking code, fake Google Calendar with odd UTC hours busy) and reports, clearly labelled **SIMULATED**:

- booking accuracy: booked when expected, unauthorized bookings, bookings without a yes, duplicates;
- coverage accuracy: served / clarify / decline as expected (from the engine's state, not the words);
- repeated-question frequency: a reply asking for a detail the engine already held (a recheck of an unverified digit
  string doesn't count);
- tool calls, infrastructure failures vs guard refusals;
- hallucinated commitments that reached the caller: prices not in the records, times never offered, "someone will call";
- cross-tenant leaks (another tenant's price in a reply, or a lead/appointment on another business);
- hand-offs recorded (and urgent), interruptions dropped without acting;
- engine-side timings per caller turn (tool code + fake Google; the stand-in model answers instantly). These are NOT
  audio latency and are not presented as such.

Result on 2026-11-21 (`node scripts/voice-bench.mjs --model both`): scripted 46/46, 25/25 expected bookings made,
0 unauthorized, 0 without a yes, 0 duplicates, coverage 46/46, repeated questions 0/32, 0 invented prices/times/
promises, 0 leaks, 6/6 hand-offs (3/3 urgent), 2/2 interruptions dropped, engine turn p50 5 ms / p95 55 ms;
adversarial: 239 guard refusals, 0 violations of any invariant. What the scripted model proves is the ENGINE's state
tracking and guards, not model quality: a real model can still phrase things badly, and nothing here measures speech.

What the benchmark cannot see (needs provider credentials and a human caller in the Lab): speech recognition on
accents and noise, turn-taking and barge-in, real response latency, voice quality, provider cost. The scenarios are
written to be read aloud by a tester for exactly that.

## Provider sections

Added by the provider agents (OpenAI Realtime: Agent D; ElevenLabs: Agent E): connection flow, what their route
issues, how tools are forwarded to `/api/platform/voice-lab/tool`, the metrics their adapter measures, the price
estimate source, and known limits.
