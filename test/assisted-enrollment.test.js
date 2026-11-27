// Assisted enrollment (server/enrollment.js, server/roles.js, server/staff-context.js, migration 0047): staff roles and
// revocation, assignment isolation, the pending workspace's restrictions, Stripe-hosted payment links through the
// ordinary checkout path, paid ONLY from the verified webhook, staff configure mode on the ordinary dashboard routes,
// the ownership claim (binding, expiry, revoke, resend, wrong email, existing account, duplicates), audit rows, and no
// card data anywhere.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { sha256Hex } from '../server/google-oauth.js'
import { rolesOf } from '../server/roles.js'
import { looksLikeCard, deriveStage, ABANDON_AFTER_DAYS } from '../server/enrollment.js'
import { providerSpendAllowed } from '../server/business-accounts.js'
import { businessEligible } from '../server/eligibility.js'
import { hostingStatus } from '../server/website.js'
import { bookableCustomer } from '../server/public.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import * as salesMe from '../functions/api/sales/me.js'
import * as salesRoles from '../functions/api/sales/roles.js'
import * as enrollments from '../functions/api/sales/enrollments.js'
import * as claim from '../functions/api/claim.js'
import * as me from '../functions/api/dashboard/me.js'
import * as hours from '../functions/api/dashboard/hours.js'
import * as profile from '../functions/api/dashboard/profile.js'
import * as billing from '../functions/api/dashboard/billing.js'
import * as onboarding from '../functions/api/dashboard/onboarding.js'
import * as accept from '../functions/api/dashboard/accept-invite.js'
import * as webhook from '../functions/api/stripe/webhook.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const WHSEC = 'whsec_test_secret'
const SECRETS = ['sk_test_SECRET', WHSEC, KEY]
const CARD = '4242 4242 4242 4242'
const DAY = 864e5
const ADMIN = 'founder@getshowups.com'
const REP = 'rep@sales.example'
const REP2 = 'rep2@sales.example'
const ONB = 'onboard@sales.example'
const OWNER = 'owner@harbor.example'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
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
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

let env, db, kv, stripe, stripeCalls, origFetch, origError, logs, responses
beforeEach(() => {
  db = d1()
  kv = new Map()
  responses = []
  stripeCalls = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    PLATFORM_ADMIN_EMAILS: ADMIN,
    STRIPE_SECRET_KEY: 'sk_test_SECRET',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    MESSAGE_TEST_RECIPIENTS: OWNER,
  }
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Growth', 'price_GROWTH', 0, '{}', 1, 1)").run()
  stripe = {
    customer: () => [200, { id: 'cus_harbor' }],
    subscriptions: () => [200, { data: [] }],
    openSessions: () => [200, { data: [] }],
    checkout: () => [200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }],
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    stripeCalls.push({ url: u, body: init.body ? String(init.body) : '', headers: init.headers || {} })
    let out
    if (u === 'https://api.stripe.com/v1/customers') out = stripe.customer(new URLSearchParams(init.body), init.headers)
    else if (u.startsWith('https://api.stripe.com/v1/subscriptions?')) out = stripe.subscriptions()
    else if (u.startsWith('https://api.stripe.com/v1/checkout/sessions?')) out = stripe.openSessions()
    else if (u === 'https://api.stripe.com/v1/checkout/sessions') out = stripe.checkout(new URLSearchParams(init.body))
    else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => (process.env.DBG && origError(...a), logs.push(a.map(String).join(' ')))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

async function session(email, { at = Date.now() } = {}) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, at, at + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, origin = ORIGIN, body, headers = {}, raw } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, params: {} })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text), text }
}
const act = async (email, body, opts = {}) => call(enrollments, 'POST', '/api/sales/enrollments', { cookie: await session(email), body, ...opts })
const detail = async (email, id) => call(enrollments, 'GET', `/api/sales/enrollments?id=${id}`, { cookie: await session(email) })
const grant = async (email, role) => call(salesRoles, 'POST', '/api/sales/roles', { cookie: await session(ADMIN), body: { action: 'grant', email, role } })
const revoke = async (email, role) => call(salesRoles, 'POST', '/api/sales/roles', { cookie: await session(ADMIN), body: { action: 'revoke', email, role } })
const auditActions = () => db.sql.prepare('SELECT action FROM admin_audit ORDER BY id').all().map((r) => r.action)
const asStaff = (id) => ({ 'X-GSU-Enrollment': id })

