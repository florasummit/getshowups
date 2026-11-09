// Platform operations: admin authorization + audit, invitations / assisted setup, follow-ups + email
// outbox, suspension, Stripe billing (checkout, portal, signed idempotent webhooks), metrics, events.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { monthlyCents, verifySignature } from '../server/stripe.js'
import * as pMe from '../functions/api/platform/me.js'
import * as pOverview from '../functions/api/platform/overview.js'
import * as pCustomer from '../functions/api/platform/customer.js'
import * as pInvites from '../functions/api/platform/invites.js'
import * as pInviteAction from '../functions/api/platform/invite-action.js'
import * as pStatus from '../functions/api/platform/status.js'
import * as pPlans from '../functions/api/platform/plans.js'
import * as invitePeek from '../functions/api/invite.js'
import * as accept from '../functions/api/dashboard/accept-invite.js'
import * as me from '../functions/api/dashboard/me.js'
import * as billing from '../functions/api/dashboard/billing.js'
import * as webhook from '../functions/api/stripe/webhook.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const WHSEC = 'whsec_test_secret'
const SECRETS = ['sk_test_SECRET', WHSEC, 're_SECRET', '1//rt', 'ya29.at', KEY]
const DAY = 864e5

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => {
      if (db.fail?.(q)) throw new Error('D1 unavailable')
      return sql.prepare(q).get(...args) ?? null
    },
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => {
      if (db.fail?.(q)) throw new Error('D1 unavailable')
      const r = sql.prepare(q).run(...args)
      return { meta: { changes: r.changes } }
    },
  })
  const db = {
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
  return db
}

let env, db, kv, fetches, stripe, resend, origFetch, origError, logs, responses

async function connectKv(id) {
  kv.set(`google:${id}`, JSON.stringify({ customer: id, email: `cal@${id}.example`, scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
}
function seed(id, { owner = `owner@${id}.example`, age = 0, hours = true } = {}) {
  const t = Date.now() - age
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, hours ? t : null, t, t)
  if (owner) db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, t)
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    PLATFORM_ADMIN_EMAILS: 'Ops@GetShowUps.com, second@getshowups.com',
  }
  stripe = { checkout: () => [200, { url: 'https://checkout.stripe.com/c/test' }], portal: () => [200, { url: 'https://billing.stripe.com/p/test' }] }
  resend = () => [200, { id: 'email_1' }]
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: 'x' }]
    else if (u.endsWith('/freeBusy')) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u.endsWith('/events?sendUpdates=all')) out = [200, { id: JSON.parse(init.body).id }]
    else if (u === 'https://api.stripe.com/v1/checkout/sessions') out = stripe.checkout(new URLSearchParams(init.body))
    else if (u === 'https://api.stripe.com/v1/billing_portal/sessions') out = stripe.portal(new URLSearchParams(init.body))
    else if (u === 'https://api.resend.com/emails') out = resend(JSON.parse(init.body))
    else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, origin = ORIGIN, body, headers = {}, params, raw } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.5', ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env,
    params,
  })
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, json: () => JSON.parse(text), text }
}
const admin = () => session('ops@getshowups.com')
const auditActions = () => db.sql.prepare('SELECT action FROM admin_audit ORDER BY id').all().map((r) => r.action)

// ---------- platform authorization ----------

test('platform: unauthenticated 401, customers 403, listed admins allowed (case-insensitive)', async () => {
  seed('alpha')
  assert.equal((await call(pMe, 'GET', '/api/platform/me')).status, 401)
  assert.equal((await call(pMe, 'GET', '/api/platform/me', { cookie: await session('owner@alpha.example') })).status, 403)
  const ok = await call(pMe, 'GET', '/api/platform/me', { cookie: await admin() })
  assert.deepEqual(ok.json(), { email: 'ops@getshowups.com', emailConfigured: false, billingConfigured: false })
  assert.equal((await call(pOverview, 'GET', '/api/platform/overview', { cookie: await session('owner@alpha.example') })).status, 403)
  env.PLATFORM_ADMIN_EMAILS = ''
  assert.equal((await call(pMe, 'GET', '/api/platform/me', { cookie: await admin() })).status, 403)
})

