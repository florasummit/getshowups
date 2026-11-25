// Booking experience (2026-11-25): one service catalog (server/services.js) with lengths, questions, hide and request
// flow; times for the chosen length through the same slot rules (closed dates, notice, day end); the booking keeps the
// length server-side and refuses overlaps; funnel events are codes only. Real handlers + migrations on node:sqlite,
// mocked Google. Nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { createSalesBusiness } from '../server/sales.js'
import { computeSlots, isOfferedSlot, zonedToUtc } from '../server/calendar.js'
import { bookingServices, offeredServices, readServices, resolveChoice, validateServices, needText } from '../server/services.js'
import { bookingFunnel, validateStage } from '../server/booking-funnel.js'
import { businessFacts } from '../server/followups/engine.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as bookEvent from '../functions/api/book/[customer]/event.js'
import * as bookArea from '../functions/api/book/[customer]/area.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const CAL = 'https://www.googleapis.com/calendar/v3'
let env, db, kv, events, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => {
      if (a.some((x) => x === undefined)) throw new TypeError('undefined bound') // like D1
      return stmt(q, a)
    },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        const out = []
        for (const s of list) out.push({ meta: { changes: sql.prepare(s.q).run(...s.args).changes } })
        sql.exec('COMMIT')
        return out
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

const POOL = [
  { id: 'sv_weekly01', name: 'Weekly pool cleaning', price: '$180 per month', slots: 1, booking: 'book' },
  { id: 'sv_green001', name: 'Green pool cleanup', price: 'From $325', slots: 3, booking: 'book', question: { label: 'How long has it been green?', required: false } },
  { id: 'sv_repair01', name: 'Equipment repair', price: '$95 diagnostic visit', slots: 1, booking: 'book', question: { label: 'Which equipment?', required: true } },
  { id: 'sv_quote001', name: 'Pool renovation', price: 'Quoted on site', slots: 1, booking: 'request' },
  { id: 'sv_close001', name: 'Pool closing', price: '$225', slots: 2, hidden: true },
  { id: 'sv_plan0001', name: 'Annual plan', price: '$2,000 per year', booking: 'off' },
]

