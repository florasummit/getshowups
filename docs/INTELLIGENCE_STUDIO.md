# Business Intelligence Studio ("Teach Your AI")

GetShowUps owns the business intelligence; Retell executes the voice experience; businesses control their operating
workflows. Code: `server/intelligence/` (engine), `functions/api/dashboard/ai-rules.js` (owner API),
`src/dashboard/TeachAI.jsx` (owner UI), migration `0033_ai_rules.sql`. Status (2026-11-22): migration applied; **owner
editing is on for every eligible business** (server/eligibility.js, no allowlist; `AI_STUDIO_ENABLED=false` switches it
off); **live use for nobody** (`AI_RULES_LIVE_BUSINESSES` empty).

## 1. Verified Retell architecture (Phase 0 audit, 2026-11-20)

Read from `server/receptionist/voice.js`, `functions/api/receptionist/llm/[secret]/[call].js`, `scripts/retell-setup.mjs`,
`docs/RECEPTIONIST.md`, migrations 0026–0027 and the production bindings (names only, never values).

| Question | Answer |
| --- | --- |
| Agent type | **One shared Custom-LLM agent** (`response_engine: custom-llm`), created by `scripts/retell-setup.mjs`. Not Single-Prompt, Multi-Prompt or Conversation Flow. |
| Agent ↔ business | The agent knows no business. Our server creates each web call (`POST /v3/create-web-call`, `metadata.business`), stores the `call_id` in `receptionist_calls`, and Retell connects back to `wss://getshowups.com/api/receptionist/llm/<RETELL_WS_SECRET>/<call_id>`. The call id (ours, unguessable) is the only routing input. |
| Prompts | Generated per business per turn by **our** engine (`server/receptionist/knowledge.js systemPrompt`, cached); nothing is stored at Retell. |
| Agent changes / versions | Only `scripts/retell-setup.mjs --apply` (dry run by default; updates the DRAFT; never publishes). Calls use `agent_version: 'latest'` unless `RETELL_AGENT_VERSION` is set. |
| Dynamic variables | Not used (no need: the prompt is ours). |
| Custom functions | None at Retell. Tools (`save_customer_details`, `check_service_area`, `request_coverage`, `find_available_times`, `book_appointment`, `request_callback`, `leave_message`) run in our engine, bound to the conversation's business. |
| Calls that reach our backend | `POST /api/receptionist/:customer/voice` (browser → us → Retell), the LLM WebSocket (Retell → us), and nothing else. No Retell webhooks are registered. |
| Webhook auth / idempotency | The socket URL carries a 32+ char secret (timing-safe compare) + optional `RETELL_WS_IPS`; the call id must exist, be < 1 h old and not ended; a newer `response_id` makes older turns stale (Retell discards them); reconnects within 2 min continue the same call. |
| Conversation state | `receptionist_conversations.state` (details, offered slots, booking, log) + `transcript`; optimistic concurrency on `turns`. |
| Tool failure | The tool returns `{ ok: false, error, note }`; the model is told to say so honestly and offer a callback/booking page. A turn the caller talked over is dropped unless it acted. |
| Interruptions / silence / turn-taking | Retell's (agent settings). Proposed tuned settings exist in `retell-setup.mjs --tuned` (not applied). Holding line before slow tools; reminders after 10 s. |
| Latency we can measure | `voice_turn` events: queue wait, first audible chunk, total, model ms, tool ms, model calls. **Real numbers (production backup 2026-11-20, 7 voice turns, one test session):** first chunk p50 **4.7 s**, model p50 3.4 s, tools p50 0 ms (719 ms when used), 4 of 7 turns talked over. The model is the bottleneck, not Retell or our tools. |
| Production vs test agents | One agent. `RECEPTIONIST_VOICE_BUSINESSES=poolthru-llc,bob-electrical` gates who can start voice. |
| Testing without live routing | Yes: the engine is unit-tested with a mocked socket (`test/receptionist.test.js`, `test/intelligence.test.js`); no Retell call is needed to test rules. |

Architecture map:

