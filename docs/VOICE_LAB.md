# Voice Lab

Admin-only testbed for putting the SAME receptionist (engine + Teach Your AI rules + the seven business tools) on
different voice providers and comparing them honestly: platform admins, admin-marked test businesses only, dry-run
by default (every guard runs, nothing is booked or sent), a daily minute ceiling, numbers-only metrics. Off unless
`VOICE_LAB_ENABLED=true`. Shared core: `server/voice/{providers,tools,sessions}.js` and
`functions/api/platform/voice-lab/{status,session,tool}.js`. Each provider adds its own connection route and browser
adapter behind the interface in `src/voice/adapter.js`.

## OpenAI Realtime

Files: `server/voice/openai.js` (client secret + session config), `functions/api/platform/voice-lab/openai.js`
(route), `src/voice/openai.js` (browser adapter), `src/voice/adapter.js` (interface), `test/voice-openai.test.js`.

### What runs where

1. The admin starts a Lab session (`POST /api/platform/voice-lab/session { action: 'start', provider: 'openai' }`).
2. The browser calls `POST /api/platform/voice-lab/openai { customer, id, token }`. The server (platform admin,
   same-origin, Lab on, `providerStatus(env).openai.configured`, the session belongs to this business and this
   provider and is not ended) builds the session configuration — model `openaiModel(env)` (default `gpt-realtime`),
   `instructions` from `voiceInstructions(env, customer)`, the seven tools from `toolsForOpenAI()`, audio in/out,
   server VAD with `interrupt_response: true`, caller transcription, an allowlisted voice — and mints a short-lived
   client secret with the permanent `OPENAI_API_KEY`. The browser receives `{ clientSecret (ek_…), expiresAt, model,
   sessionConfig, greeting }`; the permanent key never leaves the server (tests assert it). Audited
   (`voice_lab.openai_connect`, codes only). Rate limit `voiceLabConnect` (90 / h per admin).
3. The browser opens a WebRTC peer connection to OpenAI with the ephemeral secret: microphone track in, remote audio
   out, data channel `oai-events`. It sends `session.update` with the same config (minus `model`) and, once per Lab
   session, a system item with the business's greeting + `response.create` so the receptionist opens the call.
4. Turn-taking and interruptions are OpenAI's server VAD. When the model calls a tool, the adapter forwards it to
   `POST /api/platform/voice-lab/tool` with the caller's latest transcribed words (`userText`); the engine runs it
   with every guard, dry-run unless the session was started live; the result is handed back verbatim as a
   `function_call_output` item + `response.create`. The model never executes anything itself.
5. Transcript lines (caller from input transcription, receptionist from the output audio transcript) go to the
   UI and, batched, to `POST /api/platform/voice-lab/session { action: 'transcript' }`. On stop the adapter sends
   `{ action: 'end', metrics, outcome }`.
6. On ICE failure / disconnect (3 s grace) / closed channel the adapter re-mints and reconnects (a fresh OpenAI
   session, same config, no second greeting) up to 2 times, then ends the Lab session as `connection_lost`.

### Documented API relied on (official OpenAI developer docs, checked 2026-11-21)

