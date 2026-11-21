// OpenAI Realtime adapter, server side (Voice Lab only: platform admins, admin-marked test businesses, dry-run by
// default). The permanent OPENAI_API_KEY lives only here: the browser gets a SHORT-LIVED client secret minted for ONE
// Lab session, with the session configuration (model, voice, server VAD, our instructions and our seven tools) fixed
// by the server. The browser then speaks WebRTC with OpenAI directly (src/voice/openai.js); every tool the model
// calls is forwarded to POST /api/platform/voice-lab/tool and run by server/voice/tools.js with every guard. The
// model never executes anything itself and never sees a credential of ours.
//
// API surface relied on (official OpenAI developer docs, checked 2026-11-21; recorded in docs/VOICE_LAB.md):
//   POST https://api.openai.com/v1/realtime/client_secrets   (Authorization: Bearer <standard API key>)
//     body { expires_after: { anchor: 'created_at', seconds: 10..7200 (default 600) }, session: { type: 'realtime', model,
//           instructions, tools, tool_choice, output_modalities: ['audio'], audio: { input: { turn_detection,
//           transcription }, output: { voice } }, max_output_tokens } }
//     → { value: 'ek_…', expires_at: <unix seconds>, session: <effective session> }
//     https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret
//   POST https://api.openai.com/v1/realtime/calls   (browser; Authorization: Bearer <client secret>, Content-Type:
//     application/sdp, body = SDP offer → SDP answer); data channel 'oai-events'
//     https://developers.openai.com/api/docs/guides/realtime-webrtc
//   output_modalities cannot be ['audio', 'text'] at once (documented); audio responses still stream a transcript
//   (response.output_audio_transcript.delta/done), so the Lab gets text from audio.
// Not verifiable without credentials (no OPENAI_API_KEY exists in production): the live behaviour of these calls.
// Everything here is defensive about shapes and never logs or returns provider payloads, only codes and statuses.
import { openaiConfigured, openaiModel } from './providers.js'
import { toolsForOpenAI } from './tools.js'

export const OPENAI_API_BASE = 'https://api.openai.com'
export const OPENAI_CLIENT_SECRETS_URL = `${OPENAI_API_BASE}/v1/realtime/client_secrets`
export const OPENAI_CALLS_URL = `${OPENAI_API_BASE}/v1/realtime/calls`
export const OPENAI_DATA_CHANNEL = 'oai-events'

// A client secret only has to outlive the microphone prompt and the SDP exchange; a reconnect mints a new one.
// Documented range 10..7200 s (default 600). We keep it well under the default.
export const CLIENT_SECRET_TTL_SECONDS = 180
export const CLIENT_SECRET_MAX_TTL_SECONDS = 300

// Built-in voices from the client-secret reference (2026-11-21). OPENAI_REALTIME_VOICE picks one; default 'marin'
// (the docs' current example voice). Anything else falls back to the default, never to a free string.
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
export const OPENAI_DEFAULT_VOICE = 'marin'
export const openaiVoice = (env) => (OPENAI_VOICES.includes(env?.OPENAI_REALTIME_VOICE) ? env.OPENAI_REALTIME_VOICE : OPENAI_DEFAULT_VOICE)

// Input transcription gives the Lab the caller's words (and the tool route's userText: the engine's digit and
// confirmation checks read what the caller actually said). Documented model options include gpt-4o-mini-transcribe,
// gpt-4o-transcribe, whisper-1, gpt-realtime-whisper. OPENAI_TRANSCRIBE_MODEL overrides when it looks like a model id.
export const OPENAI_DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'
export const openaiTranscribeModel = (env) => (/^[a-z0-9.-]{3,60}$/i.test(env?.OPENAI_TRANSCRIBE_MODEL || '') ? env.OPENAI_TRANSCRIBE_MODEL : OPENAI_DEFAULT_TRANSCRIBE_MODEL)

// The session the Lab runs: audio in and out, server VAD (natural turn-taking: the model starts answering when the
// caller stops and is cut off when they start again), our instructions, our tools. Nothing secret goes in here;
// the same object is returned to the admin's browser (which re-sends it as session.update after a reconnect).
export function openaiSessionConfig(env, instructions) {
  return {
    type: 'realtime',
    model: openaiModel(env),
    instructions: String(instructions || ''),
    output_modalities: ['audio'],
    audio: {
      input: {
        turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true, threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        transcription: { model: openaiTranscribeModel(env), language: 'en' },
      },
      output: { voice: openaiVoice(env) },
    },
    tools: toolsForOpenAI(),
    tool_choice: 'auto',
    max_output_tokens: 1024,
  }
}

const statusCode = (status) => (status === 401 || status === 403 ? 'openai_auth_failed' : status === 429 ? 'openai_rate_limited' : status >= 500 ? 'openai_unavailable' : 'openai_rejected')

// Mints one short-lived client secret for one Lab session. → { ok, clientSecret, expiresAt (ms), model, sessionConfig }
// or { ok: false, error: <code>, status? }. The permanent key is used for this one call and never returned; a
// defensive check refuses to hand back anything that contains it.
export async function mintClientSecret(env, { instructions, ttlSeconds = CLIENT_SECRET_TTL_SECONDS } = {}, fetchFn = globalThis.fetch) {
  if (!openaiConfigured(env)) return { ok: false, error: 'openai_not_configured' }
  const sessionConfig = openaiSessionConfig(env, instructions)
  const seconds = Math.min(CLIENT_SECRET_MAX_TTL_SECONDS, Math.max(10, Math.round(Number(ttlSeconds) || CLIENT_SECRET_TTL_SECONDS)))
  let res
  try {
    res = await fetchFn(OPENAI_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds }, session: sessionConfig }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('openai client secret: unreachable', err?.name)
    return { ok: false, error: 'openai_unreachable' }
  }
  if (!res.ok) {
    console.error('openai client secret: status', res.status)
    return { ok: false, error: statusCode(res.status), status: res.status }
  }
  const data = await res.json().catch(() => null)
  const value = data?.value
  if (typeof value !== 'string' || value.length < 10 || value === env.OPENAI_API_KEY) return { ok: false, error: 'openai_bad_response' }
  const expiresAt = Number.isFinite(data?.expires_at) ? data.expires_at * 1000 : Date.now() + seconds * 1000
  const out = { ok: true, clientSecret: value, expiresAt, model: sessionConfig.model, sessionConfig }
  if (JSON.stringify(out).includes(env.OPENAI_API_KEY)) return { ok: false, error: 'openai_bad_response' }
  return out
}
