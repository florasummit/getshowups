// Tests for the Google Calendar OAuth Pages Functions.
// Runs the real handlers against an in-memory D1 (node:sqlite, Node 22.5+), a Map-backed KV,
// and a mocked Google. No network, no Cloudflare account, no dependencies. Run: npm test
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

import * as oauth from '../server/google-oauth.js'
import * as admin from '../functions/api/admin/google-invites.js'
import * as start from '../functions/api/google/oauth/start.js'
import * as callback from '../functions/api/google/oauth/callback.js'

const MIGRATION = readFileSync(new URL('../migrations/0001_onboarding_invites.sql', import.meta.url), 'utf8')
const ORIGIN = 'https://getshowups.com'
const REDIRECT = `${ORIGIN}/api/google/oauth/callback`
const ADMIN = 'a'.repeat(40)
const ALL_SCOPES =
  'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const CALENDAR_ONLY_ONE = 'openid email https://www.googleapis.com/auth/calendar.freebusy'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// ---- fakes ----
function makeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => db.prepare(sql).run(...args),
    _exec: () => db.prepare(sql).run(...args),
  })
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN')
      try {
        const r = stmts.map((s) => s._exec())
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}
function makeKV() {
  const m = new Map()
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  }
}
function makeEnv() {
  return {
    GOOGLE_CLIENT_ID: 'cid.apps.example',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: REDIRECT,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ADMIN_API_TOKEN: ADMIN,
    GOOGLE_TOKENS: makeKV(),
    ONBOARDING_DB: makeD1(),
  }
}
function mockGoogle({ scope = ALL_SCOPES, refresh = 'rt-new', ok = true, sub = 'g-123' } = {}) {
  const calls = { token: 0, revoked: [] }
  const idToken =
    'h.' + Buffer.from(JSON.stringify({ sub, email: 'owner@example.com' })).toString('base64url') + '.s'
  globalThis.fetch = async (url, init) => {
    if (url === oauth.GOOGLE_TOKEN_URL) {
      calls.token++
      calls.lastBody = Object.fromEntries(new URLSearchParams(init.body))
      if (!ok) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: refresh, scope, id_token: idToken }), {
        status: 200,
      })
    }
    if (url === oauth.GOOGLE_REVOKE_URL) {
      calls.revoked.push(new URLSearchParams(init.body).get('token'))
      return new Response('', { status: 200 })
    }
    throw new Error('unexpected fetch ' + url)
  }
  return calls
}
const adminReq = (body, headers = {}, url = `${ORIGIN}/api/admin/google-invites`) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

async function issue(env, customer = 'acme-dental', purpose = 'connect') {
  const res = await admin.onRequestPost({
    request: adminReq({ customer, purpose }, { Authorization: `Bearer ${ADMIN}` }),
    env,
  })
  assert.equal(res.status, 201)
  const { url } = await res.json()
  return new URL(url).searchParams.get('invite')
}
const startGet = (env, invite) =>
  start.onRequestGet({ request: new Request(`${ORIGIN}/api/google/oauth/start?invite=${invite}`), env })
function begin(env, invite, { confirm = 'yes', origin = ORIGIN } = {}) {
  const body = new URLSearchParams({ invite })
  if (confirm) body.set('confirm', confirm)
  const headers = origin ? { Origin: origin } : {}
  return start.onRequestPost({
    request: new Request(`${ORIGIN}/api/google/oauth/start`, { method: 'POST', headers, body }),
    env,
  })
}
const cookieFrom = (res) => res.headers.get('Set-Cookie').split(';')[0]
async function finish(env, startRes, { state, code = 'code-1', cookie } = {}) {
  const loc = new URL(startRes.headers.get('Location'))
  const u = new URL(REDIRECT)
  u.searchParams.set('code', code)
  u.searchParams.set('state', state ?? loc.searchParams.get('state'))
  return callback.onRequestGet({ request: new Request(u, { headers: { Cookie: cookie ?? cookieFrom(startRes) } }), env })
}
const inviteRow = (env) => env.ONBOARDING_DB.raw.prepare('SELECT * FROM onboarding_invites').get()

// ---- crypto helpers ----
test('PKCE S256 matches RFC 7636 Appendix B', async () => {
  assert.equal(
    await oauth.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  )
})

