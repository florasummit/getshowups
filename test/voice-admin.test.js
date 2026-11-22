// Admin Console entry point for voice-provider management (/api/platform/voice-provider, server/voice/admin.js):
// platform admins manage ANY business's provider without being a member; owners and non-admins are refused; the view
// shows the business, its configuration, readiness, blockers and a codes-only session history (never transcripts or
// contact details); check / switch / rollback are the SAME functions the dashboard control uses (readiness, blockers,
// confirmation, version, one write, audit, rollback) plus the business id typed back; deleted businesses are not
// offered; tenant authorization of the dashboard is unchanged. Harness shared with test/voice-settings.test.js.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { getVoiceSettings } from '../server/voice/settings.js'
import { voiceSessionHistory } from '../server/voice/customer.js'
import { adminVoiceView, listVoiceBusinesses, loadVoiceBusiness } from '../server/voice/admin.js'
import * as consoleApi from '../functions/api/platform/voice-provider.js'
import * as ownerApi from '../functions/api/dashboard/receptionist/index.js'

const ORIGIN = 'https://getshowups.com'
const RETELL = 'http://127.0.0.1:9941'
const EL = 'http://127.0.0.1:9942'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['retell_SECRET_0123456789', 'el_SECRET_0123456789abcdef', 'sk-openai-SECRET-0123456789abcdef']
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
let env, db, kv, fetches, origFetch, retellVoices, elVoices, retellStatus, responses
const RETELL_VOICES = [
  { voice_id: 'retell-Cimo', voice_name: 'Cimo', provider: 'elevenlabs', gender: 'male', accent: 'American', age: 'Middle Aged', preview_audio_url: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cimo.mp3' },
  { voice_id: '11labs-Adrian', voice_name: 'Adrian', provider: 'elevenlabs', gender: 'male', accent: 'American', age: 'Young', preview_audio_url: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/adrian.mp3' },
  { voice_id: '11labs-Myra', voice_name: 'Myra', provider: 'elevenlabs', gender: 'female', accent: 'American', age: 'Young', preview_audio_url: 'http://insecure.example/myra.mp3' },
  { voice_id: 'bad id!', voice_name: 'Broken', provider: 'x', gender: 'female' },
]
const EL_VOICES = [
  { voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', category: 'premade', labels: { gender: 'male', accent: 'American', age: 'middle-aged', description: 'friendly' }, preview_url: 'https://storage.googleapis.com/eleven-public-prod/eric.mp3', verified_languages: [{ language: 'en', model_id: 'm', accent: 'american' }] },
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade', labels: { gender: 'female', accent: 'American', age: 'young' }, preview_url: 'https://storage.googleapis.com/eleven-public-prod/sarah.mp3' },
]

beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  retellVoices = RETELL_VOICES
  elVoices = EL_VOICES
  retellStatus = 200
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test-SECRET',
    RETELL_API_KEY: SECRETS[0],
    RETELL_AGENT_ID: 'agent_abc123def',
    RETELL_WS_SECRET: 'w'.repeat(40),
    RETELL_API_MOCK_ORIGIN: RETELL,
    ELEVENLABS_API_KEY: SECRETS[1],
    ELEVENLABS_AGENT_ID: 'agent_el0123456789',
    ELEVENLABS_API_MOCK_ORIGIN: EL,
    OPENAI_API_KEY: SECRETS[2],
    VOICE_LAB_ENABLED: 'true',
    RECEPTIONIST_VOICE_BUSINESSES: 'alpha,beta',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === `${RETELL}/list-voices`) return retellStatus === 200 ? json(200, retellVoices) : json(retellStatus, { error: 'x' })
    if (u.startsWith(`${EL}/v2/voices`)) return json(200, { voices: elVoices, has_more: false })
    if (u === `${RETELL}/v3/create-web-call`) return json(201, { call_id: `call_${fetches.length}abcdef`, access_token: 'web_access_token', transport: 'gateway', ice_servers: [] })
    if (u.startsWith(`${EL}/v1/convai/conversation/get-signed-url`)) return json(200, { signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_el0123456789&conversation_signature=sig' })
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
  for (const r of responses) for (const s of SECRETS) assert.ok(!r.includes(s), 'a secret reached a response')
})

async function seed(id, { hours = true, token = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, hours ? t : null, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run.', ?, ?, ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), JSON.stringify(['Charleston']), t)
  db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES (?, 1, 'ai_first', 'Hi from alpha!', ?)").run(id, t)
  if (token) kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
async function session(email, customer) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  if (customer) db.sql.prepare('INSERT OR IGNORE INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(email, customer, Date.now())
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, origin = ORIGIN, body } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, waitUntil: () => {} })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}
// Evidence of a verified session: a finished Lab/customer-path session on the provider with audio both ways and the
// availability + booking tools (what server/voice/customer.js providerEvidence reads).
const labCall = (id, provider, endedAgoMs = 60_000) => {
  const t = Date.now() - endedAgoMs
  const cid = `conv_${id}_${provider}_${Math.random().toString(36).slice(2, 8)}`
  const p = provider === 'retell-lab' ? 'retell' : provider
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, '[]', ?, ?)").run(cid, id, JSON.stringify({ lab: { provider: p, startedAt: t - 60000, endedAt: t, metrics: { micLive: 1, audioReceived: 1 } }, tools: [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true, simulated: true }] }), t - 60000, t)
  db.sql.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(`lab_${cid}`, id, cid, provider, t - 60000, t)
}

