// Shared helpers for the Google Calendar OAuth (authorization-code + PKCE) flow.
// Runs only in Cloudflare Pages Functions. Never import this from src/ (the browser bundle).
//
// Required Cloudflare Pages configuration (Settings → Variables and Secrets / Bindings):
//   GOOGLE_CLIENT_ID       variable   OAuth 2.0 Web client ID
//   GOOGLE_CLIENT_SECRET   secret     OAuth 2.0 Web client secret
//   GOOGLE_REDIRECT_URI    variable   https://getshowups.com/api/google/oauth/callback
//   TOKEN_ENCRYPTION_KEY   secret     base64 of 32 random bytes (openssl rand -base64 32)
//   ADMIN_API_TOKEN        secret     bearer token for POST /api/admin/google-invites (32+ random chars)
//   GOOGLE_TOKENS          KV binding stores encrypted refresh tokens
//   ONBOARDING_DB          D1 binding single-use onboarding invites (migrations/0001_onboarding_invites.sql)

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
// Least privilege, verified against Google's Calendar API scope docs:
//   calendar.events.owned — create/change events on calendars the user owns (not shared calendars)
//   calendar.freebusy     — read availability only; accepted by freeBusy.query
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.freebusy',
]
export const SCOPES = ['openid', 'email', ...CALENDAR_SCOPES]
export const STATE_COOKIE = '__Host-gsu_google_oauth'
export const STATE_TTL_SECONDS = 600

const REQUIRED = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY',
  'ADMIN_API_TOKEN',
]

export function missingConfig(env) {
  const missing = REQUIRED.filter((k) => !env[k])
  if (!env.GOOGLE_TOKENS) missing.push('GOOGLE_TOKENS (KV binding)')
  if (!env.ONBOARDING_DB) missing.push('ONBOARDING_DB (D1 binding)')
  if (env.ADMIN_API_TOKEN && env.ADMIN_API_TOKEN.length < 32) missing.push('ADMIN_API_TOKEN (min 32 chars)')
  return missing
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier))
  return b64url(new Uint8Array(digest))
}

async function aesKey(env) {
  const raw = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), (c) => c.charCodeAt(0))
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

// AES-256-GCM: confidentiality + integrity. Output: base64url(iv || ciphertext).
export async function encrypt(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plaintext))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), 12)
  return b64url(out)
}

export async function decrypt(env, token) {
  const data = fromB64url(token)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await aesKey(env), data.slice(12))
  return dec.decode(pt)
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Every server-side call to Google goes through here so none can hang a request: it aborts after
// GOOGLE_TIMEOUT_MS (env override exists only so tests can use a short timeout).
export const GOOGLE_TIMEOUT_MS = 8000
export function googleFetch(env, url, init = {}) {
  const ms = Number(env?.GOOGLE_TIMEOUT_MS) > 0 ? Number(env.GOOGLE_TIMEOUT_MS) : GOOGLE_TIMEOUT_MS
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}

// Best effort: revoking a refresh token also revokes the grant's access tokens.
export async function revokeToken(token, env) {
  try {
    await googleFetch(env, GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
  } catch (err) {
    console.error('Google token revoke failed:', err?.message)
  }
}

// Google ties every refresh token a user gives one OAuth client to a single grant: revoking any of
// them can end all of that user's access for the client, including connections stored for other
// businesses. Returns true when a stored connection (google:<customer>) for this Google account and
// client exists, so callers keep it working by not revoking. Unknown → true (never revoke blindly).
export async function grantInUse(env, sub, clientId = env.GOOGLE_CLIENT_ID) {
  if (!sub) return true
  try {
    const listed = await env.GOOGLE_TOKENS.list({ prefix: 'google:' })
    if (!listed.list_complete) return true
    for (const { name } of listed.keys) {
      const raw = await env.GOOGLE_TOKENS.get(name)
      if (!raw) continue
      const rec = JSON.parse(raw)
      if (rec.googleSub === sub && rec.clientId === clientId) return true
    }
    return false
  } catch (err) {
    console.error('Grant usage check failed:', err?.message)
    return true
  }
}

// Revokes a token only if no stored connection still depends on the same Google grant.
export async function revokeUnlessInUse(token, sub, env, clientId) {
  if (await grantInUse(env, sub, clientId)) return false
  await revokeToken(token, env)
  return true
}

// Bearer-token check for /api/admin/* routes. Compares fixed-length digests so timing does not
// leak the token length or prefix.
export async function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  return Boolean(presented) && timingSafeEqual(await sha256Hex(presented), await sha256Hex(env.ADMIN_API_TOKEN))
}

