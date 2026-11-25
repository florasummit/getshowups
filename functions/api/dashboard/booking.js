// /api/dashboard/booking — the owner's booking-page options and how the page performed (services themselves are saved
// through /api/dashboard/profile: one catalog, server/services.js).
//   GET  → { options: { allowOther, ready }, funnel (last 30 days, server/booking-funnel.js), slotMinutes, bookingUrl }
//   POST { allowOther: boolean } → { options }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { bookingOptions, saveBookingOptions } from '../../../server/services.js'
import { bookingFunnel } from '../../../server/booking-funnel.js'

const DAY = 24 * 60 * 60 * 1000

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const id = session.customer.id
  const db = env.ONBOARDING_DB
  const [options, funnel] = await Promise.all([bookingOptions(db, id), bookingFunnel(db, id, Date.now() - 30 * DAY).catch(() => null)])
  return json(200, { options, funnel, slotMinutes: session.customer.slotMinutes, bookingUrl: `/book/${id}` })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (typeof body?.allowOther !== 'boolean') return json(400, { error: 'invalid_request' })
  const db = env.ONBOARDING_DB
  const current = await bookingOptions(db, session.customer.id).catch(() => ({ ready: false }))
  if (!current.ready) return json(409, { error: 'not_ready' })
  try {
    await saveBookingOptions(db, session.customer.id, { allowOther: body.allowOther })
  } catch (err) {
    console.error('booking options save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
  return json(200, { options: { ready: true, allowOther: body.allowOther } })
}
