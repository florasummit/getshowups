// Business details (migration 0045; docs/quality/USABILITY_FINDINGS.md SET-03, BOOK-08): booking hours per day and the
// business's own address. One helper (server/day-hours.js) for every reader of hours: slots, the receptionist's
// knowledge and "within hours", the assistant's text, follow-ups, the website. The address is public ONLY when the owner
// shows it AND customers come to the business. Everything fail-soft before 0045 (exactly today's behaviour).
// Real handlers + migrations on node:sqlite, mocked Google. Nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { activeDayHours, hoursFor, hoursGroups, parseDayHours, validateDayHours } from '../server/day-hours.js'
import { computeSlots, isOfferedSlot, zonedToUtc } from '../server/calendar.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer, validateHours } from '../server/customers.js'
import { getBusinessAddress, publicAddress, validateBusinessAddress } from '../server/business-address.js'
import { withinHours } from '../server/receptionist/routing.js'
import { knowledgeFor } from '../server/receptionist/knowledge.js'
import { businessFacts } from '../server/followups/engine.js'
import { hoursText as operatorHours } from '../server/operator-tools.js'
import { hoursText as siteHours } from '../server/site-render-v2.js'
import { ERASED_TABLES } from '../server/deletion.js'
import { businessExport } from '../server/business-export.js'
import * as hoursRoute from '../functions/api/dashboard/hours.js'
import * as addressRoute from '../functions/api/dashboard/address.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const TOKEN = 'businessDetailsSessionTokenForTests000000001'.slice(0, 43)
const TZ = 'America/New_York'
let env, db, kv, origFetch

