// GET /api/ads/google/callback — completes the Google Ads connection. Verifies state (CSRF), PKCE and
// that the same business is still signed in, exchanges the code server-side, requires the adwords
// scope and a refresh token, stores the token encrypted, then picks the account when exactly one is
// accessible. Every outcome redirects to /dashboard with at most an allowlisted code.
import { DATA_MANAGER_SCOPE } from '../../../../server/ads/conversions.js'
import { decrypt, googleApi, googleFetch, missingConfig, readCookie, timingSafeEqual } from '../../../../server/google-oauth.js'
import { cookie, getSession } from '../../../../server/auth.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { saveToken, upsertConnection } from '../../../../server/ads/connections.js'
import { ADS_SCOPE, ADS_STATE_COOKIE, ADS_STATE_TTL_SECONDS, adsRedirectUri, describeAccountWithToken, listSelectableAccountsWithToken } from '../../../../server/ads/google.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'
import { liveFor } from '../../../../server/ads/campaigns.js'

function redirect(location) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', cookie(ADS_STATE_COOKIE, '', 0))
  return new Response(null, { status: 303, headers })
}
const fail = (code) => redirect(`/dashboard/ads?ads_error=${code}`)

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return fail('not_configured')
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
  if (!adsEnabledFor(env, customerId)) return fail('not_configured')
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

  // Keep the scopes Google actually granted (conversion reporting needs the Data Manager scope too).
  const granted = String(tokens.scope || '').split(' ').filter((x) => x === ADS_SCOPE || x === DATA_MANAGER_SCOPE).join(' ')
  await saveToken(env, 'google', customerId, { refreshToken: tokens.refresh_token, clientId: env.GOOGLE_CLIENT_ID, scope: granted })

  // Find every usable account (direct + under managers). Exactly one choosable account → use it;
  // otherwise the owner picks in the dashboard. Sandbox: only Google Ads TEST accounts are choosable.
  const listed = await listSelectableAccountsWithToken(env, tokens.access_token)
  if (!listed.ok) {
    await upsertConnection(env, customerId, 'google', { status: 'needs_account' })
    return fail(listed.error)
  }
  const live = await liveFor(env, customerId) // never for a test business
  const choosable = live ? listed.accounts : listed.accounts.filter((a) => a.testAccount === true)
  const only = choosable.length === 1 ? choosable[0] : null
  const about = only ? await describeAccountWithToken(env, tokens.access_token, only.id, only.via || undefined) : null
  if (only && (live || about.testAccount === true)) {
    await upsertConnection(env, customerId, 'google', {
      accountId: only.id,
      accountName: about.name || only.name,
      currency: about.currency || only.currency,
      extra: { ...(only.via ? { loginCustomerId: only.via } : {}), testAccount: about.testAccount === true },
      status: 'connected',
    })
  } else {
    await upsertConnection(env, customerId, 'google', { status: 'needs_account' })
  }
  return redirect('/dashboard/ads?ads=google_connected')
}