const ADMIN = 'staff@getshowups.com'
// A finished admin test session on the customer path (how PR #117 records it), with customer details and a transcript
// that must NEVER reach the console; `complete` = audio both ways + both booking tools (counts as evidence).
const testSession = (id, provider, { complete = true, endedAgoMs = 60_000, ended = true } = {}) => {
  const t = Date.now() - endedAgoMs
  const cid = `conv_${id}_${provider}_${Math.random().toString(36).slice(2, 8)}`
  const state = { voice: { provider, startedAt: t - 90_000, ...(ended ? { endedAt: t } : {}), test: true, by: 'ref:abc', metrics: complete ? { micLive: 1, audioReceived: 1, durationSeconds: 90 } : { micLive: 1, audioReceived: 0 }, estimatedMicros: 51_000, outcome: 'booked' }, customer: { name: 'Pat Caller', phone: '+18435550123', email: 'pat@caller.example' }, tools: complete ? [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true, simulated: true }] : [{ name: 'find_available_times', ok: true }], booked: complete ? { simulated: true, start: t } : undefined }
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, ?, ?, ?)").run(cid, id, JSON.stringify(state), JSON.stringify([{ who: 'customer', text: 'My name is Pat Caller and my number is 843 555 0123' }]), t - 90_000, t)
  db.sql.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(`web_${cid}`, id, cid, provider, t - 90_000, ended ? t : null)
  return cid
}
const LEAK = /Pat Caller|8435550123|pat@caller|My name is|SECRET/

test('authorization: the console route is platform-admin only (401 without a session, 403 for an owner and for a non-admin member), membership is not needed, writes are same-origin and audited under the admin; the dashboard route keeps refusing non-members', async () => {
  await seed('alpha')
  await seed('beta')
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider')).status, 401)
  const owner = await session('owner@alpha.example')
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider')).status, 401)
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: owner })).status, 403)
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=alpha', { cookie: owner })).status, 403)
  assert.equal((await call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie: owner, body: { action: 'check', customer: 'alpha', provider: 'retell' } })).status, 403)
  // The platform admin is a member of NOTHING and still manages alpha and beta.
  const staff = await session(ADMIN)
  const g = await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: staff })
  assert.equal(g.status, 200)
  assert.deepEqual(g.json().businesses.map((b) => [b.id, b.name, b.test, b.receptionist, b.provider, b.providerName]), [['alpha', 'alpha Co', false, true, 'retell', 'Retell'], ['beta', 'beta Co', false, true, 'retell', 'Retell']])
  assert.ok(!JSON.stringify(g.json()).includes('@'), 'no emails in the list')
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=beta', { cookie: staff })).status, 200)
  assert.equal((await call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie: staff, origin: 'https://evil.example', body: { action: 'check', customer: 'alpha', provider: 'retell' } })).status, 403, 'same-origin')
  assert.equal((await call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie: staff, body: { action: 'nope', customer: 'alpha' } })).json().error, 'invalid_action')
  // The dashboard route is unchanged: the admin without a business has no session business there.
  assert.notEqual((await call(ownerApi, 'GET', '/api/dashboard/receptionist', { cookie: staff })).status, 200)
})

