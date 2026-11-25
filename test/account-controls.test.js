// Account controls: people, sessions, fresh sign-in, closing window, personal deletion, export, plan cancel/keep, closed
// dates, restrictions, restored-backup protection. Real handlers + migrations on node:sqlite; Stripe mocked.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { advanceDeletion, cancelDeletion, processDeletions, requestDeletion } from '../server/deletion.js'
import { uniqueCustomerId } from '../server/customers.js'
import { computeSlots } from '../server/calendar.js'
import { holidays } from '../server/dates.js'
import { cell, csv } from '../server/business-export.js'
import { missingUnit, setupCheck } from '../server/setup-check.js'
import { noticesOff } from '../server/notice-prefs.js'
import { adsAccess } from '../server/ads/access.js'
import { adsHold } from '../server/ads/holds.js'
import { customerFromRow } from '../server/auth.js'
import * as people from '../functions/api/dashboard/people.js'
import * as account from '../functions/api/dashboard/account.js'
import * as availability from '../functions/api/dashboard/availability.js'
import * as exportRoute from '../functions/api/dashboard/export.js'
import * as integrations from '../functions/api/dashboard/integrations.js'
import * as billing from '../functions/api/dashboard/billing.js'
import * as pControls from '../functions/api/platform/controls.js'
import * as pStatus from '../functions/api/platform/status.js'

const ORIGIN = 'https://getshowups.com'
const ADMIN = 'founder@getshowups.example'
const DAY = 86400000
let env, sql, kv, stripe, origFetch, origError, calls

function open(skip = []) {
  sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys = ON')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => {
      assert.ok(!a.includes(undefined), `undefined bound: ${q}`)
      return stmt(q, a)
    },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
    prepare: (q) => stmt(q),
    batch: async (l) => {
      sql.exec('BEGIN')
      try {
        const r = l.map((s) => ({ results: [], meta: { changes: sql.prepare(s.q).run(...s.args).changes } }))
        sql.exec('COMMIT')
        return r
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}
const q = (s, ...a) => sql.prepare(s).run(...a)
const one = (s, ...a) => sql.prepare(s).get(...a)

async function setup(skip = []) {
  kv = new Map()
  calls = []
  stripe = { sub: { id: 'sub_A', status: 'active', cancel_at_period_end: false, cancel_at: null, customer: 'cus_A', items: { data: [{ current_period_end: 1900000000, price: { id: 'price_x', unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] } }, ignoreUpdate: false, down: false }
  env = {
    ONBOARDING_DB: open(skip),
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)),
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, ADMIN_API_TOKEN: 'a'.repeat(40),
    STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', PLATFORM_ADMIN_EMAILS: ADMIN, ACCOUNT_DELETION_ENABLED: 'true',
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const method = init.method || 'GET'
    calls.push(`${method} ${u.pathname}`)
    const reply = (status, body) => new Response(JSON.stringify(body), { status })
    if (u.host !== 'api.stripe.com') throw new Error(`unexpected ${u}`)
    if (stripe.down) return reply(500, { error: { code: 'api_error' } })
    if (u.pathname === '/v1/subscriptions/sub_A') {
      if (method === 'DELETE') stripe.sub.status = 'canceled'
      if (method === 'POST' && !stripe.ignoreUpdate) {
        const f = new URLSearchParams(init.body)
        if (f.has('cancel_at_period_end')) stripe.sub.cancel_at_period_end = f.get('cancel_at_period_end') === 'true'
        if (f.get('cancel_at') === '') stripe.sub.cancel_at = null
      }
      return reply(200, stripe.sub)
    }
    if (u.pathname === '/v1/subscriptions') return reply(200, { data: [stripe.sub] })
    if (u.pathname === '/v1/customers/cus_A') return reply(200, method === 'DELETE' ? { deleted: true } : { id: 'cus_A', invoice_settings: { default_payment_method: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } } })
    if (u.pathname === '/v1/invoices/create_preview') return reply(200, { amount_due: 49900, currency: 'usd', next_payment_attempt: 1900000000 })
    if (u.pathname === '/v1/invoices') return reply(200, { data: [{ number: 'A-1', created: 1800000000, status: 'paid', amount_paid: 49900, currency: 'usd', customer: 'cus_A', hosted_invoice_url: 'https://invoice.stripe.com/i/x', invoice_pdf: 'javascript:alert(1)' }, { number: 'B-9', created: 1, status: 'paid', amount_paid: 1, customer: 'cus_OTHER' }, { status: 'draft', created: 2 }] })
    throw new Error(`unexpected ${method} ${u}`)
  }
  for (const [id, owner] of [['alpha-co', 'ann@alpha.example'], ['beta-co', 'bob@beta.example']]) {
    const now = Date.now()
    q("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)", id, id === 'alpha-co' ? 'Alpha Co' : 'Beta Co', now, now, now)
    q('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)', owner, id, 1000)
    q("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, '=HYPERLINK(\"x\")', 'c@x.example', '+1 843 555 0100', 'SECRET-' || ?, '29401', 'new', 'x', 1, 1)", `lead-${id}`, id, id)
    kv.set(`google:${id}`, JSON.stringify({}))
  }
  q("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, cancel_at_period_end, last_event_at, updated_at) VALUES ('alpha-co', 'cus_A', 'sub_A', 'founding', 'active', 49900, 'usd', 1900000000000, 0, 1, 1)")
}
beforeEach(async () => {
  origFetch = globalThis.fetch
  origError = console.error
  console.error = () => {}
  await setup()
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
})

