// GET /api/dashboard/overview — results (last 30 days), upcoming appointments, outcomes to record,
// and leads to follow up, for the signed-in business only.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { overview } from '../../../server/booking.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, await overview(env.ONBOARDING_DB, session.customer.id))
  } catch (err) {
    console.error('overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
