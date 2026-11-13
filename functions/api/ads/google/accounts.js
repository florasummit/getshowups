// GET  /api/ads/google/accounts — the Google Ads accounts the signed-in business can choose, found
//      automatically (direct + under accessible managers). While live launch is off (sandbox) only
//      accounts Google flags as TEST accounts are offered. Manager ids never leave the server.
// POST /api/ads/google/accounts { accountId } — owner picks one; the server works out the manager path.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getConnection, markReconnect, upsertConnection } from '../../../../server/ads/connections.js'
import { accessToken, describeAccountWithToken, listSelectableAccountsWithToken, normalizeAccountId } from '../../../../server/ads/google.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'
import { liveFor, logAction } from '../../../../server/ads/campaigns.js'

const STATUS = { reconnect_required: 409, not_approved_for_production: 403, permission_denied: 403, quota_exhausted: 503, transient: 503 }
const failed = (r) => json(STATUS[r.error] || 502, { error: r.error })

// { ok, token, offered, hidden }: offered = choosable now; hidden = how many non-test accounts were left out.
async function selectable(env, customerId) {
  const t = await accessToken(env, customerId)
  if (!t.ok) return t
  const r = await listSelectableAccountsWithToken(env, t.token)
  if (!r.ok) {
    if (r.reconnect) await markReconnect(env, customerId, 'google')
    return r
  }
  // Test businesses only ever see Google Ads test accounts, whatever ADS_LIVE_LAUNCH says.
  const live = await liveFor(env, customerId)
  const offered = live ? r.accounts : r.accounts.filter((a) => a.testAccount === true)
  return { ok: true, token: t.token, offered, hidden: r.accounts.length - offered.length, all: r.accounts, live }
}

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!adsEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  const customerId = session.customer.id
  const conn = await getConnection(env, customerId, 'google')
  if (!conn) return json(404, { error: 'not_connected' })
  const r = await selectable(env, customerId)
  if (!r.ok) return failed(r)
  return json(200, {
    status: conn.status,
    selected: conn.account_id || null,
    sandbox: !r.live,
    accounts: r.offered.map(({ id, name, testAccount }) => ({ id, name, testAccount: testAccount === true })),
    hidden: r.hidden,
  })
}

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!adsEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  const customerId = session.customer.id
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  const accountId = normalizeAccountId(body?.accountId)
  if (!accountId) return json(400, { error: 'invalid_account' })
  if (!(await getConnection(env, customerId, 'google'))) return json(404, { error: 'not_connected' })

  const r = await selectable(env, customerId)
  if (!r.ok) return failed(r)
  const pick = r.offered.find((a) => a.id === accountId)
  if (!pick) return json(r.all.some((a) => a.id === accountId) ? 409 : 400, { error: r.all.some((a) => a.id === accountId) ? 'test_account_required' : 'account_not_accessible' })
  // Re-read the account itself through the same path (Google's flag again, plus name/currency).
  const about = await describeAccountWithToken(env, r.token, accountId, pick.via || undefined)
  // Sandbox: until live launch is switched on, only accounts Google flags as TEST accounts can be connected.
  if (!r.live && about.testAccount !== true) return json(409, { error: 'test_account_required' })
  // Switching to a different Google Ads account: approvals were given for the previous account, so approved
  // but not-yet-created campaigns go back to draft and need the owner's approval again.
  const before = await getConnection(env, customerId, 'google')
  if (before?.account_id && before.account_id !== accountId) {
    const reset = await env.ONBOARDING_DB.prepare(
      "UPDATE ad_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ?2 WHERE customer = ?1 AND status = 'approved' AND platform_campaign_id IS NULL RETURNING id",
    )
      .bind(customerId, Date.now())
      .all()
    for (const r of reset.results || []) await logAction(env.ONBOARDING_DB, { customer: customerId, campaignId: r.id, actor: `owner:${session.email}`, kind: 'approval_reset', reason: 'Ad account changed: approve this campaign again' })
  }
  await upsertConnection(env, customerId, 'google', {
    accountId,
    accountName: about.name || pick.name,
    currency: about.currency || pick.currency,
    // testAccount: Google's own flag (test accounts never serve ads or spend). Re-checked live before any change.
    extra: { ...(pick.via ? { loginCustomerId: pick.via } : {}), testAccount: about.testAccount === true },
    status: 'connected',
  })
  return json(200, { ok: true, accountId, status: 'connected', testAccount: about.testAccount === true })
}
