// GET /api/dashboard/overview — results (last 30 days), upcoming appointments, outcomes to record,
// leads to follow up, and automatic-message status, for the signed-in business only.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { overview } from '../../../server/booking.js'
import { messageSummary } from '../../../server/messages.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    const data = await overview(env.ONBOARDING_DB, session.customer.id)
    return json(200, { ...data, automation: await messageSummary(env, session.customer) })
  } catch (err) {
    console.error('overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
