// GET /api/ads/meta/accounts — the signed-in business's Meta ad accounts and Pages + current selection.
// POST /api/ads/meta/accounts {adAccountId, pageId} — choose one of each (validated against the lists).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getConnection, upsertConnection } from '../../../../server/ads/connections.js'
import { listAccounts, metaConfigured } from '../../../../server/ads/meta.js'

const statusFor = (r) => (r.reconnect ? 409 : r.error === 'rate_limited' || r.error === 'transient' ? 503 : 502)

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  if (!metaConfigured(env)) return json(503, { error: 'not_configured' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const customer = session.customer.id
  const conn = await getConnection(env, customer, 'meta')
  if (!conn) return json(404, { error: 'not_connected' })
  const list = await listAccounts(env, customer)
  if (!list.ok) return json(statusFor(list), { error: list.error })
  return json(200, {
    status: conn.status,
    selected: conn.account_id ? { adAccountId: conn.account_id, pageId: conn.extra.pageId || null } : null,
    adAccounts: list.adAccounts.map(({ id, name, currency, status }) => ({ id, name, currency, active: status === 1 })),
    pages: list.pages,
  })
}

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  if (!metaConfigured(env)) return json(503, { error: 'not_configured' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const adAccountId = typeof body?.adAccountId === 'string' ? body.adAccountId : ''
  const pageId = typeof body?.pageId === 'string' ? body.pageId : ''
  if (!/^act_\d{1,30}$/.test(adAccountId) || !/^\d{1,30}$/.test(pageId)) return json(400, { error: 'invalid_selection' })
  const customer = session.customer.id
  if (!(await getConnection(env, customer, 'meta'))) return json(404, { error: 'not_connected' })
  const list = await listAccounts(env, customer)
  if (!list.ok) return json(statusFor(list), { error: list.error })
  const account = list.adAccounts.find((a) => a.id === adAccountId && a.status === 1)
  const page = list.pages.find((p) => p.id === pageId)
  if (!account || !page) return json(400, { error: 'invalid_selection' })
  await upsertConnection(env, customer, 'meta', { accountId: account.id, accountName: account.name, currency: account.currency, extra: { pageId: page.id, pageName: page.name }, status: 'connected' })
  return json(200, { ok: true, status: 'connected' })
}
