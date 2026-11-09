// Tests for GET /api/admin/google-health (and the shared admin auth used by google-invites).
// Run: npm test   (Node built-in test runner; no dependencies)
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as health from '../functions/api/admin/google-health.js'
import { onRequestPost as invitesPost } from '../functions/api/admin/google-invites.js'
import { encrypt } from '../server/google-oauth.js'

const ADMIN = 'admin-token-'.padEnd(48, 'x')
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const OTHER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const FULL_SCOPE =
  'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy openid'
const SECRETS = {
  clientSecret: 'CLIENT-SECRET-VALUE',
  rtA: '1//refresh-token-poolthru',
  rtB: '1//refresh-token-other-customer',
  accessA: 'ya29.access-token-poolthru',
  accessB: 'ya29.access-token-other',
  busyStart: '2026-11-09T15:00:00Z',
}
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy'

function d1() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('../migrations/0001_onboarding_invites.sql', import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    run: async () => sql.prepare(q).run(...args),
  })
  return {
    prepare: (q) => stmt(q),
    batch: async (list) => {
      for (const s of list) sql.prepare(s.q).run(...s.args)
    },
  }
}

let env, kv, kvReads, kvWrites, calls, logs, google, origFetch, origError

async function record(customer, refreshToken, { key = KEY, scope = FULL_SCOPE } = {}) {
  return JSON.stringify({
    customer,
    googleSub: 'sub',
    email: `${customer}@example.com`,
    clientId: 'cid.apps.googleusercontent.com',
    scope,
    refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: key }, refreshToken),
    connectedAt: '2026-11-08T21:04:40.703Z',
  })
}

beforeEach(async () => {
  kv = new Map()
  kvReads = []
  kvWrites = []
  env = {
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: SECRETS.clientSecret,
    GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback',
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: ADMIN,
    ONBOARDING_DB: d1(),
    GOOGLE_TOKENS: {
      get: async (k) => (kvReads.push(k), kv.get(k) ?? null),
      put: async (k) => kvWrites.push(k),
      delete: async (k) => kvWrites.push(k),
    },
  }
  kv.set('google:poolthru', await record('poolthru', SECRETS.rtA))
  kv.set('google:other-co', await record('other-co', SECRETS.rtB))

  // Default Google behaviour: valid refresh tokens map to access tokens; freeBusy succeeds.
  google = {
    token: (body) => {
      const map = { [SECRETS.rtA]: SECRETS.accessA, [SECRETS.rtB]: SECRETS.accessB }
      return map[body.refresh_token]
        ? [200, { access_token: map[body.refresh_token], expires_in: 3599, scope: FULL_SCOPE, token_type: 'Bearer' }]
        : [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }]
    },
    freebusy: () => [200, { kind: 'calendar#freeBusy', calendars: { primary: { busy: [{ start: SECRETS.busyStart, end: '2026-11-09T16:00:00Z' }] } } }],
  }
  calls = []
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const entry = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body }
    calls.push(entry)
    let out
    if (u === TOKEN_URL) out = google.token(Object.fromEntries(new URLSearchParams(init.body)))
    else if (u === FREEBUSY_URL) out = google.freebusy(JSON.parse(init.body), entry)
    else throw new Error(`unexpected fetch ${u}`)
    if (out instanceof Error) throw out
    return new Response(JSON.stringify(out[1]), { status: out[0], headers: { 'Content-Type': 'application/json' } })
  }
  logs = []
  origError = console.error
  console.error = (...args) => logs.push(args.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
})

const req = (customer, auth = `Bearer ${ADMIN}`) =>
  new Request(`https://getshowups.com/api/admin/google-health${customer === undefined ? '' : `?customer=${encodeURIComponent(customer)}`}`, {
    headers: auth ? { Authorization: auth } : {},
  })

async function check(customer, auth) {
  const res = await health.onRequestGet({ request: req(customer, auth), env })
  const text = await res.text()
  return { res, text, body: JSON.parse(text) }
}

// Every response and log line is scanned for secrets, tokens, and calendar data.
function assertNoLeaks(text) {
  const haystack = [text, ...logs].join('\n')
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!haystack.includes(value), `leaked ${name}`)
  for (const value of [KEY, ADMIN, 'Token has been expired', '@example.com', 'refreshToken']) {
    assert.ok(!haystack.includes(value), `leaked ${value}`)
  }
}

