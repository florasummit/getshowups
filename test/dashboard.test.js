// Self-service onboarding, sessions, tenant isolation, and the appointment engine.
// Real handlers + real migrations on node:sqlite (D1 stand-in), Map-backed KV, mocked Google. Run: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, googleApi, sha256Hex } from '../server/google-oauth.js'
import { computeSlots, zonedToUtc, isValidTimeZone } from '../server/calendar.js'
import { slugify } from '../server/customers.js'
import * as loginStart from '../functions/api/auth/google/start.js'
import * as loginCallback from '../functions/api/auth/google/callback.js'
import * as logout from '../functions/api/auth/logout.js'
import * as me from '../functions/api/dashboard/me.js'
import * as business from '../functions/api/dashboard/business.js'
import * as hours from '../functions/api/dashboard/hours.js'
import * as calendar from '../functions/api/dashboard/calendar.js'
import * as connectLink from '../functions/api/dashboard/connect-link.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as outcome from '../functions/api/dashboard/outcome.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as customers from '../functions/api/admin/customers.js'

const ORIGIN = 'https://getshowups.com'
const ADMIN = 'admin-token-'.padEnd(48, 'x')
const CLIENT_ID = 'cid.apps.googleusercontent.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const FULL_SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const SECRETS = { clientSecret: 'CLIENT-SECRET-VALUE', rtA: '1//refresh-A', rtB: '1//refresh-B', atA: 'ya29.access-A', atB: 'ya29.access-B', loginAt: 'ya29.login-access' }
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CAL = 'https://www.googleapis.com/calendar/v3'
const HOUR = 3600_000

// ---------- harness ----------
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  }
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => sql.prepare(q).run(...args),
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

const idToken = (claims) =>
  `h.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, sub: 's', ...claims })).toString('base64url')}.sig`

let env, db, kv, calls, logs, google, events, origFetch, origError, responses

async function kvRecord(customer, rt, email) {
  return JSON.stringify({ customer, googleSub: 'g', email, scope: FULL_SCOPE, refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, rt), connectedAt: '2026-11-08T21:04:40.703Z' })
}

// Seeds a fully set-up business: open every day 00:00–23:00 UTC so slots always exist.
function seedCustomer(id, email, { zips = '', confirmed = true } = {}) {
  const now = Date.now()
  db.sql
    .prepare(`INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at)
              VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)`)
    .run(id, `${id} Co`, zips, confirmed ? now : null, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(email, id, now)
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  responses = []
  events = []
  env = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: SECRETS.clientSecret,
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: ADMIN,
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
  }
  seedCustomer('alpha', 'owner@alpha.example')
  seedCustomer('bravo', 'boss@bravo.example')
  kv.set('google:alpha', await kvRecord('alpha', SECRETS.rtA, 'cal@alpha.example'))
  kv.set('google:bravo', await kvRecord('bravo', SECRETS.rtB, 'cal@bravo.example'))

  google = {
    login: () => [200, { access_token: SECRETS.loginAt, id_token: idToken({ email: 'owner@alpha.example' }) }],
    refresh: (body) => {
      const map = { [SECRETS.rtA]: SECRETS.atA, [SECRETS.rtB]: SECRETS.atB }
      return map[body.refresh_token] ? [200, { access_token: map[body.refresh_token], scope: FULL_SCOPE }] : [400, { error: 'invalid_grant' }]
    },
    busy: [], // extra Google busy intervals (ISO pairs)
    freebusy: () => [200, { calendars: { primary: { busy: [...google.busy, ...events.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }))] } } }],
    insert: (body, auth) => {
      if (body.id && events.some((e) => e.id === body.id)) return [409, { error: { status: 'ALREADY_EXISTS' } }]
      const ev = { id: body.id || `evt${events.length + 1}`, auth, ...body }
      events.push(ev)
      return [200, { id: ev.id }]
    },
  }
  calls = []
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body })
    let out
    if (u === TOKEN_URL) {
      const body = Object.fromEntries(new URLSearchParams(init.body))
      out = body.grant_type === 'refresh_token' ? google.refresh(body) : google.login(body)
    } else if (u === `${CAL}/freeBusy`) out = google.freebusy(JSON.parse(init.body))
    else if (u === `${CAL}/calendars/primary/events?sendUpdates=all`) out = google.insert(JSON.parse(init.body), init.headers.Authorization)
    else if (u.startsWith(`${CAL}/calendars/primary/events/`) && init.method === 'DELETE') {
      const id = decodeURIComponent(u.split('/events/')[1].split('?')[0])
      events = events.filter((e) => e.id !== id)
      out = [204, {}]
    } else throw new Error(`unexpected fetch ${u}`)
    return new Response(out[0] === 204 ? null : JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const [name, v] of Object.entries(SECRETS)) assert.ok(!all.includes(v), `leaked ${name}`)
  assert.ok(!all.includes(KEY) && !all.includes(ADMIN), 'leaked key/admin token')
})

