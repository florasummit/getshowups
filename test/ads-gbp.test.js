// Google Business Profile link (server/ads/gbp.js, /api/ads/gbp/*): off unless GBP_ENABLED; OAuth with the
// business.manage scope only (state, PKCE, same business); the account's listings are read (readMask, names and
// places only), one listing is linked automatically or chosen (validated against Google's list), Google's Voice of
// Merchant state is stored as the only verification claim; what is missing on the profile is reported; tokens never
// leave the server; isolation; readiness facts; nothing before migration 0037. node:sqlite D1, mocked fetch.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { loadToken } from '../server/ads/connections.js'
import { GBP_SCOPE, gbpReadiness, gbpStatus, gbpVerified, mapError, selectLocation, voiceOfMerchantWithToken } from '../server/ads/gbp.js'
import * as start from '../functions/api/ads/gbp/start.js'
import * as callback from '../functions/api/ads/gbp/callback.js'
import * as locations from '../functions/api/ads/gbp/locations.js'
import * as adsIndex from '../functions/api/dashboard/ads/index.js'

const ORIGIN = 'https://getshowups.com'
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()
function d1(files = MIGRATIONS) {
  const sql = new DatabaseSync(':memory:')
  for (const f of files) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
let env, db, kv, calls, logs, origFetch, origError, listings, vom
const RT = '1//gbp-refresh-SECRET'
const AT = 'ya29.gbp-access-SECRET'
const now = Date.now()
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const LOC = { name: 'locations/987654321', title: 'Coastal Air Heating & Cooling', storefrontAddress: { locality: 'Charleston', administrativeArea: 'SC', postalCode: '29403' }, phoneNumbers: { primaryPhone: '+1 843-555-0100' }, regularHours: { periods: [{ openDay: 'MONDAY' }] }, categories: { primaryCategory: { name: 'categories/gcid:hvac_contractor', displayName: 'HVAC contractor' } }, serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY' }, metadata: { hasVoiceOfMerchant: true, placeId: 'ChIJx', mapsUri: 'https://maps.google.com/?cid=1' } }
const LOC2 = { name: 'locations/123123123', title: 'Coastal Air — North', storefrontAddress: { locality: 'Summerville', administrativeArea: 'SC' }, websiteUri: 'https://coastalair.example', phoneNumbers: { primaryPhone: '+1 843-555-0101' }, metadata: { hasVoiceOfMerchant: false, duplicateLocation: 'locations/987654321' } }

function seed(id, owner) {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, headers: extra = {} } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...extra }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && !('Origin' in extra)) headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env })
  const text = await res.text()
  return { res, status: res.status, text, json: () => JSON.parse(text), location: res.headers.get('Location') }
}
const stateCookie = (res) => res.headers.get('Set-Cookie').match(/__Host-gsu_gbp=([^;]*)/)[1]
async function connect(email = 'owner@pools.example') {
  const cookie = await session(email)
  const s = await call(start, 'GET', '/api/ads/gbp/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  assert.equal(s.status, 302, s.text)
  const state = new URL(s.location).searchParams.get('state')
  return { cookie, cb: await call(callback, 'GET', `/api/ads/gbp/callback?code=c0de&state=${state}`, { cookie: `${cookie}; __Host-gsu_gbp=${stateCookie(s.res)}` }) }
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  logs = []
  listings = [LOC]
  vom = { hasVoiceOfMerchant: true, hasBusinessAuthority: true }
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GBP_ENABLED: 'true',
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u.replace(/\?.*$/, ''), query: u.includes('?') ? u.split('?')[1] : '', auth: new Headers(init.headers).get('Authorization') })
    if (u === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'authorization_code') return reply(200, { access_token: AT, refresh_token: RT, scope: GBP_SCOPE })
      return reply(200, { access_token: AT, scope: GBP_SCOPE })
    }
    if (u.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return reply(200, { accounts: [{ name: 'accounts/111222333', accountName: 'Coastal Air', type: 'PERSONAL' }] })
    if (u.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111222333/locations')) return reply(200, { locations: listings })
    if (/^https:\/\/mybusinessverifications\.googleapis\.com\/v1\/locations\/\d+\/VoiceOfMerchantState$/.test(u)) return reply(200, vom)
    throw new Error(`unexpected ${u}`)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  for (const s of [RT, AT]) assert.ok(!logs.join('\n').includes(s), `must not leak ${s}`)
})

