// Passwordless email sign-in (migration 0046), beside "Sign in with Google". Established pattern: the person asks with
// their address; we email a single-use LINK and a 6-digit CODE bound to the same request (15 minutes, one use, 5 wrong
// codes and it is dead); either proves control of the mailbox and creates the SAME session Google sign-in creates
// (server/auth.js createSession, same cookie, same landing rules), with session.email = that verified address.
//
// Who gets an email: exactly the people who may sign in today (signInAllowed). Everyone else gets the same answer and
// no email. The answer, its timing and its status never depend on whether an address is known: the lookup and the send
// run after the response (waitUntil). The link only works in the browser that asked (an HttpOnly cookie holds a random
// value whose hash is on the row), so a link forwarded or pre-fetched elsewhere cannot sign anyone in; the code works
// in any browser. GET never consumes anything (mail scanners open links): the link page asks for a click (POST).
//
// Linking policy (one identity = one verified address): the same verified address is the same person whatever the
// sign-in method; an existing Google user can also sign in by email for that address; nothing else is ever linked.
//
// Launch gate: sign-in emails reach any address only with AUTH_EMAIL_LIVE (or MESSAGES_LIVE) exactly 'true'; otherwise
// only MESSAGE_TEST_RECIPIENTS (server/email.js authRecipientAllowed). Tokens are never logged, returned, or stored
// (hashes only; the email is sent directly, never through the outbox).
import { adminEmails } from './platform.js'
import { billingMisconfigured, sandboxCheckoutAllowed } from './stripe.js'
import { enrollmentOpen } from './onboarding.js'
import { authEmailLive, emailConfigured, sendEmail } from './email.js'
import { EMAIL_RE, siteOrigin } from './auth.js'
import { b64url, decrypt, encrypt, randomToken, readCookie, sha256Hex, timingSafeEqual } from './google-oauth.js'

export const EMAIL_LOGIN_COOKIE = '__Host-gsu_email_login'
export const EMAIL_LOGIN_TTL_MS = 15 * 60 * 1000
export const MAX_CODE_ATTEMPTS = 5
export const RESEND_AFTER_SECONDS = 30 // the screen's "Resend" cooldown (the server limits per address too)
export const PURGE_GRACE_MS = 86_400_000
const LINK_RE = /^[A-Za-z0-9_-]{43}$/
const CODE_RE = /^\d{6}$/
const enc = new TextEncoder()

export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase()
export const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e)
export const cleanCode = (v) => String(v ?? '').replace(/[\s-]/g, '')
const emailHash = (email) => sha256Hex(`email-login:${email}`)

// AUTH_EMAIL_MOCK_ORIGIN: loopback-only test stand-in for the email provider (e2e), sign-in mail only. Never in production.
export const mockOrigin = (env) => {
  const o = env?.AUTH_EMAIL_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
}
export const deliveryConfigured = (env) => emailConfigured(env) || Boolean(mockOrigin(env))

