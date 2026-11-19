// POST /api/book/:customer/appointment — book a real slot for a captured, qualified lead.
//   Body: { leadId, leadToken, start: "<ISO time of an offered slot>" }
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { bookAppointment, dispatchBooked } from '../../../../server/booking.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { syncStage } from '../../../../server/ghl.js'

export async function onRequestPost({ request, env, params, waitUntil }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const rl = await hitByIp(env, 'bookAppointment', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const start = Date.parse(body?.start)
  let result
  try {
    result = await bookAppointment(env, customer, { leadId: body?.leadId, leadToken: body?.leadToken, start: Number.isFinite(start) ? start : NaN })
  } catch (err) {
    console.error('booking failed:', customer.id, err?.message)
    return json(503, { error: 'storage_error' })
  }
  if (!result.ok) return json(result.httpStatus, { error: result.error })
  const sync = syncStage(env, customer.id, body.leadId, 'booked').catch((e) => console.error('ghl stage failed:', e?.name))
  // Confirmation + owner notice now, not at the next cron run (dispatchBooked never throws; the cron is the fallback).
  // Only with waitUntil (always there in production): the response never waits for it.
  if (typeof waitUntil === 'function') {
    waitUntil(sync)
    waitUntil(dispatchBooked(env, result.appointment.id))
  } else await sync
  const { start: s, end } = result.appointment
  return json(201, { start: new Date(s).toISOString(), end: new Date(end).toISOString(), timezone: customer.timezone, name: customer.name })
}
