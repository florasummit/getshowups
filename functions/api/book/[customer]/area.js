// GET /api/book/:customer/area?zip=29464 — before showing times, is this ZIP one the business books online?
//   → { area: 'in' | 'outside' | 'unknown' | 'invalid' }
// 'outside' / 'unknown' are never a refusal: the page asks for details and the owner decides (server/coverage.js), as
// it always did. Same rule as the lead itself (server/zipcode.js areaFor); nothing is stored; rate-limited on its own allowance.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { areaFor, checkZip } from '../../../../server/zipcode.js'

export async function onRequestGet({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const rl = await hitByIp(env, 'bookArea', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { zip, check } = checkZip(new URL(request.url).searchParams.get('zip') || '')
  if (check === 'invalid') return json(200, { area: 'invalid' })
  const area = areaFor(customer, zip, check)
  return json(200, { area: area === 'in' ? 'in' : check === 'unknown' ? 'unknown' : 'outside' })
}
