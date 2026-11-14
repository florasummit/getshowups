// POST /api/platform/campaign-pause — { customer, campaign, confirm: true }
// Platform admin records that the advertiser confirmed a campaign is paused in Google Ads / Meta when GetShowUps can no
// longer reach it (disconnected, other ad account, expired sign-in). If it is reachable, it is simply paused by us.
// Same-origin, typed confirmation, audited.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { confirmPausedExternally } from '../../../server/ads/campaigns.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer) || typeof body?.campaign !== 'string') return json(400, { error: 'invalid_request' })
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  const r = await confirmPausedExternally(env, customer, body.campaign, `admin:${admin.email}`)
  if (!r.ok) return json(r.error === 'not_found' ? 404 : 409, { error: r.error })
  await audit(env, admin.email, 'ads.confirm_paused_externally', customer, { campaign: body.campaign, attested: Boolean(r.attested) })
  return json(200, r)
}
