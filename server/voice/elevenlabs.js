// ElevenLabs Conversational AI (Agents Platform) for the Voice Lab — server side. ElevenLabs does speech recognition,
// turn-taking, the model and the voice; GetShowUps supplies the receptionist (OUR system prompt and greeting, per
// conversation) and runs every business tool itself: the agent's seven tools are CLIENT tools, so each call reaches
// the browser, which forwards it to POST /api/platform/voice-lab/tool (server/voice/tools.js, engine guards, dry-run
// by default) and returns the result. The permanent API key never leaves this server: the browser gets one signed
// URL per connection (short-lived) for the configured agent.
//
// ElevenLabs docs read 2026-11-21 (elevenlabs.io/docs):
//   - Signed URL (private agents, WebSocket): GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url
//     ?agent_id=<agent_…>, header `xi-api-key`, → { signed_url }. "Signed URLs are valid for 15 minutes"; the
//     conversation must START within that window (agents-platform/customization/authentication). The optional
//     WebRTC variant GET /v1/convai/conversation/token → { token, conversation_id } has no documented expiry, so the
//     Lab uses the signed URL + WebSocket.
//   - WebSocket (eleven-agents/api-reference/eleven-agents/websocket): wss://api.elevenlabs.io/v1/convai/conversation
//     ?agent_id=…; first client message `conversation_initiation_client_data` { conversation_config_override: { agent:
//     { prompt: { prompt }, first_message, language }, tts: { voice_id } }, dynamic_variables }; server events
//     conversation_initiation_metadata, user_transcript, agent_response, agent_response_correction, audio,
//     interruption, ping (→ pong), client_tool_call { tool_name, tool_call_id, parameters, expects_response };
//     client answers `client_tool_result` { tool_call_id, result (string), is_error }.
//   - Overrides are OFF by default and must be enabled per field on the agent (Security tab, or API
//     platform_settings.overrides.conversation_config_override.agent.{prompt.prompt,first_message,language}: true);
//     sending an override that is not enabled is an error (customization/personalization/overrides).
//   - Verified live 2026-11-22 (agent published from the dashboard, flags on, version committed): the prompt and
//     language overrides are accepted, a first_message override is refused ("Override for field 'first_message' is
//     not allowed by config", close 1008). So the greeting travels as a DYNAMIC VARIABLE instead: the agent's
//     first_message is "{{greeting}}" (scripts/elevenlabs-setup.mjs) and we send dynamic_variables.greeting; a
//     session without it is refused by ElevenLabs ("Missing required dynamic variables"), never a placeholder spoken.
//   - Client tools: tool objects (type 'client', name, description, parameters, expects_response) created with
//     POST /v1/convai/tools and attached by id in conversation_config.agent.prompt.tool_ids; the browser SDK runs
//     the handler registered under the same name (customization/tools/client-tools). scripts/elevenlabs-setup.mjs
//     creates/updates the agent and its tools from toolsForElevenLabs().
//   - Browser SDK @elevenlabs/client 1.37.1 (lazy-loaded in src/voice/elevenlabs.js): Conversation.startSession({
//     signedUrl, connectionType: 'websocket', overrides: { agent: { prompt: { prompt }, firstMessage, language } },
//     dynamicVariables, clientTools: { name: async (params) => result } }); dist/utils/overrides.js maps that to the
//     wire message above.
//   - Tool parameters (api-reference/tools/create): ObjectJsonSchemaProperty { type, description, required,
//     properties } of LiteralJsonSchemaProperty { type: boolean|string|integer|number, description, enum? }.
//   NOT verified without credentials: a real conversation (no ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID exist in
//   production today), so request/response shapes are from the docs and the SDK source only.
import { elevenlabsConfigured } from './providers.js'
import { getVoiceSettings, sessionVoiceFor } from './style.js'
import { voiceInstructions, toolsForElevenLabs } from './tools.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/
// ELEVENLABS_API_MOCK_ORIGIN is a loopback-only test variable (never set in production).
export const elevenlabsBase = (env) => (typeof env?.ELEVENLABS_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.ELEVENLABS_API_MOCK_ORIGIN) ? env.ELEVENLABS_API_MOCK_ORIGIN : 'https://api.elevenlabs.io')

// Documented lifetime of a signed URL (start the conversation within it); the Lab reports expiresAt from this and
// asks for a fresh one on every (re)connection, never reusing an old URL.
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000
// Signed URLs issued per Lab session: the first connection + at most two reconnects (src/voice/elevenlabs.js).
export const MAX_CONNECTS_PER_SESSION = 3

