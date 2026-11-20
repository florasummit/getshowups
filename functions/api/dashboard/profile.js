// /api/dashboard/profile — business details used by onboarding and the landing page.
//   GET  → { profile | null }
//   POST { phone?, industry, description?, services?: [{ name, price? }], cities?, requireServices? }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { getProfile, saveProfile, validateProfile } from '../../../server/onboarding.js'
import { isStale } from '../../../server/stale.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { profile: await getProfile(env.ONBOARDING_DB, session.customer.id) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const [errors, profile] = validateProfile(body, { requireServices: body?.requireServices === true })
  if (errors.length) return json(400, { error: 'invalid_profile', fields: errors })
  try {
    // `base` (the details the page loaded): changed elsewhere since → 409 with the current details, nothing replaced.
    const current = await getProfile(env.ONBOARDING_DB, session.customer.id)
    if (isStale(body, current)) return json(409, { error: 'conflict', current })
    await saveProfile(env.ONBOARDING_DB, session.customer.id, profile)
  } catch (err) {
    console.error('profile save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  return json(200, { profile })
}
