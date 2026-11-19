// GET /api/book/:customer — public booking page data: business name and real open slots.
// Exposes no contact details, settings beyond what a visitor needs, or calendar contents.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { openSlots, recordAvailability } from '../../../../server/booking.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { offerSmsFor } from '../../../../server/followups/settings.js'
import { policiesOrEmpty } from '../../../../server/policies.js'

export async function onRequestGet({ request, env, params, waitUntil }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const [result, policies] = await Promise.all([openSlots(env, customer), policiesOrEmpty(env.ONBOARDING_DB, customer.id)])
  // A lookup that failed for an integration reason (never "no free time") → Business Review (throttled; never throws).
  const recorded = recordAvailability(env, customer.id, result)
  if (typeof waitUntil === 'function') waitUntil(recorded)
  else await recorded
  return json(200, {
    name: customer.name,
    timezone: customer.timezone,
    slotMinutes: customer.slotMinutes,
    // 'at_customer': the business comes to the lead, so the page asks for a service address.
    appointmentMode: customer.appointmentMode,
    askZip: customer.appointmentMode !== 'at_customer' && customer.serviceZips.length > 0,
    // Texting box: offered once the owner approved submitting the business's texting registration (carriers review
    // the live opt-in before approving). Texts themselves still wait for the provider's approval (smsReadiness).
    offerSms: await offerSmsFor(env, customer),
    // What customers should know, written by the owner (empty notes are left out).
    policies,
    status: result.ok ? 'ok' : 'unavailable',
    slots: result.ok ? result.slots.map((s) => new Date(s.start).toISOString()) : [],
  })
}