let n = 0
async function signIn(email, ageMs = 0) {
  const token = `T${String(++n).padStart(42, '0')}`
  q('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)', await sha256Hex(token), email, Date.now() - ageMs, Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, origin = ORIGIN, headers = {} } = {}) {
  const request = new Request(`${ORIGIN}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) })
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request, env, params: {} })
  const buf = new Uint8Array(await res.arrayBuffer())
  let data = null
  try {
    data = JSON.parse(new TextDecoder().decode(buf))
  } catch {}
  return { status: res.status, data, buf, headers: res.headers }
}
const post = (mod, path) => (cookie, body, opts = {}) => call(mod, 'POST', path, { cookie, body, ...opts })
const ppl = (...a) => post(people, '/api/dashboard/people')(...a)
const acct = (...a) => post(account, '/api/dashboard/account')(...a)
const plan = (...a) => post(billing, '/api/dashboard/billing')(...a)
const ctl = (...a) => post(pControls, '/api/platform/controls')(...a)

test('people: only the owner invites and removes, with a recent sign-in; never the last one; another business is untouched', async () => {
  const ann = await signIn('ann@alpha.example')
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  const mo = await signIn('mo@alpha.example')
  assert.equal((await ppl(mo, { action: 'remove', email: 'ann@alpha.example', confirm: true })).status, 403)
  assert.equal((await ppl(mo, { action: 'invite', email: 'x@y.example' })).status, 403)
  const old = await signIn('ann@alpha.example', 16 * 60000)
  assert.deepEqual([(await ppl(old, { action: 'invite', email: 'x@y.example' })).data.error, (await ppl(old, { action: 'remove', email: 'mo@alpha.example', confirm: true })).data.error], ['reauth_required', 'reauth_required'])
  assert.equal((await ppl(ann, { action: 'invite', email: 'new@y.example' }, { origin: 'https://evil.example' })).status, 403)
  const inv = await ppl(ann, { action: 'invite', email: 'New@y.example' })
  assert.equal(inv.status, 200)
  assert.equal(inv.data.emailed, false, 'the launch gate is shut: the owner is told to pass the link on')
  assert.match(inv.data.url, /invite=/)
  assert.equal((await ppl(ann, { action: 'remove', email: 'bob@beta.example', confirm: true })).status, 404)
  assert.equal((await ppl(ann, { action: 'remove', email: 'mo@alpha.example', confirm: true })).status, 200)
  assert.equal((await ppl(mo, { action: 'leave', confirm: true })).status, 401, 'removed people are signed out')
  assert.equal((await ppl(ann, { action: 'leave', confirm: true })).data.error, 'last_member')
  const seen = await call(people, 'GET', '/api/dashboard/people', { cookie: ann })
  assert.deepEqual(seen.data.members.map((m) => [m.email, m.owner]), [['ann@alpha.example', true]])
  assert.ok(!JSON.stringify(seen.data).includes('beta'))
  // Someone else's invitation can't be cancelled.
  const bob = await signIn('bob@beta.example')
  assert.equal((await ppl(bob, { action: 'cancel_invite', id: seen.data.invites[0].id })).status, 404)
})

test('the owner can leave when someone remains, and the next person becomes owner', async () => {
  const ann = await signIn('ann@alpha.example')
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  assert.equal((await ppl(ann, { action: 'leave', confirm: true })).status, 200)
  const mo = await signIn('mo@alpha.example')
  assert.equal((await call(people, 'GET', '/api/dashboard/people', { cookie: mo })).data.you.owner, true)
})

test('sessions: end the others, or all of them; only your own', async () => {
  const a = await signIn('ann@alpha.example')
  const b = await signIn('ann@alpha.example')
  const bob = await signIn('bob@beta.example')
  assert.equal((await ppl(a, { action: 'end_sessions' })).data.ended, 1)
  assert.equal((await call(people, 'GET', '/api/dashboard/people', { cookie: b })).status, 401)
  assert.equal((await ppl(a, { action: 'end_sessions', all: true })).data.ended, 1)
  assert.equal((await call(people, 'GET', '/api/dashboard/people', { cookie: bob })).status, 200)
})

test('closing: owner + recent sign-in + typed name; a forged or cross-business request does nothing', async () => {
  const old = await signIn('ann@alpha.example', 20 * 60000)
  assert.equal((await acct(old, { action: 'delete', confirm: true, name: 'Alpha Co' })).data.error, 'reauth_required')
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  const mo = await signIn('mo@alpha.example')
  assert.equal((await acct(mo, { action: 'delete', confirm: true, name: 'Alpha Co' })).data.error, 'owner_only')
  const ann = await signIn('ann@alpha.example')
  assert.equal((await acct(ann, { action: 'delete', confirm: true, name: 'Beta Co' })).data.error, 'name_mismatch')
  assert.equal((await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co', customer: 'beta-co' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal(one('SELECT count(*) n FROM account_deletions').n, 0)
  // Internal businesses can't be deleted by anyone from the product.
  q("INSERT INTO business_accounts (customer, classification, billing, environment, set_by, set_at) VALUES ('alpha-co', 'internal_live', 'complimentary', 'production', 'x', 1)")
  assert.equal((await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co' })).data.error, 'protected_business')
  assert.equal((await requestDeletion(env, 'alpha-co', { type: 'admin', id: ADMIN })).error, 'protected_business')
})

test('recovery window: offline, nothing erased, plan ends without renewing, undo restores; then it deletes and can’t be undone', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '14'
  const ann = await signIn('ann@alpha.example')
  const r = await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co' })
  assert.equal(r.status, 202)
  assert.ok(r.data.scheduledFor > Date.now() + 13 * DAY)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'suspended')
  assert.equal(stripe.sub.cancel_at_period_end, true)
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
  assert.equal((await adsHold(env, 'alpha-co')).reason, 'account_deleted')
  const st = await call(account, 'GET', '/api/dashboard/account', { cookie: ann })
  assert.deepEqual([st.data.business.chargesStopped, st.data.business.scheduledFor > 0], [true, true], 'the owner still sees it')
  // An admin reactivation can't quietly put it back, and "retry" doesn't skip the window.
  const admin = await signIn(ADMIN)
  assert.equal((await call(pStatus, 'POST', '/api/platform/status', { cookie: admin, body: { customer: 'alpha-co', status: 'active', reason: 'mistake', confirm: true } })).data.error, 'being_deleted')
  assert.equal((await advanceDeletion(env, 'alpha-co')).status, 'scheduled')
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
  assert.equal((await acct(ann, { action: 'undo_delete', confirm: true })).status, 200)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'active')
  assert.equal(stripe.sub.cancel_at_period_end, true, 'never starts charging again by itself')
  assert.equal((await acct(ann, { action: 'undo_delete', confirm: true })).data.error, 'not_scheduled')

  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  const later = Date.now() + 15 * DAY
  assert.equal((await cancelDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' }, later)).error, 'not_scheduled', 'too late')
  await processDeletions(env, { now: later })
  assert.equal(one("SELECT status FROM account_deletions WHERE customer = 'alpha-co'").status, 'completed')
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 0)
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'beta-co'").n, 1)
})

test('a suspended business that is closed and undone stays suspended', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '14'
  q("UPDATE customers SET status = 'suspended' WHERE id = 'alpha-co'")
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  assert.equal((await cancelDeletion(env, 'alpha-co', { type: 'owner', id: 'x' })).ok, true)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'suspended')
})

test('undo always wins over a run that was already under way, and an undone deletion never erases', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '14'
  stripe.down = true
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  stripe.down = false
  // The owner undoes while the cron is waiting for Stripe.
  const f = globalThis.fetch
  let undone
  globalThis.fetch = async (...a) => {
    undone ??= await cancelDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
    return f(...a)
  }
  await processDeletions(env, { now: Date.now() + 400000 })
  assert.equal(undone.ok, true)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'active')
  globalThis.fetch = f
  // A run that read the job just before the undo finds nothing to claim.
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  const db = env.ONBOARDING_DB
  const prepare = db.prepare
  let once = true
  db.prepare = (sqlText) => {
    if (once && sqlText.includes("json_set(report, '$.claimed'")) {
      once = false
      q("DELETE FROM account_deletions WHERE customer = 'alpha-co'")
    }
    return prepare(sqlText)
  }
  assert.equal((await advanceDeletion(env, 'alpha-co', Date.now() + 15 * DAY)).status, 'not_found')
  db.prepare = prepare
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
  // Once claimed, an undo is refused.
  q("INSERT INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at, report) VALUES ('alpha-co', 1, 'x', 'in_progress', 'lockout', ?, '{\"claimed\":1}')", Date.now() + DAY)
  assert.equal((await cancelDeletion(env, 'alpha-co', { type: 'owner', id: 'x' })).error, 'not_scheduled')
})

test('closing window: an admin suspension survives the undo; the plan can’t be kept; one resumed in Stripe is ended again; reminders come back', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '14'
  q("INSERT INTO messages (id, customer, lead_id, kind, channel, send_at, status, created_at, updated_at) VALUES ('m1', 'alpha-co', 'lead-alpha-co', 'lead_followup_1', 'email', ?, 'scheduled', 1, 1)", Date.now() + DAY)
  const ann = await signIn('ann@alpha.example')
  await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co' })
  assert.equal(one("SELECT error FROM messages WHERE id = 'm1'").error, 'account_closing')
  assert.equal((await plan(ann, { action: 'keep', confirm: true })).data.error, 'closing')
  stripe.sub.cancel_at_period_end = false
  q("UPDATE subscriptions SET cancel_at_period_end = 0 WHERE customer = 'alpha-co'")
  assert.equal((await call(account, 'GET', '/api/dashboard/account', { cookie: ann })).data.business.chargesStopped, false, 'never claimed from an old answer')
  await processDeletions(env, { now: Date.now() + 400000 })
  assert.equal(stripe.sub.cancel_at_period_end, true)
  const admin = await signIn(ADMIN)
  assert.equal((await call(pStatus, 'POST', '/api/platform/status', { cookie: admin, body: { customer: 'alpha-co', status: 'suspended', reason: 'abuse report', confirm: true } })).status, 200)
  assert.equal((await acct(ann, { action: 'undo_delete', confirm: true })).status, 200)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'suspended')
  assert.equal(one("SELECT status FROM messages WHERE id = 'm1'").status, 'scheduled')
})

test('a suspension recorded while a closing is being held survives; a claim only takes the job it read', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '14'
  const f = globalThis.fetch
  globalThis.fetch = async (...a) => {
    q("UPDATE account_deletions SET report = json_set(report, '$.wasStatus', 'suspended') WHERE customer = 'alpha-co'")
    return f(...a)
  }
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  globalThis.fetch = f
  assert.equal(JSON.parse(one("SELECT report FROM account_deletions").report).wasStatus, 'suspended')
  const prepare = env.ONBOARDING_DB.prepare
  env.ONBOARDING_DB.prepare = (x) => {
    if (x.includes("json_set(report, '$.claimed'")) q("UPDATE account_deletions SET requested_at = requested_at + 1, next_attempt_at = next_attempt_at + 1 WHERE customer = 'alpha-co'")
    return prepare(x)
  }
  assert.equal((await advanceDeletion(env, 'alpha-co', Date.now() + 15 * DAY)).status, 'not_found')
  env.ONBOARDING_DB.prepare = prepare
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
})

test('the restore marker is written before a deletion can be called completed', async () => {
  const put = env.GOOGLE_TOKENS.put
  env.GOOGLE_TOKENS.put = async (k, v) => {
    if (k.startsWith('deleted:')) throw new Error('kv down')
    return put(k, v)
  }
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  assert.equal(one("SELECT status FROM account_deletions WHERE customer = 'alpha-co'").status, 'in_progress')
  env.GOOGLE_TOKENS.put = put
  await processDeletions(env, { now: Date.now() + DAY })
  assert.equal(one("SELECT status FROM account_deletions WHERE customer = 'alpha-co'").status, 'completed')
  assert.ok(kv.has('deleted:alpha-co'))
})

test('disconnecting Calendar never revokes a grant an ads or profile connection may share', async () => {
  const { encrypt } = await import('../server/google-oauth.js')
  const ann = await signIn('ann@alpha.example')
  const revoked = []
  const f = globalThis.fetch
  globalThis.fetch = async (u, i) => (String(u).includes('/revoke') ? (revoked.push(1), new Response('{}')) : f(u, i))
  const connect = async () => kv.set('google:alpha-co', JSON.stringify({ customer: 'alpha-co', refreshToken: await encrypt(env, 'rt'), googleSub: 'g1', clientId: 'cid' }))
  await connect()
  kv.set('ads:google:alpha-co', 'sealed')
  let r = await call(integrations, 'POST', '/api/dashboard/integrations', { cookie: ann, body: { action: 'disconnect', id: 'calendar', confirm: true } })
  assert.deepEqual([r.data.revokeAsked, revoked.length, kv.has('ads:google:alpha-co')], [false, 0, true])
  kv.delete('ads:google:alpha-co')
  await connect()
  r = await call(integrations, 'POST', '/api/dashboard/integrations', { cookie: ann, body: { action: 'disconnect', id: 'calendar', confirm: true } })
  assert.deepEqual([r.data.revokeAsked, revoked.length], [true, 1])
  globalThis.fetch = f
})

test('only the owner opens billing; deleting one person never alters another address', async () => {
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  const mo = await signIn('mo@alpha.example')
  assert.equal((await plan(mo, { action: 'portal' })).status, 403)
  q("INSERT INTO admin_audit (at, actor, action, customer, details) VALUES (1, 'x', 'invite', 'beta-co', '{\"email\":\"momo@alpha.example\"}')")
  q("INSERT INTO admin_audit (at, actor, action, customer, details) VALUES (2, 'x', 'invite', 'alpha-co', ?)", `{"note":"asked by 'Mo@alpha.example'."}`)
  assert.equal((await acct(mo, { action: 'delete_me', confirm: true, email: 'mo@alpha.example' })).status, 200)
  assert.equal(one('SELECT details FROM admin_audit WHERE at = 1').details, '{"email":"momo@alpha.example"}')
  assert.ok(!/mo@alpha/i.test(one('SELECT details FROM admin_audit WHERE at = 2').details))
})

test('recovery window with Stripe down: reported as not stopped yet, and the cron keeps trying', async () => {
  env.ACCOUNT_RECOVERY_DAYS = '7'
  stripe.down = true
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  const ann = await signIn('ann@alpha.example')
  assert.equal((await call(account, 'GET', '/api/dashboard/account', { cookie: ann })).data.business.chargesStopped, false)
  stripe.down = false
  await processDeletions(env, { now: Date.now() + 3600000 })
  assert.equal(stripe.sub.cancel_at_period_end, true)
  assert.equal((await call(account, 'GET', '/api/dashboard/account', { cookie: ann })).data.business.chargesStopped, true)
})

test('a partial failure is never reported as deleted', async () => {
  stripe.down = true
  const ann = await signIn('ann@alpha.example')
  const r = await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co' })
  assert.deepEqual([r.status, r.data.status], [202, 'in_progress'])
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
  const admin = await signIn(ADMIN)
  const list = (await call(pControls, 'GET', '/api/platform/controls', { cookie: admin })).data
  assert.deepEqual([list.deletions[0].state, list.deletions[0].step], ['failed', 'billing'])
})

test('ChatGPT Ads credentials go with the account', async () => {
  kv.set('ads:openai:alpha-co', 'sealed')
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  assert.equal(kv.has('ads:openai:alpha-co'), false)
  assert.equal(one("SELECT status FROM account_deletions WHERE customer = 'alpha-co'").status, 'completed')
})

test('a restored backup can’t resurrect a deleted business: offline within the hour, deleted again, id never reused', async () => {
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  assert.ok(kv.has('deleted:alpha-co'))
  // "Restore": the business, a member, a lead and an active status are back; the deletion record is gone.
  q("DELETE FROM account_deletions WHERE customer = 'alpha-co'")
  q("UPDATE customers SET name = 'Alpha Co', status = 'active' WHERE id = 'alpha-co'")
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('ann@alpha.example', 'alpha-co', 1000)")
  q("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('back', 'alpha-co', 'n', 'e@x.example', '1', 'x', 'new', 'x', 1, 1)")
  const hour = Math.floor(Date.now() / 3600000) * 3600000
  delete env.ACCOUNT_DELETION_ENABLED // even while switched off it is taken offline
  assert.equal((await processDeletions(env, { now: hour })).replayed, 1)
  assert.equal(one("SELECT status FROM customers WHERE id = 'alpha-co'").status, 'suspended')
  assert.equal((await processDeletions(env, { now: hour + 3600000 })).replayed ?? 0, 0, 'found once, not every hour')
  env.ACCOUNT_DELETION_ENABLED = 'true'
  await processDeletions(env, { now: hour + 3600000 + 400000 })
  assert.equal(one("SELECT count(*) n FROM customer_users WHERE customer = 'alpha-co'").n, 0)
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 0)
  q("DELETE FROM account_deletions WHERE customer = 'alpha-co'")
  assert.equal((await processDeletions(env, { now: hour + 7200000 })).replayed ?? 0, 0, 'a tombstone is left alone')
  assert.notEqual(await uniqueCustomerId(env, 'Alpha Co'), 'alpha-co')
})

test('while deletion is off: the owner asks, sees it, can withdraw; the founder sees and resolves it; nothing is erased', async () => {
  delete env.ACCOUNT_DELETION_ENABLED
  const ann = await signIn('ann@alpha.example')
  assert.equal((await acct(ann, { action: 'delete', confirm: true, name: 'Alpha Co' })).status, 404)
  assert.equal((await acct(ann, { action: 'request_closure', confirm: true })).status, 200)
  assert.equal((await acct(ann, { action: 'request_closure', confirm: true })).data.error, 'already_requested')
  const admin = await signIn(ADMIN)
  assert.deepEqual((await call(pControls, 'GET', '/api/platform/controls', { cookie: admin })).data.requests.map((r) => r.customer), ['alpha-co'])
  assert.equal((await ctl(admin, { action: 'resolve_closure', customer: 'alpha-co', confirm: true, reason: 'no' })).data.error, 'reason_required')
  assert.equal((await ctl(admin, { action: 'resolve_closure', customer: 'alpha-co', confirm: true, reason: 'called the owner' })).status, 200)
  assert.equal((await call(account, 'GET', '/api/dashboard/account', { cookie: ann })).data.business.request, null)
  assert.equal(one("SELECT count(*) n FROM leads WHERE customer = 'alpha-co'").n, 1)
  assert.equal((await ctl(ann, { action: 'end_sessions', customer: 'beta-co', confirm: true, reason: 'not an admin' })).status, 403)
})

test('personal account: never a platform admin or the only member; otherwise everything of the person goes, the business stays', async () => {
  const ann = await signIn('ann@alpha.example')
  assert.equal((await acct(ann, { action: 'delete_me', confirm: true, email: 'ann@alpha.example' })).data.error, 'only_member')
  const admin = await signIn(ADMIN)
  assert.equal((await acct(admin, { action: 'delete_me', confirm: true, email: ADMIN })).data.error, 'platform_admin')
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  q("INSERT INTO owner_notice_off (customer, email, kind, created_at) VALUES ('alpha-co', 'mo@alpha.example', 'owner_lead', 1)")
  q("INSERT INTO email_outbox (id, to_email, customer, template, subject, body, status, created_at) VALUES ('o1', 'mo@alpha.example', 'alpha-co', 'x', 's', 'b', 'sent', 1)")
  q("INSERT INTO admin_audit (at, actor, action, customer, details) VALUES (1, 'founder@getshowups.example', 'invite', 'alpha-co', '{\"email\":\"mo@alpha.example\"}')")
  q('INSERT INTO events (id, type, customer, at, props) VALUES (?, ?, NULL, 1, ?)', `signup:${await sha256Hex('mo@alpha.example')}`, 'signup', '{}')
  const mo = await signIn('mo@alpha.example')
  const stale = await signIn('mo@alpha.example', 60 * 60000)
  assert.equal((await acct(stale, { action: 'delete_me', confirm: true, email: 'mo@alpha.example' })).data.error, 'reauth_required')
  assert.equal((await acct(mo, { action: 'delete_me', confirm: true, email: 'ann@alpha.example' })).data.error, 'email_mismatch')
  const r = await acct(mo, { action: 'delete_me', confirm: true, email: 'mo@alpha.example' })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('Set-Cookie'), /Max-Age=0/)
  for (const t of sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const rows = sql.prepare(`SELECT * FROM ${t.name}`).all()
    assert.ok(!JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? '' : v)).includes('mo@alpha.example'), `left in ${t.name}`)
  }
  assert.equal(one("SELECT count(*) n FROM customer_users WHERE customer = 'alpha-co'").n, 1)
  assert.equal(one("SELECT count(*) n FROM events WHERE id LIKE 'signup:%'").n, 0)
})

test('export: owner and recent sign-in only; this business only; no credentials; spreadsheet formulas are neutralised', async () => {
  const old = await signIn('ann@alpha.example', 20 * 60000)
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: old })).data.error, 'reauth_required')
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export')).status, 401)
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: await signIn('mo@alpha.example') })).status, 403)
  q("INSERT INTO ai_credentials (customer, provider, sealed, hint, status, created_at, updated_at) VALUES ('alpha-co', 'openai', 'SEALED-KEY', '1234', 'ok', 1, 1)")
  const ann = await signIn('ann@alpha.example')
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: ann, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  const r = await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: ann })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('Content-Type'), 'application/zip')
  const text = new TextDecoder().decode(r.buf)
  for (const f of ['README.txt', 'customers.csv', 'appointments.csv', 'recorded_payments.csv', 'business.json', 'ai_knowledge.json', 'website.json']) assert.ok(text.includes(f), f)
  assert.ok(text.includes('SECRET-alpha-co') && !text.includes('SECRET-beta-co'))
  assert.ok(!text.includes('SEALED-KEY') && !text.includes('token_hash'))
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`))
  assert.equal(one("SELECT count(*) n FROM audit_log WHERE action = 'account.data_exported'").n, 1)
  assert.deepEqual([cell('+1 843 555 0100'), cell('-5'), cell('@cmd'), cell('a,b'), cell(null)], ['+1 843 555 0100', '-5', "'@cmd", '"a,b"', ''])
  assert.ok(csv(['a'], [['x']]).startsWith('﻿a\r\nx'))
})

