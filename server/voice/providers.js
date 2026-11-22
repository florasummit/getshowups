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
  // gpt-realtime (standard tier, per 1M tokens, 2026-11-21): audio input $32, cached audio/text input $0.40, text
  // input $4, audio output $64. Audio tokens: 1 per 100 ms of caller audio, 1 per 50 ms of assistant audio
  // (developers.openai.com/api/docs/guides/realtime-costs). ESTIMATE for a typical turn-based minute: ~30 s caller
  // speech (300 input audio tokens, $0.0096) + ~30 s assistant speech (600 output audio tokens, $0.0384), the
  // assistant's audio re-sent once uncached as input (600 tokens, $0.0192), ~4 responses/min re-billing ~4k tokens
  // of cached context (instructions + history, $0.0064) ≈ $0.074/min + a one-time ~$0.012 for the first,
  // uncached instructions → rounded up to $0.08/min. Longer calls cost more per minute (the whole history is
  // re-billed per response); never presented as measured spend.
  openai: { perMinuteMicros: 80_000, source: 'https://developers.openai.com/api/docs/pricing', asOf: '2026-11-21', model: 'gpt-realtime', estimate: true },
  // ESTIMATE: ElevenLabs Agents "additional minute" rate, $0.08/min on every self-serve plan (Free … Business);
  // included plan minutes are prepaid, LLM usage is billed separately on top ("based on the model you choose"),
  // bursts over the concurrency limit cost $0.16/min. Not measured spend.
  elevenlabs: { perMinuteMicros: 80_000, source: 'https://elevenlabs.io/pricing/agents', asOf: '2026-11-21', note: 'estimate: $0.08/min additional-minute rate; LLM usage billed separately by ElevenLabs' },
}

// Per-session settings an admin may choose in the Lab (validated here; anything else is ignored, never passed through).
// OpenAI: the output voice (one of OPENAI_VOICES; default = OPENAI_REALTIME_VOICE or 'marin'). Retell and ElevenLabs
// take voice and turn-taking from their agent configuration, so they accept no per-session settings.
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
export function labSettings(provider, input) {
  const out = {}
  if (provider === 'openai' && input && OPENAI_VOICES.includes(input.voice)) out.voice = input.voice
  return out
}

// The owner's readiness questions per provider, answered from configuration and the code that exists (never by calling
// a provider): built? credentials? account/billing to set up? can a browser session run now? tools safe? transcripts +
// latency recorded? cost? smallest authorized test? Secrets never appear: only the NAMES of missing settings.
const READINESS = {
  retell: {
    name: 'Retell',
    integration: 'Production voice path: Retell does speech and turn-taking, our engine answers every turn as its custom LLM. The Lab runs the same path on an admin-marked test business.',
    needs: ['RETELL_API_KEY', 'RETELL_AGENT_ID', 'RETELL_WS_SECRET'],
    account: 'The GetShowUps Retell account (already in use for production voice). No new account.',
    tools: 'The engine’s own tools on the server, bound to the test business; dry run keeps every booking simulated.',
    settings: 'Voice and turn-taking come from the Retell agent; nothing is chosen per session.',
    smallest: 'One dry-run session on the test business, under 15 minutes.',
  },
  openai: {
    name: 'OpenAI Realtime',
    integration: 'Lab adapter: the browser speaks WebRTC with OpenAI; our server fixes the session (instructions, voice, turn detection) and runs all seven tools.',
    needs: ['OPENAI_API_KEY'],
    account: 'An OpenAI platform account with billing (pay as you go). Adding the key is a paid-service activation (approval).',
    tools: 'Shared Lab tool runner (server/voice/tools.js) with every engine guard; dry run by default.',
    settings: 'Voice per session (built-in voices); model from OPENAI_REALTIME_MODEL.',
    smallest: 'After the key is approved and set: one dry-run session, under 15 minutes (about $0.08 per minute, estimate).',
  },
  elevenlabs: {
    name: 'ElevenLabs',
    integration: 'Lab adapter: ElevenLabs does speech, turn-taking and the model; the agent’s seven tools are client tools the browser forwards to our server.',
    needs: ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'],
    account: 'An ElevenLabs account with an Agents Platform agent (its id) and a plan with conversation minutes. Adding the key is a paid-service activation (approval).',
    tools: 'Shared Lab tool runner (server/voice/tools.js) with every engine guard; dry run by default.',
    settings: 'Voice and model are set on the ElevenLabs agent; nothing is chosen per session.',
    smallest: 'After the key and agent are approved and set: one dry-run session, under 15 minutes (about $0.08 per minute, estimate).',
  },
}
export function providerReadiness(env) {
  const status = providerStatus(env)
  const lab = labEnabled(env)
  return PROVIDERS.map((id) => {
    const r = READINESS[id]
    const configured = status[id].configured
    const missing = configured ? [] : r.needs.filter((k) => !env?.[k])
    const blockers = []
    if (!lab) blockers.push('Voice Lab is switched off (VOICE_LAB_ENABLED)')
    if (!configured) blockers.push(missing.length ? `Not configured: ${missing.join(', ')} not set` : 'Not configured: a setting is present but not usable')
    return {
      id,
      name: r.name,
      integration: { built: true, note: r.integration },
      credentials: { configured, missing },
      account: r.account,
      session: { canRun: lab && configured, note: lab && configured ? 'A browser voice session can start now (admin, test business, dry run).' : blockers.join('; ') },
      tools: r.tools,
      records: { transcripts: true, latency: true, toolOutcomes: true },
      cost: COST_ESTIMATES[id]?.perMinuteMicros ? { perMinuteMicros: COST_ESTIMATES[id].perMinuteMicros, estimate: true, source: COST_ESTIMATES[id].source } : { perMinuteMicros: null, note: id === 'retell' ? 'Billed on the Retell account per minute; not estimated here.' : 'Not estimated.' },
      settings: r.settings,
      smallestTest: r.smallest,
      blockers,
    }
  })
}

export const estimateMicros = (provider, seconds) => {
  const e = COST_ESTIMATES[provider]
  if (!e || !Number.isFinite(e.perMinuteMicros) || !Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round((e.perMinuteMicros * seconds) / 60)
}
