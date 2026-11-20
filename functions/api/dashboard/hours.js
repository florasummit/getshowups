// POST /api/dashboard/hours — save booking hours (also completes that onboarding step).
//   Body: { workdays: [1,2,3,4,5], dayStart: "09:00", dayEnd: "17:00", slotMinutes: 60 }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { progress, updateHours, validateHours } from '../../../server/customers.js'
import { track } from '../../../server/events.js'
import { hoursOf, isStale } from '../../../server/stale.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const [error, hours] = validateHours(body)
  if (error) return json(400, { error })
  // `base` (the hours the page started from; session.customer is read fresh for this request): changed elsewhere since
  // → 409 with the current hours, nothing replaced.
  if (isStale(body, hoursOf(session.customer))) return json(409, { error: 'conflict', current: hoursOf(session.customer) })
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
  return json(200, { ok: true, hours })
}
