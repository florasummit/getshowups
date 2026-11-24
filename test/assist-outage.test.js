// Production incident 2026-11-24: Workers AI refused every call (4006, free allowance used up) and the assistant answered
// nothing, not even "Where is my help button?". Real handlers; the provider's refusal is the exact production message.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as api from '../functions/api/dashboard/assist.js'
import { intentOf, placeAnswer, worksWithoutAi } from '../server/assist-plain.js'
import { providerReason } from '../server/operator-model.js'
import { withoutModel } from '../server/assist.js'

const ORIGIN = 'https://getshowups.com'
const REFUSED = '4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.'
let sql, env, calls, fail, cookie, realError
beforeEach(async () => {
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  calls = 0
  fail = () => new Error(REFUSED)
  env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) }, GOOGLE_TOKENS: { get: async () => null }, OPERATOR_PROVIDER: 'claude', AI: { run: async () => { calls++; throw fail() } } }
  for (const id of ['alpha', 'beta']) {
    sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, 1, 1)").run(id, `${id} co`)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`o@${id}.example`, id)
    const token = `tok_${id}`.padEnd(43, 'x')
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), `o@${id}.example`, Date.now(), Date.now() + 864e5)
  }
  cookie = `__Host-gsu_session=${'tok_alpha'.padEnd(43, 'x')}`
  realError = console.error
  console.error = () => {}
})
afterEach(() => (console.error = realError))
let n = 0
const lead = (c, need) => sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Dana Fox', ?, '8435550100', ?, '29401', 'new', 'x', ?, 1)").run(`l${n++}`, c, `x${n}@y.example`, need, Date.now() - 36e5)
const ask = async (question, more = {}) => {
  const r = await api.onRequestPost({ env, request: new Request(`${ORIGIN}/api/dashboard/assist`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify({ view: 'teach', question, ...more }) }) })
  return { status: r.status, body: await r.json() }
}

test('the incident’s three questions, on Teach Your AI, with the provider refusing every call', async () => {
  lead('alpha', 'Green pool')
  lead('alpha', 'green pool')
  lead('alpha', 'Pump noise')
  lead('beta', 'Secret of beta')
  const one = await ask('What do people ask me for?')
  assert.deepEqual([one.status, one.body.kind], [200, 'records'])
  assert.match(one.body.answer, /3 requests.*(Green|green) pool” \(2\), “Pump noise”/)
  assert.doesNotMatch(JSON.stringify(one.body), /beta/)
  const before = calls
  const two = await ask('Where is my help button?')
  assert.deepEqual([two.status, two.body.kind, calls], [200, 'help', before], 'a place needs no model at all')
  assert.match(two.body.answer, /top of every dashboard page/)
  const history = [{ q: 'What do people ask me for?', a: one.body.answer }]
  const three = await ask('Why?', { history })
  assert.equal(three.status, 200)
  assert.match(three.body.answer, /without AI/)
  assert.match((await ask('Why?', { history: [{ q: 'What is service area?', a: 'x' }], topic: 'hours' })).body.answer, /^Booking hours: Only times inside/)
})

test('refusals are told apart, actionable, recorded as codes, and cost the owner none of the day’s questions', async () => {
  const r = await ask('write me a poem')
  assert.deepEqual([r.status, r.body.error, r.body.try.length > 0], [503, 'quota', true])
  assert.equal(r.body.resumesAt % 864e5, 0)
  assert.ok(r.body.resumesAt > Date.now() && r.body.resumesAt - Date.now() <= 864e5)
  assert.doesNotMatch(JSON.stringify(r.body), /4006|neurons|upgrade/i)
  const used = Object.fromEntries(sql.prepare('SELECT key, count FROM rate_limits').all().map((x) => [x.key.split(':')[0], x.count]))
  assert.deepEqual([used.aiAsk, used.aiAskAll, used.aiAskBurst], [0, 0, 1])
  assert.equal(JSON.parse(sql.prepare("SELECT props FROM events WHERE type = 'ai_ask'").get().props).reason, 'quota')
  fail = () => Object.assign(new Error('bad key'), { status: 401 })
  assert.equal((await ask('write me a poem')).body.error, 'setup')
  fail = () => new Error('socket')
  assert.deepEqual([(await ask('write me a poem')).body.error, sql.prepare("SELECT count FROM rate_limits WHERE key LIKE 'aiAsk:%'").get().count], ['unavailable', 1])
  for (const [e, want] of [[new Error(REFUSED), 'quota'], [new Error('ai_timeout'), 'timeout'], [Object.assign(new Error('x'), { status: 429 }), 'busy'], [Object.assign(new Error('Your credit balance is too low'), { status: 400 }), 'setup'], [undefined, 'unavailable']]) assert.equal(providerReason(e), want)
})

