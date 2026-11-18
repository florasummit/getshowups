// Service-area (coverage) workflow: lead eligibility ≠ booking eligibility. A visitor outside the listed ZIPs (or with a
// ZIP we can't verify) is never turned away: the lead is kept with its ad attribution as a coverage request; nothing is
// booked until the owner approves; approval lets the SAME lead book (no starting over). Real routes, real D1 schema
// (SQLite), Google Calendar mocked at the network boundary. Industries: pool service, HVAC, salon.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { checkZip, areaFor, isRealZip, normalizeZip } from '../server/zipcode.js'
import { ZCTA_COUNT } from '../server/zip-data.js'
import { coverageFor } from '../server/coverage.js'
import { submitSiteForm, formToken } from '../server/site-form.js'
import { queueOwnerNotices } from '../server/notify.js'
import { funnel, diagnose } from '../server/ads/funnel.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'
import { render } from '../server/messages.js'
import * as slotsApi from '../functions/api/book/[customer]/index.js'
import * as leadApi from '../functions/api/book/[customer]/lead.js'
import * as apptApi from '../functions/api/book/[customer]/appointment.js'
import * as coverageApi from '../functions/api/dashboard/coverage.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const DAY = 864e5
let env, db, kv, origFetch, events

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
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
async function business(id, zips, industry) {
  const t = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${industry} Co`, zips, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', 'active', '{}', 2000, '1', 1, 1)").run(`camp-${id}`, id)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
const cust = async (id) => customerFromRow(await getCustomer(db, id))

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
    MESSAGE_TEST_RECIPIENTS: 'owner@pools.example,owner@hvac.example,owner@salon.example',
  }
  await business('pools', '29401,29403', 'Pool service')
  await business('hvac', '78701,78702,78703', 'HVAC')
  await business('salon', '', 'Salon') // area not limited: every valid lead can book
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
    if (u.includes('/events?sendUpdates=all')) {
      events.push(JSON.parse(init.body).id)
      return json(200, { id: JSON.parse(init.body).id })
    }
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function call(mod, method, path, { cookie, origin = ORIGIN, body, params, ip = '203.0.113.7' } = {}) {
  const h = { 'CF-Connecting-IP': ip }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : {} }
}
async function owner(id) {
  const email = `owner@${id}.example`
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
const person = { name: 'Jamie Rivera', email: 'jamie@example.net', phone: '843-555-0142', need: 'Weekly pool care' }
let visitor = 0
const lead = (id, body) => call(leadApi, 'POST', `/api/book/${id}/lead`, { params: { customer: id }, ip: `203.0.113.${(visitor++ % 200) + 1}`, body: { ...person, ...body } })
const coverageRow = (leadId) => db.sql.prepare('SELECT customer, zip, zip_check, status, decided_by FROM coverage_requests WHERE lead_id = ?').get(leadId)

test('ZIP rules: real ZIPs from the Census list; ZIP+4 read as 5 digits; numeric closeness never means served', () => {
  assert.ok(ZCTA_COUNT > 33_000)
  assert.deepEqual(checkZip('29403'), { zip: '29403', check: 'valid' })
  assert.deepEqual(checkZip(' 29403-1234 '), { zip: '29403', check: 'valid' })
  for (const bad of ['2940', '294033', 'ABCDE', '', '29 403', '<script>']) assert.equal(checkZip(bad).check, 'invalid', bad)
  for (const unknown of ['00000', '99999', '00001']) assert.equal(checkZip(unknown).check, 'unknown', unknown)
  assert.equal(normalizeZip('78701'), '78701')
  assert.ok(isRealZip('90210') && isRealZip('78702') && !isRealZip('29999'))
  const pools = { serviceZips: ['29401', '29403'] }
  assert.equal(areaFor(pools, '29403'), 'in')
  assert.equal(areaFor(pools, '29405'), 'outside', 'a neighbouring number is not served') // a real Charleston ZIP
  assert.equal(areaFor(pools, '29404'), 'outside')
  assert.equal(areaFor(pools, '00000'), 'uncertain')
  assert.equal(areaFor({ serviceZips: [] }, '90210'), 'in', 'no list = area not limited')
})

test('booking page: in-area books normally; a neighbouring ZIP becomes a coverage request with its ad attribution kept; invalid ZIP asks again; unknown ZIP asks to confirm (pool service)', async () => {
  const ad = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'camp-pools', gclid: 'Cj0KCQiAtest123' }
  const inArea = await lead('pools', { zip: '29403', attribution: ad })
  assert.deepEqual([inArea.status, inArea.json.qualified, inArea.json.coverage], [201, true, null])
  const near = await lead('pools', { zip: '29407', attribution: ad }) // real, nearby, not listed
  assert.deepEqual([near.status, near.json.qualified, near.json.coverage], [201, false, 'pending'])
  assert.ok(near.json.leadToken, 'the same browser keeps its lead (no starting over later)')
  assert.deepEqual({ ...coverageRow(near.json.leadId) }, { customer: 'pools', zip: '29407', zip_check: 'outside', status: 'pending', decided_by: null })
  const attr = db.sql.prepare('SELECT source, campaign_id, details FROM lead_attribution WHERE lead_id = ?').get(near.json.leadId)
  assert.deepEqual([attr.source, attr.campaign_id, JSON.parse(attr.details).gclid], ['google_ads', 'camp-pools', 'present'], 'campaign kept for out-of-area leads')
  // Invalid → 400 and nothing stored; unknown → 400 unknown_zip, then kept when the visitor confirms it.
  const leadsBefore = db.sql.prepare('SELECT count(*) AS n FROM leads').get().n
  assert.deepEqual([(await lead('pools', { zip: '2940' })).json.error, (await lead('pools', { zip: 'ABCDE' })).json.error], ['invalid_zip', 'invalid_zip'])
  assert.equal((await lead('pools', { zip: '00000' })).json.error, 'unknown_zip')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM leads').get().n, leadsBefore, 'nothing stored until the ZIP is settled')
  const confirmed = await lead('pools', { zip: '00000', zipConfirmed: true })
  assert.deepEqual([confirmed.status, confirmed.json.coverage, coverageRow(confirmed.json.leadId).zip_check], [201, 'pending', 'unknown'])
  // An out-of-area lead can't book: the appointment route refuses before touching the calendar.
  const slots = (await call(slotsApi, 'GET', '/api/book/pools', { params: { customer: 'pools' } })).json.slots
  const refused = await call(apptApi, 'POST', '/api/book/pools/appointment', { params: { customer: 'pools' }, body: { leadId: near.json.leadId, leadToken: near.json.leadToken, start: slots[0] } })
  assert.deepEqual([refused.status, refused.json.error, events.length], [409, 'not_qualified', 0])
  // No list (salon): every valid ZIP books.
  assert.deepEqual((await lead('salon', { zip: '10001', need: 'Haircut' })).json.qualified, true)
})

test('owner decision: approve lets the SAME lead book with its own token or emailed link; decline keeps it on record; never changes the ZIP list; audited (HVAC)', async () => {
  const a = (await lead('hvac', { zip: '78745', need: 'AC not cooling' })).json
  const b = (await lead('hvac', { zip: '78750', need: 'Furnace check' })).json
  const c = await owner('hvac')
  // The owner sees the request on the Appointments data.
  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: c })).json
  const row = ov.followUp.find((l) => l.id === a.leadId)
  assert.deepEqual(row.coverage, { status: 'pending', zip: '78745', check: 'outside' })
  // Validation and protection.
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { body: { leadId: a.leadId, decision: 'approve' } })).status, 401)
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, origin: 'https://evil.example', body: { leadId: a.leadId, decision: 'approve' } })).status, 403)
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: a.leadId, decision: 'maybe' } })).status, 400)
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: 'nope', decision: 'approve' } })).status, 404)
  // Approve.
  const ok = await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: a.leadId, decision: 'approve' } })
  assert.equal(ok.json.coverage, 'approved')
  assert.match(ok.json.bookingUrl, new RegExp(`^${ORIGIN}/book/hvac\\?lead=${a.leadId}&k=[A-Za-z0-9_-]+$`))
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(a.leadId).status, 'new')
  assert.ok(!coverageRow(a.leadId).decided_by.includes('@'), 'decided_by is a reference, never an email')
  assert.equal(db.sql.prepare('SELECT service_zips FROM customers WHERE id = ?').get('hvac').service_zips, '78701,78702,78703', 'the service list never changes')
  // The visitor is sent their link (normal message rules), and the message is honest.
  // Approving again (the owner fetching the link later) returns the same link and sends nothing new.
  const again = await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: a.leadId, decision: 'approve' } })
  assert.deepEqual([again.json.unchanged, again.json.bookingUrl], [true, ok.json.bookingUrl])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM messages WHERE lead_id = ? AND kind = 'coverage_ok'").get(a.leadId).n, 1)
  const msg = db.sql.prepare("SELECT kind, channel, status FROM messages WHERE lead_id = ? AND kind = 'coverage_ok'").get(a.leadId)
  assert.deepEqual([msg.kind, msg.channel, msg.status], ['coverage_ok', 'email', 'scheduled'])
  const r = await render(env, { kind: 'coverage_ok', biz: 'HVAC Co', customer: 'hvac', lead_id: a.leadId, lead_name: 'Jamie Rivera', need: 'AC not cooling' })
  assert.match(r.text, /can help with "AC not cooling" in your area\. Your details are saved, so you only need to pick a time:\n.*\/book\/hvac\?lead=/)
  // Same lead books with the token it already had, or the emailed link's token (no new details).
  const slots = (await call(slotsApi, 'GET', '/api/book/hvac', { params: { customer: 'hvac' } })).json.slots
  const booked = await call(apptApi, 'POST', '/api/book/hvac/appointment', { params: { customer: 'hvac' }, body: { leadId: a.leadId, leadToken: a.leadToken, start: slots[0] } })
  assert.equal(booked.status, 201, JSON.stringify(booked.json))
  assert.equal(events.length, 1, 'one calendar event')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM leads').get().n, 2, 'no second lead')
  // Decline the other; repeat decisions are idempotent; a declined request can still be approved later.
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: b.leadId, decision: 'decline' } })).json.coverage, 'declined')
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: b.leadId, decision: 'decline' } })).status, 200)
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(b.leadId).status, 'unqualified', 'declined: kept, not bookable')
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: a.leadId, decision: 'decline' } })).status, 409, 'an approved (booked) request isn’t silently declined')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'lead.coverage'").get().n, 2)
})

test('tenant isolation: another business can’t see or decide a coverage request; coverage lists are per business', async () => {
  const a = (await lead('pools', { zip: '29407' })).json
  const other = await owner('hvac')
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: other, body: { leadId: a.leadId, decision: 'approve' } })).status, 404)
  assert.equal(coverageRow(a.leadId).status, 'pending')
  assert.equal((await coverageFor(db, 'hvac', [a.leadId])).size, 0)
  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: other })).json
  assert.ok(!JSON.stringify(ov).includes(a.leadId))
})

test('website form: a mistyped or out-of-area ZIP never loses the lead (a plain form can’t ask again); attribution kept (salon + pools)', async () => {
  const pools = await cust('pools')
  const t = await formToken(env, 'pools', Date.now() - 10_000)
  const send = (extra) => submitSiteForm(env, pools, { t, kind: 'contact', name: 'Sam Ortiz', email: 'sam@example.net', phone: '843-555-0103', need: 'Green pool', ...extra })
  const typo = await send({ zip: '2940', utm_source: 'google', utm_campaign: 'camp-pools' })
  const outside = await send({ zip: '29492' })
  const inArea = await send({ zip: '29401' })
  assert.deepEqual([typo.state, outside.state, inArea.state], ['sent', 'sent', 'sent'])
  assert.deepEqual({ ...coverageRow(typo.leadId) }, { customer: 'pools', zip: '2940', zip_check: 'invalid', status: 'pending', decided_by: null })
  assert.equal(coverageRow(outside.leadId).zip_check, 'outside')
  assert.equal(coverageRow(inArea.leadId), undefined)
  assert.equal(db.sql.prepare('SELECT campaign_id FROM lead_attribution WHERE lead_id = ?').get(typo.leadId).campaign_id, 'camp-pools')
  // Salon (no list): no coverage requests at all.
  const salon = await cust('salon')
  const ts = await formToken(env, 'salon', Date.now() - 10_000)
  const s = await submitSiteForm(env, salon, { t: ts, kind: 'contact', name: 'Ana Lima', email: 'ana@example.net', phone: '512-555-0100', need: 'Color appointment', zip: '' })
  assert.deepEqual([s.state, coverageRow(s.leadId)], ['sent', undefined])
})

test('owner notice: told right away about a coverage request (honest wording); once per member; held by the launch gate when not allowed', async () => {
  const now = Date.now()
  const a = (await lead('pools', { zip: '29407' })).json
  const out = await queueOwnerNotices(env, now + 1000)
  assert.equal(out.queued, 1)
  const n = db.sql.prepare("SELECT subject, body, template FROM email_outbox WHERE template = 'owner_coverage'").get()
  assert.match(n.subject, /^Can you serve Jamie Rivera\? \(ZIP 29407\)$/)
  assert.match(n.body, /ZIP 29407, which isn't on your service list\. We kept their request and told them you'll confirm availability\. They can't book until you answer\./)
  assert.equal((await queueOwnerNotices(env, now + 2000)).queued, 0, 'once')
  env.MESSAGE_TEST_RECIPIENTS = ''
  await lead('hvac', { zip: '78745' })
  assert.equal((await queueOwnerNotices(env, now + 3000)).queued, 0, 'launch gate holds it')
  assert.ok(a.leadId)
})

test('results: out-of-area leads are counted separately (not qualified, not booked); many of them → one finding about locations, booking rate judged in-area', async () => {
  for (let i = 0; i < 6; i++) await lead('pools', { zip: '29403', attribution: { utm_source: 'google', utm_campaign: 'camp-pools' } })
  for (let i = 0; i < 5; i++) await lead('pools', { zip: '29407', attribution: { utm_source: 'google', utm_campaign: 'camp-pools' } })
  const f = await funnel(db, 'pools', {})
  assert.deepEqual([f.stages.leads, f.stages.qualified, f.stages.outsideArea, f.stages.booked], [11, 6, 5, 0])
  const d = diagnose(f)
  assert.equal(d[0].id, 'outside_area')
  assert.match(d[0].detail, /^5 of 11 leads \(45%\) were outside your listed ZIP codes\. Check that the campaign’s locations match your service ZIP codes/)
  assert.ok(!d.some((x) => x.id === 'lead_to_booking'), 'only 6 in-area leads: below the minimum to judge booking')
})

test('before migration 0029: an out-of-area lead is still kept exactly as before (no coverage row, no error)', async () => {
  db = d1({ skip: ['0029'] })
  env.ONBOARDING_DB = db
  await business('pools', '29401,29403', 'Pool service')
  const r = await lead('pools', { zip: '29407' })
  assert.deepEqual([r.status, r.json.qualified, r.json.coverage], [201, false, null])
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(r.json.leadId).status, 'unqualified')
  const c = await owner('pools')
  assert.equal((await call(coverageApi, 'POST', '/api/dashboard/coverage', { cookie: c, body: { leadId: r.json.leadId, decision: 'approve' } })).status, 409)
})
