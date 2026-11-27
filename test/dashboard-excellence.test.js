// Guards for the dashboard and settings usability findings (docs/quality/USABILITY_FINDINGS.md DASH-01/04/08, SET-04,
// ONB-13, DASH-02/03). Real handlers on the SQLite-backed fake D1. The model is a stand-in that, like the one used in the
// evaluation, answers everything with one unrelated sentence: behaviour with the production model is NOT measured here.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as assist from '../functions/api/dashboard/assist.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as setupApi from '../functions/api/dashboard/setup-check.js'
import { ownStepInstead } from '../server/assist.js'
import { isOffered } from '../server/assist-plain.js'
import { problemWith } from '../server/operator.js'
import { IDEAS } from '../src/content/assistant-ideas.js'
import { isUsZone, oddZips, plainPrice, US_ZONES } from '../src/dashboard/owner-lib.js'

const ORIGIN = 'https://getshowups.com'
const UNRELATED = 'Start by checking the appointment length in Settings.'
const DAY = 864e5
let sql, env, calls, say
beforeEach(async () => {
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  calls = 0
  say = UNRELATED
  // The stand-in: first "no lookup needed", then its sentence, whatever was asked.
  const run = async (_m, body) => {
    calls++
    const looked = body.messages.some((m) => m.role === 'tool')
    return looked || !body.tools ? { choices: [{ message: { content: say } }], usage: { prompt_tokens: 900, completion_tokens: 20 } } : { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'no_lookup_needed', arguments: '{"why":"general_question"}' } }] } }], usage: { prompt_tokens: 900, completion_tokens: 10 } }
  }
  env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) }, GOOGLE_TOKENS: { get: async () => null }, AI: { run } }
  for (const id of ['alpha', 'beta']) {
    sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, service_zips, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, '29401', 1, 1)").run(id, `${id} co`)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`o@${id}.example`, id)
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(`tok_${id}`.padEnd(43, 'x')), `o@${id}.example`, Date.now(), Date.now() + DAY)
  }
})
const req = (id, body) => ({ env, request: new Request(`${ORIGIN}/x`, { method: body ? 'POST' : 'GET', headers: { Origin: ORIGIN, Cookie: `__Host-gsu_session=${`tok_${id}`.padEnd(43, 'x')}` }, ...(body ? { body: JSON.stringify(body) } : {}) }) })
const ask = async (question, more = {}) => {
  sql.exec('DELETE FROM rate_limits')
  const r = await assist.onRequestPost(req('alpha', { view: 'settings', question, ...more }))
  return { status: r.status, body: await r.json() }
}
let n = 0
const lead = (c, { status = 'new', at = Date.now() - 2 * DAY, name = 'Dana Fox', zip = '29401' } = {}) => {
  const id = `l${++n}`
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, '8435550100', 'Green pool', ?, ?, 'x', ?, 1)").run(id, c, name, `${id}@x.example`, zip, status, at)
  return id
}
const appt = (c, { status = 'booked', created = Date.now() - DAY, start = Date.now() + DAY, name } = {}) => {
  const l = lead(c, { status: 'booked', at: created, ...(name ? { name } : {}) })
  sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'e', ?, ?)").run(`a-${l}`, c, l, start, start + 36e5, status, created, created)
  return `a-${l}`
}