```
Business owner ──Teach Your AI (dashboard)──▶ ai_rules draft ──publish──▶ ai_rule_versions (live pointer)
                                                                               │ activeRules() (only AI_RULES_LIVE_BUSINESSES)
Customer ──chat page──▶ /api/receptionist/:id/chat ──▶ server/receptionist/engine.js ◀── rules: system block + per-turn note + tool guards
Customer ──"Talk"──▶ our server creates a Retell web call ──▶ Retell (ASR, voice, turn-taking) ──WebSocket──▶ same engine
                                                                               │ tools (server-side, business-bound)
                                                  Google Calendar (openSlots) · booking.js (bookAppointment) · coverage · receptionist_requests
```

**Unchanged on purpose:** Retell agent, call creation, socket auth, tools and their guards, booking integrity, cost caps,
retention, the chat page, every existing receptionist test (all still pass).

## 2. The three layers

- **A. Intelligence engine (`server/intelligence/`, provider-neutral):** `schema.js` (versioned config v1, validation,
  platform rules, industry templates, plain-language descriptions and diffs), `understand.js` (what a message states:
  towns, ZIPs, addresses, phones, need/service, equipment, urgency, safety, days, intents, corrections, conflicts),
  `decide.js` (coverage in five states; what is satisfied; the ONE next question; whether times / a booking are
  allowed; hand-offs; owner-facing explanations), `compile.js` (short rules block + per-turn note), `teach.js`
  (plain-language request → catalog operations → validated proposal), `simulate.js`, `recommend.js`, `store.js`
  (draft / versions / rollback with stale-save protection), `access.js` (gates), `providers.js` (adapter boundary).
- **B. Voice execution (Retell):** untouched. The adapter (`providers.js retellAdapter`) answers "what must change at
  the provider for this version?" → **nothing**, because the agent is a custom LLM served by our engine. Another
  provider = another adapter with the same `plan()` shape; owner configs don't change.
