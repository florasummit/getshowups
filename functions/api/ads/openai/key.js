// ChatGPT Ads connection with the advertiser's own Ads API key (OpenAI: one key per ad account, Ads Manager → Settings).
//   GET  → { connected, account: { id, name, currency, status }, last4 } (never the key)
//   POST { action: 'save', apiKey } → validated read-only (GET /ad_account) before it is stored; invalid keys are never saved
//   POST { action: 'disconnect', confirm: true } → forgets our stored key (OpenAI keeps it: revoke it in Ads Manager)
// 404 unless OPENAI_ADS_ENABLED is exactly 'true' and the business has Ads. Business from the session only.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { forgetConnection, getConnection } from '../../../../server/ads/connections.js'
import { connectWithKey, openaiAdsEnabled } from '../../../../server/ads/openai.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { logAction } from '../../../../server/ads/campaigns.js'

const STATUS = { invalid_key_format: 400, invalid_key: 400, permission_denied: 403, rate_limited: 503, transient: 503, invalid_request: 502 }

async function gate(request, env, write) {
  if (!adsEnabled(env) || !openaiAdsEnabled(env)) return { response: json(404, { error: 'not_found' }) }
  const { session, response } = await requireSession(request, env, write ? { write: true } : {})
  if (response) return { response }
  if (!(await adsAccess(env, session.customer))) return { response: json(404, { error: 'not_found' }) }
  return { session }
}

const view = (c) => (c ? { connected: c.status === 'connected', status: c.status, account: { id: c.account_id, name: c.account_name, currency: c.currency, status: c.extra?.accountStatus || null }, last4: c.extra?.last4 || null } : { connected: false, status: null, account: null, last4: null })

export async function onRequestGet({ request, env }) {
  const { session, response } = await gate(request, env, false)
  if (response) return response
  return json(200, view(await getConnection(env, session.customer.id, 'openai')))
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await gate(request, env, true)
  if (response) return response
  const id = session.customer.id
  const body = await request.json().catch(() => null)
  if (body?.action === 'disconnect') {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    const running = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND platform = 'openai' AND status = 'active'").bind(id).first()
    // Never strand a running campaign: pause it first (Ads → Pause), then disconnect.
    if ((running?.n ?? 0) > 0) return json(409, { error: 'campaigns_running' })
    await forgetConnection(env, 'openai', id)
    await logAction(env.ONBOARDING_DB, { customer: id, actor: `owner:${session.email}`, kind: 'disconnect', reason: 'ChatGPT Ads key removed from GetShowUps (revoke it in Ads Manager)', platform: 'openai' })
    return json(200, { ok: true, ...view(null) })
  }
  if (body?.action !== 'save') return json(400, { error: 'invalid_request' })
  const rl = await hit(env, 'adsKey', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const r = await connectWithKey(env, id, body.apiKey)
  if (!r.ok) return json(STATUS[r.error] || 400, { error: r.error })
  await logAction(env.ONBOARDING_DB, { customer: id, actor: `owner:${session.email}`, kind: 'connect', reason: `ChatGPT Ads account connected (key …${r.last4})${r.accountChanged ? '; a different ad account than before' : ''}`, platform: 'openai' })
  return json(200, { ok: true, ...view(await getConnection(env, id, 'openai')), accountChanged: r.accountChanged })
}
