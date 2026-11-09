// POST /api/dashboard/hours — save booking hours (also completes that onboarding step).
//   Body: { workdays: [1,2,3,4,5], dayStart: "09:00", dayEnd: "17:00", slotMinutes: 60 }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { progress, updateHours, validateHours } from '../../../server/customers.js'
import { track } from '../../../server/events.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const [error, hours] = validateHours(await request.json().catch(() => null))
  if (error) return json(400, { error })
  try {
    await updateHours(env.ONBOARDING_DB, session.customer.id, hours)
  } catch (err) {
    console.error('hours save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  const customer = { ...session.customer, hoursConfirmed: true }
  if ((await progress(env, customer)).complete) {
    await track(env, 'setup_completed', { id: `setup_completed:${customer.id}`, customer: customer.id })
  }
  return json(200, { ok: true })
}