function d1({ skip = null } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (f !== skip) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
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

async function setup(opts) {
  db = d1(opts)
  kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
  }
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, slot_minutes, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('tide', 'Tide Pools', ?, 60, '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(TZ, now, now, now)
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@tide.example', 'tide', ?)").run(now)
  db.sql.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, 'owner@tide.example', ?, ?)").run(await sha256Hex(TOKEN), now, now + 86_400_000)
  kv.set('google:tide', JSON.stringify({ customer: 'tide', email: 'owner@tide.example', scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
}
beforeEach(async () => {
  await setup()
  origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.at', scope: SCOPE }))
    if (u.endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }))
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function call(mod, method, path, body) {
  const headers = { Cookie: `__Host-gsu_session=${TOKEN}`, 'CF-Connecting-IP': '203.0.113.45', ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params: { customer: 'tide' }, waitUntil: () => {} })
  return { status: res.status, body: await res.json() }
}
const customer = async () => customerFromRow(await getCustomer(db, 'tide'))
const HOURS = { workdays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', slotMinutes: 60 }
const FRIDAY = { 5: { start: '09:00', end: '16:00' } }

// ---------- the helper ----------

test('SET-03 helper: default range, a day of its own, a closed day; no override = one group exactly as before', () => {
  const plain = { ...HOURS }
  assert.deepEqual(hoursFor(plain, 1), { start: '09:00', end: '17:00' })
  assert.equal(hoursFor(plain, 0), null, 'Sunday is not a booking day')
  assert.deepEqual(hoursGroups(plain), [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }])
  const own = { ...HOURS, dayHours: FRIDAY }
  assert.deepEqual(hoursFor(own, 5), { start: '09:00', end: '16:00' })
  assert.deepEqual(hoursFor(own, 4), { start: '09:00', end: '17:00' })
  assert.deepEqual(hoursGroups(own), [{ days: [1, 2, 3, 4], start: '09:00', end: '17:00' }, { days: [5], start: '09:00', end: '16:00' }])
  // An override for a day that is not a booking day never opens it.
  assert.equal(hoursFor({ ...HOURS, dayHours: { 6: { start: '10:00', end: '12:00' } } }, 6), null)
  assert.deepEqual(activeDayHours({ ...HOURS, dayHours: { 6: { start: '10:00', end: '12:00' }, 2: { start: '09:00', end: '17:00' }, ...FRIDAY } }), FRIDAY, 'closed days and same-as-default dropped')
  // Unreadable stored values read as no override.
  for (const bad of ['{', '[]', '{"7":{"start":"09:00","end":"10:00"}}', '{"5":{"start":"16:00","end":"09:00"}}', '{"5":{"start":"9","end":"10"}}', null, 42]) assert.deepEqual(parseDayHours(bad), {}, String(bad))
})

test('SET-03 validation: start before end, an appointment fits, only booking days kept, equal-to-default dropped', () => {
  assert.deepEqual(validateDayHours(undefined, HOURS), [null, {}])
  assert.deepEqual(validateDayHours(FRIDAY, HOURS), [null, FRIDAY])
  assert.deepEqual(validateDayHours({ 5: { start: '16:00', end: '09:00' } }, HOURS), ['invalid_day_hours', null, 5])
  assert.deepEqual(validateDayHours({ 5: { start: '09:00', end: '09:30' } }, HOURS), ['day_too_short', null, 5], 'a 60-minute appointment does not fit')
  assert.deepEqual(validateDayHours({ 5: { start: '9am', end: '16:00' } }, HOURS)[0], 'invalid_day_hours')
  assert.deepEqual(validateDayHours({ 9: FRIDAY[5] }, HOURS)[0], 'invalid_day_hours')
  assert.deepEqual(validateDayHours([], HOURS)[0], 'invalid_day_hours')
  assert.deepEqual(validateDayHours({ 0: { start: '10:00', end: '12:00' }, 2: { start: '09:00', end: '17:00' } }, HOURS), [null, {}], 'Sunday is not a booking day; Tuesday equals the default')
})

test('SET-03 slots: a day of its own changes only that day; closed dates and minimum notice still apply on top', () => {
  // A Monday well in the future, so "now" is before every slot.
  const now = zonedToUtc(2031, 1, 6, 6, 0, TZ) // Monday 2031-01-06 06:00 local
  const base = { timezone: TZ, ...HOURS }
  const plain = computeSlots({ busy: [], rules: base, now, days: 7 }).slots
  const own = computeSlots({ busy: [], rules: { ...base, dayHours: FRIDAY }, now, days: 7 }).slots
  const fri = (list) => list.filter((s) => new Date(s.start).getUTCDay() === 5 && s.start > zonedToUtc(2031, 1, 10, 0, 0, TZ))
  assert.equal(fri(plain).length, 8, '9:00–17:00, 60 minutes')
  assert.equal(fri(own).length, 7, '9:00–16:00')
  assert.equal(fri(own).at(-1).end, zonedToUtc(2031, 1, 10, 16, 0, TZ), 'the last Friday slot ends at 4 pm')
  assert.deepEqual(own.filter((s) => !fri(own).includes(s)), plain.filter((s) => !fri(plain).includes(s)), 'every other day exactly as before')
  // A later start: the grid starts at that day's start.
  const late = computeSlots({ busy: [], rules: { ...base, dayHours: { 1: { start: '10:30', end: '12:30' } } }, now, days: 1 }).slots
  assert.deepEqual(late.map((s) => s.start), [zonedToUtc(2031, 1, 6, 10, 30, TZ), zonedToUtc(2031, 1, 6, 11, 30, TZ)])
  assert.equal(isOfferedSlot({ rules: { ...base, dayHours: FRIDAY }, now, days: 7, start: zonedToUtc(2031, 1, 10, 16, 0, TZ) }), false, '4 pm Friday is not offered')
  assert.equal(computeSlots({ busy: [], rules: { ...base, dayHours: FRIDAY, closedDates: ['2031-01-10'] }, now, days: 7 }).slots.some((s) => s.start >= zonedToUtc(2031, 1, 10, 0, 0, TZ) && s.start < zonedToUtc(2031, 1, 11, 0, 0, TZ)), false, 'a closed date stays closed')
  const notice = computeSlots({ busy: [], rules: { ...base, dayHours: { 1: { start: '07:00', end: '12:00' } }, minNoticeMinutes: 120 }, now, days: 1 }).slots
  assert.equal(notice[0].start, zonedToUtc(2031, 1, 6, 8, 0, TZ), 'minimum notice still cuts the first times')
})

test('SET-03 every describer agrees: receptionist knowledge + within hours, assistant, follow-ups, website, export', async () => {
  const before = await customer()
  assert.deepEqual(before.dayHours, {})
  assert.equal(before.dayHoursReady, true)
  const kBefore = (await knowledgeFor(env, before, null)).hours
  assert.equal(kBefore, `Monday, Tuesday, Wednesday, Thursday, Friday, 9:00 AM to 5:00 PM (${TZ})`, 'no override: the line reads as before')
  assert.equal(operatorHours(before), 'Mon, Tue, Wed, Thu, Fri 9:00 AM to 5:00 PM, 60 minutes each')
  assert.equal(siteHours(before), 'Mon–Fri · 9:00 AM – 5:00 PM')
  db.sql.prepare("INSERT INTO booking_day_hours (customer, hours, updated_at) VALUES ('tide', ?, 1)").run(JSON.stringify(FRIDAY))
  const c = await customer()
  assert.deepEqual(c.dayHours, FRIDAY)
  assert.equal((await knowledgeFor(env, c, null)).hours, `Monday, Tuesday, Wednesday, Thursday, 9:00 AM to 5:00 PM; Friday, 9:00 AM to 4:00 PM (${TZ})`)
  assert.equal(operatorHours(c), 'Mon, Tue, Wed, Thu 9:00 AM to 5:00 PM; Fri 9:00 AM to 4:00 PM, 60 minutes each')
  assert.equal((await businessFacts(env, c)).hours, 'Mon, Tue, Wed, Thu 9:00 AM–5:00 PM; Fri 9:00 AM–4:00 PM')
  assert.equal(siteHours(c), 'Mon–Thu · 9:00 AM – 5:00 PM; Fri · 9:00 AM – 4:00 PM')
  // Friday 4:30 pm: outside that day's hours; Thursday 4:30 pm: inside.
  assert.equal(withinHours(c, zonedToUtc(2031, 1, 10, 16, 30, TZ)), false)
  assert.equal(withinHours(c, zonedToUtc(2031, 1, 9, 16, 30, TZ)), true)
  assert.equal(withinHours(before, zonedToUtc(2031, 1, 10, 16, 30, TZ)), true, 'without the override Friday 4:30 pm was open')
  // Business export carries the per-day hours.
  const files = await exportFiles(c)
  assert.deepEqual(files['business.json'].hours.differentDays, { Friday: { from: '09:00', to: '16:00' } })
  assert.equal(files['business.json'].address, null)
})

// business.json out of the export (stored, uncompressed entries: the JSON text is in the archive as written).
async function exportFiles(c) {
  const text = new TextDecoder().decode((await businessExport(env, c)).bytes)
  const start = text.indexOf('{\n  "id": "tide"')
  assert.ok(start >= 0, 'business.json in the archive')
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return { 'business.json': JSON.parse(text.slice(start, i + 1)) }
  }
  throw new Error('business.json not found')
}

test('SET-03 missing table (before 0045): every reader behaves as today, a plain save works, a day of its own is refused', async () => {
  await setup({ skip: '0045_business_details.sql' })
  const c = await customer()
  assert.deepEqual(c.dayHours, {})
  assert.equal(c.dayHoursReady, false)
  assert.equal(siteHours(c), 'Mon–Fri · 9:00 AM – 5:00 PM')
  assert.deepEqual((await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayEnd: '18:00' })).status, 200)
  assert.equal((await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayHours: {} })).status, 200, 'nothing differs: saved as before')
  const r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayEnd: '17:00', dayHours: FRIDAY })
  assert.deepEqual([r.status, r.body.error], [409, 'day_hours_unavailable'])
  assert.equal((await customer()).dayEnd, '17:00', 'the earlier plain save stands; the refused one changed nothing')
  assert.equal((await call(addressRoute, 'GET', '/api/dashboard/address')).body.ready, false)
  assert.equal((await call(addressRoute, 'POST', '/api/dashboard/address', { address: ADDRESS, public: true })).body.error, 'address_unavailable')
  assert.deepEqual(await getBusinessAddress(db, 'tide'), { ready: false, address: null })
  assert.equal((await call(bookInfo, 'GET', '/api/book/tide')).body.address, null)
})