beforeEach(async () => {
  db = d1()
  kv = new Map()
  events = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
  }
  // A bookable business (the sales record is the simplest fully set-up one), with a pool-service catalog.
  assert.equal((await createSalesBusiness(env, { email: 'staff@getshowups.com' }, 'sales')).ok, true)
  db.sql.prepare('UPDATE business_profiles SET services = ? WHERE customer = ?').run(JSON.stringify(POOL), 'getshowups')
  db.sql.prepare("INSERT OR REPLACE INTO booking_options (customer, allow_other, updated_at) VALUES ('getshowups', 1, 1)").run()
  kv.set('google:getshowups', JSON.stringify({ customer: 'getshowups', email: 'owner@pools.example', scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: SCOPE }]
    else if (u === `${CAL}/freeBusy`) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u.startsWith(`${CAL}/calendars/primary/events`)) {
      const body = JSON.parse(init.body)
      events.push(body)
      out = [200, { id: body.id }]
    } else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function call(mod, method, path, { body, params = { customer: 'getshowups' }, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
const person = { name: 'Dana Harbor', email: 'dana@harbor.example', phone: '843-555-0142' }

test('catalog: old {name, price} rows stay valid; ids survive edits and re-typed lists; a partial form keeps the other fields', () => {
  const legacy = readServices([{ name: 'Weekly pool cleaning', price: '$180' }, { name: 'Repair', price: '' }])
  assert.deepEqual(legacy.map(({ name, price, slots, hidden, booking, question }) => ({ name, price, slots, hidden, booking, question })), [
    { name: 'Weekly pool cleaning', price: '$180', slots: 1, hidden: false, booking: 'book', question: null },
    { name: 'Repair', price: '', slots: 1, hidden: false, booking: 'book', question: null },
  ])
  assert.equal(readServices([{ name: 'Repair' }])[0].id, readServices([{ name: 'Repair' }])[0].id, 'stable id for a stored row without one')
  const [e1, first] = validateServices([{ name: 'Weekly pool cleaning', price: '$180' }], [])
  assert.deepEqual(e1, [])
  const id = first[0].id
  // The setup step re-sends only { name, price }: the id, length and question stay.
  const stored = [{ ...first[0], slots: 2, question: { label: 'Gate code?', required: false } }]
  const [, again] = validateServices([{ name: 'Weekly pool cleaning', price: '$190' }], stored)
  assert.equal(again[0].id, id)
  assert.equal(again[0].price, '$190')
  assert.equal(again[0].slots, 2)
  assert.equal(again[0].question.label, 'Gate code?')
  assert.deepEqual(validateServices([{ name: 'Same', price: '' }, { name: 'X', slots: 9 }])[0], ['services'], 'length beyond 4 slots refused')
  assert.deepEqual(validateServices([{ name: 'Guaranteed best pool care' }])[0], ['services:unapproved_claim'])
})

test('booking page offers visible bookable services only; receptionist and assistant drop hidden ones but keep "off" (answerable) ones', async () => {
  const page = bookingServices(POOL, 20).map((s) => s.name)
  assert.deepEqual(page, ['Weekly pool cleaning', 'Green pool cleanup', 'Equipment repair', 'Pool renovation'])
  assert.equal(bookingServices(POOL, 20)[1].minutes, 60, '3 slots of 20 minutes')
  assert.deepEqual(offeredServices(POOL).map((s) => s.name), ['Weekly pool cleaning', 'Green pool cleanup', 'Equipment repair', 'Pool renovation', 'Annual plan'])
  const facts = await businessFacts(env, customerFromRow(await getCustomer(db, 'getshowups')))
  assert.ok(!facts.services.some((s) => s.name === 'Pool closing'), 'hidden: the receptionist never offers it')
  assert.ok(facts.services.some((s) => s.name === 'Annual plan'))
})

test('choice rules: Other only when allowed; a removed service is refused; a required answer is required; old pages without serviceId still work', () => {
  const svc = bookingServices(POOL, 20)
  assert.deepEqual(resolveChoice({ serviceId: '' }, svc, false), ['invalid_service'])
  assert.deepEqual(resolveChoice({ serviceId: 'sv_gone0001' }, svc, true), ['service_unavailable'])
  assert.deepEqual(resolveChoice({ serviceId: 'sv_close001' }, svc, true), ['service_unavailable'], 'hidden = not offered')
  assert.deepEqual(resolveChoice({ serviceId: 'sv_repair01' }, svc, true), ['invalid_answer'])
  assert.equal(resolveChoice({}, svc, false)[1].service, null, 'a page from before services existed')
  const [, c] = resolveChoice({ serviceId: 'sv_repair01', answer: 'Pump hums' }, svc, true)
  assert.equal(needText(c, ''), 'Equipment repair: Pump hums')
})

test('slots for longer services: same grid, whole length inside the day, closed dates and minimum notice apply', () => {
  const rules = { timezone: 'America/New_York', slotMinutes: 60, dayStart: '09:00', dayEnd: '17:00', workdays: [1, 2, 3, 4, 5], closedDates: ['2026-12-01'], minNoticeMinutes: 120 }
  const now = zonedToUtc(2026, 11, 30, 8, 30, 'America/New_York') // Monday 08:30
  const at = (d, h) => zonedToUtc(2026, 12, d, h, 0, 'America/New_York')
  const one = computeSlots({ busy: [], rules, now, days: 3, span: 1 }).slots.map((s) => s.start)
  const three = computeSlots({ busy: [], rules, now, days: 3, span: 3 }).slots
  // Monday: notice → first start 10:30 → 11:00 on the grid; span 3 must end by 17:00 → last start 14:00.
  const monday = three.filter((s) => s.start < at(1, 0)).map((s) => s.start)
  assert.equal(monday[0], zonedToUtc(2026, 11, 30, 11, 0, 'America/New_York'))
  assert.equal(monday.at(-1), zonedToUtc(2026, 11, 30, 14, 0, 'America/New_York'), 'a visit that would run past 17:00 is never offered')
  assert.ok(one.includes(zonedToUtc(2026, 11, 30, 16, 0, 'America/New_York')), 'a 1-slot service still gets 16:00')
  assert.ok(!three.some((s) => s.start >= at(1, 0) && s.start < at(2, 0)), 'closed date: nothing on Tuesday')
  assert.ok(three.every((s) => s.end - s.start === 3 * 3600_000))
  // Busy 12:00–13:00 Wednesday blocks every 3-hour start that overlaps it (10:00, 11:00, 12:00).
  const busy = [{ start: at(2, 12), end: at(2, 13) }]
  const wed = computeSlots({ busy, rules, now, days: 3, span: 3 }).slots.filter((s) => s.start >= at(2, 0)).map((s) => s.start)
  assert.deepEqual(wed, [at(2, 9), at(2, 13), at(2, 14)])
  assert.equal(isOfferedSlot({ rules, now, days: 3, start: zonedToUtc(2026, 11, 30, 15, 0, 'America/New_York'), span: 3 }), false)
})

test('end to end: the page lists services, gives times for the chosen length, books that length (server-side), keeps a snapshot, and refuses an overlapping booking', async () => {
  const info = (await call(bookInfo, 'GET', '/api/book/getshowups')).json()
  assert.deepEqual(info.services.map((s) => s.id), ['sv_weekly01', 'sv_green001', 'sv_repair01', 'sv_quote001'])
  assert.equal(info.allowOther, true)
  assert.deepEqual(info.brand, { product: true, logo: null, accent: null })
  const long = (await call(bookInfo, 'GET', '/api/book/getshowups?service=sv_green001')).json()
  assert.equal(long.minutes, 60)
  const slot = long.slots.find((s) => Date.parse(s) > Date.now() + 3600_000)
  assert.ok(slot, JSON.stringify({ status: long.status, n: long.slots.length }))
  // The browser can't pick the length: it sends only the service id.
  const lead = await call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { ...person, serviceId: 'sv_green001', answer: 'About two weeks', minutes: 5 } })
  assert.equal(lead.status, 201, lead.text)
  const { leadId, leadToken, flow } = lead.json()
  assert.equal(flow, 'book')
  assert.equal(db.sql.prepare('SELECT need FROM leads WHERE id = ?').get(leadId).need, 'Green pool cleanup: About two weeks')
  assert.deepEqual({ ...db.sql.prepare('SELECT service_id, service_name, minutes, flow FROM lead_services WHERE lead_id = ?').get(leadId) }, { service_id: 'sv_green001', service_name: 'Green pool cleanup', minutes: 60, flow: 'book' })
  const appt = await call(bookAppt, 'POST', '/api/book/getshowups/appointment', { body: { leadId, leadToken, start: slot } })
  assert.equal(appt.status, 201, appt.text)
  assert.equal(Date.parse(events[0].end.dateTime) - Date.parse(events[0].start.dateTime), 60 * 60_000, 'the event takes the service length')
  // A second visitor picks a one-slot service at a time inside that hour (not the same start): refused.
  const other = await call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { ...person, email: 'sam@pools.example', serviceId: 'sv_weekly01' } })
  const inside = Date.parse(slot) + 20 * 60_000
  const clash = await call(bookAppt, 'POST', '/api/book/getshowups/appointment', { body: { leadId: other.json().leadId, leadToken: other.json().leadToken, start: new Date(inside).toISOString() } })
  assert.equal(clash.status, 409)
  assert.equal(clash.json().error, 'slot_unavailable')
  assert.equal(events.length, 1, 'no second calendar event')
  // Renaming or removing the service later never changes what the request was for.
  db.sql.prepare('UPDATE business_profiles SET services = ? WHERE customer = ?').run(JSON.stringify(POOL.filter((s) => s.id !== 'sv_green001')), 'getshowups')
  assert.equal(db.sql.prepare('SELECT service_name FROM lead_services WHERE lead_id = ?').get(leadId).service_name, 'Green pool cleanup')
})