test('AES-GCM round-trips, rejects tampering and a wrong key', async () => {
  const env = makeEnv()
  const ct = await oauth.encrypt(env, 'secret-refresh-token')
  assert.equal(await oauth.decrypt(env, ct), 'secret-refresh-token')
  assert.notEqual(await oauth.encrypt(env, 'x'), await oauth.encrypt(env, 'x'), 'random IV')
  const bad = ct.slice(0, -2) + (ct.at(-2) === 'A' ? 'B' : 'A') + ct.at(-1)
  await assert.rejects(oauth.decrypt(env, bad))
  await assert.rejects(oauth.decrypt({ ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }, ct))
  await assert.rejects(oauth.encrypt({ ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }, 'x'))
})

// ---- admin API ----
test('admin: bearer header required; token in URL or body is ignored', async () => {
  const env = makeEnv()
  const body = { customer: 'acme-dental' }
  const post = (request) => admin.onRequestPost({ request, env })
  assert.equal((await post(adminReq(body))).status, 401)
  assert.equal((await post(adminReq(body, {}, `${ORIGIN}/api/admin/google-invites?token=${ADMIN}`))).status, 401)
  assert.equal((await post(adminReq({ ...body, token: ADMIN }))).status, 401)
  assert.equal((await post(adminReq(body, { Authorization: ADMIN }))).status, 401, 'no Bearer prefix')
  assert.equal((await post(adminReq(body, { Authorization: `Bearer ${ADMIN}x` }))).status, 401)
  assert.equal((await post(adminReq(body, { Authorization: `Bearer ${ADMIN}` }))).status, 201)
  assert.equal(typeof admin.onRequestGet, 'undefined', 'only POST exported')
})

test('admin: rejects short ADMIN_API_TOKEN and bad input; no-store headers', async () => {
  const short = { ...makeEnv(), ADMIN_API_TOKEN: 'short' }
  const r = await admin.onRequestPost({ request: adminReq({ customer: 'a1' }, { Authorization: 'Bearer short' }), env: short })
  assert.equal(r.status, 503)
  const env = makeEnv()
  const auth = { Authorization: `Bearer ${ADMIN}` }
  assert.equal((await admin.onRequestPost({ request: adminReq({ customer: '../x' }, auth), env })).status, 400)
  assert.equal((await admin.onRequestPost({ request: adminReq({ customer: 'abc', purpose: 'admin' }, auth), env })).status, 400)
  const ok = await admin.onRequestPost({ request: adminReq({ customer: 'abc' }, auth), env })
  assert.equal(ok.headers.get('Cache-Control'), 'no-store')
})

// ---- invites and the confirmation page ----
test('invite stored only as a hash; new invite invalidates the old one', async () => {
  const env = makeEnv()
  const t1 = await issue(env)
  const rows = env.ONBOARDING_DB.raw.prepare('SELECT token_hash FROM onboarding_invites').all()
  assert.ok(rows.every((r) => r.token_hash !== t1 && r.token_hash.length === 64))
  const t2 = await issue(env)
  assert.equal((await begin(env, t1)).status, 410, 'old invite dead')
  assert.equal((await begin(env, t2)).status, 303)
})

test('GET start page does not claim or consume the invite (link scanners)', async () => {
  const env = makeEnv()
  const t = await issue(env)
  for (let i = 0; i < 3; i++) assert.equal((await startGet(env, t)).status, 200)
  const row = inviteRow(env)
  assert.equal(row.claimed_at, null)
  assert.equal(row.used_at, null)
})

test('GET start page shows the customer account and requires an explicit confirmation', async () => {
  const env = makeEnv()
  const html = await (await startGet(env, await issue(env, 'acme-dental'))).text()
  assert.match(html, /Account: <strong>acme-dental<\/strong>/)
  assert.match(html, /<input type="checkbox" name="confirm" value="yes" required>/)
  assert.match(html, /authorized to connect a Google Calendar for <strong>acme-dental<\/strong>/)
  const re = await (await startGet(env, await issue(env, 'acme-dental', 'reconnect'))).text()
  assert.match(re, /Reconnect your Google Calendar/)
  assert.match(re, /replaces the Google Calendar currently connected/)
})

