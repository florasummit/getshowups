// Appointment modes: at_business (customer comes to the business; existing behavior) and at_customer
// (business visits the customer). Covers mode settings, service address capture + privacy, calendar
// event location, mode-specific messages and confirm page, the visit/work outcome model, reported job
// value (association, not attribution), and platform metrics. Real handlers + migrations on
// node:sqlite (D1 stand-in), Map KV, mocked Google and Resend. Run: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { linkToken } from '../server/links.js'
import { processDueMessages } from '../server/messages.js'
import { validateAddress } from '../server/booking.js'
import * as me from '../functions/api/dashboard/me.js'
import * as business from '../functions/api/dashboard/business.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as outcome from '../functions/api/dashboard/outcome.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as confirm from '../functions/api/appointment/confirm.js'
import * as pOverview from '../functions/api/platform/overview.js'
import * as pCustomer from '../functions/api/platform/customer.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const CAL = 'https://www.googleapis.com/calendar/v3'
const HOUR = 3600_000
const ADDRESS = { street: '12 Ocean Dr', unit: 'Apt 4', city: 'Charleston', state: 'sc', zip: '29403' }
const STREET = '12 Ocean Dr'

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

let env, db, kv, events, emails, logs, responses, origFetch, origError

function seed(id, owner, { mode, zips = '' } = {}) {
  const now = Date.now()
  db.sql
    .prepare(
      "INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)",
    )
    .run(id, `${id} Co`, zips, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  if (mode) db.sql.prepare('INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES (?, ?, ?)').run(id, mode, now)
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  events = []
  emails = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
    PLATFORM_ADMIN_EMAILS: 'ops@getshowups.com',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'GetShowUps <hello@getshowups.com>',
    MESSAGE_TEST_RECIPIENTS: 'lead@example.net',
  }
  seed('salon', 'owner@salon.example') // no service_settings row → at_business default
  seed('pools', 'owner@pools.example', { mode: 'at_customer', zips: '29403' })
  for (const id of ['salon', 'pools']) {
    kv.set(`google:${id}`, JSON.stringify({ customer: id, email: `cal@${id}.example`, scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: SCOPE }]
    else if (u === `${CAL}/freeBusy`) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u === `${CAL}/calendars/primary/events?sendUpdates=all`) {
      const body = JSON.parse(init.body)
      events.push(body)
      out = [200, { id: body.id }]
    } else if (u === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(init.body))
      out = [200, { id: `re_${emails.length}` }]
    } else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  assert.ok(!logs.join('\n').includes(STREET), 'service address must not be logged')
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, params } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST') headers.Origin = ORIGIN
  if (body !== undefined && typeof body !== 'string') headers['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
    env,
    params,
  })
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, text, json: () => JSON.parse(text) }
}
const LEAD = { name: 'Jamie Rivera', email: 'lead@example.net', phone: '555-010-0199', need: 'Weekly pool cleaning', zip: '29403' }
const info = (id) => call(bookInfo, 'GET', `/api/book/${id}`, { params: { customer: id } })
const lead = (id, body) => call(bookLead, 'POST', `/api/book/${id}/lead`, { params: { customer: id }, body })
async function bookOne(id, extra = {}) {
  const l = await lead(id, { ...LEAD, ...extra })
  assert.equal(l.status, 201, l.text)
  const { leadId, leadToken } = l.json()
  const slot = (await info(id)).json().slots[0]
  const r = await call(bookAppt, 'POST', `/api/book/${id}/appointment`, { params: { customer: id }, body: { leadId, leadToken, start: slot } })
  assert.equal(r.status, 201, r.text)
  return db.sql.prepare('SELECT id FROM appointments WHERE lead_id = ?').get(leadId).id
}
const makePast = (apptId) => db.sql.prepare('UPDATE appointments SET start_at = start_at - ?, end_at = end_at - ?, created_at = created_at - ? WHERE id = ?').run(3 * 864e5, 3 * 864e5, 1000, apptId)

// ---------- mode settings ----------

