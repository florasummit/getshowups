// ADM-02: MRR, Paying customers and Retention read the same value AND the same status word on the admin Overview and on
// Growth → Measure, because both pages word the same API facts through ONE function (src/admin/figures.js). The facts
// themselves come from the real handlers (server/metrics.js growth()) on node:sqlite: /api/platform/overview returns
// them as metrics.billing / metrics.retention30, /api/platform/growth as measure.billing / measure.retention30.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { sharedFigures } from '../src/admin/figures.js'
import * as overviewRoute from '../functions/api/platform/overview.js'
import * as growthRoute from '../functions/api/platform/growth.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86400000
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => Promise.all(list.map((s) => s.run())) }
}

test('the formatter: one value and one status word per state; test-mode billing is never a number', () => {
  const none = sharedFigures(null, null)
  assert.deepEqual([none.mrr.value, none.mrr.status, none.payingCustomers.value, none.payingCustomers.status, none.retention.value, none.retention.status], ['—', 'Unavailable', '—', 'Unavailable', '—', 'Unavailable'])
  const test1 = sharedFigures({ mode: 'test', testSubscriptions: 1, mrrCents: null, payingCustomers: null }, 50)
  assert.deepEqual([test1.mrr.value, test1.mrr.status, test1.payingCustomers.value, test1.payingCustomers.status], ['—', 'Test mode', '—', 'Test mode'])
  assert.equal(test1.mrr.note, 'Billing is in test mode: 1 active test subscription, none of it revenue.')
  assert.deepEqual([test1.retention.value, test1.retention.status], ['50%', 'Measured'])
  const live = sharedFigures({ mode: 'live', mrrCents: 99800, payingCustomers: 2 }, 100)
  assert.deepEqual([live.mrr.value, live.mrr.status, live.payingCustomers.value, live.payingCustomers.status], ['$998.00', 'Measured', '2', 'Measured'])
  const unread = sharedFigures({ mode: 'live', mrrCents: null, payingCustomers: null }, null)
  assert.deepEqual([unread.mrr.value, unread.mrr.status, unread.payingCustomers.status], ['—', 'Unavailable', 'Unavailable'])
  for (const f of [none, test1, live, unread]) for (const x of Object.values(f)) assert.doesNotMatch(`${x.value} ${x.status} ${x.note}`, /[A-Z]{3,}_[A-Z_]{3,}|\(s\)|Stripe/)
})

test('Overview and Growth hand the formatter the same facts, so the three figures cannot disagree', async () => {
  const db = d1()
  const now = Date.now()
  const env = { ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/x`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: 'founder@getshowups.com', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' }
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('pools', 'Pools Co', 'UTC', '', '09:00', '17:00', '1', ?, ?, ?)").run(now - 40 * DAY, now - 40 * DAY, now)
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@pools.example', 'pools', ?)").run(now)
  const token = 'founder'.padEnd(43, 'Q')
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), 'founder@getshowups.com', now, now + DAY)
  const get = async (mod, path) => (await mod.onRequestGet({ request: new Request(`${ORIGIN}${path}`, { headers: { Cookie: `__Host-gsu_session=${token}` } }), env })).json()
  const both = async () => {
    const o = await get(overviewRoute, '/api/platform/overview')
    const g = await get(growthRoute, '/api/platform/growth')
    assert.deepEqual(g.measure.billing ?? null, o.metrics.billing ?? null, 'the same billing facts')
    assert.equal(g.measure.retention30 ?? null, o.metrics.retention30 ?? null, 'the same retention fact')
    const a = sharedFigures(o.metrics.billing, o.metrics.retention30)
    const b = sharedFigures(g.measure.billing, g.measure.retention30)
    assert.deepEqual(b, a)
    return a
  }
  assert.equal((await both()).mrr.status, 'Unavailable', 'no subscription yet')
  // A subscription while live billing is off = test mode on both pages, never a revenue number.
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, cancel_at_period_end, last_event_at, updated_at) VALUES ('pools', 'cus_1', 'sub_1', 'founding', 'active', 49900, 'usd', 1900000000000, 0, 1, 1)").run()
  const t = await both()
  assert.deepEqual([t.mrr.value, t.mrr.status, t.payingCustomers.value, t.payingCustomers.status], ['—', 'Test mode', '—', 'Test mode'])
})