// Server-side Google API endpoints. GOOGLE_API_MOCK_ORIGIN exists only so end-to-end tests can
// point token refresh and Calendar calls at a local mock; it is ignored unless it is a loopback
// http origin, so it can never redirect production traffic elsewhere.
export function googleApi(env) {
  const o = env?.GOOGLE_API_MOCK_ORIGIN
  const mock = typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
  return {
    token: mock ? `${mock}/token` : GOOGLE_TOKEN_URL,
    calendar: mock ? `${mock}/calendar/v3` : 'https://www.googleapis.com/calendar/v3',
  }
}

// Only these Google OAuth error codes are passed through; anything else becomes "other".
const OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope'])

// OAuth client used to refresh a stored connection. Google binds a refresh token to the client that
// issued it, so during a client migration connections issued by the previous client keep refreshing
// through GOOGLE_LEGACY_CLIENT_ID/SECRET until the customer reconnects. Connections stored before
// client tracking (no issuedTo) came from the legacy client when one is configured.
export function oauthClient(env, issuedTo) {
  const current = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, kind: 'current' }
  const legacy =
    env.GOOGLE_LEGACY_CLIENT_ID && env.GOOGLE_LEGACY_CLIENT_SECRET
      ? { id: env.GOOGLE_LEGACY_CLIENT_ID, secret: env.GOOGLE_LEGACY_CLIENT_SECRET, kind: 'legacy' }
      : null
  if (issuedTo && issuedTo === current.id) return current
  if (legacy && (!issuedTo || issuedTo === legacy.id)) return legacy
  return current
}

// Exchanges a refresh token for a short-lived access token. The access token is returned to the
// caller only, for immediate use; it is never stored or logged. Network failures report status 0.
export async function refreshAccessToken(env, refreshToken, client = oauthClient(env)) {
  let res
  try {
    res = await googleFetch(env, googleApi(env).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    return { ok: false, httpStatus: 0, error: 'network_error' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    return { ok: false, httpStatus: res.status, error: OAUTH_ERRORS.has(body.error) ? body.error : 'other' }
  }
  return { ok: true, httpStatus: res.status, accessToken: body.access_token, scope: body.scope || '' }
}

export const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...NO_STORE },
  })
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

export function stateCookie(value, maxAge) {
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

// Decodes the id_token payload. Safe without signature verification ONLY because the token
// came directly from Google's token endpoint over TLS (OpenID Connect Core §3.1.3.7).
export function idTokenClaims(idToken) {
  try {
    return JSON.parse(dec.decode(fromB64url(idToken.split('.')[1])))
  } catch {
    return {}
  }
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// extraHtml must be trusted, already-escaped markup.
export function page(status, title, message, extraHeaders = {}, extraHtml = '', backLink = true) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · GetShowUps</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e4e4e9;font:16px/1.6 system-ui,sans-serif;padding:24px}main{max-width:460px;text-align:center}h1{color:#fff;font-size:1.5rem;margin:0 0 12px}a{color:#ff8a47}button{font:inherit;font-weight:600;padding:12px 24px;border:0;border-radius:999px;background:#ff6a1a;color:#0b0b0c;cursor:pointer}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extraHtml}${backLink ? '<p><a href="/dashboard">Back to your dashboard</a></p>' : ''}</main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...NO_STORE,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // form-action must allow Google because Chrome applies it to the redirect after the POST.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
      ...extraHeaders,
    },
  })
}
