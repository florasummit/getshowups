// GET  /api/platform/reconcile — the latest billing reconciliation (Stripe vs our records).
// POST /api/platform/reconcile — { action: 'run' } run it now, or { action: 'resync', customer, confirm: true }
// to apply Stripe's current subscription to one business. Platform admins only; same-origin; audited.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { ISSUE_TEXT, lastReconciliation, reconcileBilling, resyncFromStripe } from '../../../server/reconcile.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  return json(200, { last: await lastReconciliation(env.ONBOARDING_DB), labels: ISSUE_TEXT })
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  try {
    if (body?.action === 'run') {
      const r = await reconcileBilling(env, { actor: admin.email })
      if (!r.ok) return json(r.error === 'not_configured' ? 409 : 502, { error: r.error })
      return json(200, { last: r, labels: ISSUE_TEXT })
    }
    if (body?.action === 'resync') {
      const customer = String(body.customer || '').toLowerCase()
      if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_request' })
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      const r = await resyncFromStripe(env, customer)
      if (!r.ok) return json(r.error === 'no_subscription' ? 404 : 502, { error: r.error })
      await audit(env, admin.email, 'billing.resync', customer, { status: r.status, mrrCents: r.mrrCents })
      return json(200, r)
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('reconcile failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