test('confirmation page lets browsers send a real Origin; the Google redirect still sends no referrer', async () => {
  // Regression: with Referrer-Policy: no-referrer, browsers send "Origin: null" on the form POST,
  // and the same-origin check blocks every real user.
  const env = makeEnv()
  const t = await issue(env)
  const get = await startGet(env, t)
  assert.equal(get.headers.get('Referrer-Policy'), 'same-origin')
  assert.match(get.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/accounts\.google\.com/)
  assert.equal(get.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(get.headers.get('Cache-Control'), 'no-store')

  const unticked = await begin(env, t, { confirm: null })
  assert.equal(unticked.headers.get('Referrer-Policy'), 'same-origin', 're-shown confirmation page too')

  const redirect = await begin(env, t)
  assert.equal(redirect.status, 303)
  assert.equal(redirect.headers.get('Referrer-Policy'), 'no-referrer', 'Google never sees the invite URL')

  assert.equal((await startGet(env, 'x'.repeat(43))).headers.get('Referrer-Policy'), 'no-referrer', 'error pages unchanged')
  assert.equal((await begin(env, t, { origin: 'null' })).status, 403, 'strict Origin check unchanged')
})

test('GET start page rejects unknown, used, or expired invites', async () => {
  const env = makeEnv()
  assert.equal((await startGet(env, 'x'.repeat(43))).status, 410)
  const t = await issue(env)
  env.ONBOARDING_DB.raw.prepare('UPDATE onboarding_invites SET expires_at = 1').run()
  assert.equal((await startGet(env, t)).status, 410)
})

test('POST without the confirmation box re-shows the page and claims nothing', async () => {
  const env = makeEnv()
  const t = await issue(env, 'acme-dental')
  const res = await begin(env, t, { confirm: null })
  assert.equal(res.status, 400)
  const html = await res.text()
  assert.match(html, /Please tick the box/)
  assert.match(html, /acme-dental/)
  assert.equal(inviteRow(env).claimed_at, null)
  assert.equal((await begin(env, t, { confirm: 'on' })).status, 400, 'only the exact value counts')
})

test('POST from another site or with no Origin is blocked and claims nothing', async () => {
  const env = makeEnv()
  const t = await issue(env)
  assert.equal((await begin(env, t, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await begin(env, t, { origin: null })).status, 403)
  assert.equal((await begin(env, t, { origin: 'null' })).status, 403)
  assert.equal(inviteRow(env).claimed_at, null)
  assert.equal((await begin(env, t)).status, 303)
})

test('start POST: PKCE S256, exact redirect URI, scopes, offline, __Host- cookie', async () => {
  const env = makeEnv()
  const res = await begin(env, await issue(env))
  assert.equal(res.status, 303)
  const loc = new URL(res.headers.get('Location'))
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(loc.searchParams.get('redirect_uri'), REDIRECT)
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(loc.searchParams.get('access_type'), 'offline')
  assert.equal(loc.searchParams.get('scope'), ALL_SCOPES)
  const c = res.headers.get('Set-Cookie')
  assert.match(c, /^__Host-gsu_google_oauth=/)
  for (const f of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(c.includes(f), f)
  assert.ok(!c.includes('Domain='))
})

test('a second browser session cannot claim an invite already claimed', async () => {
  const env = makeEnv()
  const t = await issue(env)
  assert.equal((await begin(env, t)).status, 303)
  assert.equal((await begin(env, t)).status, 410)
})

// ---- callback ----
test('happy path stores an encrypted token under the invite customer only', async () => {
  const env = makeEnv()
  const g = mockGoogle()
  const r = await finish(env, await begin(env, await issue(env, 'acme-dental')))
  assert.equal(r.status, 200)
  assert.ok(g.lastBody.code_verifier.length > 43)
  assert.equal(g.lastBody.redirect_uri, REDIRECT)
  assert.deepEqual([...env.GOOGLE_TOKENS.m.keys()], ['google:acme-dental'])
  const rec = JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme-dental'))
  assert.ok(!JSON.stringify(rec).includes('rt-new'), 'plaintext refresh token not stored')
  assert.equal(await oauth.decrypt(env, rec.refreshToken), 'rt-new')
  assert.ok(!(await r.clone().text()).includes('rt-new'), 'token not sent to browser')
  assert.match(r.headers.get('Set-Cookie'), /Max-Age=0/)
})

test('replayed callback is rejected; the new grant is revoked unless it would end the stored connection', async () => {
  const env = makeEnv()
  mockGoogle({ refresh: 'rt-first' })
  const s = await begin(env, await issue(env))
  assert.equal((await finish(env, s)).status, 200)
  const same = mockGoogle({ refresh: 'rt-replay' })
  assert.equal((await finish(env, s, { code: 'code-2' })).status, 410)
  assert.deepEqual(same.revoked, [], 'same account: revoking would end the connection just stored')
  const other = mockGoogle({ refresh: 'rt-replay-2', sub: 'g-attacker' })
  assert.equal((await finish(env, s, { code: 'code-3' })).status, 410)
  assert.deepEqual(other.revoked, ['rt-replay-2'])
  assert.equal(env.GOOGLE_TOKENS.m.size, 1)
  assert.equal(await oauth.decrypt(env, JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme-dental')).refreshToken), 'rt-first')
})

test('state mismatch, missing cookie, and forged cookie are rejected before token exchange', async () => {
  const env = makeEnv()
  const g = mockGoogle()
  const s = await begin(env, await issue(env))
  assert.equal((await finish(env, s, { state: 'x'.repeat(43) })).status, 400)
  assert.equal((await finish(env, s, { cookie: 'other=1' })).status, 400)
  assert.equal((await finish(env, s, { cookie: '__Host-gsu_google_oauth=AAAA' })).status, 400)
  assert.equal(g.token, 0)
})

test('cross-customer: session from customer A cannot complete with customer B cookie state', async () => {
  const env = makeEnv()
  mockGoogle()
  const sA = await begin(env, await issue(env, 'customer-a'))
  const sB = await begin(env, await issue(env, 'customer-b'))
  const stateA = new URL(sA.headers.get('Location')).searchParams.get('state')
  assert.equal((await finish(env, sB, { state: stateA })).status, 400)
  assert.equal(env.GOOGLE_TOKENS.m.size, 0)
})

test('missing calendar scope is refused and revoked', async () => {
  const env = makeEnv()
  const g = mockGoogle({ scope: 'openid email https://www.googleapis.com/auth/calendar.freebusy' })
  assert.equal((await finish(env, await begin(env, await issue(env)))).status, 400)
  assert.equal(g.revoked.length, 1)
  assert.equal(env.GOOGLE_TOKENS.m.size, 0)
})

test('connect over an existing connection is refused; reconnect with another Google account revokes the old grant', async () => {
  const env = makeEnv()
  mockGoogle({ refresh: 'rt-1' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 200)
  const g2 = mockGoogle({ refresh: 'rt-2' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 409)
  assert.deepEqual(g2.revoked, [], 'same account already connected: its shared grant is not revoked')
  const g3 = mockGoogle({ refresh: 'rt-3', sub: 'g-other' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'reconnect')))).status, 200)
  const rec = JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme'))
  assert.equal(await oauth.decrypt(env, rec.refreshToken), 'rt-3')
  assert.deepEqual(g3.revoked, ['rt-1'], 'old account grant revoked')
})

// Google ties all of one user's refresh tokens for a client to one grant: revoking any of them can end
// every connection of that account. Same-account reconnects and failures must therefore not revoke.
test('grant safety: same-account reconnect replaces the token without revoking anything', async () => {
  const env = makeEnv()
  mockGoogle({ refresh: 'rt-1' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 200)
  const g = mockGoogle({ refresh: 'rt-2' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'reconnect')))).status, 200)
  assert.equal(await oauth.decrypt(env, JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme')).refreshToken), 'rt-2')
  assert.deepEqual(g.revoked, [])
})

test('grant safety: a failed connect does not revoke when the account powers another business', async () => {
  const env = makeEnv()
  mockGoogle({ refresh: 'rt-1' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'biz-one', 'connect')))).status, 200)
  const link = await issue(env, 'biz-two', 'connect')
  const g = mockGoogle({ refresh: 'rt-2', scope: CALENDAR_ONLY_ONE })
  assert.equal((await finish(env, await begin(env, link))).status, 400)
  assert.deepEqual(g.revoked, [], 'biz-one keeps working')
  const g2 = mockGoogle({ refresh: 'rt-3', sub: 'g-stranger', scope: CALENDAR_ONLY_ONE })
  assert.equal((await finish(env, await begin(env, await issue(env, 'biz-three', 'connect')))).status, 400)
  assert.deepEqual(g2.revoked, ['rt-3'], 'an unused grant of another account is still revoked')
})

test('grant safety: an incomplete key listing or a missing account id never revokes', async () => {
  const env = makeEnv()
  assert.equal(await oauth.grantInUse(env, undefined), true)
  env.GOOGLE_TOKENS.list = async () => ({ keys: [], list_complete: false })
  assert.equal(await oauth.grantInUse(env, 'g-123'), true)
  env.GOOGLE_TOKENS.list = async () => {
    throw new Error('KV down')
  }
  assert.equal(await oauth.grantInUse(env, 'g-123'), true)
})

// ---- storage failure after Google approves ----
test('token storage failure revokes the new grant, stores nothing, and the same link can be retried', async () => {
  const env = makeEnv()
  const t = await issue(env, 'acme-dental')
  const realPut = env.GOOGLE_TOKENS.put
  env.GOOGLE_TOKENS.put = async () => {
    throw new Error('KV unavailable')
  }
  const g = mockGoogle({ refresh: 'rt-fail' })
  const r = await finish(env, await begin(env, t))
  assert.equal(r.status, 503)
  assert.equal(r.headers.get('Retry-After'), '120')
  assert.match(r.headers.get('Set-Cookie'), /Max-Age=0/)
  assert.match(await r.text(), /Your link still works/)
  assert.deepEqual(g.revoked, ['rt-fail'])
  assert.equal(env.GOOGLE_TOKENS.m.size, 0)
  const row = inviteRow(env)
  assert.equal(row.used_at, null)
  assert.equal(row.claim_session, null)

  env.GOOGLE_TOKENS.put = realPut
  mockGoogle({ refresh: 'rt-retry' })
  assert.equal((await finish(env, await begin(env, t))).status, 200, 'same link works on retry')
  assert.equal(await oauth.decrypt(env, JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme-dental')).refreshToken), 'rt-retry')
})

test('token lookup failure is handled the same way', async () => {
  const env = makeEnv()
  const t = await issue(env)
  env.GOOGLE_TOKENS.get = async () => {
    throw new Error('KV unavailable')
  }
  const g = mockGoogle({ refresh: 'rt-get-fail' })
  const r = await finish(env, await begin(env, t))
  assert.equal(r.status, 503)
  assert.deepEqual(g.revoked, ['rt-get-fail'])
  assert.equal(inviteRow(env).used_at, null)
})

test('invite database failure after Google approves revokes the grant and keeps the link usable', async () => {
  const env = makeEnv()
  const t = await issue(env)
  const s = await begin(env, t)
  const realPrepare = env.ONBOARDING_DB.prepare
  env.ONBOARDING_DB.prepare = () => {
    throw new Error('D1 unavailable')
  }
  const g = mockGoogle({ refresh: 'rt-db-fail' })
  const r = await finish(env, s)
  assert.equal(r.status, 503)
  assert.match(await r.text(), /Your link still works/)
  assert.deepEqual(g.revoked, ['rt-db-fail'])
  env.ONBOARDING_DB.prepare = realPrepare
  assert.equal(inviteRow(env).used_at, null)
})

test('if the invite cannot be released, the error says to ask for a new link', async () => {
  const env = makeEnv()
  const t = await issue(env)
  const s = await begin(env, t)
  env.GOOGLE_TOKENS.put = async () => {
    // Simulate the invite expiring between consume and release, so release must refuse.
    env.ONBOARDING_DB.raw.prepare('UPDATE onboarding_invites SET expires_at = 1').run()
    throw new Error('KV unavailable')
  }
  const g = mockGoogle({ refresh: 'rt-x' })
  const r = await finish(env, s)
  assert.equal(r.status, 503)
  assert.match(await r.text(), /ask GetShowUps for a new link/)
  assert.deepEqual(g.revoked, ['rt-x'])
})

// ---- configuration ----
test('expired invite cannot be claimed', async () => {
  const env = makeEnv()
  const t = await issue(env)
  env.ONBOARDING_DB.raw.prepare('UPDATE onboarding_invites SET expires_at = 1').run()
  assert.equal((await begin(env, t)).status, 410)
})

test('missing binding fails closed with 503', async () => {
  const env = { ...makeEnv(), ONBOARDING_DB: undefined }
  const r = await admin.onRequestPost({ request: adminReq({ customer: 'abc' }, { Authorization: `Bearer ${ADMIN}` }), env })
  assert.equal(r.status, 503)
  assert.equal((await startGet(env, 'x')).status, 503)
})

// ---- OAuth client migration (old Google Cloud project → new project) ----
// A refresh token only works with the client that issued it. The legacy-client fallback was removed
// once every connection moved to the current client; reconnecting still archives a record issued by
// another client (never revokes it) so a rollback remains possible.
import { connect as calendarConnect } from '../server/calendar.js'

async function legacyRecord(env, customer, refreshToken) {
  // Shape stored before client tracking existed (no clientId).
  env.GOOGLE_TOKENS.m.set(`google:${customer}`, JSON.stringify({ customer, googleSub: 'g', email: 'care@example.com', scope: ALL_SCOPES, refreshToken: await oauth.encrypt(env, refreshToken), connectedAt: '2026-11-08T21:04:40.703Z' }))
}
function migratingEnv() {
  const env = makeEnv()
  env.GOOGLE_CLIENT_ID = 'new-cid.apps.example'
  env.GOOGLE_CLIENT_SECRET = 'new-secret'
  return env
}

test('migration: oauthClient always uses the configured client and reports whether it issued the record', () => {
  const env = migratingEnv()
  assert.equal(oauth.oauthClient(env, 'new-cid.apps.example').kind, 'current')
  assert.equal(oauth.oauthClient(env, 'old-cid.apps.example').kind, 'other')
  assert.equal(oauth.oauthClient(env, undefined).kind, 'other')
  const withOldVars = { ...env, GOOGLE_LEGACY_CLIENT_ID: 'old-cid.apps.example', GOOGLE_LEGACY_CLIENT_SECRET: 'old-secret' }
  assert.equal(oauth.oauthClient(withOldVars, undefined).id, 'new-cid.apps.example', 'legacy variables are ignored')
  assert.equal(oauth.oauthClient(withOldVars, 'old-cid.apps.example').secret, 'new-secret')
})

test('migration: reconnecting a record from another client stores clientId and archives (does not revoke) the old token', async () => {
  const env = migratingEnv()
  await legacyRecord(env, 'poolthru', 'rt-old')
  const before = env.GOOGLE_TOKENS.m.get('google:poolthru')
  const g = mockGoogle({ refresh: 'rt-new' })
  const startRes = await begin(env, await issue(env, 'poolthru', 'reconnect'))
  assert.equal(new URL(startRes.headers.get('Location')).searchParams.get('client_id'), 'new-cid.apps.example')
  assert.equal((await finish(env, startRes)).status, 200)
  assert.equal(g.lastBody.client_id, 'new-cid.apps.example')

  const rec = JSON.parse(env.GOOGLE_TOKENS.m.get('google:poolthru'))
  assert.equal(rec.clientId, 'new-cid.apps.example')
  assert.equal(await oauth.decrypt(env, rec.refreshToken), 'rt-new')
  assert.deepEqual(g.revoked, [], 'old grant kept for rollback')
  const archived = [...env.GOOGLE_TOKENS.m.keys()].filter((k) => k.startsWith('google-archive:poolthru:'))
  assert.equal(archived.length, 1)
  assert.equal(env.GOOGLE_TOKENS.m.get(archived[0]), before, 'archive is the untouched original record')

  const after = mockGoogle()
  const conn = await calendarConnect(env, 'poolthru')
  assert.equal(conn.oauthClient, 'current')
  assert.equal(after.lastBody.client_id, 'new-cid.apps.example')
})

test('migration rollback: restoring the archived record works again with the old client as primary', async () => {
  const env = migratingEnv()
  await legacyRecord(env, 'poolthru', 'rt-old')
  const original = env.GOOGLE_TOKENS.m.get('google:poolthru')
  const rolledBack = { ...makeEnv(), GOOGLE_CLIENT_ID: 'old-cid.apps.example', GOOGLE_CLIENT_SECRET: 'old-secret', GOOGLE_TOKENS: env.GOOGLE_TOKENS, TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY }
  rolledBack.GOOGLE_TOKENS.m.set('google:poolthru', original)
  const g = mockGoogle()
  const conn = await calendarConnect(rolledBack, 'poolthru')
  assert.equal(conn.ok, true)
  assert.equal(g.lastBody.client_id, 'old-cid.apps.example')
})

test('migration: same-client reconnect by another account still revokes the replaced grant', async () => {
  const env = migratingEnv()
  mockGoogle({ refresh: 'rt-1' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 200)
  const g = mockGoogle({ refresh: 'rt-2', sub: 'g-other' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'reconnect')))).status, 200)
  assert.deepEqual(g.revoked, ['rt-1'])
  assert.equal([...env.GOOGLE_TOKENS.m.keys()].filter((k) => k.startsWith('google-archive:')).length, 0)
})
