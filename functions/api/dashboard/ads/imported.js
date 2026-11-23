// Campaigns that already exist in the signed-in business's connected Google Ads account (server/ads/imports.js).
//   GET  ?days=7|30|90          → { ready, syncedAt, lastResult, campaigns[], totals, changes, recommendations }
//   POST { action: 'refresh' }  → reads the account again now (search-only toward Google), then the same shape
//   POST { action: 'propose', importedId, field: 'status'|'daily_budget', value }  → a change request (nothing on Google yet)
//   POST { action: 'apply', id, confirm: true }  → the owner's approval applies it through the API and reads back
//   POST { action: 'cancel', id }
// 404 without Ads; { ready: false } before migration 0037; 409 not_connected without a chosen Google Ads account.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { getConnection } from '../../../../server/ads/connections.js'
import { listImported, syncImportedCampaigns } from '../../../../server/ads/imports.js'
import { applyChange, cancelChange, listChanges, proposeChange } from '../../../../server/ads/changes.js'
import { listRecommendations } from '../../../../server/ads/recommend.js'

const STATUS = { not_connected: 409, needs_account: 409, reconnect_required: 409, not_approved_for_production: 403, permission_denied: 403, quota_exhausted: 503, transient: 503, not_ready: 503, not_found: 404, invalid_request: 400, invalid_budget: 400, no_change: 409, shared_budget: 409, campaign_removed: 409, request_expired: 409, ads_on_hold: 409, test_account_required: 409, live_launch_disabled: 409 }
const daysOf = (v) => ([7, 30, 90].includes(Number(v)) ? Number(v) : 30)

async function payload(db, customerId, days) {
  const list = await listImported(db, customerId, { days })
  if (!list.ready) return list
  const [changes, recommendations] = await Promise.all([listChanges(db, customerId), listRecommendations(db, customerId)])
  return { ...list, changes, recommendations }
}

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    return json(200, await payload(env.ONBOARDING_DB, session.customer.id, daysOf(new URL(request.url).searchParams.get('days'))))
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
  const customer = session.customer
  const rl = await hit(env, 'adsWrite', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  const actor = `owner:${session.email}`
  const db = env.ONBOARDING_DB
  try {
    let r
    switch (body?.action) {
      case 'refresh': {
        const conn = await getConnection(env, customer.id, 'google')
        if (!conn || conn.status !== 'connected' || !conn.account_id) return json(409, { error: 'not_connected' })
        r = await syncImportedCampaigns(env, customer.id, { full: body.full === true })
        if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error })
        return json(200, { ...(await payload(db, customer.id, daysOf(body.days))), sync: r })
      }
      case 'propose':
        r = await proposeChange(env, customer, { importedId: body.importedId, field: body.field, value: body.value }, actor)
        break
      case 'apply':
        if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
        r = await applyChange(env, customer, body.id, actor)
        break
      case 'cancel':
        r = await cancelChange(env, customer, body.id)
        break
      default:
        return json(400, { error: 'invalid_request' })
    }
    if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error, ...(r.hold ? { hold: r.hold } : {}) })
    return json(200, { ...(await payload(db, customer.id, daysOf(body.days))), ...(r.request ? { request: r.request } : {}), ...(r.google ? { google: r.google } : {}) })
  } catch (err) {
    console.error('imported campaigns action failed:', body?.action, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
