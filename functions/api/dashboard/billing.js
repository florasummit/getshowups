// GET  /api/dashboard/billing — plans and this business's subscription (configured: false if Stripe is off).
// POST /api/dashboard/billing — { action: "checkout", plan } or { action: "portal" } → { url }.
// Available even when the account is suspended, so the owner can always pay or reactivate.
// `billed`: whether this business pays for GetShowUps. Pilot / invited / admin-created businesses
// (no self-serve signup and no real subscription) are exempt: no plan card, and checkout is refused,
// so no placeholder billing record is ever created for them.
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { createCheckout, createPortal, getSubscription, listPlans, stripeConfigured } from '../../../server/stripe.js'
import { getSignup } from '../../../server/onboarding.js'

const isBilled = async (db, customerId, sub) => Boolean(sub?.stripeSubscriptionId) || Boolean(await getSignup(db, customerId))

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!stripeConfigured(env)) return json(200, { configured: false })
  const sub = await getSubscription(env.ONBOARDING_DB, session.customer.id)
  const plans = (await listPlans(env.ONBOARDING_DB)).map(({ id, name, trialDays, entitlements }) => ({ id, name, trialDays, entitlements }))
  return json(200, {
    configured: plans.length > 0,
    billed: await isBilled(env.ONBOARDING_DB, session.customer.id, sub),
    plans,
    subscription: sub && { status: sub.status, planId: sub.planId, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, manageable: Boolean(sub.stripeCustomerId) },
  })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!stripeConfigured(env)) return json(503, { error: 'billing_not_configured' })
  const body = (await request.json().catch(() => ({}))) || {}
  const origin = siteOrigin(env)
  if (body.action === 'checkout' && !(await isBilled(env.ONBOARDING_DB, session.customer.id, await getSubscription(env.ONBOARDING_DB, session.customer.id)))) {
    return json(409, { error: 'not_billed' })
  }
  const result =
    body.action === 'checkout'
      ? await createCheckout(env, { customer: session.customer, email: session.email, planId: String(body.plan || ''), origin })
      : body.action === 'portal'
        ? await createPortal(env, { customer: session.customer, origin })
        : { ok: false, httpStatus: 400, error: 'invalid_action' }
  if (!result.ok) {
    if (result.httpStatus === 0 || result.httpStatus >= 500) console.error('billing action failed:', body.action, result.error)
    return json(result.httpStatus && result.httpStatus < 500 ? result.httpStatus : 502, { error: result.error })
  }
  return json(200, { url: result.url })
}
