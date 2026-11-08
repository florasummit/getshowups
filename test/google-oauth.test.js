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
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }
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
function mockGoogle({ scope = ALL_SCOPES, refresh = 'rt-new', ok = true } = {}) {
  const calls = { token: 0, revoked: [] }
  const idToken =
    'h.' + Buffer.from(JSON.stringify({ sub: 'g-123', email: 'owner@example.com' })).toString('base64url') + '.s'
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

test('replayed callback is rejected and the new grant revoked', async () => {
  const env = makeEnv()
  const g = mockGoogle({ refresh: 'rt-replay' })
  const s = await begin(env, await issue(env))
  assert.equal((await finish(env, s)).status, 200)
  assert.equal((await finish(env, s, { code: 'code-2' })).status, 410)
  assert.ok(g.revoked.includes('rt-replay'))
  assert.equal(env.GOOGLE_TOKENS.m.size, 1)
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

test('connect over an existing connection is refused; reconnect replaces and revokes the old grant', async () => {
  const env = makeEnv()
  mockGoogle({ refresh: 'rt-1' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 200)
  mockGoogle({ refresh: 'rt-2' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'connect')))).status, 409)
  const g3 = mockGoogle({ refresh: 'rt-3' })
  assert.equal((await finish(env, await begin(env, await issue(env, 'acme', 'reconnect')))).status, 200)
  const rec = JSON.parse(env.GOOGLE_TOKENS.m.get('google:acme'))
  assert.equal(await oauth.decrypt(env, rec.refreshToken), 'rt-3')
  assert.ok(g3.revoked.includes('rt-1'), 'old grant revoked')
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