test('export fails instead of looking complete when a part can’t be read', async () => {
  sql.exec('ALTER TABLE leads RENAME COLUMN created_at TO gone')
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: await signIn('ann@alpha.example') })).status, 503)
})

test('plan: next charge, card and invoices come from Stripe for this customer only; unsafe links are dropped', async () => {
  const d = (await call(billing, 'GET', '/api/dashboard/billing?details=1', { cookie: await signIn('ann@alpha.example') })).data
  assert.equal(d.nextCharge.amountCents, 49900)
  assert.deepEqual([d.card.brand, d.card.last4], ['visa', '4242'])
  assert.deepEqual(d.invoices.map((i) => [i.number, i.url, i.pdf]), [['A-1', 'https://invoice.stripe.com/i/x', null]])
  assert.equal((await call(billing, 'GET', '/api/dashboard/billing?details=1', { cookie: await signIn('bob@beta.example') })).data.error, 'no_billing_account')
})

test('cancel: only after Stripe confirms; idempotent; keep is explicit; both owner-only; failures change nothing here', async () => {
  const ann = await signIn('ann@alpha.example')
  assert.equal((await plan(ann, { action: 'cancel' })).data.error, 'confirmation_required')
  q("INSERT INTO customer_users (email, customer, created_at) VALUES ('mo@alpha.example', 'alpha-co', 2000)")
  assert.equal((await plan(await signIn('mo@alpha.example'), { action: 'cancel', confirm: true })).status, 403)
  stripe.ignoreUpdate = true
  assert.deepEqual([(await plan(ann, { action: 'cancel', confirm: true })).status, one("SELECT cancel_at_period_end c FROM subscriptions WHERE customer = 'alpha-co'").c], [502, 0])
  stripe.ignoreUpdate = false
  stripe.down = true
  assert.equal((await plan(ann, { action: 'cancel', confirm: true })).status, 502)
  stripe.down = false
  const r = await plan(ann, { action: 'cancel', confirm: true })
  assert.deepEqual([r.status, r.data.endsAt], [200, 1900000000000])
  assert.equal(one("SELECT cancel_at_period_end c FROM subscriptions WHERE customer = 'alpha-co'").c, 1)
  const before = calls.filter((c) => c === 'POST /v1/subscriptions/sub_A').length
  assert.equal((await plan(ann, { action: 'cancel', confirm: true })).status, 200)
  assert.equal(calls.filter((c) => c === 'POST /v1/subscriptions/sub_A').length, before, 'already ending: Stripe isn’t changed again')
  assert.equal((await plan(ann, { action: 'keep' })).data.error, 'confirmation_required')
  assert.equal((await plan(ann, { action: 'keep', confirm: true })).status, 200)
  assert.equal(stripe.sub.cancel_at_period_end, false)
  // Cancelled from Stripe's own portal (cancel_at): kept the same way.
  stripe.sub.cancel_at = 1900000000
  assert.equal((await plan(ann, { action: 'keep', confirm: true })).status, 200)
  assert.equal(stripe.sub.cancel_at, null)
  stripe.sub.status = 'canceled'
  assert.equal((await plan(ann, { action: 'keep', confirm: true })).data.error, 'subscription_ended', 'an ended plan is never restarted here')
  assert.equal((await plan(ann, { action: 'cancel', confirm: true })).data.ended, true)
  assert.equal((await plan(await signIn('bob@beta.example'), { action: 'cancel', confirm: true })).data.error, 'no_subscription')
})