| Purpose | Endpoint / event | Source |
| --- | --- | --- |
| Mint ephemeral client secret (server) | `POST https://api.openai.com/v1/realtime/client_secrets`, `Authorization: Bearer <API key>`, body `{ expires_after: { anchor: 'created_at', seconds 10–7200 (default 600) }, session: { type: 'realtime', model, instructions, tools, tool_choice, output_modalities, audio: { input: { turn_detection, transcription }, output: { voice } }, max_output_tokens } }` → `{ value, expires_at (unix s), session }` | https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret |
| WebRTC SDP exchange (browser) | `POST https://api.openai.com/v1/realtime/calls`, `Authorization: Bearer <client secret>`, `Content-Type: application/sdp`, body = offer SDP → answer SDP; data channel `oai-events`; omit `audio.format` (SDP negotiates it) | https://developers.openai.com/api/docs/guides/realtime-webrtc |
| Session config | `audio.input.turn_detection` `server_vad` (`create_response`, `interrupt_response`, `threshold`, `prefix_padding_ms`, `silence_duration_ms`) or `semantic_vad`; `audio.input.transcription.model` (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`, `gpt-realtime-whisper`, …); `audio.output.voice` (`alloy ash ballad coral echo sage shimmer verse marin cedar`); `output_modalities` `['audio']` (text + audio together is not allowed); `max_output_tokens` 1–4096 or `inf` | same reference |
| Client events | `session.update`, `conversation.item.create` (`{ type: 'function_call_output', call_id, output }`; system/user message items), `response.create`, `response.cancel` | https://developers.openai.com/api/docs/guides/realtime-conversations · https://developers.openai.com/api/docs/guides/realtime-function-calling |
| Server events used | `input_audio_buffer.speech_started` / `speech_stopped`, `response.created`, `response.output_audio.delta`, `response.output_audio_transcript.delta` / `.done` (`transcript`), `response.output_text.delta` / `.done`, `conversation.item.input_audio_transcription.completed` (`transcript`), `response.function_call_arguments.done` (`call_id`, `name`, `arguments`), `response.done` (`response.output[]` function_call items as fallback; `response.usage.input_tokens` / `output_tokens`), `output_audio_buffer.started` / `stopped` / `cleared` (WebRTC only), `session.created` / `updated`, `error` | https://developers.openai.com/api/docs/api-reference/realtime-server-events |
| Pricing | `gpt-realtime` per 1M tokens: text in $4 / cached $0.40 / out $16; audio in $32 / cached $0.40 / out $64. Audio tokens: 1 per 100 ms caller audio, 1 per 50 ms assistant audio; the whole history is re-billed per response (cached where the prefix matches) | https://developers.openai.com/api/docs/pricing · https://developers.openai.com/api/docs/guides/realtime-costs |

Not verified (no `OPENAI_API_KEY` exists in production, so no real call was made): the live behaviour of any of
the above. The code is defensive about shapes (unknown events ignored, function calls deduplicated by `call_id`
across `.done` and `response.done`, unparseable arguments become `{}`, failures become honest failure results so the
model is never left waiting). The docs' current example model is `gpt-realtime-2.1`; the Lab's default stays
`gpt-realtime` (`OPENAI_REALTIME_MODEL` overrides) because that is the row the cost estimate is built on.

### Cost estimate (`COST_ESTIMATES.openai`)

$0.08 per minute (80 000 micro-dollars), an ESTIMATE for a typical turn-based minute of `gpt-realtime`, 2026-11-21
list prices: ~30 s caller speech (300 input audio tokens, $0.0096) + ~30 s assistant speech (600 output audio tokens,
$0.0384) + the assistant's audio re-sent once as uncached input (600 tokens, $0.0192) + ~4 responses/min re-billing
~4k tokens of cached context ($0.0064) ≈ $0.074, plus a one-time ~$0.012 for the first uncached instructions, rounded
up. Longer calls cost more per minute (the whole history is re-billed each response). Never shown as measured spend;
the Lab records real token usage from `response.done` when available.

### Settings

| Name | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | Permanent key, server only (approval: paid service). Absent = provider "not configured" (404 on the route). |
| `OPENAI_REALTIME_MODEL` | Model id, default `gpt-realtime`. |
| `OPENAI_REALTIME_VOICE` | One of the built-in voices, default `marin`; anything else falls back. |
| `OPENAI_TRANSCRIBE_MODEL` | Caller transcription model, default `gpt-4o-mini-transcribe`. |

### Adapter interface (`src/voice/adapter.js`)

`createOpenAIAdapter()` → `{ start({ customer, id, token, onEvent }), stop({ outcome }), state, metrics() }`.
States: `idle → connecting → connected (↔ reconnecting) → stopping → stopped | failed`. Events: `status`
`{ state, attempt?, reason? }`, `transcript` `{ who, text, at, final }`, `tool` `{ name, ok, simulated, error?, ms }`,
`metrics` `{ firstResponseMs, medianResponseMs, p95ResponseMs, turns, interruptions, toolCalls, toolFailures,
reconnects, audioSeconds, inputTokens, outputTokens }`, `error` `{ code, detail?, fatal }`. Response time = from
`input_audio_buffer.speech_stopped` to the first of `output_audio_buffer.started` / an audio or transcript delta.

## ElevenLabs (Conversational AI / Agents Platform)

Owner: server/voice/elevenlabs.js · functions/api/platform/voice-lab/elevenlabs.js · src/voice/elevenlabs.js ·
scripts/elevenlabs-setup.mjs · test/voice-elevenlabs.test.js. Docs read **2026-11-21** at elevenlabs.io/docs.

### How a Lab conversation runs

1. The Lab page starts a session (`POST /api/platform/voice-lab/session` `{ action: 'start', provider: 'elevenlabs',
   customer }`), then calls the browser adapter: `createElevenLabsAdapter().start({ customer, id, token, onEvent })`.
2. The adapter asks **our** server for a connection: `POST /api/platform/voice-lab/elevenlabs` `{ customer, id, token }`
   (platform admin, same-origin, rate limit `voiceLabConnect`, the session must be this admin's Lab session of an
   ElevenLabs provider, not ended, at most 3 connections per session). The server calls
   `GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=<ELEVENLABS_AGENT_ID>` with the
   permanent key in the `xi-api-key` header (server-only secret) and returns
   `{ signedUrl, expiresAt, overrides, dynamicVariables, clientTools, connection, connectionsLeft }`.
   `expiresAt` = issue time + 15 minutes (ElevenLabs: "Signed URLs are valid for 15 minutes"; the conversation must
   start within that window). The response never carries the key, the agent id on its own, emails or tokens.
3. `overrides` (SDK shape, mapped to the wire by the SDK) = **our** receptionist:
   `{ agent: { prompt: { prompt: voiceInstructions(env, customer).instructions }, firstMessage: <the business's
   greeting>, language: 'en' } }`. `dynamicVariables` = `{ business_name, dry_run, channel: 'voice_lab' }` (public,
   non-personal). `clientTools` = the seven engine tool names.
4. The adapter lazy-loads `@elevenlabs/client` (1.37.1, exact) and calls `Conversation.startSession({ signedUrl,
   connectionType: 'websocket', overrides, dynamicVariables, clientTools: { <name>: handler }, callbacks })`. The SDK
   opens `wss://api.elevenlabs.io/v1/convai/conversation` from the signed URL, sends
   `conversation_initiation_client_data { conversation_config_override: { agent: { prompt: { prompt }, first_message,
   language } }, dynamic_variables }`, streams the microphone (`user_audio_chunk`), plays `audio` events, answers
   `ping` with `pong`, and handles barge-in (`interruption`).
5. Every agent tool call arrives as `client_tool_call { tool_name, tool_call_id, parameters, expects_response }`; the
   SDK runs our handler, which POSTs `/api/platform/voice-lab/tool` `{ customer, id, token, name, input, userText:
   <latest final user transcript> }` and returns the server's result (the SDK sends it as `client_tool_result {
   tool_call_id, result: <JSON string>, is_error: false }`). A refused or failed call returns `{ ok: false, error, note
   }` to the model, never a thrown error (the SDK would read the exception text to the agent). This route is the only
   way the agent acts; dry-run sessions get `simulated: true` and nothing is created.
6. Final transcript lines (`onMessage { message, role: 'user' | 'agent' }`) are posted to the session (`action:
   'transcript'`, batched ~0.8 s) and emitted as `transcript` events. Metrics (browser side, numbers only):
   `firstResponseMs` / `medianResponseMs` / `p95ResponseMs` = end of the caller's utterance (final transcript) → the
   SDK's mode flipping to `speaking` (first agent audio); `turns`, `interruptions`, `toolCalls`, `toolFailures`,
   `reconnects`. The Lab sends the last `metrics` event with `action: 'end'`.
7. A disconnect with `reason: 'error'` reconnects at most twice, each time through step 2 (a fresh signed URL; the
   server caps a session at 3 connections → `reconnect_limit`). `reason: 'agent'` (the agent ended the call) or
   `'user'` ends the session.

### What must be set on the ElevenLabs agent (dashboard or API)

`scripts/elevenlabs-setup.mjs` does all of this (read-only unless `--apply`, never auto-run):

```
printf '%s\n' "$ELEVENLABS_API_KEY" | node scripts/elevenlabs-setup.mjs            # dry run: lists what it would do
printf '%s\n' "$ELEVENLABS_API_KEY" | node scripts/elevenlabs-setup.mjs --apply    # create/update (approval: paid service)
   [--site https://getshowups.com] [--name "GetShowUps receptionist (Voice Lab)"] [--voice <voice_id>] [--llm <model id>]
```

| Setting | Dashboard | API (`POST /v1/convai/agents/create` / `PATCH /v1/convai/agents/{agent_id}`) |
| --- | --- | --- |
| Overrides allowed: system prompt, first message, language | Agent → **Security** → enable the override toggles | `platform_settings.overrides.conversation_config_override: { agent: { prompt: { prompt: true }, first_message: true, language: true } }` (off by default; sending a non-enabled override is an error) |
| Only signed URLs may start a conversation | Security → authentication + allowlist | `platform_settings.auth: { enable_auth: true, allowlist: [{ hostname: 'getshowups.com' }] }` |
| Seven CLIENT tools (same names/parameters as `toolsForElevenLabs()`), "wait for response" | Agent → Tools → Add tool → type Client | Each: `POST /v1/convai/tools { tool_config: { type: 'client', name, description, expects_response: true, response_timeout_secs: 30, parameters: { type: 'object', required, properties: { <k>: { type, description, enum? } } } } }` → attach ids in `conversation_config.agent.prompt.tool_ids` |
| Client events the adapter listens to | Agent → Advanced → client events | `conversation_config.conversation.client_events: [conversation_initiation_metadata, ping, audio, interruption, user_transcript, agent_response, agent_response_correction, client_tool_call, agent_tool_response, vad_score]` |
| Conversation ceiling | Agent → Advanced | `conversation_config.conversation.max_duration_seconds: 900` |
| Placeholder prompt + first message | Agent | A conversation started without our override says "This line is not set up yet" and does nothing (no business facts live at ElevenLabs) |

Secrets (Pages project, approval): `ELEVENLABS_API_KEY` (permanent key, server only) and `ELEVENLABS_AGENT_ID` (the id
the script prints). `ELEVENLABS_API_MOCK_ORIGIN` is a loopback-only test variable. Neither secret exists in production
today, so **no real ElevenLabs conversation has been run**: request/response shapes come from the docs and the SDK
source (`@elevenlabs/client` dist/types.d.ts, dist/BaseConversation.js, dist/utils/overrides.js), and are covered by
tests with the API mocked.

### Endpoints and messages (verified in the docs on 2026-11-21)

- `GET /v1/convai/conversation/get-signed-url?agent_id=` → `{ signed_url }` (15 min; api-reference/conversations/get-signed-url,
  agents-platform/customization/authentication). Alternative `GET /v1/convai/conversation/token` → `{ token,
  conversation_id }` for WebRTC: no documented expiry, not used.
- WebSocket `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=` (eleven-agents/api-reference/eleven-agents/websocket):
  client → `conversation_initiation_client_data`, `user_audio_chunk`, `pong`, `client_tool_result`, `contextual_update`,
  `user_message`, `user_activity`; server → `conversation_initiation_metadata` (audio formats `pcm_16000` etc.),
  `user_transcript`, `agent_response`, `agent_response_correction`, `audio`, `interruption`, `ping`, `client_tool_call`,
  `vad_score`, `agent_tool_response`, `client_error`, `agent_response_complete`.
- Overrides: agents-platform/customization/personalization/overrides. Client tools: agents-platform/customization/tools/client-tools.
  Dynamic variables: agents-platform/customization/personalization/dynamic-variables. SDK: agents-platform/libraries/java-script.
- Agents/tools API: `GET /v1/convai/agents?search=&page_size=&cursor=`, `POST /v1/convai/agents/create`,
  `PATCH /v1/convai/agents/{agent_id}`, `GET /v1/convai/tools?types=client`, `POST /v1/convai/tools`,
  `PATCH /v1/convai/tools/{tool_id}`.
- Not verifiable without credentials: live behaviour of all of the above; whether the `PATCH` of
  `conversation_config` replaces nested fields the script does not send (the Lab agent is owned by the script, so
  re-running it is the fix either way).

### Cost (estimate, never measured spend)

`COST_ESTIMATES.elevenlabs = $0.08/min` (80,000 micro-dollars): the "additional minute" rate on every self-serve
Agents plan (Free … Business) at https://elevenlabs.io/pricing/agents on 2026-11-21; plan-included minutes are prepaid,
LLM usage is billed separately on top, bursts above the concurrency limit $0.16/min.

### Dependency

`@elevenlabs/client` **1.37.1** (exact pin; MIT; depends on `livekit-client` and `@elevenlabs/types`): the official
browser SDK. It owns microphone capture, audio playback/queueing, ping/pong, barge-in, `client_tool_call` →
`client_tool_result` and the override mapping; re-implementing that audio protocol by hand would be more code to
maintain against an evolving WebSocket spec. It is imported lazily (`import('@elevenlabs/client')`) inside
`createElevenLabsAdapter().start()`, so it is a separate chunk that only the Lab page loads.