async function signed(event) {
  const t = Math.floor(Date.now() / 1000)
  const raw = JSON.stringify({ livemode: false, ...event })
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))), (b) => b.toString(16).padStart(2, '0')).join('')
  return call(webhook, 'POST', '/api/stripe/webhook', { raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } })
}
const paidEvent = (customer, id = 'evt_paid') => ({ id, type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: { id: 'sub_h', customer: 'cus_harbor', status: 'active', metadata: { customer }, currency: 'usd', current_period_end: 1900000000, items: { data: [{ quantity: 1, price: { id: 'price_GROWTH', unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] } } } })

// A rep's prospect with a workspace. Returns { id, customer }.
async function prospect(email = REP, extra = {}) {
  if (email !== ADMIN) await grant(email, 'sales_rep')
  const c = await act(email, { action: 'create', businessName: 'Harbor Pools', ownerName: 'Pat Harbor', ownerEmail: OWNER, phone: '843-555-0142', planId: 'founding', timezone: 'America/New_York', notes: 'Wants weekly service', ...extra })
  assert.equal(c.status, 200, c.text)
  const id = c.json().id
  const w = await act(email, { action: 'workspace', id })
  assert.equal(w.status, 200, w.text)
  return { id, customer: w.json().customer }
}
// Staff configure the required setup through the ordinary routes.
async function configure(email, id) {
  const cookie = await session(email)
  const p = await call(profile, 'POST', '/api/dashboard/profile', { cookie, headers: asStaff(id), body: { phone: '843-555-0142', industry: 'Pool service', services: [{ name: 'Weekly pool care', price: '$160 per month' }], cities: ['Charleston'] } })
  assert.equal(p.status, 200, p.text)
  const h = await call(hours, 'POST', '/api/dashboard/hours', { cookie, headers: asStaff(id), body: { workdays: [1, 2, 3, 4, 5], dayStart: '08:00', dayEnd: '17:00', slotMinutes: 60 } })
  assert.equal(h.status, 200, h.text)
}

// ---------- roles ----------

test('roles: platform admins from PLATFORM_ADMIN_EMAILS; reps/onboarding granted, revoked on the next request; audited', async () => {
  assert.deepEqual([...(await rolesOf(env, ADMIN))], ['platform_admin'])
  assert.equal((await call(salesMe, 'GET', '/api/sales/me')).status, 401)
  assert.equal((await call(salesMe, 'GET', '/api/sales/me', { cookie: await session(REP) })).status, 403)
  // Only platform admins grant, same origin only; customers and reps can't.
  assert.equal((await call(salesRoles, 'POST', '/api/sales/roles', { cookie: await session(REP), body: { action: 'grant', email: REP, role: 'sales_rep' } })).status, 403)
  assert.equal((await call(salesRoles, 'POST', '/api/sales/roles', { cookie: await session(ADMIN), origin: 'https://evil.example', body: { action: 'grant', email: REP, role: 'sales_rep' } })).status, 403)
  assert.equal((await grant(REP, 'platform_admin')).json().error, 'invalid_role')
  assert.equal((await grant(ADMIN, 'sales_rep')).json().error, 'already_admin')
  assert.equal((await grant(REP, 'sales_rep')).json().changed, true)
  assert.equal((await grant(REP, 'sales_rep')).json().changed, false, 'one active grant per email + role')
  const r = await call(salesMe, 'GET', '/api/sales/me', { cookie: await session(REP) })
  assert.deepEqual(r.json().roles, ['sales_rep'])
  assert.equal((await revoke(REP, 'sales_rep')).status, 200)
  assert.equal((await call(salesMe, 'GET', '/api/sales/me', { cookie: await session(REP) })).status, 403, 'revocation applies on the next request')
  assert.equal((await revoke(REP, 'sales_rep')).status, 404)
  assert.deepEqual(auditActions(), ['commercial.role_granted', 'commercial.role_revoked'])
  // A role never makes anyone a business member, and business membership never grants a role.
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customer_users').get().n, 0)
})

test('roles: before migration 0047 only platform admins have a role (fails closed for the new roles)', async () => {
  const broken = { ...env, ONBOARDING_DB: { prepare: () => ({ bind: () => ({ all: async () => Promise.reject(new Error('no such table: commercial_roles')) }) }) } }
  assert.deepEqual([...(await rolesOf(broken, REP))], [])
  assert.deepEqual([...(await rolesOf(broken, ADMIN))], ['platform_admin'])
})

// ---------- lifecycle ----------

test('a workspace is a pending business: no owner, not hosted, not bookable, no paid tools, no provider spend', async () => {
  const { id, customer } = await prospect()
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customer_users WHERE customer = ?').get(customer).n, 0, 'no owner membership')
  assert.ok(db.sql.prepare('SELECT 1 FROM self_signups WHERE customer = ?').get(customer), 'billed: must pay')
  assert.equal(db.sql.prepare('SELECT created_via FROM customers WHERE id = ?').get(customer).created_via, 'admin_invite')
  assert.equal((await hostingStatus(db, customer, Date.now(), env)).status, 'unpaid')
  const c = customerFromRow(await getCustomer(db, customer))
  assert.equal(await businessEligible(env, c), false)
  assert.equal(await providerSpendAllowed(env, customer), false)
  kv.set(`google:${customer}`, '{}')
  db.sql.prepare('UPDATE customers SET hours_confirmed_at = 1 WHERE id = ?').run(customer)
  assert.equal((await bookableCustomer(env, { customer })).response.status, 404, 'not bookable publicly')
  // The phone said on the call is already in the business details (never asked again).
  assert.equal(JSON.parse(JSON.stringify(db.sql.prepare('SELECT phone FROM business_profiles WHERE customer = ?').get(customer))).phone, '(843) 555-0142')
  assert.equal((await act(REP, { action: 'workspace', id })).json().error, 'workspace_exists', 'one workspace per enrollment')
  assert.deepEqual(auditActions().filter((a) => a.startsWith('enrollment.')), ['enrollment.created', 'enrollment.workspace_created'])
})

test('payment link: the ordinary checkout path (customer first, idempotent), Stripe-hosted, returns to /claim; emailed via the outbox', async () => {
  const { id, customer } = await prospect()
  const r = await act(REP, { action: 'payment', id, email: true })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json().url, 'https://checkout.stripe.com/c/pay/cs_test_1')
  const cust = stripeCalls.find((c) => c.url === 'https://api.stripe.com/v1/customers')
  assert.equal(cust.headers['Idempotency-Key'], `gsu-customer-${customer}`)
  assert.equal(new URLSearchParams(cust.body).get('email'), OWNER)
  const s = new URLSearchParams(stripeCalls.find((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').body)
  assert.equal(s.get('mode'), 'subscription')
  assert.equal(s.get('line_items[0][price]'), 'price_GROWTH')
  assert.equal(s.get('success_url'), `${ORIGIN}/claim?paid=1`)
  assert.equal(s.get('metadata[enrollment]'), id)
  assert.match(s.get('custom_text[submit][message]'), /authorize GetShowUps to charge the price shown above .* every month .* until you cancel/)
  assert.equal(s.get('consent_collection[terms_of_service]'), null, 'only with STRIPE_CHECKOUT_TERMS=true')
  const mail = db.sql.prepare("SELECT to_email, template, body FROM email_outbox WHERE template = 'assisted_payment'").get()
  assert.equal(mail.to_email, OWNER)
  assert.match(mail.body, /checkout\.stripe\.com/)
  assert.equal((await detail(REP, id)).json().enrollment.stage, 'payment_sent')
  // The representative saying so never makes it paid: no such action exists, and the invitation waits for Stripe.
  assert.equal((await act(REP, { action: 'paid', id })).status, 400)
  assert.equal((await act(REP, { action: 'invite', id })).json().error, 'payment_required')
  env.STRIPE_CHECKOUT_TERMS = 'true'
  await act(REP, { action: 'payment', id })
  assert.equal(new URLSearchParams(stripeCalls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions').at(-1).body).get('consent_collection[terms_of_service]'), 'required')
})

test('payment link: sandbox rules unchanged (non-tester refused) and duplicate subscriptions refused', async () => {
  env.MESSAGE_TEST_RECIPIENTS = ''
  const { id } = await prospect()
  const r = await act(REP, { action: 'payment', id })
  assert.equal(r.status, 403)
  assert.equal(r.json().error, 'billing_not_live')
  env.MESSAGE_TEST_RECIPIENTS = OWNER
  await act(REP, { action: 'payment', id }) // creates the Stripe customer record
  stripe.subscriptions = () => [200, { data: [{ id: 'sub_x', status: 'active' }] }]
  const dup = await act(REP, { action: 'payment', id })
  assert.equal(dup.status, 409)
  assert.equal(dup.json().error, 'subscription_exists')
})

test('paid comes ONLY from the verified webhook: restrictions lift through the existing hosting logic', async () => {
  const { id, customer } = await prospect()
  await act(REP, { action: 'payment', id })
  // An unsigned "payment" changes nothing.
  const forged = await call(webhook, 'POST', '/api/stripe/webhook', { raw: JSON.stringify(paidEvent(customer)), headers: { 'Stripe-Signature': 't=1,v1=00' } })
  assert.equal(forged.status, 400)
  assert.equal(db.sql.prepare('SELECT stage, paid_at FROM assisted_enrollments WHERE id = ?').get(id).paid_at, null)
  assert.equal((await signed(paidEvent(customer))).status, 200)
  const row = db.sql.prepare('SELECT stage, paid_at FROM assisted_enrollments WHERE id = ?').get(id)
  assert.equal(row.stage, 'paid')
  assert.ok(row.paid_at)
  assert.equal((await hostingStatus(db, customer, Date.now(), env)).status, 'active')
  assert.equal(await providerSpendAllowed(env, customer), true)
  assert.ok(db.sql.prepare("SELECT 1 FROM audit_log WHERE action = 'enrollment.paid'").get())
  assert.equal((await act(REP, { action: 'payment', id })).json().error, 'already_paid')
  assert.equal((await act(REP, { action: 'abandon', id })).json().error, 'already_paid')
})

test('card data never enters GetShowUps: refused in notes and every field, nothing stored', async () => {
  await grant(REP, 'sales_rep')
  for (const field of ['notes', 'ownerName', 'businessName']) {
    const r = await act(REP, { action: 'create', businessName: 'Harbor Pools', ownerEmail: OWNER, planId: 'founding', [field]: `card ${CARD} exp 12/29` })
    assert.equal(r.status, 400)
    assert.equal(r.json().error, 'card_data_refused')
  }
  assert.equal(db.sql.prepare('SELECT count(*) n FROM assisted_enrollments').get().n, 0)
  const { id } = await prospect()
  assert.equal((await act(REP, { action: 'update', id, notes: '4111-1111-1111-1111' })).json().error, 'card_data_refused')
  assert.ok(looksLikeCard('5555555555554444') && looksLikeCard('3782 822463 10005') && !looksLikeCard('(843) 555-0142') && !looksLikeCard('+1 843 555 0142'))
  const dump = JSON.stringify(db.sql.prepare('SELECT * FROM assisted_enrollments').all()) + JSON.stringify(db.sql.prepare('SELECT * FROM admin_audit').all()) + JSON.stringify(db.sql.prepare('SELECT details FROM audit_log').all())
  for (const digits of ['4242424242424242', '4242 4242', '4111-1111', '4111111111111111']) assert.ok(!dump.includes(digits), 'no card number anywhere')
})

// ---------- isolation ----------

test('a representative sees and acts on ONLY their assigned enrollments; onboarding configures but never takes payment', async () => {
  const { id } = await prospect(REP)
  await grant(REP2, 'sales_rep')
  await grant(ONB, 'onboarding')
  const list2 = (await call(enrollments, 'GET', '/api/sales/enrollments', { cookie: await session(REP2) })).json()
  assert.deepEqual(list2.enrollments, [])
  assert.equal((await detail(REP2, id)).status, 404, 'not visible = not found (no enumeration)')
  for (const action of ['update', 'workspace', 'payment', 'invite', 'abandon', 'assign']) assert.equal((await act(REP2, { action, id })).status, 404, action)
  assert.equal(list2.reps, null, 'reps never see the staff list')
  // Onboarding: sees all, configures, may invite; never payment, assignment, abandonment or creating prospects.
  assert.equal((await call(enrollments, 'GET', '/api/sales/enrollments', { cookie: await session(ONB) })).json().enrollments.length, 1)
  assert.equal((await act(ONB, { action: 'payment', id })).json().error, 'forbidden_role')
  assert.equal((await act(ONB, { action: 'assign', id, repEmail: REP2 })).json().error, 'forbidden_role')
  assert.equal((await act(ONB, { action: 'create', businessName: 'X Co', ownerEmail: 'x@x.example', planId: 'founding' })).json().error, 'forbidden_role')
  assert.equal((await call(salesRoles, 'GET', '/api/sales/roles', { cookie: await session(ONB) })).status, 403, 'roles are admin-only')
  // The founder reassigns: the first rep loses it at once.
  assert.equal((await act(ADMIN, { action: 'assign', id, repEmail: REP2 })).status, 200)
  assert.equal((await detail(REP, id)).status, 404)
  assert.equal((await detail(REP2, id)).status, 200)
  assert.equal((await act(ADMIN, { action: 'assign', id, repEmail: 'stranger@x.example' })).json().error, 'not_a_rep')
  // Reps reach nothing else of the admin console.
  const pMe = await import('../functions/api/platform/me.js')
  assert.equal((await call(pMe, 'GET', '/api/platform/me', { cookie: await session(REP) })).status, 403)
})

test('configure mode: the ordinary routes act for the enrollment business, audited, allowlisted, role + assignment + stage on every request', async () => {
  const { id, customer } = await prospect(REP)
  const cookie = await session(REP)
  const m = await call(me, 'GET', '/api/dashboard/me', { cookie, headers: asStaff(id) })
  assert.equal(m.status, 200)
  assert.equal(m.json().customer.id, customer)
  assert.deepEqual(m.json().staff, { role: 'sales_rep', enrollmentId: id })
  // Steps the owner would see, derived from the data (payment is the enrollment's; staff never finish onboarding).
  assert.deepEqual(m.json().progress.steps.map((s) => s.id), ['business', 'payment', 'details', 'services', 'calendar', 'hours', 'website', 'address', 'publish', 'launch'])
  await configure(REP, id)
  assert.deepEqual(auditActions().filter((a) => a === 'enrollment.staff_write'), ['enrollment.staff_write', 'enrollment.staff_write'])
  assert.equal((await call(onboarding, 'POST', '/api/dashboard/onboarding', { cookie, headers: asStaff(id), body: { action: 'finish' } })).json().error, 'owner_decision')
  // Not a configuration route (billing, people, export …) → refused, never the business's data.
  assert.equal((await call(billing, 'POST', '/api/dashboard/billing', { cookie, headers: asStaff(id), body: { action: 'checkout', plan: 'founding' } })).json().error, 'staff_not_allowed')
  assert.equal((await call(billing, 'GET', '/api/dashboard/billing', { cookie, headers: asStaff(id) })).status, 403)
  // Cross-site writes refused; the staff email never becomes a member.
  assert.equal((await call(hours, 'POST', '/api/dashboard/hours', { cookie, origin: 'https://evil.example', headers: asStaff(id), body: {} })).status, 403)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customer_users').get().n, 0)
  // Another rep, a customer, a malformed id: refused.
  await grant(REP2, 'sales_rep')
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: await session(REP2), headers: asStaff(id) })).status, 403)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: await session('someone@else.example'), headers: asStaff(id) })).status, 403)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie, headers: asStaff('enr_../../x') })).status, 403)
  // A preview read may name the enrollment in the address; a write may not.
  assert.equal((await call(me, 'GET', `/api/dashboard/me?enrollment=${id}`, { cookie })).json().customer.id, customer)
  // A stale configure cookie in someone else's browser is ignored (their own dashboard keeps working).
  const other = await session('owner@other.example')
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('other-co', 'Other Co', 'UTC', 1, 1)").run()
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@other.example', 'other-co', 1)").run()
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: `${other}; __Host-gsu_staff=${id}` })).json().customer.id, 'other-co')
  // Revocation takes effect on the next request.
  await revoke(REP, 'sales_rep')
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie, headers: asStaff(id) })).status, 403)
})

