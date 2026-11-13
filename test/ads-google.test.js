// Google Ads adapter + connect routes: OAuth start/callback (adwords scope, PKCE, encrypted state and
// token), account selection, the one-mutate PAUSED launch (validateOnly by default), idempotency,
// error mapping/retries, status/budget updates, metrics normalization, isolation and leak checks.
// Real handlers + migrations (incl. 0006) on node:sqlite, Map KV with real encryption, mocked fetch.
// Nothing here talks to Google. Run: node --no-warnings --test test/ads-google.test.js
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { decrypt, encrypt, pkceChallenge, sha256Hex } from '../server/google-oauth.js'
import { getConnection, saveToken, upsertConnection } from '../server/ads/connections.js'
import { validateSpec } from '../server/ads/spec.js'
import * as G from '../server/ads/google.js'
import * as start from '../functions/api/ads/google/start.js'
import * as callback from '../functions/api/ads/google/callback.js'
import * as accounts from '../functions/api/ads/google/accounts.js'

const ORIGIN = 'https://getshowups.com'
const ADS = 'https://googleads.googleapis.com/v26'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const RT = '1//ads-refresh-SECRET'
const AT = 'ya29.ads-access-SECRET'
const SECRET = 'client-secret-SECRET'
const LEAK = 'Customer 1234567890 belongs to Jane Doe at secret-co'
const ACCT = '1234567890'
const ACCT2 = '9876543210'
const MCC = '5555555555'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}

let env, db, kv, calls, logs, outputs, origFetch, origError, refreshMode, ads, tokenExchange

function seed(id, owner) {
  const now = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)")
    .run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const adsError = (status, code, errorCode) => reply(status, { error: { code: status, message: LEAK, status: code, details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode, message: LEAK }] }] } })

// Default Google Ads mock (MOCK DATA, never real results): two accessible accounts, no existing campaign,
// ZIPs resolve, mutates succeed. The mock account reports itself as a Google Ads TEST account unless a
// test sets mockTestAccount (true / false / null = flag missing).
let mockTestAccount = true
let mockAccountLookup = true // false: the per-test `ads` mock answers the account lookup too (error tests)
function defaultAds(path, body) {
  if (path === '/customers:listAccessibleCustomers') return reply(200, { resourceNames: [`customers/${ACCT}`, `customers/${MCC}`] })
  if (path === '/geoTargetConstants:suggest') {
    return reply(200, {
      geoTargetConstantSuggestions: body.locationNames.names.map((z) => ({ searchTerm: z, locale: 'en', reach: '1000', geoTargetConstant: { resourceName: `geoTargetConstants/9${z}`, id: `9${z}`, targetType: 'Postal Code', countryCode: 'US' } })),
    })
  }
  if (/googleAds:search$/.test(path)) {
    if (body.query.includes('FROM customer_client')) {
      // Account hierarchy (MOCK): MCC is a manager with test client ACCT2; ACCT is a plain account.
      const root = path.split('/')[2]
      if (root === MCC) return reply(200, { results: [{ customerClient: { id: MCC, manager: true, descriptiveName: 'Pools Manager' } }, { customerClient: { id: ACCT2, manager: false, descriptiveName: 'Client Ads', currencyCode: 'USD', testAccount: true } }] })
      return reply(200, { results: [{ customerClient: { id: root, manager: false, descriptiveName: 'Pools Ads', currencyCode: 'USD', ...(mockTestAccount === null ? {} : { testAccount: mockTestAccount }) } }] })
    }
    if (body.query.includes('FROM customer ')) return reply(200, { results: [{ customer: { id: ACCT, descriptiveName: 'Pools Ads', currencyCode: 'USD', ...(mockTestAccount === null ? {} : { testAccount: mockTestAccount }) } }] })
    return reply(200, { results: [] })
  }
  if (/googleAds:mutate$/.test(path)) {
    if (body.validateOnly) return reply(200, {})
    const acct = path.split('/')[2]
    return reply(200, {
      mutateOperationResponses: body.mutateOperations.map((op) => {
        const kind = Object.keys(op)[0].replace('Operation', 'Result')
        const n = { campaignBudgetResult: 'campaignBudgets/111', campaignResult: 'campaigns/222', adGroupResult: 'adGroups/333', adGroupAdResult: 'adGroupAds/333~444' }[kind] || 'x/1'
        return { [kind]: { resourceName: `customers/${acct}/${n}` } }
      }),
    })
  }
  if (/campaigns:mutate$|campaignBudgets:mutate$/.test(path)) return reply(200, { results: [{ resourceName: body.operations[0].update.resourceName }] })
  throw new Error(`unexpected ads path ${path}`)
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  calls = []
  logs = []
  outputs = []
  refreshMode = 'ok'
  mockTestAccount = true
  mockAccountLookup = true
  ads = defaultAds
  tokenExchange = () => reply(200, { access_token: AT, refresh_token: RT, scope: G.ADS_SCOPE, expires_in: 3599, token_type: 'Bearer' })
  env = {
    ADS_ENABLED: 'true',
    ADS_BUSINESSES: 'pools,salon', // per-business Ads flag (server/ads/access.js)
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: SECRET,
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
    GOOGLE_ADS_RETRY_MS: '0',
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const headers = new Headers(init.headers)
    if (u === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body))
      calls.push({ url: u, form })
      if (form.get('grant_type') === 'authorization_code') return tokenExchange(form)
      if (refreshMode === 'invalid_grant') return reply(400, { error: 'invalid_grant', error_description: LEAK })
      return reply(200, { access_token: AT, scope: G.ADS_SCOPE })
    }
    if (u.startsWith(ADS)) {
      const path = u.slice(ADS.length)
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ url: u, path, method: init.method || 'GET', headers, body })
      assert.equal(headers.get('Authorization'), `Bearer ${AT}`)
      // The account lookup (incl. Google's test-account flag) always answers from the labelled default
      // mock, controlled by mockTestAccount, so per-test mocks for other calls don't hide the guard.
      if (/googleAds:search$/.test(path) && body?.query?.includes('FROM customer ') && mockAccountLookup) return defaultAds(path, body, headers)
      return ads(path, body, headers)
    }
    throw new Error(`unexpected ${u}`)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const out = [...logs, ...outputs].join('\n')
  for (const s of [RT, AT, SECRET, LEAK, 'Jane Doe']) assert.ok(!out.includes(s), `must not leak ${s}`)
})

const adsCalls = (re) => calls.filter((c) => c.path && re.test(c.path))
const remember = (r) => (outputs.push(JSON.stringify(r)), r)

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, headers: extra = {} } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...extra }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && !('Origin' in extra)) headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env })
  const text = await res.clone().text()
  outputs.push(text, res.headers.get('Location') || '')
  return { res, status: res.status, text, json: () => JSON.parse(text), location: res.headers.get('Location') }
}
const stateCookie = (res) => res.headers.get('Set-Cookie').match(/__Host-gsu_ads_google=([^;]*)/)[1]

