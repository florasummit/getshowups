// Acquisition engine (Phase 3): one funnel (server/ads/funnel.js) from ad spend to money actually received, revenue kept
// apart from attendance (server/revenue.js, migration 0028), deterministic diagnostics, and ad attribution carried
// through the website form and the AI receptionist. Real D1 schema (SQLite), real routes; no Google calls.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { funnel, diagnose, MIN } from '../server/ads/funnel.js'
import { recordRevenue } from '../server/revenue.js'
import { keepableAttribution, recordAttribution } from '../server/ads/attribution.js'
import { submitSiteForm, formToken } from '../server/site-form.js'
import { chatLink } from '../server/site-serve.js'
import { startConversation, loadConversation } from '../server/receptionist/engine.js'
import { adResults, adSummary } from '../server/ads/campaigns.js'
import * as results from '../functions/api/dashboard/results.js'
import * as revenueApi from '../functions/api/dashboard/revenue.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 17, 12)
let env, db

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
function business(id) {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', 1, 1, 1)").run(id, `${id} Co`)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`owner@${id}.example`, id)
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', 'active', '{}', 2000, '999', 1, 1)").run(`camp-${id}`, id)
}
let n = 0
// A lead created `daysAgo`, optionally from an ad, with an appointment in a given state.
function lead(customer, { daysAgo = 2, ad = true, status = 'new', email = 'x@example.net', appt = null, test = false } = {}) {
  const id = `L${++n}`
  const at = NOW - daysAgo * DAY
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'N', ?, '+18435550100', 'x', '', ?, 'h', ?, ?)").run(id, customer, email, status, at, at)
  if (ad) db.sql.prepare("INSERT INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?, ?, 'google_ads', ?, '{}', ?)").run(id, customer, `camp-${customer}`, at)
  if (test) db.sql.prepare('INSERT INTO test_marks (lead_id, customer, is_test, marked_by, marked_at) VALUES (?, ?, 1, ?, 1)').run(id, customer, 'owner')
  if (appt) {
    const start = (appt.past ? at + DAY : NOW + DAY) + n * 3_600_000 // distinct times (the double-booking guard)
    db.sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'e', ?, ?)").run(`A${id}`, customer, id, start, start + 3_600_000, appt.status, at, at)
    if (appt.work || appt.value != null) db.sql.prepare('INSERT INTO appointment_outcomes (appointment_id, customer, work, value_cents, reported_at) VALUES (?, ?, ?, ?, ?)').run(`A${id}`, customer, appt.work ?? null, appt.value ?? null, NOW)
  }
  return id
}
const spend = (customer, cents, clicks, { daysAgo = 1, fetched = NOW - 3_600_000 } = {}) =>
  db.sql.prepare('INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?)').run(`camp-${customer}`, customer, new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10), cents, clicks, fetched)
const cust = (id) => ({ id, name: `${id} Co`, appointmentMode: 'at_business' })