test('platform: write routes require same origin; customer membership never grants admin', async () => {
  const cookie = await admin()
  for (const mod of [pInvites, pInviteAction, pStatus, pPlans]) {
    assert.equal((await call(mod, 'POST', '/api/platform/x', { cookie, origin: 'https://evil.example', body: {} })).status, 403)
  }
  seed('ops-co', { owner: 'someone@ops-co.example' })
  assert.equal((await call(pStatus, 'POST', '/api/platform/status', { cookie: await session('someone@ops-co.example'), body: { customer: 'ops-co', status: 'suspended' } })).status, 403)
  assert.equal(db.sql.prepare("SELECT status FROM customers WHERE id = 'ops-co'").get().status, 'active')
})

// ---------- overview & detail ----------

test('overview: onboarding status, attention flags, and no lead contact data', async () => {
  seed('live-co')
  await connectKv('live-co')
  seed('stalled-co', { age: 3 * DAY, hours: false })
  seed('disconnected-co') // hours set but no calendar
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('l1', 'live-co', 'Private Person', 'private@example.net', '555-0100', 'x', 'new', 'h', ?, ?)").run(Date.now(), Date.now())
  db.sql.prepare("INSERT INTO events (id, type, customer, at) VALUES ('f1', 'booking_failed', 'live-co', ?)").run(Date.now())
  const r = await call(pOverview, 'GET', '/api/platform/overview', { cookie: await admin() })
  const byId = Object.fromEntries(r.json().customers.map((c) => [c.id, c]))
  assert.equal(byId['live-co'].onboarding, 'live')
  assert.equal(byId['live-co'].leads30, 1)
  assert.deepEqual(byId['live-co'].attention, ['booking_failures'])
  assert.equal(byId['stalled-co'].onboarding, 'calendar')
  assert.ok(byId['stalled-co'].attention.includes('setup_stalled'))
  assert.ok(byId['disconnected-co'].attention.includes('calendar_disconnected'))
  assert.ok(!r.text.includes('private@example.net') && !r.text.includes('Private Person') && !r.text.includes('555-0100'))
})

test('customer detail: totals, invites, audit trail, and on-demand live health', async () => {
  seed('alpha')
  await connectKv('alpha')
  const cookie = await admin()
  const d = await call(pCustomer, 'GET', '/api/platform/customer?id=alpha&health=1', { cookie })
  assert.equal(d.status, 200)
  assert.equal(d.json().health.status, 'healthy')
  assert.deepEqual(d.json().totals, { leads: 0, booked: 0, showed: 0, no_show: 0 })
  assert.equal((await call(pCustomer, 'GET', '/api/platform/customer?id=nope', { cookie })).status, 404)
  assert.equal((await call(pCustomer, 'GET', '/api/platform/customer?id=Bad!', { cookie })).status, 400)
})

// ---------- invitations & assisted setup ----------

test('assisted setup: admin creates business + invite; owner accepts and authorizes their own calendar', async () => {
  const cookie = await admin()
  const r = await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'New@Owner.example', businessName: 'Sunny Pools', timezone: 'America/Phoenix' } })
  assert.equal(r.status, 201)
  const { customer, url, email } = r.json()
  assert.equal(customer, 'sunny-pools')
  assert.equal(email, 'not_configured')
  const row = db.sql.prepare('SELECT created_via, source FROM customers WHERE id = ?').get(customer)
  assert.deepEqual({ ...row }, { created_via: 'admin_invite', source: 'assisted' })
  assert.deepEqual(auditActions(), ['customer.create', 'invite.create'])
  assert.equal(db.sql.prepare('SELECT status FROM email_outbox').get().status, 'pending')
  assert.equal(db.sql.prepare('SELECT count(*) c FROM account_invites WHERE token_hash = ?').get(new URL(url).searchParams.get('invite')).c, 0, 'raw token not stored')

  const token = new URL(url).searchParams.get('invite')
  const peek = await call(invitePeek, 'GET', `/api/invite?token=${token}`)
  assert.deepEqual(peek.json(), { businessName: 'Sunny Pools', email: 'n•••@owner.example' })

  const wrong = await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie: await session('intruder@example.org'), body: { token } })
  assert.equal(wrong.status, 409)
  assert.deepEqual(wrong.json(), { error: 'wrong_account', expected: 'n•••@owner.example' })

  const ownerCookie = await session('new@owner.example')
  assert.equal((await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie: ownerCookie, body: { token } })).status, 200)
  const state = (await call(me, 'GET', '/api/dashboard/me', { cookie: ownerCookie })).json()
  assert.equal(state.customer.id, 'sunny-pools')
  assert.deepEqual(state.progress, { business: true, calendar: false, hours: false, complete: false })
  assert.equal((await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie: await session('new2@owner.example'), body: { token } })).status, 404, 'single use')
})

