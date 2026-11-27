// POST /api/platform/attribution { customer, channel?, partnerId? (null clears), repEmail? (null clears), confirm: true } —
// the ONLY way a recorded attribution changes after the fact (server/commercial-attribution.js correctAttribution).
// Platform admins only, same-origin, explicit confirmation, audited from → to. Existing ledger rows are never changed.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { correctAttribution } from '../../../server/commercial-attribution.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const customer = String(body?.customer || '')
  if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  try {
    const r = await correctAttribution(env, customer, { channel: body.channel, partnerId: body.partnerId, repEmail: body.repEmail }, admin.email)
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, 'attribution.corrected', customer, { from: r.from, to: r.to })
    return json(200, { ok: true, attribution: r.to })
  } catch (err) {
    console.error('attribution correction failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
