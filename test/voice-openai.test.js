// OpenAI Realtime adapter for the Voice Lab: the server mints a SHORT-LIVED client secret with our permanent key
// (mocked at the network boundary: no OPENAI_API_KEY exists anywhere, so nothing here talks to OpenAI), the route
// keeps every Lab gate, and the browser adapter (run in node with a fake RTCPeerConnection) forwards every model tool
// call to our server, keeps the transcript, measures response times and recovers from a dropped connection.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { COST_ESTIMATES, estimateMicros } from '../server/voice/providers.js'
import { VOICE_TOOL_NAMES } from '../server/voice/tools.js'
import { startLabSession, endLabSession, loadLabSession } from '../server/voice/sessions.js'
import { mintClientSecret, openaiSessionConfig, openaiVoice, OPENAI_CLIENT_SECRETS_URL, CLIENT_SECRET_TTL_SECONDS, CLIENT_SECRET_MAX_TTL_SECONDS } from '../server/voice/openai.js'
import * as openaiApi from '../functions/api/platform/voice-lab/openai.js'
import { createOpenAIAdapter, OPENAI_CALLS_URL, OPENAI_DATA_CHANNEL, MAX_RECONNECTS } from '../src/voice/openai.js'
import { summarizeMetrics, ADAPTER_EVENTS, METRIC_KEYS } from '../src/voice/adapter.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const OPENAI_KEY = 'sk-proj-PERMANENT-SECRET-0123456789abcdefghij'
const SECRETS = [OPENAI_KEY, KEY]
const EPHEMERAL = 'ek_test_ephemeral_0123456789'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}

let env, db, kv, fetches, responses, origFetch, origError, logs, openaiStatus
const admin = { email: 'staff@getshowups.com' }
const DAY = 864e5

