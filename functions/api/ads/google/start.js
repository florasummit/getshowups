// GET /api/ads/google/start — owner connects their business's Google Ads account (scope: adwords only,
// a consent separate from sign-in and Calendar). State, PKCE verifier and the business id travel in an
// encrypted, HttpOnly cookie; the callback re-checks the signed-in session against it.
import { GOOGLE_AUTH_URL, encrypt, json, pkceChallenge, randomToken } from '../../../../server/google-oauth.js'
import { cookie, requireSession, siteOrigin } from '../../../../server/auth.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { ADS_SCOPE, ADS_STATE_COOKIE, ADS_STATE_TTL_SECONDS, adsRedirectUri } from '../../../../server/ads/google.js'

// A top-level navigation from our own dashboard; anything sent from another site is refused.
function crossSite(request, env) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== siteOrigin(env)) return true
  const site = request.headers.get('Sec-Fetch-Site')
  return Boolean(site) && !['same-origin', 'none'].includes(site)
}

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (crossSite(request, env)) return json(403, { error: 'forbidden' })
  const rl = await hitByIp(env, 'adsConnect', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)

  const state = randomToken()
  const verifier = randomToken(48)
  const sealed = await encrypt(env, JSON.stringify({ state, verifier, customer: session.customer.id, email: session.email, iat: Date.now() }))
  const auth = new URL(GOOGLE_AUTH_URL)
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: adsRedirectUri(env),
    response_type: 'code',
    scope: ADS_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // a refresh token is required for later, unattended reporting
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': cookie(ADS_STATE_COOKIE, sealed, ADS_STATE_TTL_SECONDS),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
