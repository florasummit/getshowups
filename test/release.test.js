// Release hardening: rate limits, Google timeouts/failures during booking, stale-reservation recovery,
// and migration safety for PoolThru's existing production data. Run: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { STALE_PENDING_MS } from '../server/booking.js'
import * as loginStart from '../functions/api/auth/google/start.js'
import * as loginCallback from '../functions/api/auth/google/callback.js'
import * as me from '../functions/api/dashboard/me.js'
import * as hours from '../functions/api/dashboard/hours.js'
import * as customers from '../functions/api/admin/customers.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'

// Legacy setup fields; businesses without a self-serve signup are never asked to pay or do extra steps.
const legacy = (p) => (assert.equal(p.selfServe, false), assert.equal(p.billing, 'not_required'), { business: p.business, calendar: p.calendar, hours: p.hours, complete: p.complete })

const ORIGIN = 'https://getshowups.com'
const ADMIN = 'admin-token-'.padEnd(48, 'x')
const CLIENT_ID = 'cid.apps.googleusercontent.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy openid'
const RT = '1//poolthru-refresh'
const AT = 'ya29.poolthru-access'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CAL = 'https://www.googleapis.com/calendar/v3'
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()
const migration = (f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')

function d1(files = MIGRATIONS) {
  const sql = new DatabaseSync(':memory:')
  for (const f of files) sql.exec(migration(f))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => (db.fail?.(q) ? Promise.reject(new Error('D1 unavailable')) : sql.prepare(q).get(...args) ?? null),
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => (db.fail?.(q) ? Promise.reject(new Error('D1 unavailable')) : sql.prepare(q).run(...args)),
  })
  const db = {
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
  return db
}

// A request that never answers until the caller's timeout aborts it.
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))

let env, db, kv, events, google, origFetch, origError, logs, responses, deletes

async function poolthruRecord() {
  // Exactly the shape the production OAuth callback stores for PoolThru.
  return JSON.stringify({ customer: 'poolthru', googleSub: '1234', email: 'care@poolthru.example', scope: SCOPE, refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, RT), connectedAt: '2026-11-08T21:04:40.703Z' })
}

function seedBookable() {
  const now = Date.now()
  db.sql
    .prepare(`INSERT INTO customers (id, name, timezone, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at)
              VALUES ('poolthru', 'PoolThru', 'UTC', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)`)
    .run(now, now, now)
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('care@poolthru.example', 'poolthru', ?)").run(now)
}

beforeEach(async () => {
  db = d1()
  kv = new Map([['google:poolthru', await poolthruRecord()]])
  events = []
  deletes = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET-VALUE',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: ADMIN,
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    GOOGLE_TIMEOUT_MS: 40,
  }
  google = {
    refresh: () => [200, { access_token: AT, scope: SCOPE }],
    login: () => [200, { id_token: `h.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'care@poolthru.example', email_verified: true })).toString('base64url')}.s` }],
    freebusy: () => [200, { calendars: { primary: { busy: events.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) } } }],
    insert: (body) => {
      if (events.some((e) => e.id === body.id)) return [409, { error: { status: 'ALREADY_EXISTS' } }]
      events.push(body)
      return [200, { id: body.id }]
    },
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    let out
    if (u === TOKEN_URL) {
      const body = Object.fromEntries(new URLSearchParams(init.body))
      out = body.grant_type === 'refresh_token' ? google.refresh(body, init) : google.login(body, init)
    } else if (u === `${CAL}/freeBusy`) out = google.freebusy(JSON.parse(init.body), init)
    else if (u === `${CAL}/calendars/primary/events?sendUpdates=all`) out = google.insert(JSON.parse(init.body), init)
    else if (init.method === 'DELETE') {
      const id = decodeURIComponent(u.split('/events/')[1].split('?')[0])
      deletes.push(id)
      events = events.filter((e) => e.id !== id)
      out = [204, null]
    } else throw new Error(`unexpected ${u}`)
    if (out instanceof Promise) return out
    return new Response(out[1] === null ? null : JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const secret of [RT, AT, KEY, ADMIN, 'CLIENT-SECRET-VALUE']) assert.ok(!all.includes(secret), 'secret leaked')
})

async function call(mod, method, path, { ip = '203.0.113.7', origin = ORIGIN, body, headers = {}, params } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers }
  if (method === 'POST') h.Origin = origin
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    params,
  })
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, json: () => JSON.parse(text) }
}
const P = { customer: 'poolthru' }
const LEAD = { name: 'Riley Test', email: 'riley@example.net', phone: '555-010-0111', need: 'Pool opening' }
const info = (opts) => call(bookInfo, 'GET', '/api/book/poolthru', { params: P, ...opts })
const lead = (opts) => call(bookLead, 'POST', '/api/book/poolthru/lead', { params: P, body: LEAD, ...opts })
const appt = (body, opts) => call(bookAppt, 'POST', '/api/book/poolthru/appointment', { params: P, body, ...opts })
async function leadAndSlot() {
  const l = (await lead()).json()
  const slot = (await info()).json().slots[0]
  return { l, slot, body: { leadId: l.leadId, leadToken: l.leadToken, start: slot } }
}
const apptRows = () => db.sql.prepare('SELECT status FROM appointments').all().map((r) => r.status)

