// POST /api/dashboard/business — create the signed-in user's business (first time) or update it.
//   Body: { name, timezone, serviceZips, appointmentMode?, plan? }. A new self-serve business is put on
//   the requested (or first) plan when billing is configured, and must pay before the rest of setup.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { createCustomer, updateBusiness, validateBusiness } from '../../../server/customers.js'
import { signupPlan } from '../../../server/onboarding.js'
import { recordAttribution } from '../../../server/commercial-attribution.js'
import { billingMisconfigured, sandboxCheckoutAllowed } from '../../../server/stripe.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false, write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const [error, business] = validateBusiness(body)
  if (error) return json(400, { error })

  try {
    if (session.customer) {
      await updateBusiness(env.ONBOARDING_DB, session.customer.id, business)
      return json(200, { id: session.customer.id })
    }
    // Billing half-configured (e.g. mid go-live): refuse, never create a business that would skip payment for good.
    if (billingMisconfigured(env)) {
      console.error('self-serve signup refused: billing_misconfigured')
      return json(403, { error: 'signup_not_open' })
    }
    const planId = await signupPlan(env, String(body?.plan || ''))
    // Billed signup while billing is sandbox-only: only authorized testers may create one (no orphan businesses
    // for visitors who could never pay; the page already says online sign-up isn't open).
    if (planId && !(await sandboxCheckoutAllowed(env, null, session.email))) return json(403, { error: 'signup_not_open' })
    const id = await createCustomer(env, session.email, business, { source: body?.source, via: 'self_serve', planId })
    // First-touch commercial attribution (never throws; the partner code is validated server-side, self-referral refused).
    await recordAttribution(env.ONBOARDING_DB, id, { channel: 'self_serve', partnerCode: Array.isArray(body?.partner) ? body.partner : null, source: body?.source, ownerEmail: session.email })
    return json(201, { id })
  } catch (err) {
    // A concurrent request already created this user's business (customer_users PK).
    if (/UNIQUE|PRIMARY/i.test(String(err?.message))) return json(409, { error: 'already_exists' })
    console.error('business save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