test('SET-03 route: saves default + per-day together, keeps per-day when the page leaves it out, 409 on a stale per-day base', async () => {
  let r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayHours: FRIDAY, base: { ...HOURS, dayHours: {} } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.hours.dayHours, FRIDAY)
  assert.deepEqual((await customer()).dayHours, FRIDAY)
  assert.equal(db.sql.prepare("SELECT day_end FROM customers WHERE id = 'tide'").get().day_end, '17:00', 'the default columns are not rewritten')
  // Onboarding / older pages send no dayHours: the stored per-day hours stay.
  r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, slotMinutes: 30 })
  assert.equal(r.status, 200)
  assert.equal(r.body.hours.dayHours, undefined, 'the older response shape')
  assert.deepEqual((await customer()).dayHours, FRIDAY)
  // A page that loaded before Friday changed: refused, nothing replaced.
  r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, slotMinutes: 30, dayHours: {}, base: { ...HOURS, slotMinutes: 30, dayHours: {} } })
  assert.deepEqual([r.status, r.body.error], [409, 'conflict'])
  assert.deepEqual(r.body.current.dayHours, FRIDAY)
  // Validation per day, with the day named.
  r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayHours: { 3: { start: '12:00', end: '12:15' } } })
  assert.deepEqual([r.status, r.body.error, r.body.day], [400, 'day_too_short', 3])
  // Everything back to the default → no row (exactly today's behaviour).
  r = await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, slotMinutes: 30, dayHours: { 5: { start: '09:00', end: '17:00' } } })
  assert.equal(r.status, 200)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM booking_day_hours').get().n, 0)
  // The booking page offers the per-day hours (Friday ends at 4 pm).
  await call(hoursRoute, 'POST', '/api/dashboard/hours', { ...HOURS, dayHours: FRIDAY })
  const slots = (await call(bookInfo, 'GET', '/api/book/tide')).body.slots.map((s) => Date.parse(s))
  const local = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const fridays = slots.map(local).filter((p) => p.weekday === 'Fri')
  assert.ok(fridays.length > 0)
  assert.ok(fridays.every((p) => p.hour < '16'), 'no Friday time at or after 4 pm')
  assert.ok(slots.map(local).some((p) => p.weekday === 'Thu' && p.hour === '16'), 'Thursday still has 4 pm')
})

