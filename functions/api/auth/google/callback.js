// GET /api/auth/google/callback — completes dashboard sign-in.
// Verifies state (CSRF) and PKCE, exchanges the code server-side, requires a Google-verified email
// issued for our client, then creates a session for that email. Every outcome redirects to
// /dashboard with at most an allowlisted error code.
import {
  decrypt,
  googleApi,
  googleFetch,
  idTokenClaims,
  missingConfig,
  page,
  readCookie,
  sha256Hex,
  timingSafeEqual,
} from '../../../../server/google-oauth.js'
import {
  EMAIL_RE,
  LOGIN_COOKIE,
  LOGIN_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  cookie,
  createSession,
  loginRedirectUri,
  safeNext,
} from '../../../../server/auth.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { track } from '../../../../server/events.js'
import { adminEmails } from '../../../../server/platform.js'

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  headers.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0))
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(null, { status: 303, headers })
}
// Errors return to where sign-in started (admin console or dashboard), with an allowlisted code.
const failTo = (origin) => (code) => redirect(`${origin === '/admin' ? '/admin' : '/dashboard'}?login_error=${code}`)
// Best effort: which area started this sign-in (from our encrypted login cookie). Unreadable → dashboard.
async function startedFrom(env, request) {
  try {
    const sealed = readCookie(request, LOGIN_COOKIE)
    return sealed ? JSON.parse(await decrypt(env, sealed)).next : null
  } catch {
    return null
  }
}

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return page(503, 'Sign-in unavailable', 'Dashboard sign-in is not configured yet.')
  }

  const fail = failTo(await startedFrom(env, request))
  if ((await hitByIp(env, 'loginCallback', request)).limited) return fail('rate_limited')

  const url = new URL(request.url)
  if (url.searchParams.get('error')) return fail('cancelled')

  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const sealed = readCookie(request, LOGIN_COOKIE)
  if (!code || !returnedState || !sealed) return fail('expired')

  let saved
  try {
    saved = JSON.parse(await decrypt(env, sealed))
  } catch {
    return fail('expired')
  }
  if (!timingSafeEqual(returnedState, saved.state) || Date.now() - saved.iat > LOGIN_TTL_SECONDS * 1000) {
    return fail('expired')
  }

  let tokens
  try {
    const res = await googleFetch(env, googleApi(env).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: loginRedirectUri(env),
        grant_type: 'authorization_code',
        code_verifier: saved.verifier,
      }),
    })
    tokens = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Login token exchange failed:', res.status, tokens.error)
      return fail('failed')
    }
  } catch {
    return fail('failed')
  }

  // Claims are trusted because the id_token came straight from Google's token endpoint over TLS;
  // aud and iss are still checked so a token minted for another client is never accepted.
  const claims = idTokenClaims(tokens.id_token || '')
  const email = String(claims.email || '').toLowerCase()
  if (
    claims.aud !== env.GOOGLE_CLIENT_ID ||
    !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
    claims.email_verified !== true ||
    !EMAIL_RE.test(email)
  ) {
    return fail('failed')
  }

  // Any verified Google account may sign in. Business access is resolved per request from
  // customer_users; a new user is taken to setup to create their business.
  let token
  try {
    token = await createSession(env.ONBOARDING_DB, email)
  } catch (err) {
    console.error('Session create failed:', err?.message)
    return fail('failed')
  }
  await track(env, 'signup', { id: `signup:${await sha256Hex(email)}` }) // first sign-in only (deduped)
  return redirect(await landing(env, email, saved.next), [cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS)])
}

// Where a new session lands. A platform admin with no business membership goes to the console even if
// sign-in started from /dashboard, instead of being shown "create your business". This only changes
// the landing page: /admin still authorizes every request via PLATFORM_ADMIN_EMAILS. On a lookup error
// the ordinary landing is kept.
async function landing(env, email, next) {
  const want = safeNext(next)
  if (want === '/admin' || !adminEmails(env).includes(email)) return want
  try {
    const member = await env.ONBOARDING_DB.prepare('SELECT 1 FROM customer_users WHERE email = ?1').bind(email).first()
    return member ? want : '/admin' // admin without a business: the console, never customer onboarding
  } catch {
    return want
  }
}