- **C. Operational APIs:** the receptionist tools. Owner rules only ever **add** guards (`ruleBlock`): the platform
  guards (area, offered slot + the customer's own yes, contact, address, one booking) stay exactly as they were.

## 3. Data model (migration 0033, additive)

`ai_rules` (one draft per business, `draft_updated_at` = version stamp, `live_version`), `ai_rule_versions`
(append-only; rollback publishes a copy as a new version; `published_by` is a hash ref). No business fact is copied:
services/prices/towns/phone (business_profiles), ZIPs/hours/time zone (customers), appointment mode (service_settings),
policies (business_policies) are read at decision time, and a stored config is re-validated against today's records
(a town removed in Settings is dropped from "fully served", never silently relied on). Both tables are in
`ERASED_TABLES` (erased with the account).

Config v1 fields: `intake[]` (8 catalog items, owner order, required, beforeTimes), `services.excluded`,
`coverage.cityWide`, `emergency {triggers, action}`, `escalation[] {when, action, phrase?}`, `afterHours`, `pricing`,
`style`. Owner text is limited to short validated phrases (towns must exist in records; excluded services can't be
listed services; instruction-like text is refused), so a config can never become system-prompt access.

## 4. Release switches (all off; each needs approval)

| Switch | Effect |
| --- | --- |
| Migration `0033_ai_rules.sql` | Creates the two tables. Until applied: tab hidden, API 404, receptionist unchanged. |
| Eligibility (server/eligibility.js: active business, hosting active) | Every eligible owner sees Teach Your AI and can edit, test, publish, from the first day. **Customers are not affected.** `AI_STUDIO_ENABLED=false` hides it for everyone (emergency). `AI_STUDIO_BUSINESSES` (the pilot allowlist) is ignored. |
| `AI_RULES_LIVE_BUSINESSES` (ids) | The receptionist (chat + Retell voice) uses that business's PUBLISHED version. |
| `AI_RULES_ENABLED=false` | Emergency off for live use everywhere (Studio stays usable). |

Rollback of the code: Cloudflare Pages → previous deployment. Tables stay (older code ignores them). Rollback of a
business's rules: the owner's own "Go back to this version", or remove the id from `AI_RULES_LIVE_BUSINESSES`.

## 5. What the evaluation covers (and what it doesn't)

`node scripts/intelligence-eval.mjs` — 51 curated scenarios (location 20, workflow 17, conversation 8, security 6)
over a pool service, two HVAC companies with different rules on the same records, and an electrician. Result
(2026-11-20): **51/51**, location accuracy 100%, repeated questions 0, unauthorized bookings 0, escalation accuracy
100%, cross-tenant exposure 0. Enforced by `test/intelligence-eval.test.js` (≥95% location, zeros).

These measure the **rules** (understanding, coverage, next question, when times/bookings are allowed, hand-offs),
deterministically and offline. They do **not** measure model wording, speech recognition, audio quality, response
timing or interruption behaviour: those need the real-model script (`scripts/receptionist-eval.mjs --real`) and real
Retell calls, which are approval items (paid). The adversarial receptionist suite (100 scenarios, guards) still passes.

## 6. Cost estimates (not measured; provider list prices as of 2026-11-20, to confirm)

Assumptions per business per month — low / normal / heavy: 30 / 120 / 400 conversations, 60% chat / 40% voice, 8
turns each, voice calls 3 min. Intelligence engine = D1 rows + a few KB per turn note + one Workers request per turn
(no extra model call: the rules add ~600 cached prompt tokens and one short note).

| Component | Basis | 10 businesses | 100 | 1,000 |
| --- | --- | --- | --- | --- |
| Intelligence engine (D1, Workers, KV) | Cloudflare paid plan $5 + usage; ~0.1 MB/business/month | ≈ $5 | ≈ $5–10 | ≈ $15–40 |
| Claude (receptionist turns, Opus 5.5, cached prompt) | ≈ $0.02/turn normal | $20 / $60 / $190 | $190 / $580 / $1,900 | $1,900 / $5,800 / $19,000 |
| Retell platform + voice (web calls) | ≈ $0.07–0.15/min (plan-dependent) | $10 / $50 / $180 | $100 / $500 / $1,800 | $1,000 / $5,000 / $18,000 |
| Telephony (phone numbers, PSTN) | not provisioned | $0 | $0 | $0 |
| Storage (conversations 365 d, rule versions) | D1 ≈ $0.75/GB-month | < $1 | ≈ $1 | ≈ $5–10 |
| Analytics / evaluation | counts from existing tables; eval offline | $0 | $0 | $0 |
| Optional recordings | not enabled (consent decision) | — | — | — |
| **Total, normal usage** | | **≈ $115** | **≈ $1,100** | **≈ $10,900** |

Per business at normal usage ≈ $11/month against the $499 plan: gross margin ≈ 97% on these components, ≈ 90% in the
heavy case. **Main drivers:** model tokens per turn (voice especially: `RECEPTIONIST_VOICE_MODEL` can point voice at a
faster, cheaper model, approval) and Retell minutes. The rules engine itself is a rounding error by design (no model
call, no tool call). Existing caps stay: $1/conversation, $5/business/day.

## 7. Limitations and readiness

- Understanding is pattern-based (towns from records, ZIPs, addresses, safety/urgency/equipment words). Anything it
  can't place is still handled by the model (which records answers with `note_answer`, checked against the customer's
  words) — the rules are a floor, not a ceiling.
- "Fully served town" never bypasses the ZIP list at booking (platform rule): an unlisted ZIP in a served town becomes
  a service-area request. The owner is told this in the UI.
- After-hours rules depend on confirmed booking hours.
- The model path of Teach a Change costs ≈ $0.01 per request (limited to 30/hour/business) and is only used when fixed
  patterns don't understand the sentence.
- No real voice test has run with rules live. Latency: the rules add ~0 ms (one deterministic pass); the model remains
  the bottleneck (p50 first chunk 4.7 s in the one production session measured).

Pilot (controlled): apply 0033 (done) → owner configures, tests, publishes (editing is on for every eligible business) →
review the published version together → add to `AI_RULES_LIVE_BUSINESSES` → a few chat conversations, then a voice
call (paid) → compare `rules` / `voice_turn` events and the owner's transcript → widen.
