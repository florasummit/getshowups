// GET /api/dashboard/me — signed-in user, their business (or null), onboarding progress, booking link.
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { progress } from '../../../server/customers.js'
import { signupPlan } from '../../../server/onboarding.js'
import { billingMisconfigured, listPlans, sandboxCheckoutAllowed, stripeConfigured } from '../../../server/stripe.js'
import { adsAccess } from '../../../server/ads/access.js'
import { deletionEnabled, deletionStatus } from '../../../server/deletion.js'
import { testStatus } from '../../../server/testbusiness.js'
import { studioAccess } from '../../../server/intelligence/access.js'
import { phoneEnabled } from '../../../server/telephony/lines.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false })
  if (response) return response
  const { customer, email } = session
  // Before a business exists: which plan a new self-serve signup gets (null when billing is off).
  const planId = customer ? null : await signupPlan(env, new URL(request.url).searchParams.get('plan') || '')
  const plan = planId ? (await listPlans(env.ONBOARDING_DB)).find((p) => p.id === planId) : null
  return json(200, {
    signupPlan: plan ? { id: plan.id, name: plan.name, trialDays: plan.trialDays } : null,
    // Whether this person can buy online now (false while billing is sandbox-only and they aren't an authorized tester),
    // so the signup says so BEFORE a business is created. null when billing isn't configured.
    checkoutOpen: stripeConfigured(env) ? await sandboxCheckoutAllowed(env, customer?.id || null, email) : billingMisconfigured(env) ? false : null,
    email,
    customer,
    closing: customer?.status === 'suspended' ? await deletionStatus(env.ONBOARDING_DB, customer.id).then((x) => x?.report?.scheduledFor ?? null, () => null) : null,
    // Admin-marked test business: browser acceptance (scripts/acceptance) refuses to run anywhere else. Unreadable = not confirmed.
    testBusiness: customer ? await testStatus(env, customer.id).then((t) => t.test === true && !t.unreadable) : false,
    progress: await progress(env, customer),
    bookingUrl: customer ? `${siteOrigin(env)}/book/${customer.id}` : null,
    // Ads and Teach Your AI: every eligible business (server/eligibility.js), nothing to switch on per business.
    features: { ads: customer ? await adsAccess(env, customer) : false, ghl: env.GHL_ENABLED === 'true', accountDeletion: Boolean(customer) && deletionEnabled(env), teachAi: customer ? await studioAccess(env, customer).catch(() => false) : false, phone: Boolean(customer) && phoneEnabled(env) },
  })
}
