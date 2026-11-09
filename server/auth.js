// Dashboard authentication: "Sign in with Google" (openid + email). Any Google-verified email may
// sign in; business access comes only from customer_users, resolved on every request. Session tokens
// are opaque and stored only as SHA-256. The customer for a dashboard request always comes from here.
import { json, missingConfig, randomToken, readCookie, sha256Hex } from './google-oauth.js'

export const LOGIN_COOKIE = '__Host-gsu_login'
export const SESSION_COOKIE = '__Host-gsu_session'
export const LOGIN_TTL_SECONDS = 600
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const LOGIN_SCOPES = ['openid', 'email']
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const siteOrigin = (env) => new URL(env.GOOGLE_REDIRECT_URI).origin
export const loginRedirectUri = (env) => `${siteOrigin(env)}/api/auth/google/callback`
export const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

// State-changing requests must come from our own pages.
export const isSameOrigin = (request, env) => request.headers.get('Origin') === siteOrigin(env)

export async function createSession(db, email, now = Date.now()) {
  const token = randomToken(32)
  await db
    .prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(token), email, now, now + SESSION_TTL_SECONDS * 1000)
    .run()
  return token
}

export function customerFromRow(row) {
  if (!row?.id) return null
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    serviceZips: String(row.service_zips || '').split(',').filter(Boolean),
    slotMinutes: row.slot_minutes,
    dayStart: row.day_start,
    dayEnd: row.day_end,
    workdays: String(row.workdays).split(',').filter(Boolean).map(Number),
    hoursConfirmed: Boolean(row.hours_confirmed_at),
    status: row.status || 'active',
    automations: row.automations !== 0,
    appointmentMode: row.appointment_mode === 'at_customer' ? 'at_customer' : 'at_business',
    createdAt: row.created_at,
  }
}

// Signed-in user (and their business, if any), or null.
export async function getSession(request, env, now = Date.now()) {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token || !TOKEN_RE.test(token)) return null
  const row = await env.ONBOARDING_DB.prepare(
    `SELECT s.token_hash, s.email, c.*, coalesce(cs.automations, 1) AS automations, ss.appointment_mode
       FROM sessions s
       LEFT JOIN customer_users u ON u.email = s.email
       LEFT JOIN customers c ON c.id = u.customer
       LEFT JOIN customer_settings cs ON cs.customer = c.id
       LEFT JOIN service_settings ss ON ss.customer = c.id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  )
    .bind(await sha256Hex(token), now)
    .first()
  if (!row) return null
  return { tokenHash: row.token_hash, email: row.email, customer: customerFromRow(row) }
}

export async function deleteSession(db, tokenHash) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run()
}

// Guard for /api/dashboard/* handlers. Returns { session } or { response } to return as-is.
// needCustomer: require the user to belong to a business (409 setup_required otherwise).
// write: also require a same-origin request (CSRF protection for POST routes).
export async function requireSession(request, env, { needCustomer = true, write = false } = {}) {
  if (missingConfig(env).length) return { response: json(503, { error: 'not_configured' }) }
  if (write && !isSameOrigin(request, env)) return { response: json(403, { error: 'forbidden' }) }
  let session
  try {
    session = await getSession(request, env)
  } catch (err) {
    console.error('Session lookup failed:', err?.message)
    return { response: json(503, { error: 'storage_error' }) }
  }
  if (!session) return { response: json(401, { error: 'unauthenticated' }) }
  if (needCustomer && !session.customer) return { response: json(409, { error: 'setup_required' }) }
  return { session }
}
