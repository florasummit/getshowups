// Voice providers (shared interface, owned by the orchestrator). Three ways to put the SAME receptionist on a voice
// call: Retell (production browser voice: Retell does speech, our engine is its custom LLM), OpenAI Realtime and
// ElevenLabs Conversational AI (Voice Lab adapters: the provider does speech + the model; our server runs every
// business tool through server/voice/tools.js, bound to the conversation's business).
//
// Every switch is off unless set. Nothing here calls a provider; it only reports what is configured, honestly, so the
// Voice Lab shows "unavailable" instead of pretending. Secrets are never returned: only booleans and public ids.
import { voiceConfigured } from '../receptionist/voice.js'

export const PROVIDERS = ['retell', 'openai', 'elevenlabs']

// VOICE_LAB_ENABLED: the admin-only Voice Lab (/admin/voice-lab + /api/platform/voice-lab/*). Off = 404 everywhere.
export const labEnabled = (env) => env?.VOICE_LAB_ENABLED === 'true'

// Daily usage ceiling for the Lab, in minutes of provider time across all admins (VOICE_LAB_DAILY_MINUTES, default 60).
export const labDailyMinutes = (env) => {
  const n = Number(env?.VOICE_LAB_DAILY_MINUTES)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600) : 60
}

export const OPENAI_DEFAULT_MODEL = 'gpt-realtime'
export const openaiConfigured = (env) => typeof env?.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length >= 20
export const openaiModel = (env) => (/^[a-z0-9.-]{3,60}$/i.test(env?.OPENAI_REALTIME_MODEL || '') ? env.OPENAI_REALTIME_MODEL : OPENAI_DEFAULT_MODEL)

export const elevenlabsConfigured = (env) => typeof env?.ELEVENLABS_API_KEY === 'string' && env.ELEVENLABS_API_KEY.length >= 20 && /^[A-Za-z0-9_-]{6,80}$/.test(env?.ELEVENLABS_AGENT_ID || '')

// { retell: { configured, reason }, openai: {...}, elevenlabs: {...} } — reasons are codes, never values.
export function providerStatus(env) {
  return {
    retell: voiceConfigured(env) ? { configured: true } : { configured: false, reason: 'retell_not_configured' },
    openai: openaiConfigured(env) ? { configured: true, model: openaiModel(env) } : { configured: false, reason: 'openai_not_configured' },
    elevenlabs: elevenlabsConfigured(env) ? { configured: true } : { configured: false, reason: 'elevenlabs_not_configured' },
  }
}

// Price estimates per minute of conversation, in micro-dollars, for the Lab's "estimated cost" line. Every number is
// an ESTIMATE from the provider's public price list on the date noted; null = not known (shown as "not estimated").
// Provider agents fill these in with the source URL; the Lab never presents them as measured spend.
export const COST_ESTIMATES = {
  retell: { perMinuteMicros: null, source: null, asOf: null },
  openai: { perMinuteMicros: null, source: null, asOf: null },
  elevenlabs: { perMinuteMicros: null, source: null, asOf: null },
}

export const estimateMicros = (provider, seconds) => {
  const e = COST_ESTIMATES[provider]
  if (!e || !Number.isFinite(e.perMinuteMicros) || !Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round((e.perMinuteMicros * seconds) / 60)
}