async function seed(id, { test: isTest = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401,29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run pool care.', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), t)
  db.sql.prepare('INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?, 1, ?, ?, ?, ?, 1)').run(id, 'ai_first', 'Thanks for calling alpha Co, this is Sam.', null, null)
  if (isTest) db.sql.prepare('INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, ?, ?)').run(id, 'staff@getshowups.com', t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
  return customerFromRow(await getCustomer(db, id))
}
const sessionCookie = async (email) => {
  const token = ('tok_' + email.replace(/\W/g, '') + 'x'.repeat(43)).slice(0, 43)
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, path, { cookie, origin = ORIGIN, body } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', Origin: origin }
  if (cookie) h.Cookie = cookie
  const res = await mod.onRequestPost({ request: new Request(ORIGIN + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }), env, waitUntil: () => {} })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  openaiStatus = 200
  env = {
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com', ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test', VOICE_LAB_ENABLED: 'true', OPENAI_API_KEY: OPENAI_KEY,
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === OPENAI_CLIENT_SECRETS_URL) {
      const body = JSON.parse(init.body)
      if (openaiStatus !== 200) return json(openaiStatus, { error: { message: 'nope' } })
      return json(200, { value: EPHEMERAL, expires_at: Math.floor(Date.now() / 1000) + body.expires_after.seconds, session: body.session })
    }
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
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

test('session config: our instructions, the seven tools, audio in/out, server VAD with interruptions, caller transcription, an allowlisted voice', () => {
  const c = openaiSessionConfig(env, 'INSTRUCTIONS HERE')
  assert.equal(c.type, 'realtime')
  assert.equal(c.model, 'gpt-realtime')
  assert.equal(c.instructions, 'INSTRUCTIONS HERE')
  assert.deepEqual(c.output_modalities, ['audio'])
  assert.deepEqual(c.tools.map((t) => t.name), VOICE_TOOL_NAMES)
  assert.ok(c.tools.every((t) => t.type === 'function' && t.parameters?.type === 'object'))
  assert.equal(c.tool_choice, 'auto')
  assert.equal(c.audio.input.turn_detection.type, 'server_vad')
  assert.equal(c.audio.input.turn_detection.interrupt_response, true)
  assert.equal(c.audio.input.turn_detection.create_response, true)
  assert.equal(typeof c.audio.input.transcription.model, 'string')
  assert.equal(c.audio.output.voice, 'marin')
  assert.equal(openaiVoice({ OPENAI_REALTIME_VOICE: 'cedar' }), 'cedar')
  assert.equal(openaiVoice({ OPENAI_REALTIME_VOICE: 'x"; drop' }), 'marin')
  assert.ok(!JSON.stringify(c).includes(OPENAI_KEY))
})

test('mintClientSecret: the permanent key is sent only to OpenAI as a bearer, the lifetime is short, the response carries the ephemeral value and never our key', async () => {
  const r = await mintClientSecret(env, { instructions: 'I' })
  assert.equal(r.ok, true)
  assert.equal(r.clientSecret, EPHEMERAL)
  assert.equal(r.model, 'gpt-realtime')
  assert.equal(r.sessionConfig.instructions, 'I')
  assert.ok(r.expiresAt > Date.now() && r.expiresAt <= Date.now() + CLIENT_SECRET_MAX_TTL_SECONDS * 1000 + 1000)
  assert.ok(!JSON.stringify(r).includes(OPENAI_KEY))
  const sent = fetches.find((f) => f.url === OPENAI_CLIENT_SECRETS_URL)
  assert.equal(sent.init.headers.Authorization, `Bearer ${OPENAI_KEY}`)
  const body = JSON.parse(sent.init.body)
  assert.deepEqual(body.expires_after, { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS })
  assert.ok(CLIENT_SECRET_TTL_SECONDS <= 300 && CLIENT_SECRET_MAX_TTL_SECONDS <= 600, 'short-lived')
  assert.equal(body.session.tools.length, 7)
  assert.equal((await mintClientSecret(env, { instructions: 'I', ttlSeconds: 99999 })).ok, true)
  assert.equal(JSON.parse(fetches.at(-1).init.body).expires_after.seconds, CLIENT_SECRET_MAX_TTL_SECONDS)
  // Failure paths are codes only
  assert.deepEqual(await mintClientSecret({}, { instructions: 'I' }), { ok: false, error: 'openai_not_configured' })
  openaiStatus = 401
  assert.equal((await mintClientSecret(env, { instructions: 'I' })).error, 'openai_auth_failed')
  openaiStatus = 429
  assert.equal((await mintClientSecret(env, { instructions: 'I' })).error, 'openai_rate_limited')
  openaiStatus = 503
  assert.equal((await mintClientSecret(env, { instructions: 'I' })).error, 'openai_unavailable')
  assert.equal((await mintClientSecret(env, { instructions: 'I' }, async () => { throw new Error('ECONNRESET') })).error, 'openai_unreachable')
  assert.equal((await mintClientSecret(env, { instructions: 'I' }, async () => new Response(JSON.stringify({ value: OPENAI_KEY }), { status: 200 }))).error, 'openai_bad_response')
  assert.ok(!logs.join('\n').includes('nope'), 'provider payloads never logged')
})

test('route: admin + same-origin + Lab on + provider configured + a Lab session of this business on this provider; the ephemeral secret goes to the browser, our key never does; audited', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await sessionCookie('staff@getshowups.com')
  const owner = await sessionCookie('owner@alpha.example')
  const start = await startLabSession(env, admin, { customer: 'alpha', provider: 'openai' })
  const body = { customer: 'alpha', id: start.session.id, token: start.session.token }
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { body })).status, 401)
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: owner, body })).status, 403)
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, origin: 'https://evil.example', body })).status, 403)
  env.VOICE_LAB_ENABLED = 'false'
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body })).status, 404)
  env.VOICE_LAB_ENABLED = 'true'
  const saved = env.OPENAI_API_KEY
  delete env.OPENAI_API_KEY
  const off = await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body })
  assert.equal(off.status, 404)
  assert.equal(off.json().error, 'openai_not_configured')
  env.OPENAI_API_KEY = saved
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body: { ...body, customer: 'beta' } })).status, 404)
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body: { ...body, token: 'wrong' } })).status, 404)
  const ok = await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body })
  assert.equal(ok.status, 200)
  const data = ok.json()
  assert.equal(data.clientSecret, EPHEMERAL)
  assert.equal(data.model, 'gpt-realtime')
  assert.ok(data.expiresAt > Date.now())
  assert.match(data.sessionConfig.instructions, /alpha Co/)
  assert.match(data.sessionConfig.instructions, /Yes, we service <place>/)
  assert.equal(data.sessionConfig.tools.length, 7)
  assert.equal(data.greeting, 'Thanks for calling alpha Co, this is Sam.')
  assert.ok(!JSON.stringify(data).includes(OPENAI_KEY))
  // Only OpenAI's client-secret endpoint ever saw our key
  for (const f of fetches) if (f.init?.headers?.Authorization?.includes(OPENAI_KEY)) assert.equal(f.url, OPENAI_CLIENT_SECRETS_URL)
  // Provider failures surface as codes
  openaiStatus = 500
  const bad = await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body })
  assert.equal(bad.status, 502)
  assert.equal(bad.json().error, 'openai_unavailable')
  openaiStatus = 200
  // A session on another provider or an ended one is refused
  const el = await startLabSession({ ...env, ELEVENLABS_API_KEY: 'el_'.padEnd(30, 'x'), ELEVENLABS_AGENT_ID: 'agent_1' }, admin, { customer: 'alpha', provider: 'elevenlabs' })
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body: { customer: 'alpha', id: el.session.id, token: el.session.token } })).json().error, 'wrong_provider')
  await endLabSession(env, await loadLabSession(env, 'alpha', start.session.id, start.session.token), {})
  assert.equal((await call(openaiApi, '/api/platform/voice-lab/openai', { cookie: staff, body })).json().error, 'conversation_ended')
  const audits = db.sql.prepare("SELECT details FROM admin_audit WHERE action = 'voice_lab.openai_connect'").all()
  assert.equal(audits.length, 2)
  assert.ok(audits.every((a) => !a.details.includes(EPHEMERAL)))
  // A real (non-test) business never gets a Lab session, so there is nothing to connect
  await seed('realco', { test: false })
  assert.equal((await startLabSession(env, admin, { customer: 'realco', provider: 'openai' })).error, 'not_test_business')
})

