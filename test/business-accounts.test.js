// Business account types (server/business-accounts.js, migration 0034, /api/platform/account): classification,
// billing entitlement, environment and provider spend kept apart; complimentary accounts never check out, are never
// held or resynced for billing, are hosted whatever Stripe says, take the legacy onboarding path and are left out
// of paying/MRR counts; sandbox = test business; only platform admins may write; owners cannot; fail-soft before the
// migration. Real handlers + migrations on node:sqlite; nothing external.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { accountOf, accountsReady, classifyBusiness, createClassifiedBusiness, isComplimentary, providerCosts, providerSpendAllowed } from '../server/business-accounts.js'
import { hostingStatus } from '../server/website.js'
import { createCheckout } from '../server/stripe.js'
import { adsHold } from '../server/ads/holds.js'
import { lifecycle, recoveryFor } from '../server/lifecycle.js'
import { onboardingSteps } from '../server/onboarding.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { growth, customerRows } from '../server/metrics.js'
import { reconcileBilling } from '../server/reconcile.js'
import { liveFor } from '../server/ads/campaigns.js'
import * as accountRoute from '../functions/api/platform/account.js'
import * as billingRoute from '../functions/api/dashboard/billing.js'
import * as receptionistInfo from '../functions/api/receptionist/[customer]/index.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86400000
const ADMIN = 'brandon@getshowups.com'
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}
let env, db, kv, fetches
const now = Date.now()
beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  env = {
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: ADMIN, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', ADS_ENABLED: 'true', ADS_BUSINESSES: 'poolthru-llc,pools', ADS_LIVE_LAUNCH: 'true', RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test',
  }
  const biz = (id, name, via = 'self_serve') => {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, source, created_via, created_at, updated_at) VALUES (?, ?, 'America/New_York', '', '09:00', '17:00', '1,2,3,4,5', ?, 'direct', ?, ?, ?)").run(id, name, now - 40 * DAY, via, now - 40 * DAY, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
    db.sql.prepare("INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, updated_at) VALUES (?, 1, 'ai_first', 1)").run(id)
    kv.set(`google:${id}`, JSON.stringify({ customer: id, refreshToken: 'x' }))
  }
  // PoolThru as in production: legacy self-serve record, Stripe customer created, checkout never completed, no self_signups row.
  biz('poolthru-llc', 'PoolThru')
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, mrr_cents, last_event_at, updated_at) VALUES ('poolthru-llc', 'cus_pool', NULL, 'incomplete', 0, 0, 1)").run()
  // An ordinary billed customer with an active test-mode subscription.
  biz('pools', 'Pools Co')
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES ('pools', 'founding', ?, ?)").run(now - 30 * DAY, now - 29 * DAY)
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Founding', 'price_x', 0, '{}', 1, 1)").run()
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, last_event_at, updated_at) VALUES ('pools', 'cus_p', 'sub_p', 'founding', 'active', 49900, 'usd', ?, ?, ?)").run(now + 20 * DAY, now, now)
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
})
const cookieFor = async (email) => {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + DAY)
  return `__Host-gsu_session=${token}`
}
const call = async (mod, method, path, { cookie, body, origin = ORIGIN, params } = {}) => {
  const headers = { 'CF-Connecting-IP': '203.0.113.5' }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST') headers.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, json: () => JSON.parse(text) }
}
const admin = { email: ADMIN }
const customer = async (id) => customerFromRow(await getCustomer(db, id))