// Before 0046 is applied the table is missing: email sign-in is unavailable (503), never half-working.
export async function tableReady(db) {
  try {
    await db.prepare('SELECT 1 FROM email_login_tokens LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

// Whether the sign-in screens offer email sign-in to everyone: table + delivery + the gate open for any address. Until
// then the form is shown only on request (?email=1, for testers) and only test recipients receive anything.
export async function emailSignInOffered(env) {
  return deliveryConfigured(env) && authEmailLive(env) && (await tableReady(env.ONBOARDING_DB))
}

// Exactly who may sign in today. Fail closed: a lookup error sends nothing.
//   platform admins (PLATFORM_ADMIN_EMAILS) · members of a business (customer_users) · an open account invitation ·
//   new people only where self-serve sign-up is open for them (public enrollment open, or an authorized tester).
// extraChecks: (db, email, now) → boolean, for other invitation kinds (fail-soft: a missing table counts as no).
const EXTRA_CHECKS = [
  // Staff roles and ownership invitations from the commercial enrollment stream (migration 0047). No-op before it.
  (db, email) => db.prepare('SELECT 1 FROM commercial_roles WHERE lower(email) = ?1 AND revoked_at IS NULL LIMIT 1').bind(email).first(),
  (db, email, now) => db.prepare('SELECT 1 FROM ownership_invites WHERE lower(email) = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 LIMIT 1').bind(email, now).first(),
]
export async function signInAllowed(env, email, now = Date.now(), { extraChecks = EXTRA_CHECKS } = {}) {
  if (adminEmails(env).includes(email)) return true
  const db = env.ONBOARDING_DB
  if (await db.prepare('SELECT 1 FROM customer_users WHERE email = ?1 LIMIT 1').bind(email).first()) return true
  if (await db.prepare('SELECT 1 FROM account_invites WHERE lower(email) = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 LIMIT 1').bind(email, now).first()) return true
  for (const check of extraChecks) if (await check(db, email, now).catch(() => null)) return true
  if (billingMisconfigured(env)) return false
  return (await enrollmentOpen(env)) || (await sandboxCheckoutAllowed(env, null, email))
}

async function codeKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`gsu-email-login:v1:${env.TOKEN_ENCRYPTION_KEY}`))
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}
export async function codeHash(env, id, code) {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await codeKey(env), enc.encode(`${id}:${code}`))))
}
// Uniform 000000–999999 (rejection sampling, no modulo bias).
export function randomCode() {
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, '0')
  }
}

export const linkUrl = (env, token) => `${siteOrigin(env)}/dashboard/email-sign-in#t=${token}`

function signInEmail(env, { code, token }) {
  return {
    subject: 'Sign in to GetShowUps',
    text:
      `Your sign-in code: ${code}\n\n` +
      `Or open this link in the same browser where you asked to sign in:\n${linkUrl(env, token)}\n\n` +
      'The code and the link work once and expire in 15 minutes.\n\n' +
      'Didn’t ask to sign in? You can ignore this email. No one can sign in without this code or link.',
  }
}

// The browser's half of a request: a random value (its hash is on the row) + the address and landing, sealed.
export async function sealBrowser(env, { email, next }, now = Date.now()) {
  const secret = randomToken(32)
  return { secret, sealed: await encrypt(env, JSON.stringify({ b: secret, e: email, n: next, iat: now })) }
}
export async function openBrowser(env, request) {
  try {
    const sealed = readCookie(request, EMAIL_LOGIN_COOKIE)
    if (!sealed) return null
    const v = JSON.parse(await decrypt(env, sealed))
    return typeof v?.b === 'string' && typeof v?.e === 'string' ? v : null
  } catch {
    return null
  }
}

// The work behind POST start, run AFTER the response so neither its timing nor its outcome is observable.
// Returns a code for tests and logs only ('sent' | 'not_allowed' | 'not_delivered' | 'limited' | 'failed'); never thrown.
export async function issueSignIn(env, { email, next, browserSecret }, now = Date.now(), { allowed = signInAllowed, hitSend } = {}) {
  const db = env.ONBOARDING_DB
  try {
    const eHash = await emailHash(email)
    // A new request ends every earlier one for this address (only the newest code and link work).
    await db.prepare('UPDATE email_login_tokens SET expires_at = ?2 WHERE email_hash = ?1 AND used_at IS NULL AND expires_at > ?2').bind(eHash, now).run()
    if (!(await allowed(env, email, now))) return 'not_allowed'
    if (hitSend && (await hitSend()).limited) return 'limited'
    const id = randomToken(12)
    const token = randomToken(32)
    const code = randomCode()
    await db
      .prepare('INSERT INTO email_login_tokens (id, email_hash, link_hash, code_hash, browser_hash, next, attempts, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)')
      .bind(id, eHash, await sha256Hex(token), await codeHash(env, id, code), await sha256Hex(browserSecret), next, now, now + EMAIL_LOGIN_TTL_MS)
      .run()
    const mock = mockOrigin(env)
    const sendEnv = mock && !emailConfigured(env) ? { ...env, RESEND_API_KEY: 'mock', EMAIL_FROM: 'GetShowUps <sign-in@test.invalid>' } : env
    const r = await sendEmail(sendEnv, { id: `signin:${id}`, to: email, ...signInEmail(env, { code, token }), signIn: true, apiOrigin: mock })
    if (!r.ok) {
      // Nothing was delivered (or we can't tell): the request can't be used, so it is ended now.
      await db.prepare('UPDATE email_login_tokens SET expires_at = ?2 WHERE id = ?1').bind(id, now).run()
      console.error('sign-in email not sent:', r.error)
      return 'not_delivered'
    }
    return 'sent'
  } catch (err) {
    console.error('sign-in request failed:', err?.name || 'error')
    return 'failed'
  }
}