test('cost estimate: labelled, sourced, dated, and only ever an estimate', () => {
  const e = COST_ESTIMATES.openai
  assert.ok(e.perMinuteMicros > 0 && e.estimate === true)
  assert.match(e.source, /^https:\/\/developers\.openai\.com\//)
  assert.match(e.asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(estimateMicros('openai', 60), e.perMinuteMicros)
  assert.equal(estimateMicros('openai', 0), null)
})

// ---- Browser adapter, run in node with a fake peer connection ------------------------------------------------------

function fakeRtc() {
  const made = []
  class FakeChannel {
    constructor(label) {
      this.label = label
      this.readyState = 'connecting'
      this.sent = []
    }
    send(s) {
      if (this.readyState !== 'open') throw new Error('not open')
      this.sent.push(JSON.parse(s))
    }
    close() {
      this.readyState = 'closed'
    }
    open() {
      this.readyState = 'open'
      this.onopen?.()
    }
    receive(ev) {
      this.onmessage?.({ data: JSON.stringify(ev) })
    }
  }
  class FakePC {
    constructor() {
      this.tracks = []
      this.connectionState = 'new'
      made.push(this)
    }
    addTrack(t) {
      this.tracks.push(t)
    }
    createDataChannel(label) {
      this.dc = new FakeChannel(label)
      return this.dc
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' }
    }
    async setLocalDescription() {}
    async setRemoteDescription(d) {
      this.remote = d
      this.connectionState = 'connected'
      queueMicrotask(() => this.dc.open())
    }
    close() {
      this.connectionState = 'closed'
    }
    drop(state = 'failed') {
      this.connectionState = state
      this.onconnectionstatechange?.()
    }
  }
  return { FakePC, made }
}

function harness({ mintStatus = 200, toolResult = { ok: true, served: true }, sdpOk = true } = {}) {
  const calls = []
  const events = []
  const rtc = fakeRtc()
  const mic = { stopped: 0, getAudioTracks: () => [{ kind: 'audio' }], getTracks() { return [{ stop: () => { mic.stopped += 1 } }] } }
  let t = 1000
  const api = async (path, { body }) => {
    calls.push({ path, body })
    if (path === '/api/platform/voice-lab/openai') return mintStatus === 200 ? { status: 200, data: { clientSecret: EPHEMERAL, expiresAt: Date.now() + 180_000, model: 'gpt-realtime', sessionConfig: { type: 'realtime', model: 'gpt-realtime', instructions: 'I', tools: [{ type: 'function', name: 'check_service_area' }] }, greeting: 'Hi, this is alpha Co.' } } : { status: mintStatus, data: { error: mintStatus === 404 ? 'openai_not_configured' : 'oops' } }
    if (path === '/api/platform/voice-lab/tool') return typeof toolResult === 'function' ? toolResult(body) : { status: 200, data: { result: toolResult } }
    if (path === '/api/platform/voice-lab/session') return { status: 200, data: body.action === 'end' ? { ok: true, summary: { id: body.id, metrics: body.metrics, outcome: body.outcome } } : { ok: true, added: body.lines.length } }
    return { status: 404, data: { error: 'not_found' } }
  }
  const sdp = []
  const fetch = async (url, init) => {
    sdp.push({ url, init })
    return sdpOk ? new Response('v=0 answer', { status: 200 }) : new Response('no', { status: 401 })
  }
  const timers = []
  const adapter = createOpenAIAdapter({ api, fetch, RTCPeerConnection: rtc.FakePC, getUserMedia: async () => mic, now: () => t, setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout: () => {}, audio: { play: () => Promise.resolve() } })
  const onEvent = (name, payload) => events.push({ ...payload, name, ...(name === 'tool' ? { tool: payload.name } : {}) })
  const tick = (ms) => { t += ms }
  const flushTimers = async () => { for (const fn of timers.splice(0)) await fn() }
  return { adapter, api, calls, events, rtc, mic, sdp, tick, flushTimers, onEvent, pc: () => rtc.made.at(-1), dc: () => rtc.made.at(-1).dc }
}
const settle = () => new Promise((r) => setTimeout(r, 5))
const session = { customer: 'alpha', id: 'conv_1', token: 'tok_1' }

test('adapter: mint → WebRTC offer with the ephemeral key → session.update + one greeting; the API shape is the documented one', async () => {
  const h = harness()
  assert.equal(h.adapter.state, 'idle')
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  assert.equal(h.adapter.state, 'connected')
  assert.deepEqual(h.calls[0], { path: '/api/platform/voice-lab/openai', body: session })
  assert.equal(h.sdp[0].url, OPENAI_CALLS_URL)
  assert.equal(h.sdp[0].init.headers.Authorization, `Bearer ${EPHEMERAL}`)
  assert.equal(h.sdp[0].init.headers['Content-Type'], 'application/sdp')
  assert.equal(h.sdp[0].init.body, 'v=0 offer')
  assert.deepEqual(h.pc().remote, { type: 'answer', sdp: 'v=0 answer' })
  assert.equal(h.dc().label, OPENAI_DATA_CHANNEL)
  assert.equal(h.pc().tracks.length, 1, 'microphone track added')
  const types = h.dc().sent.map((m) => m.type)
  assert.deepEqual(types, ['session.update', 'conversation.item.create', 'response.create'])
  assert.equal(h.dc().sent[0].session.model, undefined)
  assert.equal(h.dc().sent[0].session.instructions, 'I')
  assert.equal(h.dc().sent[0].session.tools.length, 1)
  assert.match(h.dc().sent[1].item.content[0].text, /Hi, this is alpha Co\./)
  assert.deepEqual(h.events.map((e) => e.name + ':' + (e.state || '')), ['status:connecting', 'status:connected'])
  await assert.rejects(h.adapter.start({ ...session, onEvent: h.onEvent }), /already_started/)
  const { summary, metrics } = await h.adapter.stop()
  assert.equal(h.adapter.state, 'stopped')
  assert.equal(h.mic.stopped, 1)
  assert.equal(summary.outcome, 'ended')
  assert.deepEqual(metrics, { turns: 0, interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0, audioSeconds: 0, inputTokens: 0, outputTokens: 0 })
  assert.equal(h.calls.at(-1).body.action, 'end')
})

test('adapter: a model tool call is forwarded to our server with the caller\'s latest words and the result goes back verbatim as function_call_output + response.create; duplicates from response.done are not run twice', async () => {
  const seen = []
  const h = harness({ toolResult: (body) => { seen.push(body); return { status: 200, data: { result: { ok: true, served: true, simulated: true } } } } })
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  h.dc().sent.length = 0
  h.dc().receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'I am in two nine four zero one' })
  h.dc().receive({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'check_service_area', arguments: '{"zip":"29401"}' })
  await settle()
  assert.deepEqual(seen, [{ customer: 'alpha', id: 'conv_1', token: 'tok_1', name: 'check_service_area', input: { zip: '29401' }, userText: 'I am in two nine four zero one' }])
  assert.deepEqual(h.dc().sent.map((m) => m.type), ['conversation.item.create', 'response.create'])
  assert.deepEqual(h.dc().sent[0].item, { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ ok: true, served: true, simulated: true }) })
  h.dc().receive({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', status: 'completed', call_id: 'call_1', name: 'check_service_area', arguments: '{"zip":"29401"}' }], usage: { input_tokens: 1200, output_tokens: 80 } } })
  await settle()
  assert.equal(seen.length, 1, 'response.done fallback does not re-run a handled call')
  // The fallback does run a call that never got its .done event
  h.dc().receive({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', status: 'completed', call_id: 'call_2', name: 'find_available_times', arguments: 'not json' }], usage: { input_tokens: 1300, output_tokens: 90 } } })
  await settle()
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1].input, {}, 'unparseable arguments become an empty object, never a crash')
  const tools = h.events.filter((e) => e.name === 'tool')
  assert.equal(tools.length, 2)
  assert.deepEqual([tools[0].ok, tools[0].simulated, tools[0].tool], [true, true, 'check_service_area'])
  const { metrics } = await h.adapter.stop({ outcome: 'booked' })
  assert.equal(metrics.toolCalls, 2)
  assert.equal(metrics.toolFailures, 0)
  assert.equal(metrics.inputTokens, 2500)
  assert.equal(metrics.outputTokens, 170)
  assert.equal(h.calls.at(-1).body.outcome, 'booked')
})

