// /api/dashboard/policies — what customers should know (shown on the booking page and in confirmations/reminders).
//   GET  → { policies: { beforeVisit, cancellation } }
//   POST { beforeVisit, cancellation } (each ≤ 300 characters, empty = not shown)
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { getPolicies, savePolicies, validatePolicies } from '../../../server/policies.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { policies: await getPolicies(env.ONBOARDING_DB, session.customer.id) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const [errors, policies] = validatePolicies(await request.json().catch(() => null))
  if (errors.length) return json(400, { error: 'invalid_policies', fields: errors })
  try {
    await savePolicies(env.ONBOARDING_DB, session.customer.id, policies)
  } catch (err) {
    console.error('policies save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
  return json(200, { policies })
}
