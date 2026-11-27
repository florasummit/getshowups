// One spending guard for GetShowUps-paid AI (server/ai-budget.js): atomic reservations against platform, public, business
// and entry ceilings; concurrent requests can't pass a ceiling together; refusals charge nothing; settle gives back the
// unused part; emergency switches; fails closed; the receptionist answers with its fallback (no model call) when refused;
// the admin view. Providers are mocked; no real network, no paid calls.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { reserveAi, spendToday, worstCase, aiOff } from '../server/ai-budget.js'
import { sha256Hex } from '../server/google-oauth.js'
import * as spendApi from '../functions/api/platform/ai-spend.js'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    // Every statement yields to the event loop first, so "concurrent" requests really interleave between statements.
    first: async () => (await Promise.resolve(), sql.prepare(q).get(...args) ?? null),
    all: async () => (await Promise.resolve(), { results: sql.prepare(q).all(...args) }),
    run: async () => (await Promise.resolve(), { meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q) }
}
let env, db
const NOW = Date.UTC(2026, 10, 27, 15)
const count = (key) => db.sql.prepare('SELECT count FROM rate_limits WHERE key = ?').get(key)?.count ?? 0
beforeEach(() => {
  db = d1()
  env = { ONBOARDING_DB: db }
})

test('a reservation charges every ceiling once; settle replaces it with the real cost', async () => {
  const r = await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })
  assert.equal(r.ok, true)
  for (const k of ['aib:platform:20261127', 'aib:public:20261127', 'aib:biz:alpha:20261127', 'aib:entry:receptionist:alpha:20261127']) assert.equal(count(k), 100_000, k)
  await r.settle(30_000)
  await r.settle(99_999_999) // once only
  assert.equal(count('aib:platform:20261127'), 30_000)
  assert.equal(count('aib:entry:receptionist:alpha:20261127'), 30_000)
  // Owner entry points are not part of the public ceiling.
  await reserveAi(env, { entry: 'teach', customerId: 'alpha', micros: 5_000, now: NOW })
  assert.equal(count('aib:public:20261127'), 30_000)
  assert.equal(count('aib:biz:alpha:20261127'), 35_000)
})

test('concurrent requests can never pass a ceiling together, and refused ones charge nothing', async () => {
  env.AI_BUSINESS_DAILY_MICROS = '1000000' // $1 per business
  const all = await Promise.all(Array.from({ length: 40 }, () => reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })))
  assert.equal(all.filter((r) => r.ok).length, 10)
  assert.ok(all.filter((r) => !r.ok).every((r) => r.reason === 'business'))
  assert.equal(count('aib:biz:alpha:20261127'), 1_000_000)
  assert.equal(count('aib:platform:20261127'), 1_000_000) // nothing charged by the 30 refusals
})

test('one abusive tenant cannot use up another tenant’s allowance; the public ceiling protects owner tools', async () => {
  Object.assign(env, { AI_BUSINESS_DAILY_MICROS: '500000', AI_PUBLIC_DAILY_MICROS: '800000', AI_PLATFORM_DAILY_MICROS: '1000000' })
  // A flood against alpha's public receptionist stops at alpha's ceiling.
  await Promise.all(Array.from({ length: 30 }, () => reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })))
  assert.equal(count('aib:biz:alpha:20261127'), 500_000)
  // Beta's customers still get answers until the public ceiling.
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'beta', micros: 300_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'gamma', micros: 100_000, now: NOW })).reason, 'public')
  // Owners' own tools still have the platform headroom the public share leaves.
  assert.equal((await reserveAi(env, { entry: 'assistant', customerId: 'gamma', micros: 100_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'assistant', customerId: 'gamma', micros: 200_000, now: NOW })).reason, 'platform')
})

test('per-entry ceilings, a new UTC day, and the receptionist’s own daily setting', async () => {
  env.RECEPTIONIST_DAILY_MICROS = '150000'
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })).reason, 'entry')
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'alpha', micros: 100_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW + 86_400_000 })).ok, true)
})

test('emergency switches refuse before anything is charged; unknown entries and bad ids are refused', async () => {
  env.AI_OFF_BUSINESSES = 'alpha, beta'
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 1, now: NOW })).reason, 'ai_off')
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'gamma', micros: 1, now: NOW })).ok, true)
  env.AI_ALL_OFF = 'true'
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'gamma', micros: 1, now: NOW })).reason, 'ai_off')
  assert.equal(aiOff(env, 'anyone'), true)
  delete env.AI_ALL_OFF
  assert.equal((await reserveAi(env, { entry: 'websites', customerId: 'gamma', micros: 1, now: NOW })).reason, 'unavailable')
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: '../x', micros: 1, now: NOW })).reason, 'unavailable')
  assert.equal(count('aib:biz:alpha:20261127'), 0)
})

test('fails closed: when the counters cannot be written, nothing is spent', async () => {
  const errors = []
  const orig = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    env.ONBOARDING_DB = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1_ERROR') }, all: async () => { throw new Error('D1_ERROR') }, first: async () => { throw new Error('D1_ERROR') } }) }) }
    assert.deepEqual(await reserveAi(env, { entry: 'receptionist', customerId: 'fresh-biz', micros: 1, now: NOW }), { ok: false, reason: 'unavailable' })
  } finally {
    console.error = orig
  }
  assert.ok(errors.every((e) => !e.includes('fresh-biz')))
})

test('a counter row that disappeared (purged) is recreated, never a partial charge', async () => {
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 10, now: NOW })).ok, true)
  db.sql.prepare("DELETE FROM rate_limits WHERE key = 'aib:entry:receptionist:alpha:20261127'").run()
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 10, now: NOW })).ok, true)
  assert.equal(count('aib:platform:20261127'), 20)
  assert.equal(count('aib:entry:receptionist:alpha:20261127'), 10)
})

test('worst case: input estimate plus every output token allowed', () => {
  assert.equal(worstCase({ chars: 35_000, maxOutput: 4096, inPerToken: 5, outPerToken: 20 }), 50_000 + 81_920)
})

test('admin view: platform admins only; today’s totals, top businesses and entry points; switch states', async () => {
  await reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 120_000, now: Date.now() })
  await reserveAi(env, { entry: 'teach', customerId: 'beta', micros: 30_000, now: Date.now() })
  const s = await spendToday({ ...env, AI_OFF_BUSINESSES: 'beta' })
  assert.deepEqual([s.platform, s.public, s.businesses[0], s.entries.teach, s.off.businesses], [150_000, 120_000, { customer: 'alpha', micros: 120_000 }, 30_000, ['beta']])
  // Route: a signed-in non-admin is refused, never shown the numbers.
  Object.assign(env, { PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), GOOGLE_TOKENS: { get: async () => null } })
  const session = async (email) => {
    const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
    db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
    return `__Host-gsu_session=${token}`
  }
  const get = async (cookie) => spendApi.onRequestGet({ request: new Request('https://getshowups.com/api/platform/ai-spend', { headers: { Cookie: cookie } }), env })
  const owner = await get(await session('owner@alpha.example'))
  assert.notEqual(owner.status, 200)
  assert.equal((await owner.json()).platform, undefined)
  const admin = await get(await session('staff@getshowups.com'))
  assert.equal(admin.status, 200)
  assert.equal((await admin.json()).platform, 150_000)
})