// ---------- invitation + claim ----------

async function readyForClaim() {
  const { id, customer } = await prospect(REP)
  await act(REP, { action: 'payment', id })
  await signed(paidEvent(customer))
  const notReady = await act(REP, { action: 'invite', id })
  assert.equal(notReady.json().error, 'not_ready')
  assert.deepEqual(notReady.json().missing, ['details', 'services', 'hours'])
  await configure(REP, id)
  const d = (await detail(REP, id)).json()
  assert.equal(d.enrollment.stage, 'ready')
  assert.equal(d.checklist.ready, true)
  assert.deepEqual(d.checklist.items.find((i) => i.id === 'phone'), { id: 'phone', label: 'Phone: not available yet', state: 'off', detail: 'not_available', required: false })
  const inv = await act(REP, { action: 'invite', id })
  assert.equal(inv.status, 200, inv.text)
  const token = new URL(inv.json().url).searchParams.get('token')
  assert.equal(new URL(inv.json().url).pathname, '/claim')
  return { id, customer, token }
}
const peek = async (token, cookie) => call(claim, 'GET', `/api/claim?token=${token}`, { cookie })
const doClaim = async (token, cookie, body = {}) => call(claim, 'POST', '/api/claim', { cookie, body: { token, acceptTerms: true, termsVersion: 'assisted-claim-2026-11-26', ...body } })

