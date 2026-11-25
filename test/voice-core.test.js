// Shared voice core (server/voice/*): the provider-independent tool runner with dry-run, Lab sessions bound to a
// platform admin + an admin-marked TEST business, and honest provider status. Mocked at the network boundary only
// (Google free/busy); the real engine tools, D1 schema and routes run.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { providerStatus, labEnabled, estimateMicros, COST_ESTIMATES } from '../server/voice/providers.js'
import { runVoiceTool, voiceInstructions, toolsForOpenAI, toolsForElevenLabs, VOICE_TOOL_NAMES, appendVoiceTranscript } from '../server/voice/tools.js'
import { startLabSession, loadLabSession, endLabSession, listLabSessions, cleanMetrics } from '../server/voice/sessions.js'
import * as statusApi from '../functions/api/platform/voice-lab/status.js'
import * as sessionApi from '../functions/api/platform/voice-lab/session.js'
import * as toolApi from '../functions/api/platform/voice-lab/tool.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['sk-openai-SECRET-0123456789abcdef', 'el_SECRET_0123456789abcdefghij', 'retell_SECRET', KEY]

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}

let env, db, kv, fetches, responses, origFetch, origError, logs
const admin = { email: 'staff@getshowups.com' }
const DAY = 864e5

async function seed(id, { test: isTest = true, zips = '29401,29403' } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, zips, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run pool care.', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), t)
  db.sql.prepare('INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?, 1, ?, ?, ?, ?, 1)').run(id, 'ai_first', null, null, null)
  if (isTest) db.sql.prepare('INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, ?, ?)').run(id, 'staff@getshowups.com', t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
  return customerFromRow(await getCustomer(db, id))
}
const sessionCookie = async (email) => {
  const token = ('tok_' + email.replace(/\W/g, '') + 'x'.repeat(43)).slice(0, 43)
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
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

beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com', ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test', VOICE_LAB_ENABLED: 'true', OPENAI_API_KEY: SECRETS[0], ELEVENLABS_API_KEY: SECRETS[1], ELEVENLABS_AGENT_ID: 'agent_abc123',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push(u)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
    if (u.includes('/events?sendUpdates=all')) return json(200, { id: JSON.parse(init.body).id })
    throw new Error(`unexpected ${u}`)
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

test('provider status is honest: configured booleans and codes only; the Lab is off unless VOICE_LAB_ENABLED is exactly true', () => {
  const s = providerStatus(env)
  assert.deepEqual(s.openai, { configured: true, model: 'gpt-realtime' })
  assert.deepEqual(s.elevenlabs, { configured: true })
  assert.deepEqual(s.retell, { configured: false, reason: 'retell_not_configured' })
  assert.deepEqual(providerStatus({}).openai, { configured: false, reason: 'openai_not_configured' })
  assert.ok(!JSON.stringify(s).includes(SECRETS[0]))
  assert.equal(labEnabled({ VOICE_LAB_ENABLED: 'TRUE' }), false)
  assert.equal(labEnabled(env), true)
  assert.equal(estimateMicros('openai', 60), COST_ESTIMATES.openai.perMinuteMicros == null ? null : COST_ESTIMATES.openai.perMinuteMicros)
})

test('tool catalogue: the same seven engine tools, re-shaped for OpenAI and ElevenLabs, nothing provider-specific', () => {
  assert.deepEqual(VOICE_TOOL_NAMES, ['save_customer_details', 'check_service_area', 'request_coverage', 'find_available_times', 'book_appointment', 'request_callback', 'leave_message'])
  assert.deepEqual(toolsForOpenAI().map((t) => [t.type, t.name]), VOICE_TOOL_NAMES.map((n) => ['function', n]))
  assert.ok(toolsForElevenLabs().every((t) => t.expects_response === true && t.parameters.type === 'object'))
})

test('dry-run session: every guard runs (area, offered slot, confirming words, details) and the booking is simulated: no lead, no appointment, no Google event', async () => {
  const customer = await seed('alpha')
  const start = await startLabSession(env, admin, { customer: 'alpha', provider: 'openai' })
  assert.equal(start.ok, true)
  assert.equal(start.session.dryRun, true)
  const s = await loadLabSession(env, 'alpha', start.session.id, start.session.token)
  const run = (name, input, userText) => runVoiceTool(env, { customer, conv: s.conv, userText, dryRun: true, provider: 'openai' }, name, input)
  assert.deepEqual((await run('check_service_area', { zip: '29999' }, 'I am in 29999')).served, false)
  assert.equal((await run('check_service_area', { zip: '29401' }, 'two nine four zero one')).served, true)
  const times = await run('find_available_times', { date: '', part_of_day: 'any' }, 'tomorrow?')
  assert.ok(times.options.length > 0)
  assert.equal((await run('book_appointment', { slot_id: 'nope', confirmation_quote: 'yes' }, 'yes')).error, 'slot_not_offered')
  assert.equal((await run('book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes book it' }, 'hmm maybe')).error, 'confirmation_required')
  assert.equal((await run('book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')).error, 'details_missing')
  const saved = await run('save_customer_details', { name: 'Jamie Rivera', phone: '8435550142', email: '', zip: '29401', street: '', city: '', state: '', need: 'Green pool' }, 'Jamie Rivera, 843 555 0142, 29401, green pool')
  assert.equal(saved.ok, true)
  const booked = await run('book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')
  assert.equal(booked.booked, true)
  assert.equal(booked.simulated, true)
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0)
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0)
  assert.ok(!fetches.some((u) => u.includes('/events')), 'no Google event created')
  const cb = await run('request_callback', { reason: 'wants a person', urgent: false }, 'can I talk to someone')
  assert.equal(cb.simulated, true)
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM receptionist_requests').get().n, 0)
  const ev = db.sql.prepare("SELECT kind, detail FROM receptionist_events WHERE conversation_id = ? AND kind = 'book_appointment' ORDER BY id").all(s.conv.id)
  assert.equal(ev.at(-1).detail, 'booked_simulated')
  const ended = await endLabSession(env, s, { metrics: { firstResponseMs: 812.4, turns: 5, bogus: 'x', providerCostMicros: -1 }, outcome: 'booked' })
  assert.equal(ended.summary.simulated, true)
  assert.deepEqual(Object.keys(ended.summary.metrics).sort(), ['durationSeconds', 'firstResponseMs', 'turns'])
  assert.equal((await listLabSessions(env))[0].id, s.conv.id)
  assert.deepEqual(cleanMetrics({ p95ResponseMs: 1200.6, note: 'no' }), { p95ResponseMs: 1201 })
})

