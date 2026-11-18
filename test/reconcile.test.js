// Billing reconciliation (server/reconcile.js): Stripe vs our records, read-only toward Stripe; every difference type
// found; pagination; recorded in the permanent audit log; admin resync applies Stripe's state (audited).
// MOCK Stripe; real handlers + migrations on node:sqlite.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { reconcileBilling, dailyReconciliation } from '../server/reconcile.js'
import * as route from '../functions/api/platform/reconcile.js'

const ORIGIN = 'https://getshowups.com'
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
  return { sql, prepare: (q) => stmt(q) }
}
const price = (cents) => ({ items: { data: [{ quantity: 1, price: { id: 'price_X', unit_amount: cents, recurring: { interval: 'month', interval_count: 1 } } }] } })
let env, db, fetches, stripeSubs, stripeInvoices, origFetch, origError, logs
beforeEach(() => {
  db = d1()
  fetches = []
  logs = []
  stripeSubs = []
  stripeInvoices = []
  env = {
    ONBOARDING_DB: db,
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/x`,
    TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    GOOGLE_TOKENS: { get: async () => null, list: async () => ({ keys: [], list_complete: true }) },
    PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    fetches.push({ method, path: u.pathname, query: u.search })
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const page = (list) => {
      const after = u.searchParams.get('starting_after')
      const start = after ? list.findIndex((x) => x.id === after) + 1 : 0
      const limit = 2 // MOCK: tiny pages to exercise pagination
      return reply({ data: list.slice(start, start + limit), has_more: start + limit < list.length })
    }
    if (u.pathname === '/v1/subscriptions' && method === 'GET') return page(stripeSubs)
    if (u.pathname === '/v1/invoices' && method === 'GET') return page(stripeInvoices)
    const m = u.pathname.match(/^\/v1\/subscriptions\/(\w+)$/)
    if (m && method === 'GET') return reply(stripeSubs.find((s) => s.id === m[1]))
    throw new Error(`unexpected ${method} ${u}`)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.join(' '))
  const now = Date.now()
  for (const [id, sub, status, mrr] of [['alpha', 'sub_a', 'active', 49900], ['beta', 'sub_b', 'active', 49900]]) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?)").run(id, id, now, now)
    db.sql.prepare('INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, mrr_cents, currency, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)').run(id, `cus_${id}`, sub, status, mrr, 'usd', now)
    db.sql.prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?, 0, ?)').run(id, now)
    db.sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES (?, 'revenue', ?, ?, '{}')").run(`revenue:in_${id}`, id, now - 86400000)
    stripeSubs.push({ id: sub, customer: `cus_${id}`, status, livemode: false, metadata: { customer: id }, ...price(mrr) })
    stripeInvoices.push({ id: `in_${id}`, customer: `cus_${id}`, amount_paid: mrr, parent: { subscription_details: { metadata: { customer: id } } } })
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
})
async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(method, body, c) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' }
  if (c) headers.Cookie = c
  const res = await route[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}/api/platform/reconcile`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env })
  return { status: res.status, json: await res.json() }
}

test('clean: records match Stripe; read-only (GETs only); pages followed; run recorded in the audit log', async () => {
  stripeSubs.push({ id: 'sub_old', customer: 'cus_alpha', status: 'canceled', livemode: false, metadata: { customer: 'alpha' }, ...price(49900) }) // history: fine
  const r = await reconcileBilling(env)
  assert.deepEqual([r.ok, r.issues, r.checked.subscriptions, r.checked.invoices], [true, 0, 3, 2])
  assert.ok(fetches.every((f) => f.method === 'GET'), 'never writes to Stripe')
  assert.ok(fetches.some((f) => f.query.includes('starting_after=sub_b')), 'followed pagination')
  assert.match(fetches.find((f) => f.path === '/v1/invoices').query, /status=paid&created%5Bgte%5D=\d+/)
  const row = db.sql.prepare("SELECT actor_type, details FROM audit_log WHERE action = 'billing.reconciliation'").get()
  assert.equal(row.actor_type, 'system')
  assert.equal(JSON.parse(row.details).issues, 0)
  assert.deepEqual(await dailyReconciliation(env), { skipped: 'recent' })
})