const refreshTokensUsed = () =>
  calls.filter((c) => c.url === TOKEN_URL).map((c) => new URLSearchParams(c.body).get('refresh_token')).filter(Boolean)

async function call(mod, method, path, { cookie, origin, headers = {}, body, params } = {}) {
  const h = { ...headers }
  if (cookie) h.Cookie = cookie
  if (origin) h.Origin = origin
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body)
    h['Content-Type'] = 'application/json'
  }
  const request = new Request(ORIGIN + path, { method, headers: h, body })
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request, env, params })
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, text, json: () => JSON.parse(text) }
}
const post = (mod, path, body, opts = {}) => call(mod, 'POST', path, { origin: ORIGIN, body, ...opts })

async function sessionFor(email, { expiresIn = HOUR } = {}) {
  const token = `${email}-session`.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Z').slice(0, 43)
  const now = Date.now()
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + expiresIn)
  return `__Host-gsu_session=${token}`
}

async function signIn(email) {
  google.login = () => [200, { id_token: idToken({ email }) }]
  const start = await call(loginStart, 'GET', '/api/auth/google/start')
  const loc = new URL(start.res.headers.get('Location'))
  const loginCookie = start.res.headers.get('Set-Cookie').split(';')[0]
  const cb = await call(loginCallback, 'GET', `/api/auth/google/callback?code=C&state=${loc.searchParams.get('state')}`, { cookie: loginCookie })
  const session = cb.res.headers.getSetCookie().find((c) => c.startsWith('__Host-gsu_session=') && !c.includes('Max-Age=0'))
  return { cb, loc, cookie: session?.split(';')[0] }
}

// Booking helpers (public API).
const book = {
  info: (id) => call(bookInfo, 'GET', `/api/book/${id}`, { params: { customer: id } }),
  lead: (id, body, opts) => post(bookLead, `/api/book/${id}/lead`, body, { params: { customer: id }, ...opts }),
  appt: (id, body, opts) => post(bookAppt, `/api/book/${id}/appointment`, body, { params: { customer: id }, ...opts }),
}
const LEAD = { name: 'Jamie Rivera', email: 'jamie@example.net', phone: '(555) 010-0199', need: 'Weekly pool cleaning', zip: '33101' }
async function newLead(id = 'alpha', patch = {}) {
  const r = await book.lead(id, { ...LEAD, ...patch })
  assert.equal(r.status, 201, r.text)
  return r.json()
}

// ---------- availability math ----------

test('zonedToUtc handles DST and non-hour offsets', () => {
  assert.equal(new Date(zonedToUtc(2026, 10, 30, 9, 0, 'America/New_York')).toISOString(), '2026-10-30T13:00:00.000Z')
  assert.equal(new Date(zonedToUtc(2026, 11, 2, 9, 0, 'America/New_York')).toISOString(), '2026-11-02T14:00:00.000Z')
  assert.equal(new Date(zonedToUtc(2026, 11, 9, 9, 0, 'Asia/Kolkata')).toISOString(), '2026-11-09T03:30:00.000Z')
  assert.equal(new Date(zonedToUtc(2026, 4, 9, 9, 0, 'Europe/London')).toISOString(), '2026-04-09T08:00:00.000Z')
  assert.ok(isValidTimeZone('America/New_York') && !isValidTimeZone('Mars/Base') && !isValidTimeZone(''))
})

