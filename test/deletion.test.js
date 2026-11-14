// Permanent account deletion (server/deletion.js, migration 0016): gate, owner + admin routes, every step, erasure
// of exactly the right records (another business untouched), what is retained, external cleanup (Stripe, Google),
// retries with backoff, audit trail without personal data, and a fresh start for a returning owner.
// Real handlers + migrations on node:sqlite; Map KV; Stripe and Google are mocked (MOCK). Nothing external is called.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { verifyAuditChain } from '../server/auditlog.js'
import { ERASED_TABLES, processDeletions, requestDeletion } from '../server/deletion.js'
import { uniqueCustomerId } from '../server/customers.js'
import * as account from '../functions/api/dashboard/account.js'
import * as me from '../functions/api/dashboard/me.js'
import * as pDeletion from '../functions/api/platform/deletion.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const RT = '1//refresh-SECRET-alpha'
const OWNER = 'jamie.owner@alpha.example'
const MIN = 60000

function d1() {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys = ON') // D1 enforces foreign keys
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
function kvStore() {
  const m = new Map()
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  }
}

let env, db, kv, fetches, stripe, logs, origFetch, origError
beforeEach(async () => {
  db = d1()
  kv = kvStore()
  fetches = []
  logs = []
  // MOCK Stripe: one active subscription per Stripe customer.
  stripe = { subs: { sub_A: 'active', sub_B: 'active' }, customers: new Set(['cus_A', 'cus_B']), fail: null }
  env = {
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: kv,
    TOKEN_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example',
    ACCOUNT_DELETION_ENABLED: 'true',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    fetches.push({ host: u.host, method, path: u.pathname, body: init.body ? String(init.body) : '' })
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return reply(200, {})
    if (u.host === 'api.stripe.com') {
      if (stripe.fail) return reply(stripe.fail, { error: { code: 'api_connection_error', message: 'MOCK down' } })
      let m
      if (u.pathname === '/v1/subscriptions' && method === 'GET') {
        const cus = u.searchParams.get('customer')
        return reply(200, { data: Object.entries(stripe.subs).filter(([id]) => id.endsWith(cus.slice(-1))).map(([id, status]) => ({ id, status })) })
      }
      if ((m = u.pathname.match(/^\/v1\/subscriptions\/(\w+)$/))) {
        if (!(m[1] in stripe.subs)) return reply(404, { error: { code: 'resource_missing' } })
        if (method === 'DELETE') stripe.subs[m[1]] = 'canceled'
        return reply(200, { id: m[1], status: stripe.subs[m[1]] })
      }
      if ((m = u.pathname.match(/^\/v1\/customers\/(\w+)$/)) && method === 'DELETE') {
        if (!stripe.customers.delete(m[1])) return reply(404, { error: { code: 'resource_missing' } })
        return reply(200, { id: m[1], deleted: true })
      }
    }
    throw new Error(`unexpected ${method} ${u}`)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
  await seedBusiness('alpha-co', 'Alpha Co', OWNER, 'A')
  await seedBusiness('beta-co', 'Beta Co', 'owner@beta.example', 'B')
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  assert.ok(!logs.join('\n').includes(RT), 'no token in logs')
})

async function seedBusiness(id, name, owner, x, { googleSub = `sub-${x}` } = {}) {
  const now = Date.now()
  const q = (s, ...a) => db.sql.prepare(s).run(...a)
  q("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401', '00:00', '23:59', '0,1,2,3,4,5,6', ?, ?, ?)", id, name, now, now, now)
  q('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)', owner, id, now)
  q("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Lee Lead', ?, '843-555-0100', 'Pool cleaning', '29401', 'booked', 'h', ?, ?)", `lead${x}0001`, id, `lee.${x}@example.net`, now, now)
  q("INSERT INTO lead_addresses (lead_id, customer, street, city, state, zip, created_at) VALUES (?, ?, '1 Main St', 'Charleston', 'SC', '29401', ?)", `lead${x}0001`, id, now)
  q("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'booked', ?, ?)", `appt${x}001`, id, `lead${x}0001`, now + 86400000, now + 90000000, now, now)
  q("INSERT INTO messages (id, customer, lead_id, appointment_id, kind, channel, send_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'reminder_24h', 'email', ?, 'scheduled', ?, ?)", `reminder_24h:email:${x}`, id, `lead${x}0001`, `appt${x}001`, now + MIN, now, now)
  q("INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, '{\"headline\":\"Hi\"}', 1, ?, ?)", id, now, now)
  q("INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 1, '{\"headline\":\"Hi\"}', ?)", id, now)
  q("INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?, ?, 'image/png', x'89504e47', 4, ?)", `${x.toLowerCase()}`.repeat(32), id, now)
  q("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '843-555-0199', 'Pool', 'We clean pools', '[]', '[]', ?)", id, now)
  q("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', 'paused', '{}', 2500, '222', ?, ?)", `cmp_${x}0000001`, id, now, now)
  q("INSERT INTO ad_actions (id, customer, campaign_id, actor, kind, status, reason, details, at) VALUES (?, ?, ?, ?, 'pause', 'applied', 'Paused', '{}', ?)", `act${x}0000001`, id, `cmp_${x}0000001`, `owner:${owner}`, now)
  q("INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES (?, 'founding', ?, ?)", id, now, now)
  q("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, last_event_at, updated_at) VALUES (?, ?, ?, 'founding', 'active', 49900, 'usd', ?, ?)", id, `cus_${x}`, `sub_${x}`, now, now)
  q("INSERT INTO events (id, type, customer, at, props) VALUES (?, 'revenue', ?, ?, '{\"amountCents\":49900}'), (?, 'lead_created', ?, ?, '{}')", `revenue:${x}`, id, now, `lead:${x}`, id, now)
  q("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at, sent_count) VALUES (?, ?, ?, ?, 'founder@getshowups.example', ?, ?, 1)", `inv${x}`, `th${x}`, `partner.${x}@example.net`, id, now, now + 86400000)
  q("INSERT INTO email_outbox (id, to_email, customer, template, subject, body, status, attempts, created_at) VALUES (?, ?, ?, 'invite', 'Join', 'b', 'pending', 0, ?)", `out${x}`, `partner.${x}@example.net`, id, now)
  q("INSERT INTO admin_audit (at, actor, action, customer, details) VALUES (?, 'founder@getshowups.example', 'invite.create', ?, ?)", now, id, JSON.stringify({ email: `partner.${x}@example.net` }))
  await kv.put(`google:${id}`, JSON.stringify({ customer: id, refreshToken: await encrypt(env, RT), googleSub, clientId: 'cid', scope: 'x' }))
  await kv.put(`google-archive:${id}:1`, JSON.stringify({ customer: id, refreshToken: await encrypt(env, RT), googleSub, clientId: 'old' }))
  await kv.put(`ads:google:${id}`, 'enc')
  await kv.put(`ghl:${id}`, 'enc')
}

async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie: c, body, origin = ORIGIN, params } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7' }
  if (c) headers.Cookie = c
  if (method === 'POST') headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