test('view: a bad or unknown id is refused before any lookup; a deleted business is neither listed nor managed; the view carries the business facts, the stored configuration, the provider overview (same states/evidence/blockers as the dashboard) and a codes-only history; transcripts and customer details never appear', async () => {
  await seed('alpha')
  await seed('gone')
  db.sql.prepare("INSERT INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at, completed_at) VALUES ('gone', 1, 'admin', 'completed', 'done', 1, 1)").run()
  const staff = await session(ADMIN)
  assert.deepEqual([(await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=Bad%20Id', { cookie: staff })).status, (await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=nope', { cookie: staff })).status, (await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=gone', { cookie: staff })).status], [400, 404, 404])
  assert.deepEqual((await listVoiceBusinesses(env)).map((b) => b.id), ['alpha'])
  assert.equal((await loadVoiceBusiness(env, 'gone')).error, 'not_found')
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('alpha', 1, 'ref:x', 1)").run()
  db.sql.prepare("INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, version, updated_by, updated_at) VALUES ('alpha', 'openai', 'cedar', 'Cedar', 'warm', 'normal', 'en', 1, 'ref:x', 1)").run()
  testSession('alpha', 'retell') // complete → evidence
  testSession('alpha', 'elevenlabs', { complete: false }) // audio one way only
  labCall('alpha', 'openai')
  testSession('alpha', 'retell', { ended: false, endedAgoMs: 0 }) // in progress
  const g = await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=alpha', { cookie: staff })
  assert.equal(g.status, 200)
  const v = g.json()
  assert.deepEqual(v.business, { id: 'alpha', name: 'alpha Co', status: 'active', test: true, testUnreadable: false, receptionist: true, hoursConfirmed: true })
  assert.deepEqual([v.ready, v.voice.provider, v.voice.providerName, v.voice.voiceName, v.voice.personality, v.voice.pace, v.voice.version], [true, 'openai', 'OpenAI Realtime', 'Cedar', 'Warm & Friendly', 'Normal', 1])
  assert.deepEqual(v.providers.providers.map((p) => [p.id, p.state, p.evidence.ok, p.testUrl, p.blockers]), [
    ['retell', 'ready', true, '/chat/alpha?test=retell', []],
    ['openai', 'active', true, '/chat/alpha?test=openai', []],
    ['elevenlabs', 'needs_test', false, '/chat/alpha?test=elevenlabs', ['needs_test']],
  ])
  assert.deepEqual([v.providers.version, v.providers.previous, v.providers.testBusiness], [1, null, true])
  assert.equal(v.history.length, 4)
  const byKind = Object.fromEntries(v.history.map((h) => [`${h.provider}:${h.kind}:${h.endedAt ? 'ended' : 'open'}`, h]))
  const done = byKind['retell:test:ended']
  assert.deepEqual([done.kind, done.dryRun, done.audio, done.tools, done.outcome, done.booked, done.simulated, done.estimatedMicros, done.evidence], ['test', true, { micLive: true, audioReceived: true }, { availability: true, booking: true, count: 2 }, 'booked', true, true, 51_000, true])
  const partial = byKind['elevenlabs:test:ended']
  assert.deepEqual([partial.audio.audioReceived, partial.tools.booking, partial.evidence], [false, false, false])
  assert.deepEqual([byKind['openai:lab:ended'].kind, byKind['openai:lab:ended'].evidence], ['lab', true])
  assert.deepEqual([byKind['retell:test:open'].inProgress, byKind['retell:test:open'].evidence], [true, false])
  assert.ok(!LEAK.test(JSON.stringify(v)), 'no transcript, name, phone or email in the console view')
  assert.ok(!LEAK.test(JSON.stringify(await voiceSessionHistory(env, 'alpha'))))
  assert.ok(!LEAK.test(JSON.stringify(await adminVoiceView(env, (await loadVoiceBusiness(env, 'alpha')).customer))))
  // The catalog of any provider, for the replacement-voice picker.
  const cat = await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=alpha&catalog=elevenlabs', { cookie: staff })
  assert.deepEqual([cat.json().provider, cat.json().voices.map((x) => x.name)], ['elevenlabs', ['Eric', 'Sarah']])
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=alpha&catalog=nope', { cookie: staff })).json().error, 'invalid_provider')
  // Before migration 0035 the view still answers (defaults, not ready) instead of breaking.
  db.sql.exec('DROP TABLE receptionist_voice_settings')
  const g2 = await call(consoleApi, 'GET', '/api/platform/voice-provider?customer=alpha', { cookie: staff })
  assert.deepEqual([g2.status, g2.json().ready, g2.json().voice.provider], [200, false, 'retell'])
})

test('check / switch / rollback: the same readiness requirements as the dashboard (blocked without evidence, audited), the business id must be typed back before anything changes, a passing switch is atomic + audited under the admin and leaves other businesses alone, rollback restores the previous configuration', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await session(ADMIN)
  const post = (body) => call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie: staff, body })
  // Check: nothing changes, blockers named (no finished session on ElevenLabs yet).
  const chk = await post({ action: 'check', customer: 'alpha', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal' })
  assert.equal(chk.status, 200)
  assert.deepEqual(chk.json().check.blockers, ['test_session_required'])
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 0)
  // Switch without / with a wrong typed id: refused before the checklist, nothing audited, nothing changed.
  for (const confirmCustomer of [undefined, 'beta', 'alph']) {
    const r = await post({ action: 'switch', customer: 'alpha', confirmCustomer, provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 0 })
    assert.deepEqual([r.status, r.json().error], [400, 'confirm_customer_mismatch'])
  }
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 0)
  // Typed correctly but unverified: blocked by the checklist (409), audited as blocked, still Retell.
  const blocked = await post({ action: 'switch', customer: 'alpha', confirmCustomer: 'ALPHA', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 0 })
  assert.deepEqual([blocked.status, blocked.json().error, blocked.json().check.blockers], [409, 'blocked', ['test_session_required']])
  assert.equal((await getVoiceSettings(db, 'alpha')).provider, 'retell')
  // With evidence (a finished admin test session with audio both ways + both tools): confirmation and version still required.
  testSession('alpha', 'elevenlabs')
  assert.equal((await post({ action: 'switch', customer: 'alpha', confirmCustomer: 'alpha', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', version: 0 })).json().error, 'confirmation_required')
  assert.equal((await post({ action: 'switch', customer: 'alpha', confirmCustomer: 'alpha', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 7 })).json().error, 'stale')
  const sw = await post({ action: 'switch', customer: 'alpha', confirmCustomer: 'alpha', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 0 })
  assert.equal(sw.status, 200, sw.json().error)
  const after = sw.json()
  assert.deepEqual([after.providers.current, after.voice.voiceName, after.providers.version, after.providers.previous.provider, after.check.ok, after.business.id], ['elevenlabs', 'Eric', 1, 'retell', true, 'alpha'])
  assert.deepEqual([(await getVoiceSettings(db, 'alpha')).provider, (await getVoiceSettings(db, 'beta')).provider], ['elevenlabs', 'retell'], 'beta untouched')
  const actions = db.sql.prepare("SELECT actor, action, customer, details FROM admin_audit ORDER BY id").all()
  assert.deepEqual(actions.map((a) => [a.actor, a.action, a.customer]), [[ADMIN, 'receptionist.provider_switch_blocked', 'alpha'], [ADMIN, 'receptionist.provider_switched', 'alpha']])
  assert.match(actions[1].details, /"from":"retell","to":"elevenlabs"/)
  assert.ok(!actions.some((a) => LEAK.test(a.details)))
  // Rollback: typed id required; restores Retell with the default voice; audited; nothing left to roll back.
  assert.deepEqual([(await post({ action: 'rollback', customer: 'alpha', confirm: true, version: 1 })).json().error, (await post({ action: 'rollback', customer: 'alpha', confirmCustomer: 'beta', confirm: true, version: 1 })).json().error], ['confirm_customer_mismatch', 'confirm_customer_mismatch'])
  assert.equal((await post({ action: 'rollback', customer: 'alpha', confirmCustomer: 'alpha', version: 1 })).status, 409)
  const rb = await post({ action: 'rollback', customer: 'alpha', confirmCustomer: 'alpha', confirm: true, version: 1 })
  assert.equal(rb.status, 200, rb.json().error)
  assert.deepEqual([rb.json().providers.current, rb.json().voice.voiceName, rb.json().providers.previous], ['retell', null, null])
  assert.equal((await post({ action: 'rollback', customer: 'alpha', confirmCustomer: 'alpha', confirm: true, version: 2 })).json().error, 'nothing_to_roll_back')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'receptionist.provider_rolled_back'").get().n, 1)
  // Beta (never switched, no session) is checked on its own records: blocked for its own reasons, not alpha's evidence.
  assert.deepEqual((await post({ action: 'check', customer: 'beta', provider: 'retell' })).json().check.blockers, ['test_session_required', 'no_change'])
})
