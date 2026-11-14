// POST /api/dashboard/appointment-cancel — { id, confirm: true }: the owner cancels an upcoming appointment.
// Removes the Google Calendar event first (Google notifies the attendee), then marks it cancelled; reminders stop.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { cancelAppointment } from '../../../server/booking.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  try {
    const r = await cancelAppointment(env, session.customer, body.id, { by: session.email })
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    return json(200, { status: r.status })
  } catch (err) {
    console.error('appointment cancel failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