test('claim: verified invited email + terms → owner in one step, lands on the configured dashboard, staff access ends, audited', async () => {
  const { id, customer, token } = await readyForClaim()
  assert.equal(db.sql.prepare("SELECT template FROM email_outbox WHERE template = 'ownership_invite'").get().template, 'ownership_invite')
  assert.equal(db.sql.prepare('SELECT token_hash FROM account_invites').get().token_hash, await sha256Hex(token), 'only the hash is stored')
  assert.equal((await peek(token)).json().state, 'signed_out')
  assert.equal((await peek(token)).json().email, 'o•••@harbor.example')
  const cookie = await session(OWNER)
  assert.equal((await peek(token, cookie)).json().state, 'ready')
  // The ordinary dashboard invitation can't be used to skip the terms.
  assert.equal((await call(accept, 'POST', '/api/dashboard/accept-invite', { cookie, body: { token } })).json().error, 'claim_required')
  assert.equal((await doClaim(token, cookie, { acceptTerms: false })).json().error, 'terms_required')
  assert.equal((await doClaim(token, cookie, { termsVersion: 'old' })).json().error, 'terms_required')
  const ok = await doClaim(token, cookie)
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json(), { customer, onboarded: false }) // calendar not connected yet: the owner continues there
  assert.deepEqual(db.sql.prepare('SELECT email FROM customer_users WHERE customer = ?').all(customer).map((r) => r.email), [OWNER])
  const row = db.sql.prepare('SELECT stage, claimed_by, terms_version, terms_accepted_at, assignment_closed_at FROM assisted_enrollments WHERE id = ?').get(id)
  assert.equal(row.stage, 'claimed')
  assert.equal(row.terms_version, 'assisted-claim-2026-11-26')
  assert.ok(row.terms_accepted_at && row.assignment_closed_at)
  assert.ok(db.sql.prepare("SELECT 1 FROM audit_log WHERE action = 'enrollment.claimed' AND actor_type = 'owner'").get())
  // Owner's dashboard: their business, steps they already have are done (never asked again).
  const m = (await call(me, 'GET', '/api/dashboard/me', { cookie })).json()
  assert.equal(m.customer.id, customer)
  assert.equal(m.staff, null)
  const open = m.progress.steps.filter((s) => !s.done).map((s) => s.id)
  assert.ok(!open.includes('payment') && !open.includes('details') && !open.includes('services') && !open.includes('hours'), open.join())
  // Single use; staff lose access to the business.
  assert.equal((await doClaim(token, cookie)).status, 404)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: await session(REP), headers: asStaff(id) })).status, 403)
  assert.equal((await act(REP, { action: 'invite', id })).json().error, 'already_claimed')
})

