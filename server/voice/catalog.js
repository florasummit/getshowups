// Voice catalog: ONE normalized list of voices per provider, read from the provider (Retell GET /list-voices,
// ElevenLabs GET /v2/voices) or fixed by the provider's documentation (OpenAI Realtime's built-in voices), cached in
// D1 (voice_catalog_cache, 24 h) so dashboards never hit a provider per view. Every voice id a business can store is
// validated against this list: nothing is invented, no capability is claimed that the provider's metadata does not
// carry (gender/accent/age only where the provider states them; OpenAI states none), previews are the provider's own
// public sample URLs (nothing generated, nothing billed, no key in the browser).
//
// Normalized voice: { provider, id, name, preview (https url | null), language (BCP-47-ish | null), accent, gender
// ('feminine' | 'masculine' | null), age, description, available: true }.
import { elevenlabsBase } from './elevenlabs.js'
import { elevenlabsConfigured, openaiConfigured, OPENAI_VOICES } from './providers.js'
import { voiceConfigured } from '../receptionist/voice.js'

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const VOICE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env?.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
// Preview sample URLs: https only (a loopback mock origin is accepted in tests, never in production).
const httpsUrl = (u, mock = null) => (typeof u === 'string' && (/^https:\/\/[^\s"'<>]{8,500}$/.test(u) || (mock && u.startsWith(`${mock}/`))) ? u : null)
const text = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
// Only the provider's own stated values, mapped to presentation terms; anything else is "not stated".
const GENDER = { male: 'masculine', female: 'feminine' }
const gender = (v) => GENDER[String(v || '').toLowerCase()] || null

// OpenAI Realtime: documented built-in voices; the API offers no metadata and no samples.
const openaiCatalog = () => OPENAI_VOICES.map((id) => ({ provider: 'openai', id, name: id.charAt(0).toUpperCase() + id.slice(1), preview: null, language: null, accent: null, gender: null, age: null, description: null, available: true }))

export const normalizeRetellVoice = (v, mock = null) =>
  v && VOICE_ID_RE.test(String(v.voice_id || '')) && text(v.voice_name)
    ? { provider: 'retell', id: String(v.voice_id), name: text(v.voice_name), preview: httpsUrl(v.preview_audio_url, mock), language: null, accent: text(v.accent, 40), gender: gender(v.gender), age: text(v.age, 40), description: null, available: true }
    : null

export const normalizeElevenlabsVoice = (v) => {
  if (!v || !VOICE_ID_RE.test(String(v.voice_id || '')) || !text(v.name)) return null
  const labels = v.labels && typeof v.labels === 'object' ? v.labels : {}
  const langs = Array.isArray(v.verified_languages) ? v.verified_languages.map((l) => text(l?.language, 12)).filter(Boolean) : []
  return { provider: 'elevenlabs', id: String(v.voice_id), name: text(v.name), preview: httpsUrl(v.preview_url), language: langs[0] || (text(labels.language, 12) || null), accent: text(labels.accent, 40), gender: gender(labels.gender), age: text(labels.age, 40), description: text(labels.description || labels.use_case, 80), available: true }
}

async function fetchRetell(env) {
  const res = await fetch(`${retellBase(env)}/list-voices`, { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`retell_http_${res.status}`)
  const data = await res.json()
  const mock = MOCK_RE.test(env?.RETELL_API_MOCK_ORIGIN || '') ? env.RETELL_API_MOCK_ORIGIN : null
  return (Array.isArray(data) ? data : []).map((v) => normalizeRetellVoice(v, mock)).filter(Boolean)
}
async function fetchElevenlabs(env) {
  const res = await fetch(`${elevenlabsBase(env)}/v2/voices?page_size=100`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`elevenlabs_http_${res.status}`)
  const data = await res.json()
  return (Array.isArray(data?.voices) ? data.voices : []).map(normalizeElevenlabsVoice).filter(Boolean)
}

const configured = (env, provider) => (provider === 'retell' ? voiceConfigured(env) : provider === 'openai' ? openaiConfigured(env) : provider === 'elevenlabs' ? elevenlabsConfigured(env) : false)

// → { provider, voices, fetchedAt, source: 'provider' | 'cache' | 'fixed', stale?: true, error?: code }. Never throws:
// a provider or cache failure returns the last cached list (stale) or an empty list with an error code.
export async function catalogFor(env, provider, { now = Date.now(), refresh = false } = {}) {
  if (provider === 'openai') return { provider, voices: openaiConfigured(env) ? openaiCatalog() : [], fetchedAt: now, source: 'fixed', ...(openaiConfigured(env) ? {} : { error: 'not_configured' }) }
  if (provider !== 'retell' && provider !== 'elevenlabs') return { provider, voices: [], fetchedAt: now, source: 'fixed', error: 'unknown_provider' }
  const db = env.ONBOARDING_DB
  let cached = null
  try {
    const r = await db.prepare('SELECT voices, fetched_at FROM voice_catalog_cache WHERE provider = ?1').bind(provider).first()
    if (r) cached = { voices: JSON.parse(r.voices), fetchedAt: Number(r.fetched_at) }
  } catch {
    cached = null // table missing (migration not applied yet) → no cache, nothing breaks
  }
  if (cached && !refresh && now - cached.fetchedAt < CATALOG_TTL_MS) return { provider, voices: cached.voices, fetchedAt: cached.fetchedAt, source: 'cache' }
  if (!configured(env, provider)) return { provider, voices: cached?.voices || [], fetchedAt: cached?.fetchedAt || now, source: cached ? 'cache' : 'fixed', error: 'not_configured', ...(cached ? { stale: true } : {}) }
  try {
    const voices = provider === 'retell' ? await fetchRetell(env) : await fetchElevenlabs(env)
    if (!voices.length) throw new Error('empty_catalog')
    try {
      await db.prepare('INSERT INTO voice_catalog_cache (provider, voices, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(provider) DO UPDATE SET voices = ?2, fetched_at = ?3').bind(provider, JSON.stringify(voices), now).run()
    } catch {
      /* cache table missing: still answer from the provider */
    }
    return { provider, voices, fetchedAt: now, source: 'provider' }
  } catch (err) {
    const code = /^(retell|elevenlabs)_http_\d+$|^empty_catalog$/.test(err?.message || '') ? err.message : 'provider_unreachable'
    if (cached) return { provider, voices: cached.voices, fetchedAt: cached.fetchedAt, source: 'cache', stale: true, error: code }
    return { provider, voices: [], fetchedAt: now, source: 'fixed', error: code }
  }
}

export const findVoice = (catalog, id) => (catalog?.voices || []).find((v) => v.id === id) || null

// A voice id a business wants to store: well-formed AND present in that provider's current catalog. An unreachable
// provider with no cache refuses (catalog_unavailable) rather than accepting an id nobody has seen.
export async function validateVoice(env, provider, voiceId, opts = {}) {
  const id = String(voiceId || '')
  if (!VOICE_ID_RE.test(id)) return { ok: false, error: 'invalid_voice_id' }
  const catalog = await catalogFor(env, provider, opts)
  if (!catalog.voices.length) return { ok: false, error: catalog.error === 'not_configured' ? 'provider_not_configured' : 'catalog_unavailable' }
  const voice = findVoice(catalog, id)
  return voice ? { ok: true, voice, catalog } : { ok: false, error: 'voice_unknown' }
}
