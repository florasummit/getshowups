// Admin → Growth → Activities (server/acquisition.js, /api/platform/acquisition, migration 0044): the prepared
// acquisition plan by tracking code. Results come from the real path a prospect takes (tracked link → public lead route
// → booked demo → attended → business created with the same sign-in → live subscription and payment); status and cost
// are recorded by the founder, audited, and never send or spend anything. Real handlers + migrations on node:sqlite;
// Google is a stand-in; the subscription and payment rows stand in for Stripe's webhook.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { createSalesBusiness } from '../server/sales.js'
import { createCustomer } from '../server/customers.js'
import { track } from '../server/events.js'
import { ACTIVITIES, STATUSES, acquisitionOverview, cleanLabel, linkReadiness, saveAcquisitionCode } from '../server/acquisition.js'
import { planStep } from '../server/growth.js'
import * as growthRoute from '../functions/api/platform/growth.js'
import * as acqRoute from '../functions/api/platform/acquisition.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as outcomeRoute from '../functions/api/dashboard/outcome.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86400000
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const CAL = 'https://www.googleapis.com/calendar/v3'
const ADMIN = 'founder@getshowups.com'
let env, db, kv, origFetch

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

beforeEach(async () => {
  db = d1()
  kv = new Map()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) }, PLATFORM_ADMIN_EMAILS: ADMIN, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' }
  assert.equal((await createSalesBusiness(env, { email: ADMIN }, 'sales')).ok, true)
  kv.set('google:getshowups', JSON.stringify({ customer: 'getshowups', email: ADMIN, scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.at', scope: SCOPE })
    if (u === `${CAL}/freeBusy`) return Response.json({ calendars: { primary: { busy: [] } } })
    if (u.startsWith(`${CAL}/calendars/primary/events`)) return Response.json({ id: JSON.parse(init.body).id })
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { body, as, params = { customer: 'getshowups' }, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...(as ? { Cookie: await cookie(as) } : {}), ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
const view = async () => (await call(growthRoute, 'GET', '/api/platform/growth', { as: ADMIN })).json().acquisition
const codeOf = (a, code) => a.activities.flatMap((x) => x.codes).find((c) => c.code === code)
// A prospect opens a tracked link and books a demo through the public routes, exactly as a browser would.
async function prospect(email, attribution, { book = true } = {}) {
  const lead = await call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { name: 'Pat Owner', email, phone: '843-555-0142', serviceId: 'sv_gsudemo', answer: 'Pool service and repair', attribution } })
  assert.equal(lead.status, 201, lead.text)
  if (!book) return lead.json()
  const info = (await call(bookInfo, 'GET', '/api/book/getshowups?service=sv_gsudemo')).json()
  const taken = new Set(db.sql.prepare('SELECT start_at FROM appointments').all().map((r) => r.start_at))
  const slot = info.slots.find((s) => Date.parse(s) > Date.now() + 3600_000 && !taken.has(Date.parse(s)))
  const appt = await call(bookAppt, 'POST', '/api/book/getshowups/appointment', { body: { leadId: lead.json().leadId, leadToken: lead.json().leadToken, start: slot } })
  assert.equal(appt.status, 201, appt.text)
  return lead.json()
}

test('the catalog: ten activities, unique lowercase codes, every link carries its own code to the sales booking page and chat', async () => {
  assert.equal(ACTIVITIES.length, 10)
  const codes = ACTIVITIES.flatMap((a) => a.codes)
  assert.equal(new Set(codes).size, codes.length)
  for (const c of codes) assert.match(c, /^[a-z0-9][a-z0-9-]{1,31}$/)
  const a = await view()
  assert.equal(a.available, true)
  assert.deepEqual(a.activities.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(codeOf(a, 'out-01').links.book, 'https://getshowups.com/book/getshowups?utm_source=outreach&utm_medium=email&utm_campaign=out-01')
  assert.equal(codeOf(a, 'counter-01').links.chat, 'https://getshowups.com/chat/getshowups?utm_source=counter&utm_medium=print&utm_campaign=counter-01')
  assert.equal(a.totals.codes, codes.length)
  assert.equal(a.totals.sent, 0)
  assert.deepEqual(codeOf(a, 'out-01').results, { prospects: 0, qualified: 0, consultationsBooked: 0, consultationsAttended: 0, businessesCreated: 0, paying: null, revenueCents: null })
})

test('prospect to customer through one tracking code: link → lead → demo booked → attended → business → paying → paid revenue', async () => {
  // The founder records that the email went out (recording sends nothing).
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'out-01', status: 'approved' } })).status, 200)
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'out-01', status: 'sent', label: 'Harbor Pools', costCents: 0 } })).status, 200)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM email_outbox').get().n, 0, 'nothing is queued to anyone')
  // The prospect opens the link in the email and books a demo.
  const lead = await prospect('pat@harborpools.example', { utm_source: 'outreach', utm_medium: 'email', utm_campaign: 'out-01' })
  let c = codeOf(await view(), 'out-01')
  assert.deepEqual([c.results.prospects, c.results.qualified, c.results.consultationsBooked, c.results.consultationsAttended], [1, 1, 1, 0])
  // The founder marks the reply, and after the call records that the prospect came (the call is moved into the past).
  await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'out-01', status: 'replied' } })
  const appt = db.sql.prepare('SELECT id FROM appointments WHERE lead_id = ?').get(lead.leadId)
  db.sql.prepare('UPDATE appointments SET start_at = ?, end_at = ? WHERE id = ?').run(Date.now() - 2 * 3600_000, Date.now() - 3600_000, appt.id)
  const out = await call(outcomeRoute, 'POST', '/api/dashboard/outcome', { as: ADMIN, body: { id: appt.id, outcome: 'showed' } })
  assert.equal(out.status, 200, out.text)
  // The prospect signs up with the same address. In Stripe test mode nobody is paying and no revenue is shown.
  const business = await createCustomer(env, 'pat@harborpools.example', { name: 'Harbor Pools', timezone: 'America/New_York', serviceZips: [], appointmentMode: 'at_customer' }, { source: 'outreach', via: 'self_serve' }, Date.now() + 1000)
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, updated_at) VALUES (?, 'cus_1', 'sub_1', 'founding', 'active', 49900, 'usd', 1)").run(business)
  db.sql.prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?, 1, 1)').run(business)
  await track(env, 'revenue', { id: 'revenue:in_1', customer: business, props: { amountCents: 49900, currency: 'usd', livemode: true }, at: Date.now() })
  await track(env, 'revenue', { id: 'revenue:in_test', customer: business, props: { amountCents: 49900, currency: 'usd', livemode: false }, at: Date.now() })
  let a = await view()
  c = codeOf(a, 'out-01')
  assert.equal(a.live, false)
  assert.deepEqual(c.results, { prospects: 1, qualified: 1, consultationsBooked: 1, consultationsAttended: 1, businessesCreated: 1, paying: null, revenueCents: null })
  assert.equal(a.totals.costPerPayingCents, null)
  // Live billing: the live subscription counts and only the live payment is revenue; cost per paying customer uses the
  // founder's recorded costs (a second inquiry from the same address is never credited the revenue twice).
  env.STRIPE_LIVE_ENABLED = 'true'
  env.STRIPE_SECRET_KEY = 'sk_live_fake'
  await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'counter-01', status: 'sent', costCents: 4200 } })
  a = await view()
  c = codeOf(a, 'out-01')
  assert.deepEqual(c.results, { prospects: 1, qualified: 1, consultationsBooked: 1, consultationsAttended: 1, businessesCreated: 1, paying: 1, revenueCents: 49900 })
  assert.equal(c.status, 'replied')
  assert.equal(c.label, 'Harbor Pools')
  assert.ok(c.sentAt && c.repliedAt && c.approvedAt)
  assert.deepEqual([a.totals.sent, a.totals.replied, a.totals.results.paying, a.totals.results.revenueCents, a.totals.recordedCostCents, a.totals.adSpendCents, a.totals.costPerPayingCents], [2, 1, 1, 49900, 4200, null, 4200])
  assert.equal(a.activities.find((x) => x.key === 'email-local').results.paying, 1)
  assert.ok(!JSON.stringify(a).includes('@'), 'no address in the view')
  // Every recorded step is in the audit trail, as codes.
  const audits = db.sql.prepare("SELECT details FROM admin_audit WHERE action = 'acquisition.code_updated'").all().map((r) => JSON.parse(r.details))
  assert.equal(audits.length, 4)
  assert.deepEqual(audits[1], { code: 'out-01', activity: 'email-local', from: { status: 'approved', costCents: 0 }, to: { status: 'sent', costCents: 0 } })
})

