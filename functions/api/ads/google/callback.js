// GET /api/ads/google/callback — completes the Google Ads connection. Verifies state (CSRF), PKCE and
// that the same business is still signed in, exchanges the code server-side, requires the adwords
// scope and a refresh token, stores the token encrypted, then picks the account when exactly one is
// accessible. Every outcome redirects to /dashboard with at most an allowlisted code.
import { decrypt, googleApi, googleFetch, missingConfig, readCookie, timingSafeEqual } from '../../../../server/google-oauth.js'
import { cookie, getSession } from '../../../../server/auth.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { saveToken, upsertConnection } from '../../../../server/ads/connections.js'
import { ADS_SCOPE, ADS_STATE_COOKIE, ADS_STATE_TTL_SECONDS, adsRedirectUri, describeAccountWithToken, listAccountsWithToken } from '../../../../server/ads/google.js'

function redirect(location) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', cookie(ADS_STATE_COOKIE, '', 0))
  return new Response(null, { status: 303, headers })
}
const fail = (code) => redirect(`/dashboard?ads_error=${code}`)

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return fail('not_configured')
  if (missingConfig(env).length) return fail('not_configured')
  if ((await hitByIp(env, 'adsCallback', request)).limited) return fail('rate_limited')

  const url = new URL(request.url)
  if (url.searchParams.get('error')) return fail('cancelled')
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const sealed = readCookie(request, ADS_STATE_COOKIE)
  if (!code || !returnedState || !sealed) return fail('expired')

  let saved
  try {
    saved = JSON.parse(await decrypt(env, sealed))
  } catch {
    return fail('expired')
  }
  if (!timingSafeEqual(returnedState, String(saved.state || '')) || Date.now() - saved.iat > ADS_STATE_TTL_SECONDS * 1000) return fail('expired')

  // The business comes from the live session; the sealed state must name the same one.
  let session
  try {
    session = await getSession(request, env)
  } catch {
    return fail('failed')
  }
  if (!session?.customer) return fail('unauthenticated')
  const customerId = session.customer.id
  if (saved.customer !== customerId || saved.email !== session.email) return fail('expired')

  let tokens
  try {
    const res = await googleFetch(env, googleApi(env).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: adsRedirectUri(env),
        grant_type: 'authorization_code',
        code_verifier: saved.verifier,
      }),
    })
    tokens = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Google Ads token exchange failed:', res.status)
      return fail('failed')
    }
  } catch {
    return fail('failed')
  }
  if (!String(tokens.scope || '').split(' ').includes(ADS_SCOPE)) return fail('scope_denied')
  if (!tokens.refresh_token || !tokens.access_token) return fail('no_refresh_token')

  await saveToken(env, 'google', customerId, { refreshToken: tokens.refresh_token, clientId: env.GOOGLE_CLIENT_ID, scope: ADS_SCOPE })

  const listed = await listAccountsWithToken(env, tokens.access_token)
  if (!listed.ok) {
    await upsertConnection(env, customerId, 'google', { status: 'needs_account' })
    return fail(listed.error)
  }
  if (listed.accounts.length === 1) {
    const accountId = listed.accounts[0]
    const about = await describeAccountWithToken(env, tokens.access_token, accountId)
    await upsertConnection(env, customerId, 'google', { accountId, accountName: about.name, currency: about.currency, status: 'connected' })
  } else {
    await upsertConnection(env, customerId, 'google', { status: 'needs_account' })
  }
  return redirect('/dashboard?ads=google_connected')
}
