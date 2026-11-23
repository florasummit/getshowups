// GET /api/ads/gbp/callback — completes the Business Profile connection: state (CSRF) + PKCE + the same business still
// signed in, server-side code exchange, the business.manage scope and a refresh token required, token stored
// encrypted, then the location is linked when the account manages exactly one; otherwise the owner picks in the
// dashboard. Every outcome redirects to the Ads tab with at most an allowlisted code.
import { decrypt, googleApi, googleFetch, missingConfig, readCookie, timingSafeEqual } from '../../../../server/google-oauth.js'
import { cookie, getSession } from '../../../../server/auth.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { saveToken } from '../../../../server/ads/connections.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { GBP_SCOPE, GBP_STATE_COOKIE, GBP_STATE_TTL_SECONDS, discoverWithToken, gbpEnabled, gbpRedirectUri, selectLocation, upsertGbp } from '../../../../server/ads/gbp.js'

function redirect(location) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', cookie(GBP_STATE_COOKIE, '', 0))
  return new Response(null, { status: 303, headers })
}
const fail = (code) => redirect(`/dashboard/ads?ads_error=gbp_${code}`)

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env) || !gbpEnabled(env) || missingConfig(env).length) return fail('not_configured')
  if ((await hitByIp(env, 'adsCallback', request)).limited) return fail('rate_limited')
  const url = new URL(request.url)
  if (url.searchParams.get('error')) return fail('cancelled')
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const sealed = readCookie(request, GBP_STATE_COOKIE)
  if (!code || !returnedState || !sealed) return fail('expired')
  let saved
  try {
    saved = JSON.parse(await decrypt(env, sealed))
  } catch {
    return fail('expired')
  }
  if (!timingSafeEqual(returnedState, String(saved.state || '')) || Date.now() - saved.iat > GBP_STATE_TTL_SECONDS * 1000) return fail('expired')
  let session
  try {
    session = await getSession(request, env)
  } catch {
    return fail('failed')
  }
  if (!session?.customer) return fail('unauthenticated')
  const customerId = session.customer.id
  if (!(await adsAccess(env, session.customer))) return fail('not_configured')
  if (saved.customer !== customerId || saved.email !== session.email) return fail('expired')

  let tokens
  try {
    const res = await googleFetch(env, googleApi(env).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: gbpRedirectUri(env), grant_type: 'authorization_code', code_verifier: saved.verifier }),
    })
    tokens = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Business Profile token exchange failed:', res.status)
      return fail('failed')
    }
  } catch {
    return fail('failed')
  }
  if (!String(tokens.scope || '').split(' ').includes(GBP_SCOPE)) return fail('scope_denied')
  if (!tokens.refresh_token || !tokens.access_token) return fail('no_refresh_token')
  await saveToken(env, 'gbp', customerId, { refreshToken: tokens.refresh_token, clientId: env.GOOGLE_CLIENT_ID, scope: GBP_SCOPE })

  const found = await discoverWithToken(env, tokens.access_token)
  if (!found.ok) {
    await upsertGbp(env, customerId, { status: 'needs_location' }).catch(() => {})
    return fail(found.error)
  }
  if (found.locations.length === 1) {
    const r = await selectLocation(env, customerId, found.locations[0].name, { token: tokens.access_token, locations: found.locations })
    if (!r.ok) return fail(r.error)
  } else {
    await upsertGbp(env, customerId, { status: 'needs_location', extra: { choices: found.locations.length } })
  }
  return redirect('/dashboard/ads?ads=gbp_connected')
}
