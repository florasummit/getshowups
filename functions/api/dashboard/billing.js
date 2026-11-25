// GET  /api/dashboard/billing?details=1 — next charge, card (brand, last four), invoices: read from Stripe, never stored.
// POST { action: 'cancel', confirm } (end of the paid period) · { action: 'keep', confirm } — owner only, confirmed by Stripe.
// GET  /api/dashboard/billing — plans and this business's subscription (configured: false if Stripe is off).
// POST /api/dashboard/billing — { action: "checkout", plan } or { action: "portal" } → { url }.
// Available even when the account is suspended, so the owner can always pay or reactivate.
// `billed`: whether this business pays for GetShowUps. Pilot / invited / admin-created businesses
// (no self-serve signup and no real subscription) are exempt: no plan card, and checkout is refused,
// so no placeholder billing record is ever created for them.
import { json } from '../../../server/google-oauth.js'
import { isOwner, requireSession, siteOrigin } from '../../../server/auth.js'
import { billingDetails, cancelPlan, keepPlan } from '../../../server/billing-details.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { billingSubscription, createCheckout, createPortal, getSubscription, listPlans, stripeConfigured } from '../../../server/stripe.js'
import { getSignup } from '../../../server/onboarding.js'
import { recoveryFor } from '../../../server/lifecycle.js'
import { accountOf } from '../../../server/business-accounts.js'

const isBilled = async (db, customerId, sub) => Boolean(sub?.stripeSubscriptionId) || Boolean(await getSignup(db, customerId))

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!stripeConfigured(env)) return json(200, { configured: false })
  if (new URL(request.url).searchParams.get('details') === '1') {
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    const rl = await hit(env, 'billingRead', session.customer.id)
    if (rl.limited) return tooManyJson(rl.retryAfter)
    const d = await billingDetails(env, session.customer.id)
    return d.ok ? json(200, d) : json(409, { error: d.error })
  }
  // Access view: after go-live a test-mode subscription shows as 'sandbox' (subscribe for real; not manageable).
  const sub = await billingSubscription(env, session.customer.id)
  const plans = (await listPlans(env.ONBOARDING_DB)).map(({ id, name, trialDays, entitlements }) => ({ id, name, trialDays, entitlements }))
  const account = await accountOf(env, session.customer.id)
  return json(200, {
    configured: plans.length > 0,
    // Complimentary (internal live / sandbox): never billed, no plan card, checkout refused server-side too.
    billed: account.billing === 'complimentary' ? false : await isBilled(env.ONBOARDING_DB, session.customer.id, sub),
    complimentary: account.billing === 'complimentary',
    plans,
    subscription: sub && { status: sub.status, planId: sub.planId, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, manageable: Boolean(sub.stripeCustomerId) && !sub.sandbox },
    owner: await isOwner(env.ONBOARDING_DB, session),
    recovery: await recoveryFor(env, session.customer.id),
  })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!stripeConfigured(env)) return json(503, { error: 'billing_not_configured' })
  const body = (await request.json().catch(() => ({}))) || {}
  const origin = siteOrigin(env)
  if (body.action === 'cancel' || body.action === 'keep') {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    const rl = await hit(env, 'accountWrite', session.customer.id)
    if (rl.limited) return tooManyJson(rl.retryAfter)
    const r = await (body.action === 'cancel' ? cancelPlan : keepPlan)(env, session.customer.id, { type: 'owner', id: session.email })
    if (r.ok) return json(200, r)
    if (r.unavailable) console.error('billing action failed:', body.action, r.error)
    return json(r.unavailable ? 502 : 409, { error: r.unavailable ? 'not_confirmed' : r.error })
  }
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