// ---------- rate limits ----------

test('rate limit: lead submissions per IP → 429 with Retry-After; other IPs unaffected', async () => {
  seedBookable()
  for (let i = 0; i < 10; i++) assert.equal((await lead()).status, 201)
  const limited = await lead()
  assert.equal(limited.status, 429)
  assert.equal(limited.json().error, 'rate_limited')
  assert.ok(Number(limited.res.headers.get('Retry-After')) > 0)
  assert.equal((await lead({ ip: '198.51.100.9' })).status, 201)
  const stored = db.sql.prepare('SELECT key FROM rate_limits').all().map((r) => r.key).join(' ')
  assert.ok(!stored.includes('203.0.113.7'), 'raw IP must not be stored')
})

test('rate limit: per-business lead cap stops floods from many IPs', async () => {
  seedBookable()
  for (let i = 0; i < 100; i++) assert.equal((await lead({ ip: `10.0.${Math.floor(i / 250)}.${i % 250}` })).status, 201)
  assert.equal((await lead({ ip: '10.9.9.9' })).status, 429)
})

test('rate limit: window resets; booking views and appointments are limited', async () => {
  seedBookable()
  for (let i = 0; i < 60; i++) await info()
  assert.equal((await info()).status, 429)
  db.sql.exec('UPDATE rate_limits SET win = win - 1') // simulate the next window
  assert.equal((await info()).status, 200)
  for (let i = 0; i < 15; i++) await appt({ leadId: 'x', leadToken: 'y', start: 'z' }, { ip: '192.0.2.1' })
  assert.equal((await appt({ leadId: 'x', leadToken: 'y', start: 'z' }, { ip: '192.0.2.1' })).status, 429)
})

test('rate limit: sign-in start and callback', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await call(loginStart, 'GET', '/api/auth/google/start')).status, 302)
  const blocked = await call(loginStart, 'GET', '/api/auth/google/start')
  assert.equal(blocked.status, 429)
  for (let i = 0; i < 30; i++) await call(loginCallback, 'GET', '/api/auth/google/callback?error=x')
  const cb = await call(loginCallback, 'GET', '/api/auth/google/callback?error=x')
  assert.equal(cb.res.headers.get('Location'), '/dashboard?login_error=rate_limited')
})

test('rate limit: fails open if its storage is unavailable', async () => {
  seedBookable()
  db.sql.exec('DROP TABLE rate_limits')
  assert.equal((await lead()).status, 201)
  assert.ok(logs.some((l) => l.includes('rate limit unavailable')))
})

// ---------- Google failures and timeouts during booking ----------

test('timeout: token refresh hangs → 503 calendar_unavailable, nothing reserved', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  google.refresh = (_b, init) => hang(init)
  const r = await appt(body)
  assert.equal(r.status, 503)
  assert.equal(r.json().error, 'calendar_unavailable')
  assert.deepEqual(apptRows(), [])
})

test('timeout: freeBusy hangs at booking time → 502, slot released, lead can retry', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  google.freebusy = (_b, init) => hang(init)
  assert.equal((await appt(body)).json().error, 'calendar_error')
  assert.deepEqual(apptRows(), [])
  assert.equal(events.length, 0)
  google.freebusy = () => [200, { calendars: { primary: { busy: [] } } }]
  assert.equal((await appt(body)).status, 201)
})

test('timeout: event creation times out once, retry succeeds → exactly one event', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  const real = google.insert
  let attempts = 0
  google.insert = (b, init) => (++attempts === 1 ? hang(init) : real(b))
  assert.equal((await appt(body)).status, 201)
  assert.equal(attempts, 2)
  assert.equal(events.length, 1)
  assert.deepEqual(apptRows(), ['booked'])
})

test('timeout: first attempt lands but the response is lost → retry sees 409, booking succeeds once', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  const real = google.insert
  let attempts = 0
  google.insert = (b, init) => {
    attempts++
    const result = real(b) // Google created the event…
    return attempts === 1 ? hang(init) : result // …but the first response never arrived
  }
  const r = await appt(body)
  assert.equal(r.status, 201)
  assert.equal(events.length, 1)
  assert.equal(db.sql.prepare('SELECT google_event_id FROM appointments').get().google_event_id, events[0].id)
})

test('timeout: event creation never answers → 502, possible orphan deleted, slot and lead released', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  google.insert = (b, init) => {
    events.push(b) // worst case: it was created at Google
    return hang(init)
  }
  const r = await appt(body)
  assert.equal(r.status, 502)
  assert.equal(r.json().error, 'booking_failed')
  assert.equal(events.length, 0, 'orphan event removed')
  assert.equal(deletes.length, 1)
  assert.deepEqual(apptRows(), [])
  assert.equal(db.sql.prepare('SELECT status FROM leads').get().status, 'new')
})