// The per-conversation overrides in the browser SDK's shape (camelCase; the SDK sends the snake_case wire form):
// OUR system prompt and OUR greeting, English. No key, token, email or id goes here; the prompt is the engine's
// per-business prompt (facts + guards + voice manner), which never contains secrets.
// tts: { voiceId?, speed? } → the agent's tts.voice_id / tts.speed overrides (enabled on the agent by
// scripts/elevenlabs-setup.mjs); absent → the agent's own voice.
export const elevenlabsOverrides = ({ instructions, tts = null }) => ({ agent: { prompt: { prompt: String(instructions || '') }, language: 'en' }, ...(tts && (tts.voiceId || tts.speed) ? { tts: { ...(tts.voiceId ? { voiceId: tts.voiceId } : {}), ...(tts.speed ? { speed: tts.speed } : {}) } } : {}) })

// Dynamic variables ({{business_name}} etc. in the agent's dashboard prompt, if anyone types one there): public,
// non-personal facts only.
// The greeting is the agent's first message ("{{greeting}}" on the agent): the business's own, never empty (an empty
// first message would make the agent wait for the caller).
export const elevenlabsDynamicVariables = (customer, lab, greeting = '') => ({ business_name: String(customer?.name || ''), dry_run: lab?.dryRun !== false, channel: 'voice_lab', greeting: String(greeting || '').trim() || `Thanks for calling ${String(customer?.name || 'us')}, how can I help?` })

// The client tools the browser must register for this agent (names only; the handler forwards to our tool route).
export const elevenlabsClientToolNames = () => toolsForElevenLabs().map((t) => t.name)

const WSS_RE = /^wss:\/\/[a-z0-9.-]+\.elevenlabs\.io\//
const okSignedUrl = (env, url) => typeof url === 'string' && url.length <= 4096 && (WSS_RE.test(url) || (env?.ELEVENLABS_API_MOCK_ORIGIN && url.startsWith(elevenlabsBase(env).replace(/^http/, 'ws'))))

// Fetches one signed URL for the configured agent. → { ok, signedUrl } | { ok: false, error (code), httpStatus }.
// The key goes only in the request header to ElevenLabs; errors are codes.
export async function fetchSignedUrl(env) {
  if (!elevenlabsConfigured(env)) return { ok: false, error: 'elevenlabs_not_configured', httpStatus: 404 }
  let res
  try {
    res = await fetch(`${elevenlabsBase(env)}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  } catch {
    return { ok: false, error: 'elevenlabs_unreachable', httpStatus: 502 }
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'elevenlabs_auth_failed', httpStatus: 502 }
  if (!res.ok) return { ok: false, error: `elevenlabs_http_${res.status}`, httpStatus: 502 }
  if (!okSignedUrl(env, body?.signed_url)) return { ok: false, error: 'elevenlabs_bad_response', httpStatus: 502 }
  return { ok: true, signedUrl: body.signed_url }
}

// One connection of a Lab session (first connect or a reconnect): a fresh signed URL + everything the browser needs
// to start the conversation as OUR receptionist. Counts connections on the session (conversation.state.lab.elevenlabs)
// so a looping client cannot mint signed URLs. → { ok, signedUrl, expiresAt, overrides, dynamicVariables, clientTools,
// connection } | { ok: false, error, httpStatus }.
export async function connectElevenLabs(env, { customer, conv }, now = Date.now()) {
  if (!elevenlabsConfigured(env)) return { ok: false, error: 'elevenlabs_not_configured', httpStatus: 404 }
  const lab = conv.state?.lab
  if (!lab) return { ok: false, error: 'not_found', httpStatus: 404 }
  if (lab.provider !== 'elevenlabs') return { ok: false, error: 'wrong_provider', httpStatus: 409 }
  if (conv.state.endedAt || lab.endedAt) return { ok: false, error: 'conversation_ended', httpStatus: 409 }
  const el = lab.elevenlabs || { connects: 0 }
  if (el.connects >= MAX_CONNECTS_PER_SESSION) return { ok: false, error: 'reconnect_limit', httpStatus: 429 }
  const signed = await fetchSignedUrl(env)
  if (!signed.ok) return signed
  const v = await voiceInstructions(env, customer, now)
  lab.elevenlabs = { connects: el.connects + 1, lastConnectAt: now }
  await env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(conv.state), now).run()
  return {
    ok: true,
    signedUrl: signed.signedUrl,
    expiresAt: now + SIGNED_URL_TTL_MS,
    overrides: elevenlabsOverrides({ ...v, tts: lab.settings?.voice ? { voiceId: lab.settings.voice } : sessionVoiceFor('elevenlabs', await getVoiceSettings(env.ONBOARDING_DB, customer.id)) }),
    dynamicVariables: elevenlabsDynamicVariables(customer, lab, v.greeting),
    clientTools: elevenlabsClientToolNames(),
    connection: lab.elevenlabs.connects,
    connectionsLeft: MAX_CONNECTS_PER_SESSION - lab.elevenlabs.connects,
  }
}