test('closed dates and notice: validated, conflict-safe, past dates dropped, followed by every slot', async () => {
  const ann = await signIn('ann@alpha.example')
  const save = (body) => call(availability, 'POST', '/api/dashboard/availability', { cookie: ann, body })
  const base = { minNoticeMinutes: 0, closures: [] }
  assert.equal((await save({ minNoticeMinutes: 7, closures: [] })).data.error, 'invalid_notice')
  assert.equal((await save({ minNoticeMinutes: 0, closures: [{ date: '2027-02-30' }] })).data.error, 'invalid_date')
  const r = await save({ minNoticeMinutes: 1440, closures: [{ date: '2099-12-25', label: 'Christmas' }, { date: '2001-01-01' }], base })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.closures, [{ date: '2099-12-25', label: 'Christmas' }])
  assert.equal((await save({ minNoticeMinutes: 0, closures: [], base })).data.error, 'conflict')
  assert.equal((await call(availability, 'GET', '/api/dashboard/availability', { cookie: await signIn('bob@beta.example') })).data.closures.length, 0)
  const rules = { timezone: 'America/New_York', slotMinutes: 60, dayStart: '09:00', dayEnd: '17:00', workdays: [1, 2, 3, 4, 5] }
  const now = Date.UTC(2026, 10, 25, 18, 0)
  const days = (extra) => [...new Set(computeSlots({ busy: [], rules: { ...rules, ...extra }, now, days: 4 }).slots.map((s) => new Date(s.start).toISOString().slice(0, 10)))]
  assert.deepEqual(days({}), ['2026-11-25', '2026-11-26', '2026-11-27'])
  assert.deepEqual(days({ closedDates: ['2026-11-26'] }), ['2026-11-25', '2026-11-27'])
  assert.deepEqual(days({ minNoticeMinutes: 1440 }), ['2026-11-26', '2026-11-27'])
  assert.deepEqual(holidays('2026-11-20', 40).map((h) => h.date), ['2026-11-26', '2026-12-25'])
  assert.deepEqual(holidays('2027-05-01', 130).map((h) => h.date), ['2027-05-31', '2027-07-04', '2027-09-06'])
})