test('differences: every kind is reported (never fixed automatically)', async () => {
  const s = (id) => stripeSubs.find((x) => x.id === id)
  Object.assign(s('sub_a'), { status: 'past_due', cancel_at_period_end: true, livemode: true })
  Object.assign(s('sub_b'), price(39900))
  stripeSubs.push({ id: 'sub_c', customer: 'cus_c', status: 'active', livemode: false, metadata: { customer: 'gamma' }, ...price(49900) })
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES ('delta', 'Deleted business', 'UTC', '', '09:00', '17:00', '1', 1, 1)").run()
  db.sql.prepare("INSERT INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at) VALUES ('delta', 1, 'system', 'completed', 'done', 1)").run()
  stripeSubs.push({ id: 'sub_d', customer: 'cus_d', status: 'active', livemode: false, metadata: { customer: 'delta' }, ...price(49900) })
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES ('epsilon', 'e', 'UTC', '', '09:00', '17:00', '1', 1, 1)").run()
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, mrr_cents, last_event_at, updated_at) VALUES ('epsilon', 'cus_e', 'sub_gone', 'active', 49900, 0, 1)").run()
  stripeInvoices.push({ id: 'in_new', customer: 'cus_beta', amount_paid: 49900, parent: { subscription_details: { metadata: { customer: 'beta' } } } })
  stripeInvoices.splice(stripeInvoices.findIndex((i) => i.id === 'in_alpha'), 1)
  const before = JSON.stringify(db.sql.prepare('SELECT * FROM subscriptions ORDER BY customer').all())
  const r = await reconcileBilling(env)
  assert.deepEqual(r.byType, {
    status_mismatch: 1,
    cancel_mismatch: 1,
    mode_mismatch: 1,
    amount_mismatch: 1,
    stripe_only: 1,
    billing_after_deletion: 1,
    ours_only: 1,
    payment_not_recorded: 1,
    payment_unknown: 1,
  })
  assert.deepEqual(r.list.find((i) => i.type === 'billing_after_deletion'), { type: 'billing_after_deletion', customer: 'delta', subscription: 'sub_d', stripe: 'active' })
  assert.deepEqual(r.list.find((i) => i.type === 'amount_mismatch'), { type: 'amount_mismatch', customer: 'beta', subscription: 'sub_b', ours: 49900, stripe: 39900 })
  assert.equal(JSON.stringify(db.sql.prepare('SELECT * FROM subscriptions ORDER BY customer').all()), before, 'records unchanged')
  assert.ok(logs.some((l) => l.startsWith('billing reconciliation: issues')))
})

test('missed cancellation webhook: a paid subscription Stripe reports as ended is applied (decrease-only); a late or duplicate webhook changes nothing', async () => {
  const s = (id) => stripeSubs.find((x) => x.id === id)
  // The final failed-payment retry canceled sub_a in Stripe; our webhook never arrived (ours still past_due).
  db.sql.prepare("UPDATE subscriptions SET status = 'past_due' WHERE customer = 'alpha'").run()
  Object.assign(s('sub_a'), { status: 'canceled', ended_at: Math.floor(Date.now() / 1000) })
  // An abandoned checkout placeholder that Stripe expired is NOT touched (never paid: nothing to take away).
  db.sql.prepare("UPDATE subscriptions SET status = 'incomplete' WHERE customer = 'beta'").run()
  Object.assign(s('sub_b'), { status: 'incomplete_expired' })
  const r = await reconcileBilling(env)
  assert.deepEqual(r.applied, [{ customer: 'alpha', subscription: 'sub_a', ok: true, status: 'canceled', error: undefined }])
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get().status, 'canceled')
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'beta'").get().status, 'incomplete')
  assert.ok(fetches.every((f) => f.method === 'GET'), 'still never writes to Stripe')
  assert.ok(db.sql.prepare("SELECT 1 FROM audit_log WHERE action = 'billing.subscription_status' AND customer = 'alpha'").get(), 'status change audited')
  assert.ok(JSON.parse(db.sql.prepare("SELECT details FROM audit_log WHERE action = 'billing.reconciliation' ORDER BY seq DESC").get().details).applied.length === 1)
  // Next run: nothing left to apply for alpha.
  const again = await reconcileBilling(env)
  assert.deepEqual(again.applied, [])
  // The real webhook arriving late (older event) or twice changes nothing.
  const { handleEvent } = await import('../server/stripe.js')
  const late = { id: 'evt_late', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) - 3600, livemode: false, data: { object: { ...s('sub_a'), status: 'past_due' } } }
  await handleEvent(env, late)
  await handleEvent(env, late)
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get().status, 'canceled')
})

test('admin route: run now + resync one business from Stripe (audited); admin only; not configured → 409', async () => {
  const c = await cookie('founder@getshowups.example')
  assert.equal((await call('GET', null, await cookie('owner@alpha.example'))).status, 403)
  assert.equal((await call('GET', null, c)).json.last, null)
  Object.assign(stripeSubs.find((x) => x.id === 'sub_a'), { status: 'past_due' })
  const run = await call('POST', { action: 'run' }, c)
  assert.deepEqual([run.status, run.json.last.byType], [200, { status_mismatch: 1 }])
  assert.equal(db.sql.prepare("SELECT actor_type FROM audit_log WHERE action = 'billing.reconciliation'").get().actor_type, 'admin')
  assert.equal((await call('POST', { action: 'resync', customer: 'alpha' }, c)).json.error, 'confirmation_required')
  const fix = await call('POST', { action: 'resync', customer: 'alpha', confirm: true }, c)
  assert.deepEqual([fix.status, fix.json.status], [200, 'past_due'])
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'alpha'").get().status, 'past_due')
  assert.equal(db.sql.prepare("SELECT action FROM admin_audit ORDER BY id DESC LIMIT 1").get().action, 'billing.resync')
  assert.equal((await call('POST', { action: 'run' }, c)).json.last.issues, 0, 'clean after the fix')
  // A live-mode subscription is never applied while live billing is off.
  Object.assign(stripeSubs.find((x) => x.id === 'sub_b'), { livemode: true })
  assert.equal((await call('POST', { action: 'resync', customer: 'beta', confirm: true }, c)).json.error, 'livemode_not_enabled')
  delete env.STRIPE_SECRET_KEY
  assert.equal((await call('POST', { action: 'run' }, c)).status, 409)
})