test('off unless GBP_ENABLED: start, callback and locations answer 404 / not_configured; the Ads payload says not available and gives the facts', async () => {
  delete env.GBP_ENABLED
  const cookie = await session('owner@pools.example')
  assert.equal((await call(start, 'GET', '/api/ads/gbp/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 404)
  assert.equal((await call(callback, 'GET', '/api/ads/gbp/callback?code=x&state=y', { cookie })).location, '/dashboard/ads?ads_error=gbp_not_configured')
  assert.equal((await call(locations, 'GET', '/api/ads/gbp/locations', { cookie })).status, 404)
  const d = (await call(adsIndex, 'GET', '/api/dashboard/ads', { cookie })).json()
  assert.deepEqual([d.capabilities.gbp, d.businessProfile, d.businessProfileReadiness.available, d.businessProfileReadiness.canCreateHere], [false, null, false, false])
  assert.equal(d.businessProfileReadiness.items.find((i) => i.id === 'connect').detail, 'Connecting here opens once Google approves GetShowUps’ Business Profile access.')
})

test('connect: business.manage scope only with PKCE and state; the one listing is linked with Google’s verification state; the Ads tab shows title, place, Verified and what is missing; tokens stay encrypted', async () => {
  const { cookie, cb } = await connect()
  assert.equal(cb.location, '/dashboard/ads?ads=gbp_connected', cb.text)
  const authUrl = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'))
  assert.ok(authUrl)
  const s = await call(start, 'GET', '/api/ads/gbp/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  const auth = new URL(s.location)
  assert.deepEqual([auth.origin, auth.searchParams.get('scope'), auth.searchParams.get('code_challenge_method'), auth.searchParams.get('redirect_uri')], ['https://accounts.google.com', GBP_SCOPE, 'S256', `${ORIGIN}/api/ads/gbp/callback`])
  // What Google was asked: accounts, locations with the required readMask, Voice of Merchant. Never a write.
  const locCall = calls.find((c) => c.url.includes('/locations'))
  assert.ok(locCall.query.includes('readMask=') && locCall.query.includes('metadata'), locCall.query)
  assert.ok(calls.some((c) => c.url.endsWith('/locations/987654321/VoiceOfMerchantState')))
  const row = db.sql.prepare("SELECT * FROM gbp_connections WHERE customer = 'pools'").get()
  assert.deepEqual([row.status, row.account_name, row.location_name, row.title], ['connected', 'accounts/111222333', 'locations/987654321', 'Coastal Air Heating & Cooling'])
  assert.ok(!row.extra.includes('843') && !row.verification.includes(AT), 'no phone number, no token in the row')
  assert.equal((await loadToken(env, 'gbp', 'pools')).refreshToken, RT)
  const d = (await call(adsIndex, 'GET', '/api/dashboard/ads', { cookie })).json()
  assert.deepEqual([d.businessProfile.status, d.businessProfile.title, d.businessProfile.place, d.businessProfile.category, d.businessProfile.verification.state, d.businessProfile.verification.label, d.businessProfile.missing, d.businessProfile.mapsUri], ['connected', 'Coastal Air Heating & Cooling', 'Charleston, SC', 'HVAC contractor', 'verified', 'Verified', ['website'], 'https://maps.google.com/?cid=1'])
  assert.ok(!JSON.stringify(d).includes(RT) && !JSON.stringify(d).includes(AT))
  assert.equal(await gbpVerified(env, 'pools'), true)
  assert.equal(await gbpVerified(env, 'salon'), null)
  // The other business sees nothing of it.
  const salon = await session('owner@salon.example')
  assert.equal((await call(adsIndex, 'GET', '/api/dashboard/ads', { cookie: salon })).json().businessProfile, null)
  assert.equal((await call(locations, 'GET', '/api/ads/gbp/locations', { cookie: salon })).status, 404)
})

test('several listings: the owner chooses from Google’s list (a typed name is refused); an unverified duplicate is shown as such; Google’s state words', async () => {
  listings = [LOC, LOC2]
  const { cookie, cb } = await connect()
  assert.equal(cb.location, '/dashboard/ads?ads=gbp_connected')
  assert.equal(db.sql.prepare("SELECT status FROM gbp_connections WHERE customer = 'pools'").get().status, 'needs_location')
  const list = (await call(locations, 'GET', '/api/ads/gbp/locations', { cookie })).json()
  assert.deepEqual([list.status, list.selected, list.locations.map((l) => [l.title, l.place, l.verified, l.duplicate])], ['needs_location', null, [['Coastal Air Heating & Cooling', 'Charleston, SC', true, false], ['Coastal Air — North', 'Summerville, SC', false, true]]])
  assert.equal((await call(locations, 'POST', '/api/ads/gbp/locations', { cookie, body: { locationName: 'locations/555' } })).json().error, 'location_not_accessible')
  assert.equal((await call(locations, 'POST', '/api/ads/gbp/locations', { cookie, body: { locationName: 'x; DROP' } })).status, 400)
  vom = { hasVoiceOfMerchant: false, hasBusinessAuthority: true, verify: { hasPendingVerification: true } }
  const r = await call(locations, 'POST', '/api/ads/gbp/locations', { cookie, body: { locationName: 'locations/123123123' } })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.json().verification.state, 'pending_verification')
  const st = await gbpStatus(env, 'pools')
  assert.deepEqual([st.status, st.title, st.verification.label, st.verification.verified, st.missing, st.choices], ['connected', 'Coastal Air — North', 'Verification pending', false, ['hours', 'category'], 2])
  assert.equal(await gbpVerified(env, 'pools'), false)
  // Voice of Merchant answers → plain states.
  const states = async (body) => {
    vom = body
    return (await voiceOfMerchantWithToken(env, AT, 'locations/1')).verification.state
  }
  assert.equal(await states({ hasVoiceOfMerchant: false, verify: { hasPendingVerification: false } }), 'needs_verification')
  assert.equal(await states({ hasVoiceOfMerchant: false, resolveOwnershipConflict: {} }), 'ownership_conflict')
  assert.equal(await states({ hasVoiceOfMerchant: false, complyWithGuidelines: { recommendationReason: 'BUSINESS_LOCATION_SUSPENDED' } }), 'suspended')
  assert.equal(await states({ hasVoiceOfMerchant: false, waitForVoiceOfMerchant: {} }), 'waiting')
  assert.equal(await states({}), 'unknown')
  assert.deepEqual([mapError(401).error, mapError(403).error, mapError(429).error, mapError(503).error, mapError(400).error], ['reconnect_required', 'permission_denied', 'quota_exhausted', 'transient', 'invalid_request'])
})

test('callback refusals: bad state, another business, missing scope, no refresh token, cancelled; nothing stored', async () => {
  const cookie = await session('owner@pools.example')
  const s = await call(start, 'GET', '/api/ads/gbp/start', { cookie, headers: { 'Sec-Fetch-Site': 'same-origin' } })
  const sealed = stateCookie(s.res)
  assert.equal((await call(callback, 'GET', '/api/ads/gbp/callback?code=c&state=wrong', { cookie: `${cookie}; __Host-gsu_gbp=${sealed}` })).location, '/dashboard/ads?ads_error=gbp_expired')
  assert.equal((await call(callback, 'GET', '/api/ads/gbp/callback?error=access_denied', { cookie })).location, '/dashboard/ads?ads_error=gbp_cancelled')
  const other = await session('owner@salon.example')
  const state = new URL(s.location).searchParams.get('state')
  assert.equal((await call(callback, 'GET', `/api/ads/gbp/callback?code=c&state=${state}`, { cookie: `${other}; __Host-gsu_gbp=${sealed}` })).location, '/dashboard/ads?ads_error=gbp_expired')
  globalThis.fetch = async () => reply(200, { access_token: AT, refresh_token: RT, scope: 'openid email' })
  assert.equal((await call(callback, 'GET', `/api/ads/gbp/callback?code=c&state=${state}`, { cookie: `${cookie}; __Host-gsu_gbp=${sealed}` })).location, '/dashboard/ads?ads_error=gbp_scope_denied')
  globalThis.fetch = async () => reply(200, { access_token: AT, scope: GBP_SCOPE })
  assert.equal((await call(callback, 'GET', `/api/ads/gbp/callback?code=c&state=${state}`, { cookie: `${cookie}; __Host-gsu_gbp=${sealed}` })).location, '/dashboard/ads?ads_error=gbp_no_refresh_token')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM gbp_connections').get().n, 0)
  assert.equal(kv.size, 0)
  // Cross-site start is refused.
  assert.equal((await call(start, 'GET', '/api/ads/gbp/start', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
})

test('readiness facts; before migration 0037 nothing breaks', async () => {
  const r = gbpReadiness({ enabled: true })
  assert.deepEqual([r.canCreateHere, r.setupUrl, r.items.map((i) => i.id)], [false, 'https://business.google.com/create', ['exists', 'eligible', 'account', 'create', 'verify', 'connect']])
  const old = d1(MIGRATIONS.filter((f) => !f.startsWith('0037')))
  old.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('pools', 'Pools', 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(now, now, now)
  const e = { ...env, ONBOARDING_DB: old }
  assert.equal(await gbpStatus(e, 'pools'), null)
  assert.equal(await gbpVerified(e, 'pools'), null)
  assert.deepEqual((await selectLocation(e, 'pools', 'locations/1')).error, 'not_ready')
})