test('setup check: facts from the records, consequences and where to fix them; nothing invented', async () => {
  const c = () => customerFromRow({ ...one("SELECT * FROM customers WHERE id = 'alpha-co'"), appointment_mode: 'at_customer' })
  const now = Date.UTC(2026, 10, 20, 15)
  const ids = (r) => r.items.map((x) => x.id)
  let r = await setupCheck(env, c(), now)
  for (const id of ['holiday_open', 'no_notice', 'no_area', 'no_services', 'no_phone', 'no_towns']) assert.ok(ids(r).includes(id), id)
  assert.equal(r.items[0].level, 'critical')
  q("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('alpha-co', '(843) 555-0100', 'Pool service', 'd', ?, '[\"Charleston\"]', 1)", JSON.stringify([{ name: 'Weekly Pool Care', price: '$300+' }, { name: 'One visit', price: '$200' }]))
  q("INSERT INTO business_closures (customer, date, label, created_at) VALUES ('alpha-co', '2026-11-26', '', 1)")
  r = await setupCheck(env, c(), now)
  assert.ok(!ids(r).includes('holiday_open') && ids(r).includes('price_unit'))
  assert.match(r.items.find((x) => x.id === 'price_unit').title, /Weekly Pool Care/)
  assert.deepEqual([{ name: 'Weekly care', price: '$300+ per month' }, { name: 'Monthly plan', price: '$99/mo' }, { name: 'Filter clean', price: '$90' }, { name: 'Weekly care', price: '' }].map(missingUnit), [false, false, false, false])
  sql.exec('ALTER TABLE business_policies RENAME TO bp')
  r = await setupCheck(env, c(), now)
  assert.deepEqual([r.unread, ids(r).includes('no_cancellation')], [['policies'], false], 'unreadable is never reported as missing')
})

