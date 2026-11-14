// POST /api/platform/deletion — { customer, action: 'request' | 'retry', confirm: true, confirmId: '<customer id>' }
// Platform admin: start a permanent account deletion on a verified request (e.g. by email), or retry a stuck one
// now. Same workflow as the owner's (server/deletion.js). Same-origin, typed confirmation, audited.
// Only when ACCOUNT_DELETION_ENABLED is exactly 'true' (approval); otherwise 404.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { advanceDeletion, deletionEnabled, deletionStatus, requestDeletion } from '../../../server/deletion.js'

export async function onRequestPost({ request, env }) {
  if (!deletionEnabled(env)) return json(404, { error: 'not_found' })
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer) || !['request', 'retry'].includes(body?.action)) return json(400, { error: 'invalid_request' })
  if (body.confirm !== true || String(body.confirmId || '').toLowerCase() !== customer) return json(400, { error: 'confirmation_required' })
  try {
    if (body.action === 'request') {
      const r = await requestDeletion(env, customer, { type: 'admin', id: admin.email })
      if (!r.ok) return json(r.error === 'not_found' ? 404 : 409, { error: r.error })
      await audit(env, admin.email, 'customer.delete', customer, {})
    } else {
      if (!(await deletionStatus(env.ONBOARDING_DB, customer))) return json(404, { error: 'not_found' })
      await advanceDeletion(env, customer)
      await audit(env, admin.email, 'customer.delete_retry', customer, {})
    }
    return json(200, { deletion: await deletionStatus(env.ONBOARDING_DB, customer) })
  } catch (err) {
    console.error('admin deletion failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