test('computeSlots: booking hours, busy time, past slots, weekends, slot length', () => {
  const RULES = { timezone: 'America/New_York', slotMinutes: 60, dayStart: '09:00', dayEnd: '17:00', workdays: [1, 2, 3, 4, 5] }
  const MON_8AM = Date.parse('2026-11-09T13:00:00Z')
  assert.equal(computeSlots({ busy: [], rules: RULES, now: MON_8AM, days: 1 }).slots.length, 8)
  const busy = [{ start: Date.parse('2026-11-09T15:30:00Z'), end: Date.parse('2026-11-09T16:15:00Z') }]
  assert.equal(computeSlots({ busy, rules: RULES, now: MON_8AM, days: 1 }).slots.length, 6)
  assert.equal(computeSlots({ busy: [], rules: RULES, now: Date.parse('2026-11-09T17:30:00Z'), days: 1 }).slots.length, 4)
  assert.equal(computeSlots({ busy: [], rules: RULES, now: MON_8AM, days: 7 }).slots.length, 40)
  assert.equal(computeSlots({ busy: [], rules: { ...RULES, slotMinutes: 90 }, now: MON_8AM, days: 1 }).slots.length, 5)
})

test('slugify produces valid booking ids', () => {
  assert.equal(slugify('PoolThru'), 'poolthru')
  assert.equal(slugify("Joe's Pools & Spas, LLC"), 'joe-s-pools-spas-llc')
  assert.match(slugify('Ü'), /^[a-z0-9][a-z0-9-]{1,62}$/)
})

test('googleApi: the test-only mock origin is honored only for loopback http', () => {
  assert.equal(googleApi({}).token, 'https://oauth2.googleapis.com/token')
  assert.equal(googleApi({ GOOGLE_API_MOCK_ORIGIN: 'http://127.0.0.1:8790' }).calendar, 'http://127.0.0.1:8790/calendar/v3')
  for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example:80', 'http://localhost:8790', 'http://127.0.0.1:8790/x', 'http://10.0.0.1:80']) {
    assert.equal(googleApi({ GOOGLE_API_MOCK_ORIGIN: bad }).token, 'https://oauth2.googleapis.com/token', bad)
  }
})

// ---------- sign-in ----------

test('login: openid+email only; any verified Google account gets a session (self-service)', async () => {
  const { loc, cb, cookie } = await signIn('new.owner@example.org')
  assert.equal(loc.searchParams.get('scope'), 'openid email')
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(cb.res.headers.get('Location'), '/dashboard')
  assert.match(cb.res.headers.getSetCookie().find((c) => c.startsWith('__Host-gsu_session=')), /HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/)
  const body = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.equal(body.customer, null)
  assert.deepEqual(body.progress, { business: false, calendar: false, hours: false, complete: false })
  const row = db.sql.prepare("SELECT token_hash FROM sessions WHERE email = 'new.owner@example.org'").get()
  assert.equal(row.token_hash, await sha256Hex(cookie.split('=')[1]))
})

test('login: unverified, wrong-audience, wrong-issuer, or missing email get no session', async () => {
  for (const claims of [{ email: 'a@b.co', email_verified: false }, { email: 'a@b.co', aud: 'x' }, { email: 'a@b.co', iss: 'https://evil.example' }, { email: undefined }]) {
    google.login = () => [200, { id_token: idToken(claims) }]
    const start = await call(loginStart, 'GET', '/api/auth/google/start')
    const state = new URL(start.res.headers.get('Location')).searchParams.get('state')
    const cb = await call(loginCallback, 'GET', `/api/auth/google/callback?code=C&state=${state}`, { cookie: start.res.headers.get('Set-Cookie').split(';')[0] })
    assert.equal(cb.res.headers.get('Location'), '/dashboard?login_error=failed', JSON.stringify(claims))
  }
  assert.equal(db.sql.prepare('SELECT count(*) c FROM sessions').get().c, 0)
})