test('DASH-01: every chip the panel offers for a fact is answered from the records, with no model call', async () => {
  lead('alpha', { status: 'unqualified', name: 'Olive Outside', zip: '29999' })
  lead('alpha')
  appt('alpha', { name: 'Uma Upcoming' })
  appt('alpha', { name: 'Pat Past', start: Date.now() - DAY, created: Date.now() - 3 * DAY })
  lead('beta', { status: 'unqualified', name: 'Beta Secret', zip: '11111' })
  const want = {
    'What are my hours?': /^Your booking hours: /,
    'Who asks from outside my area?': /^1 person asked from outside your service area/,
    'What’s coming up?': /1 upcoming visit, and 1 past visit without an outcome/,
    'What’s on this week?': /appointment|Nothing is booked/,
    'Which visits still need an outcome?': /^1 past visit still needs an outcome/,
    'Who hasn’t been answered?': /Nothing has been sent to these people yet|Nothing like that/,
    'Who asked recently?': /Your latest inquiries/,
    'What do people ask me for?': /What people wrote/,
    'What should I fix first?': /most important first/,
    'What did my ads bring in?': /From leads traced to your ads in the last 30 days: 0 inquiries|Ads aren’t available/,
    'Compare the last 30 days with the 30 before': /^Last 30 days: .*\nThe 30 days before: /,
  }
  const offered = Object.values(IDEAS).flat()
  for (const q of new Set(offered)) {
    if (q === 'Draft a follow-up for me') continue // asks for writing: the model's, checked below
    assert.ok(want[q], `a new suggestion needs its expected fact here: ${q}`)
    const r = await ask(q)
    assert.equal(r.status, 200, q)
    assert.match(r.body.answer, want[q], q)
    assert.notEqual(r.body.answer, UNRELATED, q)
    assert.equal(r.body.aiOut, undefined, `${q}: not presented as an outage`)
    assert.doesNotMatch(JSON.stringify(r.body), /Beta Secret|11111/, `${q}: this business only`)
  }
  assert.equal(calls, 0, 'no model call for an offered fact')
  assert.equal((await ask('Who asks from outside my area?')).body.records[0].name, 'Olive Outside')
  // Follow-ups under a number (help topics) that ask for a count.
  assert.match((await ask('How many inquiries became bookings?', { topic: 'inquiries', view: 'overview' })).body.answer, /^Last 30 days: 4 new inquiries and 2 bookings made/)
  assert.match((await ask('How many ZIP codes do I list?', { topic: 'qualified', view: 'ads' })).body.answer, /^You list 1 ZIP code: 29401\./)
  assert.match((await ask('Do I have visits left to mark?', { topic: 'showed', view: 'overview' })).body.answer, /^1 past visit still needs an outcome/)
  assert.equal(calls, 0)
  assert.equal(isOffered('what are my hours'), true, 'the same words typed by hand get the same answer')
  assert.equal(isOffered('Draft a follow-up for me'), true)
  assert.equal(isOffered('Should I raise my prices?'), false)
})

test('DASH-01: a change request the model answers with an unrelated sentence gets the exact place instead; nothing is claimed', async () => {
  for (const [q, card, words] of [
    ['Stop taking bookings on Fridays', 'settings#booking-hours', /Booking hours are in Settings/],
    ['Change the price of filter cleaning to $120', 'settings#services', /Prices are in Settings/],
    ['Set my minimum notice to one day', 'settings#closed-dates', /Minimum notice is in Settings/],
    ['Mark Pat as a no-show', 'appointments', /Outcomes are recorded on Appointments/],
  ]) {
    const r = await ask(q)
    assert.deepEqual([r.status, r.body.kind, r.body.go], [200, 'help', card], q)
    assert.match(r.body.answer, words, q)
    assert.match(r.body.answer, /Nothing was changed\.$/, q)
    assert.notEqual(r.body.answer, UNRELATED)
    assert.equal(r.body.proposals, undefined, 'nothing prepared, nothing to approve')
    // The same check every model answer passes: no action claimed, no number invented.
    assert.equal(problemWith(r.body.answer, { facts: q, looked: false, refs: new Map() }), null, q)
  }
  assert.ok(calls > 0, 'these went to the model first')
  // An answer that is about the request is the model's to give: never replaced.
  say = 'Booking hours apply to every day you select, so one day can’t close earlier.'
  assert.equal((await ask('Stop taking bookings on Fridays')).body.answer, say)
  // A question that is not a request keeps the model's answer even when it is thin (no false place).
  say = UNRELATED
  assert.equal((await ask('Should I raise my prices?')).body.answer, UNRELATED)
})