test('adapter: a failed tool is reported to the model honestly as a failure result and counted; the model is never left waiting', async () => {
  const h = harness({ toolResult: () => ({ status: 429, data: { error: 'rate_limited' } }) })
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  h.dc().sent.length = 0
  h.dc().receive({ type: 'response.function_call_arguments.done', call_id: 'call_9', name: 'book_appointment', arguments: '{}' })
  await settle()
  const out = JSON.parse(h.dc().sent[0].item.output)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'rate_limited')
  assert.equal(h.dc().sent[1].type, 'response.create')
  const ev = h.events.find((e) => e.name === 'tool')
  assert.deepEqual([ev.ok, ev.error], [false, 'rate_limited'])
  assert.equal((await h.adapter.stop()).metrics.toolFailures, 1)
})

test('adapter: transcript lines (caller + receptionist) reach the UI and our server as text; response times and interruptions are measured from VAD events', async () => {
  const h = harness()
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  const dc = h.dc()
  // Turn 1: caller stops at t, first audio at t+640
  dc.receive({ type: 'input_audio_buffer.speech_started' })
  dc.receive({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1200 })
  dc.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Do you service Charleston?' })
  h.tick(640)
  dc.receive({ type: 'response.created', response: { id: 'r1' } })
  dc.receive({ type: 'output_audio_buffer.started', response_id: 'r1' })
  dc.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'Yes, we ' })
  dc.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'service Charleston.' })
  // The caller interrupts while the receptionist is speaking
  dc.receive({ type: 'input_audio_buffer.speech_started' })
  dc.receive({ type: 'output_audio_buffer.cleared', response_id: 'r1' })
  dc.receive({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'Yes, we service Charleston.' })
  dc.receive({ type: 'response.done', response: { status: 'cancelled', output: [], usage: { input_tokens: 10, output_tokens: 5 } } })
  // Turn 2: 1,900 ms
  dc.receive({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 4000 })
  dc.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Tomorrow morning?' })
  h.tick(1900)
  dc.receive({ type: 'response.created', response: { id: 'r2' } })
  dc.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a2', delta: 'We have 10 tomorrow.' })
  dc.receive({ type: 'response.output_audio_transcript.done', item_id: 'a2' })
  dc.receive({ type: 'response.done', response: { status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 6 } } })
  dc.receive({ type: 'error', error: { type: 'invalid_request_error', code: 'bad_thing', message: 'secret details' } })
  const lines = h.events.filter((e) => e.name === 'transcript').map((e) => [e.who, e.text])
  assert.deepEqual(lines, [['customer', 'Do you service Charleston?'], ['receptionist', 'Yes, we service Charleston.'], ['customer', 'Tomorrow morning?'], ['receptionist', 'We have 10 tomorrow.']])
  const err = h.events.find((e) => e.name === 'error')
  assert.deepEqual(err, { name: 'error', code: 'provider_error', detail: 'bad_thing', fatal: false })
  await h.flushTimers()
  const posted = h.calls.filter((c) => c.path === '/api/platform/voice-lab/session' && c.body.action === 'transcript')
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0].body.lines.map((l) => l.who), ['customer', 'receptionist', 'customer', 'receptionist'])
  assert.ok(posted[0].body.lines.every((l) => Number.isFinite(l.at)))
  h.tick(30_000)
  const { metrics } = await h.adapter.stop()
  assert.equal(metrics.firstResponseMs, 640)
  assert.equal(metrics.turns, 2)
  assert.equal(metrics.medianResponseMs, 640)
  assert.equal(metrics.p95ResponseMs, 1900)
  assert.equal(metrics.interruptions, 1)
  assert.equal(metrics.audioSeconds, 33)
  assert.equal(metrics.inputTokens, 30)
  assert.ok(Object.keys(metrics).every((k) => METRIC_KEYS.includes(k)))
  // No conversation text in the metrics or the end call
  assert.ok(!JSON.stringify(h.calls.at(-1).body.metrics).includes('Charleston'))
})