async function connect(email = 'owner@pools.example') {
  const cookie = await session(email)
  const s = await call(start, 'GET', '/api/ads/google/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  const state = new URL(s.location).searchParams.get('state')
  return call(callback, 'GET', `/api/ads/google/callback?code=c0de&state=${state}`, { cookie: `${cookie}; __Host-gsu_ads_google=${stateCookie(s.res)}` })
}

async function connected(customer = 'pools', { accountId = ACCT, extra = {} } = {}) {
  await saveToken(env, 'google', customer, { refreshToken: RT, clientId: 'cid', scope: G.ADS_SCOPE })
  await upsertConnection(env, customer, 'google', { accountId, extra, currency: 'USD', status: 'connected' })
}

const SPEC_INPUT = {
  platform: 'google',
  name: "Joe's Pools",
  dailyBudgetCents: 2500,
  geo: { zips: ['29403', '29401'] },
  finalUrl: 'https://pools.example/book',
  google: {
    keywords: [
      { text: 'pool cleaning', match: 'PHRASE' },
      { text: 'pool service charleston', match: 'EXACT' },
    ],
    negativeKeywords: ['jobs', 'diy'],
    headlines: ['Pool Cleaning Charleston', 'Book A Pool Visit', 'Weekly Pool Service'],
    descriptions: ['Weekly pool cleaning for Charleston homes.', 'Pick a time online in a minute.'],
    path1: 'pools',
  },
}
const campaign = () => {
  const [errors, spec] = validateSpec(SPEC_INPUT)
  assert.deepEqual(errors, [])
  return { id: 'cmp_abc123', spec }
}
const row = (extra = {}) => ({
  id: 'cmp_abc123',
  customer: 'pools',
  platform_campaign_id: '222',
  platform_ids: JSON.stringify({ campaign: `customers/${ACCT}/campaigns/222`, budget: `customers/${ACCT}/campaignBudgets/111` }),
  ...extra,
})

// ---------- base + error mapping ----------

test('googleAdsBase honors only loopback mock origins', () => {
  assert.equal(G.googleAdsBase({}), ADS)
  assert.equal(G.googleAdsBase({ GOOGLE_ADS_API_MOCK_ORIGIN: 'http://127.0.0.1:8799' }), 'http://127.0.0.1:8799/v26')
  for (const bad of ['https://evil.example', 'http://localhost:8799', 'http://127.0.0.1.evil.example:80', 'http://127.0.0.1']) {
    assert.equal(G.googleAdsBase({ GOOGLE_ADS_API_MOCK_ORIGIN: bad }), ADS, bad)
  }
})

test('mapError: allowlisted codes only, never the provider message', () => {
  const body = (errorCode, status) => ({ error: { status, message: LEAK, details: [{ errors: [{ errorCode, message: LEAK }] }] } })
  const cases = [
    [401, body({ authenticationError: 'OAUTH_TOKEN_REVOKED' }, 'UNAUTHENTICATED'), 'reconnect_required', false, true],
    [403, body({ authorizationError: 'USER_PERMISSION_DENIED' }, 'PERMISSION_DENIED'), 'permission_denied', false, false],
    [403, body({ authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, 'PERMISSION_DENIED'), 'not_approved_for_production', false, false],
    [429, body({ quotaError: 'RESOURCE_EXHAUSTED' }, 'RESOURCE_EXHAUSTED'), 'quota_exhausted', true, false],
    [409, body({ databaseError: 'CONCURRENT_MODIFICATION' }, 'ABORTED'), 'concurrent_modification', true, false],
    [500, body({ internalError: 'TRANSIENT_ERROR' }, 'INTERNAL'), 'transient', true, false],
    [503, {}, 'transient', true, false],
    [400, body({ campaignError: 'DUPLICATE_CAMPAIGN_NAME' }, 'INVALID_ARGUMENT'), 'invalid_request', false, false],
    [400, 'not json', 'invalid_request', false, false],
    [400, [body({ quotaError: 'RESOURCE_EXHAUSTED' })], 'quota_exhausted', true, false], // searchStream arrays
  ]
  for (const [status, b, error, retryable, reconnect] of cases) {
    const r = G.mapError(status, b)
    assert.deepEqual(r, { ok: false, error, httpStatus: status, retryable, reconnect }, error)
    assert.ok(!JSON.stringify(r).includes(LEAK))
  }
})

// ---------- OAuth start ----------

test('start: owner session required; cross-site refused; adwords scope + PKCE + encrypted state', async () => {
  assert.equal((await call(start, 'GET', '/api/ads/google/start')).status, 401)
  const noBiz = await session('someone@new.example')
  assert.equal((await call(start, 'GET', '/api/ads/google/start', { cookie: noBiz })).status, 409)
  const cookie = await session('owner@pools.example')
  assert.equal((await call(start, 'GET', '/api/ads/google/start', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await call(start, 'GET', '/api/ads/google/start', { cookie, headers: { Origin: 'https://evil.example' } })).status, 403)

  const r = await call(start, 'GET', '/api/ads/google/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  assert.equal(r.status, 302)
  const u = new URL(r.location)
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  const q = Object.fromEntries(u.searchParams)
  assert.equal(q.scope, 'https://www.googleapis.com/auth/adwords')
  assert.equal(q.redirect_uri, `${ORIGIN}/api/ads/google/callback`)
  assert.equal(q.access_type, 'offline')
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.client_id, 'cid')
  const setCookie = r.res.headers.get('Set-Cookie')
  assert.match(setCookie, /^__Host-gsu_ads_google=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/)
  const sealed = JSON.parse(await decrypt(env, stateCookie(r.res)))
  assert.equal(sealed.state, q.state)
  assert.equal(sealed.customer, 'pools')
  assert.equal(await pkceChallenge(sealed.verifier), q.code_challenge)
  assert.ok(!setCookie.includes(sealed.verifier), 'verifier is only inside the encrypted cookie')
  assert.ok(!r.location.includes(sealed.verifier))
})

test('start: rate limited per IP with the login rule', async () => {
  const cookie = await session('owner@pools.example')
  let last
  for (let i = 0; i < 21; i++) last = await call(start, 'GET', '/api/ads/google/start', { cookie })
  assert.equal(last.status, 429)
})

// ---------- OAuth callback ----------

test('callback: rejects bad/missing state, other business sessions, and denied consent', async () => {
  const cookie = await session('owner@pools.example')
  const s = await call(start, 'GET', '/api/ads/google/start', { cookie })
  const sealed = stateCookie(s.res)
  const state = new URL(s.location).searchParams.get('state')
  const cb = (qs, c) => call(callback, 'GET', `/api/ads/google/callback?${qs}`, { cookie: c })
  assert.equal((await cb(`code=x&state=${state}`, cookie)).location, '/dashboard/ads?ads_error=expired') // no state cookie
  assert.equal((await cb(`code=x&state=wrong`, `${cookie}; __Host-gsu_ads_google=${sealed}`)).location, '/dashboard/ads?ads_error=expired')
  assert.equal((await cb(`code=x&state=${state}`, `${cookie}; __Host-gsu_ads_google=garbage`)).location, '/dashboard/ads?ads_error=expired')
  assert.equal((await cb(`error=access_denied&state=${state}`, `${cookie}; __Host-gsu_ads_google=${sealed}`)).location, '/dashboard/ads?ads_error=cancelled')
  // A different business's owner cannot finish this business's flow (state names the business).
  const other = await session('owner@salon.example')
  assert.equal((await cb(`code=x&state=${state}`, `${other}; __Host-gsu_ads_google=${sealed}`)).location, '/dashboard/ads?ads_error=expired')
  // Expired state.
  const old = await encrypt(env, JSON.stringify({ state: 's'.repeat(43), verifier: 'v', customer: 'pools', email: 'owner@pools.example', iat: Date.now() - 11 * 60_000 }))
  assert.equal((await cb(`code=x&state=${'s'.repeat(43)}`, `${cookie}; __Host-gsu_ads_google=${old}`)).location, '/dashboard/ads?ads_error=expired')
  assert.equal(calls.length, 0, 'no token exchange happened')
  assert.equal(kv.size, 0)
})

test('callback: exchanges with PKCE, stores the refresh token encrypted, single account auto-selected', async () => {
  ads = (path, body, h) => (path === '/customers:listAccessibleCustomers' ? reply(200, { resourceNames: [`customers/${ACCT}`] }) : defaultAds(path, body, h))
  const r = await connect()
  assert.equal(r.status, 303)
  assert.equal(r.location, '/dashboard/ads?ads=google_connected')
  assert.match(r.res.headers.get('Set-Cookie'), /__Host-gsu_ads_google=; .*Max-Age=0/)
  const ex = calls.find((c) => c.form?.get('grant_type') === 'authorization_code').form
  assert.equal(ex.get('redirect_uri'), `${ORIGIN}/api/ads/google/callback`)
  assert.ok(ex.get('code_verifier')?.length >= 43)
  const stored = kv.get('ads:google:pools')
  assert.ok(stored && !stored.includes(RT), 'token is encrypted at rest')
  assert.equal(JSON.parse(await decrypt(env, stored)).refreshToken, RT)
  const conn = await getConnection(env, 'pools', 'google')
  assert.equal(conn.status, 'connected')
  assert.equal(conn.account_id, ACCT)
  assert.equal(conn.account_name, 'Pools Ads')
  assert.equal(conn.currency, 'USD')
  assert.deepEqual(conn.extra, { testAccount: true }, "Google's test-account flag is recorded on auto-select too")
  assert.ok(!JSON.stringify(conn).includes(RT))
})

test('callback: sign-in that only reaches a manager → its one test client is found and auto-selected', async () => {
  // Like the sandbox setup: the Google login can access the test MANAGER; the test client sits under it.
  ads = (path, body, h) => (path === '/customers:listAccessibleCustomers' ? reply(200, { resourceNames: [`customers/${MCC}`] }) : defaultAds(path, body, h))
  assert.equal((await connect()).location, '/dashboard/ads?ads=google_connected')
  const conn = await getConnection(env, 'pools', 'google')
  assert.deepEqual([conn.status, conn.account_id, conn.extra], ['connected', ACCT2, { loginCustomerId: MCC, testAccount: true }])
  assert.ok(adsCalls(/googleAds:search$/).every((c) => c.headers.get('login-customer-id') === MCC), 'every read goes through the manager')
})

test('discovery: production accounts Google refuses are skipped; only-production sign-in → allowlisted error', async () => {
  const PROD = '9223132742'
  const refuse = () => adsError(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' })
  // Like the real login: a production manager (refused under Test access) plus the test manager.
  ads = (path, body, h) =>
    path === '/customers:listAccessibleCustomers' ? reply(200, { resourceNames: [`customers/${PROD}`, `customers/${MCC}`] }) : path.startsWith(`/customers/${PROD}/`) ? refuse() : defaultAds(path, body, h)
  assert.equal((await connect()).location, '/dashboard/ads?ads=google_connected')
  let conn = await getConnection(env, 'pools', 'google')
  assert.deepEqual([conn.status, conn.account_id, conn.extra.loginCustomerId], ['connected', ACCT2, MCC], 'the one test client is found and used')
  const cookie = await session('owner@pools.example')
  const list = (await call(accounts, 'GET', '/api/ads/google/accounts', { cookie })).json()
  assert.deepEqual(list.accounts.map((a) => a.id), [ACCT2])
  assert.ok(!JSON.stringify(list).includes(PROD))
  assert.equal((await call(accounts, 'POST', '/api/ads/google/accounts', { cookie, body: { accountId: PROD } })).json().error, 'account_not_accessible')

  // Only production accounts: nothing connected, allowlisted error, no provider text leaks.
  ads = (path) => (path === '/customers:listAccessibleCustomers' ? reply(200, { resourceNames: [`customers/${PROD}`] }) : refuse())
  const r = await connect('owner@salon.example')
  assert.equal(r.location, '/dashboard/ads?ads_error=not_approved_for_production')
  conn = await getConnection(env, 'salon', 'google')
  assert.deepEqual([conn.status, conn.account_id], ['needs_account', null])
  const salon = await session('owner@salon.example')
  const g = await call(accounts, 'GET', '/api/ads/google/accounts', { cookie: salon })
  assert.deepEqual([g.status, g.json()], [403, { error: 'not_approved_for_production' }])
  assert.ok(!outputs.join(' ').includes('Jane Doe'))
})

test('sandbox: only Google Ads TEST accounts can be connected until live launch is switched on', async () => {
  // Callback with ONE accessible account that Google does not flag as a test account → not auto-selected.
  mockTestAccount = false
  ads = (path, body, h) => (path === '/customers:listAccessibleCustomers' ? reply(200, { resourceNames: [`customers/${ACCT}`] }) : defaultAds(path, body, h))
  assert.equal((await connect()).location, '/dashboard/ads?ads=google_connected')
  let conn = await getConnection(env, 'pools', 'google')
  assert.deepEqual([conn.status, conn.account_id], ['needs_account', null])
  // Choosing it explicitly is refused too, and nothing is stored.
  const cookie = await session('owner@pools.example')
  const pick = (body) => call(accounts, 'POST', '/api/ads/google/accounts', { cookie, body })
  const refused = await pick({ accountId: ACCT })
  assert.deepEqual([refused.status, refused.json()], [409, { error: 'test_account_required' }])
  conn = await getConnection(env, 'pools', 'google')
  assert.deepEqual([conn.status, conn.account_id], ['needs_account', null])
  // Unknown flag (lookup failed) is refused the same way (fails closed).
  mockTestAccount = null
  assert.equal((await pick({ accountId: ACCT })).json().error, 'test_account_required')
  // The list offers only test accounts (the non-test one is counted, never shown); managers never appear.
  mockTestAccount = false
  ads = defaultAds
  const offered = (await call(accounts, 'GET', '/api/ads/google/accounts', { cookie })).json()
  assert.deepEqual([offered.accounts.map((a) => a.id), offered.hidden, offered.sandbox], [[ACCT2], 1, true])
  // A test account under a manager is accepted; the server works out the manager path itself.
  mockTestAccount = true
  assert.equal((await pick({ accountId: ACCT2 })).json().testAccount, true)
  assert.equal((await getConnection(env, 'pools', 'google')).extra.loginCustomerId, MCC)
  assert.equal((await getConnection(env, 'pools', 'google')).account_id, ACCT2)
  // With the operator's live switch on, a non-test account can be chosen (real accounts need approval).
  mockTestAccount = false
  env.ADS_LIVE_LAUNCH = 'true'
  const live = await pick({ accountId: ACCT })
  assert.deepEqual([live.status, live.json().testAccount], [200, false])
  delete env.ADS_LIVE_LAUNCH
})

test('callback: several accounts → needs_account; missing scope or refresh token refused', async () => {
  assert.equal((await connect()).location, '/dashboard/ads?ads=google_connected')
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'needs_account')
  assert.equal((await getConnection(env, 'pools', 'google')).account_id, null)

  tokenExchange = () => reply(200, { access_token: AT, scope: 'openid email' , refresh_token: RT })
  assert.equal((await connect('owner@salon.example')).location, '/dashboard/ads?ads_error=scope_denied')
  tokenExchange = () => reply(200, { access_token: AT, scope: G.ADS_SCOPE })
  assert.equal((await connect('owner@salon.example')).location, '/dashboard/ads?ads_error=no_refresh_token')
  assert.equal(kv.has('ads:google:salon'), false)
})

test('callback: test-access project → connection kept as needs_account with an allowlisted error', async () => {
  ads = () => adsError(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' })
  assert.equal((await connect()).location, '/dashboard/ads?ads_error=not_approved_for_production')
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'needs_account')
})

// ---------- account selection ----------

test('accounts: found automatically (direct + under managers), select only those; owner + same-origin', async () => {
  await connect()
  const cookie = await session('owner@pools.example')
  const list = await call(accounts, 'GET', '/api/ads/google/accounts', { cookie })
  assert.deepEqual(list.json(), {
    status: 'needs_account',
    selected: null,
    sandbox: true,
    accounts: [
      { id: ACCT2, name: 'Client Ads', testAccount: true },
      { id: ACCT, name: 'Pools Ads', testAccount: true },
    ],
    hidden: 0,
  })
  assert.ok(!list.text.includes(MCC), 'manager ids never reach the browser')
  assert.equal((await call(accounts, 'GET', '/api/ads/google/accounts')).status, 401)

  const post = (body, extra) => call(accounts, 'POST', '/api/ads/google/accounts', { cookie, body, headers: extra })
  assert.equal((await post({ accountId: ACCT }, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ accountId: '123' })).json().error, 'invalid_account')
  assert.equal((await post({ accountId: '1111111111' })).json().error, 'account_not_accessible')
  assert.equal((await post({ accountId: MCC })).json().error, 'account_not_accessible', 'a manager account cannot hold campaigns')

  const ok = await post({ accountId: '123-456-7890' })
  assert.deepEqual(ok.json(), { ok: true, accountId: ACCT, status: 'connected', testAccount: true })
  const viaMcc = await post({ accountId: ACCT2, loginCustomerId: ACCT }) // client-sent manager ids are ignored
  assert.equal(viaMcc.status, 200)
  const conn = await getConnection(env, 'pools', 'google')
  assert.equal(conn.account_id, ACCT2)
  assert.deepEqual(conn.extra, { loginCustomerId: MCC, testAccount: true })
  assert.equal(adsCalls(/customer_client|googleAds:search/).at(-1).headers.get('login-customer-id'), MCC)

  // Another business has no connection: nothing of pools' is visible to it.
  const salon = await session('owner@salon.example')
  assert.equal((await call(accounts, 'GET', '/api/ads/google/accounts', { cookie: salon })).json().error, 'not_connected')
  assert.equal((await call(accounts, 'POST', '/api/ads/google/accounts', { cookie: salon, body: { accountId: ACCT } })).json().error, 'not_connected')
})

test('per-business flag: Google Ads connect + read routes only for businesses listed in ADS_BUSINESSES', async () => {
  const campaignsRoute = await import('../functions/api/ads/google/campaigns.js')
  const owner = await session('owner@pools.example')
  const get = async (mod, path) => (await call(mod, 'GET', path, { cookie: owner, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status
  await connected()
  for (const list of ['', 'salon', ' POOLS ', '*', 'pools-x', 'pool']) {
    env.ADS_BUSINESSES = list
    assert.equal(await get(start, '/api/ads/google/start'), 404, `start hidden for list ${JSON.stringify(list)}`)
    assert.equal(await get(accounts, '/api/ads/google/accounts'), 404)
    assert.equal(await get(campaignsRoute, '/api/ads/google/campaigns'), 404)
    assert.equal((await call(accounts, 'POST', '/api/ads/google/accounts', { cookie: owner, body: { accountId: ACCT } })).status, 404)
  }
  env.ADS_BUSINESSES = 'salon, pools'
  assert.equal(await get(accounts, '/api/ads/google/accounts'), 200)
  assert.notEqual(await get(campaignsRoute, '/api/ads/google/campaigns'), 404, 'listed → route reachable')
  assert.equal(await get(start, '/api/ads/google/start'), 302)

  // Removed from the list between start and callback: the callback refuses and stores nothing.
  kv.clear()
  const cookie = await session('owner@pools.example')
  const s = await call(start, 'GET', '/api/ads/google/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  env.ADS_BUSINESSES = 'salon'
  const cb = await call(callback, 'GET', `/api/ads/google/callback?code=c0de&state=${new URL(s.location).searchParams.get('state')}`, { cookie: `${cookie}; __Host-gsu_ads_google=${stateCookie(s.res)}` })
  assert.equal(cb.location, '/dashboard/ads?ads_error=not_configured')
  assert.equal(kv.size, 0, 'no token stored')
  assert.equal(calls.filter((c) => c.form?.get('grant_type') === 'authorization_code').length, 0, 'no code exchange')
})

test('no developer-token header: Google sunset developer tokens (2026-09-09); access is per Cloud project', async () => {
  // Even if the old secret is still stored, it is never sent (Google will reject it in a future version).
  env.GOOGLE_ADS_DEVELOPER_TOKEN = 'fake-legacy-token'
  await connected()
  assert.equal((await G.launchCampaign(env, 'pools', campaign())).ok, true)
  const all = adsCalls(/./)
  assert.ok(all.length > 0)
  for (const c of all) assert.equal(c.headers.get('developer-token'), null)
})

// ---------- launch ----------

test('launch: validateOnly by default; one atomic mutate with temp ids, PAUSED campaign, geo, keywords, negatives, RSA', async () => {
  await connected()
  const r = remember(await G.launchCampaign(env, 'pools', campaign()))
  assert.deepEqual(r, { ok: true, validateOnly: true, existing: false, operations: 10 })
  const search = adsCalls(/googleAds:search$/)
  assert.equal(search.length, 1)
  assert.equal(search[0].body.query, "SELECT campaign.resource_name, campaign.id, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.name = 'Joe\\'s Pools [gsu:cmp_abc123]' AND campaign.status != 'REMOVED' LIMIT 1")
  const geo = adsCalls(/geoTargetConstants:suggest$/)
  assert.deepEqual(geo[0].body, { locale: 'en', countryCode: 'US', locationNames: { names: ['29403', '29401'] } })
  const mutates = adsCalls(/googleAds:mutate$/)
  assert.equal(mutates.length, 1)
  const m = mutates[0]
  assert.equal(m.path, `/customers/${ACCT}/googleAds:mutate`)
  assert.equal(m.headers.get('login-customer-id'), null)
  assert.equal(m.headers.get('developer-token'), null)
  const c = `customers/${ACCT}`
  const name = "Joe's Pools [gsu:cmp_abc123]"
  assert.deepEqual(m.body, {
    partialFailure: false,
    validateOnly: true,
    mutateOperations: [
      { campaignBudgetOperation: { create: { resourceName: `${c}/campaignBudgets/-1`, name: `${name} budget`, amountMicros: '25000000', deliveryMethod: 'STANDARD', explicitlyShared: false } } },
      {
        campaignOperation: {
          create: {
            resourceName: `${c}/campaigns/-2`,
            name,
            status: 'PAUSED',
            advertisingChannelType: 'SEARCH',
            campaignBudget: `${c}/campaignBudgets/-1`,
            maximizeConversions: {},
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
            containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      },
      { campaignCriterionOperation: { create: { campaign: `${c}/campaigns/-2`, location: { geoTargetConstant: 'geoTargetConstants/929403' } } } },
      { campaignCriterionOperation: { create: { campaign: `${c}/campaigns/-2`, location: { geoTargetConstant: 'geoTargetConstants/929401' } } } },
      { campaignCriterionOperation: { create: { campaign: `${c}/campaigns/-2`, negative: true, keyword: { text: 'jobs', matchType: 'PHRASE' } } } },
      { campaignCriterionOperation: { create: { campaign: `${c}/campaigns/-2`, negative: true, keyword: { text: 'diy', matchType: 'PHRASE' } } } },
      { adGroupOperation: { create: { resourceName: `${c}/adGroups/-3`, campaign: `${c}/campaigns/-2`, name: `${name} ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
      { adGroupCriterionOperation: { create: { adGroup: `${c}/adGroups/-3`, status: 'ENABLED', keyword: { text: 'pool cleaning', matchType: 'PHRASE' } } } },
      { adGroupCriterionOperation: { create: { adGroup: `${c}/adGroups/-3`, status: 'ENABLED', keyword: { text: 'pool service charleston', matchType: 'EXACT' } } } },
      {
        adGroupAdOperation: {
          create: {
            adGroup: `${c}/adGroups/-3`,
            status: 'ENABLED',
            ad: {
              finalUrls: ['https://pools.example/book'],
              responsiveSearchAd: {
                headlines: [{ text: 'Pool Cleaning Charleston' }, { text: 'Book A Pool Visit' }, { text: 'Weekly Pool Service' }],
                descriptions: [{ text: 'Weekly pool cleaning for Charleston homes.' }, { text: 'Pick a time online in a minute.' }],
                path1: 'pools',
              },
            },
          },
        },
      },
    ],
  })
  // The only object that gates serving is never created enabled.
  assert.ok(m.body.mutateOperations.every((op) => op.campaignOperation?.create.status !== 'ENABLED'))
})

test('launch: real create returns ids; relaunch finds the tagged campaign instead of duplicating', async () => {
  await connected('pools', { extra: { loginCustomerId: MCC } })
  const r = remember(await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false }))
  assert.deepEqual(r, {
    ok: true,
    validateOnly: false,
    existing: false,
    platformCampaignId: '222',
    platformIds: { campaign: `customers/${ACCT}/campaigns/222`, budget: `customers/${ACCT}/campaignBudgets/111`, adGroup: `customers/${ACCT}/adGroups/333`, ad: `customers/${ACCT}/adGroupAds/333~444` },
  })
  const m = adsCalls(/googleAds:mutate$/)[0]
  assert.equal(m.body.validateOnly, false)
  assert.equal(m.body.mutateOperations[1].campaignOperation.create.status, 'PAUSED')
  assert.equal(m.headers.get('login-customer-id'), MCC)

  calls = []
  ads = (path, body, h) =>
    /googleAds:search$/.test(path) ? reply(200, { results: [{ campaign: { resourceName: `customers/${ACCT}/campaigns/222`, id: '222', status: 'PAUSED', campaignBudget: `customers/${ACCT}/campaignBudgets/111` } }] }) : defaultAds(path, body, h)
  const again = await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false })
  assert.deepEqual(again, { ok: true, existing: true, validateOnly: false, platformCampaignId: '222', platformIds: { campaign: `customers/${ACCT}/campaigns/222`, budget: `customers/${ACCT}/campaignBudgets/111` } })
  assert.equal(adsCalls(/googleAds:mutate$/).length, 0)
  assert.equal(adsCalls(/geoTargetConstants/).length, 0)
})

test('launch: unknown outcome (5xx) re-checks before retrying, so a committed create is not duplicated', async () => {
  await connected()
  let searches = 0
  ads = (path, body, h) => {
    if (/googleAds:mutate$/.test(path)) return adsError(500, 'INTERNAL', { internalError: 'INTERNAL_ERROR' })
    if (/googleAds:search$/.test(path)) return ++searches === 1 ? reply(200, { results: [] }) : reply(200, { results: [{ campaign: { resourceName: `customers/${ACCT}/campaigns/222`, id: '222' } }] })
    return defaultAds(path, body, h)
  }
  const r = await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false })
  assert.equal(r.existing, true)
  assert.equal(r.platformCampaignId, '222')
  assert.equal(adsCalls(/googleAds:mutate$/).length, 1)
})

test('launch: refuses non-Google specs, unconnected or unselected accounts, unresolved ZIPs', async () => {
  assert.equal((await G.launchCampaign(env, 'pools', { id: 'cmp_x1', spec: { platform: 'meta' } })).error, 'invalid_spec')
  assert.equal((await G.launchCampaign(env, 'pools', campaign())).error, 'not_connected')
  await saveToken(env, 'google', 'pools', { refreshToken: RT })
  await upsertConnection(env, 'pools', 'google', { status: 'needs_account' })
  assert.equal((await G.launchCampaign(env, 'pools', campaign())).error, 'needs_account')
  assert.equal(calls.length, 0)
  await connected()
  ads = (path, body, h) => (path === '/geoTargetConstants:suggest' ? reply(200, { geoTargetConstantSuggestions: [] }) : defaultAds(path, body, h))
  assert.equal((await G.launchCampaign(env, 'pools', campaign())).error, 'geo_unresolved')
  assert.equal(adsCalls(/googleAds:mutate$/).length, 0)
})

// ---------- tokens + error handling ----------

test('expired/revoked grant → reconnect_required and the connection is marked', async () => {
  await connected()
  refreshMode = 'invalid_grant'
  const r = remember(await G.launchCampaign(env, 'pools', campaign()))
  assert.deepEqual(r, { ok: false, error: 'reconnect_required', httpStatus: 400, retryable: false, reconnect: true })
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'reconnect_required')
  assert.equal(adsCalls(/./).length, 0)

  await connected()
  refreshMode = 'ok'
  ads = () => adsError(401, 'UNAUTHENTICATED', { authenticationError: 'OAUTH_TOKEN_REVOKED' })
  const r2 = remember(await G.setStatus(env, 'pools', row(), 'PAUSED'))
  assert.equal(r2.error, 'reconnect_required')
  assert.equal(adsCalls(/campaigns:mutate$/).length, 1, 'not retried')
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'reconnect_required')

  // No stored token at all.
  kv.clear()
  await upsertConnection(env, 'pools', 'google', { accountId: ACCT, status: 'connected' })
  assert.equal((await G.listAccounts(env, 'pools')).error, 'reconnect_required')
})

test('permission denied is not retried; quota exhausted retried once then succeeds', async () => {
  await connected()
  ads = () => adsError(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' })
  assert.equal(remember(await G.setStatus(env, 'pools', row(), 'PAUSED')).error, 'permission_denied')
  assert.equal(adsCalls(/campaigns:mutate$/).length, 1)
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'connected')

  calls = []
  let n = 0
  ads = (path, body, h) => (++n === 1 ? adsError(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }) : defaultAds(path, body, h))
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'PAUSED'), { ok: true, status: 'PAUSED' })
  assert.equal(adsCalls(/campaigns:mutate$/).length, 2)
})

test('transient errors: one retry, then a retryable failure', async () => {
  await connected()
  ads = () => adsError(503, 'UNAVAILABLE', { internalError: 'TRANSIENT_ERROR' })
  assert.deepEqual(remember(await G.setDailyBudget(env, 'pools', row(), 3000)), { ok: false, error: 'transient', httpStatus: 503, retryable: true, reconnect: false })
  assert.equal(adsCalls(/campaignBudgets:mutate$/).length, 2)

  calls = []
  ads = (path, body, h) => {
    if (/googleAds:mutate$/.test(path)) return adsError(500, 'INTERNAL', { internalError: 'INTERNAL_ERROR' })
    return defaultAds(path, body, h)
  }
  const r = await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false })
  assert.equal(r.error, 'transient')
  assert.equal(adsCalls(/googleAds:mutate$/).length, 2)

  calls = []
  ads = () => {
    throw new TypeError('network down')
  }
  assert.equal((await G.setStatus(env, 'pools', row(), 'PAUSED')).error, 'transient')
  assert.equal(adsCalls(/campaigns:mutate$/).length, 2)
})

test('invalid request maps to invalid_request without the provider message', async () => {
  await connected()
  ads = (path, body, h) => (/googleAds:mutate$/.test(path) ? adsError(400, 'INVALID_ARGUMENT', { campaignError: 'DUPLICATE_CAMPAIGN_NAME' }) : defaultAds(path, body, h))
  const r = remember(await G.launchCampaign(env, 'pools', campaign()))
  assert.deepEqual(r, { ok: false, error: 'invalid_request', httpStatus: 400, retryable: false, reconnect: false })
  assert.equal(adsCalls(/googleAds:mutate$/).length, 1)
  assert.ok(logs.some((l) => l.includes('invalid_request')), 'the code is logged, not the message')
})

// ---------- status, budget, metrics ----------

test('setStatus and setDailyBudget send minimal update operations', async () => {
  await connected('pools', { extra: { loginCustomerId: MCC } })
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'ENABLED'), { ok: true, status: 'ENABLED' })
  const s = adsCalls(/campaigns:mutate$/)[0]
  assert.equal(s.path, `/customers/${ACCT}/campaigns:mutate`)
  assert.deepEqual(s.body, { operations: [{ update: { resourceName: `customers/${ACCT}/campaigns/222`, status: 'ENABLED' }, updateMask: 'status' }] })
  assert.equal(s.headers.get('login-customer-id'), MCC)
  assert.equal((await G.setStatus(env, 'pools', row(), 'REMOVED')).error, 'invalid_request')

  assert.deepEqual(await G.setDailyBudget(env, 'pools', row(), 1999), { ok: true, dailyBudgetCents: 1999 })
  const b = adsCalls(/campaignBudgets:mutate$/)[0]
  assert.deepEqual(b.body, { operations: [{ update: { resourceName: `customers/${ACCT}/campaignBudgets/111`, amountMicros: '19990000' }, updateMask: 'amountMicros' }] })
  for (const bad of [0, 499, 12.5, '2000']) assert.equal((await G.setDailyBudget(env, 'pools', row(), bad)).error, 'invalid_request')
  assert.equal((await G.setStatus(env, 'pools', row({ platform_campaign_id: null, platform_ids: '{}' }), 'PAUSED')).error, 'not_launched')
})

test('fetchDailyMetrics: GAQL per day, micros → cents, string int64s, batches merged', async () => {
  await connected()
  ads = (path) => {
    assert.equal(path, `/customers/${ACCT}/googleAds:searchStream`)
    return reply(200, [
      { results: [{ segments: { date: '2026-11-01' }, metrics: { costMicros: '12345678', impressions: '100', clicks: '7', conversions: 1.5 } }] },
      {
        results: [
          { segments: { date: '2026-11-02' }, metrics: { costMicros: '4999', impressions: '3' } },
          { segments: { date: 'bogus' }, metrics: { costMicros: '1' } },
        ],
      },
    ])
  }
  const r = await G.fetchDailyMetrics(env, 'pools', row(), '2026-11-01', '2026-11-02')
  assert.deepEqual(r, {
    ok: true,
    rows: [
      { date: '2026-11-01', spendCents: 1235, impressions: 100, clicks: 7, conversions: 1.5 },
      { date: '2026-11-02', spendCents: 0, impressions: 3, clicks: 0, conversions: 0 },
    ],
  })
  assert.equal(
    adsCalls(/searchStream$/)[0].body.query,
    "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.id = 222 AND segments.date BETWEEN '2026-11-01' AND '2026-11-02'",
  )
  for (const [a, b] of [['2026-11-1', '2026-11-02'], ["2026-11-01' OR 1=1", '2026-11-02'], ['2026-11-03', '2026-11-02']]) {
    assert.equal((await G.fetchDailyMetrics(env, 'pools', row(), a, b)).error, 'invalid_request')
  }
  assert.equal((await G.fetchDailyMetrics(env, 'pools', row({ platform_campaign_id: '1 OR 1=1', platform_ids: '{}' }), '2026-11-01', '2026-11-02')).error, 'not_launched')
})

// ---------- isolation ----------

test('cross-customer isolation: tokens, accounts and campaigns never cross businesses', async () => {
  await connected('pools')
  await saveToken(env, 'google', 'salon', { refreshToken: '1//salon-refresh' })
  await upsertConnection(env, 'salon', 'google', { accountId: ACCT2, status: 'connected' })

  // A pools row used under salon is refused before any call.
  assert.equal((await G.setStatus(env, 'salon', row(), 'PAUSED')).error, 'not_launched')
  assert.equal((await G.fetchDailyMetrics(env, 'salon', row(), '2026-11-01', '2026-11-02')).error, 'not_launched')
  assert.equal(adsCalls(/./).length, 0)
  // A salon row with a pools budget resource name is refused (budget must live in salon's account).
  assert.equal((await G.setDailyBudget(env, 'salon', row({ customer: 'salon' }), 3000)).error, 'not_launched')
  // Salon's call uses salon's own refresh token and account.
  calls = []
  await G.setStatus(env, 'salon', row({ customer: 'salon' }), 'PAUSED')
  assert.equal(calls.find((c) => c.form).form.get('refresh_token'), '1//salon-refresh')
  assert.equal(adsCalls(/campaigns:mutate$/)[0].path, `/customers/${ACCT2}/campaigns:mutate`)
  assert.equal(adsCalls(/campaigns:mutate$/)[0].body.operations[0].update.resourceName, `customers/${ACCT2}/campaigns/222`)
  // Marking one business for reconnect leaves the other alone.
  refreshMode = 'invalid_grant'
  await G.listAccounts(env, 'salon')
  assert.equal((await getConnection(env, 'salon', 'google')).status, 'reconnect_required')
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'connected')
})

// ---------- test-account sandbox (Google Ads test accounts only; MOCK DATA) ----------

test('guard: without ADS_LIVE_LAUNCH, create/resume/budget work only on a verified Google Ads test account', async () => {
  await connected()
  // Real (non-test) account → every serving change refused before any mutate; pausing still works.
  mockTestAccount = false
  for (const r of [await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false }), await G.setStatus(env, 'pools', row(), 'ENABLED'), await G.setDailyBudget(env, 'pools', row(), 3000)]) {
    assert.equal(r.error, 'test_account_required')
  }
  assert.equal(adsCalls(/:mutate$/).length, 0, 'nothing sent to Google')
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'PAUSED'), { ok: true, status: 'PAUSED' }, 'pausing is never blocked')
  // Validation (validateOnly) creates nothing, so it stays available on any account.
  assert.equal((await G.launchCampaign(env, 'pools', campaign())).validateOnly, true)
  // Flag missing or unreadable → refused (fails closed).
  mockTestAccount = null
  assert.equal((await G.setStatus(env, 'pools', row(), 'ENABLED')).error, 'test_account_required')
  // Verified test account → allowed; the flag is re-read from Google right before the change.
  mockTestAccount = true
  calls = []
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'ENABLED'), { ok: true, status: 'ENABLED' })
  assert.ok(adsCalls(/googleAds:search$/).some((c) => c.body.query.includes('customer.test_account')), 're-checked live')
  assert.equal((await G.setDailyBudget(env, 'pools', row(), 2500)).dailyBudgetCents, 2500)
  assert.equal((await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false })).platformCampaignId, '222')
  // Operator live switch (needs separate approval) lifts the test-account requirement.
  mockTestAccount = false
  env.ADS_LIVE_LAUNCH = 'true'
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'ENABLED'), { ok: true, status: 'ENABLED' })
})

test('test business: ADS_LIVE_LAUNCH never applies; real accounts refused; unmarking keeps sandbox campaigns sandboxed', async () => {
  const TB = await import('../server/testbusiness.js')
  await connected()
  await connected('salon')
  env.ADS_LIVE_LAUNCH = 'true' // future operator switch: must not reach a test business
  await TB.setTestBusiness(env, 'pools', true, 'admin@getshowups.example')
  mockTestAccount = false // the connected account is a REAL Google Ads account
  for (const r of [await G.launchCampaign(env, 'pools', campaign(), { validateOnly: false }), await G.setStatus(env, 'pools', row(), 'ENABLED'), await G.setDailyBudget(env, 'pools', row(), 3000)]) {
    assert.equal(r.error, 'test_account_required')
  }
  assert.equal(adsCalls(/:mutate$/).length, 0, 'nothing sent to Google for the test business')
  assert.deepEqual(await G.setStatus(env, 'pools', row(), 'PAUSED'), { ok: true, status: 'PAUSED' }, 'pausing is never blocked')
  // Account choice: only test accounts are offered and accepted, live switch or not.
  const cookie = await session('owner@pools.example')
  const list = (await call(accounts, 'GET', '/api/ads/google/accounts', { cookie })).json()
  assert.deepEqual([list.sandbox, list.accounts.map((a) => a.id), list.hidden], [true, [ACCT2], 1])
  assert.deepEqual((await call(accounts, 'POST', '/api/ads/google/accounts', { cookie, body: { accountId: ACCT } })).json(), { error: 'test_account_required' })
  // A real business (not marked) is unaffected: the operator switch applies to it as before.
  assert.deepEqual(await G.setStatus(env, 'salon', row({ customer: 'salon' }), 'ENABLED'), { ok: true, status: 'ENABLED' })

  // Unmark: the Ads connection must be chosen again, and campaigns created while marked stay sandboxed.
  const before = Date.now() - 1000
  await TB.setTestBusiness(env, 'pools', false, 'admin@getshowups.example')
  assert.equal((await getConnection(env, 'pools', 'google')).status, 'needs_account', 'sandbox connection is not carried into live use')
  assert.equal((await G.setStatus(env, 'pools', row(), 'ENABLED')).error, 'needs_account')
  await connected() // the owner explicitly chooses an account again
  assert.equal((await G.setStatus(env, 'pools', row({ created_at: before }), 'ENABLED')).error, 'test_account_required', 'sandbox campaign stays sandboxed')
  assert.equal((await G.setDailyBudget(env, 'pools', row({ created_at: before }), 3000)).error, 'test_account_required')
  assert.deepEqual(await G.setStatus(env, 'pools', row({ created_at: Date.now() + 1000 }), 'ENABLED'), { ok: true, status: 'ENABLED' }, 'new campaigns follow the live switch')
  delete env.ADS_LIVE_LAUNCH
})

test('read: campaigns with status, daily budget and 30-day metrics; read-only; errors map to safe codes', async () => {
  await connected()
  ads = (path, body, h) => {
    if (/googleAds:searchStream$/.test(path)) {
      assert.match(body.query, /FROM campaign/)
      assert.match(body.query, /DURING LAST_30_DAYS/)
      // MOCK DATA: two daily rows for our campaign, one for a campaign GetShowUps did not create.
      return reply(200, [
        {
          results: [
            { campaign: { id: '222', name: 'Pool cleaning [gsu:cmp_abc123]', status: 'PAUSED' }, campaignBudget: { amountMicros: '25000000' }, metrics: { costMicros: '1230000', clicks: '3', impressions: '40', conversions: 1 } },
            { campaign: { id: '222', name: 'Pool cleaning [gsu:cmp_abc123]', status: 'PAUSED' }, campaignBudget: { amountMicros: '25000000' }, metrics: { costMicros: '770000', clicks: '2', impressions: '10', conversions: 0 } },
            { campaign: { id: '999', name: 'Owner campaign', status: 'ENABLED' }, campaignBudget: { amountMicros: '5000000' }, metrics: {} },
          ],
        },
      ])
    }
    return defaultAds(path, body, h)
  }
  const r = await G.readCampaigns(env, 'pools')
  assert.equal(r.ok, true)
  assert.equal(r.testAccount, true)
  assert.deepEqual(r.campaigns, [
    { id: '222', name: 'Pool cleaning [gsu:cmp_abc123]', status: 'PAUSED', dailyBudgetCents: 2500, clicks: 5, impressions: 50, conversions: 1, spendCents: 200, gsuId: 'cmp_abc123' },
    { id: '999', name: 'Owner campaign', status: 'ENABLED', dailyBudgetCents: 500, clicks: 0, impressions: 0, conversions: 0, spendCents: 0, gsuId: null },
  ])
  assert.equal(adsCalls(/:mutate$/).length, 0, 'reading never mutates')
  // Errors: permission and quota map to allowlisted codes; Google's message (may echo account data) never leaks.
  ads = () => adsError(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' })
  const denied = remember(await G.readCampaigns(env, 'pools'))
  assert.equal(denied.ok, false)
  assert.ok(!JSON.stringify(denied).includes('Jane Doe'))
  // Not connected / no account chosen.
  assert.equal((await G.readCampaigns(env, 'salon')).error, 'not_connected')
})

test('read route + campaign actions: owner-only, same-origin, tenant isolated, approved budget enforced', async () => {
  const campaignsRoute = await import('../functions/api/ads/google/campaigns.js')
  const campaignRoute = await import('../functions/api/dashboard/ads/campaign.js')
  const { saveProfile } = await import('../server/ads/campaigns.js')
  await connected()
  ads = (path, body, h) => (/googleAds:searchStream$/.test(path) ? reply(200, [{ results: [] }]) : defaultAds(path, body, h))
  const get = async (cookie) => campaignsRoute.onRequestGet({ request: new Request(`${ORIGIN}/api/ads/google/campaigns`, { headers: cookie ? { Cookie: cookie } : {} }), env })
  const owner = await session('owner@pools.example')
  assert.equal((await get()).status, 401)
  const mine = await get(owner)
  assert.deepEqual([mine.status, await mine.json()], [200, { testAccount: true, campaigns: [] }])
  assert.equal((await get(await session('owner@salon.example'))).status, 404, 'another business sees nothing of pools')
  env.ADS_ENABLED = 'false'
  assert.equal((await get(owner)).status, 404, 'feature switch off → route hidden')
  env.ADS_ENABLED = 'true'

  // A launched campaign row (MOCK) + an approved $600/month budget → daily ceiling applies to budget changes.
  const now = Date.now()
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, created_at, updated_at) VALUES ('cmp_abc123', 'pools', 'google', 'paused', ?, 1000, '222', ?, ?, ?)").run(JSON.stringify(campaign().spec), row().platform_ids, now, now)
  void saveProfile
  const post = (cookie, body, origin = ORIGIN) => campaignRoute.onRequestPost({ request: new Request(`${ORIGIN}/api/dashboard/ads/campaign`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env })
  assert.equal((await post(owner, { action: 'budget', id: 'cmp_abc123', dailyCents: 1500 })).status, 409, 'no approved budget yet')
  db.sql.prepare("INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES ('appr1', 'pools', 60000, 'owner@pools.example', ?)").run(now)
  assert.equal((await post(owner, { action: 'budget', id: 'cmp_abc123', dailyCents: 999999 })).status, 409, 'above the approved daily ceiling')
  assert.equal((await post(owner, { action: 'budget', id: 'cmp_abc123', dailyCents: 1500 }, 'https://evil.example')).status, 403)
  assert.equal((await post(await session('owner@salon.example'), { action: 'budget', id: 'cmp_abc123', dailyCents: 1500 })).status, 404, 'cannot touch another business’s campaign')
  const ok = await post(owner, { action: 'budget', id: 'cmp_abc123', dailyCents: 1500 })
  assert.deepEqual([ok.status, (await ok.json()).dailyBudgetCents], [200, 1500])
  assert.equal(db.sql.prepare("SELECT daily_budget_cents d FROM ad_campaigns WHERE id = 'cmp_abc123'").get().d, 1500)
  // Resume on the verified test account works without the live switch; on a real account it is refused.
  const resumed = await post(owner, { action: 'resume', id: 'cmp_abc123' })
  assert.equal(resumed.status, 200, await resumed.clone().text())
  await post(owner, { action: 'pause', id: 'cmp_abc123' })
  mockTestAccount = false
  assert.deepEqual([(await post(owner, { action: 'resume', id: 'cmp_abc123' })).status], [409])
  assert.equal(db.sql.prepare("SELECT status FROM ad_campaigns WHERE id = 'cmp_abc123'").get().status, 'paused')
})
