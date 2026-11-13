// POST /api/platform/test-business — { customer, test: true | false, confirm: true }. Platform admin only,
// same-origin, audited. Marks a business as a test business (kept out of metrics; never live Ads,
// live messaging or live Stripe), or removes the mark. Removing it never promotes sandbox data: records
// created while marked stay sandboxed and Ads connections must be chosen again (server/testbusiness.js).
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { setTestBusiness } from '../../../server/testbusiness.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer) || typeof body?.test !== 'boolean' || body?.confirm !== true) return json(400, { error: 'invalid_request' })
  const exists = await env.ONBOARDING_DB.prepare('SELECT id FROM customers WHERE id = ?1').bind(customer).first()
  if (!exists) return json(404, { error: 'not_found' })
  const r = await setTestBusiness(env, customer, body.test, admin.email)
  if (!r.ok) return json(r.httpStatus || 503, { error: r.error })
  if (r.changed) await audit(env, admin.email, body.test ? 'customer.test_mark' : 'customer.test_unmark', customer, {})
  return json(200, { customer, test: r.test, changed: r.changed })
}