test('adapter: a dropped connection re-mints and reconnects (same config, no second greeting) up to 2 times, then ends the session as connection_lost', async () => {
  const h = harness()
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  const first = h.pc()
  first.drop('failed')
  await settle()
  assert.equal(h.adapter.state, 'connected')
  assert.notEqual(h.pc(), first)
  assert.equal(h.calls.filter((c) => c.path === '/api/platform/voice-lab/openai').length, 2, 're-minted')
  assert.deepEqual(h.dc().sent.map((m) => m.type), ['session.update'], 'config re-sent, greeting not repeated')
  assert.ok(h.events.some((e) => e.name === 'status' && e.state === 'reconnecting' && e.attempt === 1 && e.reason === 'ice_failed'))
  h.pc().drop('failed')
  await settle()
  assert.equal(h.adapter.state, 'connected')
  h.pc().drop('failed')
  await settle()
  assert.equal(h.adapter.state, 'failed')
  assert.equal(h.calls.filter((c) => c.path === '/api/platform/voice-lab/openai').length, 1 + MAX_RECONNECTS)
  const fatal = h.events.find((e) => e.name === 'error' && e.fatal)
  assert.equal(fatal.code, 'connection_lost')
  const end = h.calls.at(-1)
  assert.equal(end.body.action, 'end')
  assert.equal(end.body.outcome, 'connection_lost')
  assert.equal(end.body.metrics.reconnects, 2)
  assert.equal(h.mic.stopped, 1)
})

