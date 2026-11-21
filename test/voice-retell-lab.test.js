// Retell in the Voice Lab (server/voice/retell.js, /api/platform/voice-lab/retell, server/receptionist/voice.js): the
// production call path on an admin-marked TEST business, allowed only while the Lab is on; our key never leaves the
// server; one Lab call at a time; a Lab conversation started in dry-run stays dry on every path that answers it.
// Retell and Google are mocked at the network boundary; the real D1 schema, engine and routes run.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { attachRetellSocket } from '../server/receptionist/voice.js'
import { loadConversation } from '../server/receptionist/engine.js'
import { startLabSession, loadLabSession, endLabSession, labBusy } from '../server/voice/sessions.js'
import { runVoiceTool } from '../server/voice/tools.js'
import { RETELL_LAB_MAX_CONNECTS } from '../server/voice/retell.js'
import * as retellApi from '../functions/api/platform/voice-lab/retell.js'

const ORIGIN = 'https://getshowups.com'
const MOCK = 'http://127.0.0.1:9913'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['retell_SECRET_key_0123456789', KEY]
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}
let env, db, kv, fetches, responses, origFetch, origError, logs
const admin = { email: 'staff@getshowups.com' }

async function seed(id, { test: isTest = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, t, t, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '', 'Software', '', ?, '[]', ?)").run(id, JSON.stringify([{ name: 'Founding plan', price: '$499/month' }]), t)
  db.sql.prepare("INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, updated_at) VALUES (?, 1, 'ai_first', 1)").run(id)
  if (isTest) db.sql.prepare('INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, ?, ?)').run(id, admin.email, t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
  return customerFromRow(await getCustomer(db, id))
}
const cookieFor = async (email) => {
  const token = ('tok_' + email.replace(/\W/g, '') + 'x'.repeat(43)).slice(0, 43)
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
const call = async (mod, path, { cookie, origin = ORIGIN, body } = {}) => {
  const h = { 'CF-Connecting-IP': '203.0.113.9', Origin: origin }
  if (cookie) h.Cookie = cookie
  const res = await mod.onRequestPost({ request: new Request(ORIGIN + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }), env, waitUntil: () => {} })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}
function ws() {
  const sent = []
  return { sent, send: (s) => sent.push(JSON.parse(s)), close: (code) => sent.push({ closed: code }), addEventListener: () => {} }
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: admin.email, ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test', VOICE_LAB_ENABLED: 'true',
    RETELL_API_KEY: SECRETS[0], RETELL_AGENT_ID: 'agent_abc123def', RETELL_WS_SECRET: 'w'.repeat(40), RETELL_API_MOCK_ORIGIN: MOCK, RECEPTIONIST_VOICE_BUSINESSES: 'poolthru-llc',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === `${MOCK}/v3/create-web-call`) return json(201, { call_id: `call_lab${fetches.length}abcdef`, access_token: 'web_access_token', transport: 'gateway', ice_servers: [] })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
    throw new Error(`unexpected ${u}`)
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  for (const s of SECRETS) assert.ok(![...responses, ...logs].join('\n').includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

test('a Lab Retell call: our server creates it with the shared agent, the Lab call row becomes that call, the socket answers it for a test business the voice allowlist does not name; never for a real business, never with the Lab off', async () => {
  await seed('getshowups-lab')
  await seed('realco', { test: false })
  const staff = await cookieFor(admin.email)
  const start = await startLabSession(env, admin, { customer: 'getshowups-lab', provider: 'retell' })
  assert.equal(start.ok, true)
  assert.equal(await labBusy(env), true, 'one Lab call at a time')
  assert.equal((await startLabSession(env, admin, { customer: 'getshowups-lab', provider: 'retell' })).error, 'lab_busy')
  const { id, token } = start.session
  const r = await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'getshowups-lab', id, token } })
  assert.equal(r.status, 200)
  const { accessToken, callId, connectionsLeft } = r.json()
  assert.deepEqual([accessToken, connectionsLeft], ['web_access_token', RETELL_LAB_MAX_CONNECTS - 1])
  const sent = JSON.parse(fetches.find((f) => f.url.endsWith('/v3/create-web-call')).init.body)
  assert.deepEqual([sent.agent_id, sent.metadata.business, sent.metadata.lab], ['agent_abc123def', 'getshowups-lab', true])
  assert.deepEqual({ ...db.sql.prepare('SELECT call_id, provider, ended_at FROM receptionist_calls WHERE conversation_id = ?').get(id) }, { call_id: callId, provider: 'retell-lab', ended_at: null })
  // The custom-LLM socket routes the call to the Lab conversation although getshowups-lab is not in RECEPTIONIST_VOICE_BUSINESSES.
  const s = ws()
  assert.equal(await attachRetellSocket(env, s, callId), true)
  assert.equal(s.sent[0].response_type, 'config')
  assert.match(s.sent[1].content, /getshowups-lab Co|Thanks for calling/)
  // Lab off → the same call is refused; a real business's Lab-shaped row is refused too.
  const off = ws()
  assert.equal(await attachRetellSocket({ ...env, VOICE_LAB_ENABLED: 'false' }, off, callId), false)
  assert.deepEqual(off.sent.at(-1), { closed: 1008 })
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES ('call_realshaped1', 'realco', ?, 'retell-lab', ?)").run(id, Date.now())
  const real = ws()
  assert.equal(await attachRetellSocket(env, real, 'call_realshaped1'), false)
  // Gates on the route: other business / wrong token 404, non-admin 401/403, cross-origin 403, wrong provider 409, reconnect cap.
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'realco', id, token } })).status, 404)
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'getshowups-lab', id, token: 'wrong' } })).status, 404)
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { body: { customer: 'getshowups-lab', id, token } })).status, 401)
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, origin: 'https://evil.example', body: { customer: 'getshowups-lab', id, token } })).status, 403)
  for (let i = 1; i < RETELL_LAB_MAX_CONNECTS; i++) assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'getshowups-lab', id, token } })).status, 200)
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'getshowups-lab', id, token } })).json().error, 'reconnect_limit')
  db.sql.prepare("DELETE FROM receptionist_calls WHERE call_id = 'call_realshaped1'").run() // the refused real-business row, not a Lab call
  const ended = await endLabSession(env, await loadLabSession(env, 'getshowups-lab', id, token), {})
  assert.equal(ended.ok, true)
  assert.equal(await labBusy(env), false)
  assert.ok(db.sql.prepare('SELECT ended_at FROM receptionist_calls WHERE conversation_id = ?').get(id).ended_at > 0)
  assert.equal((await call(retellApi, '/api/platform/voice-lab/retell', { cookie: staff, body: { customer: 'getshowups-lab', id, token } })).json().error, 'conversation_ended')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'voice_lab.retell_connect'").get().n, RETELL_LAB_MAX_CONNECTS + 2, 'every connect attempt is audited, refused ones included')
  const other = await startLabSession(env, admin, { customer: 'getshowups-lab', provider: 'openai' })
  assert.equal(other.error, 'openai_not_configured')
})

