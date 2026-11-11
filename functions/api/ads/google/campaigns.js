// GET /api/ads/google/campaigns — campaigns in the signed-in business's connected Google Ads account,
// read live from Google: status, daily budget and last-30-day metrics, plus whether the account is a
// Google Ads test account. Read-only; never changes anything.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { readCampaigns } from '../../../../server/ads/google.js'

const STATUS = { not_connected: 404, needs_account: 409, reconnect_required: 409, not_approved_for_production: 403, permission_denied: 403, quota_exhausted: 503, transient: 503 }

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const r = await readCampaigns(env, session.customer.id)
  if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error })
  return json(200, { testAccount: r.testAccount, campaigns: r.campaigns })
}