test('notices: each person’s own choice; unknown kinds refused', async () => {
  const ann = await signIn('ann@alpha.example')
  assert.equal((await ppl(ann, { action: 'notice', kind: 'billing', on: false })).status, 400)
  assert.equal((await ppl(ann, { action: 'notice', kind: 'owner_lead', on: false })).status, 200)
  assert.ok((await noticesOff(env.ONBOARDING_DB, ['alpha-co'])).has('alpha-co|ann@alpha.example|owner_lead'))
  await ppl(ann, { action: 'notice', kind: 'owner_lead', on: true })
  assert.equal((await noticesOff(env.ONBOARDING_DB, ['alpha-co'])).size, 0)
})

test('restrictions: admin only, reason required, only ever take away, ads are held', async () => {
  const admin = await signIn(ADMIN)
  const c = customerFromRow(one("SELECT * FROM customers WHERE id = 'beta-co'"))
  assert.equal(await adsAccess(env, c), true)
  assert.equal((await ctl(admin, { action: 'restrict', customer: 'beta-co', feature: 'ads', confirm: true, reason: 'x' })).data.error, 'reason_required')
  assert.equal((await ctl(admin, { action: 'restrict', customer: 'beta-co', feature: 'billing', confirm: true, reason: 'not a feature' })).data.error, 'invalid_feature')
  assert.equal((await ctl(admin, { action: 'restrict', customer: 'beta-co', feature: 'ads', confirm: true, reason: 'policy review' })).status, 200)
  assert.equal(await adsAccess(env, c), true, 'the owner can still pause and disconnect')
  assert.equal((await adsHold(env, 'beta-co')).reason, 'restricted')
  assert.equal(await adsAccess(env, customerFromRow(one("SELECT * FROM customers WHERE id = 'alpha-co'"))), true)
  await ctl(admin, { action: 'unrestrict', customer: 'beta-co', feature: 'ads', confirm: true, reason: 'review done' })
  assert.equal(await adsAccess(env, c), true)
  const ann = await signIn('ann@alpha.example')
  await ctl(admin, { action: 'end_sessions', customer: 'alpha-co', confirm: true, reason: 'lost laptop' })
  assert.equal((await call(people, 'GET', '/api/dashboard/people', { cookie: ann })).status, 401)
  assert.equal((await call(pControls, 'GET', '/api/platform/controls', { cookie: admin })).status, 200, 'the founder isn’t signed out')
})