test('adapter: a transient disconnect that recovers within the grace period does not reconnect; a closed channel does', async () => {
  const h = harness()
  await h.adapter.start({ ...session, onEvent: h.onEvent })
  await settle()
  h.pc().drop('disconnected')
  h.pc().connectionState = 'connected'
  await h.flushTimers()
  await settle()
  assert.equal(h.calls.filter((c) => c.path === '/api/platform/voice-lab/openai').length, 1)
  h.dc().close()
  h.dc().onclose?.()
  await settle()
  assert.equal(h.calls.filter((c) => c.path === '/api/platform/voice-lab/openai').length, 2)
  assert.equal(h.adapter.state, 'connected')
  await h.adapter.stop()
})

test('adapter: provider not configured / mint refused / SDP refused / microphone denied end the session with a code and never leave it open', async () => {
  const a = harness({ mintStatus: 404 })
  await assert.rejects(a.adapter.start({ ...session, onEvent: a.onEvent }), /openai_not_configured/)
  assert.equal(a.adapter.state, 'failed')
  assert.equal(a.calls.at(-1).body.action, 'end')
  assert.equal(a.calls.at(-1).body.outcome, 'connect_failed')
  const b = harness({ sdpOk: false })
  await assert.rejects(b.adapter.start({ ...session, onEvent: b.onEvent }), /secret_rejected/)
  assert.equal(b.adapter.state, 'failed')
  const c = harness()
  const denied = createOpenAIAdapter({ api: c.api, fetch: async () => new Response('x'), RTCPeerConnection: c.rtc.FakePC, getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError') } })
  const ev = []
  await assert.rejects(denied.start({ ...session, onEvent: (n, p) => ev.push({ n, ...p }) }), /mic_denied/)
  assert.ok(ev.some((e) => e.n === 'error' && e.code === 'mic_denied' && e.fatal))
  assert.equal(c.calls.at(-1).body.outcome, 'mic_denied')
  await assert.rejects(createOpenAIAdapter({ api: c.api }).start({ onEvent() {} }), /invalid_session/)
  assert.deepEqual(await createOpenAIAdapter({ api: c.api }).stop(), { summary: null, metrics: { turns: 0, interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0, audioSeconds: 0, inputTokens: 0, outputTokens: 0 } })
})

test('adapter interface: documented event names and metric summary', () => {
  assert.deepEqual(ADAPTER_EVENTS, ['status', 'transcript', 'tool', 'metrics', 'error'])
  assert.deepEqual(summarizeMetrics({ firstResponseMs: 500.4, responseTimes: [900, 500, 1500, 700], interruptions: 1, toolCalls: 2, toolFailures: 1, reconnects: 0, audioSeconds: 61.2, inputTokens: 10, outputTokens: 4 }), { firstResponseMs: 500, medianResponseMs: 700, p95ResponseMs: 1500, turns: 4, interruptions: 1, toolCalls: 2, toolFailures: 1, reconnects: 0, audioSeconds: 61, inputTokens: 10, outputTokens: 4 })
  assert.deepEqual(summarizeMetrics({}), { turns: 0, interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0, inputTokens: 0, outputTokens: 0 })
})
