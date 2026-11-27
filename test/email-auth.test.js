// Passwordless email sign-in (server/email-auth.js, migration 0046): token lifecycle, single use, expiry, attempts,
// replay, enumeration-equal answers, rate limits, launch gate, who may sign in, linking policy, a session identical to
// Google's, same-origin, fail-soft before the migration, and leak checks. Real handlers + real migrations on node:sqlite.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { sha256Hex } from '../server/google-oauth.js'
import { getSession, isFresh } from '../server/auth.js'
import { EMAIL_LOGIN_TTL_MS, MAX_CODE_ATTEMPTS, issueSignIn, purgeExpiredSignIns, randomCode, signInAllowed } from '../server/email-auth.js'
import * as status from '../functions/api/auth/email/index.js'
import * as start from '../functions/api/auth/email/start.js'
import * as verify from '../functions/api/auth/email/verify.js'
import * as loginStart from '../functions/api/auth/google/start.js'
import * as loginCallback from '../functions/api/auth/google/callback.js'
import * as me from '../functions/api/dashboard/me.js'
import * as connectLink from '../functions/api/dashboard/connect-link.js'

const ORIGIN = 'https://getshowups.com'
const CLIENT_ID = 'cid.apps.googleusercontent.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const RESEND_KEY = 're_test_SECRET_VALUE'
const OWNER = 'owner@alpha.example'
const ADMIN = 'founder@getshowups.example'
const INVITED = 'invited@bravo.example'
const STRANGER = 'stranger@nowhere.example'
const TESTER = 'tester@qa.example'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => {
      const r = sql.prepare(q).run(...args)
      return { meta: { changes: r.changes } }
    },
  })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

let env, db, mail, responses, logs, origFetch, origError, pending, googleEmail
beforeEach(() => {
  db = d1()
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES ('alpha', 'Alpha Pools', 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?)").run(now, now)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES ('bravo', 'Bravo Electric', 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?)").run(now, now)
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES (?, 'alpha', ?)").run(OWNER, now)
  db.sql.prepare("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at) VALUES ('inv1', 'h', ?, 'bravo', ?, ?, ?)").run(INVITED, ADMIN, now, now + 86400_000)
  // Billing on in test mode with a plan on sale: public self-serve sign-up is CLOSED (as in production today).
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Growth', 'price_x', 0, '{}', 1, 1)").run()
  env = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'admin-token-'.padEnd(48, 'x'),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async () => null, put: async () => {} },
    RESEND_API_KEY: RESEND_KEY,
    EMAIL_FROM: 'GetShowUps <hello@getshowups.com>',
    PLATFORM_ADMIN_EMAILS: ADMIN,
    MESSAGE_TEST_RECIPIENTS: [OWNER, ADMIN].join(','), // a listed test recipient also counts as a tester (may sign up)
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
  }
  mail = []
  responses = []
  pending = []
  googleEmail = OWNER
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.resend.com/emails' || /^http:\/\/127\.0\.0\.1:\d+\/resend\/emails$/.test(u)) {
      const body = JSON.parse(init.body)
      mail.push({ url: u, to: body.to[0], subject: body.subject, text: body.text, code: body.text.match(/code: (\d{6})/)?.[1], token: body.text.match(/#t=([A-Za-z0-9_-]{43})/)?.[1] })
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
    }
    if (u === 'https://oauth2.googleapis.com/token') {
      const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, email: googleEmail })).toString('base64url')
      return new Response(JSON.stringify({ id_token: `h.${p}.s` }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  // Leak check: no code, link token, provider key or encryption key in any response body or log line.
  const all = [...responses, ...logs].join('\n')
  for (const m of mail) {
    if (m.code) assert.ok(!all.includes(m.code), 'code leaked')
    if (m.token) assert.ok(!all.includes(m.token), 'link token leaked')
  }
  assert.ok(!all.includes(RESEND_KEY) && !all.includes(KEY), 'key leaked')
})