test('mode: existing businesses default to at_business; owners can switch; invalid values rejected', async () => {
  const cookie = await session('owner@salon.example')
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).json().customer.appointmentMode, 'at_business')
  assert.equal((await info('salon')).json().appointmentMode, 'at_business')
  const bad = await call(business, 'POST', '/api/dashboard/business', { cookie, body: { name: 'Salon', timezone: 'UTC', appointmentMode: 'drive_by' } })
  assert.equal(bad.json().error, 'invalid_mode')
  await call(business, 'POST', '/api/dashboard/business', { cookie, body: { name: 'Salon', timezone: 'UTC', appointmentMode: 'at_customer' } })
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).json().customer.appointmentMode, 'at_customer')
  // Saving without a mode keeps the current one (older clients cannot silently reset it).
  await call(business, 'POST', '/api/dashboard/business', { cookie, body: { name: 'Salon Renamed', timezone: 'UTC' } })
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie })).json().customer.appointmentMode, 'at_customer')
})

test('mode: new businesses can choose at_customer at creation', async () => {
  const cookie = await session('new@pooltech.example')
  const r = await call(business, 'POST', '/api/dashboard/business', { cookie, body: { name: 'Pool Tech', timezone: 'UTC', appointmentMode: 'at_customer' } })
  assert.equal(r.status, 201)
  assert.equal(db.sql.prepare('SELECT appointment_mode FROM service_settings WHERE customer = ?').get(r.json().id).appointment_mode, 'at_customer')
})

// ---------- address capture ----------

test('address: validated, US only, normalized', () => {
  assert.deepEqual(validateAddress(ADDRESS), [null, { street: '12 Ocean Dr', unit: 'Apt 4', city: 'Charleston', state: 'SC', zip: '29403' }])
  for (const [patch, error] of [
    [{ street: 'Ocean Dr' }, 'invalid_street'],
    [{ street: '12' }, 'invalid_street'],
    [{ city: '9' }, 'invalid_city'],
    [{ state: 'XX' }, 'invalid_state'],
    [{ zip: '2940' }, 'invalid_zip'],
    [{ zip: '29403-12' }, 'invalid_zip'],
  ]) {
    assert.equal(validateAddress({ ...ADDRESS, ...patch })[0], error, JSON.stringify(patch))
  }
  assert.equal(validateAddress({ ...ADDRESS, zip: '29403-1234' })[0], null)
})

test('at_customer: lead requires a service address; its ZIP decides service area', async () => {
  assert.equal((await lead('pools', LEAD)).json().error, 'invalid_street')
  assert.equal((await lead('pools', { ...LEAD, address: { ...ADDRESS, state: 'ZZ' } })).json().error, 'invalid_state')
  const outside = (await lead('pools', { ...LEAD, address: { ...ADDRESS, zip: '90210' } })).json()
  assert.equal(outside.qualified, false)
  const ok = (await lead('pools', { ...LEAD, zip: '00000', address: ADDRESS })).json()
  assert.equal(ok.qualified, true)
  const row = db.sql.prepare('SELECT street, unit, city, state, zip FROM lead_addresses WHERE lead_id = ?').get(ok.leadId)
  assert.deepEqual({ ...row }, { street: '12 Ocean Dr', unit: 'Apt 4', city: 'Charleston', state: 'SC', zip: '29403' })
  assert.equal(db.sql.prepare('SELECT zip FROM leads WHERE id = ?').get(ok.leadId).zip, '29403')
  assert.equal((await info('pools')).json().askZip, false) // the address carries the ZIP
})

test('at_business regression: no address asked, stored, or required', async () => {
  const r = await lead('salon', { ...LEAD, address: ADDRESS })
  assert.equal(r.status, 201)
  assert.equal(db.sql.prepare('SELECT count(*) c FROM lead_addresses').get().c, 0)
})

// ---------- calendar event ----------

test('calendar event: at_customer carries the service address as location; at_business has none', async () => {
  await bookOne('pools', { address: ADDRESS })
  await bookOne('salon')
  const [visit, salon] = events
  assert.equal(visit.location, '12 Ocean Dr, Apt 4, Charleston, SC 29403')
  assert.match(visit.description, /Service address: 12 Ocean Dr, Apt 4, Charleston, SC 29403/)
  assert.equal(salon.location, undefined)
  assert.doesNotMatch(salon.description, /Service address/)
})

