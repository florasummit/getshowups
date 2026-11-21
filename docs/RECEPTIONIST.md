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