test('claim: finished setup → onboarding finished in the same step (the owner lands on Home)', async () => {
  const { customer, token } = await readyForClaim()
  kv.set(`google:${customer}`, '{}')
  db.sql.prepare("INSERT INTO onboarding_marks (customer, step, value, at) VALUES (?, 'website', 'existing', 1)").run(customer)
  const r = await doClaim(token, await session(OWNER))
  assert.deepEqual(r.json(), { customer, onboarded: true })
  assert.ok(db.sql.prepare('SELECT onboarded_at FROM self_signups WHERE customer = ?').get(customer).onboarded_at)
})

test('claim: wrong email, an email that already owns a business, expired, revoked and resent links are refused; nothing is merged', async () => {
  const { id, customer, token } = await readyForClaim()
  const wrong = await session('intruder@evil.example')
  const p = (await peek(token, wrong)).json()
  assert.equal(p.state, 'wrong_account')
  assert.equal(p.signedInAs, 'intruder@evil.example')
  assert.equal(p.email, 'o•••@harbor.example', 'the invited address stays masked')
  assert.equal((await doClaim(token, wrong)).json().error, 'wrong_account')
  // The invited email already owns another business: explained, not merged.
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('mine-co', 'Mine Co', 'UTC', 1, 1)").run()
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES (?, 'mine-co', 1)").run(OWNER)
  const owner = await session(OWNER)
  assert.equal((await peek(token, owner)).json().state, 'has_business')
  assert.equal((await doClaim(token, owner)).json().error, 'already_in_business')
  db.sql.prepare("DELETE FROM customer_users WHERE customer = 'mine-co'").run()
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customer_users WHERE customer = ?').get(customer).n, 0)
  // Revoked → dead; resend → only the newest works.
  assert.equal((await act(REP, { action: 'revoke_invite', id })).status, 200)
  assert.equal((await peek(token, owner)).status, 404)
  const again = new URL((await act(REP, { action: 'invite', id })).json().url).searchParams.get('token')
  const third = new URL((await act(REP, { action: 'invite', id })).json().url).searchParams.get('token')
  assert.equal((await peek(again, owner)).status, 404, 'resend revokes the previous link')
  // Expired.
  db.sql.prepare('UPDATE account_invites SET expires_at = 1 WHERE accepted_at IS NULL AND revoked_at IS NULL').run()
  assert.equal((await peek(third, owner)).status, 404)
  assert.equal((await doClaim(third, owner)).json().error, 'invite_invalid')
  assert.equal(db.sql.prepare('SELECT count(*) n FROM customer_users WHERE customer = ?').get(customer).n, 0)
  assert.ok(auditActions().includes('enrollment.invitation_revoked'))
})