// Code typed by the person. One statement: counts the attempt on every live request for the address and marks the
// matching one used. Returns { ok: true, next } or { ok: false } (wrong, expired, used, dead: one answer for all).
export async function consumeCode(env, { email, code }, now = Date.now()) {
  if (!CODE_RE.test(code)) return { ok: false }
  const db = env.ONBOARDING_DB
  const eHash = await emailHash(email)
  const { results } = await db.prepare('SELECT id FROM email_login_tokens WHERE email_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND attempts < ?3').bind(eHash, now, MAX_CODE_ATTEMPTS).all()
  if (!results.length) return { ok: false }
  let hit = null
  for (const r of results) {
    const expected = await codeHash(env, r.id, code)
    const row = await db
      .prepare(
        `UPDATE email_login_tokens SET attempts = attempts + 1, used_at = CASE WHEN code_hash = ?2 THEN ?3 ELSE NULL END
          WHERE id = ?1 AND used_at IS NULL AND expires_at > ?3 AND attempts < ?4 RETURNING used_at, code_hash, next`,
      )
      .bind(r.id, expected, now, MAX_CODE_ATTEMPTS)
      .first()
    if (row?.used_at && timingSafeEqual(row.code_hash, expected)) hit = row
  }
  return hit ? { ok: true, next: hit.next } : { ok: false }
}

// Link opened and confirmed (POST) in a browser. Works only in the browser that asked (cookie), once, before expiry.
// Returns { ok: true, email, next } or { ok: false, error } with error in link_invalid | link_used | link_expired | other_browser.
export async function consumeLink(env, request, { token }, now = Date.now()) {
  if (!LINK_RE.test(String(token))) return { ok: false, error: 'link_invalid' }
  const db = env.ONBOARDING_DB
  const linkHash = await sha256Hex(token)
  const browser = await openBrowser(env, request)
  if (browser) {
    const row = await db
      .prepare('UPDATE email_login_tokens SET used_at = ?3 WHERE link_hash = ?1 AND browser_hash = ?2 AND email_hash = ?4 AND used_at IS NULL AND expires_at > ?3 AND attempts < ?5 RETURNING next')
      .bind(linkHash, await sha256Hex(browser.b), now, await emailHash(normalizeEmail(browser.e)), MAX_CODE_ATTEMPTS)
      .first()
    if (row) return { ok: true, email: normalizeEmail(browser.e), next: row.next }
  }
  // Why it didn't work, told to the holder of a 256-bit link (no address is revealed).
  const row = await db.prepare('SELECT used_at, expires_at, attempts FROM email_login_tokens WHERE link_hash = ?1').bind(linkHash).first()
  if (!row) return { ok: false, error: 'link_invalid' }
  if (row.used_at) return { ok: false, error: 'link_used' }
  if (row.expires_at <= now || row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'link_expired' }
  return { ok: false, error: 'other_browser' }
}

// Expired requests are refused already; this removes the rows a day after they expire (cron, bounded). No-op before 0046.
export async function purgeExpiredSignIns(env, now = Date.now(), limit = 500) {
  try {
    const r = await env.ONBOARDING_DB.prepare('DELETE FROM email_login_tokens WHERE id IN (SELECT id FROM email_login_tokens WHERE expires_at < ?1 LIMIT ?2)').bind(now - PURGE_GRACE_MS, limit).run()
    return { removed: r.meta?.changes ?? 0 }
  } catch {
    return { removed: 0, unavailable: true }
  }
}
