// Receptionist voice style: the constants and the one read every path shares (engine prompt, Retell web call,
// Lab sessions, dashboard). No imports, so nothing here can form a cycle with the engine (providers.js lists the
// same three ids; a test keeps them equal).
export const PROVIDER_IDS = ['retell', 'openai', 'elevenlabs']

// What each provider can do TODAY in this codebase (never inferred from a Lab session working). `customers`: the
// customer-facing browser voice path exists (functions/api/receptionist/[customer]/voice.js → Retell). `phone`: no
// provider has a phone line here (routing.js is simulated; no numbers provisioned). `lab`: Voice Lab adapter.
export const PROVIDER_CAPABILITIES = {
  retell: { name: 'Retell', customers: true, lab: true, phone: false, pace: true, previews: true, voiceChoice: true, languages: ['en'] },
  openai: { name: 'OpenAI Realtime', customers: false, lab: true, phone: false, pace: false, previews: false, voiceChoice: true, languages: ['en'] },
  elevenlabs: { name: 'ElevenLabs', customers: false, lab: true, phone: false, pace: true, previews: true, voiceChoice: true, languages: ['en'] },
}
// Providers a business may be switched TO for customers: a customer-facing path must exist in the code.
export const LIVE_PROVIDERS = PROVIDER_IDS.filter((p) => PROVIDER_CAPABILITIES[p].customers)
export const DEFAULT_PROVIDER = 'retell'

// Personality presets: fixed wording appended to the receptionist's prompt (chat and voice). Style only: no preset
// can change facts, prices, area rules, booking guards or tools (those live in the engine and its tools).
export const PERSONALITIES = {
  standard: { name: 'Balanced', blurb: 'Warm, brief and natural, the way it sounds today.', prompt: '' },
  warm: { name: 'Warm & Friendly', blurb: 'Friendly and personable, like a neighbour who runs the front desk.', prompt: '# Personality\nWarm and friendly: greet people like a neighbour, use their name once you know it, sound glad they called, keep it light without jokes. Still brief.' },
  professional: { name: 'Professional & Polished', blurb: 'Courteous, precise and efficient.', prompt: '# Personality\nProfessional and polished: courteous, precise, efficient; complete sentences, no slang, no exclamation marks; confirm details back clearly.' },
  calm: { name: 'Calm & Reassuring', blurb: 'Steady and patient, good for stressed or urgent callers.', prompt: "# Personality\nCalm and reassuring: unhurried, patient, steady; acknowledge a problem before moving on (\"That sounds frustrating; let's get it sorted\"), one step at a time." },
  upbeat: { name: 'Upbeat & Energetic', blurb: 'Bright and quick, with momentum toward the next step.', prompt: '# Personality\nUpbeat and energetic: bright, positive, quick to the point; move things forward with enthusiasm without pushing.' },
}
export const PACES = { slower: { name: 'A little slower', retell: 0.9, elevenlabs: 0.9 }, normal: { name: 'Normal', retell: 1, elevenlabs: 1 }, faster: { name: 'A little faster', retell: 1.1, elevenlabs: 1.1 } }
export const personalityPrompt = (p) => PERSONALITIES[p]?.prompt || ''
// Provider-specific pace value, or null when the provider does not support pace (never sent).
export const paceFor = (provider, pace) => (PROVIDER_CAPABILITIES[provider]?.pace && PACES[pace] ? PACES[pace][provider] : null)

export const VOICE_DEFAULTS = Object.freeze({ provider: DEFAULT_PROVIDER, voiceId: null, voiceName: null, personality: 'standard', pace: 'normal', language: 'en', previous: null, version: 0, updatedAt: null })
export const voiceFromRow = (r) => (r ? { provider: r.provider, voiceId: r.voice_id || null, voiceName: r.voice_name || null, personality: r.personality || 'standard', pace: r.pace || 'normal', language: r.language || 'en', previous: r.previous ? JSON.parse(r.previous) : null, version: Number(r.version) || 0, updatedAt: Number(r.updated_at) || null } : { ...VOICE_DEFAULTS })

// Fails soft: before migration 0035 (or on a storage error) every business has the defaults, nothing breaks.
export async function getVoiceSettings(db, customerId) {
  try {
    return voiceFromRow(await db.prepare('SELECT * FROM receptionist_voice_settings WHERE customer = ?1').bind(customerId).first())
  } catch {
    return { ...VOICE_DEFAULTS }
  }
}

// The provider-specific voice settings a session should apply for this business (used by the Retell web call, the
// ElevenLabs session and the OpenAI session): null when the business runs the provider's defaults.
//   retell → { voice_id?, voice_speed? } (create-web-call agent_override.agent)
//   elevenlabs → { voiceId?, speed? } (conversation_config_override.tts)   openai → { voice? }
export function sessionVoiceFor(provider, s) {
  if (!s || s.provider !== provider) return null
  const out = {}
  if (provider === 'retell') {
    if (s.voiceId) out.voice_id = s.voiceId
    const sp = paceFor('retell', s.pace)
    if (sp && sp !== 1) out.voice_speed = sp
  } else if (provider === 'elevenlabs') {
    if (s.voiceId) out.voiceId = s.voiceId
    const sp = paceFor('elevenlabs', s.pace)
    if (sp && sp !== 1) out.speed = sp
  } else if (provider === 'openai') {
    if (s.voiceId) out.voice = s.voiceId
  }
  return Object.keys(out).length ? out : null
}
