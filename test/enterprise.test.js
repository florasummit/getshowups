// Enterprise inquiries (server/enterprise.js, /api/enterprise/inquiry): stored only as leads of the GetShowUps sales
// business, validated, bot-protected, rate-limited, never messaged automatically, the owner told; no other tenant touched.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as api from '../functions/api/enterprise/inquiry.js'
import { inquiryToken, validateInquiry, ORG_TYPES } from '../server/enterprise.js'
import { formToken } from '../server/site-form.js'
import { validateLead } from '../server/booking.js'
import { queueOwnerNotices } from '../server/notify.js'
import { growth, customerRows } from '../server/metrics.js'
import { enterprise, pricing } from '../src/content/site.js'

let db, env, logs
const NOW = Date.now()
const real = console.error
beforeEach((t) => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q, args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
  })
  db = { sql, prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) }
  for (const id of ['getshowups', 'pools']) sql.prepare('INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)').run(id, id, 'America/New_York')
  sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run('founder@getshowups.example', 'getshowups')
  env = { GOOGLE_TOKENS: { get: async () => null, list: async () => ({ keys: [], list_complete: true }) }, ONBOARDING_DB: db, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback' }
  logs = []
  console.error = (...a) => logs.push(a.join(' '))
  t.after?.(() => (console.error = real))
})
const good = { organization: 'Harbor Franchise Group', name: 'Dana Lee', email: 'Dana@Harbor.example', type: 'franchise', count: '25', goal: 'Bookings for every location', website: '' }
const post = async (over = {}, { ip = '203.0.113.5', t } = {}) => {
  const body = JSON.stringify({ ...good, t: t ?? (await inquiryToken(env, Date.now() - 5000)), ...over })
  const r = await api.onRequestPost({ env, request: new Request('https://getshowups.com/api/enterprise/inquiry', { method: 'POST', body, headers: { 'CF-Connecting-IP': ip } }) })
  return { status: r.status, body: await r.json() }
}
const count = (t) => db.sql.prepare(`SELECT count(*) AS n FROM ${t}`).get().n

test('a valid inquiry becomes one lead of the sales business only, marked as enterprise, with no automatic message', async () => {
  assert.deepEqual(await post(), { status: 200, body: { ok: true } })
  const l = db.sql.prepare('SELECT * FROM leads').all()
  assert.equal(l.length, 1)
  assert.deepEqual([l[0].customer, l[0].name, l[0].email, l[0].phone, l[0].status], ['getshowups', 'Dana Lee', 'dana@harbor.example', '', 'new'])
  assert.equal(l[0].need, 'Enterprise inquiry: Harbor Franchise Group (Franchise, about 25 businesses). Goal: Bookings for every location')
  assert.equal(db.sql.prepare('SELECT source FROM lead_threads').get().source, 'enterprise_inquiry')
  assert.equal(count('messages'), 0)
  assert.ok(!logs.join().includes('harbor'))
  const g = await growth(env, await customerRows(env), Date.now())
  assert.equal(g.sales.enterpriseInquiries, 1)
})

test('the target business is never client input', async () => {
  assert.equal((await post({ customer: 'pools', source: 'booking_page', id: 'x', smsConsent: true })).status, 200)
  assert.deepEqual(db.sql.prepare('SELECT customer FROM leads').all().map((r) => r.customer), ['getshowups'])
  assert.equal(count('sms_consents'), 0)
})

test('the owner is told through the existing notice, under the launch gate, without an empty phone line', async () => {
  await post()
  await queueOwnerNotices(env, Date.now() + 11 * 60000)
  assert.equal(count('email_outbox'), 0, 'launch gate closed: nothing queued')
  env.MESSAGE_TEST_RECIPIENTS = 'founder@getshowups.example'
  Object.assign(env, { RESEND_API_KEY: 're_x', EMAIL_FROM: 'GetShowUps <hello@getshowups.example>' })
  await queueOwnerNotices(env, Date.now() + 11 * 60000)
  const m = db.sql.prepare('SELECT * FROM email_outbox').all()
  assert.equal(m.length, 1)
  assert.match(JSON.stringify(m[0]), /Enterprise inquiry: Harbor Franchise Group/)
  assert.ok(!/Phone:/.test(JSON.stringify(m[0])))
})