test('login: state/CSRF failures and cancellation', async () => {
  const start = await call(loginStart, 'GET', '/api/auth/google/start')
  const state = new URL(start.res.headers.get('Location')).searchParams.get('state')
  const lc = start.res.headers.get('Set-Cookie').split(';')[0]
  const loc = async (q, cookie) => (await call(loginCallback, 'GET', `/api/auth/google/callback?${q}`, { cookie })).res.headers.get('Location')
  assert.equal(await loc('code=C&state=WRONG', lc), '/dashboard?login_error=expired')
  assert.equal(await loc(`code=C&state=${state}`), '/dashboard?login_error=expired')
  assert.equal(await loc('error=access_denied', lc), '/dashboard?login_error=cancelled')
})

// ---------- sessions ----------

test('session: missing, malformed, unknown, expired → 401; logout requires same origin and revokes', async () => {
  assert.equal((await call(me, 'GET', '/api/dashboard/me')).status, 401)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: '__Host-gsu_session=short' })).status, 401)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: `__Host-gsu_session=${'Q'.repeat(43)}` })).status, 401)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: await sessionFor('old@alpha.example', { expiresIn: -1 }) })).status, 401)
  const cookie = await sessionFor('owner@alpha.example')
  assert.equal((await call(logout, 'POST', '/api/auth/logout', { cookie, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(logout, 'POST', '/api/auth/logout', { cookie, origin: ORIGIN })).status, 200)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).status, 401)
})

test('session: removing a user from the business revokes business access immediately', async () => {
  const cookie = await sessionFor('owner@alpha.example')
  assert.equal((await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).status, 200)
  db.sql.exec("DELETE FROM customer_users WHERE email = 'owner@alpha.example'")
  assert.equal((await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).status, 409)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).json().customer, null)
})

test('dashboard routes fail closed without configuration', async () => {
  const cookie = await sessionFor('owner@alpha.example')
  delete env.ONBOARDING_DB
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).status, 503)
  assert.equal((await post(hours, '/api/dashboard/hours', {}, { cookie })).status, 503)
  assert.equal((await book.info('alpha')).status, 503)
})

// ---------- self-service onboarding ----------

