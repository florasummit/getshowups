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
