// One spending guard for GetShowUps-paid AI (server/ai-budget.js): atomic reservations against platform, public, business
// and entry ceilings; concurrent requests can't pass a ceiling together; refusals charge nothing; settle gives back the
// unused part; emergency switches; fails closed; the receptionist answers with its fallback (no model call) when refused;
// the admin view. Providers are mocked; no real network, no paid calls.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { reserveAi, spendToday, worstCase, aiOff, resetSettingsCache, retellRoom, voiceRoom, setBudgetSetting, DEFAULTS, paidCall, voiceReconciliation } from '../server/ai-budget.js'
import { setRestriction } from '../server/restrictions.js'
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
  resetSettingsCache()
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
  assert.equal(await aiOff(env, 'anyone'), true)
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
    // Refused either way: an unreadable restriction counts as off, unreadable counters as unavailable.
    const r = await reserveAi(env, { entry: 'receptionist', customerId: 'fresh-biz', micros: 1, now: NOW })
    assert.equal(r.ok, false)
    assert.ok(['ai_off', 'unavailable'].includes(r.reason))
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
  const cookie = await session('staff@getshowups.com')
  const admin = await get(cookie)
  assert.equal(admin.status, 200)
  assert.equal((await admin.json()).platform, 150_000)
  // An admin change: reason + confirm required, audited from → to, applied at once, within the allowed range only.
  const post = (body, origin = 'https://getshowups.com') => spendApi.onRequestPost({ request: new Request('https://getshowups.com/api/platform/ai-spend', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env })
  assert.equal((await post({ action: 'set', key: 'business_micros', value: 500_000, reason: 'pilot week' })).status, 400) // no confirm
  assert.equal((await post({ action: 'set', key: 'business_micros', value: 500_000, confirm: true })).status, 400) // no reason
  assert.equal((await post({ action: 'set', key: 'business_micros', value: 500_000_000, reason: 'typo', confirm: true })).status, 400) // over $100
  assert.equal((await post({ action: 'set', key: 'business_micros', value: 500_000, reason: 'pilot week', confirm: true }, 'https://evil.example')).status, 403)
  const ok = await post({ action: 'set', key: 'business_micros', value: 500_000, reason: 'pilot week', confirm: true })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).ceilings.business, 500_000)
  const row = db.sql.prepare("SELECT actor, details FROM admin_audit WHERE action = 'ai_budget.set'").get()
  assert.deepEqual([row.actor, JSON.parse(row.details)], ['staff@getshowups.com', { key: 'business_micros', from: 1_000_000, to: 500_000, reason: 'pilot week' }])
})

test('conservative defaults: $5 platform, $3 public, $1 per business, 60 Retell minutes; stricter entry limits still apply', async () => {
  assert.deepEqual(DEFAULTS, { platform_micros: 5_000_000, public_micros: 3_000_000, business_micros: 1_000_000, retell_minutes: 60, openai_minutes: 30, elevenlabs_minutes: 30, all_off: 0 })
  // $1 per business stops a business long before the receptionist's own $5.
  const r = await Promise.all(Array.from({ length: 12 }, () => reserveAi(env, { entry: 'receptionist', customerId: 'alpha', micros: 100_000, now: NOW })))
  assert.equal(r.filter((x) => x.ok).length, 10)
  // A stricter entry limit stays the effective one.
  env.RECEPTIONIST_DAILY_MICROS = '150000'
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'beta', micros: 100_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'beta', micros: 100_000, now: NOW })).reason, 'entry')
  // Public $3 across tenants.
  delete env.RECEPTIONIST_DAILY_MICROS
  for (const b of ['c1', 'c2', 'c3']) await Promise.all(Array.from({ length: 10 }, () => reserveAi(env, { entry: 'receptionist', customerId: b, micros: 100_000, now: NOW })))
  assert.equal(count('aib:public:20261127'), 3_000_000)
  assert.equal((await reserveAi(env, { entry: 'receptionist', customerId: 'c4', micros: 1, now: NOW })).reason, 'public')
})

