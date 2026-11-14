// Scalability regressions (synthetic data, deterministic): cron jobs rotate fairly under persistent failures, admin
// views stay within Workers' per-request KV budget, and one-business views don't grow with the number of businesses.
// The full measurement run is scripts/scale-bench.mjs (10 / 100 / 1,000 businesses).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const DAY = 86400000
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const counter = { n: 0 }
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => (counter.n++, sql.prepare(q).get(...args) ?? null),
    all: async () => (counter.n++, { results: sql.prepare(q).all(...args) }),
    run: async () => (counter.n++, { meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, counter, prepare: (q) => stmt(q) }
}
// KV fake with Cloudflare's real paging: at most 1,000 keys per list call, cursor for the rest.
function kv() {
  const m = new Map()
  const ops = { n: 0 }
  return {
    m,
    ops,
    get: async (k) => (ops.n++, m.get(k) ?? null),
    put: async (k, v) => void (ops.n++, m.set(k, v)),
    delete: async (k) => void (ops.n++, m.delete(k)),
    list: async ({ prefix = '', cursor } = {}) => {
      ops.n++
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const keys = all.slice(start, start + 1000).map((name) => ({ name }))
      return start + 1000 < all.length ? { keys, list_complete: false, cursor: String(start + 1000) } : { keys, list_complete: true }
    },
  }
}
let env, db, store, origError
function seed(n, { canceledExpired = 0, heldWithRunning = 0 } = {}) {
  const now = Date.now()
  const c = db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, status, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?, ?, ?)")
  db.sql.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const id = `b${String(i).padStart(5, '0')}`
    const held = i < heldWithRunning
    c.run(id, id, now, held ? 'suspended' : 'active', now - 300 * DAY, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`o${i}@x.example`, id, now)
    if (held) db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', 'active', '{}', 2500, '1', ?, ?)").run(`cmp_${id}`, id, now, now)
    if (i >= heldWithRunning && i < heldWithRunning + canceledExpired) {
      db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at) VALUES (?, 'founding', ?)").run(id, now)
      db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, current_period_end, last_event_at, updated_at) VALUES (?, ?, ?, 'canceled', ?, 0, ?)").run(id, `cus_${i}`, `sub_${i}`, now - (100 + i) * DAY, now)
    }
    store.m.set(`google:${id}`, '{}')
  }
  db.sql.exec('COMMIT')
  return now
}
beforeEach(() => {
  db = d1()
  store = kv()
  env = { ONBOARDING_DB: db, GOOGLE_TOKENS: store, ADS_ENABLED: 'true', GOOGLE_CLIENT_ID: 'cid', TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }
  origError = console.error
  console.error = () => {}
})
afterEach(() => {
  console.error = origError
})

test('ads hold sweep rotates fairly: campaigns that keep failing never starve other held businesses', async () => {
  const { enforceAdsHolds } = await import('../server/ads/holds.js')
  const now = seed(40, { heldWithRunning: 30 }) // 30 held, each with an unreachable running campaign
  const tried = new Set()
  for (let run = 0; run < 2; run++) {
    await enforceAdsHolds(env, { now: now + run * 300000, limit: 25 })
    for (const r of db.sql.prepare("SELECT DISTINCT customer FROM ad_actions WHERE kind = 'pause'").all()) tried.add(r.customer)
  }
  assert.equal(tried.size, 30, 'every held business attempted within two runs (was: the same 25 forever)')
})

test('recovery expiry: more than one batch of expired accounts are all recorded over successive runs (no starvation)', async () => {
  const { processRecoveryExpiries } = await import('../server/lifecycle.js')
  const now = seed(70, { canceledExpired: 60 })
  const a = await processRecoveryExpiries(env, { now })
  const b = await processRecoveryExpiries(env, { now: now + 300000 })
  const c = await processRecoveryExpiries(env, { now: now + 600000 })
  const d = await processRecoveryExpiries(env, { now: now + 900000 })
  assert.deepEqual([a.expired, b.expired, c.expired, d.expired], [25, 25, 10, 0])
})

test('admin list: Calendar connections read with KV list pages, not one read per business (Workers ~1,000 KV ops/request)', async () => {
  const { customerRows } = await import('../server/metrics.js')
  seed(2500)
  store.ops.n = 0
  const rows = await customerRows(env)
  assert.equal(rows.length, 2500)
  assert.ok(rows.every((r) => r.calendarConnected))
  assert.equal(store.ops.n, 3, '2,500 keys = 3 list pages')
})

test('one-business views cost the same at 10 and 300 businesses (bounded queries)', async () => {
  const { businessReview } = await import('../server/ops/review.js')
  seed(10)
  db.counter.n = 0
  store.ops.n = 0
  await businessReview(env, 'b00003')
  const small = { d1: db.counter.n, kv: store.ops.n }
  db = d1()
  store = kv()
  env = { ...env, ONBOARDING_DB: db, GOOGLE_TOKENS: store }
  seed(300)
  db.counter.n = 0
  store.ops.n = 0
  const r = await businessReview(env, 'b00003')
  assert.equal(r.id, 'b00003')
  assert.deepEqual({ d1: db.counter.n, kv: store.ops.n }, small)
})
