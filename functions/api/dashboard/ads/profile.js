// POST /api/dashboard/ads/profile — save what GetShowUps needs to plan ads (services, area, value, claims).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { validateProfile, saveProfile } from '../../../../server/ads/campaigns.js'

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'adsWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { errors, profile } = validateProfile(await request.json().catch(() => null))
  if (errors) return json(400, { error: 'invalid_profile', fields: errors })
  try {
    await saveProfile(env.ONBOARDING_DB, session.customer.id, profile)
  } catch (err) {
    console.error('ads profile save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  return json(200, { profile })
}
