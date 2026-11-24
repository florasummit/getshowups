// Acceptance of the dashboard assistant and insights: deterministic signals, dismissal, evidence, prepared changes,
// general questions, isolation, no model where none is needed.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as api from '../functions/api/dashboard/assist.js'
import * as insightsApi from '../functions/api/dashboard/insights.js'
import * as proposalApi from '../functions/api/dashboard/proposal.js'
import { helpFor, isSensitive, periodIn, wantsFunnel } from '../server/assist.js'
import { insights } from '../server/insights.js'
import { wantsServiceArea } from '../server/proposals.js'
import { runTool, toolContext } from '../server/operator-tools.js'
import { businessFacts } from '../server/followups/engine.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'

const ORIGIN = 'https://getshowups.com'
let db, env, calls, reply, cookies, realError
beforeEach(async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  db = { sql, prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) }
  calls = []
  reply = () => ({ response: { kind: 'business', answer: 'Check your booking hours in Settings first.' }, usage: { prompt_tokens: 300, completion_tokens: 20 } })
  env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null }, AI: { run: async (m, b) => (calls.push(b), reply(b)) } }
  cookies = {}
  for (const id of ['alpha', 'beta', 'unpaid']) {
    sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, 1, 1)").run(id, `${id} co`)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`o@${id}.example`, id)
    const token = `tok_${id}`.padEnd(43, 'x')
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), `o@${id}.example`, Date.now(), Date.now() + 864e5)
    cookies[id] = `__Host-gsu_session=${token}`
    sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '', 'Pool service', ?, '[]', '[]', 1)").run(id, `secret-${id}`)
  }
  sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at) VALUES ('unpaid', 'founding', 1)").run()
  realError = console.error
  console.error = () => {}
})
afterEach(() => (console.error = realError))
const post = async (id, body, origin = ORIGIN) => {
  const r = await api.onRequestPost({ env, request: new Request(`${ORIGIN}/api/dashboard/assist`, { method: 'POST', headers: { Origin: origin, ...(id ? { Cookie: cookies[id] } : {}) }, body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json() }
}

const DAY = 864e5
const call = async (mod, id, body, origin = ORIGIN) => {
  const r = await mod.onRequestPost({ env, request: new Request(`${ORIGIN}/x`, { method: 'POST', headers: { Origin: origin, ...(id ? { Cookie: cookies[id] } : {}) }, body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json() }
}
const get = async (id) => (await (await insightsApi.onRequestGet({ env, request: new Request(`${ORIGIN}/x`, { headers: { Cookie: cookies[id] } }) })).json()).insights
const who = async (id) => customerFromRow(await getCustomer(db, id))
let n = 0
const lead = (c, { ago = 2, status = 'new', zip = '', outside = false, thread = false } = {}) => {
  const id = `l${n++}`
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Jane Doe', ?, '8435550100', 'Private need', ?, ?, 'x', ?, 1)").run(id, c, `${id}@x.example`, zip, outside ? 'unqualified' : status, Date.now() - ago * DAY)
  if (outside) db.sql.prepare("INSERT INTO coverage_requests (lead_id, customer, zip, zip_check, status, created_at) VALUES (?, ?, ?, 'outside', 'pending', ?)").run(id, c, zip, Date.now() - ago * DAY)
  if (thread) db.sql.prepare("INSERT INTO lead_threads (lead_id, customer, source, stage, created_at, updated_at) VALUES (?, ?, 'website_form', 'new', 1, 1)").run(id, c)
  return id
}
const zips = (c, v) => db.sql.prepare('UPDATE customers SET service_zips = ? WHERE id = ?').run(v, c)
const ids = async (id) => (await get(id)).map((x) => x.id)

test('signals are deterministic, need evidence, hold no personal data, and never call a model', async () => {
  zips('alpha', '29401,29403')
  assert.deepEqual(await get('alpha'), [])
  lead('alpha', { outside: true, zip: '29464' })
  lead('alpha', { outside: true, zip: '29464' })
  assert.deepEqual(await ids('alpha'), []) // two is too few
  lead('alpha', { outside: true, zip: '29412' })
  lead('alpha', { thread: true, ago: 3 })
  lead('alpha', { thread: true, ago: 0.2 }) // too recent to nag about
  lead('alpha', { thread: true, ago: 40 }) // too old
  const list = await get('alpha')
  assert.deepEqual(list.map((x) => x.id), ['unanswered', 'outside_area'])
  assert.match(list[0].title, /^1 person asked/)
  assert.match(list[1].evidence[0], /29464 \(2\), 29412 \(1\)/)
  db.sql.prepare("INSERT INTO ops_incidents (id, fingerprint, customer, feature, journey, step, kind, code, severity, cause, status, first_seen, last_seen, detected_at) VALUES ('i', 'f', 'alpha', 'calendar.google', 'booking', 'availability', 'calendar', 'x', 'critical', 'unknown', 'open', 1, 1, 1)").run()
  db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, updated_at) VALUES ('alpha', 1, 1)").run()
  assert.deepEqual(await ids('alpha'), ['calendar', 'unanswered', 'outside_area', 'no_services'])
  assert.deepEqual(await ids('beta'), [])
  assert.doesNotMatch(JSON.stringify(await get('alpha')), /Jane|Private|8435550100|@/)
  assert.equal(calls.length, 0)
  env.AI_INSIGHTS_ENABLED = 'false'
  assert.deepEqual(await get('alpha'), [])
})

test('a running campaign with nothing reported is a data gap, not a claim about spend', async () => {
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, launched_at, created_at, updated_at) VALUES ('k', 'alpha', 'google', 'active', '{}', 1000, ?, 1, 1)").run(Date.now() - 10 * DAY)
  const it = (await get('alpha')).find((x) => x.id === 'ads_gap')
  assert.match(it.evidence.join(' '), /doesn’t mean nothing was spent/)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, clicks, fetched_at) VALUES ('k', 'alpha', ?, 0, 0, 1)").run(new Date(Date.now() - DAY).toISOString().slice(0, 10))
  assert.deepEqual(await ids('alpha'), [])
})

test('dismissal: hidden until the cooldown or clearly more evidence; only true insights; per business; same origin', async () => {
  for (const c of ['alpha', 'beta']) lead(c, { thread: true })
  assert.equal((await call(insightsApi, 'alpha', { id: 'unanswered', kind: 'dismiss' }, 'https://evil.example')).status, 403)
  assert.equal((await call(insightsApi, null, { id: 'unanswered', kind: 'dismiss' })).status, 401)
  for (const b of [{ id: 'calendar', kind: 'dismiss' }, { id: 'unanswered', kind: 'forever' }, {}]) assert.equal((await call(insightsApi, 'alpha', b)).status, 400)
  assert.equal((await call(insightsApi, 'alpha', { id: 'unanswered', kind: 'snooze', level: 999 })).status, 200)
  assert.deepEqual([await ids('alpha'), await ids('beta')], [[], ['unanswered']])
  lead('alpha', { thread: true })
  assert.deepEqual(await ids('alpha'), []) // a little more is not news
  for (let i = 0; i < 3; i++) lead('alpha', { thread: true })
  assert.deepEqual(await ids('alpha'), ['unanswered'])
  await call(insightsApi, 'alpha', { id: 'unanswered', kind: 'snooze' })
  assert.deepEqual((await insights(env, await who('alpha'), Date.now() + 2.9 * DAY)).map((x) => x.id), [])
  assert.deepEqual((await insights(env, await who('alpha'), Date.now() + 3.1 * DAY)).map((x) => x.id), ['unanswered'])
})

test('cross-feature: without the model the records are still shown, with what they can’t show, for the period asked', async () => {
  for (let i = 0; i < 4; i++) lead('alpha')
  lead('beta')
  reply = () => { throw new Error('x') }
  const ask = (question) => post('alpha', { question, view: 'overview' })
  const r = await ask('Why are they not booking?')
  assert.equal(r.status, 503)
  const w = await ask('Why are my jobs not getting booked by customers?')
  assert.match(w.body.evidence.known[0], /^4 inquiries in the last 30 days/)
  assert.match(w.body.evidence.unknown.join(' '), /too few to judge a rate.*isn’t recorded/)
  assert.match((await ask('Why did customers not book in the last 90 days?')).body.evidence.known[0], /last 90 days/)
})

test('booking hours are real times, never NaN', async () => {
  for (const [from, to, want] of [['09:00', '17:30', '9:00 AM–5:30 PM'], ['00:00', '12:00', '12:00 AM–12:00 PM'], ['06:05', '22:00', '6:05 AM–10:00 PM']]) {
    db.sql.prepare("UPDATE customers SET day_start = ?, day_end = ?, workdays = '1,2' WHERE id = 'alpha'").run(from, to)
    assert.equal((await businessFacts(env, await who('alpha'))).hours, `Mon, Tue ${want}`)
  }
})

test('money: recorded payments and the ad-traced part are told apart, per period and business; nothing is credited to ads', async () => {
  db.sql.exec('PRAGMA foreign_keys = OFF')
  const job = (c, ago, cents, ad) => {
    const id = lead(c, { ago, status: 'booked' })
    if (ad) db.sql.prepare("INSERT INTO lead_attribution (lead_id, customer, source, created_at) VALUES (?, ?, 'google_ads', 1)").run(id, c)
    db.sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 'showed', ?, 1, 1)").run(`a${id}`, c, id, n, `e${id}`)
    if (cents) db.sql.prepare("INSERT INTO revenue_entries (customer, appointment_id, kind, amount_cents, recorded_by, recorded_at) VALUES (?, ?, 'paid', ?, 'ref:x', 1)").run(c, `a${id}`, cents)
  }
  job('alpha', 3, 16000, true)
  job('alpha', 4, 25000, false)
  job('alpha', 20, 9000, false)
  job('alpha', 5, null, true)
  job('beta', 3, 777700, true)
  const q = { question: 'How much revenue did my advertising generate?', view: 'overview' }
  reply = () => { throw new Error('x') }
  const r = await post('alpha', q)
  assert.equal(r.status, 503)
  assert.deepEqual(r.body.evidence.known, ['Payments you recorded for inquiries of the last 30 days: $500.', 'Of those, for jobs from leads traced to your ads: $160.', 'Ad spend Google reported: none reported.'])
  assert.match(r.body.evidence.unknown.join(' '), /caused isn’t measured.*2 of 4 inquiries.*1 of 4 visits/)
  assert.match((await post('alpha', { ...q, days: 7, view: 'ads' })).body.evidence.known[0], /last 7 days: \$410\./)
  const f = await runTool(toolContext(env, await who('alpha'), {}), 'explain_funnel', {})
  assert.deepEqual([f.payments_recorded_for_all, f.ads.payments_recorded_for_traced_jobs, f.ads.spend_reported], ['$500', '$160', 'none reported'])
  assert.doesNotMatch(JSON.stringify(f), /7777/)
})

test('legal, tax and money questions carry a caution', () => {
  assert.equal(isSensitive('Can I lie about my LLC?'), true)
  assert.equal(isSensitive('Can I deduct my truck on taxes?'), true)
  assert.equal(isSensitive('How do I ask for reviews?'), false)
})

test('a definition needs no model and no allowance', async () => {
  zips('alpha', '29401')
  const r = await post('alpha', { question: 'What is ad spend?' })
  assert.deepEqual([r.status, r.body.kind], [200, 'help'])
  assert.equal(helpFor('What is the weather?'), null)
  assert.equal(calls.length, 0)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'aiAsk:%'").get().n, 0)
})

test('service area: grounded proposal, nothing changes until approved, stale and forged approvals refused, audited', async () => {
  zips('alpha', '29401,29403')
  const list = () => db.sql.prepare("SELECT service_zips AS z FROM customers WHERE id = 'alpha'").get().z
  reply = () => { throw new Error('x') } // the model is down: the same change is prepared by code
  const ask = async (question) => {
    db.sql.exec('DELETE FROM rate_limits')
    return (await post('alpha', { question })).body
  }
  assert.match((await ask('Help me improve my service area')).answer, /nothing to suggest/)
  lead('alpha', { outside: true, zip: '29464' })
  assert.match((await ask('Help me improve my service area')).answer, /too little/)
  lead('alpha', { outside: true, zip: '29464' })
  const p = (await ask('Help me improve my service area')).proposals[0]
  assert.deepEqual([p.before, p.after, p.add, p.remove], [['29401', '29403'], ['29401', '29403', '29464'], ['29464'], []])
  assert.match(p.why, /2 inquiries from 29464/)
  assert.equal(list(), '29401,29403')
  // The owner's own instruction, adding and removing; unknown ZIPs are left out and said so.
  const own = (await ask('Please add 29412 and remove 29403 from my zip codes')).proposals[0]
  assert.deepEqual([own.add, own.remove], [['29412'], ['29403']])
  assert.match((await ask('add 00001 to my zips')).answer, /isn’t a ZIP code we recognise/)
  assert.match((await ask('remove 29401 and remove 29403 zips')).answer, /isn’t suggested/)
  const ok = { type: p.type, before: p.before, after: p.after, confirm: true }
  assert.equal((await call(proposalApi, null, ok)).status, 401)
  assert.equal((await call(proposalApi, 'alpha', ok, 'https://evil.example')).status, 403)
  assert.equal((await call(proposalApi, 'unpaid', ok)).status, 404)
  // Another business can't apply it to this one, and its own list doesn't match.
  assert.deepEqual(await call(proposalApi, 'beta', { ...ok, customer: 'alpha' }), { status: 409, body: { error: 'stale' } })
  for (const bad of [{ ...ok, confirm: undefined }, { ...ok, type: 'hours' }, { ...ok, after: [] }, { ...ok, after: ['29464', '29464'] }, { ...ok, after: [...p.before, "29464'; DROP TABLE"] }, { ...ok, after: [...p.before, '00001'] }, { ...ok, after: p.before }, null]) assert.equal((await call(proposalApi, 'alpha', bad)).status, 400)
  assert.equal(list(), '29401,29403')
  assert.deepEqual(await call(proposalApi, 'alpha', ok), { status: 200, body: { ok: true, serviceZips: p.after } })
  assert.equal(list(), '29401,29403,29464')
  assert.deepEqual((await call(proposalApi, 'alpha', ok)).body, { error: 'stale' })
  const ev = db.sql.prepare("SELECT details, actor FROM audit_log WHERE action = 'business.service_zips'").all()
  assert.equal(ev.length, 1)
  assert.doesNotMatch(JSON.stringify(ev), /@|29464/)
  // An unlimited area is never narrowed by "adding".
  zips('alpha', '')
  assert.match((await ask('add 29464 to my zips')).answer, /stop everyone else/)
})

test('periods and intents named in plain words', () => {
  assert.deepEqual([periodIn('last week'), periodIn('in 90 days'), periodIn('hello')], [7, 90, null])
  assert.equal(wantsFunnel('Why are my leads not becoming booked jobs?'), true)
  assert.equal(wantsServiceArea('What is my service area?'), false)
})