test('claim: changing the owner email needs the pending invitation revoked first', async () => {
  const { id } = await readyForClaim()
  assert.equal((await act(REP, { action: 'update', id, ownerEmail: 'new@harbor.example' })).json().error, 'invitation_pending')
})

// ---------- abandoned ----------

test('abandoned: an unpaid enrollment past ABANDON_AFTER_DAYS is shown as abandoned; marking keeps everything; resend reopens', async () => {
  const { id, customer } = await prospect()
  db.sql.prepare('UPDATE assisted_enrollments SET created_at = ? WHERE id = ?').run(Date.now() - (ABANDON_AFTER_DAYS + 1) * DAY, id)
  const list = (await call(enrollments, 'GET', '/api/sales/enrollments', { cookie: await session(REP) })).json()
  assert.equal(list.enrollments[0].stale, true)
  assert.equal(list.abandonAfterDays, ABANDON_AFTER_DAYS)
  assert.equal((await act(REP, { action: 'abandon', id })).status, 200)
  assert.equal(db.sql.prepare('SELECT stage FROM assisted_enrollments WHERE id = ?').get(id).stage, 'abandoned')
  assert.ok(db.sql.prepare('SELECT 1 FROM customers WHERE id = ?').get(customer), 'nothing deleted')
  await act(REP, { action: 'payment', id })
  assert.equal(db.sql.prepare('SELECT stage FROM assisted_enrollments WHERE id = ?').get(id).stage, 'payment_sent')
})