test('dry-run follows the Lab conversation into the engine: a booking through the Lab path is simulated, nothing is created; the Lab summary lists the tools (from the runner, or from the engine events for a Retell call)', async () => {
  const customer = await seed('getshowups-lab')
  const start = await startLabSession(env, admin, { customer: 'getshowups-lab', provider: 'retell' })
  const { conv } = await loadLabSession(env, 'getshowups-lab', start.session.id, start.session.token)
  assert.equal(conv.state.lab.dryRun, true)
  const run = (name, input, userText) => runVoiceTool(env, { customer, conv, userText, dryRun: conv.state.lab.dryRun, provider: 'retell' }, name, input)
  await run('save_customer_details', { name: 'Jamie Rivera', phone: '8435550142', email: '', zip: '', street: '', city: '', state: '', need: 'pool company' }, 'Jamie Rivera, 843 555 0142, pool company')
  const times = await run('find_available_times', { date: '', part_of_day: 'any' }, 'tomorrow?')
  const booked = await run('book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')
  assert.deepEqual([booked.booked, booked.simulated], [true, true])
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM appointments').get().n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM leads').get().n, 0)
  const fresh = await loadLabSession(env, 'getshowups-lab', start.session.id, start.session.token)
  const ended = await endLabSession(env, fresh, {})
  assert.deepEqual(ended.summary.tools.map((t) => [t.name, t.ok, t.simulated]), [['save_customer_details', true, undefined], ['find_available_times', true, undefined], ['book_appointment', true, true]])
  assert.equal((await loadConversation(env, customer, conv.id)).state.endedAt > 0, true)
  // A Retell call answers through the engine on the server (no runner): the summary reads the engine's own events.
  const second = await startLabSession(env, admin, { customer: 'getshowups-lab', provider: 'retell' })
  const s2 = await loadLabSession(env, 'getshowups-lab', second.session.id, second.session.token)
  db.sql.prepare("INSERT INTO receptionist_events (customer, conversation_id, kind, ok, detail, at) VALUES ('getshowups-lab', ?, 'check_service_area', 1, NULL, ?), ('getshowups-lab', ?, 'book_appointment', 1, 'booked_simulated', ?)").run(s2.conv.id, Date.now(), s2.conv.id, Date.now())
  const e2 = await endLabSession(env, s2, {})
  assert.deepEqual(e2.summary.tools.map((t) => [t.name, t.ok, t.simulated]), [['check_service_area', true, undefined], ['book_appointment', true, true]])
})
