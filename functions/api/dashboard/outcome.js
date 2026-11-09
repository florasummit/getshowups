// POST /api/dashboard/outcome — record what happened after a past appointment.
//   Body: { id, outcome: "showed" | "no_show", work?: "completed" | "not_completed", valueCents?: integer }
//   'showed' = it happened (customer attended / technician visited); work = whether the job was done.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { setOutcome } from '../../../server/booking.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const result = await setOutcome(env, session.customer, body?.id, body?.outcome, { work: body?.work, valueCents: body?.valueCents })
  return result.ok ? json(200, result.appointment) : json(result.httpStatus, { error: result.error })
}