test('a live (not dry-run) Lab session books for real through the same guards', async () => {
  const customer = await seed('alpha')
  const start = await startLabSession(env, admin, { customer: 'alpha', provider: 'elevenlabs', dryRun: false })
  const s = await loadLabSession(env, 'alpha', start.session.id, start.session.token)
  const run = (name, input, userText) => runVoiceTool(env, { customer, conv: s.conv, userText, dryRun: false, provider: 'elevenlabs' }, name, input)
  await run('save_customer_details', { name: 'Jamie Rivera', phone: '8435550142', email: '', zip: '29401', street: '', city: '', state: '', need: 'Green pool' }, 'Jamie Rivera, 843 555 0142, 29401, green pool')
  const times = await run('find_available_times', { date: '', part_of_day: 'any' }, 'tomorrow?')
  const booked = await run('book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes' }, 'yes')
  assert.equal(booked.booked, true)
  assert.equal(booked.simulated, undefined)
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 1)
})

test('tenant binding: a session of one business cannot be loaded or driven through another; unknown tools and ended sessions refuse', async () => {
  await seed('alpha')
  await seed('beta')
  const start = await startLabSession(env, admin, { customer: 'alpha', provider: 'openai' })
  assert.equal(await loadLabSession(env, 'beta', start.session.id, start.session.token), null)
  assert.equal(await loadLabSession(env, 'alpha', start.session.id, 'wrong-token'), null)
  const s = await loadLabSession(env, 'alpha', start.session.id, start.session.token)
  assert.deepEqual(await runVoiceTool(env, { customer: s.customer, conv: s.conv, userText: '' }, 'drop_tables', {}), { ok: false, error: 'unknown_tool' })
  await endLabSession(env, s, {})
  assert.deepEqual(await runVoiceTool(env, { customer: s.customer, conv: s.conv, userText: '' }, 'check_service_area', { zip: '29401' }), { ok: false, error: 'conversation_ended' })
})

