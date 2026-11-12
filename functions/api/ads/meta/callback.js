// GET /api/ads/meta/callback — completes the Meta connection. Verifies state against the sealed
// cookie and that the signed-in business is the one that started the flow, exchanges the code for a
// long-lived token (stored encrypted in KV), then auto-selects the ad account + Page when there is
// exactly one of each. Every outcome redirects to /dashboard with at most an allowlisted code.
import { decrypt, json, readCookie, timingSafeEqual } from '../../../../server/google-oauth.js'
import { cookie, requireSession } from '../../../../server/auth.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { saveToken, upsertConnection } from '../../../../server/ads/connections.js'
import { META_STATE_COOKIE, META_STATE_TTL_SECONDS, exchangeCode, listAccountsWithToken, metaConfigured } from '../../../../server/ads/meta.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'

function redirect(location) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', cookie(META_STATE_COOKIE, '', 0))
  return new Response(null, { status: 303, headers })
}
const fail = (code) => redirect(`/dashboard?ads_error=${code}`)

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return fail('not_configured')
  if (!metaConfigured(env)) return json(503, { error: 'not_configured' })
  if ((await hitByIp(env, 'adsCallback', request)).limited) return fail('rate_limited')
  const { session, response } = await requireSession(request, env)
  if (response) return fail('signin_required')
  if (!adsEnabledFor(env, session.customer?.id)) return fail('not_configured')

  const url = new URL(request.url)
  if (url.searchParams.get('error')) return fail('cancelled')
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const sealed = readCookie(request, META_STATE_COOKIE)
  if (!code || !returnedState || !sealed) return fail('expired')
  let saved
  try {
    saved = JSON.parse(await decrypt(env, sealed))
  } catch {
    return fail('expired')
  }
  if (!timingSafeEqual(returnedState, String(saved.state)) || Date.now() - saved.iat > META_STATE_TTL_SECONDS * 1000) return fail('expired')
  if (saved.customer !== session.customer.id) return fail('expired') // started by another business

  const ex = await exchangeCode(env, code)
  if (!ex.ok) {
    console.error('Meta token exchange failed:', ex.httpStatus, ex.error)
    return fail(ex.error)
  }
  const customer = session.customer.id
  await saveToken(env, 'meta', customer, { accessToken: ex.accessToken, expiresAt: ex.expiresAt })

  const list = await listAccountsWithToken(env, ex.accessToken)
  if (!list.ok) {
    console.error('Meta account listing failed:', list.httpStatus, list.error)
    await upsertConnection(env, customer, 'meta', { status: 'needs_account' })
    return fail(list.error)
  }
  const active = list.adAccounts.filter((a) => a.status === 1)
  if (active.length === 1 && list.pages.length === 1) {
    const [a] = active
    await upsertConnection(env, customer, 'meta', { accountId: a.id, accountName: a.name, currency: a.currency, extra: { pageId: list.pages[0].id, pageName: list.pages[0].name }, status: 'connected' })
  } else {
    await upsertConnection(env, customer, 'meta', { status: 'needs_account' })
  }
  return redirect('/dashboard?ads=meta_connected')
}
