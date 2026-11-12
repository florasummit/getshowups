// GET  /api/ads/google/accounts — accessible Google Ads customer ids for the signed-in business.
// POST /api/ads/google/accounts { accountId, loginCustomerId? } — owner picks the account to use.
// The account must be directly accessible, or a client of an accessible manager (loginCustomerId).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getConnection, markReconnect, upsertConnection } from '../../../../server/ads/connections.js'
import { accessToken, describeAccountWithToken, isClientOfManager, listAccountsWithToken, normalizeAccountId } from '../../../../server/ads/google.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'

const STATUS = { reconnect_required: 409, not_approved_for_production: 403, permission_denied: 403, quota_exhausted: 503, transient: 503 }
const failed = (r) => json(STATUS[r.error] || 502, { error: r.error })

async function listFor(env, customerId) {
  const t = await accessToken(env, customerId)
  if (!t.ok) return t
  const r = await listAccountsWithToken(env, t.token)
  if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'google')
  return r.ok ? { ...r, token: t.token } : r
}

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!adsEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  const customerId = session.customer.id
  const conn = await getConnection(env, customerId, 'google')
  if (!conn) return json(404, { error: 'not_connected' })
  const r = await listFor(env, customerId)
  if (!r.ok) return failed(r)
  return json(200, { status: conn.status, selected: conn.account_id || null, accounts: r.accounts.map((id) => ({ id })) })
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
  const loginCustomerId = body?.loginCustomerId == null || body.loginCustomerId === '' ? null : normalizeAccountId(body.loginCustomerId)
  if (!accountId || (body?.loginCustomerId != null && body.loginCustomerId !== '' && !loginCustomerId)) return json(400, { error: 'invalid_account' })
  if (!(await getConnection(env, customerId, 'google'))) return json(404, { error: 'not_connected' })

  const r = await listFor(env, customerId)
  if (!r.ok) return failed(r)
  if (loginCustomerId) {
    if (!r.accounts.includes(loginCustomerId) || !(await isClientOfManager(env, r.token, loginCustomerId, accountId))) return json(400, { error: 'account_not_accessible' })
  } else if (!r.accounts.includes(accountId)) {
    return json(400, { error: 'account_not_accessible' })
  }
  const about = await describeAccountWithToken(env, r.token, accountId, loginCustomerId || undefined)
  await upsertConnection(env, customerId, 'google', {
    accountId,
    accountName: about.name,
    currency: about.currency,
    // testAccount: Google's own flag (test accounts never serve ads or spend). Re-checked live before any change.
    extra: { ...(loginCustomerId ? { loginCustomerId } : {}), testAccount: about.testAccount === true },
    status: 'connected',
  })
  return json(200, { ok: true, accountId, status: 'connected', testAccount: about.testAccount === true })
}
