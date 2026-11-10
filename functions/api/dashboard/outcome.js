// POST /api/dashboard/outcome — record what happened after a past appointment.
//   Body: { id, outcome: "showed" | "no_show" | "clear", work?: "completed" | "not_completed", valueCents?: integer }
//   Outcomes can be corrected at any time ("clear" = back to not recorded); every change is kept.
//   'showed' = it happened (customer attended / technician visited); work = whether the job was done.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { setOutcome } from '../../../server/booking.js'
import { syncStage } from '../../../server/ghl.js'

export async function onRequestPost({ request, env, waitUntil }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const result = await setOutcome(env, session.customer, body?.id, body?.outcome, { work: body?.work, valueCents: body?.valueCents, by: session.email })
  if (!result.ok) return json(result.httpStatus, { error: result.error })
  // Best-effort GoHighLevel pipeline copy. Showing up is not job completion.
  const a = result.appointment
  if (a.status === 'booked') return json(200, a)
  const stage = a.status === 'no_show' ? 'noShow' : a.work === 'completed' ? 'completed' : 'showed'
  const sync = syncStage(env, session.customer.id, result.leadId, stage, stage === 'completed' ? a.valueCents : undefined).catch((e) => console.error('ghl stage failed:', e?.name))
  if (typeof waitUntil === 'function') waitUntil(sync)
  else await sync
  return json(200, a)
}
