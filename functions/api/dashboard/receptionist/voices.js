// GET /api/dashboard/receptionist/voices[?provider=<id>&refresh=1] — the voice catalog the owner may choose from:
// the business's ACTIVE provider's voices (normalized, with the provider's own public preview URLs; no key, no
// generated audio). `provider` (another provider) and `refresh` (re-read from the provider) are platform-admin only.
// Session business only; read-only; rate-limited per business (the catalog is cached 24 h, so this is cheap).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { catalogFor, getVoiceSettings, isPlatformAdminEmail, PROVIDER_CAPABILITIES } from '../../../../server/voice/settings.js'
import { PROVIDERS } from '../../../../server/voice/providers.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const rl = await hit(env, 'voiceCatalog', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const url = new URL(request.url)
  const admin = isPlatformAdminEmail(env, session.email)
  const current = await getVoiceSettings(env.ONBOARDING_DB, session.customer.id)
  const asked = url.searchParams.get('provider')
  const provider = admin && PROVIDERS.includes(asked) ? asked : current.provider
  const refresh = admin && url.searchParams.get('refresh') === '1'
  const c = await catalogFor(env, provider, { refresh })
  const cap = PROVIDER_CAPABILITIES[provider]
  // Owners never see a provider name; admins do (they are choosing between providers).
  return json(200, {
    ...(admin ? { provider } : {}),
    voices: c.voices.map((v) => ({ id: v.id, name: v.name, preview: cap.previews ? v.preview : null, language: v.language, accent: v.accent, gender: v.gender, age: v.age, description: v.description })),
    fetchedAt: c.fetchedAt,
    ...(c.stale ? { stale: true } : {}),
    ...(c.error ? { error: c.error } : {}),
    capabilities: { previews: cap.previews, pace: cap.pace, languages: cap.languages },
  })
}
