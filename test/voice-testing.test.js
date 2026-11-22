// Provider tests on the customer path from the Admin Console (server/voice/testing.js): the public receptionist info
// route opens the chat page for a signed-in platform admin's test on an admin-marked test business even while that
// business's receptionist is OFF for customers (voice only, dry run), and for nobody else; the console learns which
// test business to use and whether the current default is verified (records only). Harness as test/voice-promote.test.js.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { adminTestAccess, eligibleTestBusinesses, testPageFor } from '../server/voice/testing.js'
import { globalOverview, switchGlobalProvider } from '../server/voice/global.js'
import * as infoApi from '../functions/api/receptionist/[customer]/index.js'
import * as voiceApi from '../functions/api/receptionist/[customer]/voice.js'
import * as consoleApi from '../functions/api/platform/voice-provider.js'

const ORIGIN = 'https://getshowups.com'
const RETELL = 'http://127.0.0.1:9951'
const EL = 'http://127.0.0.1:9952'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['retell_SECRET_0123456789', 'el_SECRET_0123456789abcdef', 'sk-openai-SECRET-0123456789abcdef', 'sk-ant-test-SECRET']
const DAY = 864e5

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
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
let env, db, kv, fetches, origFetch, responses
beforeEach(() => {
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
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: SECRETS[3],
    RETELL_API_KEY: SECRETS[0],
    RETELL_AGENT_ID: 'agent_abc123def',
    RETELL_WS_SECRET: 'w'.repeat(40),
    RETELL_API_MOCK_ORIGIN: RETELL,
    ELEVENLABS_API_KEY: SECRETS[1],
    ELEVENLABS_AGENT_ID: 'agent_el0123456789',
    ELEVENLABS_API_MOCK_ORIGIN: EL,
    OPENAI_API_KEY: SECRETS[2],
    RECEPTIONIST_VOICE_BUSINESSES: '',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.startsWith(`${EL}/v1/convai/conversation/get-signed-url`)) return json(200, { signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_el0123456789&conversation_signature=sig${fetches.length}` })
    if (u.startsWith(`${EL}/v2/voices`)) return json(200, { voices: [], has_more: false })
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
  for (const r of responses) for (const s of SECRETS) assert.ok(!r.includes(s), 'a secret reached a response')
})

async function seed(id, { on = true, token = true, name = `${id} Co`, zips = '29401,29403' } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, name, zips, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run.', ?, ?, ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), JSON.stringify(['Charleston']), t)
  if (on) db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES (?, 1, 'ai_first', ?, ?)").run(id, `Thanks for calling ${id} Co!`, t)
  if (token) kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
const cust = async (id) => customerFromRow(await getCustomer(db, id))
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
let ipN = 0
async function call(mod, method, path, { cookie, origin = ORIGIN, body, params } = {}) {
  const h = { 'CF-Connecting-IP': `203.0.113.${(ipN++ % 200) + 1}` }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}
const info = (id, q = '', cookie) => call(infoApi, 'GET', `/api/receptionist/${id}${q}`, { params: { customer: id }, cookie })
const markTest = (id) => db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'staff', 1)").run(id)
const ADMIN = 'staff@getshowups.com'
const admin = { email: ADMIN }
// A finished session on `provider` on the customer path with audio both ways and both booking tools.
const evidence = (id, provider, { test = true } = {}) => {
  const t = Date.now() - 60_000
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, '[]', ?, ?)").run(`conv_${id}_${provider}_${t}`, id, JSON.stringify({ voice: { provider, startedAt: t - 90_000, endedAt: t, test, metrics: { micLive: 1, audioReceived: 1 } }, tools: [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true, simulated: test }] }), Date.now(), t)
}

test('the chat page of a test business whose receptionist is OFF opens only for a signed-in platform admin’s ?test=<provider> (voice only, dry run, codes-only refusals for everyone else); customers see the same unavailable page as before and the receptionist stays off for them', async () => {
  await seed('sandbox', { on: false })
  markTest('sandbox')
  await seed('live') // receptionist on, real customers
  const staff = await session(ADMIN)
  const owner = await session('owner@sandbox.example')
  // As before: off for customers, no test key without ?test.
  assert.deepEqual((await info('sandbox')).json(), { enabled: false, name: 'sandbox Co' })
  // ?test without an admin session: still unavailable, the reason as a code (the page explains it).
  assert.deepEqual((await info('sandbox', '?test=elevenlabs')).json(), { enabled: false, name: 'sandbox Co', test: { error: 'test_not_allowed' } }, 'anonymous')
  assert.deepEqual((await info('sandbox', '?test=elevenlabs', owner)).json(), { enabled: false, name: 'sandbox Co', test: { error: 'test_not_allowed' } }, 'owner')
  // The admin on the test business: the page opens, voice only on the candidate provider, nothing for typed chat.
  const t = (await info('sandbox', '?test=elevenlabs', staff)).json()
  assert.deepEqual([t.enabled, t.testOnly, t.test, t.voice, t.voiceStatus, t.callbacks, t.website, t.name], [true, true, { provider: 'elevenlabs', name: 'ElevenLabs' }, false, 'testing', false, null, 'sandbox Co'])
  assert.ok(t.greeting.length > 0)
  // Typed chat stays off for that business: the chat route itself is unchanged (receptionist_off).
  const { onRequestPost: chat } = await import('../functions/api/receptionist/[customer]/chat.js')
  const chatRes = await chat({ request: new Request(`${ORIGIN}/api/receptionist/sandbox/chat`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: staff, 'CF-Connecting-IP': '203.0.113.250' }, body: JSON.stringify({ text: 'hi' }) }), env, params: { customer: 'sandbox' }, waitUntil: () => {} })
  assert.equal(chatRes.status, 404)
  // The voice test session itself starts (dry run) although the receptionist is off: the real provider integration.
  const v = await call(voiceApi, 'POST', '/api/receptionist/sandbox/voice', { params: { customer: 'sandbox' }, body: { test: { provider: 'elevenlabs' } }, cookie: staff })
  assert.equal(v.status, 200, JSON.stringify(v.json()))
  assert.deepEqual([v.json().provider, v.json().test, typeof v.json().signedUrl], ['elevenlabs', true, 'string'])
  // Refusals, each with its code: unknown provider, not configured, switched off, not a test business.
  assert.deepEqual((await info('sandbox', '?test=nope', staff)).json().test, { error: 'invalid_provider' })
  const el = env.ELEVENLABS_API_KEY
  delete env.ELEVENLABS_API_KEY
  assert.deepEqual((await info('sandbox', '?test=elevenlabs', staff)).json(), { enabled: false, name: 'sandbox Co', test: { error: 'voice_not_configured' } })
  env.ELEVENLABS_API_KEY = el
  env.VOICE_PROVIDERS_DISABLED = 'elevenlabs'
  assert.deepEqual((await info('sandbox', '?test=elevenlabs', staff)).json().test, { error: 'voice_unavailable' })
  delete env.VOICE_PROVIDERS_DISABLED
  // A LIVE business: its page is on for customers as usual, but the admin's test is refused by name (never dry-run on real customers' business).
  const live = (await info('live', '?test=elevenlabs', staff)).json()
  assert.deepEqual([live.enabled, live.testOnly, live.test], [true, undefined, { error: 'not_test_business' }])
  assert.deepEqual((await adminTestAccess(env, new Request(`${ORIGIN}/x`, { headers: { Cookie: staff } }), await cust('live'), 'elevenlabs')).error, 'not_test_business')
  // A test business whose receptionist is ON keeps its normal page and just learns the test provider.
  await seed('sandbox2')
  markTest('sandbox2')
  const on = (await info('sandbox2', '?test=retell', staff)).json()
  assert.deepEqual([on.enabled, on.testOnly, on.test], [true, undefined, { provider: 'retell', name: 'Retell' }])
})

test('the console learns the test business and the verification of the current default from records: eligible = admin-marked, active, bookable (hours, calendar, hosted), receptionist-on first; none → a reason, never a guess; the verification flips only on a finished production-path session on the candidate', async () => {
  await seed('alpha') // live, not a test business
  await seed('tb-off', { on: false, name: 'Sandbox Pools' })
  markTest('tb-off')
  await seed('tb-nocal', { token: false, name: 'Calendarless Test' })
  markTest('tb-nocal')
  assert.deepEqual(await eligibleTestBusinesses(env), [{ id: 'tb-off', name: 'Sandbox Pools', receptionist: false, zips: 2, zip: '29401' }])
  await seed('tb-on', { name: 'Live Test Pools' })
  markTest('tb-on')
  assert.deepEqual(
    (await eligibleTestBusinesses(env)).map((b) => b.id),
    ['tb-on', 'tb-off'],
    'receptionist-on first',
  )
  // A test business without a service-area list comes first: nothing can send the receptionist down the coverage path.
  await seed('tb-open', { on: false, name: 'Open Area Pools', zips: '' })
  markTest('tb-open')
  assert.deepEqual((await eligibleTestBusinesses(env)).map((b) => [b.id, b.zips, b.zip]), [['tb-open', 0, null], ['tb-on', 2, '29401'], ['tb-off', 2, '29401']])
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'tb-on'").run()
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'tb-open'").run()
  assert.deepEqual((await eligibleTestBusinesses(env)).map((b) => b.id), ['tb-off'], 'suspended excluded')
  assert.deepEqual(await testPageFor(env, 'elevenlabs'), { url: '/chat/tb-off?test=elevenlabs&from=admin', business: { id: 'tb-off', name: 'Sandbox Pools', receptionist: false, zips: 2, zip: '29401' }, provider: 'elevenlabs' })
  const el = env.ELEVENLABS_API_KEY
  delete env.ELEVENLABS_API_KEY
  assert.deepEqual(await testPageFor(env, 'elevenlabs'), { url: null, reason: 'not_configured' })
  env.ELEVENLABS_API_KEY = el
  db.sql.prepare('DELETE FROM test_businesses').run()
  assert.deepEqual(await testPageFor(env, 'elevenlabs'), { url: null, reason: 'no_test_business' })
  markTest('tb-off')

  // Stage ElevenLabs (production shape): the overview says "needs verification" with the test page, until a session exists.
  const staged = await switchGlobalProvider(env, admin, { provider: 'elevenlabs', mode: 'staged', confirm: true, version: 0 })
  assert.equal(staged.ok, true, staged.error)
  let o = await globalOverview(env)
  assert.deepEqual([o.current.provider, o.current.mode, o.counts.usingDefault, o.counts.pins], ['elevenlabs', 'staged', 0, 5])
  assert.deepEqual(o.verification, { ok: false, sessions: 0, finished: 0, businesses: [], lastAt: null, missing: ['session', 'audio', 'tools', 'booking', 'clean_end'], latest: null })
  assert.deepEqual(o.testPage.url, '/chat/tb-off?test=elevenlabs&from=admin')
  // A Lab-only or incomplete record does not verify; a session on another provider does not either. The newest finished
  // session is explained as a record: what it showed, what it did not, which tool failed and why (event codes).
  evidence('tb-off', 'retell')
  const t = Date.now() - 30_000
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES ('partial', 'tb-off', 'voice', ?, '[]', ?, ?)").run(JSON.stringify({ voice: { provider: 'elevenlabs', startedAt: t - 9000, endedAt: t, test: true, metrics: { micLive: 1, audioReceived: 0 } }, tools: [{ name: 'find_available_times', ok: true }] }), t - 9000, t)
  o = await globalOverview(env)
  assert.deepEqual([o.verification.ok, o.verification.finished, o.verification.missing], [false, 1, ['audio', 'tools', 'booking', 'clean_end']])
  assert.deepEqual(o.verification.latest, { id: 'partial', customer: 'tb-off', startedAt: t - 9000, endedAt: t, durationSeconds: 9, test: true, audio: false, availability: true, booking: false, cleanEnd: true, outcome: null, tools: [{ name: 'find_available_times', ok: true }], failures: [], path: 'audio' })
  // The production shape of 2026-11-22: audio both ways, a clean end, but the service-area path (check_service_area →
  // request_coverage failed zip_missing) and never the booking tools → not verified, path 'area' with the failure code.
  const t2 = Date.now() - 20_000
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES ('areapath', 'tb-off', 'voice', ?, '[]', ?, ?)").run(JSON.stringify({ voice: { provider: 'elevenlabs', startedAt: t2 - 70_000, endedAt: t2, test: true, outcome: 'ended', metrics: { micLive: 1, audioReceived: 1, durationSeconds: 70 } }, tools: [{ name: 'check_service_area', ok: true }, { name: 'save_customer_details', ok: true }, { name: 'request_coverage', ok: false }] }), t2 - 10_000, t2)
  db.sql.prepare("INSERT INTO receptionist_events (id, customer, conversation_id, kind, ok, detail, at) VALUES (901, 'tb-off', 'areapath', 'request_coverage', 0, 'zip_missing', ?)").run(t2 - 1000)
  o = await globalOverview(env)
  assert.deepEqual([o.verification.ok, o.verification.finished, o.verification.missing], [false, 2, ['audio', 'tools', 'booking', 'clean_end']])
  assert.deepEqual([o.verification.latest.id, o.verification.latest.path, o.verification.latest.audio, o.verification.latest.cleanEnd, o.verification.latest.durationSeconds, o.verification.latest.failures], ['areapath', 'area', true, true, 70, [{ tool: 'request_coverage', code: 'zip_missing' }]])
  // The qualifying session: the overview and the GET route agree; the response carries no secret.
  evidence('tb-off', 'elevenlabs')
  o = await globalOverview(env)
  assert.deepEqual([o.verification.ok, o.verification.finished, o.verification.businesses, o.verification.missing, o.verification.latest.path], [true, 3, ['tb-off'], [], 'ok'])
  const staff = await session(ADMIN)
  const g = (await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: staff })).json().global
  assert.deepEqual([g.verification.ok, g.testPage.business.id, g.current.provider], [true, 'tb-off', 'elevenlabs'])
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: await session('owner@alpha.example') })).status, 403)
})