async function call(mod, method, path, { cookie, origin = ORIGIN, body, ip = '203.0.113.7', waitUntil = true } = {}) {
  const headers = { 'CF-Connecting-IP': ip }
  if (cookie) headers.Cookie = cookie
  if (origin) headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const request = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const ctx = { request, env, params: {} }
  if (waitUntil) ctx.waitUntil = (p) => pending.push(p)
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`](ctx)
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, text, json: () => JSON.parse(text), cookies: res.headers.getSetCookie() }
}
const settle = async () => {
  await Promise.all(pending.splice(0))
}
const cookieOf = (r, name) => r.cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'))?.split(';')[0]
async function ask(email, opts = {}) {
  const r = await call(start, 'POST', '/api/auth/email/start', { body: { email, next: opts.next }, ...opts })
  await settle()
  return r
}
const byCode = (email, code, opts = {}) => call(verify, 'POST', '/api/auth/email/verify', { body: { email, code }, ...opts })
const byLink = (token, cookie, opts = {}) => call(verify, 'POST', '/api/auth/email/verify', { body: { token }, cookie, ...opts })
const sessionRows = () => db.sql.prepare('SELECT email FROM sessions').all().map((r) => r.email)

// ---------- start: one answer for everyone ----------
test('start: the same answer for a member, an admin, an invitee, an unknown address and a closed sign-up; mail only to who may sign in', async () => {
  env.AUTH_EMAIL_LIVE = 'true' // the gate is open: only who may sign in decides
  const answers = []
  for (const e of [OWNER, ADMIN, INVITED, STRANGER, 'Owner@Alpha.Example ']) {
    const r = await ask(e, { ip: `198.51.100.${answers.length + 1}` })
    assert.equal(r.status, 200)
    assert.ok(cookieOf(r, '__Host-gsu_email_login'), 'browser binding cookie set for everyone')
    assert.match(r.cookies[0], /HttpOnly; Secure; SameSite=Lax; Max-Age=900/)
    answers.push(r.text)
  }
  assert.equal(new Set(answers).size, 1, 'byte-identical bodies')
  assert.deepEqual(JSON.parse(answers[0]), { ok: true, resendAfter: 30 })
  // Public sign-up is closed and STRANGER is not a tester, admin, member or invitee: no email.
  assert.deepEqual(mail.map((m) => m.to), [OWNER, ADMIN, INVITED, OWNER])
  assert.ok(mail.every((m) => /^\d{6}$/.test(m.code) && m.token && m.subject === 'Sign in to GetShowUps'))
  assert.match(mail[0].text, /https:\/\/getshowups\.com\/dashboard\/email-sign-in#t=/)
  // Nothing stored in the outbox; tokens stored only as hashes; no address in the table.
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM email_outbox').get().n, 0)
  const rows = db.sql.prepare('SELECT * FROM email_login_tokens').all()
  const dump = JSON.stringify(rows)
  for (const m of mail) assert.ok(!dump.includes(m.code) && !dump.includes(m.token))
  assert.ok(!dump.includes('alpha.example') && !dump.includes('@'))
  // A refusal of the address format is the only other answer (format only, says nothing about accounts).
  assert.equal((await ask('not-an-email')).json().error, 'invalid_email')
})

test('start: the answer does not wait for the lookup or the email (waitUntil), so timing reveals nothing', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const slowFetch = globalThis.fetch
  globalThis.fetch = async (...a) => (await gate, slowFetch(...a))
  const r = await call(start, 'POST', '/api/auth/email/start', { body: { email: OWNER } })
  assert.equal(r.status, 200)
  assert.equal(mail.length, 0, 'answered before the email was sent')
  release()
  await settle()
  assert.equal(mail.length, 1)
})

test('who may sign in: open sign-up, testers, admins, members, invitees; closed sign-up and revoked/expired invitations get nothing', async () => {
  const allowed = (e) => signInAllowed(env, e)
  assert.equal(await allowed(OWNER), true)
  assert.equal(await allowed(ADMIN), true)
  assert.equal(await allowed(INVITED), true)
  assert.equal(await allowed(STRANGER), false)
  // A tester (sandbox checkout allowed) may start a business today, so may sign in.
  assert.equal(await signInAllowed({ ...env, MESSAGE_TEST_RECIPIENTS: TESTER }, TESTER), true)
  // Public enrollment open (live billing): anyone.
  assert.equal(await signInAllowed({ ...env, STRIPE_LIVE_ENABLED: 'true' }, STRANGER), true)
  // Half-configured billing refuses new sign-ups: nobody new.
  assert.equal(await signInAllowed({ ...env, STRIPE_WEBHOOK_SECRET: '' }, STRANGER), false)
  db.sql.prepare('UPDATE account_invites SET revoked_at = 1').run()
  assert.equal(await allowed(INVITED), false)
  db.sql.prepare('UPDATE account_invites SET revoked_at = NULL, expires_at = 1').run()
  assert.equal(await allowed(INVITED), false)
  // Extra invitation kinds (commercial roles / ownership invitations) are fail-soft before their table exists.
  assert.equal(await allowed('rep@sales.example'), false)
  // A lookup error fails closed: nothing is sent.
  const broken = { ...env, ONBOARDING_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('db down') }, run: async () => ({}) }) }) } }
  assert.equal(await issueSignIn(broken, { email: OWNER, next: '/dashboard', browserSecret: 'x' }), 'failed')
  assert.equal(mail.length, 0)
})

// ---------- code ----------
test('code: signs in once with the SAME session as Google sign-in; replay, other codes and the link are dead afterwards', async () => {
  await ask(OWNER)
  const { code, token } = mail[0]
  const ok = await byCode(OWNER, `${code.slice(0, 3)} ${code.slice(3)}`) // pasted with a space
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json(), { ok: true, next: '/dashboard' })
  const session = cookieOf(ok, '__Host-gsu_session')
  assert.ok(session)
  assert.ok(ok.cookies.some((c) => c.startsWith('__Host-gsu_email_login=;') && c.includes('Max-Age=0')), 'binding cookie cleared')
  // Same cookie attributes and session row as Google sign-in.
  const g = await call(loginStart, 'GET', '/api/auth/google/start')
  const st = new URL(g.res.headers.get('Location')).searchParams.get('state')
  const cb = await call(loginCallback, 'GET', `/api/auth/google/callback?code=C&state=${st}`, { cookie: g.cookies[0].split(';')[0] })
  const attrs = (c) => c.split(';').slice(1).map((s) => s.trim()).join(';')
  const gCookie = cb.cookies.find((c) => c.startsWith('__Host-gsu_session=') && !c.includes('Max-Age=0'))
  assert.equal(attrs(ok.cookies.find((c) => c.startsWith('__Host-gsu_session='))), attrs(gCookie))
  assert.deepEqual(sessionRows(), [OWNER, OWNER], 'both sign-in methods → the same identity (the address)')
  const s = await getSession(new Request(ORIGIN, { headers: { Cookie: session } }), env)
  assert.equal(s.email, OWNER)
  assert.equal(s.customer.id, 'alpha', 'an existing Google user reaches their business by email sign-in')
  assert.equal(isFresh(s), true, 'a just-verified email sign-in counts as a recent sign-in')
  // Replay of the code, and the link of the same request, no longer work.
  assert.equal((await byCode(OWNER, code)).json().error, 'code_invalid')
  assert.equal((await byLink(token, null)).json().error, 'link_used')
  assert.equal(sessionRows().length, 2)
})

test('code: wrong, expired and unknown give one answer; 5 guesses then too_many_attempts for known and unknown addresses alike', async () => {
  await ask(OWNER)
  const { code } = mail[0]
  const wrong = code === '000000' ? '111111' : '000000'
  assert.equal((await byCode(STRANGER, wrong)).json().error, 'code_invalid')
  const answers = []
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) answers.push((await byCode(OWNER, wrong)).text)
  assert.equal(new Set(answers).size, 1)
  const locked = await byCode(OWNER, code)
  assert.equal(locked.status, 429)
  assert.equal(locked.json().error, 'too_many_attempts')
  for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) await byCode(STRANGER, wrong)
  assert.equal((await byCode(STRANGER, wrong)).text, locked.text, 'unknown address: same lock answer')
  // The request itself is dead after 5 wrong codes, even once the guess counter is reset.
  db.sql.prepare('DELETE FROM rate_limits').run()
  assert.equal((await byCode(OWNER, code)).json().error, 'code_invalid')
  assert.equal(sessionRows().length, 0)
})

test('code: expires after 15 minutes; a new request (Resend) ends the old code and link and resets the guess count', async () => {
  await ask(OWNER)
  const first = mail[0]
  db.sql.prepare('UPDATE email_login_tokens SET expires_at = ?').run(Date.now() - 1)
  assert.equal((await byCode(OWNER, first.code)).json().error, 'code_invalid')
  await ask(OWNER)
  await ask(OWNER)
  const [, second, third] = mail
  assert.equal((await byCode(OWNER, second.code === third.code ? '999999' : second.code)).json().error, 'code_invalid', 'older code ended by Resend')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM email_login_tokens WHERE expires_at > ?').get(Date.now()).n, 1)
  const row = db.sql.prepare('SELECT created_at, expires_at FROM email_login_tokens WHERE expires_at > ?').get(Date.now())
  assert.equal(row.expires_at - row.created_at, EMAIL_LOGIN_TTL_MS)
  assert.equal((await byCode(OWNER, third.code)).status, 200)
})

// ---------- link ----------
test('link: only in the browser that asked, once; other browsers are told to use the code; expired and used are explained', async () => {
  const asked = await ask(OWNER, { next: '/dashboard/settings' })
  const binding = cookieOf(asked, '__Host-gsu_email_login')
  const { token } = mail[0]
  // A pre-fetch or a forwarded link (no binding cookie, or another browser's) does nothing.
  assert.equal((await byLink(token, null)).json().error, 'other_browser')
  const other = cookieOf(await ask(STRANGER, { ip: '198.51.100.9' }), '__Host-gsu_email_login')
  assert.equal((await byLink(token, other)).json().error, 'other_browser')
  assert.equal(sessionRows().length, 0)
  const ok = await byLink(token, binding)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.json().next, '/dashboard/settings')
  assert.deepEqual(sessionRows(), [OWNER])
  assert.equal((await byLink(token, binding)).json().error, 'link_used')
  assert.equal((await byLink('x'.repeat(43), binding)).json().error, 'link_invalid')
  assert.equal((await byLink('short', binding)).json().error, 'link_invalid')
  await ask(OWNER)
  db.sql.prepare('UPDATE email_login_tokens SET expires_at = 1 WHERE used_at IS NULL').run()
  assert.equal((await byLink(mail[1].token, binding)).json().error, 'link_expired')
  // GET never consumes: the verify route has no GET handler (the link opens a page that asks for a click).
  assert.equal(typeof verify.onRequestGet, 'undefined')
  assert.equal(typeof start.onRequestGet, 'undefined')
})

test('landing: the same allowlisted rules as Google sign-in (admin without a business → console, unknown next → /dashboard)', async () => {
  await ask(ADMIN, { next: '/dashboard' })
  assert.equal((await byCode(ADMIN, mail[0].code)).json().next, '/admin')
  await ask(OWNER, { next: 'https://evil.example/' })
  assert.equal((await byCode(OWNER, mail[1].code)).json().next, '/dashboard')
})

test('invitation: an invitee signed in by email sees their invitation exactly as with Google (same address = same person)', async () => {
  env.AUTH_EMAIL_LIVE = 'true'
  await ask(INVITED)
  const r = await byCode(INVITED, mail[0].code)
  const m = await call(me, 'GET', '/api/dashboard/me', { cookie: cookieOf(r, '__Host-gsu_session') })
  assert.equal(m.json().email, INVITED)
  assert.equal(m.json().customer, null, 'no automatic linking: the invitation is accepted by its own step')
})

test('calendar: an owner signed in by email can start the separate Google Calendar connection', async () => {
  await ask(OWNER)
  const cookie = cookieOf(await byCode(OWNER, mail[0].code), '__Host-gsu_session')
  const r = await call(connectLink, 'POST', '/api/dashboard/connect-link', { cookie })
  assert.equal(r.status, 201)
  assert.match(r.json().url, /\/api\/google\/oauth\/start\?invite=/)
})

// ---------- protections ----------
test('same-origin: start and verify refuse cross-site requests', async () => {
  assert.equal((await call(start, 'POST', '/api/auth/email/start', { body: { email: OWNER }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(start, 'POST', '/api/auth/email/start', { body: { email: OWNER }, origin: null })).status, 403)
  assert.equal((await call(verify, 'POST', '/api/auth/email/verify', { body: { email: OWNER, code: '123456' }, origin: 'https://evil.example' })).status, 403)
  await settle()
  assert.equal(mail.length, 0)
})

test('rate limits: per IP and per address (known or not, same answer); a sending ceiling for everyone', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await ask(STRANGER, { ip: `192.0.2.${i}` })).status, 200)
  const perAddress = await ask(STRANGER, { ip: '192.0.2.99' })
  assert.equal(perAddress.status, 429)
  assert.ok(Number(perAddress.res.headers.get('Retry-After')) > 0)
  for (let i = 0; i < 5; i++) await ask(OWNER, { ip: `192.0.2.${10 + i}` })
  assert.equal((await ask(OWNER, { ip: '192.0.2.98' })).text, perAddress.text, 'known address: identical refusal')
  db.sql.prepare('DELETE FROM rate_limits').run()
  for (let i = 0; i < 10; i++) await ask(`p${i}@x.example`, { ip: '192.0.2.200' })
  assert.equal((await ask('p10@x.example', { ip: '192.0.2.200' })).status, 429, 'per IP')
  for (let i = 0; i < 30; i++) await call(verify, 'POST', '/api/auth/email/verify', { body: { email: `v${i}@x.example`, code: '123456' }, ip: '192.0.2.201' })
  assert.equal((await call(verify, 'POST', '/api/auth/email/verify', { body: { email: 'v@x.example', code: '123456' }, ip: '192.0.2.201' })).status, 429, 'verify per IP')
  // Global send ceiling: nothing is sent once reached (the answer stays the same).
  db.sql.prepare('DELETE FROM rate_limits').run()
  const before = mail.length
  const r = await issueSignIn(env, { email: OWNER, next: '/dashboard', browserSecret: 's' }, Date.now(), { hitSend: async () => ({ limited: true }) })
  assert.equal(r, 'limited')
  assert.equal(mail.length, before)
})

test('launch gate: only test recipients receive sign-in emails until AUTH_EMAIL_LIVE (or MESSAGES_LIVE) is exactly true', async () => {
  env.MESSAGE_TEST_RECIPIENTS = ADMIN
  await ask(OWNER)
  assert.equal(mail.length, 0, 'member, but not a test recipient: held')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM email_login_tokens WHERE expires_at > ?').get(Date.now()).n, 0, 'an undeliverable request is ended at once')
  env.AUTH_EMAIL_LIVE = 'yes'
  await ask(OWNER, { ip: '198.51.100.50' })
  assert.equal(mail.length, 0)
  env.AUTH_EMAIL_LIVE = 'true'
  await ask(OWNER, { ip: '198.51.100.51' })
  assert.equal(mail.length, 1)
  delete env.AUTH_EMAIL_LIVE
  env.MESSAGES_LIVE = 'true'
  await ask(OWNER, { ip: '198.51.100.52' })
  assert.equal(mail.length, 2)
  // The gate never opens the eligibility rule: a stranger still gets nothing.
  env.AUTH_EMAIL_LIVE = 'true'
  await ask(STRANGER, { ip: '198.51.100.53' })
  assert.equal(mail.length, 2)
})

test('offered: the sign-in screens offer email only with delivery, the table and the gate open; the e2e stand-in is loopback-only', async () => {
  assert.deepEqual((await call(status, 'GET', '/api/auth/email')).json(), { offered: false })
  env.AUTH_EMAIL_LIVE = 'true'
  assert.deepEqual((await call(status, 'GET', '/api/auth/email')).json(), { offered: true })
  delete env.RESEND_API_KEY
  assert.deepEqual((await call(status, 'GET', '/api/auth/email')).json(), { offered: false })
  assert.equal((await ask(OWNER)).json().error, 'not_available')
  env.AUTH_EMAIL_MOCK_ORIGIN = 'https://mail.example' // not loopback: ignored
  assert.equal((await ask(OWNER)).json().error, 'not_available')
  env.AUTH_EMAIL_MOCK_ORIGIN = 'http://127.0.0.1:4531'
  await ask(OWNER, { ip: '198.51.100.60' })
  assert.equal(mail.length, 1)
  assert.equal(mail[0].url, 'http://127.0.0.1:4531/resend/emails')
})

test('before migration 0046: email sign-in is unavailable (503), nothing else changes; cron purge is a no-op', async () => {
  db.sql.exec('DROP TABLE email_login_tokens')
  env.AUTH_EMAIL_LIVE = 'true'
  assert.deepEqual((await call(status, 'GET', '/api/auth/email')).json(), { offered: false })
  assert.equal((await ask(OWNER)).status, 503)
  assert.equal((await byCode(OWNER, '123456')).status, 503)
  assert.deepEqual(await purgeExpiredSignIns(env), { removed: 0, unavailable: true })
  assert.equal(mail.length, 0)
})

test('purge: rows go a day after they expire, never a live one', async () => {
  await ask(OWNER)
  const now = Date.now()
  db.sql.prepare("INSERT INTO email_login_tokens (id, email_hash, link_hash, code_hash, browser_hash, created_at, expires_at) VALUES ('old', 'e', 'l', 'c', 'b', 1, ?)").run(now - 2 * 86400_000)
  assert.deepEqual(await purgeExpiredSignIns(env, now), { removed: 1 })
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM email_login_tokens').get().n, 1)
})

test('codes are uniform 6-digit strings; code hashes are keyed (not a plain hash of the code)', async () => {
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const c = randomCode()
    assert.match(c, /^\d{6}$/)
    seen.add(c)
  }
  assert.ok(seen.size > 490)
  await ask(OWNER)
  const row = db.sql.prepare('SELECT code_hash FROM email_login_tokens').get()
  assert.notEqual(row.code_hash, await sha256Hex(mail[0].code))
})
