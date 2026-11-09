// POST /api/dashboard/outcome — mark a past appointment as showed or no_show.
//   Body: { id, outcome: "showed" | "no_show" }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { setOutcome } from '../../../server/booking.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const result = await setOutcome(env, session.customer.id, body?.id, body?.outcome)
  return result.ok ? json(200, result.appointment) : json(result.httpStatus, { error: result.error })
}
