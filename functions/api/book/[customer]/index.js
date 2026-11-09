// GET /api/book/:customer — public booking page data: business name and real open slots.
// Exposes no contact details, settings beyond what a visitor needs, or calendar contents.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { openSlots } from '../../../../server/booking.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestGet({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const result = await openSlots(env, customer)
  return json(200, {
    name: customer.name,
    timezone: customer.timezone,
    slotMinutes: customer.slotMinutes,
    askZip: customer.serviceZips.length > 0,
    status: result.ok ? 'ok' : 'unavailable',
    slots: result.ok ? result.slots.map((s) => new Date(s.start).toISOString()) : [],
  })
}