test('a missing Claude key never uses another feature’s key', async () => {
  env.RECEPTIONIST_ANTHROPIC_API_KEY = 'not-for-this'
  await ask('write me a poem')
  assert.equal(JSON.parse(sql.prepare("SELECT props FROM events WHERE type = 'ai_ask'").get().props).model.startsWith('@cf/'), true)
  assert.equal(calls, 1)
})

test('places answer only questions about where things are; data, drafts and reasons stay with the model', () => {
  const at = (question, view = 'overview') => placeAnswer({ question, view, topic: null })
  for (const [q, go] of [['How do I change my hours?', 'settings'], ['where’s settings', 'settings'], ['Where do I mark outcomes?', 'appointments'], ['how can I connect my domain', 'website'], ['open teach your ai', 'teach'], ['take me to follow-ups', 'followups']]) assert.equal(at(q)?.go, go, q)
  assert.match(at('What is this page for?', 'ads').answer, /^This is Ads/)
  for (const q of ['Where is my next appointment?', 'where are my leads coming from', 'where am I losing leads', 'how do I get more leads', 'show me my appointments', 'where should I advertise', 'how do I add a lead', 'where is my booking page', 'What should I change about my hours?']) assert.equal(at(q), null, q)
  for (const q of ['why are leads not booking', 'draft a follow-up for the newest lead', 'mark the first appointment as done', 'should I raise my prices', 'how much revenue did my ads make']) assert.equal(intentOf(q), null, q)
})

test('every suggestion shown during an outage really is answered without the model, on every page', async () => {
  const customer = { id: 'alpha', name: 'alpha co', timezone: 'America/New_York', serviceZips: [], slotMinutes: 60, workdays: [1], dayStart: '09:00', dayEnd: '17:00' }
  for (const view of ['overview', 'appointments', 'followups', 'receptionist', 'teach', 'website', 'ads', 'settings'])
    for (const question of worksWithoutAi(view)) assert.ok((await withoutModel(env, customer, { question, view, topic: null, history: [], refs: {} }))?.answer, `${view}: ${question}`)
})

test('follow-ups keep the subject: "and tomorrow?" after appointments; unknown ones are not guessed', async () => {
  const r = await ask('and tomorrow?', { history: [{ q: 'what is on my schedule', a: 'x' }] })
  assert.deepEqual([r.status, r.body.kind], [200, 'records'])
  assert.equal((await ask('and tomorrow?')).body.error, 'quota')
})

test('acceptance without a model: performance, priorities, revenue, hours change, another business, misspelling', async () => {
  lead('alpha', 'Green pool')
  for (const [q, want] of [
    ['How is my business performing?', /1 new inquiries|1 new/],
    ['What should I improve first?', /most important first|Nothing in your records/],
    ['How much recorded revenue did I generate?', /^Payments you recorded .*none recorded\. Money nobody recorded/],
    ['Can you change my operating hours?', /Nothing was changed/],
    ['Show me another business’s customers', /only have this business/],
  ]) {
    sql.exec('DELETE FROM rate_limits')
    const r = await ask(q)
    assert.equal(r.status, 200, q)
    assert.match(r.body.answer, want, q)
  }
  sql.exec('DELETE FROM rate_limits')
  assert.equal((await ask('app oinmntes tomorow')).body.kind, 'records')
  assert.match((await ask('how many availible appointments do I have?')).body.answer, /Google Calendar can’t be read/, 'open times, never a count of other things')
})

test('retry: one, only for a refusal that can pass; never for quota, setup or timeout', async () => {
  for (const [e, n] of [[new Error('socket'), 2], [new Error('3040: out of capacity'), 2], [new Error(REFUSED), 1], [new Error('ai_timeout'), 1], [Object.assign(new Error('x'), { status: 401 }), 1]]) {
    sql.exec('DELETE FROM rate_limits')
    calls = 0
    fail = () => e
    await ask('write me a poem')
    assert.equal(calls, n, e.message)
  }
})