// ---------- the address ----------

const ADDRESS = { street: '12 Harbor St', unit: 'Suite 2', city: 'Charleston', state: 'sc', zip: '29401' }

test('BOOK-08 validation: the lead address rules; an explicit show choice; null removes', () => {
  assert.deepEqual(validateBusinessAddress({ address: ADDRESS, public: true }), [null, { address: { ...ADDRESS, state: 'SC' }, public: true }])
  assert.equal(validateBusinessAddress({ address: { ...ADDRESS, street: 'Harbor' }, public: true })[0], 'invalid_street')
  assert.equal(validateBusinessAddress({ address: { ...ADDRESS, state: 'ZZ' }, public: false })[0], 'invalid_state')
  assert.equal(validateBusinessAddress({ address: { ...ADDRESS, zip: '2940' }, public: false })[0], 'invalid_zip')
  assert.equal(validateBusinessAddress({ address: ADDRESS })[0], 'invalid_request', 'the show choice is never assumed')
  assert.deepEqual(validateBusinessAddress({ address: null, public: true }), [null, { address: null, public: false }])
})

test('BOOK-08 exposure: public + at_business only; private never; a visiting business never, even marked public', async () => {
  const info = async () => (await call(bookInfo, 'GET', '/api/book/tide')).body.address
  assert.equal(await info(), null, 'no address on record')
  let r = await call(addressRoute, 'POST', '/api/dashboard/address', { address: ADDRESS, public: false, base: { address: null, public: false } })
  assert.deepEqual([r.status, r.body.shown], [200, false])
  assert.equal(await info(), null, 'private: never sent')
  r = await call(addressRoute, 'POST', '/api/dashboard/address', { address: ADDRESS, public: true })
  assert.deepEqual([r.status, r.body.shown], [200, true])
  assert.equal(await info(), '12 Harbor St, Suite 2, Charleston, SC 29401')
  // The business switches to visiting its customers: the address is no longer sent, though still marked public.
  db.sql.prepare("INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES ('tide', 'at_customer', 1)").run()
  assert.equal(await info(), null)
  assert.equal(await publicAddress(db, await customer()), null)
  assert.equal((await call(addressRoute, 'GET', '/api/dashboard/address')).body.shown, false)
  // A page that loaded before the address changed: refused, nothing replaced.
  r = await call(addressRoute, 'POST', '/api/dashboard/address', { address: { ...ADDRESS, street: '99 Other Rd' }, public: true, base: { address: null, public: false } })
  assert.deepEqual([r.status, r.body.error], [409, 'conflict'])
  assert.equal((await getBusinessAddress(db, 'tide')).address.street, '12 Harbor St')
  // Same-origin only; validation errors named.
  assert.equal((await call(addressRoute, 'POST', '/api/dashboard/address', { address: { ...ADDRESS, city: '9' }, public: true })).body.error, 'invalid_city')
  // Removing it.
  r = await call(addressRoute, 'POST', '/api/dashboard/address', { address: null, public: false })
  assert.deepEqual([r.status, r.body.address], [200, null])
  // A failing read never breaks the booking page: no address.
  assert.equal(await publicAddress({ prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error('D1 down')) }) }) }, { id: 'tide', appointmentMode: 'at_business' }), null)
})

test('BOOK-08 / SET-03 deletion and export cover the new tables', async () => {
  for (const t of ['booking_day_hours', 'business_addresses']) assert.ok(ERASED_TABLES.includes(t), t)
  await call(addressRoute, 'POST', '/api/dashboard/address', { address: ADDRESS, public: true })
  const files = await exportFiles(await customer())
  assert.deepEqual(files['business.json'].address, { ...ADDRESS, state: 'SC', public: true })
  assert.ok(validateHours(HOURS)[1], 'sanity')
})