test('failure: Google 5xx then success → booked once; 4xx → no retry, released', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  const real = google.insert
  let attempts = 0
  google.insert = (b) => (++attempts === 1 ? [503, { error: { status: 'UNAVAILABLE' } }] : real(b))
  assert.equal((await appt(body)).status, 201)
  assert.equal(events.length, 1)

  const second = await leadAndSlot()
  attempts = 0
  google.insert = () => (attempts++, [403, { error: { status: 'PERMISSION_DENIED' } }])
  assert.equal((await appt(second.body)).status, 502)
  assert.equal(attempts, 1)
  assert.equal(deletes.length, 0)
})

test('failure: database error after the event is created → event deleted, slot released', async () => {
  seedBookable()
  const { body } = await leadAndSlot()
  db.fail = (q) => q.startsWith("UPDATE leads SET status = 'booked'")
  assert.equal((await appt(body)).status, 503)
  db.fail = null
  assert.equal(events.length, 0)
  assert.deepEqual(apptRows(), [])
})

test('recovery: an abandoned pending reservation frees its slot after the stale window', async () => {
  seedBookable()
  const { l, slot, body } = await leadAndSlot()
  const insertPending = (age) =>
    db.sql
      .prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?, 'poolthru', ?, ?, ?, 'pending', ?, ?)")
      .run(`stuck${age}`, l.leadId, Date.parse(slot), Date.parse(slot) + 3600_000, Date.now() - age, Date.now() - age)
  insertPending(30_000) // fresh: a booking may still be in flight
  assert.ok(!(await info()).json().slots.includes(slot))
  assert.equal((await appt(body)).json().error, 'slot_unavailable')
  db.sql.exec('DELETE FROM appointments')
  insertPending(STALE_PENDING_MS + 1000) // abandoned
  assert.ok((await info()).json().slots.includes(slot))
  assert.equal((await appt(body)).status, 201)
  assert.deepEqual(apptRows(), ['booked'])
})

// ---------- migrations preserve PoolThru ----------

test('migrations: 0002 is additive and idempotent over production state; PoolThru connection is reused', async () => {
  // Production today: only 0001 applied, PoolThru's used invite, encrypted connection in KV.
  db = d1(['0001_onboarding_invites.sql'])
  env.ONBOARDING_DB = db
  const now = Date.now()
  db.sql
    .prepare("INSERT INTO onboarding_invites (token_hash, customer, purpose, created_at, expires_at, claim_session, claimed_at, used_at) VALUES (?, 'poolthru', 'connect', ?, ?, 's', ?, ?)")
    .run(await sha256Hex('old-invite'), now - 1e6, now + 1e6, now - 9e5, now - 9e5)
  const kvBefore = kv.get('google:poolthru')
  const invitesBefore = JSON.stringify(db.sql.prepare('SELECT * FROM onboarding_invites').all())

  for (let i = 0; i < 2; i++) for (const f of MIGRATIONS.filter((x) => x !== '0001_onboarding_invites.sql')) db.sql.exec(migration(f))
  assert.equal(JSON.stringify(db.sql.prepare('SELECT * FROM onboarding_invites').all()), invitesBefore)
  for (const f of MIGRATIONS) assert.doesNotMatch(migration(f), /\b(DROP|DELETE|ALTER|UPDATE)\b/i, `${f} must be additive`)

  const linked = await call(customers, 'POST', '/api/admin/customers', {
    headers: { Authorization: `Bearer ${ADMIN}` },
    body: { customer: 'poolthru', name: 'PoolThru', timezone: 'UTC', users: ['care@poolthru.example'] },
  })
  assert.equal(linked.json().calendarConnected, true)

  // care@poolthru.example signs in, finishes hours, and a lead books with the pre-existing token.
  const start = await call(loginStart, 'GET', '/api/auth/google/start')
  const state = new URL(start.res.headers.get('Location')).searchParams.get('state')
  const cb = await call(loginCallback, 'GET', `/api/auth/google/callback?code=c&state=${state}`, { headers: { Cookie: start.res.headers.get('Set-Cookie').split(';')[0] } })
  const cookie = cb.res.headers.getSetCookie().find((c) => c.startsWith('__Host-gsu_session=')).split(';')[0]
  assert.deepEqual(legacy((await call(me, 'GET', '/api/dashboard/me', { headers: { Cookie: cookie } })).json().progress), { business: true, calendar: true, hours: false, complete: false })
  await call(hours, 'POST', '/api/dashboard/hours', { headers: { Cookie: cookie }, body: { workdays: [0, 1, 2, 3, 4, 5, 6], dayStart: '00:00', dayEnd: '23:00', slotMinutes: 60 } })
  const { body } = await leadAndSlot()
  assert.equal((await appt(body)).status, 201)
  assert.equal(events.length, 1)
  assert.equal(kv.get('google:poolthru'), kvBefore, 'stored connection untouched')
})