test('DASH-01: a typed question about one fact in the records is answered from them; a change the model can’t help with gets its place', async () => {
  sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('alpha', '', 'Pool service', '', ?, '[]', 1)").run(JSON.stringify([{ name: 'Filter cleaning', price: '$95' }, { name: 'Green pool cleanup', price: 'From $325' }, { name: 'Pool opening', price: '' }]))
  sql.prepare("INSERT INTO booking_rules (customer, min_notice_minutes, updated_at) VALUES ('alpha', 120, 1)").run()
  sql.prepare("INSERT INTO business_closures (customer, date, label, created_at) VALUES ('alpha', '2026-12-25', 'Christmas Day', 1)").run()
  sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('beta', '', 'Pool service', '', ?, '[]', 1)").run(JSON.stringify([{ name: 'Filter cleaning', price: '$1' }]))
  for (const [q, want, go] of [
    ['How much do I charge for filter cleaning?', /^Filter cleaning: \$95, as listed in Settings\.$/, 'settings#services'],
    ['What is the price of a green pool cleanup?', /^Green pool cleanup: From \$325/, 'settings#services'],
    ['How much is pool opening?', /^Pool opening has no price listed\./, 'settings#services'],
    ['What is my minimum notice?', /^Your minimum notice is 2 hours/, 'settings#closed-dates'],
    ['When am I closed?', /^Closed: .*Dec 25.*Christmas Day/, 'settings#closed-dates'],
  ]) {
    const r = await ask(q)
    assert.deepEqual([r.status, r.body.kind, r.body.go], [200, 'records', go], q)
    assert.match(r.body.answer, want, q)
    assert.doesNotMatch(r.body.answer, /\d{4}-\d{2}-\d{2}|\$1\b/, `${q}: no ISO date, this business only`)
  }
  assert.equal(calls, 0, 'no model call for a fact the records hold')
  // Not one listed service, a request, or advice: the model's, as before.
  for (const q of ['How much do I charge for a heater repair?', 'How much should I charge for filter cleaning?', 'Change the price of filter cleaning to $110']) {
    calls = 0
    await ask(q)
    assert.ok(calls > 0, `${q}: goes to the model`)
  }
  // The model's answer fails its checks or can't be used, and the request is one the owner does themselves: the place.
  say = 'Done: I marked Pat Lee as a no-show and saved it.' // claims an action it can't take: refused by the checks
  const r = await ask('Mark Pat Lee as a no-show')
  assert.deepEqual([r.body.kind, r.body.go], ['help', 'appointments'])
  assert.match(r.body.answer, /^Outcomes are recorded on Appointments.*Nothing was changed\.$/)
  assert.equal(r.body.records, undefined, 'no unrelated records')
  // "no-show" is an outcome, not a negation: a claimed no-show is caught like any claimed action.
  for (const a of ['I marked Pat Lee as a no-show.', 'Pat Lee is now marked as a no show.']) assert.match(problemWith(a, { facts: '', looked: false, refs: new Map() }) || '', /something was done/, a)
  assert.equal(problemWith('I have not marked anyone as a no-show.', { facts: '', looked: false, refs: new Map() }), null)
})

test('DASH-01: the guard never replaces a prepared change, a shown record or a page the model offered', () => {
  const q = 'Change my hours to close at 4'
  assert.equal(ownStepInstead(q, { answer: 'Ready.', proposals: [{ type: 'hours' }], records: [] }), null)
  assert.equal(ownStepInstead(q, { answer: 'See below.', proposals: [], records: [{ ref: 'A1' }] }), null)
  assert.equal(ownStepInstead(q, { answer: 'That is your own step.', proposals: [], records: [], go: 'settings' }), null)
  assert.equal(ownStepInstead('How is my marketing going?', { answer: 'Fine.', proposals: [], records: [] }), null)
  assert.equal(ownStepInstead('What is my show-up rate?', { answer: 'Too few to judge.', proposals: [], records: [] }), null)
  assert.equal(ownStepInstead(q, { answer: 'Sure thing.', proposals: [], records: [] }).go, 'settings#booking-hours')
})

