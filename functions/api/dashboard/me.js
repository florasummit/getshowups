// GET /api/dashboard/me — signed-in user, their business (or null), onboarding progress, booking link.
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { progress } from '../../../server/customers.js'
import { signupPlan } from '../../../server/onboarding.js'
import { listPlans } from '../../../server/stripe.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false })
  if (response) return response
  const { customer, email } = session
  // Before a business exists: which plan a new self-serve signup gets (null when billing is off).
  const planId = customer ? null : await signupPlan(env, new URL(request.url).searchParams.get('plan') || '')
  const plan = planId ? (await listPlans(env.ONBOARDING_DB)).find((p) => p.id === planId) : null
  return json(200, {
    signupPlan: plan ? { id: plan.id, name: plan.name, trialDays: plan.trialDays } : null,
    email,
    customer,
    progress: await progress(env, customer),
    bookingUrl: customer ? `${siteOrigin(env)}/book/${customer.id}` : null,
    features: { ads: env.ADS_ENABLED === 'true', ghl: env.GHL_ENABLED === 'true' },
  })
}
