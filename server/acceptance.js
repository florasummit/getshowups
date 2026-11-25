// Test sessions: the acceptance runner (scripts/acceptance) uses the deployed dashboard of ONE admin-marked test business,
// without Google and without being anyone. Separate from normal sign-in: its own cookie, its own tables; server/auth.js and
// requirePlatformAdmin never read either. Off unless ACCEPTANCE_SESSIONS_ENABLED is exactly 'true'. Any error = refused.
//   pair:    the runner sends the hash of a secret only it has → a 10-minute code; a platform admin approves the code for a
//            test business (typed id + confirm) → a 90-day grant; a code works once
//   session: the secret → a 1-hour session cookie; the newest replaces the older
//   request: middleware → this file → exact method + path list → handler with a stripped environment (acceptance-env.js)
import { json, randomToken, readCookie, sha256Hex, timingSafeEqual } from './google-oauth.js'
import { customerFromRow, isSameOrigin, SESSION_COOKIE } from './auth.js'
import { hit, hitByIp, tooManyJson } from './ratelimit.js'
import { recordEvent } from './auditlog.js'
import { CUSTOMER_RE } from './invites.js'
import { testStatus } from './testbusiness.js'
import { acceptanceEnv } from './acceptance-env.js'

export const COOKIE = '__Host-gsu_acceptance'
export const PAIR_MS = 10 * 60_000
export const SESSION_MS = 60 * 60_000
export const GRANT_MS = 90 * 86_400_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const HASH = /^[0-9a-f]{64}$/
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE = new RegExp(`^[${ALPHABET}]{4}-?[${ALPHABET}]{4}$`)
export const acceptanceEnabled = (env) => env.ACCEPTANCE_SESSIONS_ENABLED === 'true'
const refused = (status = 403) => json(status, { error: 'not_allowed' })
const note = (env, type, customer, outcome, details = {}, id = 'acceptance') => recordEvent(env.ONBOARDING_DB, { type: `acceptance.${type}`, actor: 'system:acceptance', customer, capability: 'platform.acceptance', resource: { type: 'acceptance_grant', id }, outcome, details }).catch(() => {})
const codeHash = (code) => sha256Hex(`acceptance-code:${code.replace('-', '')}`)
const newCode = () => [...crypto.getRandomValues(new Uint8Array(64))].filter((b) => b < 248).slice(0, 8).map((b) => ALPHABET[b % ALPHABET.length]).join('')

// Everything that must hold, read together, every time. → row | null
const live = (db, tokenHash, now) =>
  db
    .prepare(
      `SELECT s.grant_id, c.*, coalesce(cs.automations, 1) AS automations, ss.appointment_mode
         FROM acceptance_sessions s
         JOIN acceptance_grants g ON g.id = s.grant_id AND g.customer = s.customer AND g.revoked_at IS NULL AND g.expires_at > ?2
         JOIN test_businesses t ON t.customer = s.customer AND t.is_test = 1
         JOIN customers c ON c.id = s.customer AND c.status = 'active'
         LEFT JOIN customer_settings cs ON cs.customer = c.id
         LEFT JOIN service_settings ss ON ss.customer = c.id
        WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = c.id)`,
    )
    .bind(tokenHash, now)
    .first()

