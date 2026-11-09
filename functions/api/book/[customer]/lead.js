// POST /api/book/:customer/lead — capture a lead from the booking page and qualify it (service area).
//   Body: { name, email, phone, need, zip?, website? }  (website is a honeypot and must be empty)
// Returns { leadId, leadToken, qualified }. The token lets only this browser book for this lead.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { createLead, validateLead } from '../../../../server/booking.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'bookLead', request), await hit(env, 'bookLeadPerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  const body = await request.json().catch(() => null)
  if (body?.website) return json(400, { error: 'invalid_request' })
  const [error, lead] = validateLead(body)
  if (error) return json(400, { error })
  if (customer.serviceZips.length && !lead.zip) return json(400, { error: 'invalid_zip' })
  try {
    const { id, token, qualified } = await createLead(env, customer, lead)
    return json(201, { leadId: id, leadToken: token, qualified })
  } catch (err) {
    console.error('lead save failed:', customer.id, err?.message)
    return json(503, { error: 'storage_error' })
  }
}
