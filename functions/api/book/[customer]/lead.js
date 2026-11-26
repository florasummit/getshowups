// POST /api/book/:customer/lead — capture a lead from the booking page and qualify it (service area).
//   Body: { name, email, phone, need?, serviceId?, answer?, zip?, zipConfirmed?, website? }  (website is a honeypot)
//   serviceId: one of the page's services (server/services.js); '' = Other / Not sure (then `need` is the open text).
//   The stored need is "Service: answer", so every existing view, message and calendar event reads as before.
// Returns { leadId, leadToken, qualified, coverage, flow }. The token lets only this browser book for this lead.
// flow 'request': a quote / consultation request (no time is booked; no "pick a time" follow-ups).
// Field rules: server/lead-fields.js (shared with the page; a phone number needs its area code here). A submission
// refused for a missing or malformed field is answered before the attempt limits are counted (429 + Retry-After).
// 400 invalid_zip (not a ZIP) / unknown_zip (not a known ZIP area; resend with zipConfirmed: true to keep it as typed).
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { createLead, validateLead } from '../../../../server/booking.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { recordAttribution } from '../../../../server/ads/attribution.js'
import { syncLead } from '../../../../server/ghl.js'
import { getProfile } from '../../../../server/onboarding.js'
import { bookingOptions, bookingServices, needText, recordLeadService, resolveChoice } from '../../../../server/services.js'

export async function onRequestPost({ request, env, params, waitUntil }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (body?.website) return json(400, { error: 'invalid_request' })
  // The cheap checks first (no storage): a submission refused for a missing or malformed field never uses up the
  // visitor's attempts. A chosen service supplies the need itself, so only its presence stands in here; the full
  // check with the real text runs again below.
  const picked = typeof body?.serviceId === 'string' && body.serviceId !== ''
  const [early] = validateLead({ ...body, need: picked ? 'service' : body?.need }, customer.appointmentMode, { fullNumber: true })
  if (early) return json(400, { error: early })
  if (customer.serviceZips.length && customer.appointmentMode !== 'at_customer' && !String(body?.zip ?? '').trim()) return json(400, { error: 'invalid_zip' })
  // Only a well-formed submission counts toward the limits (per visitor and per business; values in server/ratelimit.js).
  for (const rl of [await hitByIp(env, 'bookLead', request), await hit(env, 'bookLeadPerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  const db = env.ONBOARDING_DB
  const [profile, options] = await Promise.all([getProfile(db, customer.id).catch(() => null), bookingOptions(db, customer.id).catch(() => ({ allowOther: true }))])
  const services = bookingServices(profile?.services, customer.slotMinutes)
  // A service removed or hidden since the page loaded → service_unavailable (the page reloads the list).
  const [choiceError, choice] = resolveChoice(body, services, options.allowOther)
  if (choiceError) return json(400, { error: choiceError })
  const [error, lead] = validateLead({ ...body, need: needText(choice, body?.need) }, customer.appointmentMode, { fullNumber: true })
  if (error) return json(400, { error })
  const flow = choice.service?.flow === 'request' ? 'request' : 'book'
  if (flow === 'request') lead.request = true
  if (customer.serviceZips.length && !lead.zip) return json(400, { error: 'invalid_zip' })
  try {
    const { id, token, qualified, coverage } = await createLead(env, customer, lead)
    // Which service it was for, as the customer saw it (history and reports survive renames and removals).
    await recordLeadService(db, { leadId: id, customer: customer.id, choice, minutes: choice.service?.minutes ?? null }).catch((e) => console.error('lead service failed:', e?.name))
    // Best effort: attribution and the GoHighLevel copy never block or fail the lead.
    const sideEffects = (async () => {
      await recordAttribution(env, customer.id, id, body.attribution).catch((e) => console.error('attribution failed:', e?.name))
      await syncLead(env, customer.id, id).catch((e) => console.error('ghl sync failed:', e?.name))
    })()
    if (typeof waitUntil === 'function') waitUntil(sideEffects)
    else await sideEffects
    // Not in a listed ZIP: the lead is kept with its attribution and waits for the owner's coverage decision
    // (coverage 'pending'); the browser shows "we'll confirm availability", never times.
    return json(201, { leadId: id, leadToken: token, qualified, coverage, flow })
  } catch (err) {
    console.error('lead save failed:', customer.id, err?.message)
    return json(503, { error: 'storage_error' })
  }
}