// ---------- authentication ----------

test('auth: missing Authorization header → 401, no KV or Google access', async () => {
  const { res, body, text } = await check('poolthru', '')
  assert.equal(res.status, 401)
  assert.deepEqual(body, { error: 'unauthorized' })
  assert.equal(kvReads.length, 0)
  assert.equal(calls.length, 0)
  assertNoLeaks(text)
})

test('auth: wrong token, wrong scheme, and token prefix are all rejected', async () => {
  for (const auth of ['Bearer wrong', `Basic ${ADMIN}`, `Bearer ${ADMIN.slice(0, -1)}`, `Bearer ${ADMIN}x`, ADMIN, 'Bearer ']) {
    const { res } = await check('poolthru', auth)
    assert.equal(res.status, 401, auth)
  }
  assert.equal(kvReads.length, 0)
  assert.equal(calls.length, 0)
})

test('auth: endpoint fails closed when configuration is missing', async () => {
  for (const drop of ['ADMIN_API_TOKEN', 'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKENS']) {
    const saved = env[drop]
    delete env[drop]
    const { res, body } = await check('poolthru')
    assert.equal(res.status, 503, drop)
    assert.equal(body.error, 'not_configured')
    env[drop] = saved
  }
  assert.equal(calls.length, 0)
})

test('auth: only GET is exported (other methods never reach the handler)', () => {
  assert.deepEqual(Object.keys(health), ['onRequestGet'])
})

test('auth: google-invites still uses the same admin check', async () => {
  const post = (auth) =>
    invitesPost({
      env,
      request: new Request('https://getshowups.com/api/admin/google-invites', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: 'new-co' }),
      }),
    })
  assert.equal((await post('Bearer wrong')).status, 401)
  assert.equal((await post(`Bearer ${ADMIN}`)).status, 201)
})

// ---------- happy path / read-only ----------