test('onboarding: new user creates a business, connects, sets hours, and setup completes', async () => {
  const { cookie } = await signIn('owner@newpools.example')
  assert.equal((await post(hours, '/api/dashboard/hours', {}, { cookie })).status, 409) // business first

  const created = await post(business, '/api/dashboard/business', { name: 'New Pools', timezone: 'America/Chicago', serviceZips: '60601, 60602' }, { cookie })
  assert.equal(created.status, 201)
  const id = created.json().id
  assert.equal(id, 'new-pools')
  let state = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.deepEqual(state.progress, { business: true, calendar: false, hours: false, complete: false })
  assert.deepEqual(state.customer.serviceZips, ['60601', '60602'])
  assert.equal(state.bookingUrl, `${ORIGIN}/book/new-pools`)

  const link = (await post(connectLink, '/api/dashboard/connect-link', undefined, { cookie })).json()
  assert.equal(link.purpose, 'connect')
  assert.match(link.invite, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(db.sql.prepare('SELECT customer FROM onboarding_invites').get().customer, 'new-pools')

  kv.set('google:new-pools', await kvRecord('new-pools', SECRETS.rtA, 'cal@newpools.example')) // what the existing callback stores
  assert.equal((await post(hours, '/api/dashboard/hours', { workdays: [1, 2, 3, 4, 5, 6], dayStart: '08:00', dayEnd: '16:00', slotMinutes: 90 }, { cookie })).status, 200)
  state = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.deepEqual(state.progress, { business: true, calendar: true, hours: true, complete: true })
  assert.equal(state.customer.slotMinutes, 90)
  assert.equal((await book.info('new-pools')).status, 200)
})

test('onboarding: business updates keep the same id; validation errors are specific', async () => {
  const cookie = await sessionFor('owner@alpha.example')
  for (const [patch, error] of [[{ name: '' }, 'invalid_name'], [{ timezone: 'Mars/Base' }, 'invalid_timezone'], [{ serviceZips: '<script>' }, 'invalid_zips']]) {
    const r = await post(business, '/api/dashboard/business', { name: 'Alpha', timezone: 'UTC', ...patch }, { cookie })
    assert.equal(r.status, 400)
    assert.equal(r.json().error, error)
  }
  const r = await post(business, '/api/dashboard/business', { name: 'Alpha Pools Renamed', timezone: 'UTC' }, { cookie })
  assert.deepEqual(r.json(), { id: 'alpha' })
  assert.equal(db.sql.prepare("SELECT name FROM customers WHERE id = 'alpha'").get().name, 'Alpha Pools Renamed')
  for (const [patch, error] of [[{ slotMinutes: 5 }, 'invalid_slot_minutes'], [{ dayStart: '18:00', dayEnd: '09:00' }, 'invalid_hours'], [{ workdays: [] }, 'invalid_workdays']]) {
    const h = await post(hours, '/api/dashboard/hours', patch, { cookie })
    assert.equal(h.json().error, error)
  }
})

test('onboarding: a new business can never take over an existing calendar connection id', async () => {
  kv.set('google:poolthru', await kvRecord('poolthru', SECRETS.rtB, 'care@poolthru.example')) // pre-existing connection, no customer row
  const { cookie } = await signIn('impostor@example.org')
  const id = (await post(business, '/api/dashboard/business', { name: 'PoolThru', timezone: 'UTC' }, { cookie })).json().id
  assert.equal(id, 'poolthru-2')
  const { cookie: c2 } = await signIn('another@example.org')
  assert.equal((await post(business, '/api/dashboard/business', { name: 'Alpha', timezone: 'UTC' }, { cookie: c2 })).json().id, 'alpha-2')
  const state = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.equal(state.progress.calendar, false)
})

test('onboarding: write routes require same origin and a session', async () => {
  const cookie = await sessionFor('owner@alpha.example')
  for (const [mod, path] of [[business, '/api/dashboard/business'], [hours, '/api/dashboard/hours'], [connectLink, '/api/dashboard/connect-link'], [outcome, '/api/dashboard/outcome']]) {
    assert.equal((await post(mod, path, {}, { cookie, origin: 'https://evil.example' })).status, 403, path)
    assert.equal((await post(mod, path, {})).status, 401, path)
  }
})

test('existing business (PoolThru path): admin links owner, calendar connection is preserved', async () => {
  kv.set('google:poolthru', await kvRecord('poolthru', SECRETS.rtB, 'care@poolthru.example'))
  const linked = await post(customers, '/api/admin/customers', { customer: 'poolthru', name: 'PoolThru', timezone: 'America/New_York', users: ['Care@PoolThru.example'] }, { headers: { Authorization: `Bearer ${ADMIN}` } })
  assert.equal(linked.status, 200)
  assert.equal(linked.json().calendarConnected, true)
  const { cookie } = await signIn('care@poolthru.example')
  const state = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.equal(state.customer.id, 'poolthru')
  assert.deepEqual(state.progress, { business: true, calendar: true, hours: false, complete: false })
  const before = kv.get('google:poolthru')
  await post(hours, '/api/dashboard/hours', { workdays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', slotMinutes: 60 }, { cookie })
  assert.equal(kv.get('google:poolthru'), before)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).json().progress.complete, true)
})

test('admin customers: auth, validation, and emails never move between businesses', async () => {
  const auth = { Authorization: `Bearer ${ADMIN}` }
  assert.equal((await post(customers, '/api/admin/customers', { customer: 'x' }, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await post(customers, '/api/admin/customers', { customer: 'Bad!', name: 'X', timezone: 'UTC', users: ['a@b.co'] }, { headers: auth })).json().error, 'invalid_customer')
  assert.equal((await post(customers, '/api/admin/customers', { customer: 'zed', name: 'X', timezone: 'UTC', users: [] }, { headers: auth })).json().error, 'invalid_users')
  const r = await post(customers, '/api/admin/customers', { customer: 'zed', name: 'Zed', timezone: 'UTC', users: ['owner@alpha.example'] }, { headers: auth })
  assert.equal(r.status, 409)
})

// ---------- tenant isolation ----------

test('isolation: calendar status and connect links use only the session business', async () => {
  const cookie = await sessionFor('boss@bravo.example')
  const status = (await call(calendar, 'GET', '/api/dashboard/calendar?customer=alpha', { cookie })).json()
  assert.equal(status.account.email, 'cal@bravo.example')
  assert.deepEqual(refreshTokensUsed(), [SECRETS.rtB])
  await post(connectLink, '/api/dashboard/connect-link?customer=alpha', { customer: 'alpha' }, { cookie })
  assert.deepEqual(db.sql.prepare('SELECT customer FROM onboarding_invites').all().map((r) => r.customer), ['bravo'])
})

test('isolation: overview and outcomes never cross businesses', async () => {
  const a = await newLead('alpha')
  const slotA = (await book.info('alpha')).json().slots[0]
  assert.equal((await book.appt('alpha', { leadId: a.leadId, leadToken: a.leadToken, start: slotA })).status, 201)
  const bravo = await sessionFor('boss@bravo.example')
  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: bravo })).json()
  assert.equal(ov.upcoming.length, 0)
  assert.equal(ov.stats.leads, 0)
  const apptId = db.sql.prepare("SELECT id FROM appointments WHERE customer = 'alpha'").get().id
  db.sql.prepare('UPDATE appointments SET start_at = ? WHERE id = ?').run(Date.now() - HOUR, apptId)
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: apptId, outcome: 'no_show' }, { cookie: bravo })).status, 404)
  assert.equal(db.sql.prepare('SELECT status FROM appointments WHERE id = ?').get(apptId).status, 'booked')
})