test('services: calendar disconnect is owner-only, confirmed, removes our access; Meta never leaves running ads behind', async () => {
  const ann = await signIn('ann@alpha.example')
  const go = (cookie, body) => call(integrations, 'POST', '/api/dashboard/integrations', { cookie, body })
  assert.equal((await go(ann, { action: 'disconnect', id: 'calendar' })).data.error, 'confirmation_required')
  assert.equal((await go(ann, { action: 'disconnect', id: 'google', confirm: true })).status, 400)
  assert.equal((await go(ann, { action: 'disconnect', id: 'calendar', confirm: true })).status, 200)
  assert.deepEqual([kv.has('google:alpha-co'), kv.has('google:beta-co')], [false, true])
  kv.set('ads:meta:alpha-co', 'x')
  q("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('k1', 'alpha-co', 'meta', 'active', '{}', 100, 1, 1)")
  assert.equal((await go(ann, { action: 'disconnect', id: 'meta', confirm: true })).data.error, 'campaigns_running')
  assert.ok(kv.has('ads:meta:alpha-co'))
  const items = (await call(integrations, 'GET', '/api/dashboard/integrations', { cookie: ann })).data.items
  assert.equal(items.find((x) => x.id === 'calendar').state, 'off')
})

test('before migration 0041 everything works as before', async () => {
  await setup(['0041'])
  const ann = await signIn('ann@alpha.example')
  assert.deepEqual([(await call(availability, 'GET', '/api/dashboard/availability', { cookie: ann })).data.ready, (await call(availability, 'POST', '/api/dashboard/availability', { cookie: ann, body: { minNoticeMinutes: 0, closures: [] } })).data.error], [false, 'not_available_yet'])
  assert.equal((await call(people, 'GET', '/api/dashboard/people', { cookie: ann })).data.notices, null)
  assert.equal((await ppl(ann, { action: 'end_sessions' })).status, 200)
  const c = customerFromRow(one("SELECT * FROM customers WHERE id = 'alpha-co'"))
  assert.equal(await adsAccess(env, c), true)
  assert.equal((await setupCheck(env, c)).items.some((x) => x.id === 'holiday_open'), false)
  assert.equal((await call(exportRoute, 'GET', '/api/dashboard/export', { cookie: ann })).status, 200)
  assert.equal((await ctl(await signIn(ADMIN), { action: 'restrict', customer: 'beta-co', feature: 'ads', confirm: true, reason: 'policy review' })).data.error, 'not_available_yet')
  await requestDeletion(env, 'alpha-co', { type: 'owner', id: 'ann@alpha.example' })
  assert.equal(one("SELECT status FROM account_deletions WHERE customer = 'alpha-co'").status, 'completed')
})
