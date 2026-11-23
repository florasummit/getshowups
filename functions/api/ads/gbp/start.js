// GET /api/ads/gbp/start — owner connects their Google Business Profile (scope business.manage only, a consent separate
// from sign-in, Calendar and Ads). State, PKCE verifier and the business id travel in an encrypted HttpOnly cookie;
// the callback re-checks the signed-in session against it. 404 unless GBP_ENABLED (approval: scope + Google access).
import { GOOGLE_AUTH_URL, encrypt, json, pkceChallenge, randomToken } from '../../../../server/google-oauth.js'
import { cookie, requireSession, siteOrigin } from '../../../../server/auth.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { GBP_SCOPE, GBP_STATE_COOKIE, GBP_STATE_TTL_SECONDS, gbpEnabled, gbpRedirectUri } from '../../../../server/ads/gbp.js'

function crossSite(request, env) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== siteOrigin(env)) return true
  const site = request.headers.get('Sec-Fetch-Site')
  return Boolean(site) && !['same-origin', 'none'].includes(site)
}

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env) || !gbpEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  if (crossSite(request, env)) return json(403, { error: 'forbidden' })
  const rl = await hitByIp(env, 'adsConnect', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const state = randomToken()
  const verifier = randomToken(48)
  const sealed = await encrypt(env, JSON.stringify({ state, verifier, customer: session.customer.id, email: session.email, iat: Date.now() }))
  const auth = new URL(GOOGLE_AUTH_URL)
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: gbpRedirectUri(env),
    response_type: 'code',
    scope: GBP_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return new Response(null, { status: 302, headers: { Location: auth.toString(), 'Set-Cookie': cookie(GBP_STATE_COOKIE, sealed, GBP_STATE_TTL_SECONDS), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}