test('results by code: other sources are listed apart; a second inquiry never doubles revenue; test leads never count', async () => {
  await prospect('a@one.example', { utm_source: 'referral', utm_medium: 'word', utm_campaign: 'ref-01' }, { book: false })
  await prospect('a@one.example', { utm_source: 'counter', utm_medium: 'print', utm_campaign: 'counter-01' }, { book: false })
  await prospect('b@two.example', { utm_source: 'homepage', utm_medium: 'site', utm_campaign: 'cta_hero' }, { book: false })
  await prospect('c@three.example', undefined, { book: false })
  await prospect(ADMIN, { utm_source: 'outreach', utm_medium: 'email', utm_campaign: 'out-02' }, { book: false }) // internal: a test lead
  const business = await createCustomer(env, 'a@one.example', { name: 'One Pools', timezone: 'America/New_York', serviceZips: [], appointmentMode: 'at_customer' }, { source: 'referral', via: 'self_serve' }, Date.now() + 1000)
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, updated_at) VALUES (?, 'cus_1', 'sub_1', 'founding', 'active', 49900, 'usd', 1)").run(business)
  db.sql.prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?, 1, 1)').run(business)
  await track(env, 'revenue', { id: 'revenue:in_1', customer: business, props: { amountCents: 49900, currency: 'usd', livemode: true }, at: Date.now() })
  env.STRIPE_LIVE_ENABLED = 'true'
  env.STRIPE_SECRET_KEY = 'sk_live_fake'
  const a = await view()
  assert.equal(codeOf(a, 'out-02').results.prospects, 0)
  assert.equal(codeOf(a, 'ref-01').results.revenueCents + codeOf(a, 'counter-01').results.revenueCents, 49900, 'credited once')
  assert.equal(a.totals.results.revenueCents, 49900)
  assert.deepEqual(a.other.map((o) => `${o.source}|${o.campaign}|${o.prospects}`).sort(), ['direct|null|1', 'homepage|cta_hero|1'])
})