test('DASH-08: Overview and the assistant count the last 30 days the same way, at the edges too', async () => {
  // Booked 29.9 days ago (inside a rolling 30 × 24 h window, before the start of the 30th calendar day) and today.
  appt('alpha', { created: Date.now() - 29.9 * DAY, start: Date.now() + DAY })
  appt('alpha', { created: Date.now() - 31 * DAY, start: Date.now() + 2 * DAY })
  appt('alpha', { created: Date.now() - 60_000, start: Date.now() + 3 * DAY })
  appt('alpha', { created: Date.now() - DAY, start: Date.now() + 4 * DAY, status: 'cancelled' })
  const o = await (await overviewApi.onRequestGet(req('alpha'))).json()
  const a = (await ask('How many inquiries became bookings?', { topic: 'inquiries', view: 'overview' })).body.answer
  const said = Number(/(\d+) bookings? made/.exec(a)[1])
  assert.equal(said, o.stats.booked, `assistant "${a}" vs Overview ${o.stats.booked}`)
  assert.equal(Number(/(\d+) new inquir/.exec(a)[1]), o.stats.leads)
  assert.doesNotMatch(a, /\b1 (visits|bookings|new inquiries)\b|\d{4}-\d{2}-\d{2}/, 'plurals agree and no ISO date')
  assert.equal(calls, 0)
})

test('DASH-08: bookings count by the day they were made, visits and jobs by the day they were scheduled; Overview and the assistant agree', async () => {
  const done = (id, work) => sql.prepare('INSERT INTO appointment_outcomes (appointment_id, customer, work, reported_at) VALUES (?, ?, ?, ?)').run(id, 'alpha', work, Date.now())
  // Booked before the window, visited inside it (completed): a visit and a job, not a booking.
  done(appt('alpha', { created: Date.now() - 40 * DAY, start: Date.now() - 10 * DAY, status: 'showed' }), 'completed')
  // Booked inside the window, visit still to come: a booking, not a visit.
  appt('alpha', { created: Date.now() - 5 * DAY, start: Date.now() + 5 * DAY })
  // Booked and scheduled inside the window, did not come: a booking and a no-show.
  appt('alpha', { created: Date.now() - 2 * DAY, start: Date.now() - DAY, status: 'no_show' })
  // Booked and visited before the window: neither.
  done(appt('alpha', { created: Date.now() - 45 * DAY, start: Date.now() - 35 * DAY, status: 'showed' }), 'completed')
  // Another business's visit never counts.
  appt('beta', { created: Date.now() - 40 * DAY, start: Date.now() - 10 * DAY, status: 'showed' })
  const before = sql.prepare('SELECT * FROM appointments ORDER BY id').all()
  const o = (await (await overviewApi.onRequestGet(req('alpha'))).json()).stats
  assert.deepEqual([o.booked, o.visitsScheduled, o.showed, o.noShow, o.completed], [2, 2, 1, 1, 1])
  const a = (await ask('Compare the last 30 days with the 30 before', { view: 'overview' })).body.answer
  assert.equal(Number(/(\d+) bookings? made/.exec(a)[1]), o.booked, a)
  assert.equal(Number(/(\d+) visits? scheduled in that time and marked as happened/.exec(a)[1]), o.showed, a)
  const n = (await ask('How many no-shows did I have?', { topic: 'show_rate', view: 'overview' })).body.answer
  assert.match(n, /by the day the visit was scheduled: 1 no-show, 1 visit marked as happened/)
  assert.deepEqual(sql.prepare('SELECT * FROM appointments ORDER BY id').all(), before, 'stored data never changes')
  // The tiles and their help say which date each counts by.
  const home = readFileSync(new URL('../src/dashboard/Home.jsx', import.meta.url), 'utf8')
  assert.match(home, /'bookings made these 30 days/)
  assert.match(home, /'scheduled these 30 days, marked as happened'/)
  const { HELP } = await import('../src/content/help.js')
  assert.match(HELP.booked.what, /by the day the booking was made/)
  assert.match(HELP.showed.what, /counted by the day of the visit/)
  assert.match(HELP.completed.what, /visits scheduled in the last 30 days/)
  assert.equal(calls, 0)
})

test('DASH-03: a cancelled visit is listed (this business only) and never counted as booked', async () => {
  appt('alpha', { status: 'cancelled', name: 'Cora Cancelled' })
  appt('beta', { status: 'cancelled', name: 'Beta Secret' })
  const o = await (await overviewApi.onRequestGet(req('alpha'))).json()
  assert.deepEqual(o.cancelled.map((x) => [x.name, x.status]), [['Cora Cancelled', 'cancelled']])
  assert.equal(o.stats.booked, 0)
  assert.equal(o.upcoming.length, 0)
})

test('DASH-04: a notice that may be ignored can be dismissed: same-origin, this business, only what is flagged, and it stays dismissed', async () => {
  sql.prepare("UPDATE customers SET workdays = '0,1,2,3,4,5,6' WHERE id IN ('alpha', 'beta')").run()
  const get = async (id) => (await (await setupApi.onRequestGet(req(id))).json()).items
  const before = await get('alpha')
  const holiday = before.find((x) => x.id === 'holiday_open')
  if (!holiday) return // no US holiday within three weeks of today: nothing to dismiss (the fixed-date case is in account-controls.test.js)
  assert.equal(holiday.dismiss.startsWith('I work'), true)
  assert.doesNotMatch(holiday.title, /\d{4}-\d{2}-\d{2}/, 'no ISO date')
  const cross = await setupApi.onRequestPost({ env, request: new Request(`${ORIGIN}/x`, { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: `__Host-gsu_session=${'tok_alpha'.padEnd(43, 'x')}` }, body: JSON.stringify({ id: 'holiday_open', action: 'dismiss' }) }) })
  assert.equal(cross.status, 403)
  assert.equal((await setupApi.onRequestPost(req('alpha', { id: 'no_notice', action: 'dismiss' }))).status, 400, 'only notices that offer it')
  const done = await setupApi.onRequestPost(req('alpha', { id: 'holiday_open', action: 'dismiss' }))
  assert.equal(done.status, 200)
  assert.equal((await done.json()).items.some((x) => x.id === 'holiday_open'), false)
  assert.equal((await get('alpha')).some((x) => x.id === 'holiday_open'), false)
  assert.equal((await get('beta')).some((x) => x.id === 'holiday_open'), true, 'another business still sees its own')
  assert.equal((await setupApi.onRequestPost(req('alpha', { id: 'holiday_open', action: 'dismiss' }))).status, 400, 'nothing left to dismiss')
})