test('invitations: existing business, member conflict, expiry, revoke, resend', async () => {
  seed('alpha')
  const cookie = await admin()
  assert.equal((await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'owner@alpha.example', customer: 'alpha' } })).json().error, 'email_already_in_business')
  assert.equal((await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'bad', customer: 'alpha' } })).json().error, 'invalid_email')
  const first = (await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'partner@alpha.example', customer: 'alpha' } })).json()
  const tokenOf = (u) => new URL(u).searchParams.get('invite')

  const resent = (await call(pInviteAction, 'POST', '/api/platform/invite-action', { cookie, body: { id: first.inviteId, action: 'resend' } })).json()
  assert.equal((await call(invitePeek, 'GET', `/api/invite?token=${tokenOf(first.url)}`)).status, 404, 'old link invalid after resend')
  assert.equal((await call(invitePeek, 'GET', `/api/invite?token=${tokenOf(resent.url)}`)).status, 200)

  assert.equal((await call(pInviteAction, 'POST', '/api/platform/invite-action', { cookie, body: { id: resent.inviteId, action: 'revoke' } })).status, 200)
  assert.equal((await call(invitePeek, 'GET', `/api/invite?token=${tokenOf(resent.url)}`)).status, 404)

  const third = (await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'partner@alpha.example', customer: 'alpha' } })).json()
  db.sql.exec('UPDATE account_invites SET expires_at = 1 WHERE revoked_at IS NULL')
  assert.equal((await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie: await session('partner@alpha.example'), body: { token: tokenOf(third.url) } })).status, 404)
  assert.deepEqual(auditActions(), ['invite.create', 'invite.resend', 'invite.revoke', 'invite.create'])
})

test('invitations: a user who already has a business cannot accept another', async () => {
  seed('alpha')
  seed('bravo', { owner: 'busy@bravo.example' })
  const inv = (await call(pInvites, 'POST', '/api/platform/invites', { cookie: await admin(), body: { email: 'free@alpha.example', customer: 'alpha' } })).json()
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('free@alpha.example', 'bravo', 1)").run()
  const r = await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie: await session('free@alpha.example'), body: { token: new URL(inv.url).searchParams.get('invite') } })
  assert.equal(r.json().error, 'already_in_business')
})

// ---------- follow-ups & email ----------

test('follow-ups: stalled setup and stale invites are queued once; finished businesses are not', async () => {
  seed('stalled', { age: 2 * DAY, hours: false })
  seed('done', { age: 2 * DAY })
  await connectKv('done')
  seed('fresh', { hours: false })
  const inv = (await call(pInvites, 'POST', '/api/platform/invites', { cookie: await admin(), body: { email: 'late@x.example', businessName: 'Late Co', timezone: 'UTC' } })).json()
  db.sql.prepare('UPDATE account_invites SET created_at = ? WHERE id = ?').run(Date.now() - 4 * DAY, inv.inviteId)
  for (let i = 0; i < 2; i++) await call(pOverview, 'GET', '/api/platform/overview', { cookie: await admin() })
  const ids = db.sql.prepare('SELECT id FROM email_outbox ORDER BY id').all().map((r) => r.id)
  assert.deepEqual(ids.filter((i) => i.startsWith('followup:')).sort(), [`followup:invite:${inv.inviteId}`, 'followup:setup:stalled'])
})

