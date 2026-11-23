// Campaigns that already exist in the signed-in business's connected Google Ads account (server/ads/imports.js).
//   GET  ?days=7|30|90          → { ready, syncedAt, lastResult, campaigns[], totals } (read-only copy, Google's numbers)
//   POST { action: 'refresh' }  → reads the account again now (search-only toward Google), then the same shape
// 404 without Ads; { ready: false } before migration 0037; 409 not_connected without a chosen Google Ads account.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { getConnection } from '../../../../server/ads/connections.js'
import { listImported, syncImportedCampaigns } from '../../../../server/ads/imports.js'

const STATUS = { not_connected: 409, needs_account: 409, reconnect_required: 409, not_approved_for_production: 403, permission_denied: 403, quota_exhausted: 503, transient: 503, not_ready: 503 }
const daysOf = (v) => ([7, 30, 90].includes(Number(v)) ? Number(v) : 30)

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    return json(200, await listImported(env.ONBOARDING_DB, session.customer.id, { days: daysOf(new URL(request.url).searchParams.get('days')) }))
  } catch (err) {
    console.error('imported campaigns load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const customerId = session.customer.id
  const rl = await hit(env, 'adsWrite', customerId)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (body?.action !== 'refresh') return json(400, { error: 'invalid_request' })
  const conn = await getConnection(env, customerId, 'google')
  if (!conn || conn.status !== 'connected' || !conn.account_id) return json(409, { error: 'not_connected' })
  try {
    const r = await syncImportedCampaigns(env, customerId, { full: body.full === true })
    if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error })
    return json(200, { ...(await listImported(env.ONBOARDING_DB, customerId, { days: daysOf(body.days) })), sync: r })
  } catch (err) {
    console.error('imported campaigns refresh failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