test('isolation: a lead token for one business cannot book at another', async () => {
  const a = await newLead('alpha')
  const slot = (await book.info('bravo')).json().slots[0]
  assert.equal((await book.appt('bravo', { leadId: a.leadId, leadToken: a.leadToken, start: slot })).status, 404)
})

// ---------- public booking ----------

test('booking page: only fully set-up businesses are bookable', async () => {
  assert.equal((await book.info('nope')).status, 404)
  assert.equal((await book.info('Bad Id!')).status, 404)
  seedCustomer('charlie', 'c@charlie.example', { confirmed: false })
  kv.set('google:charlie', await kvRecord('charlie', SECRETS.rtA, 'x@charlie.example'))
  assert.equal((await book.info('charlie')).status, 404) // hours not confirmed
  seedCustomer('delta', 'd@delta.example')
  assert.equal((await book.info('delta')).status, 404) // no calendar connection
})

test('booking page: real open slots exclude Google busy time and booked appointments; no private data', async () => {
  const first = (await book.info('alpha')).json()
  assert.deepEqual(Object.keys(first).sort(), ['askZip', 'name', 'offerSms', 'slotMinutes', 'slots', 'status', 'timezone'])
  assert.equal(first.offerSms, false, 'no SMS provider configured → no SMS consent offered')
  assert.equal(first.status, 'ok')
  const [s0, s1] = first.slots
  google.busy = [{ start: s0, end: new Date(Date.parse(s0) + HOUR).toISOString() }]
  const a = await newLead()
  assert.equal((await book.appt('alpha', { leadId: a.leadId, leadToken: a.leadToken, start: s1 })).status, 201)
  events = [] // even if Google has not shown the event yet, our own booking blocks the slot
  const after = (await book.info('alpha')).json().slots
  assert.ok(!after.includes(s0) && !after.includes(s1))
})