test('status: times follow the steps, stepping back clears later ones, a follow-up is due 4 days after sending without a reply', async () => {
  const t0 = Date.now() - 6 * DAY
  assert.equal((await saveAcquisitionCode(env, { code: 'out-03', status: 'sent' }, t0)).ok, true)
  let a = await acquisitionOverview(env, null)
  assert.equal(codeOf(a, 'out-03').followUpDue, true)
  assert.equal(codeOf(a, 'out-03').results, null, 'no attribution → results unavailable, never zeros')
  assert.equal(a.totals.followUpsDue, 1)
  assert.equal(a.activities.find((x) => x.key === 'follow-up').codes.length, 0)
  await saveAcquisitionCode(env, { code: 'out-03', status: 'followed_up' })
  a = await acquisitionOverview(env, null)
  assert.equal(codeOf(a, 'out-03').followUpDue, false)
  assert.equal(codeOf(a, 'out-03').sentAt, t0, 'the first time is kept')
  await saveAcquisitionCode(env, { code: 'out-03', status: 'declined' })
  assert.equal((await acquisitionOverview(env, null)).totals.declined, 1)
  await saveAcquisitionCode(env, { code: 'out-03', status: 'prepared' })
  const row = db.sql.prepare("SELECT * FROM acquisition_codes WHERE code = 'out-03'").get()
  assert.deepEqual([row.approved_at, row.sent_at, row.followed_up_at, row.replied_at], [null, null, null, null])
  // A sent counter card is not outreach to a person: no follow-up.
  await saveAcquisitionCode(env, { code: 'counter-01', status: 'sent' }, t0)
  assert.equal(codeOf(await acquisitionOverview(env, null), 'counter-01').followUpDue, false)
  assert.deepEqual(STATUSES, ['prepared', 'approved', 'sent', 'followed_up', 'replied', 'declined'])
})

