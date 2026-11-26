// Admin → Growth (server/growth.js, server/growth-model.js, /api/platform/growth): measured figures labelled by kind
// with samples, test businesses and test leads excluded; the simulator is pure arithmetic over assumptions prefilled
// only from big-enough samples; Decide judges rates only with minimum samples and never recommends spend; the route is
// admin-only and read-only. Real handlers + migrations on node:sqlite; nothing external.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { growthMeasure, decide, listedPriceCents, MIN, THRESHOLDS } from '../server/growth.js'
import { baselineFrom, compare, monthlyFunnel, normalizeAssumptions, project, sensitivity, DEFAULTS, FIELDS } from '../server/growth-model.js'
import * as route from '../functions/api/platform/growth.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86400000
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q) }
}
let env, db
const now = Date.now()
beforeEach(() => {
  db = d1()
  env = { ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/x`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: 'founder@getshowups.com', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' }
  const biz = (id, name) => {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?, ?)").run(id, name, now - 40 * DAY, now - 40 * DAY, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  }
  biz('getshowups', 'GetShowUps')
  biz('pools', 'Pools Co')
  biz('testco', 'Test Co')
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('testco', 1, 'founder', 1)").run()
  const lead = (id, customer, status, email = `${id}@example.net`) => db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'P', ?, '843-555-0100', 'x', '29401', ?, ?, ?, ?)").run(id, customer, email, status, `h${id}`, now - DAY, now)
  for (let i = 0; i < 12; i++) lead(`s${i}`, 'getshowups', i < 9 ? 'new' : 'unqualified')
  for (let i = 0; i < 3; i++) lead(`sb${i}`, 'getshowups', 'booked')
  lead('internal', 'getshowups', 'booked', 'me@getshowups.com') // internal address: never counted
  for (let i = 0; i < 4; i++) lead(`p${i}`, 'pools', 'new')
  for (let i = 0; i < 20; i++) lead(`t${i}`, 'testco', 'booked') // test business: never counted
  let slot = 0 // distinct start times: the double-booking guard is a UNIQUE index on (customer, start_at)
  const appt = (id, customer, leadId, status) => db.sql.prepare('INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, customer, leadId, now - DAY + slot * 3600000, now - DAY + slot++ * 3600000 + 1200000, status, `ev${id}`, now - DAY, now)
  appt('a0', 'getshowups', 'sb0', 'showed')
  appt('a1', 'getshowups', 'sb1', 'no_show')
  appt('a2', 'getshowups', 'sb2', 'booked')
  appt('ai', 'getshowups', 'internal', 'showed')
  for (const [id, customer] of [['c1', 'pools'], ['c2', 'testco']]) db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', 'active', '{}', 1000, ?, ?, ?)").run(id, customer, `g${id}`, now - 5 * DAY, now)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES ('c1', 'pools', ?, 1200, 10, 2, 0, ?), ('c2', 'testco', ?, 99999, 10, 2, 0, ?)").run(new Date(now - DAY).toISOString().slice(0, 10), now, new Date(now - DAY).toISOString().slice(0, 10), now)
})
async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}

test('measure: every figure has a kind and a sample; test businesses, test leads and internal addresses are excluded; test-mode billing is never revenue; spend only when synced', async () => {
  const m = await growthMeasure(env, now)
  const by = Object.fromEntries(m.items.map((i) => [i.key, i]))
  assert.equal(m.billingMode, 'test')
  for (const it of m.items) assert.ok(['live', 'test', 'estimated', 'unavailable'].includes(it.kind), it.key)
  assert.deepEqual([by.leads.value, by.qualifiedLeads.value], [19, 16], 'getshowups 15 + pools 4; the internal lead and the test business never count')
  assert.deepEqual([by.salesLeads.value, by.consultationsBooked.value, by.consultationsAttended.value], [15, 3, 1])
  assert.deepEqual([by.payingCustomers.kind, by.payingCustomers.value, by.mrr.kind, by.mrr.value], ['test', 0, 'unavailable', null])
  assert.deepEqual([by.spend.kind, by.spend.value], ['live', 1200], 'the test business’s spend is excluded')
  assert.equal(by.cac.kind, 'unavailable')
  // GROW-04: a customer's ad spend (pools, $12) is never GetShowUps' acquisition spend; only the sales business's own is.
  assert.deepEqual(m.measured, { leads30: 15, qualified30: 12, booked30: 3, attended30: 1, closed30: null, spend30Cents: null, payingCustomers: null, mrrCents: null, priceMonthlyCents: 49900 })
  assert.equal(baselineFrom(m.measured).sources.spendPerMonthCents, 'assumption')
  assert.deepEqual([by.ownSpend.kind, by.ownSpend.value], ['unavailable', null])
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES ('c0', 'getshowups', 'google', 'active', '{}', 1000, 'gc0', ?, ?)").run(now - 5 * DAY, now)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES ('c0', 'getshowups', ?, 700, 10, 2, 0, ?)").run(new Date(now - DAY).toISOString().slice(0, 10), now)
  const own = await growthMeasure(env, now)
  assert.equal(own.measured.spend30Cents, 700, 'GetShowUps’ own campaigns only')
  assert.equal(baselineFrom(own.measured).sources.spendPerMonthCents, 'measured')
  assert.equal(own.items.find((i) => i.key === 'ownSpend').value, 700)
  // GROW-09: two groups; nothing an admin reads carries a switch name, a "(s)" plural or an engineering phrase.
  assert.deepEqual([...new Set(m.items.map((i) => i.group))], ['customers', 'sales'])
  assert.deepEqual(m.items.filter((i) => i.group === 'customers').map((i) => i.key), ['leads', 'qualifiedLeads', 'bookingConversion', 'spend'])
  for (const it of [...m.items, ...own.items]) assert.doesNotMatch(`${it.label} ${it.note || ''}`, /[A-Z]{3,}_[A-Z_]{3,}|\(s\)|\(es\)|tables? (is|are) missing|\bcents\b|Stripe/, it.key)
  // ADM-02: the same billing and retention facts the Overview reads.
  assert.deepEqual([m.billing, m.retention30 === by.retention.value], [null, true])
  assert.equal(listedPriceCents(), 49900)
  assert.ok(!JSON.stringify(m).includes('@'), 'no addresses')
})

test('model: arithmetic, clamping, projection with churn, sensitivity order, baseline prefill only with enough sample', () => {
  const a = normalizeAssumptions({ leadsPerMonth: 100, qualificationRate: 0.5, bookingRate: 0.5, attendanceRate: 0.8, closeRate: 0.25, spendPerMonthCents: 100000, priceMonthlyCents: 49900, monthlyChurn: 0, existingMrrCents: 0, existingCustomers: 0, months: 3 })
  const f = monthlyFunnel(a)
  assert.deepEqual([f.qualified, f.booked, f.attended, f.newCustomers, f.newMrrCents, f.cacCents, Math.round(f.paybackMonths * 100) / 100], [50, 25, 20, 5, 249500, 20000, 0.4])
  const p = project(a)
  assert.deepEqual([p.endCustomers, p.endMrrCents, p.totalSpendCents], [15, 748500, 300000])
  const churned = project({ ...a, monthlyChurn: 0.5, existingCustomers: 8, existingMrrCents: 0 }).months.map((r) => r.customers)
  assert.deepEqual(churned, [9, 9.5, 9.75])
  // Clamping and strings from form fields.
  const c = normalizeAssumptions({ leadsPerMonth: '-5', qualificationRate: '2', months: 99, priceMonthlyCents: 'abc' })
  assert.deepEqual([c.leadsPerMonth, c.qualificationRate, c.months, c.priceMonthlyCents], [0, 1, 36, DEFAULTS.priceMonthlyCents])
  const s = sensitivity(a)
  assert.equal(s.length, 4)
  assert.ok(s.every((x, i) => i === 0 || Math.abs(x.upDelta) <= Math.abs(s[i - 1].upDelta)), 'sorted by effect')
  const cmp = compare(a, { ...a, closeRate: 0.35 })
  assert.deepEqual([cmp.changed, Math.round(cmp.delta.newCustomersPerMonth * 100) / 100], [['closeRate'], 2])
  // Baseline: a rate is measured only with the minimum sample; later stages need their own.
  const b1 = baselineFrom({ leads30: 15, qualified30: 12, booked30: 3, attended30: 1, closed30: null, spend30Cents: 1200, priceMonthlyCents: 49900 })
  assert.deepEqual([b1.sources.leadsPerMonth, b1.sources.qualificationRate, b1.sources.bookingRate, b1.sources.attendanceRate, b1.sources.closeRate], ['measured', 'measured', 'measured', 'assumption', 'assumption'])
  assert.deepEqual([b1.assumptions.leadsPerMonth, b1.assumptions.qualificationRate, b1.assumptions.bookingRate, b1.assumptions.attendanceRate], [15, 0.8, 0.25, DEFAULTS.attendanceRate])
  const b0 = baselineFrom({ leads30: 4, qualified30: 4 })
  assert.equal(Object.values(b0.sources).filter((x) => x === 'measured').length, 0)
  assert.equal(Object.keys(FIELDS).length, Object.keys(DEFAULTS).length)
})

test('decide: too few leads → volume experiment (no spend); a stage below threshold with enough cases → that experiment with modeled upside; all good → keep measuring', () => {
  const base = { range: {}, measured: { leads30: 4 } }
  const d0 = decide(base)
  assert.deepEqual([d0.bottleneck, d0.evidence, d0.upside], ['volume', 'insufficient', null])
  assert.doesNotMatch(d0.experiment, /increase (the )?budget|spend more/i)
  assert.match(d0.why, /^4 prospects in 30 days/)
  const d1 = decide({ measured: { leads30: 15, qualified30: 12, booked30: 3, attended30: 1, closed30: null, priceMonthlyCents: 49900 } })
  assert.equal(d1.bottleneck, 'bookingRate', JSON.stringify(d1))
  assert.deepEqual(d1.sample.bookingRate, { num: 3, den: 12, rate: 0.25, threshold: THRESHOLDS.bookingRate })
  assert.ok(d1.upside.newCustomersPerMonth > 0 && d1.upside.newMrrCentsPerMonth > 0)
  assert.equal(d1.evidence, 'weak')
  const d2 = decide({ measured: { leads30: 100, qualified30: 70, booked30: 35, attended30: 30, closed30: 10, priceMonthlyCents: 49900 } })
  assert.deepEqual([d2.bottleneck, d2.evidence], [null, 'strong'])
  const d3 = decide({ measured: { leads30: 12, qualified30: 3, booked30: 1, attended30: 0, closed30: null } })
  assert.equal(d3.bottleneck, 'qualificationRate')
  assert.ok(MIN.leads === 10)
})

test('route: platform admins only; read-only; returns measure + baseline + decide', async () => {
  const get = async (c) => {
    const res = await route.onRequestGet({ request: new Request(`${ORIGIN}/api/platform/growth`, { headers: c ? { Cookie: c } : {} }), env })
    return { status: res.status, json: await res.json() }
  }
  assert.equal((await get()).status, 401)
  assert.equal((await get(await cookie('owner@pools.example'))).status, 403)
  const before = db.sql.prepare('SELECT count(*) AS n FROM audit_log').get().n
  const r = await get(await cookie('founder@getshowups.com'))
  assert.equal(r.status, 200)
  assert.ok(r.json.measure.items.length > 8 && r.json.baseline.assumptions && r.json.decide.title)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM audit_log').get().n, before, 'read-only')
})