test('lead capture: validation, honeypot, same-origin, and service-area qualification', async () => {
  for (const [patch, error] of [[{ name: 'J' }, 'invalid_name'], [{ email: 'nope' }, 'invalid_email'], [{ phone: '12' }, 'invalid_phone'], [{ need: '' }, 'invalid_need']]) {
    const r = await book.lead('alpha', { ...LEAD, ...patch })
    assert.equal(r.json().error, error)
  }
  assert.equal((await book.lead('alpha', { ...LEAD, website: 'http://spam' })).status, 400)
  assert.equal((await book.lead('alpha', LEAD, { origin: 'https://evil.example' })).status, 403)

  seedCustomer('zipco', 'z@zipco.example', { zips: '33101,33102' })
  kv.set('google:zipco', await kvRecord('zipco', SECRETS.rtA, 'cal@zipco.example'))
  assert.equal((await book.info('zipco')).json().askZip, true)
  assert.equal((await book.lead('zipco', { ...LEAD, zip: '' })).json().error, 'invalid_zip')
  assert.equal((await newLead('zipco', { zip: '33101' })).qualified, true)
  const out = await newLead('zipco', { zip: '90210' })
  assert.equal(out.qualified, false)
  const slot = (await book.info('zipco')).json().slots[0]
  assert.equal((await book.appt('zipco', { leadId: out.leadId, leadToken: out.leadToken, start: slot })).json().error, 'not_qualified')
  assert.equal(db.sql.prepare("SELECT status FROM leads WHERE zip = '90210'").get().status, 'unqualified')
})

test('booking: creates a real calendar event, invites the lead, records the appointment', async () => {
  const lead = await newLead()
  const slot = (await book.info('alpha')).json().slots[0]
  const r = await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slot })
  assert.equal(r.status, 201)
  assert.equal(r.json().start, slot)
  assert.equal(events.length, 1)
  assert.equal(events[0].auth, `Bearer ${SECRETS.atA}`)
  assert.deepEqual(events[0].attendees, [{ email: LEAD.email, displayName: LEAD.name }])
  assert.equal(events[0].start.dateTime, slot)
  assert.match(events[0].description, /Phone: \(555\) 010-0199/)
  const appt = db.sql.prepare('SELECT status, google_event_id FROM appointments').get()
  assert.equal(appt.status, 'booked')
  assert.match(appt.google_event_id, /^gsu[0-9a-f]{32}$/)
  assert.equal(events[0].id, appt.google_event_id)
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(lead.leadId).status, 'booked')
  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await sessionFor('owner@alpha.example') })).json()
  assert.equal(ov.stats.leads, 1)
  assert.equal(ov.stats.booked, 1)
  assert.equal(ov.upcoming[0].name, LEAD.name)
})

test('booking: the same slot cannot be booked twice, even concurrently', async () => {
  const slot = (await book.info('alpha')).json().slots[0]
  const [a, b, c] = [await newLead(), await newLead('alpha', { email: 'b@example.net' }), await newLead('alpha', { email: 'c@example.net' })]
  assert.equal((await book.appt('alpha', { leadId: a.leadId, leadToken: a.leadToken, start: slot })).status, 201)
  const again = await book.appt('alpha', { leadId: b.leadId, leadToken: b.leadToken, start: slot })
  assert.equal(again.status, 409)
  assert.equal(again.json().error, 'slot_unavailable')

  const slot2 = (await book.info('alpha')).json().slots[0]
  const results = await Promise.all([
    book.appt('alpha', { leadId: b.leadId, leadToken: b.leadToken, start: slot2 }),
    book.appt('alpha', { leadId: c.leadId, leadToken: c.leadToken, start: slot2 }),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  assert.equal(events.length, 2)
  assert.equal(db.sql.prepare("SELECT count(*) c FROM appointments WHERE status = 'booked'").get().c, 2)
})

test('booking: a slot that became busy on Google is refused and released', async () => {
  const lead = await newLead()
  const slot = (await book.info('alpha')).json().slots[0]
  google.busy = [{ start: slot, end: new Date(Date.parse(slot) + 30 * 60_000).toISOString() }]
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slot })).json().error, 'slot_unavailable')
  assert.equal(db.sql.prepare('SELECT count(*) c FROM appointments').get().c, 0)
  google.busy = []
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slot })).status, 201)
})

