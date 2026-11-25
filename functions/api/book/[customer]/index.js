// GET /api/book/:customer[?service=<id>] — public booking page data: business name, its bookable services (one catalog:
// server/services.js), its published brand, and real open slots for the chosen service's length (no service = one slot).
// Exposes no contact details, settings beyond what a visitor needs, or calendar contents.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { openSlots, recordAvailability } from '../../../../server/booking.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { offerSmsFor } from '../../../../server/followups/settings.js'
import { policiesOrEmpty } from '../../../../server/policies.js'
import { getProfile } from '../../../../server/onboarding.js'
import { bookingOptions, bookingServices } from '../../../../server/services.js'
import { publicBrand } from '../../../../server/public-brand.js'

export async function onRequestGet({ request, env, params, waitUntil }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const db = env.ONBOARDING_DB
  const [profile, options, brand] = await Promise.all([getProfile(db, customer.id).catch(() => null), bookingOptions(db, customer.id).catch(() => ({ allowOther: true })), publicBrand(env, customer)])
  const services = bookingServices(profile?.services, customer.slotMinutes)
  const wanted = new URL(request.url).searchParams.get('service')
  const chosen = wanted ? services.find((x) => x.id === wanted) : null
  const span = chosen ? Math.min(4, Math.max(1, Math.round(chosen.minutes / customer.slotMinutes))) : 1
  const [result, policies] = await Promise.all([openSlots(env, customer, Date.now(), { span }), policiesOrEmpty(db, customer.id)])
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
    // A service area exists: the page asks for the ZIP before showing times (also for visits, then prefills the address).
    areaCheck: customer.serviceZips.length > 0,
    // The services a customer can pick (hidden and not-bookable ones left out), and whether "Other / Not sure" is offered.
    services,
    allowOther: services.length ? options.allowOther : true,
    // The business's own published logo and accent (GetShowUps' own page: product: true).
    brand,
    minutes: chosen ? chosen.minutes : customer.slotMinutes,
    // Texting box: offered once the owner approved submitting the business's texting registration (carriers review
    // the live opt-in before approving). Texts themselves still wait for the provider's approval (smsReadiness).
    offerSms: await offerSmsFor(env, customer),
    // What customers should know, written by the owner (empty notes are left out).
    policies,
    status: result.ok ? 'ok' : 'unavailable',
    slots: result.ok ? result.slots.map((s) => new Date(s.start).toISOString()) : [],
  })
}
