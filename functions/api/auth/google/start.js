// GET /api/auth/google/start — "Sign in with Google" for the customer dashboard.
// Requests openid + email only (no calendar access). State + PKCE verifier travel in an
// encrypted, HttpOnly cookie separate from the calendar-connection flow's cookie.
import { GOOGLE_AUTH_URL, encrypt, missingConfig, page, pkceChallenge, randomToken } from '../../../../server/google-oauth.js'
import { LOGIN_COOKIE, LOGIN_SCOPES, LOGIN_TTL_SECONDS, cookie, loginRedirectUri, safeNext } from '../../../../server/auth.js'
import { hitByIp, tooManyPage } from '../../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return page(503, 'Sign-in unavailable', 'Dashboard sign-in is not configured yet.')
  }
  const rl = await hitByIp(env, 'login', request)
  if (rl.limited) return tooManyPage(rl.retryAfter)

  const state = randomToken()
  const verifier = randomToken(48)
  // Where to land after sign-in: the admin console or a dashboard tab (allowlist; see safeNext).
  const next = safeNext(new URL(request.url).searchParams.get('next'))
  const sealed = await encrypt(env, JSON.stringify({ state, verifier, next, iat: Date.now() }))

  const auth = new URL(GOOGLE_AUTH_URL)
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: loginRedirectUri(env),
    response_type: 'code',
    scope: LOGIN_SCOPES.join(' '),
    prompt: 'select_account',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString()

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': cookie(LOGIN_COOKIE, sealed, LOGIN_TTL_SECONDS),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
