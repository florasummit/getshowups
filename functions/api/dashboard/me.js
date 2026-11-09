// GET /api/dashboard/me — signed-in user, their business (or null), onboarding progress, booking link.
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { progress } from '../../../server/customers.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false })
  if (response) return response
  const { customer, email } = session
  return json(200, {
    email,
    customer,
    progress: await progress(env, customer),
    bookingUrl: customer ? `${siteOrigin(env)}/book/${customer.id}` : null,
    features: { ads: env.ADS_ENABLED === 'true', ghl: env.GHL_ENABLED === 'true' },
  })
}