// ---------- messages & confirm page ----------

test('messages: at_business wording unchanged; at_customer talks about a visit and access', async () => {
  await bookOne('salon')
  await bookOne('pools', { address: ADDRESS })
  const result = await processDueMessages(env, Date.now() + 1000)
  assert.equal(result.sent, 2)
  const salon = emails.find((e) => e.subject.startsWith("You're booked with salon Co"))
  assert.match(salon.text, /Please confirm you'll be there:/)
  const pools = emails.find((e) => e.subject.startsWith('pools Co visit booked'))
  assert.match(pools.text, /pools Co is scheduled to visit at 12 Ocean Dr on /)
  assert.match(pools.text, /can access the property/)
  assert.doesNotMatch(pools.text, /you'll be there/)
})

test('messages: reminders and rebook use visit wording for at_customer', async () => {
  const id = await bookOne('pools', { address: ADDRESS })
  const start = db.sql.prepare('SELECT start_at FROM appointments WHERE id = ?').get(id).start_at
  db.sql.prepare("INSERT INTO messages (id, customer, lead_id, appointment_id, kind, channel, send_at, status, created_at, updated_at) SELECT 'r2', customer, lead_id, id, 'reminder_2h', 'email', ?, 'scheduled', 1, 1 FROM appointments WHERE id = ?").run(start - 2 * HOUR, id)
  await processDueMessages(env, start - 2 * HOUR + 1000)
  const reminder = emails.find((e) => e.subject.startsWith('Reminder: pools Co visit today'))
  assert.match(reminder.text, /scheduled to visit at 12 Ocean Dr today at/)
  const cookie = await session('owner@pools.example')
  makePast(id)
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie, body: { id, outcome: 'no_show' } })
  await processDueMessages(env, Date.now() + HOUR)
  const rebook = emails.find((e) => e.subject.startsWith("Your pools Co visit didn't happen"))
  assert.match(rebook.text, /wasn't able to complete your scheduled visit at 12 Ocean Dr/)
})

test('confirm page: visit wording for at_customer; unchanged for at_business', async () => {
  const visitId = await bookOne('pools', { address: ADDRESS })
  const salonId = await bookOne('salon')
  const page = async (a) => (await call(confirm, 'GET', `/api/appointment/confirm?a=${a}&k=${await linkToken(env, 'confirm', a)}`)).text
  const v = await page(visitId)
  assert.match(v, /Confirm your visit/)
  assert.match(v, /Confirm the visit/)
  assert.doesNotMatch(v, /I’ll be there/)
  assert.match(await page(salonId), /Confirm I’ll be there/)
})

// ---------- outcomes: visit occurred vs work completed; reported value ----------

test('outcomes: arrival is not completion; work and value are separate optional facts', async () => {
  const cookie = await session('owner@pools.example')
  const ids = [await bookOne('pools', { address: ADDRESS }), await bookOne('pools', { address: ADDRESS, email: 'b@example.net' }), await bookOne('pools', { address: ADDRESS, email: 'c@example.net' })]
  ids.forEach(makePast)
  const post = (body) => call(outcome, 'POST', '/api/dashboard/outcome', { cookie, body })
  assert.equal((await post({ id: ids[0], outcome: 'showed', work: 'completed', valueCents: 25000 })).status, 200)
  assert.equal((await post({ id: ids[1], outcome: 'showed', work: 'not_completed' })).status, 200)
  assert.equal((await post({ id: ids[2], outcome: 'showed' })).status, 200) // visited, work not recorded yet

  const stats = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json().stats
  assert.equal(stats.showed, 3)
  assert.equal(stats.completed, 1)
  assert.equal(stats.notCompleted, 1)
  assert.equal(stats.completionRate, 50) // of visits with recorded work, not of all arrivals
  assert.equal(stats.reportedValueCents, 25000)
  assert.equal(stats.valuedJobs, 1)

  const recent = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json().recent
  const done = recent.find((r) => r.id === ids[0])
  assert.deepEqual([done.work, done.valueCents, done.address], ['completed', 25000, '12 Ocean Dr, Apt 4, Charleston, SC 29403'])
})

test('outcomes: validation and corrections', async () => {
  const cookie = await session('owner@pools.example')
  const id = await bookOne('pools', { address: ADDRESS })
  makePast(id)
  const post = (body) => call(outcome, 'POST', '/api/dashboard/outcome', { cookie, body })
  assert.equal((await post({ id, outcome: 'showed', work: 'half' })).json().error, 'invalid_work')
  assert.equal((await post({ id, outcome: 'showed', valueCents: -1 })).json().error, 'invalid_value')
  assert.equal((await post({ id, outcome: 'showed', valueCents: 12.5 })).json().error, 'invalid_value')
  assert.equal((await post({ id, outcome: 'no_show', work: 'completed' })).status, 400)
  await post({ id, outcome: 'showed', work: 'completed', valueCents: 9900 })
  assert.equal(db.sql.prepare('SELECT count(*) c FROM appointment_outcomes').get().c, 1)
  await post({ id, outcome: 'no_show' }) // correction: the visit didn't happen → no work, no value
  assert.equal(db.sql.prepare('SELECT count(*) c FROM appointment_outcomes').get().c, 0)
  const other = await session('owner@salon.example')
  assert.equal((await call(outcome, 'POST', '/api/dashboard/outcome', { cookie: other, body: { id, outcome: 'showed', work: 'completed' } })).status, 404)
})

test('at_business regression: showed/no-show and show rate behave as before', async () => {
  const cookie = await session('owner@salon.example')
  const [a, b] = [await bookOne('salon'), await bookOne('salon', { email: 'b@example.net' })]
  makePast(a)
  makePast(b)
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie, body: { id: a, outcome: 'showed' } })
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie, body: { id: b, outcome: 'no_show' } })
  const s = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie })).json().stats
  assert.deepEqual([s.showed, s.noShow, s.showRate, s.completed, s.completionRate, s.reportedValueCents], [1, 1, 50, 0, null, null])
})

