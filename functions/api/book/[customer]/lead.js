// POST /api/book/:customer/lead — capture a lead from the booking page and qualify it (service area).
//   Body: { name, email, phone, need, zip?, zipConfirmed?, website? }  (website is a honeypot and must be empty)
// Returns { leadId, leadToken, qualified, coverage }. The token lets only this browser book for this lead.
// 400 invalid_zip (not a ZIP) / unknown_zip (not a known ZIP area; resend with zipConfirmed: true to keep it as typed).
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { createLead, validateLead } from '../../../../server/booking.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { recordAttribution } from '../../../../server/ads/attribution.js'
import { syncLead } from '../../../../server/ghl.js'

export async function onRequestPost({ request, env, params, waitUntil }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'bookLead', request), await hit(env, 'bookLeadPerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  const body = await request.json().catch(() => null)
  if (body?.website) return json(400, { error: 'invalid_request' })
  const [error, lead] = validateLead(body, customer.appointmentMode)
  if (error) return json(400, { error })
  if (customer.serviceZips.length && !lead.zip) return json(400, { error: 'invalid_zip' })
  try {
    const { id, token, qualified, coverage } = await createLead(env, customer, lead)
    // Best effort: attribution and the GoHighLevel copy never block or fail the lead.
    const sideEffects = (async () => {
      await recordAttribution(env, customer.id, id, body.attribution).catch((e) => console.error('attribution failed:', e?.name))
      await syncLead(env, customer.id, id).catch((e) => console.error('ghl sync failed:', e?.name))
    })()
    if (typeof waitUntil === 'function') waitUntil(sideEffects)
    else await sideEffects
    // Not in a listed ZIP: the lead is kept with its attribution and waits for the owner's coverage decision
    // (coverage 'pending'); the browser shows "we'll confirm availability", never times.
    return json(201, { leadId: id, leadToken: token, qualified, coverage })
  } catch (err) {
    console.error('lead save failed:', customer.id, err?.message)
    return json(503, { error: 'storage_error' })
  }
}