test('DASH-02 / SET-04 / ONB-13: amounts, ZIP entries and time zones', () => {
  // A listed price is suggested only when it is a plain amount for one visit.
  assert.deepEqual(['$95', '95', '$1,200', '$95.50', '$95 per visit', ' $150 flat '].map(plainPrice), [9500, 9500, 120000, 9550, 9500, 15000])
  assert.deepEqual(['From $150', '$300+ per month', '$95 diagnostic', '$100-$200', '$165/month', '', null, 'Call us'].map(plainPrice), [null, null, null, null, null, null, null, null])
  // ZIP entries that aren't five digits are named for a US business; other countries' postal codes are left alone.
  assert.deepEqual(oddZips('2946, ABCDE, 99999 29401', 'America/New_York'), ['2946', 'ABCDE'])
  assert.deepEqual(oddZips('29401, 29403', 'America/Chicago'), [])
  assert.deepEqual(oddZips('', 'America/Chicago'), [])
  assert.deepEqual(oddZips('SW1A 1AA, K1A 0B1', 'Europe/London'), [])
  assert.deepEqual(oddZips('K1A 0B1', 'America/Toronto'), [])
  // Named US zones first: fewer than 20 entries, real zone ids, the same stored values.
  assert.ok(US_ZONES.length < 20)
  for (const [id, label] of US_ZONES) {
    assert.ok(Intl.supportedValuesOf('timeZone').includes(id), id)
    assert.match(label, / Time/)
    assert.equal(isUsZone(id), true)
  }
  assert.deepEqual(['America/Detroit', 'America/Indiana/Indianapolis', 'America/Toronto', 'Europe/London', 'America/Mexico_City'].map(isUsZone), [true, true, false, false, false])
})