test('admin settings: applied without a deploy; a variable can only lower them; all_off and the per-business restriction stop everything', async () => {
  assert.equal((await setBudgetSetting(env, 'platform_micros', 200_000, 'staff@getshowups.com')).ok, true)
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'alpha', micros: 150_000, now: NOW })).ok, true)
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'beta', micros: 100_000, now: NOW })).reason, 'platform')
  // A variable never raises what the admin set.
  env.AI_PLATFORM_DAILY_MICROS = '90000000'
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'beta', micros: 100_000, now: NOW })).reason, 'platform')
  delete env.AI_PLATFORM_DAILY_MICROS
  assert.equal((await setBudgetSetting(env, 'all_off', 1, 'staff@getshowups.com')).ok, true)
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'gamma', micros: 1, now: NOW })).reason, 'ai_off')
  assert.equal((await setBudgetSetting(env, 'all_off', 2, 'x')).error, 'invalid_value')
  await setBudgetSetting(env, 'all_off', 0, 'staff@getshowups.com')
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('gamma', 'G', 'UTC', 1, 1)").run()
  await setRestriction(db, 'gamma', 'ai', true, 'abuse', 'staff@getshowups.com')
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'gamma', micros: 1, now: NOW })).reason, 'ai_off')
  assert.equal((await reserveAi(env, { entry: 'teach', customerId: 'delta', micros: 1, now: NOW })).ok, true)
})