test('email: nothing is marked sent without a provider; provider success and retry limits', async () => {
  seed('alpha')
  const cookie = await admin()
  await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'a@alpha.example', customer: 'alpha' } })
  assert.equal(db.sql.prepare("SELECT count(*) c FROM email_outbox WHERE status = 'sent'").get().c, 0)
  assert.ok(!fetches.some((f) => f.url.includes('resend')))

  env.RESEND_API_KEY = 're_SECRET'
  env.EMAIL_FROM = 'GetShowUps <hello@getshowups.com>'
  const r = await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'b@alpha.example', customer: 'alpha' } })
  assert.equal(r.json().email, 'sent')
  assert.equal(db.sql.prepare("SELECT count(*) c FROM email_outbox WHERE status = 'sent'").get().c, 2)
  const sent = fetches.filter((f) => f.url.includes('resend'))
  assert.equal(sent[0].init.headers['Idempotency-Key'].startsWith('invite:'), true)

  resend = () => [500, {}]
  await call(pInvites, 'POST', '/api/platform/invites', { cookie, body: { email: 'c@alpha.example', customer: 'alpha' } })
  for (let i = 0; i < 3; i++) await call(pOverview, 'GET', '/api/platform/overview', { cookie })
  const failed = db.sql.prepare("SELECT status, attempts FROM email_outbox WHERE to_email = 'c@alpha.example'").get()
  assert.deepEqual({ ...failed }, { status: 'failed', attempts: 3 })
})

// ---------- account status ----------

test('suspension: manual, audited; pauses booking; owner keeps dashboard and billing access', async () => {
  seed('alpha')
  await connectKv('alpha')
  const cookie = await admin()
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).status, 200)
  assert.equal((await call(pStatus, 'POST', '/api/platform/status', { cookie, body: { customer: 'alpha', status: 'suspended', reason: 'requested' } })).status, 200)
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).status, 404)
  const owner = await session('owner@alpha.example')
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: owner })).json().customer.status, 'suspended')
  assert.equal((await call(billing, 'GET', '/api/dashboard/billing', { cookie: owner })).status, 200)
  await call(pStatus, 'POST', '/api/platform/status', { cookie, body: { customer: 'alpha', status: 'active' } })
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).status, 200)
  assert.deepEqual(auditActions(), ['customer.suspend', 'customer.reactivate'])
})

// ---------- billing ----------

const configureStripe = () => {
  env.STRIPE_SECRET_KEY = 'sk_test_SECRET'
  env.STRIPE_WEBHOOK_SECRET = WHSEC
}
const addPlan = async (cookie, patch = {}) =>
  call(pPlans, 'POST', '/api/platform/plans', { cookie, body: { id: 'starter', name: 'Starter', stripePriceId: 'price_TEST123', trialDays: 14, entitlements: { bookingPage: true }, ...patch } })