test('healthy: returns status only, uses freeBusy on primary, writes nothing', async () => {
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(Object.keys(body).sort(), ['calendar', 'checkedAt', 'customer', 'oauthClient', 'scopes', 'status', 'token'])
  assert.equal(body.oauthClient, 'current')
  assert.equal(body.status, 'healthy')
  assert.equal(body.customer, 'poolthru')
  assert.deepEqual(body.scopes, { ok: true })
  assert.deepEqual(body.token, { httpStatus: 200 })
  assert.deepEqual(body.calendar, { httpStatus: 200, check: 'freeBusy.query primary' })

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${TOKEN_URL}`, `POST ${FREEBUSY_URL}`])
  const fb = JSON.parse(calls[1].body)
  assert.deepEqual(fb.items, [{ id: 'primary' }])
  assert.equal(calls[1].headers.Authorization, `Bearer ${SECRETS.accessA}`)
  assert.equal(kvWrites.length, 0)
  assertNoLeaks(text)
})

// ---------- customer isolation ----------

test('isolation: checking poolthru reads only its key and uses only its token', async () => {
  await check('poolthru')
  assert.deepEqual(kvReads, ['google:poolthru'])
  const tokenBody = Object.fromEntries(new URLSearchParams(calls[0].body))
  assert.equal(tokenBody.refresh_token, SECRETS.rtA)
  assert.ok(!calls.some((c) => String(c.body).includes(SECRETS.rtB) || JSON.stringify(c.headers).includes(SECRETS.accessB)))
})

test('isolation: checking other-co never touches poolthru credentials', async () => {
  const { body, text } = await check('other-co')
  assert.equal(body.customer, 'other-co')
  assert.deepEqual(kvReads, ['google:other-co'])
  assert.ok(!calls.some((c) => String(c.body).includes(SECRETS.rtA)))
  assert.ok(!text.includes('poolthru'))
})

test('isolation: malformed or injected customer ids are rejected before any lookup', async () => {
  for (const c of [undefined, '', 'poolthru:x', '../poolthru', 'google:poolthru', 'pool thru', 'p', '-poolthru', 'a'.repeat(64)]) {
    const { res, body } = await check(c)
    assert.equal(res.status, 400, String(c))
    assert.equal(body.error, 'invalid_customer')
  }
  assert.equal(kvReads.length, 0)
  assert.equal(calls.length, 0)
})

test('isolation: customer id is case-normalized to the same key', async () => {
  const { body } = await check('PoolThru')
  assert.equal(body.customer, 'poolthru')
  assert.deepEqual(kvReads, ['google:poolthru'])
})

test('isolation: a record filed under the wrong key is refused', async () => {
  kv.set('google:mislabeled', await record('other-co', SECRETS.rtB))
  const { res, body, text } = await check('mislabeled')
  assert.equal(res.status, 500)
  assert.equal(body.status, 'record_invalid')
  assert.equal(calls.length, 0)
  assertNoLeaks(text)
})

test('isolation: unknown customer → 404 not_connected, no Google calls', async () => {
  const { res, body } = await check('nobody')
  assert.equal(res.status, 404)
  assert.equal(body.status, 'not_connected')
  assert.equal(calls.length, 0)
})

// ---------- failures ----------

test('failure: revoked grant (invalid_grant) → reconnect_required', async () => {
  google.token = () => [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }]
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 502)
  assert.equal(body.status, 'reconnect_required')
  assert.deepEqual(body.token, { httpStatus: 400, error: 'invalid_grant' })
  assert.equal(body.calendar, undefined)
  assert.equal(calls.length, 1)
  assertNoLeaks(text)
})

test('failure: unknown token error is reduced to "other" and its text is not echoed', async () => {
  google.token = () => [401, { error: `weird ${SECRETS.clientSecret}`, error_description: SECRETS.rtA }]
  const { body, text } = await check('poolthru')
  assert.equal(body.status, 'token_refresh_failed')
  assert.deepEqual(body.token, { httpStatus: 401, error: 'other' })
  assertNoLeaks(text)
})

test('failure: token endpoint network error → httpStatus 0', async () => {
  google.token = () => new Error(`ECONNRESET ${SECRETS.rtA}`)
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 502)
  assert.deepEqual(body.token, { httpStatus: 0, error: 'network_error' })
  assertNoLeaks(text)
})

test('failure: record encrypted with a different key → decrypt_failed, no Google calls', async () => {
  kv.set('google:poolthru', await record('poolthru', SECRETS.rtA, { key: OTHER_KEY }))
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 500)
  assert.equal(body.status, 'decrypt_failed')
  assert.equal(calls.length, 0)
  assertNoLeaks(text)
})

test('failure: KV unavailable → 503 storage_error', async () => {
  env.GOOGLE_TOKENS.get = async () => {
    throw new Error(`kv down ${SECRETS.rtA}`)
  }
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 503)
  assert.equal(body.status, 'storage_error')
  assertNoLeaks(text)
})

test('failure: calendar API 403 → calendar_error with sanitized code only', async () => {
  google.freebusy = () => [403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient scopes for poolthru@example.com' } }]
  const { res, body, text } = await check('poolthru')
  assert.equal(res.status, 502)
  assert.equal(body.status, 'calendar_error')
  assert.deepEqual(body.calendar, { httpStatus: 403, error: 'PERMISSION_DENIED' })
  assertNoLeaks(text)
})

test('failure: freeBusy 200 with per-calendar error → calendar_error', async () => {
  google.freebusy = () => [200, { calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } }]
  const { body } = await check('poolthru')
  assert.equal(body.status, 'calendar_error')
  assert.deepEqual(body.calendar, { httpStatus: 200, error: 'notFound' })
})

test('failure: calendar error codes with unexpected characters become "other"', async () => {
  google.freebusy = () => [500, { error: { status: `<script>${SECRETS.accessA}` } }]
  const { body, text } = await check('poolthru')
  assert.deepEqual(body.calendar, { httpStatus: 500, error: 'other' })
  assertNoLeaks(text)
})

test('failure: calendar network error → httpStatus 0', async () => {
  google.freebusy = () => new Error('socket hang up')
  const { body } = await check('poolthru')
  assert.equal(body.status, 'calendar_error')
  assert.deepEqual(body.calendar, { httpStatus: 0, error: 'network_error' })
})

test('scopes: a record missing a calendar scope is reported, check still runs', async () => {
  kv.set('google:poolthru', await record('poolthru', SECRETS.rtA, { scope: 'openid https://www.googleapis.com/auth/calendar.freebusy' }))
  const { body } = await check('poolthru')
  assert.deepEqual(body.scopes, { ok: false })
  assert.equal(body.status, 'healthy')
})