async function cookieFor(id) {
  const email = `owner@${id}.example`
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, path = '/x', origin = ORIGIN } = {}) {
  const h = {}
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}${path}`, { method, headers: h, body: body && JSON.stringify(body) }), env })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text || '{}'), text }
}

beforeEach(() => {
  db = d1()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, ADS_ENABLED: 'true', ADS_BUSINESSES: 'pools', GOOGLE_TOKENS: { get: async () => null } }
  business('pools')
  business('salon')
})

test('funnel: one cohort from spend to paid money; test leads, other periods and cancellations left out; nothing estimated', async () => {
  spend('pools', 40000, 120) // $400, 120 clicks
  lead('pools', { status: 'unqualified' })
  lead('pools', { appt: { status: 'booked' } }) // upcoming
  lead('pools', { appt: { status: 'cancelled' } })
  const noShow = lead('pools', { appt: { status: 'no_show', past: true } })
  const done = lead('pools', { appt: { status: 'showed', past: true, work: 'completed', value: 50000 } })
  lead('pools', { appt: { status: 'showed', past: true, work: 'not_completed' } })
  lead('pools', { appt: { status: 'booked', past: true } }) // past, no outcome marked yet
  lead('pools', { ad: false }) // not from an ad
  lead('pools', { test: true, appt: { status: 'showed', past: true, work: 'completed', value: 99900 } }) // test: excluded
  lead('pools', { email: 'me@getshowups.com' }) // internal: excluded
  lead('pools', { daysAgo: 45 }) // outside 30 days
  lead('salon', { appt: { status: 'showed', past: true, work: 'completed', value: 7000 } }) // another business
  // Money recorded on the completed visit, with a correction (latest wins) and the history kept.
  const cs = cust('pools')
  assert.equal((await recordRevenue(db, cs, `A${done}`, 'invoiced', 52000, 'owner@pools.example', NOW)).ok, true)
  await recordRevenue(db, cs, `A${done}`, 'paid', 40000, 'owner@pools.example', NOW)
  await recordRevenue(db, cs, `A${done}`, 'paid', 45000, 'owner@pools.example', NOW + 1)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM revenue_entries').get().n, 3, 'append-only: the correction is a new row')
  assert.deepEqual((await recordRevenue(db, cs, `A${noShow}`, 'paid', 100, 'o', NOW)).error, 'not_found', 'no money on a visit that did not happen')
  const f = await funnel(db, 'pools', { days: 30, now: NOW })
  assert.deepEqual(f.stages, { leads: 7, qualified: 6, booked: 5, cancelled: 1, past: 4, outcomeRecorded: 3, attended: 2, noShow: 1, completed: 1 })
  assert.deepEqual(f.revenue, { estimatedCents: 50000, estimatedJobs: 1, invoicedCents: 52000, invoicedJobs: 1, paidCents: 45000, paidJobs: 1 })
  assert.deepEqual(f.cost, { perLead: Math.round(40000 / 7), perQualified: Math.round(40000 / 6), perBooking: 8000, perAttended: 20000, perCompleted: 40000 })
  assert.equal(f.roas, 1.13, 'paid ÷ spend')
  assert.deepEqual(f.attribution, { allLeads: 8, adLeads: 7, unattributed: 1 })
  assert.deepEqual([f.spend.cents, f.spend.clicks, f.spend.stale], [40000, 120, false])
  // 'all' scope counts every lead, but costs need ad leads (spend is ad spend).
  const all = await funnel(db, 'pools', { days: 30, scope: 'all', now: NOW })
  assert.deepEqual([all.stages.leads, all.cost.perLead, all.roas], [8, null, null])
  // 90 days includes the older lead.
  assert.equal((await funnel(db, 'pools', { days: 90, now: NOW })).stages.leads, 8)
  // The two existing summaries are views of this one funnel (no second definition).
  const r = await adResults(db, 'pools', NOW)
  assert.deepEqual([r.leads, r.qualifiedLeads, r.booked, r.completedJobs, r.reportedRevenueCents, r.verifiedPaymentsCents, r.costPerBookingCents], [7, 6, 5, 1, 50000, 45000, 8000])
  const o = await adSummary(db, 'pools', NOW)
  assert.deepEqual([o.leads, o.booked, o.showed, o.costPerShowUpCents], [7, 5, 2, 20000])
})

test('funnel honesty: no spend → no costs or ROAS; nothing to divide by → null; stale spend flagged; before migration 0028 money is unavailable', async () => {
  lead('pools', { appt: { status: 'showed', past: true, work: 'completed' } })
  const f = await funnel(db, 'pools', { now: NOW })
  assert.deepEqual([f.spend.cents, f.cost.perLead, f.roas, f.revenue.estimatedCents, f.revenue.paidCents], [null, null, null, null, null])
  spend('salon', 1000, 3, { fetched: NOW - 40 * 3_600_000 })
  const s = await funnel(db, 'salon', { now: NOW })
  assert.deepEqual([s.stages.leads, s.cost.perLead, s.spend.stale], [0, null, true])
  db = d1({ skip: ['0028'] })
  env.ONBOARDING_DB = db
  business('pools')
  lead('pools', { appt: { status: 'showed', past: true, value: 3000 } })
  const old = await funnel(db, 'pools', { now: NOW })
  assert.deepEqual([old.revenueTracking, old.revenue.estimatedCents, old.revenue.invoicedCents, old.revenue.paidCents], [false, 3000, null, null])
  assert.deepEqual((await recordRevenue(db, cust('pools'), 'x', 'paid', 1, 'o')).error, 'not_ready')
})

test('diagnostics: grounded in the numbers, judged only with enough data, ordered along the funnel, never "spend more"', () => {
  const base = { scope: 'ads', range: { days: 30 }, spend: { cents: null, clicks: null, stale: false }, revenue: { paidCents: null }, revenueTracking: true }
  const st = (o) => ({ leads: 0, qualified: 0, booked: 0, cancelled: 0, past: 0, outcomeRecorded: 0, attended: 0, noShow: 0, completed: 0, ...o })
  const ids = (f) => diagnose(f).map((d) => d.id)
  // Spending with clicks but no leads → tracking first.
  assert.deepEqual(ids({ ...base, spend: { cents: 12000, clicks: 80, stale: false }, stages: st({}) }), ['tracking', 'sample'])
  // Too few leads: no rate judgement, just "not enough data".
  const few = diagnose({ ...base, stages: st({ leads: 4, booked: 0 }) })
  assert.deepEqual(few.map((d) => [d.id, d.level]), [['sample', 'info']])
  assert.match(few[0].detail, /4 leads in 30 days/)
  // 42 leads, 6 booked → lead-to-booking, with the numbers.
  const drop = diagnose({ ...base, stages: st({ leads: 42, booked: 6 }) })
  assert.equal(drop[0].id, 'lead_to_booking')
  assert.match(drop[0].detail, /42 leads, but only 6 booked \(14%\)\. Review booking availability and how fast you follow up before increasing ad spend\./)
  // Visits not marked; attendance; payments missing; stale spend.
  assert.deepEqual(ids({ ...base, stages: st({ leads: 20, booked: 12, past: 10, outcomeRecorded: 3, attended: 3 }) }), ['outcomes_missing'])
  assert.deepEqual(ids({ ...base, stages: st({ leads: 20, booked: 15, past: 12, outcomeRecorded: 10, attended: 5, noShow: 5 }) }), ['attendance', 'revenue_missing'])
  assert.deepEqual(ids({ ...base, spend: { cents: 100, clicks: 1, stale: true }, stages: st({ leads: 12, booked: 8, past: 6, outcomeRecorded: 6, attended: 6 }) }), ['stale', 'revenue_missing'])
  assert.ok(diagnose({ ...base, stages: st({ leads: MIN.leads, booked: MIN.leads }) }).length === 0, 'a healthy funnel says nothing')
  for (const d of drop) assert.doesNotMatch(d.detail, /increase (your )?budget|spend more/i)
})

test('routes: results need a session, and the Ads feature for ad scope; revenue is same-origin, session-business only, validated and audited', async () => {
  const c = await cookieFor('pools')
  const s = await cookieFor('salon')
  lead('pools', { appt: { status: 'showed', past: true } })
  lead('salon', { appt: { status: 'showed', past: true } })
  assert.equal((await call(results, 'GET', { path: '/api/dashboard/results' })).status, 401)
  const r = await call(results, 'GET', { cookie: c, path: '/api/dashboard/results?days=7&scope=ads' })
  assert.deepEqual([r.status, r.json.funnel.range.days, r.json.funnel.stages.leads, Array.isArray(r.json.diagnostics)], [200, 7, 1, true])
  assert.equal((await call(results, 'GET', { cookie: s, path: '/api/dashboard/results?scope=ads' })).status, 404, 'no Ads feature → no ad results')
  assert.equal((await call(results, 'GET', { cookie: s, path: '/api/dashboard/results?scope=all' })).json.funnel.stages.leads, 1)
  const appt = db.sql.prepare("SELECT id FROM appointments WHERE customer = 'pools'").get().id
  assert.equal((await call(revenueApi, 'POST', { cookie: c, body: { appointmentId: appt, kind: 'paid', amountCents: 1000 }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(revenueApi, 'POST', { cookie: s, body: { appointmentId: appt, kind: 'paid', amountCents: 1000 } })).status, 404, 'another business’s visit')
  for (const bad of [{ kind: 'refund', amountCents: 1 }, { kind: 'paid', amountCents: -5 }, { kind: 'paid', amountCents: 1.5 }, { kind: 'paid' }, { kind: 'paid', amountCents: 200_000_000 }])
    assert.equal((await call(revenueApi, 'POST', { cookie: c, body: { appointmentId: appt, ...bad } })).status, 400, JSON.stringify(bad))
  const ok = await call(revenueApi, 'POST', { cookie: c, body: { appointmentId: appt, kind: 'paid', amountCents: 12500 } })
  assert.deepEqual([ok.status, ok.json.revenue], [200, { invoiced: null, paid: 12500 }])
  const cleared = await call(revenueApi, 'POST', { cookie: c, body: { appointmentId: appt, kind: 'paid', amountCents: null } })
  assert.deepEqual(cleared.json.revenue, { invoiced: null, paid: null })
  assert.ok(!db.sql.prepare('SELECT recorded_by FROM revenue_entries').all().some((x) => x.recorded_by.includes('@')), 'who recorded it: a reference, never an email')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'appointment.revenue'").get().n, 2)
})

test('attribution through the website: a contact form carries the ad’s parameters; only this business’s campaign counts; no parameters → unattributed', async () => {
  const pools = { ...cust('pools'), serviceZips: [] }
  const t = Number((await formToken(env, 'pools', NOW - 10_000)).split('.')[0])
  const token = await formToken(env, 'pools', t)
  const send = (extra) => submitSiteForm(env, pools, { t: token, kind: 'contact', name: 'Jamie Rivera', email: 'jamie@example.net', phone: '843-555-0142', need: 'Weekly care', zip: '', ...extra }, NOW)
  const a = await send({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'camp-pools', gclid: 'Cj0KCQiA1234567890abc' })
  const b = await send({ utm_source: 'google', utm_campaign: 'camp-salon' }) // another business's campaign id
  const c = await send({})
  const rows = Object.fromEntries(db.sql.prepare('SELECT lead_id, source, campaign_id, details FROM lead_attribution').all().map((r) => [r.lead_id, r]))
  assert.deepEqual([rows[a.leadId].source, rows[a.leadId].campaign_id, JSON.parse(rows[a.leadId].details).gclid], ['google_ads', 'camp-pools', 'present'])
  assert.deepEqual([rows[b.leadId].source, rows[b.leadId].campaign_id], ['booking_page', null], 'never credited to another business’s campaign')
  assert.ok(!JSON.stringify(rows).includes('Cj0KCQiA'), 'the click id itself is not stored (conversion reporting off)')
  assert.equal(rows[c.leadId].source, 'booking_page')
  // The website keeps the parameters on the chat link (escaped) for the receptionist.
  assert.match(chatLink('https://getshowups.com/chat/pools?utm_source=google&utm_campaign=camp-pools'), /href="https:\/\/getshowups\.com\/chat\/pools\?utm_source=google&amp;utm_campaign=camp-pools"/)
})

test('attribution through the AI receptionist: the conversation keeps campaign parameters only (never a click id); its lead is credited when it books', async () => {
  const kept = keepableAttribution({ utm_source: 'google', utm_campaign: 'camp-pools', gclid: 'Cj0KCQiA1234567890abc', evil: '<x>' })
  assert.deepEqual(kept, { utm_source: 'google', utm_campaign: 'camp-pools', gclidPresent: true })
  assert.equal(keepableAttribution({ utm_campaign: '<script>' }), null)
  const c = await startConversation(env, cust('pools'), 'chat', NOW, { attribution: { utm_source: 'google', utm_campaign: 'camp-pools', gclid: 'Cj0KCQiA1234567890abc' } })
  const conv = await loadConversation(env, cust('pools'), c.id)
  assert.deepEqual(conv.state.attribution, kept)
  assert.ok(!JSON.stringify(conv.state).includes('Cj0KCQiA'))
  // What the engine records when that conversation creates its lead.
  const id = lead('pools', { ad: false })
  await recordAttribution(env, 'pools', id, conv.state.attribution, NOW)
  const row = db.sql.prepare('SELECT source, campaign_id, details FROM lead_attribution WHERE lead_id = ?').get(id)
  assert.deepEqual([row.source, row.campaign_id, JSON.parse(row.details).gclid], ['google_ads', 'camp-pools', 'present'])
})