test('booking: Google failure rolls back cleanly so the lead can retry', async () => {
  const lead = await newLead()
  const slot = (await book.info('alpha')).json().slots[0]
  google.insert = () => [403, { error: { status: 'PERMISSION_DENIED', message: 'cal@alpha.example denied' } }]
  const r = await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slot })
  assert.equal(r.status, 502)
  assert.equal(r.json().error, 'booking_failed')
  assert.equal(db.sql.prepare('SELECT count(*) c FROM appointments').get().c, 0)
  assert.equal(db.sql.prepare('SELECT status FROM leads').get().status, 'new')
  google.refresh = () => [400, { error: 'invalid_grant' }]
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slot })).json().error, 'calendar_unavailable')
})

test('booking: wrong token, already-booked lead, and non-offered times are refused', async () => {
  const lead = await newLead()
  const slots = (await book.info('alpha')).json().slots
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: 'x'.repeat(43), start: slots[0] })).status, 404)
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: new Date(Date.parse(slots[0]) + 60_000).toISOString() })).json().error, 'slot_unavailable')
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: new Date(Date.now() - 2 * HOUR).toISOString() })).json().error, 'slot_unavailable')
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: 'garbage' })).json().error, 'invalid_request')
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slots[0] })).status, 201)
  assert.equal((await book.appt('alpha', { leadId: lead.leadId, leadToken: lead.leadToken, start: slots[1] })).json().error, 'already_booked')
  assert.equal(events.length, 1)
})

test('results: outcomes only on past appointments; show rate and follow-up list', async () => {
  const cookie = await sessionFor('owner@alpha.example')
  const slots = (await book.info('alpha')).json().slots
  const leads = [await newLead(), await newLead('alpha', { email: 'b@example.net' }), await newLead('alpha', { email: 'c@example.net', name: 'Casey Unbooked' })]
  for (const [i, l] of leads.slice(0, 2).entries()) await book.appt('alpha', { leadId: l.leadId, leadToken: l.leadToken, start: slots[i] })
  const ids = db.sql.prepare('SELECT id FROM appointments ORDER BY start_at').all().map((r) => r.id)
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: ids[0], outcome: 'showed' }, { cookie })).status, 404) // future
  db.sql.prepare('UPDATE appointments SET start_at = start_at - ?, end_at = end_at - ?').run(3 * 24 * HOUR, 3 * 24 * HOUR)
  let ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json()
  assert.equal(ov.needsOutcome.length, 2)
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: ids[0], outcome: 'showed' }, { cookie })).status, 200)
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: ids[1], outcome: 'no_show' }, { cookie })).status, 200)
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: ids[1], outcome: 'cancelled' }, { cookie })).status, 400)
  ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json()
  assert.deepEqual(ov.stats, { leads: 3, booked: 2, confirmed: 0, showed: 1, noShow: 1, bookingRate: 67, showRate: 50 })
  assert.equal(ov.needsOutcome.length, 0)
  assert.equal(ov.recent.length, 2)
  // The no-show reopens its lead: it is back on the follow-up list (and can rebook from a message link).
  assert.deepEqual(ov.followUp.map((l) => l.name).sort(), ['Casey Unbooked', 'Jamie Rivera'])
  // Correcting the outcome to showed closes the lead again.
  assert.equal((await post(outcome, '/api/dashboard/outcome', { id: ids[1], outcome: 'showed' }, { cookie })).status, 200)
  ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json()
  assert.deepEqual(ov.followUp.map((l) => l.name), ['Casey Unbooked'])
})