test('defaults and fail-soft: no row = paying customer; without the table every read says customer and writes say migration_required', async () => {
  assert.equal(await accountsReady(db), true)
  assert.deepEqual(await accountOf(env, 'poolthru-llc'), { classification: 'customer', billing: 'stripe', environment: 'production', providerSpend: 'allowed', note: '', setBy: null, setAt: null, recorded: false })
  assert.equal(await isComplimentary(env, 'poolthru-llc'), false)
  db.sql.exec('DROP TABLE business_accounts')
  assert.equal(await accountsReady(db), false)
  assert.equal((await accountOf(env, 'poolthru-llc')).classification, 'customer')
  assert.equal((await classifyBusiness(env, admin, 'poolthru-llc', 'internal_live')).error, 'migration_required')
  assert.equal((await createClassifiedBusiness(env, admin, { name: 'X Lab', classification: 'sandbox' })).error, 'migration_required')
  // Everything that reads the entitlement still works (as before the feature).
  assert.deepEqual(await hostingStatus(db, 'poolthru-llc', now, env), { status: 'active', exempt: true })
  assert.equal((await lifecycle(env, 'poolthru-llc', now)).stage, 'not_billed')
})

test('PoolThru → internal live: complimentary, production, hosted, no checkout, no hold, lifecycle "complimentary", legacy onboarding, Stripe records untouched, audited with from/to', async () => {
  const before = JSON.stringify(db.sql.prepare("SELECT * FROM subscriptions WHERE customer = 'poolthru-llc'").get())
  const r = await classifyBusiness(env, admin, 'poolthru-llc', 'internal_live', { note: 'GetShowUps-owned operating business' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual([r.account.classification, r.account.billing, r.account.environment, r.account.providerSpend, r.testMark], ['internal_live', 'complimentary', 'production', 'allowed', { test: false, changed: false }])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM test_businesses WHERE customer = 'poolthru-llc' AND is_test = 1").get().n, 0, 'never a test business')
  assert.equal(JSON.stringify(db.sql.prepare("SELECT * FROM subscriptions WHERE customer = 'poolthru-llc'").get()), before, 'Stripe records untouched')
  assert.equal(fetches.length, 0, 'no Stripe call')
  assert.deepEqual(await hostingStatus(db, 'poolthru-llc', now, env), { status: 'active', exempt: true, complimentary: true })
  assert.equal((await createCheckout(env, { customer: await customer('poolthru-llc'), email: 'owner@poolthru-llc.example', planId: 'founding', origin: ORIGIN })).error, 'complimentary')
  assert.equal(await adsHold(env, 'poolthru-llc'), null)
  const l = await lifecycle(env, 'poolthru-llc', now)
  assert.deepEqual([l.stage, l.account, l.hosting.status], ['complimentary', { classification: 'internal_live', billing: 'complimentary', environment: 'production' }, 'active'])
  assert.equal(await recoveryFor(env, 'poolthru-llc', now), null)
  const steps = await onboardingSteps(env, await customer('poolthru-llc'), { calendar: true })
  assert.deepEqual([steps.selfServe, steps.billing], [false, 'not_required'])
  assert.deepEqual([r.from, r.note], ['customer', 'GetShowUps-owned operating business'])
  // Owner billing route: not billed, complimentary; checkout refused.
  const c = await cookieFor('owner@poolthru-llc.example')
  const g = await call(billingRoute, 'GET', '/api/dashboard/billing', { cookie: c })
  assert.deepEqual([g.json().billed, g.json().complimentary], [false, true])
  assert.equal((await call(billingRoute, 'POST', '/api/dashboard/billing', { cookie: c, body: { action: 'checkout', plan: 'founding' } })).status, 409)
  // Suspension still holds ads (classification never overrides an admin suspension).
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'poolthru-llc'").run()
  assert.deepEqual(await adsHold(env, 'poolthru-llc'), { reason: 'suspended' })
})

test('sandbox: test mark follows the environment, provider spend blocked by default (public receptionist off, no live ads), back to production unmarks; a live Stripe subscription blocks reclassification', async () => {
  const r = await createClassifiedBusiness(env, admin, { name: 'QA Lab Pools', classification: 'sandbox', ownerEmail: 'qa@getshowups.example' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.id, 'qa-lab-pools')
  assert.deepEqual([r.account.classification, r.account.environment, r.account.providerSpend], ['sandbox', 'sandbox', 'blocked'])
  assert.equal(db.sql.prepare("SELECT is_test FROM test_businesses WHERE customer = 'qa-lab-pools'").get().is_test, 1)
  assert.equal(db.sql.prepare("SELECT customer FROM customer_users WHERE email = 'qa@getshowups.example'").get().customer, 'qa-lab-pools')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM self_signups WHERE customer = 'qa-lab-pools'").get().n, 0, 'never a payment step')
  assert.equal((await createClassifiedBusiness(env, admin, { name: 'Second', classification: 'sandbox', ownerEmail: 'qa@getshowups.example' })).error, 'owner_has_business')
  assert.equal((await createClassifiedBusiness(env, admin, { name: 'Nope', classification: 'customer' })).error, 'invalid_classification')
  // Provider spend blocked: the public receptionist is off and live ads impossible; spend may be allowed explicitly.
  db.sql.prepare("INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, updated_at) VALUES ('qa-lab-pools', 1, 'ai_first', 1)").run()
  db.sql.prepare("UPDATE customers SET hours_confirmed_at = ?1 WHERE id = 'qa-lab-pools'").run(now)
  kv.set('google:qa-lab-pools', JSON.stringify({ customer: 'qa-lab-pools', refreshToken: 'x' }))
  assert.equal(await providerSpendAllowed(env, 'qa-lab-pools'), false)
  assert.equal((await call(receptionistInfo, 'GET', '/api/receptionist/qa-lab-pools', { params: { customer: 'qa-lab-pools' } })).json().enabled, false)
  assert.equal(await liveFor(env, 'qa-lab-pools'), false)
  const allow = await classifyBusiness(env, admin, 'qa-lab-pools', 'sandbox', { providerSpend: 'allowed', note: 'paid testing approved' })
  assert.equal(allow.account.providerSpend, 'allowed')
  assert.equal((await call(receptionistInfo, 'GET', '/api/receptionist/qa-lab-pools', { params: { customer: 'qa-lab-pools' } })).json().enabled, true)
  assert.equal(await liveFor(env, 'qa-lab-pools'), false, 'a test business still never goes live on ads')
  // Back to a paying customer: unmarked (sandbox-era data stays sandboxed: unmarked_at recorded).
  const back = await classifyBusiness(env, admin, 'qa-lab-pools', 'customer')
  assert.deepEqual([back.account.billing, back.testMark], ['stripe', { test: false, changed: true }])
  assert.ok(db.sql.prepare("SELECT unmarked_at FROM test_businesses WHERE customer = 'qa-lab-pools'").get().unmarked_at > 0)
  // A LIVE Stripe subscription still running blocks a move away from paying (nothing is cancelled automatically).
  db.sql.prepare("INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES ('pools', 1, ?1)").run(now)
  assert.equal((await classifyBusiness(env, admin, 'pools', 'internal_live')).error, 'live_subscription_running')
  assert.equal((await classifyBusiness(env, admin, 'pools', 'customer')).ok, true, 'an explicit "customer" record is always allowed')
  assert.equal((await classifyBusiness(env, admin, 'nobody', 'sandbox')).error, 'not_found')
  assert.equal((await classifyBusiness(env, admin, 'pools', 'vip')).error, 'invalid_classification')
})

test('metrics and reconciliation: complimentary businesses never count as paying or MRR and are never resynced; costs are estimates per source', async () => {
  // Give PoolThru an (impossible in practice) active test subscription to prove the exclusion is explicit.
  db.sql.prepare("UPDATE subscriptions SET status = 'active', stripe_subscription_id = 'sub_pool', mrr_cents = 49900 WHERE customer = 'poolthru-llc'").run()
  await classifyBusiness(env, admin, 'poolthru-llc', 'internal_live')
  const rows = await customerRows(env, now)
  const pool = rows.find((r) => r.id === 'poolthru-llc')
  assert.deepEqual(pool.account, { classification: 'internal_live', billing: 'complimentary', environment: 'production', providerSpend: 'allowed' })
  const g = await growth(env, rows, now)
  assert.equal(g.billing.mode, 'test')
  assert.equal(g.billing.testSubscriptions, 1, 'only Pools Co: the complimentary business is excluded')
  // Reconciliation: Stripe says PoolThru's subscription ended; a paying business would be resynced, a complimentary one is reported only.
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/v1/subscriptions') && !u.includes('/sub_')) return new Response(JSON.stringify({ data: [{ id: 'sub_pool', customer: 'cus_pool', status: 'canceled', livemode: false, metadata: { customer: 'poolthru-llc' }, items: { data: [{ quantity: 1, price: { unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] } }, { id: 'sub_p', customer: 'cus_p', status: 'active', livemode: false, metadata: { customer: 'pools' }, items: { data: [{ quantity: 1, price: { unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] } }], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const r = await reconcileBilling(env, { now })
  assert.deepEqual(r.applied, [{ customer: 'poolthru-llc', subscription: 'sub_pool', ok: false, status: null, error: 'complimentary_account' }])
  assert.equal(db.sql.prepare("SELECT status FROM subscriptions WHERE customer = 'poolthru-llc'").get().status, 'active', 'record untouched')
  const costs = await providerCosts(env, 'poolthru-llc', 30, now)
  assert.deepEqual(costs.items.map((i) => i.key), ['receptionist', 'websiteAi', 'adCreatives', 'adSpend', 'voiceLab'])
  assert.deepEqual([costs.totalMicros, costs.estimate], [0, true])
})

test('route: platform admin only (owners 403, signed-out 401, cross-origin 403, confirm required); GET shows account, subscription, costs, history; customer users have no path to change it', async () => {
  const owner = await cookieFor('owner@poolthru-llc.example')
  const staff = await cookieFor(ADMIN)
  const body = { action: 'classify', customer: 'poolthru-llc', classification: 'internal_live', confirm: true }
  assert.equal((await call(accountRoute, 'POST', '/api/platform/account', { body })).status, 401)
  assert.equal((await call(accountRoute, 'POST', '/api/platform/account', { cookie: owner, body })).status, 403)
  assert.equal((await call(accountRoute, 'POST', '/api/platform/account', { cookie: staff, body, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(accountRoute, 'POST', '/api/platform/account', { cookie: staff, body: { ...body, confirm: false } })).status, 400)
  assert.equal((await call(accountRoute, 'GET', '/api/platform/account?id=poolthru-llc', { cookie: owner })).status, 403)
  const r = await call(accountRoute, 'POST', '/api/platform/account', { cookie: staff, body: { ...body, note: 'PoolThru is GetShowUps-owned' } })
  assert.equal(r.status, 200, JSON.stringify(r.json()))
  const g = await call(accountRoute, 'GET', '/api/platform/account?id=poolthru-llc', { cookie: staff })
  const j = g.json()
  assert.deepEqual([j.ready, j.account.classification, j.account.billing, j.subscription.status, j.subscription.stripeSubscription, j.subscription.stripeCustomer, j.testMark.test], [true, 'internal_live', 'complimentary', 'incomplete', false, true, false])
  assert.equal(j.history.length, 1)
  assert.deepEqual([j.history[0].details.from, j.history[0].details.to, j.history[0].details.note], ['customer', 'internal_live', 'PoolThru is GetShowUps-owned'])
  assert.equal(j.costs.items.length, 5)
  assert.ok(Object.keys(j.classifications).length === 3)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'account.classify' AND customer = 'poolthru-llc'").get().n, 1)
  const ev = db.sql.prepare("SELECT details FROM audit_log WHERE action = 'account.classify' AND customer = 'poolthru-llc'").all()
  assert.equal(ev.length, 1, 'one permanent record per change')
  assert.ok(!JSON.stringify(ev).includes('@'), 'no addresses in the permanent log')
  const c = await call(accountRoute, 'POST', '/api/platform/account', { cookie: staff, body: { action: 'create', name: 'Demo Pools', classification: 'internal_live', confirm: true } })
  assert.equal(c.status, 200)
  assert.equal(c.json().account.billing, 'complimentary')
  assert.equal((await call(accountRoute, 'GET', '/api/platform/account?id=nobody-here', { cookie: staff })).status, 404)
})