test('a new code joins an activity that takes codes; bad input is refused with a code', async () => {
  // Adding is its own intent (create: true). A change to a code that does not exist is refused, never a silent add.
  assert.deepEqual(await saveAcquisitionCode(env, { code: 'out-06', status: 'prepared', activity: 'email-local' }), { ok: false, httpStatus: 404, error: 'unknown_code' })
  assert.equal((await saveAcquisitionCode(env, { code: 'out-06', create: true })).error, 'invalid_activity')
  assert.equal((await saveAcquisitionCode(env, { code: 'out-06', create: true, activity: 'follow-up' })).error, 'invalid_activity')
  assert.equal((await saveAcquisitionCode(env, { code: 'out-06', create: true, activity: 'email-local' })).created, true)
  const a = await acquisitionOverview(env, null)
  assert.ok(a.activities.find((x) => x.key === 'email-local').codes.some((c) => c.code === 'out-06' && c.links.book.endsWith('utm_campaign=out-06')))
  // A catalog code keeps its own activity whatever is sent.
  assert.equal((await saveAcquisitionCode(env, { code: 'ref-01', status: 'sent', activity: 'paid-test' })).activity, 'referral')
  for (const [input, error] of [
    [{ code: 'Out 07', status: 'sent' }, 'invalid_code'],
    [{ code: 'out-01', status: 'emailed' }, 'invalid_status'],
    [{ code: 'out-01', label: 'pat@harborpools.example' }, 'invalid_label'],
    [{ code: 'out-01', label: 'Pat 843-555-0142' }, 'invalid_label'],
    [{ code: 'out-01', costCents: -1 }, 'invalid_cost'],
    [{ code: 'out-01', costCents: 12.5 }, 'invalid_cost'],
  ]) assert.equal((await saveAcquisitionCode(env, input)).error, error, JSON.stringify(input))
  assert.equal(cleanLabel('  Mount Pleasant\tsupply counter '), 'Mount Pleasant supply counter')
  assert.equal(cleanLabel('843 Pool Service'), '843 Pool Service')
})

test('GROW-01: adding a code that already exists is refused (code_exists) and leaves its status, dates, name and cost untouched', async () => {
  const t0 = Date.now() - 2 * DAY
  // A catalog code the founder already worked with, and one they added themselves.
  await saveAcquisitionCode(env, { code: 'out-01', status: 'sent', label: 'Harbor Pools', costCents: 1500 }, t0)
  assert.equal((await saveAcquisitionCode(env, { code: 'mine-01', create: true, activity: 'referral' }, t0)).created, true)
  await saveAcquisitionCode(env, { code: 'mine-01', status: 'replied', label: 'Neighbor', costCents: 300 }, t0)
  const rows = () => JSON.stringify(db.sql.prepare('SELECT * FROM acquisition_codes ORDER BY code').all())
  const before = rows()
  const audits = () => db.sql.prepare("SELECT count(*) n FROM admin_audit WHERE action LIKE 'acquisition.%'").get().n
  const auditsBefore = audits()
  for (const [code, activity] of [['out-01', 'email-local'], ['out-01', 'referral'], ['mine-01', 'referral'], ['out-02', 'email-local']]) {
    // The released page's request (status: 'prepared' + activity) with the new intent, through the real route.
    const r = await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code, activity, create: true, status: 'prepared' } })
    assert.deepEqual([r.status, r.json().error], [409, 'code_exists'], code)
  }
  assert.equal(rows(), before, 'nothing stored changed')
  assert.equal(audits(), auditsBefore, 'a refusal is not audited as a change')
  const a = await view()
  assert.deepEqual([codeOf(a, 'out-01').status, codeOf(a, 'out-01').sentAt, codeOf(a, 'out-01').label, codeOf(a, 'out-01').costCents], ['sent', t0, 'Harbor Pools', 1500])
  assert.deepEqual([codeOf(a, 'mine-01').status, codeOf(a, 'mine-01').repliedAt, codeOf(a, 'mine-01').costCents], ['replied', t0, 300])
  // The released page's old request (no create intent) for a brand-new code can no longer add or reset anything.
  const old = await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'brand-new', status: 'prepared', activity: 'referral' } })
  assert.deepEqual([old.status, old.json().error], [404, 'unknown_code'])
  // A real new code through the route.
  const ok = await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'ref-04', activity: 'referral', create: true } })
  assert.deepEqual([ok.status, ok.json().status], [200, 'prepared'])
})