// ---------- privacy & platform metrics ----------

test('privacy: service addresses never reach platform admin views or analytics events', async () => {
  const id = await bookOne('pools', { address: ADDRESS })
  makePast(id)
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie: await session('owner@pools.example'), body: { id, outcome: 'showed', work: 'completed', valueCents: 100 } })
  const admin = await session('ops@getshowups.com')
  for (const r of [await call(pOverview, 'GET', '/api/platform/overview', { cookie: admin }), await call(pCustomer, 'GET', '/api/platform/customer?id=pools', { cookie: admin })]) {
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('Ocean') && !r.text.includes('Charleston'), 'admin view leaked address')
  }
  assert.ok(!JSON.stringify(db.sql.prepare('SELECT props FROM events').all()).includes('Ocean'))
  // Another business's dashboard never sees it either.
  const salonView = await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await session('owner@salon.example') })
  assert.ok(!salonView.text.includes('Ocean'))
})

test('platform metrics: show-up for at_business, visit and completion for at_customer, value without attribution', async () => {
  const salonCookie = await session('owner@salon.example')
  const poolsCookie = await session('owner@pools.example')
  const s = await bookOne('salon')
  const p1 = await bookOne('pools', { address: ADDRESS })
  const p2 = await bookOne('pools', { address: ADDRESS, email: 'b@example.net' })
  ;[s, p1, p2].forEach(makePast)
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie: salonCookie, body: { id: s, outcome: 'no_show' } })
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie: poolsCookie, body: { id: p1, outcome: 'showed', work: 'completed', valueCents: 30000 } })
  await call(outcome, 'POST', '/api/dashboard/outcome', { cookie: poolsCookie, body: { id: p2, outcome: 'no_show' } })
  const m = (await call(pOverview, 'GET', '/api/platform/overview', { cookie: await session('ops@getshowups.com') })).json().metrics
  assert.equal(m.showUpRate30, 0) // the salon's only appointment was a no-show; pool visits don't count here
  assert.equal(m.visitRate30, 50)
  assert.equal(m.completionRate30, 100)
  assert.equal(m.reportedBookingValue30Cents, 30000)
  assert.equal(m.incrementalRevenue, null)
})
