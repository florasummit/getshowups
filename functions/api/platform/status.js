// POST /api/platform/status — { customer, status: "active" | "suspended", reason? }.
// Manual only (there is no automatic suspension). Suspension pauses the public booking page; the
// owner keeps dashboard, billing, and reactivation access.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { track } from '../../../server/events.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  const status = body?.status
  if (!CUSTOMER_RE.test(customer) || !['active', 'suspended'].includes(status)) return json(400, { error: 'invalid_request' })
  const row = await env.ONBOARDING_DB.prepare('UPDATE customers SET status = ?2, updated_at = ?3 WHERE id = ?1 RETURNING id')
    .bind(customer, status, Date.now())
    .first()
  if (!row) return json(404, { error: 'not_found' })
  const reason = String(body?.reason || '').slice(0, 200)
  await audit(env, admin.email, `customer.${status === 'suspended' ? 'suspend' : 'reactivate'}`, customer, { reason })
  await track(env, status === 'suspended' ? 'account_suspended' : 'account_reactivated', { customer })
  return json(200, { customer, status })
}
