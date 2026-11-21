# Voice Lab

Admin-only (`/admin/voice-lab`, `/api/platform/voice-lab/*`; 404 unless `VOICE_LAB_ENABLED=true`): the SAME
receptionist (server/receptionist engine, Teach Your AI rules, the seven business tools) on different voice
providers, on admin-marked TEST businesses only, dry-run by default (every guard runs, nothing is created). Shared
core: server/voice/{providers,tools,sessions}.js. Each provider has one server module, one route and one browser
adapter implementing src/voice/adapter.js.

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