test('gates: a real (non-test) business is refused, an unconfigured provider is refused, the Lab is 404 when off, and the daily minute ceiling holds', async () => {
  await seed('real', { test: false })
  await seed('alpha')
  assert.equal((await startLabSession(env, admin, { customer: 'real', provider: 'openai' })).error, 'not_test_business')
  assert.equal((await startLabSession(env, admin, { customer: 'alpha', provider: 'retell' })).error, 'retell_not_configured')
  assert.equal((await startLabSession(env, admin, { customer: 'alpha', provider: 'other' })).error, 'invalid_provider')
  assert.equal((await startLabSession({ ...env, VOICE_LAB_ENABLED: 'false' }, admin, { customer: 'alpha', provider: 'openai' })).httpStatus, 404)
  // A fixed time of day: the ceiling counts a UTC day, so five minutes back must be the same day.
  const noon = Math.floor(Date.now() / 864e5) * 864e5 + 432e5
  const a = await startLabSession({ ...env, VOICE_LAB_DAILY_MINUTES: '1' }, admin, { customer: 'alpha', provider: 'openai' }, noon - 5 * 60_000)
  assert.equal(a.ok, true)
  assert.equal((await startLabSession({ ...env, VOICE_LAB_DAILY_MINUTES: '1' }, admin, { customer: 'alpha', provider: 'openai' }, noon)).error, 'lab_daily_limit')
})

test('routes: platform admin only, same-origin writes, 404 when the Lab is off, the tool route runs the engine tool for the session and the transcript is kept as text', async () => {
  const customer = await seed('alpha')
  const staff = await sessionCookie('staff@getshowups.com')
  const owner = await sessionCookie('owner@alpha.example')
  assert.equal((await call(statusApi, 'GET', '/api/platform/voice-lab/status')).status, 401)
  assert.equal((await call(statusApi, 'GET', '/api/platform/voice-lab/status', { cookie: owner })).status, 403)
  const st = await call(statusApi, 'GET', '/api/platform/voice-lab/status', { cookie: staff })
  assert.equal(st.status, 200)
  assert.deepEqual(st.json().businesses.map((b) => b.id), ['alpha'])
  assert.equal(st.json().providers.openai.configured, true)
  env.VOICE_LAB_ENABLED = 'false'
  assert.equal((await call(statusApi, 'GET', '/api/platform/voice-lab/status', { cookie: staff })).status, 404)
  env.VOICE_LAB_ENABLED = 'true'
  assert.equal((await call(sessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, origin: 'https://evil.example', body: { action: 'start', provider: 'openai', customer: 'alpha' } })).status, 403)
  const started = await call(sessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'start', provider: 'openai', customer: 'alpha' } })
  assert.equal(started.status, 200)
  const { session } = started.json()
  assert.equal(session.dryRun, true)
  assert.equal((await call(toolApi, 'POST', '/api/platform/voice-lab/tool', { cookie: staff, body: { customer: 'alpha', id: session.id, token: session.token, name: 'rm_rf', input: {} } })).status, 400)
  const tr = await call(toolApi, 'POST', '/api/platform/voice-lab/tool', { cookie: staff, body: { customer: 'alpha', id: session.id, token: session.token, name: 'check_service_area', input: { zip: '29401' }, userText: 'I am in 29401' } })
  assert.equal(tr.status, 200)
  assert.equal(tr.json().result.served, true)
  assert.equal((await call(toolApi, 'POST', '/api/platform/voice-lab/tool', { cookie: staff, body: { customer: 'beta', id: session.id, token: session.token, name: 'check_service_area', input: { zip: '29401' } } })).status, 404)
  assert.equal((await call(sessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'transcript', customer: 'alpha', id: session.id, token: session.token, lines: [{ who: 'customer', text: 'I am in 29401' }, { who: 'receptionist', text: 'Yes, we service 29401.' }, { who: 'system', text: 'ignored' }] } })).json().added, 2)
  const ended = await call(sessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'end', customer: 'alpha', id: session.id, token: session.token, metrics: { firstResponseMs: 640 } } })
  assert.equal(ended.status, 200)
  assert.deepEqual(ended.json().summary.log.map((l) => l.who), ['customer', 'receptionist'])
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action LIKE 'voice_lab.%'").get().n, 2)
  const instr = await voiceInstructions(env, customer)
  assert.match(instr.instructions, /alpha Co/)
  assert.match(instr.instructions, /Yes, we service <place>/)
  assert.match(instr.instructions, /check_service_area with place/)
  assert.ok(!instr.instructions.includes(SECRETS[0]))
  await appendVoiceTranscript(env, customer, { id: session.id, state: {} }, [])
})
