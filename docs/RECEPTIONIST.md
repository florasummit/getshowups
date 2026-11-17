# AI receptionist: how it works, activation, personal test

## What it is

One shared engine (`server/receptionist/`) answers customers of every eligible business in **website chat**
(`/chat/<business id>`, linked from the business website) and **browser voice** (same page, "Talk instead").

- **Model:** Claude Opus 5.5 through the Anthropic API, real inference. It uses the GetShowUps-paid key
  `RECEPTIONIST_ANTHROPIC_API_KEY`, a separate secret so receptionist spend is separate and setting it switches nothing else on.
  - Effort is `low` for conversational latency.
  - The per-business system prompt is cached.
  - No server-side model fallback (owner decision 2026-11-16).
- **Knowledge:** only the business's records: services and prices, ZIPs, towns, hours, appointment mode, phone,
  "what customers should know" and the owner's receptionist notes. A generic industry playbook (pool, HVAC, plumbing,
  cleaning) shapes which questions to ask and what counts as urgent.
- **Tools, run on our server and bound to the conversation's business:**
  - `save_customer_details`: name, phone, email (optional), ZIP, address (visits at the customer), need. Checked
    deterministically (phone/ZIP digits must be in what the customer typed or said, spoken digits like "two nine four
    zero three" included; email must be typed) and kept in the conversation's state. Every turn tells the model what is
    already known, so nothing is asked twice; a value that fails a check gets a targeted re-ask of just that value;
  - `check_service_area`;
  - `find_available_times`: real Google free/busy through `openSlots` (labels carry the time zone);
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

`test/fixtures/receptionist-scenarios.js`: 100 scenarios (pool, HVAC, plumbing, cleaning × 25) covering bookings,
corrections, price objections, emergencies, frustration, unclear needs, wrong assumptions, unavailable and invented
times, double booking, out of area, human requests, outages, prompt injection and cross-tenant attempts.

- **Simulated (free, in CI):** `test/receptionist-eval.test.js` runs all 100 scenarios against an adversarial model that
  attacks on every turn. It requires 0 unauthorized bookings, 0 unoffered times shown, 0 invented prices shown and 0
  cross-tenant exposure. This measures the guards, not conversation quality.
- **Real model (paid, approval):** `ANTHROPIC_API_KEY=… node scripts/receptionist-eval.mjs --real --yes-spend` measures
  booking success, escalation, factual accuracy, latency and cost per scenario. Estimated $3–10 for all 100.