const count = (table, id) => db.sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE customer = ?`).get(id).n
const job = (id) => db.sql.prepare('SELECT * FROM account_deletions WHERE customer = ?').get(id)
const auditActions = (id) => db.sql.prepare('SELECT action FROM audit_log WHERE customer = ? ORDER BY seq').all(id).map((r) => r.action)

test('gate: without ACCOUNT_DELETION_ENABLED nothing can be requested or run (routes 404, cron off, me hides it)', async () => {
  delete env.ACCOUNT_DELETION_ENABLED
  const c = await cookie(OWNER)
  assert.equal((await call(account, 'POST', '/api/dashboard/account', { cookie: c, body: { action: 'delete', confirm: true, name: 'Alpha Co' } })).status, 404)
  assert.equal((await call(pDeletion, 'POST', '/api/platform/deletion', { cookie: await cookie('founder@getshowups.example'), body: { customer: 'alpha-co', action: 'request', confirm: true, confirmId: 'alpha-co' } })).status, 404)
  assert.deepEqual(await requestDeletion(env, 'alpha-co', { type: 'owner', id: OWNER }), { ok: false, error: 'not_enabled' })
  assert.deepEqual(await processDeletions(env), { enabled: false })
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: c })).json().features.accountDeletion, false)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM account_deletions').get().n, 0)
  assert.equal(fetches.length, 0)
})

test('owner deletion: confirmed by typing the business name; everything erased, billing ended, Google revoked; beta untouched', async () => {
  const c = await cookie(OWNER)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: c })).json().features.accountDeletion, true)
  const del = (body, opts = {}) => call(account, 'POST', '/api/dashboard/account', { cookie: c, body, ...opts })
  assert.equal((await del({ action: 'delete', confirm: true, name: 'Alpha' })).json().error, 'name_mismatch')
  assert.equal((await del({ action: 'delete', name: 'Alpha Co' })).json().error, 'confirmation_required')
  assert.equal((await del({ action: 'delete', confirm: true, name: 'Alpha Co' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM account_deletions').get().n, 0, 'nothing started by refused requests')
  const r = await del({ action: 'delete', confirm: true, name: '  alpha   co ' })
  assert.deepEqual([r.status, r.json()], [202, { deleting: true, status: 'completed' }])

  // Erased: every business/personal record of alpha.
  for (const t of ERASED_TABLES) assert.equal(count(t, 'alpha-co'), 0, t)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM events WHERE customer = 'alpha-co' AND type = 'lead_created'").get().n, 0)
  for (const k of ['google:alpha-co', 'google-archive:alpha-co:1', 'ads:google:alpha-co', 'ghl:alpha-co']) assert.equal(kv.m.has(k), false, k)
  // Retained (documented): tombstone, billing records, financial events; staff log with emails replaced.
  assert.deepEqual({ ...db.sql.prepare("SELECT name, status, service_zips FROM customers WHERE id = 'alpha-co'").get() }, { name: 'Deleted business', status: 'suspended', service_zips: '' })
  assert.equal(count('subscriptions', 'alpha-co'), 1)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM events WHERE customer = 'alpha-co' AND type = 'revenue'").get().n, 1)
  const staff = db.sql.prepare("SELECT details FROM admin_audit WHERE customer = 'alpha-co'").get().details
  assert.ok(!staff.includes('partner.A'), 'email replaced in the staff log')
  assert.match(JSON.parse(staff).email, /^ref:[0-9a-f]{20}$/)
  // External: Stripe subscription canceled now and confirmed, Stripe customer deleted; Google grant revoked.
  assert.equal(stripe.subs.sub_A, 'canceled')
  assert.equal(stripe.customers.has('cus_A'), false)
  assert.equal(fetches.filter((f) => f.path === '/revoke').length, 2, 'current + archived grant (not used by any other business)')
  // Beta untouched, inside and outside.
  for (const t of ['leads', 'appointments', 'messages', 'websites', 'website_assets', 'customer_users', 'ad_campaigns', 'subscriptions']) assert.equal(count(t, 'beta-co'), 1, `beta ${t}`)
  assert.equal(stripe.subs.sub_B, 'active')
  assert.equal(kv.m.has('google:beta-co'), true)
  // Members lost access at once; the public booking page is gone.
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: c })).json().customer, null)
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha-co', { params: { customer: 'alpha-co' } })).status, 404)
  // Record + permanent audit trail, without personal data.
  const j = job('alpha-co')
  assert.deepEqual([j.status, j.step, j.last_error], ['completed', 'done', null])
  assert.match(j.requested_by, /^owner:ref:[0-9a-f]{20}$/)
  const report = JSON.parse(j.report)
  assert.deepEqual(report.verify.clean, true)
  assert.equal(report.billing.canceled, 1)
  assert.deepEqual(auditActions('alpha-co').slice(-8), ['account.deletion_requested', 'account.deletion_lockout', 'account.deletion_ads', 'account.deletion_billing', 'account.deletion_integrations', 'account.deletion_data', 'account.deletion_verify', 'account.deletion_completed'])
  const auditText = JSON.stringify(db.sql.prepare('SELECT * FROM audit_log').all())
  for (const s of ['jamie', 'Lee Lead', 'example.net', '1 Main St', '843-555']) assert.ok(!auditText.includes(s), `audit has no ${s}`)
  assert.equal((await verifyAuditChain(db)).ok, true)
  // A second request is a no-op; a returning owner starts fresh (the old id is never reused).
  assert.equal((await requestDeletion(env, 'alpha-co', { type: 'owner', id: OWNER })).status, 'completed')
  assert.notEqual(await uniqueCustomerId(env, 'Alpha Co'), 'alpha-co')
})

test('shared Google grant: the token is deleted but NOT revoked while another business still uses the same grant', async () => {
  await kv.put('google:beta-co', JSON.stringify({ customer: 'beta-co', refreshToken: await encrypt(env, RT), googleSub: 'sub-A', clientId: 'cid', scope: 'x' }))
  db.sql.prepare("DELETE FROM self_signups WHERE customer = 'alpha-co'").run()
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: OWNER })
  assert.equal(job('alpha-co').status, 'completed')
  assert.equal(kv.m.has('google:alpha-co'), false)
  assert.equal(fetches.filter((f) => f.path === '/revoke').length, 1, 'only the archived grant from the old client (not shared) is revoked')
  assert.equal(kv.m.has('google:beta-co'), true)
})

test('retries: Stripe down → services already off, step retried with backoff by the cron until it completes; no double cancel', async () => {
  stripe.fail = 503
  const t0 = Date.now()
  const r = await requestDeletion(env, 'alpha-co', { type: 'admin', id: 'founder@getshowups.example' }, t0)
  assert.deepEqual([r.status, r.step, r.error], ['in_progress', 'billing', 'stripe_api_connection_error'])
  assert.equal(count('customer_users', 'alpha-co'), 0, 'lockout already done')
  assert.equal(db.sql.prepare("SELECT status, error FROM messages WHERE customer = 'alpha-co'").get().error, 'account_deleted', 'pending reminder cancelled')
  assert.equal(count('leads', 'alpha-co'), 1, 'data not erased before billing has ended (order)')
  const j1 = job('alpha-co')
  assert.deepEqual([j1.attempts, j1.last_error], [1, 'stripe_api_connection_error'])
  assert.ok(j1.next_attempt_at >= t0 + 5 * MIN)
  assert.deepEqual(await processDeletions(env, { now: t0 + MIN }), { enabled: true, advanced: 0, completed: 0, failed: 0 }, 'not due yet')
  assert.deepEqual(await processDeletions(env, { now: t0 + 5 * MIN }), { enabled: true, advanced: 1, completed: 0, failed: 1 })
  const j2 = job('alpha-co')
  assert.equal(j2.attempts, 2)
  assert.ok(j2.next_attempt_at >= t0 + 15 * MIN, 'backoff doubles')
  stripe.fail = null
  assert.deepEqual(await processDeletions(env, { now: j2.next_attempt_at }), { enabled: true, advanced: 1, completed: 1, failed: 0 })
  assert.equal(job('alpha-co').status, 'completed')
  assert.equal(fetches.filter((f) => f.method === 'DELETE' && f.path === '/v1/subscriptions/sub_A').length, 1, 'canceled once')
  assert.ok(auditActions('alpha-co').includes('account.deletion_step_failed'))
})

test('ads: a campaign that cannot be paused blocks the deletion (retried), never skipped; launch/Start refused meanwhile', async () => {
  db.sql.prepare("UPDATE ad_campaigns SET status = 'active' WHERE customer = 'alpha-co'").run() // running, no ad connection → pause fails
  const r = await requestDeletion(env, 'alpha-co', { type: 'owner', id: OWNER })
  assert.deepEqual([r.step, r.error], ['ads', 'ads_not_paused'])
  const H = await import('../server/ads/holds.js')
  assert.deepEqual(await H.adsHold(env, 'alpha-co'), { reason: 'account_deleted' })
  assert.equal(stripe.subs.sub_A, 'active', 'later steps wait')
  db.sql.prepare("UPDATE ad_campaigns SET status = 'paused' WHERE customer = 'alpha-co'").run() // e.g. paused once Google answers
  const done = await processDeletions(env, { now: job('alpha-co').next_attempt_at })
  assert.equal(done.completed, 1)
})

test('platform admin: typed confirmation, audited, retry now; customer detail shows the status', async () => {
  const c = await cookie('founder@getshowups.example')
  const post = (body) => call(pDeletion, 'POST', '/api/platform/deletion', { cookie: c, body })
  assert.equal((await post({ customer: 'alpha-co', action: 'request', confirm: true, confirmId: 'beta-co' })).json().error, 'confirmation_required')
  assert.equal((await call(pDeletion, 'POST', '/api/platform/deletion', { cookie: await cookie(OWNER), body: { customer: 'alpha-co', action: 'request', confirm: true, confirmId: 'alpha-co' } })).status, 403)
  stripe.fail = 500
  const r = await post({ customer: 'alpha-co', action: 'request', confirm: true, confirmId: 'alpha-co' })
  assert.equal(r.status, 200)
  assert.deepEqual([r.json().deletion.status, r.json().deletion.step], ['in_progress', 'billing'])
  stripe.fail = null
  const retry = await post({ customer: 'alpha-co', action: 'retry', confirm: true, confirmId: 'alpha-co' })
  assert.equal(retry.json().deletion.status, 'completed')
  assert.deepEqual(
    db.sql.prepare("SELECT action FROM admin_audit WHERE action LIKE 'customer.delete%' ORDER BY id").all().map((x) => x.action),
    ['customer.delete', 'customer.delete_retry'],
  )
  const pCustomer = await import('../functions/api/platform/customer.js')
  const detail = await call(pCustomer, 'GET', '/api/platform/customer?id=alpha-co', { cookie: c })
  assert.equal(detail.status, 200)
  assert.deepEqual([detail.json().deletion.enabled, detail.json().deletion.status], [true, 'completed'])
})

test('new business tables must be classified: every table with a customer column is erased or explicitly retained', async () => {
  const retained = new Set(['customers', 'subscriptions', 'subscription_modes', 'events', 'ai_usage', 'test_businesses', 'audit_log', 'admin_audit', 'account_deletions'])
  const withCustomer = db.sql
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((t) => db.sql.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'customer'))
  const unclassified = withCustomer.filter((t) => !ERASED_TABLES.includes(t) && !retained.has(t))
  assert.deepEqual(unclassified, [], 'add the table to ERASED_TABLES or document it as retained (docs/DATA_RETENTION.md)')
})