test('plans: validated, audited, never invent prices', async () => {
  const cookie = await admin()
  assert.equal((await addPlan(cookie, { stripePriceId: '29.99' })).json().error, 'invalid_price')
  assert.equal((await addPlan(cookie, { trialDays: 365 })).json().error, 'invalid_trial')
  const ok = (await addPlan(cookie)).json()
  assert.deepEqual(ok.plans[0], { id: 'starter', name: 'Starter', stripePriceId: 'price_TEST123', trialDays: 14, entitlements: { bookingPage: true }, active: true })
  assert.deepEqual(auditActions(), ['plan.upsert'])
  assert.ok(!JSON.stringify(ok).match(/amount|price":\s*\d/))
})

test('billing: hidden and refused when Stripe is not configured', async () => {
  seed('alpha')
  const owner = await session('owner@alpha.example')
  assert.deepEqual((await call(billing, 'GET', '/api/dashboard/billing', { cookie: owner })).json(), { configured: false })
  assert.equal((await call(billing, 'POST', '/api/dashboard/billing', { cookie: owner, body: { action: 'checkout', plan: 'starter' } })).status, 503)
})

test('billing: checkout offers the trial once, then the portal manages changes', async () => {
  seed('alpha')
  configureStripe()
  await addPlan(await admin())
  const owner = await session('owner@alpha.example')
  const info = (await call(billing, 'GET', '/api/dashboard/billing', { cookie: owner })).json()
  assert.deepEqual(info.plans, [{ id: 'starter', name: 'Starter', trialDays: 14, entitlements: { bookingPage: true } }])
  const r = await call(billing, 'POST', '/api/dashboard/billing', { cookie: owner, body: { action: 'checkout', plan: 'starter' } })
  assert.equal(r.json().url, 'https://checkout.stripe.com/c/test')
  const sent = new URLSearchParams(fetches.find((f) => f.url.endsWith('/checkout/sessions')).init.body)
  assert.equal(sent.get('line_items[0][price]'), 'price_TEST123')
  assert.equal(sent.get('subscription_data[trial_period_days]'), '14')
  assert.equal(sent.get('client_reference_id'), 'alpha')
  assert.equal(sent.get('customer_email'), 'owner@alpha.example')
  assert.equal(fetches.find((f) => f.url.endsWith('/checkout/sessions')).init.headers.Authorization, 'Bearer sk_test_SECRET')

  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, status, updated_at) VALUES ('alpha', 'cus_1', 'active', 1)").run()
  assert.equal((await call(billing, 'POST', '/api/dashboard/billing', { cookie: owner, body: { action: 'checkout', plan: 'starter' } })).json().error, 'use_portal')
  const portal = await call(billing, 'POST', '/api/dashboard/billing', { cookie: owner, body: { action: 'portal' } })
  assert.equal(portal.json().url, 'https://billing.stripe.com/p/test')
  assert.equal(new URLSearchParams(fetches.at(-1).init.body).get('customer'), 'cus_1')
  assert.equal((await call(billing, 'POST', '/api/dashboard/billing', { cookie: owner, origin: 'https://evil.example', body: { action: 'portal' } })).status, 403)
})

async function signed(event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))), (b) => b.toString(16).padStart(2, '0')).join('')
  return call(webhook, 'POST', '/api/stripe/webhook', { raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } })
}
const subEvent = (id, type, created, sub) => ({ id, type, created, data: { object: { id: 'sub_1', customer: 'cus_1', metadata: { customer: 'alpha' }, currency: 'usd', current_period_end: 1900000000, cancel_at_period_end: false, items: { data: [{ quantity: 1, price: { id: 'price_TEST123', unit_amount: 12000, recurring: { interval: 'month', interval_count: 1 } } }] }, ...sub } } })

test('webhook: signature required, stale timestamps rejected', async () => {
  configureStripe()
  seed('alpha')
  const ev = subEvent('evt_1', 'customer.subscription.created', 100, { status: 'trialing' })
  assert.equal((await signed(ev, { secret: 'whsec_wrong' })).status, 400)
  assert.equal((await signed(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400)
  assert.equal((await call(webhook, 'POST', '/api/stripe/webhook', { raw: JSON.stringify(ev) })).status, 400)
  assert.equal(db.sql.prepare('SELECT count(*) c FROM subscriptions').get().c, 0)
  assert.ok(await verifySignature('{}', `t=1,v1=${'0'.repeat(64)}`, WHSEC, 1) === false)
})

test('webhook: lifecycle, idempotency, out-of-order protection, and revenue events', async () => {
  configureStripe()
  seed('alpha')
  await addPlan(await admin())
  assert.equal((await signed(subEvent('evt_1', 'customer.subscription.created', 100, { status: 'trialing' }))).status, 200)
  let s = db.sql.prepare("SELECT * FROM subscriptions WHERE customer = 'alpha'").get()
  assert.deepEqual([s.status, s.plan_id, s.mrr_cents], ['trialing', 'starter', 12000])

  const dup = await signed(subEvent('evt_1', 'customer.subscription.created', 100, { status: 'trialing' }))
  assert.equal(dup.json().duplicate, true)

  await signed(subEvent('evt_3', 'customer.subscription.updated', 300, { status: 'active' }))
  await signed(subEvent('evt_2', 'customer.subscription.updated', 200, { status: 'past_due' })) // late, older
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get().status, 'active')

  await signed(subEvent('evt_4', 'customer.subscription.updated', 400, { status: 'unpaid' }))
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get().status, 'past_due')

  const invoice = { id: 'evt_5', type: 'invoice.paid', created: 450, data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 12000, currency: 'usd' } } }
  await signed(invoice)
  await signed({ ...invoice, id: 'evt_5b' }) // same invoice, different event id → still one revenue record
  assert.equal(db.sql.prepare("SELECT count(*) c FROM events WHERE type = 'revenue'").get().c, 1)

  await signed(subEvent('evt_6', 'customer.subscription.deleted', 500, { status: 'canceled' }))
  s = db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get()
  assert.equal(s.status, 'canceled')
  const types = db.sql.prepare("SELECT type FROM events WHERE id LIKE 'stripe:%' ORDER BY at").all().map((r) => r.type)
  assert.deepEqual(types, ['subscription_started', 'subscription_status_changed', 'subscription_status_changed', 'subscription_canceled'])
})