test('Retell minutes: open calls count their full 15 minutes; a start is allowed only if it still fits; unreadable refuses', async () => {
  const day = NOW - (NOW % 86_400_000)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('alpha', 'A', 'UTC', 1, 1)").run()
  const call = (id, start, end) => db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES (?, 'alpha', 'c', 'retell', ?, ?)").run(id, start, end)
  call('done1', day + 1000, day + 1000 + 20 * 60_000) // 20 min, counted at most 15
  call('done2', day + 2000, day + 2000 + 10 * 60_000) // 10 min
  assert.deepEqual(await retellRoom(env, NOW), { ok: true, used: 25, cap: 60 })
  call('open1', NOW - 60_000, null) // running: counts 15
  assert.deepEqual(await retellRoom(env, NOW), { ok: true, used: 40, cap: 60 })
  call('open2', NOW - 30_000, null)
  assert.deepEqual(await retellRoom(env, NOW), { ok: false, used: 55, cap: 60 })
  await setBudgetSetting(env, 'retell_minutes', 120, 'staff@getshowups.com')
  assert.equal((await retellRoom(env, NOW)).ok, true)
  // OpenAI and ElevenLabs have their own conservative allowance (30 min each), counted the same strict way.
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES ('web_1', 'alpha', 'c', 'openai', ?)").run(NOW - 1000)
  assert.deepEqual(await voiceRoom(env, 'openai', NOW), { ok: true, used: 15, cap: 30 })
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES ('web_2', 'alpha', 'c', 'openai', ?)").run(NOW - 500)
  assert.equal((await voiceRoom(env, 'openai', NOW)).ok, false)
  assert.deepEqual(await voiceRoom(env, 'elevenlabs', NOW), { ok: true, used: 0, cap: 30 })
  assert.equal((await voiceRoom(env, 'unknown', NOW)).ok, false)
  await setBudgetSetting(env, 'openai_minutes', 45, 'staff@getshowups.com')
  assert.equal((await voiceRoom(env, 'openai', NOW)).ok, true)
  const broken = { ONBOARDING_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1') }, all: async () => { throw new Error('D1') } }), all: async () => { throw new Error('D1') } }) } }
  resetSettingsCache()
  const errs = console.error
  console.error = () => {}
  try {
    assert.equal((await retellRoom(broken, NOW)).ok, false)
  } finally {
    console.error = errs
  }
})

test('paidCall: success settles to the reported cost; a lost connection keeps its worst case and retries once; a refusal costs nothing; never more than two attempts', async () => {
  const biz = () => count('aib:biz:alpha:20261127')
  const opts = { entry: 'teach', customerId: 'alpha', micros: 100_000, now: NOW }
  let calls = 0
  const ok = await paidCall(env, opts, async () => (calls++, { value: 'v', costMicros: 3_000 }))
  assert.deepEqual([ok.ok, ok.value, ok.attempts, calls, biz()], [true, 'v', 1, 1, 3_000])
  // Lost connection (no status) then success: the first attempt keeps 100_000, the second settles to 3_000.
  calls = 0
  const r = await paidCall(env, opts, async (i) => {
    calls++
    if (i === 0) throw new TypeError('fetch failed')
    return { value: 'ok', costMicros: 3_000 }
  })
  assert.deepEqual([r.ok, r.attempts, calls, biz()], [true, 2, 2, 3_000 + 100_000 + 3_000])
  // 429 twice: both settled to 0, two attempts only.
  calls = 0
  const busy = await paidCall(env, opts, async () => {
    calls++
    throw Object.assign(new Error('busy'), { status: 429 })
  })
  assert.deepEqual([busy.ok, busy.reason, calls, biz()], [false, 'provider', 2, 106_000])
  // 400 is never retried.
  calls = 0
  await paidCall(env, opts, async () => {
    calls++
    throw Object.assign(new Error('bad'), { status: 400 })
  })
  assert.equal(calls, 1)
  // Budget exhausted between attempts: the retry is refused, no second call.
  env.AI_BUSINESS_DAILY_MICROS = String(106_000 + 150_000)
  calls = 0
  const cut = await paidCall(env, opts, async () => {
    calls++
    throw new TypeError('fetch failed')
  })
  assert.deepEqual([cut.ok, cut.reason, calls], [false, 'budget_business', 1])
})

test('paidCall under concurrency: simultaneous callers can never spend past a ceiling, failures included', async () => {
  env.AI_BUSINESS_DAILY_MICROS = '1000000'
  let provider = 0
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, k) =>
      paidCall(env, { entry: 'teach', customerId: 'alpha', micros: 100_000, now: NOW }, async () => {
        provider++
        if (k % 3 === 0) throw new TypeError('fetch failed') // lost: keeps 100_000
        return { value: k, costMicros: 100_000 }
      }),
    ),
  )
  assert.ok(count('aib:biz:alpha:20261127') <= 1_000_000)
  assert.ok(provider <= 10, `at most 10 attempts fit in $1 at $0.10 each, got ${provider}`)
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'budget_business' || r.reason === 'provider'))
})

test('provider reconciliation: verified charges next to the estimate; a provider billing >25% over the estimate is flagged', async () => {
  const day = Date.now() - (Date.now() % 86_400_000)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('alpha', 'A', 'UTC', 1, 1)").run()
  const conv = (id, provider, micros, secs) => db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, created_at, updated_at) VALUES (?, 'alpha', 'voice', ?, ?, ?)").run(id, JSON.stringify({ voice: { provider, endedAt: 1, ...(micros == null ? {} : { charge: { micros, durationSeconds: secs } }) } }), day + 1000, day + 1000)
  conv('r1', 'retell', 70_000, 60)
  conv('r2', 'retell', null, null)
  conv('e1', 'elevenlabs', 200_000, 60)
  const r = await voiceReconciliation(env)
  assert.deepEqual(r.retell, { sessions: 2, priced: 1, verifiedMicros: 70_000, estimatedMicros: 70_000, drift: false })
  assert.equal(r.elevenlabs.drift, true)
  const s = await spendToday(env)
  assert.ok(s.warnings.some((w) => w.scope === 'drift' && w.provider === 'elevenlabs'))
})