test('GROW-07: a name and a cost saved at the same moment both stay (each request writes only what it changes)', async () => {
  await saveAcquisitionCode(env, { code: 'out-04', status: 'sent' })
  await Promise.all([saveAcquisitionCode(env, { code: 'out-04', label: 'Harbor Pools' }), saveAcquisitionCode(env, { code: 'out-04', costCents: 2500 }), saveAcquisitionCode(env, { code: 'out-05', label: 'Tide Pools' }), saveAcquisitionCode(env, { code: 'out-05', costCents: 900 })])
  const a = await view()
  assert.deepEqual([codeOf(a, 'out-04').status, codeOf(a, 'out-04').label, codeOf(a, 'out-04').costCents], ['sent', 'Harbor Pools', 2500])
  assert.deepEqual([codeOf(a, 'out-05').status, codeOf(a, 'out-05').label, codeOf(a, 'out-05').costCents], ['prepared', 'Tide Pools', 900])
})

test('GROW-03/08/02: codes come in order; each activity offers only the statuses that fit it; links say whether they will open', async () => {
  await saveAcquisitionCode(env, { code: 'out-10', create: true, activity: 'email-regional' })
  await saveAcquisitionCode(env, { code: 'out-9', create: true, activity: 'email-regional' })
  let a = await view()
  assert.deepEqual(a.activities.find((x) => x.key === 'email-regional').codes.map((c) => c.code), ['out-9', 'out-10', 'out-38', 'out-49', 'out-52', 'out-53', 'out-58'])
  assert.deepEqual(a.activities.find((x) => x.key === 'email-local').statuses, STATUSES)
  for (const key of ['counter-card', 'founder-post', 'listing', 'paid-test']) assert.deepEqual(a.activities.find((x) => x.key === key).statuses, ['prepared', 'approved', 'sent'], key)
  // The sales business of this file exists with its calendar; the hours and the receptionist decide the rest.
  const row = db.sql.prepare("SELECT hours_confirmed_at FROM customers WHERE id = 'getshowups'").get()
  const on = Boolean(db.sql.prepare("SELECT enabled FROM receptionist_settings WHERE customer = 'getshowups'").get()?.enabled)
  const bookable = Boolean(row.hours_confirmed_at)
  assert.deepEqual(a.linkState, { book: bookable ? 'ready' : 'not_bookable', chat: !bookable ? 'not_bookable' : on ? 'ready' : 'off' })
  assert.deepEqual(linkReadiness({ exists: false }), { book: 'missing', chat: 'missing' })
  assert.deepEqual(linkReadiness({ exists: true, calendarConnected: true, hoursConfirmed: true, receptionistOn: false }), { book: 'ready', chat: 'off' })
  assert.deepEqual(linkReadiness({ exists: true, calendarConnected: false, hoursConfirmed: true, receptionistOn: true }), { book: 'not_bookable', chat: 'not_bookable' })
  assert.deepEqual(linkReadiness(null), { book: 'unknown', chat: 'unknown' })
  db.sql.exec('PRAGMA foreign_keys = OFF') // only the business row goes: the page must cope with its records missing
  db.sql.prepare("DELETE FROM customers WHERE id = 'getshowups'").run()
  a = await view()
  assert.deepEqual(a.linkState, { book: 'missing', chat: 'missing' })
})

