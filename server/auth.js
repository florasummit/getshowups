// Dashboard authentication: "Sign in with Google" (openid + email) or an emailed code/link (server/email-auth.js). Either
// way the session's email is a VERIFIED address; business access comes only from customer_users, resolved on every request. Session tokens
// are opaque and stored only as SHA-256. The customer for a dashboard request always comes from here.
import { ACCEPTANCE } from './acceptance-env.js'
import { json, missingConfig, randomToken, readCookie, sha256Hex } from './google-oauth.js'
import { activeDayHours, withDayHoursColumn } from './day-hours.js'
import { adminEmails } from './platform.js'

export const LOGIN_COOKIE = '__Host-gsu_login'
export const SESSION_COOKIE = '__Host-gsu_session'
export const LOGIN_TTL_SECONDS = 600
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
// Where a sign-in may return to: the admin console or a dashboard tab. Anything else → /dashboard (never an
// arbitrary URL, so the destination can't be used as an open redirect).
export const safeNext = (v) => (typeof v === 'string' && /^\/(admin(\/(review|control|voice-lab|growth))?|dashboard(\/(appointments|followups|receptionist|website|ads|settings))?)$/.test(v) ? v : '/dashboard')

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
  const workdays = String(row.workdays).split(',').filter(Boolean).map(Number)
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    serviceZips: String(row.service_zips || '').split(',').filter(Boolean),
    slotMinutes: row.slot_minutes,
    dayStart: row.day_start,
    dayEnd: row.day_end,
    workdays,
    // Booking days with their own hours (migration 0045, server/day-hours.js): { [weekday]: { start, end } }, {} = none.
    // dayHoursReady: the table exists (a row without the column, e.g. an older query, reads as not ready and no override).
    dayHours: activeDayHours({ workdays, dayStart: row.day_start, dayEnd: row.day_end, dayHours: row.day_hours }),
    dayHoursReady: row.day_hours_ready === 1,
    hoursConfirmed: Boolean(row.hours_confirmed_at),
    status: row.status || 'active',
    automations: row.automations !== 0,
    appointmentMode: row.appointment_mode === 'at_customer' ? 'at_customer' : 'at_business',
    createdAt: row.created_at,
  }
}

// Signed-in user (and their business, if any), or null.
export async function getSession(request, env, now = Date.now()) {
  // Set only by server/acceptance.js on an environment it built itself (a symbol, so no setting or request can carry it).
  if (env[ACCEPTANCE]) return env[ACCEPTANCE].session
  const token = readCookie(request, SESSION_COOKIE)
  if (!token || !TOKEN_RE.test(token)) return null
  const tokenHash = await sha256Hex(token)
  const row = await withDayHoursColumn((dayHours) =>
    env.ONBOARDING_DB.prepare(
      `SELECT s.token_hash, s.email, s.created_at AS signed_in_at, c.*, coalesce(cs.automations, 1) AS automations, ss.appointment_mode, ${dayHours}
         FROM sessions s
         LEFT JOIN customer_users u ON u.email = s.email
         LEFT JOIN customers c ON c.id = u.customer
         LEFT JOIN customer_settings cs ON cs.customer = c.id
         LEFT JOIN service_settings ss ON ss.customer = c.id
        WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
      .bind(tokenHash, now)
      .first(),
  )
  if (!row) return null
  return { tokenHash: row.token_hash, email: row.email, signedInAt: row.signed_in_at, customer: customerFromRow(row) }
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

// Where a new session lands (Google and email sign-in alike). A platform admin with no business membership goes to the
// console even if sign-in started from /dashboard, instead of being shown "create your business". This only changes the
// landing page: /admin still authorizes every request via PLATFORM_ADMIN_EMAILS. On a lookup error the ordinary landing
// is kept.
export async function landingFor(env, email, next) {
  const want = safeNext(next)
  if (want === '/admin' || !adminEmails(env).includes(email)) return want
  try {
    const member = await env.ONBOARDING_DB.prepare('SELECT 1 FROM customer_users WHERE email = ?1').bind(email).first()
    return member ? want : '/admin' // admin without a business: the console, never customer onboarding
  } catch {
    return want
  }
}

// Consequential account actions (closing, deleting, removing people, exporting): the person must have signed in (with
// Google, or with an emailed code or link, which proves control of the mailbox now) within the last 15 minutes. Protects
// against a copied or long-open GetShowUps session; not against someone at an unlocked browser that is still signed in
// to Google or to their mailbox. Test sessions never qualify.
export const FRESH_MS = 15 * 60 * 1000
export const isFresh = (session, now = Date.now()) => Number.isFinite(session?.signedInAt) && now - session.signedInAt <= FRESH_MS && session.signedInAt <= now + 60000
export const needsFresh = (session, now) => (isFresh(session, now) ? null : json(403, { error: 'reauth_required' }))

// Who may close the business, remove people, invite, export and change the subscription: the business's owner = its
// longest-standing member (derived; there are no roles to keep). If the owner leaves, the next one takes over.
export async function ownerEmail(db, customerId) {
  return (await db.prepare('SELECT email FROM customer_users WHERE customer = ?1 ORDER BY created_at, rowid LIMIT 1').bind(customerId).first())?.email ?? null
}
export const isOwner = async (db, session) => Boolean(session?.customer) && (await ownerEmail(db, session.customer.id)) === session.email