test('deriveStage: claimed is final; paid stages need the verified subscription', () => {
  const row = { stage: 'payment_sent', payment_sent_at: 1, config_started_at: 1, invite_id: null }
  assert.equal(deriveStage(row, { paid: false }), 'payment_sent')
  assert.equal(deriveStage({ ...row, stage: 'invited', invite_id: 'i' }, { paid: false }), 'payment_sent', 'no subscription, no paid stage')
  assert.equal(deriveStage(row, { paid: true, ready: false }), 'configuring')
  assert.equal(deriveStage(row, { paid: true, ready: true }), 'ready')
  assert.equal(deriveStage({ ...row, stage: 'claimed' }, { paid: false }), 'claimed')
})

test('before migration 0047: the enrollment screen says so, claims answer the ordinary invalid-link reply', async () => {
  const missing = (q) => /assisted_enrollments|commercial_roles/.test(q)
  const real = db.prepare
  db.prepare = (q) => {
    if (missing(q)) return { bind: () => ({ first: async () => Promise.reject(new Error('no such table: assisted_enrollments')), all: async () => Promise.reject(new Error('no such table: x')), run: async () => Promise.reject(new Error('no such table: x')) }), first: async () => Promise.reject(new Error('no such table: assisted_enrollments')), all: async () => Promise.reject(new Error('no such table: commercial_roles')) }
    return real(q)
  }
  const list = await call(enrollments, 'GET', '/api/sales/enrollments', { cookie: await session(ADMIN) })
  assert.equal(list.json().ready, false)
  assert.equal((await call(claim, 'GET', `/api/claim?token=${'a'.repeat(43)}`)).status, 404)
  db.prepare = real
})