test('webhook: processing failure returns 500 and allows Stripe to retry', async () => {
  configureStripe()
  seed('alpha')
  db.fail = (q) => q.startsWith('INSERT INTO subscriptions')
  assert.equal((await signed(subEvent('evt_9', 'customer.subscription.created', 100, { status: 'active' }))).status, 500)
  db.fail = null
  assert.equal((await signed(subEvent('evt_9', 'customer.subscription.created', 100, { status: 'active' }))).json().handled, true)
})

test('monthlyCents normalizes intervals and quantities', () => {
  const sub = (amount, interval, count = 1, quantity = 1) => ({ items: { data: [{ quantity, price: { unit_amount: amount, recurring: { interval, interval_count: count } } }] } })
  assert.equal(monthlyCents(sub(12000, 'year')), 1000)
  assert.equal(monthlyCents(sub(5000, 'month', 1, 2)), 10000)
  assert.equal(monthlyCents(sub(30000, 'month', 3)), 10000)
  assert.equal(monthlyCents({}), 0)
})

// ---------- metrics & events ----------

test('metrics: empty platform shows unavailable values, never estimates', async () => {
  const m = (await call(pOverview, 'GET', '/api/platform/overview', { cookie: await admin() })).json().metrics
  assert.equal(m.billing, null)
  assert.equal(m.activationRate, null)
  assert.equal(m.showUpRate30, null)
  assert.equal(m.cac, null)
  assert.equal(m.ltv, null)
  assert.equal(m.grossMargin, null)
})

test('metrics and events: real activity drives activation, conversion, show-up, MRR', async () => {
  seed('alpha')
  await connectKv('alpha')
  const p = { customer: 'alpha' }
  const lead = (await call(bookLead, 'POST', '/api/book/alpha/lead', { params: p, body: { name: 'Lee', email: 'lee@example.net', phone: '555-010-0100', need: 'Pool service' } })).json()
  const slot = (await call(bookInfo, 'GET', '/api/book/alpha', { params: p })).json().slots[0]
  const booked = await call(bookAppt, 'POST', '/api/book/alpha/appointment', { params: p, body: { leadId: lead.leadId, leadToken: lead.leadToken, start: slot } })
  assert.equal(booked.status, 201)
  db.sql.prepare("INSERT INTO events (id, type, customer, at) VALUES ('setup_completed:alpha', 'setup_completed', 'alpha', ?)").run(Date.now())
  db.sql.exec("UPDATE appointments SET status = 'showed', start_at = start_at - 172800000")
  db.sql.prepare("INSERT INTO subscriptions (customer, status, mrr_cents, currency, updated_at) VALUES ('alpha', 'active', 9900, 'usd', 1)").run()

  const types = db.sql.prepare('SELECT type FROM events ORDER BY at').all().map((r) => r.type)
  assert.ok(types.includes('lead_created') && types.includes('appointment_booked'))
  const m = (await call(pOverview, 'GET', '/api/platform/overview', { cookie: await admin() })).json().metrics
  assert.equal(m.activationRate, 100)
  assert.equal(m.firstBookingRate, 100)
  assert.equal(m.bookingConversion30, 100)
  assert.equal(m.showUpRate30, 100)
  assert.deepEqual([m.billing.mrrCents, m.billing.arrCents, m.billing.payingCustomers], [9900, 118800, 1])
  assert.equal(m.billing.revenueGrowth30, null) // no prior-period revenue to compare against
})
