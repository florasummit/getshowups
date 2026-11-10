// Self-serve onboarding: Get started → business on the founding plan → payment gate (Stripe webhook
// decides) → details → services → calendar → hours → page → test → launch. Legacy businesses keep their
// three-step setup and are never asked to pay. node:sqlite D1, Map KV, mocked Google; no network.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { normalizePhone, validateProfile } from '../server/onboarding.js'
import * as me from '../functions/api/dashboard/me.js'
import * as business from '../functions/api/dashboard/business.js'
import * as profile from '../functions/api/dashboard/profile.js'
import * as onboarding from '../functions/api/dashboard/onboarding.js'
import * as hours from '../functions/api/dashboard/hours.js'
import * as landing from '../functions/api/dashboard/landing.js'
import * as publicPage from '../functions/api/page/[customer].js'
import * as webhook from '../functions/api/stripe/webhook.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const WHSEC = 'whsec_test_onboarding'
let env, db, kv, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
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
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, params, origin = ORIGIN, path = '/x', raw, headers = {} } = {}) {
  const h = { ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}${path}`, { method, headers: h, body: raw ?? (body && JSON.stringify(body)) }), env, params })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text || 'null') }
}
async function deliver(event) {
  const raw = JSON.stringify({ livemode: false, ...event })
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))), (b) => b.toString(16).padStart(2, '0')).join('')
  return call(webhook, 'POST', { raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, origin: null })
}
const activate = (customer, status = 'active') =>
  deliver({ id: `evt_${customer}_${status}`, type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), data: { object: { id: `sub_${customer}`, customer: `cus_${customer}`, status, metadata: { customer }, currency: 'usd', cancel_at_period_end: false, items: { data: [{ quantity: 1, current_period_end: 1900000000, price: { id: 'price_FOUNDING', unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] } } } })
const stepsOf = async (cookie) => Object.fromEntries((await call(me, 'GET', { cookie })).json.progress.steps.map((s) => [s.id, s.done]))

beforeEach(() => {
  db = d1()
  kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: WHSEC,
  }
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'GetShowUps Founding', 'price_FOUNDING', 0, '{}', 1, 1)").run()
  origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy' }))
    if (u.endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }))
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function newSignup(email = 'owner@newpools.example', name = 'New Pools') {
  const cookie = await cookieFor(email)
  const first = await call(me, 'GET', { cookie, path: '/api/dashboard/me?plan=founding' })
  assert.deepEqual(first.json.signupPlan, { id: 'founding', name: 'GetShowUps Founding', trialDays: 0 })
  const r = await call(business, 'POST', { cookie, body: { name, timezone: 'America/New_York', serviceZips: '', plan: 'founding' } })
  assert.equal(r.status, 201)
  return { cookie, id: r.json.id }
}
async function connectCalendar(id) {
  kv.set(`google:${id}`, JSON.stringify({ customer: id, refreshToken: await encrypt(env, '1//rt'), scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', email: 'cal@example.com' }))
}

test('get started: name only creates the business on the founding plan; payment comes before anything else', async () => {
  const { cookie, id } = await newSignup()
  assert.equal(db.sql.prepare('SELECT plan_id FROM self_signups WHERE customer = ?').get(id).plan_id, 'founding')
  const p = (await call(me, 'GET', { cookie })).json.progress
  assert.equal(p.selfServe, true)
  assert.equal(p.billing, 'required')
  assert.deepEqual(p.steps.map((s) => s.id), ['business', 'payment', 'details', 'services', 'calendar', 'hours', 'page', 'test', 'launch'])
  assert.deepEqual(p.steps.filter((s) => s.done).map((s) => s.id), ['business'])
  // Same account cannot create a second business.
  assert.equal((await call(business, 'POST', { cookie, body: { name: 'Again', timezone: 'America/New_York', serviceZips: '' } })).status, 200, 'second POST updates the same business')
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customers').get().n, 1)
})

test('payment step is completed only by a verified Stripe webhook; past_due keeps access, canceled does not', async () => {
  const { cookie, id } = await newSignup()
  assert.equal((await stepsOf(cookie)).payment, false)
  await activate(id)
  assert.equal((await stepsOf(cookie)).payment, true)
  await activate(id, 'past_due')
  assert.equal((await stepsOf(cookie)).payment, true, 'grace while Stripe retries')
  await deliver({ id: 'evt_del', type: 'customer.subscription.deleted', created: Math.floor(Date.now() / 1000) + 5, data: { object: { id: `sub_${id}`, customer: `cus_${id}`, status: 'canceled', metadata: { customer: id }, items: { data: [] } } } })
  assert.equal((await stepsOf(cookie)).payment, false, 'ended before finishing onboarding → reactivate first')
  db.sql.prepare('UPDATE self_signups SET onboarded_at = 1 WHERE customer = ?').run(id)
  assert.equal((await stepsOf(cookie)).payment, true, 'after onboarding the owner keeps their dashboard; billing shows as a notice')
  const r = (await call(onboarding, 'GET', { cookie })).json.readiness
  assert.deepEqual([r.items[0].id, r.items[0].state, r.items[0].detail, r.next], ['subscription', 'action', 'canceled', 'subscription'])
})

test('legacy businesses (no self-serve signup) are never asked to pay or do the new steps', async () => {
  delete env.STRIPE_SECRET_KEY
  const cookie = await cookieFor('owner@legacy.example')
  assert.equal((await call(me, 'GET', { cookie, path: '/api/dashboard/me?plan=founding' })).json.signupPlan, null, 'billing off → no plan offered')
  const r = await call(business, 'POST', { cookie, body: { name: 'Legacy Co', timezone: 'America/New_York', serviceZips: '' } })
  const p = (await call(me, 'GET', { cookie })).json.progress
  assert.deepEqual([p.selfServe, p.billing, p.steps.map((s) => s.id)], [false, 'not_required', ['business', 'calendar', 'hours']])
  assert.equal(db.sql.prepare('SELECT count(*) n FROM self_signups WHERE customer = ?').get(r.json.id).n, 0)
  assert.equal((await call(onboarding, 'POST', { cookie, body: { action: 'finish' } })).status, 409)
})

test('profile: validation, phone formatting, claims filter, and tenant isolation', async () => {
  assert.equal(normalizePhone('843.555.0123'), '(843) 555-0123')
  assert.equal(normalizePhone('+1 843 555 0123'), '(843) 555-0123')
  assert.equal(normalizePhone('555-0123'), null)
  assert.deepEqual(validateProfile({ industry: 'Pool service', description: 'Best in Charleston, satisfaction guaranteed' })[0], ['description:unapproved_claim'])
  assert.deepEqual(validateProfile({ industry: 'Pool service', services: [{ name: 'Cleaning', price: '50% off' }] })[0], ['services:unapproved_claim'])
  assert.deepEqual(validateProfile({ industry: '' }, { requireServices: true })[0], ['industry', 'services'])
  const a = await newSignup()
  const b = await newSignup('owner@other.example', 'Other Co')
  assert.equal((await call(profile, 'POST', { cookie: a.cookie, body: { industry: 'Pool service', phone: 'abc' } })).json.fields[0], 'phone')
  assert.equal((await call(profile, 'POST', { cookie: a.cookie, origin: 'https://evil.example', body: { industry: 'x' } })).status, 403)
  assert.equal((await call(profile, 'POST', { cookie: a.cookie, body: { industry: 'Pool service', phone: '8435550123', cities: 'Charleston, Mount Pleasant', services: [{ name: 'Weekly pool cleaning', price: 'From $150/month' }] } })).status, 200)
  assert.equal((await call(profile, 'GET', { cookie: b.cookie })).json.profile, null, 'other business sees nothing')
  assert.equal((await call(profile, 'GET', {})).status, 401)
})

test('full self-serve journey: steps advance from saved data; finish requires the core steps; page drafted from profile', async () => {
  const { cookie, id } = await newSignup()
  assert.equal((await call(onboarding, 'POST', { cookie, body: { action: 'finish' } })).json.missing.length, 6)
  await activate(id)
  await call(profile, 'POST', { cookie, body: { industry: 'Pool service', phone: '(843) 555-0123', cities: ['Charleston'], description: 'Family-run pool care across Charleston.' } })
  assert.deepEqual(await stepsOf(cookie), { business: true, payment: true, details: true, services: false, calendar: false, hours: false, page: false, test: false, launch: false })
  await call(profile, 'POST', { cookie, body: { industry: 'Pool service', phone: '(843) 555-0123', cities: ['Charleston'], description: 'Family-run pool care across Charleston.', services: [{ name: 'Weekly pool cleaning', price: 'From $150/month' }, { name: 'Green pool cleanup', price: '' }], requireServices: true } })
  await connectCalendar(id)
  assert.equal((await call(onboarding, 'POST', { cookie, body: { action: 'check_availability' } })).json.error, 'hours_required')
  assert.equal((await call(hours, 'POST', { cookie, body: { workdays: [1, 2, 3, 4, 5], dayStart: '08:00', dayEnd: '17:00', slotMinutes: 60 } })).status, 200)
  const draft = (await call(landing, 'GET', { cookie })).json.page
  assert.equal(draft.headline, 'Weekly pool cleaning in Charleston')
  assert.equal(draft.intro, 'Family-run pool care across Charleston.')
  assert.deepEqual(draft.services, ['Weekly pool cleaning · From $150/month', 'Green pool cleanup'])
  // Draft saved privately: page step done, page still not public.
  await call(landing, 'POST', { cookie, body: { ...draft, publish: false } })
  assert.equal((await call(publicPage, 'GET', { params: { customer: id } })).status, 404)
  const avail = await call(onboarding, 'POST', { cookie, body: { action: 'check_availability' } })
  assert.equal(avail.json.status, 'ok')
  assert.ok(avail.json.slots > 0)
  await call(onboarding, 'POST', { cookie, body: { action: 'tested' } })
  assert.equal((await call(onboarding, 'POST', { cookie, body: { action: 'finish' } })).status, 200)
  const p = (await call(me, 'GET', { cookie })).json.progress
  assert.equal(p.complete, true)
  // Publishing (explicit) makes the page public with the business phone.
  await call(landing, 'POST', { cookie, body: { ...draft, publish: true } })
  const pub = await call(publicPage, 'GET', { params: { customer: id } })
  assert.deepEqual([pub.status, pub.json.phone], [200, '(843) 555-0123'])
})

test('readiness is honest: messaging activating, SMS and ads not available, next action points at what is missing', async () => {
  const { cookie, id } = await newSignup()
  await activate(id)
  await connectCalendar(id)
  const r = (await call(onboarding, 'GET', { cookie })).json.readiness
  const by = Object.fromEntries(r.items.map((i) => [i.id, [i.state, i.detail ?? null]]))
  assert.deepEqual(by.subscription, ['ok', 'active'])
  assert.deepEqual(by.calendar, ['ok', 'healthy'])
  assert.deepEqual(by.hours, ['action', null])
  assert.deepEqual(by.email, ['pending', 'activating'])
  assert.deepEqual(by.sms, ['off', 'not_available_yet'])
  assert.deepEqual(by.ads, ['off', 'not_available_yet'])
  assert.equal(r.next, 'hours')
  env.MESSAGES_LIVE = 'true'
  assert.deepEqual(Object.fromEntries((await call(onboarding, 'GET', { cookie })).json.readiness.items.map((i) => [i.id, i.state])).email, 'ok')
})

test('admin attention: abandoned checkout, scheduled cancellation and ended subscription are flagged', async () => {
  const { customerRows } = await import('../server/metrics.js')
  const a = await newSignup('a@x.example', 'Abandoned Co')
  const b = await newSignup('b@x.example', 'Leaving Co')
  const c = await newSignup('c@x.example', 'Ended Co')
  db.sql.prepare('UPDATE customers SET created_at = ? WHERE id IN (?, ?, ?)').run(Date.now() - 3 * 864e5, a.id, b.id, c.id)
  db.sql.prepare("INSERT INTO subscriptions (customer, status, cancel_at_period_end, updated_at) VALUES (?, 'active', 1, 1), (?, 'canceled', 0, 1)").run(b.id, c.id)
  const rows = Object.fromEntries((await customerRows(env)).map((r) => [r.id, r.attention]))
  assert.ok(rows[a.id].includes('checkout_abandoned'))
  assert.ok(rows[b.id].includes('cancel_scheduled') && !rows[b.id].includes('checkout_abandoned'))
  assert.ok(rows[c.id].includes('subscription_ended'))
})
