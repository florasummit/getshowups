// GET /api/page/:customer — public landing page content. Only for a published page of a bookable
// business; otherwise 404 (indistinguishable from an unknown business). No contact details.
import { json } from '../../../server/google-oauth.js'
import { bookableCustomer } from '../../../server/public.js'
import { getPage } from '../../../server/landing.js'
import { hitByIp, tooManyJson } from '../../../server/ratelimit.js'

export async function onRequestGet({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const rl = await hitByIp(env, 'pageView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const page = await getPage(env.ONBOARDING_DB, customer.id)
  if (!page?.published) return json(404, { error: 'not_found' })
  const { headline, intro, services, area, highlights } = page
  return json(200, { name: customer.name, appointmentMode: customer.appointmentMode, headline, intro, services, area, highlights })
}