test('request flow: details only, no "pick a time" follow-ups; a service hidden since the page loaded is refused cleanly', async () => {
  const r = await call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { ...person, serviceId: 'sv_quote001' } })
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json().flow, 'request')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM messages WHERE lead_id = ? AND kind LIKE 'lead_followup%'").get(r.json().leadId).n, 0)
  const gone = await call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { ...person, serviceId: 'sv_close001' } })
  assert.equal(gone.status, 400)
  assert.equal(gone.json().error, 'service_unavailable')
})

test('funnel events: same-origin only, codes only, one row per visit and stage; owner counts with null rates when there were no visits', async () => {
  assert.equal((await bookingFunnel(db, 'getshowups', 0)).conversion, null)
  const visit = 'abcdefghijkl12'
  const send = (body, origin) => call(bookEvent, 'POST', '/api/book/getshowups/event', { body, origin })
  assert.equal((await send({ stage: 'view', visit, device: 'mobile', source: 'google' }, 'https://evil.example')).status, 403)
  assert.equal((await send({ stage: 'nope', visit })).status, 400)
  for (const stage of ['view', 'view', 'service', 'time', 'details', 'booked']) assert.equal((await send({ stage, visit, device: 'mobile', source: 'google', service: 'sv_weekly01', name: 'Dana', email: 'dana@x.example' })).status, 204)
  await send({ stage: 'view', visit: 'zzzzzzzzzzzz99', device: 'desktop' })
  const rows = db.sql.prepare("SELECT id, props FROM events WHERE type = 'booking_stage'").all()
  assert.equal(rows.length, 6, 'the repeated view counted once')
  assert.ok(rows.every((r) => !/dana|@|name|email/i.test(r.props)), 'nothing personal stored')
  const f = await bookingFunnel(db, 'getshowups', 0)
  assert.equal(f.stages.view, 2)
  assert.equal(f.stages.booked, 1)
  assert.equal(f.conversion, 50)
  assert.deepEqual(f.device.mobile, { view: 1, booked: 1, conversion: 100 })
  assert.equal(f.sources.find((s) => s.source === 'google').booked, 1)
  assert.deepEqual(validateStage({ stage: 'view', visit, source: '<script>' })[1].source, 'direct')
})

test('area check before times: a listed ZIP is in; a real unlisted ZIP or an unknown one goes to the owner; nothing stored', async () => {
  db.sql.prepare("UPDATE customers SET service_zips = ? WHERE id = 'getshowups'").run('29464,29403')
  const area = async (zip) => (await call(bookArea, 'GET', `/api/book/getshowups/area?zip=${zip}`)).json().area
  assert.equal(await area('29464'), 'in')
  assert.equal(await area('29407'), 'outside')
  assert.equal(await area('00000'), 'unknown')
  assert.equal(await area('2940'), 'invalid')
  assert.equal(db.sql.prepare('SELECT count(*) n FROM leads').get().n, 0)
  assert.equal((await call(bookInfo, 'GET', '/api/book/getshowups')).json().areaCheck, true)
})