// POST /api/acceptance/pair { secretHash } → { code, expiresAt }
export async function startPairing(request, env, now = Date.now()) {
  if (!acceptanceEnabled(env)) return refused(404)
  try {
    if ((await hitByIp(env, 'acceptancePair', request)).limited || (await hit(env, 'acceptancePairAll', 'all')).limited) return tooManyJson(600)
    const b = await request.json().catch(() => null)
    if (typeof b?.secretHash !== 'string' || !HASH.test(b.secretHash)) return json(400, { error: 'invalid_request' })
    const db = env.ONBOARDING_DB
    await db.prepare('DELETE FROM acceptance_pairings WHERE expires_at <= ?1').bind(now).run()
    const code = newCode()
    if (code.length !== 8) return refused(503)
    const used = await db.prepare('SELECT 1 AS x FROM acceptance_grants WHERE secret_hash = ?1').bind(b.secretHash).first()
    if (used) return json(409, { error: 'secret_used' })
    await db.prepare('INSERT INTO acceptance_pairings (id, code_hash, secret_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(randomToken(9), await codeHash(code), b.secretHash, now, now + PAIR_MS).run()
    return json(200, { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: now + PAIR_MS })
  } catch {
    return refused(503)
  }
}

// Platform admin (functions/api/platform/acceptance.js). → { ok, grant } | { ok: false, status, error }
export async function approvePairing(env, adminEmail, { code, customer, confirmCustomer, confirm }, now = Date.now()) {
  const fail = (status, error) => ({ ok: false, status, error })
  if (!acceptanceEnabled(env)) return fail(409, 'switched_off')
  const up = String(code || '').trim().toUpperCase()
  if (confirm !== true || !CODE.test(up) || typeof customer !== 'string' || !CUSTOMER_RE.test(customer) || confirmCustomer !== customer) return fail(400, 'invalid_request')
  const db = env.ONBOARDING_DB
  const t = await testStatus(env, customer)
  if (t.test !== true || t.unreadable) return fail(403, 'not_test_business')
  const id = randomToken(12)
  const hash = await codeHash(up)
  // One transaction, every condition inside it: a code is spent exactly once, and only for a business that is a test
  // business at that moment. An older grant of the business ends (renewing = pairing and confirming again).
  const eligible = "EXISTS (SELECT 1 FROM test_businesses t JOIN customers c ON c.id = t.customer WHERE t.customer = ?2 AND t.is_test = 1 AND c.status = 'active')"
  const [ins] = await db.batch([
    db.prepare(`INSERT INTO acceptance_grants (id, customer, secret_hash, approved_by, created_at, expires_at) SELECT ?1, ?2, p.secret_hash, ?3, ?4, ?5 FROM acceptance_pairings p WHERE p.code_hash = ?6 AND p.status = 'pending' AND p.expires_at > ?4 AND ${eligible}`).bind(id, customer, `ref:${(await sha256Hex(adminEmail)).slice(0, 12)}`, now, now + GRANT_MS, hash),
    db.prepare("UPDATE acceptance_pairings SET status = 'approved' WHERE code_hash = ?1 AND EXISTS (SELECT 1 FROM acceptance_grants WHERE id = ?2)").bind(hash, id),
    db.prepare('UPDATE acceptance_grants SET revoked_at = ?3 WHERE customer = ?1 AND id <> ?2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM acceptance_grants WHERE id = ?2)').bind(customer, id, now),
  ])
  return ins?.meta?.changes === 1 ? { ok: true, grant: { id, customer, expiresAt: now + GRANT_MS } } : fail(404, 'code_not_valid')
}

export async function revokeGrant(env, id, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const r = await db.prepare('UPDATE acceptance_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL RETURNING customer').bind(id, now).first()
  await db.prepare('DELETE FROM acceptance_sessions WHERE grant_id = ?1').bind(id).run()
  return r ? { ok: true, customer: r.customer } : { ok: false, status: 404, error: 'not_found' }
}
export const listGrants = async (env, now = Date.now()) => (await env.ONBOARDING_DB.prepare('SELECT id, customer, created_at, expires_at, revoked_at, last_used_at FROM acceptance_grants ORDER BY created_at DESC LIMIT 20').all()).results.map((g) => ({ ...g, active: !g.revoked_at && g.expires_at > now }))

// POST /api/acceptance/session (Authorization: Bearer secret) → 200 + cookie | 202 waiting for approval | 401
export async function startSession(request, env, now = Date.now()) {
  if (!acceptanceEnabled(env)) return refused(404)
  try {
    if ((await hitByIp(env, 'acceptanceSession', request)).limited) return tooManyJson(600)
    const secret = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1]
    if (!secret) return refused(401)
    const db = env.ONBOARDING_DB
    const hash = await sha256Hex(secret)
    const g = await db.prepare("SELECT g.id, g.customer, g.secret_hash FROM acceptance_grants g JOIN test_businesses t ON t.customer = g.customer AND t.is_test = 1 JOIN customers c ON c.id = g.customer AND c.status = 'active' WHERE g.secret_hash = ?1 AND g.revoked_at IS NULL AND g.expires_at > ?2").bind(hash, now).first()
    if (!g || !timingSafeEqual(g.secret_hash, hash)) {
      const waiting = await db.prepare("SELECT 1 AS x FROM acceptance_pairings WHERE secret_hash = ?1 AND status = 'pending' AND expires_at > ?2").bind(hash, now).first()
      return waiting ? json(202, { pending: true }) : refused(401)
    }
    const token = randomToken(32)
    const th = await sha256Hex(token)
    await db.batch([
      db.prepare('DELETE FROM acceptance_sessions WHERE grant_id = ?1 OR expires_at <= ?2').bind(g.id, now),
      db.prepare('INSERT INTO acceptance_sessions (token_hash, grant_id, customer, created_at, expires_at) SELECT ?1, g.id, g.customer, ?3, ?4 FROM acceptance_grants g WHERE g.id = ?2 AND g.revoked_at IS NULL AND g.expires_at > ?3').bind(th, g.id, now, now + SESSION_MS),
      db.prepare('UPDATE acceptance_grants SET last_used_at = ?2 WHERE id = ?1').bind(g.id, now),
    ])
    if (!(await live(db, th, now))) return refused(401)
    await note(env, 'session', g.customer, 'success', {}, g.id)
    const res = json(200, { customer: g.customer, expiresAt: now + SESSION_MS })
    res.headers.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`)
    return res
  } catch {
    return refused(503)
  }
}

// Does this request belong here? Only when it carries a test cookie and no normal session: a person's own session always
// wins and is never combined with a test session.
export const carriesTestSession = (request) => Boolean(readCookie(request, COOKIE)) && !readCookie(request, SESSION_COOKIE)

// → Response. Every /api/ request of a test session ends here; nothing falls through to other handlers.
export async function dispatch(request, env, routes, now = Date.now()) {
  const url = new URL(request.url)
  try {
    if (!acceptanceEnabled(env)) return refused()
    const token = readCookie(request, COOKIE) || ''
    if (!TOKEN.test(token)) return refused()
    const th = await sha256Hex(token)
    const row = await live(env.ONBOARDING_DB, th, now)
    if (!row) return refused()
    const key = `${request.method} ${url.pathname}`
    const route = Object.hasOwn(routes, key) ? routes[key] : null
    if (!route) {
      if (request.method !== 'GET' && !(await hit(env, 'acceptanceRefused', row.id)).limited) await note(env, 'refused', row.id, 'failure', { method: request.method, area: url.pathname.split('/').slice(1, 4).join('/') }, row.grant_id)
      return refused()
    }
    if (request.method !== 'GET' && !isSameOrigin(request, env)) return refused()
    const { grant_id: grantId, ...c } = row
    const grant = {
      customer: c.id,
      session: { tokenHash: th, email: 'acceptance-test@getshowups.invalid', customer: customerFromRow(c) },
      recheck: async () => acceptanceEnabled(env) && Boolean(await live(env.ONBOARDING_DB, th, Date.now())),
    }
    return await route.handler({ request, env: acceptanceEnv(env, grant, { fixture: route.fixture === true }), params: {}, waitUntil: () => {}, grant, grantId })
  } catch (err) {
    console.error('acceptance request refused:', String(err?.message).slice(0, 40))
    return refused()
  }
}