test('GROW-05: Decide never states a count Measure shows as unavailable, names the prepared activities, follows what was recorded, never suggests the paid test', async () => {
  const d = async () => (await call(growthRoute, 'GET', '/api/platform/growth', { as: ADMIN })).json()
  // Nothing recorded: the first prepared activities by title.
  let r = await d()
  assert.equal(r.decide.bottleneck, 'volume')
  assert.deepEqual(r.decide.activities, [ACTIVITIES[0].title, ACTIVITIES[1].title])
  assert.match(r.decide.experiment, /Nothing has been sent yet\. Approve and send the first prepared activity, “Emails to Charleston owners” \(5 codes prepared\)/)
  assert.match(r.decide.why, /^0 prospects in 30 days/, 'the sales business exists: 0 is a measured count')
  // An approved batch that was never sent comes before anything new.
  for (const code of ['ref-01', 'ref-02']) await saveAcquisitionCode(env, { code, status: 'approved' })
  r = await d()
  assert.match(r.decide.experiment, /^Send the approved batch: 2 approved codes in “Referral asks” have not been sent/)
  assert.deepEqual(r.decide.activities, ['Referral asks'])
  // Follow-ups that are due come first.
  await saveAcquisitionCode(env, { code: 'out-02', status: 'sent' }, Date.now() - 5 * DAY)
  r = await d()
  assert.match(r.decide.experiment, /^Start with the 1 follow-up now due in “Emails to Charleston owners”/)
  // Only a paid activity approved: still never suggested.
  assert.deepEqual(planStep({ totals: { sent: 0 }, activities: [{ title: 'Capped paid test', paid: true, codes: [{}], status: { approved: 1, prepared: 0 }, followUpsDue: 0 }] }).activities, [])
  for (const text of [r.decide.experiment, r.decide.title, r.decide.cost, r.decide.why]) assert.doesNotMatch(text, /Meta|Google|budget|spend more|homepage entry is live|[A-Z]{3,}_[A-Z_]{3,}/)
  // No sales business: prospects are unavailable in Measure, so Decide states no count and says what to set up.
  db.sql.exec('PRAGMA foreign_keys = OFF') // only the business row goes: the page must cope with its records missing
  db.sql.prepare("DELETE FROM customers WHERE id = 'getshowups'").run()
  r = await d()
  assert.equal(r.measure.items.find((i) => i.key === 'salesLeads').kind, 'unavailable')
  assert.deepEqual(r.decide.sample, {})
  assert.doesNotMatch(`${r.decide.why} ${r.decide.experiment} ${r.decide.title}`, /\b0 prospect|\d+ prospects? in 30 days|is live/)
  assert.match(r.decide.experiment, /^Create the GetShowUps sales assistant/)
  assert.ok(r.decide.activities.length >= 1 && r.decide.experiment.includes(`“${r.decide.activities[0]}”`))
})

test('the route: platform admins only, same-origin, nothing saved or audited on a refusal; before migration 0044 the view still works', async () => {
  const body = { code: 'out-01', status: 'sent' }
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { body })).status, 401)
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { as: 'owner@pools.example', body })).status, 403)
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body: { code: 'out-01' } })).status, 400)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM acquisition_codes').get().n, 0)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM admin_audit WHERE action LIKE 'acquisition.%'").get().n, 0)
  db.sql.exec('DROP TABLE acquisition_codes')
  const refused = await call(acqRoute, 'POST', '/api/platform/acquisition', { as: ADMIN, body })
  assert.equal(refused.status, 409)
  assert.equal(refused.json().error, 'not_ready')
  const a = await view()
  assert.equal(a.available, false)
  assert.equal(codeOf(a, 'out-01').status, 'prepared')
  assert.equal(a.totals.codes, 18)
})