test('invalid fields are refused by code and store nothing', async () => {
  let n = 0
  for (const [over, code] of [[{ organization: ' ' }, 'invalid_organization'], [{ type: 'constructor' }, 'invalid_type'], [{ type: '' }, 'invalid_type'], [{ count: 'many' }, 'invalid_count'], [{ count: '0' }, 'invalid_count'], [{ goal: '' }, 'invalid_goal'], [{ name: 'D' }, 'invalid_name'], [{ email: 'nope' }, 'invalid_email'], [{ organization: { a: 1 } }, 'invalid_organization']])
    assert.deepEqual(await post(over, { ip: `198.51.100.${++n}` }), { status: 400, body: { error: code } })
  assert.equal(count('leads'), 0)
})

test('the longest accepted inquiry is stored whole', () => {
  const [error, i] = validateInquiry({ ...good, organization: 'o'.repeat(120), type: 'program', count: '100000', goal: 'g'.repeat(300) })
  assert.equal(error, null)
  assert.ok(i.lead.need.endsWith('g'.repeat(300)) && i.lead.need.length <= 500, String(i.lead.need.length))
})

test('control characters cannot add lines to the stored text', () => {
  const [, i] = validateInquiry({ ...good, organization: 'A\r\nBcc: x', goal: 'one\u0000\ntwo' })
  assert.ok(!/\p{Cc}/u.test(i.lead.need))
})

test('bots: trap field, missing, too fast, stale, forged and website-form tokens store nothing', async () => {
  assert.deepEqual(await post({ website: 'spam' }), { status: 200, body: { ok: true } })
  for (const t of ['', await inquiryToken(env), await inquiryToken(env, NOW - 25 * 3600e3), `${NOW - 9000}.${'A'.repeat(43)}`, await formToken(env, 'pools', NOW - 9000)])
    assert.deepEqual(await post({}, { t, ip: `192.0.2.${Math.floor(Math.random() * 250)}` }), { status: 400, body: { error: 'expired' } })
  assert.equal(count('leads'), 0)
})

test('rate limit per visitor; the token endpoint is never cached', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post()).status, 200)
  assert.equal((await post()).status, 429)
  const r = await api.onRequestGet({ env, request: new Request('https://getshowups.com/api/enterprise/inquiry') })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('Cache-Control') || '', /no-store/)
})

test('no sales business, a suspended one, a storage failure or missing config: an honest failure, never a false "sent"', async () => {
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'getshowups'").run()
  assert.deepEqual(await post(), { status: 503, body: { error: 'unavailable' } })
  db.sql.prepare("UPDATE customers SET status = 'active' WHERE id = 'getshowups'").run()
  const batch = db.batch
  db.batch = async () => { throw new Error('dana@harbor.example') }
  assert.equal((await post()).status, 503)
  db.batch = batch
  assert.ok(!logs.join().includes('dana@harbor'))
  delete env.TOKEN_ENCRYPTION_KEY
  assert.equal((await post({}, { t: 'x' })).status, 503)
})

test('booking-page leads still need a phone', () => {
  assert.deepEqual(validateLead({ name: 'Pat Doe', email: 'p@example.com', need: 'Cleaning' }), ['invalid_phone'])
})

test('pricing: exactly Growth at $499 and Enterprise from $10,000; form types match the server', () => {
  assert.deepEqual([pricing.name, pricing.price, enterprise.name, enterprise.lead, enterprise.price], ['Growth', 499, 'Enterprise', 'Starting at', '10,000'])
  assert.deepEqual(Object.fromEntries(enterprise.types), ORG_TYPES)
  assert.match(enterprise.points[0], /^Up to 25 business accounts/)
  assert.ok(!/consolidated|centralized|one login|by agreement/i.test(JSON.stringify(enterprise)))
})
