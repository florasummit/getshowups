// ElevenLabs Conversational AI adapter for the Voice Lab: the server mints short-lived signed URLs with the permanent
// key (never sent to the browser), the overrides carry OUR prompt/greeting and the seven client tools, every gate
// holds, and the browser adapter forwards each agent tool call to our tool route with the caller's latest words.
// Mocked at the network boundary only (ElevenLabs API, Google free/busy); the real engine, D1 schema and routes run.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { COST_ESTIMATES, estimateMicros, providerStatus } from '../server/voice/providers.js'
import { VOICE_TOOL_NAMES } from '../server/voice/tools.js'
import { startLabSession, loadLabSession, endLabSession, cleanMetrics } from '../server/voice/sessions.js'
import { connectElevenLabs, fetchSignedUrl, elevenlabsBase, elevenlabsOverrides, SIGNED_URL_TTL_MS, MAX_CONNECTS_PER_SESSION } from '../server/voice/elevenlabs.js'
import * as connectApi from '../functions/api/platform/voice-lab/elevenlabs.js'
import { createTurnMetrics, ADAPTER_STATES } from '../src/voice/adapter.js'
import { createElevenLabsAdapter, MAX_RECONNECTS } from '../src/voice/elevenlabs.js'

const ORIGIN = 'https://getshowups.com'
const EL = 'http://127.0.0.1:9931'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const EL_KEY = 'el_SECRET_0123456789abcdefghij'
const SECRETS = [EL_KEY, 'sk-openai-SECRET-0123456789abcdef', KEY]

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}

let env, db, kv, fetches, responses, origFetch, origError, logs, signedUrlResponder
const admin = { email: 'staff@getshowups.com' }
const DAY = 864e5

async function seed(id, { test: isTest = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401,29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run pool care.', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), t)
  db.sql.prepare('INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?, 1, ?, ?, ?, ?, 1)').run(id, 'ai_first', 'Thanks for calling alpha Co, how can I help?', null, null)
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
  signedUrlResponder = (init) => {
    assert.equal(init.headers['xi-api-key'], EL_KEY, 'the key goes to ElevenLabs in the xi-api-key header')
    return new Response(JSON.stringify({ signed_url: 'ws://127.0.0.1:9931/v1/convai/conversation?agent_id=agent_abc123&conversation_signature=sig_short_lived' }), { status: 200 })
  }
  env = {
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com', ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test', VOICE_LAB_ENABLED: 'true', OPENAI_API_KEY: SECRETS[1], ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_AGENT_ID: 'agent_abc123', ELEVENLABS_API_MOCK_ORIGIN: EL,
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push([u, init])
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
    if (u === `${EL}/v1/convai/conversation/get-signed-url?agent_id=agent_abc123`) return signedUrlResponder(init)
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

const startEl = async (customer = 'alpha', dryRun = true) => {
  const start = await startLabSession(env, admin, { customer, provider: 'elevenlabs', dryRun })
  assert.equal(start.ok, true, start.error)
  return { ...start.session, s: await loadLabSession(env, customer, start.session.id, start.session.token) }
}

test('cost estimate: ElevenLabs per-minute price is labelled an estimate with its source and date; the Lab prices seconds from it', () => {
  const e = COST_ESTIMATES.elevenlabs
  assert.equal(e.perMinuteMicros, 80_000)
  assert.match(e.source, /^https:\/\/elevenlabs\.io\/pricing/)
  assert.match(e.asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(e.note, /estimate/)
  assert.equal(estimateMicros('elevenlabs', 90), 120_000)
  assert.equal(elevenlabsBase({}), 'https://api.elevenlabs.io')
  assert.equal(elevenlabsBase({ ELEVENLABS_API_MOCK_ORIGIN: 'https://evil.example' }), 'https://api.elevenlabs.io', 'mock origin is loopback-only')
  assert.equal(elevenlabsBase(env), EL)
})

test('connect: a short-lived signed URL for the configured agent, overrides with OUR prompt and greeting, the seven client tools, no secrets', async () => {
  const customer = await seed('alpha')
  const { s } = await startEl()
  const before = Date.now()
  const r = await connectElevenLabs(env, s, before)
  assert.equal(r.ok, true, r.error)
  assert.match(r.signedUrl, /^ws:\/\/127\.0\.0\.1:9931\/v1\/convai\/conversation\?agent_id=agent_abc123&conversation_signature=/)
  assert.equal(r.expiresAt - before, SIGNED_URL_TTL_MS)
  assert.ok(SIGNED_URL_TTL_MS <= 15 * 60_000, 'expiry is the documented 15 minutes or shorter')
  assert.match(r.overrides.agent.prompt.prompt, /alpha Co/)
  assert.match(r.overrides.agent.prompt.prompt, /Yes, we service <place>/)
  assert.equal(r.overrides.agent.firstMessage, 'Thanks for calling alpha Co, how can I help?')
  assert.equal(r.overrides.agent.language, 'en')
  assert.deepEqual(r.clientTools, VOICE_TOOL_NAMES)
  assert.equal(r.clientTools.length, 7)
  assert.deepEqual(r.dynamicVariables, { business_name: 'alpha Co', dry_run: true, channel: 'voice_lab' })
  assert.deepEqual([r.connection, r.connectionsLeft], [1, MAX_CONNECTS_PER_SESSION - 1])
  const text = JSON.stringify(r)
  for (const sec of SECRETS) assert.ok(!text.includes(sec))
  assert.ok(!text.includes('owner@alpha.example'), 'no emails in overrides')
  assert.ok(!Object.keys(r.overrides).includes('tts'), 'voice stays the agent\'s (nothing we override without need)')
  // Only the signed-URL request went to ElevenLabs, with the key in its header and nothing in the URL.
  const el = fetches.filter(([u]) => u.startsWith(EL))
  assert.equal(el.length, 1)
  assert.ok(!el[0][0].includes(EL_KEY))
  // The SDK shape is what elevenlabsOverrides builds; the greeting comes from the business's receptionist settings.
  assert.deepEqual(elevenlabsOverrides({ instructions: 'X', greeting: 'Hi' }), { agent: { prompt: { prompt: 'X' }, firstMessage: 'Hi', language: 'en' } })
  assert.equal(customer.id, 'alpha')
})

test('connect gates: unconfigured → 404 code; wrong provider → 409; ended → 409; a third reconnect → 429 and no signed URL is fetched; a provider failure changes nothing', async () => {
  await seed('alpha')
  const { s } = await startEl()
  assert.deepEqual(await connectElevenLabs({ ...env, ELEVENLABS_AGENT_ID: '' }, s), { ok: false, error: 'elevenlabs_not_configured', httpStatus: 404 })
  assert.equal(providerStatus({ ...env, ELEVENLABS_API_KEY: 'short' }).elevenlabs.reason, 'elevenlabs_not_configured')
  // One Lab call at a time: the open session blocks a second start; a session of another provider is refused here.
  assert.equal((await startLabSession(env, admin, { customer: 'alpha', provider: 'openai' })).error, 'lab_busy')
  const so = { customer: s.customer, conv: { ...s.conv, state: { ...s.conv.state, lab: { ...s.conv.state.lab, provider: 'openai' } } } }
  assert.deepEqual(await connectElevenLabs(env, so), { ok: false, error: 'wrong_provider', httpStatus: 409 })
  // Provider failures: codes only, the session's connection count is untouched.
  signedUrlResponder = () => new Response('{"detail":"nope"}', { status: 401 })
  assert.deepEqual(await connectElevenLabs(env, s), { ok: false, error: 'elevenlabs_auth_failed', httpStatus: 502 })
  signedUrlResponder = () => { throw new Error('ECONNRESET') }
  assert.deepEqual(await connectElevenLabs(env, s), { ok: false, error: 'elevenlabs_unreachable', httpStatus: 502 })
  signedUrlResponder = () => new Response(JSON.stringify({ signed_url: 'wss://evil.example/steal' }), { status: 200 })
  assert.deepEqual(await connectElevenLabs(env, s), { ok: false, error: 'elevenlabs_bad_response', httpStatus: 502 })
  signedUrlResponder = () => new Response('{}', { status: 500 })
  assert.deepEqual(await connectElevenLabs(env, s), { ok: false, error: 'elevenlabs_http_500', httpStatus: 502 })
  assert.equal(s.conv.state.lab.elevenlabs, undefined)
  assert.deepEqual(await fetchSignedUrl({}), { ok: false, error: 'elevenlabs_not_configured', httpStatus: 404 })
  // Connection ceiling: first connect + two reconnects, then refused before any request to ElevenLabs.
  signedUrlResponder = () => new Response(JSON.stringify({ signed_url: 'ws://127.0.0.1:9931/v1/convai/conversation?agent_id=agent_abc123&conversation_signature=s2' }), { status: 200 })
  for (let i = 1; i <= MAX_CONNECTS_PER_SESSION; i++) assert.equal((await connectElevenLabs(env, s)).connection, i)
  const n = fetches.filter(([u]) => u.startsWith(EL)).length
  assert.deepEqual(await connectElevenLabs(env, s), { ok: false, error: 'reconnect_limit', httpStatus: 429 })
  assert.equal(fetches.filter(([u]) => u.startsWith(EL)).length, n)
  const stored = JSON.parse(db.sql.prepare('SELECT state FROM receptionist_conversations WHERE id = ?').get(s.conv.id).state)
  assert.equal(stored.lab.elevenlabs.connects, MAX_CONNECTS_PER_SESSION)
  // Ended sessions never get a new connection (the first session is ended first: one Lab call at a time).
  await endLabSession(env, s, {})
  const two = await startEl()
  await endLabSession(env, two.s, {})
  const reloaded = await loadLabSession(env, 'alpha', two.id, two.token)
  assert.deepEqual(await connectElevenLabs(env, reloaded), { ok: false, error: 'conversation_ended', httpStatus: 409 })
})

test('route: platform admin + same-origin only; 404 when the Lab is off or ElevenLabs is not configured; another business or token → 404; success returns no key', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await sessionCookie('staff@getshowups.com')
  const owner = await sessionCookie('owner@alpha.example')
  const { id, token } = await startEl()
  const body = { customer: 'alpha', id, token }
  assert.equal((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { body })).status, 401)
  assert.equal((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: owner, body })).status, 403)
  assert.equal((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, origin: 'https://evil.example', body })).status, 403)
  env.VOICE_LAB_ENABLED = 'false'
  assert.deepEqual((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, body })).json(), { error: 'not_found' })
  env.VOICE_LAB_ENABLED = 'true'
  const saved = env.ELEVENLABS_API_KEY
  delete env.ELEVENLABS_API_KEY
  const nc = await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, body })
  assert.equal(nc.status, 404)
  assert.deepEqual(nc.json(), { error: 'elevenlabs_not_configured' })
  env.ELEVENLABS_API_KEY = saved
  assert.equal((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, body: { ...body, customer: 'beta' } })).status, 404)
  assert.equal((await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, body: { ...body, token: 'wrong' } })).status, 404)
  assert.equal(fetches.filter(([u]) => u.startsWith(EL)).length, 0, 'no signed URL was minted for a refused request')
  const ok = await call(connectApi, '/api/platform/voice-lab/elevenlabs', { cookie: staff, body })
  assert.equal(ok.status, 200)
  const out = ok.json()
  assert.deepEqual(Object.keys(out).sort(), ['clientTools', 'connection', 'connectionsLeft', 'dynamicVariables', 'expiresAt', 'overrides', 'signedUrl'])
  assert.ok(out.expiresAt > Date.now() && out.expiresAt <= Date.now() + 15 * 60_000)
  assert.equal(out.clientTools.length, 7)
})

test('setup script: dry run writes nothing; --apply creates the seven client tools and the agent with overrides enabled, auth on and our events; re-runs PATCH; duplicates stop it; the key is never printed', async () => {
  const { setupElevenLabsAgent, AGENT_NAME, agentBody, clientToolConfig, CLIENT_EVENTS } = await import('../scripts/elevenlabs-setup.mjs')
  const R = 'http://127.0.0.1:9932'
  let agents = []
  let tools = []
  const writes = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const json = (st, b) => new Response(JSON.stringify(b), { status: st })
    assert.equal(init.headers['xi-api-key'], EL_KEY)
    if (u.startsWith(`${R}/v1/convai/tools?`)) return json(200, { tools, has_more: false })
    if (u.startsWith(`${R}/v1/convai/agents?`)) return json(200, { agents, has_more: false })
    if (u === `${R}/v1/convai/tools` && init.method === 'POST') {
      const b = JSON.parse(init.body)
      writes.push(['create_tool', b])
      const t = { id: `tool_${tools.length + 1}`, tool_config: b.tool_config }
      tools.push(t)
      return json(200, t)
    }
    if (u.startsWith(`${R}/v1/convai/tools/`) && init.method === 'PATCH') {
      const id = decodeURIComponent(u.split('/').at(-1))
      writes.push(['update_tool', JSON.parse(init.body)])
      return json(200, { id, tool_config: JSON.parse(init.body).tool_config })
    }
    if (u === `${R}/v1/convai/agents/create` && init.method === 'POST') {
      const b = JSON.parse(init.body)
      writes.push(['create_agent', b])
      agents.push({ agent_id: 'agent_new1234', name: b.name })
      return json(200, { agent_id: 'agent_new1234' })
    }
    if (u === `${R}/v1/convai/agents/agent_new1234` && init.method === 'PATCH') {
      writes.push(['update_agent', JSON.parse(init.body)])
      return json(200, { agent_id: 'agent_new1234' })
    }
    throw new Error(`unexpected ${init.method} ${u}`)
  }
  const lines = []
  const opts = { apiKey: EL_KEY, base: R, log: (l) => lines.push(l) }
  assert.equal((await setupElevenLabsAgent({ ...opts, apiKey: 'short' })).error, 'elevenlabs_api_key_missing')
  assert.equal((await setupElevenLabsAgent({ ...opts, site: 'http://getshowups.com' })).error, 'invalid_site')
  const dry = await setupElevenLabsAgent({ ...opts, apply: false })
  assert.deepEqual([dry.dryRun, dry.action, dry.tools.length, writes.length], [true, 'create', 7, 0])
  const created = await setupElevenLabsAgent({ ...opts, apply: true, voiceId: 'voice_abc123' })
  assert.deepEqual([created.action, created.agentId, created.toolIds.length], ['created', 'agent_new1234', 7])
  assert.deepEqual(writes.map((w) => w[0]), [...Array(7).fill('create_tool'), 'create_agent'])
  const toolBodies = writes.filter((w) => w[0] === 'create_tool').map((w) => w[1].tool_config)
  assert.deepEqual(toolBodies.map((t) => t.name), VOICE_TOOL_NAMES)
  assert.ok(toolBodies.every((t) => t.type === 'client' && t.expects_response === true && t.parameters.type === 'object' && !('additionalProperties' in t.parameters)))
  const find = toolBodies.find((t) => t.name === 'find_available_times')
  assert.deepEqual(find.parameters.properties.part_of_day.enum, ['any', 'morning', 'afternoon', 'evening'])
  assert.deepEqual(find.parameters.required, ['date', 'part_of_day'])
  assert.equal(toolBodies.find((t) => t.name === 'request_callback').parameters.properties.urgent.type, 'boolean')
  const agent = writes.at(-1)[1]
  assert.equal(agent.name, AGENT_NAME)
  assert.deepEqual(agent.conversation_config.agent.prompt.tool_ids, created.toolIds)
  assert.deepEqual(agent.platform_settings.overrides.conversation_config_override, { agent: { prompt: { prompt: true }, first_message: true, language: true } })
  assert.deepEqual(agent.platform_settings.auth, { enable_auth: true, allowlist: [{ hostname: 'getshowups.com' }] })
  assert.ok(agent.conversation_config.conversation.client_events.includes('client_tool_call') && agent.conversation_config.conversation.client_events.includes('user_transcript'))
  assert.deepEqual(agent.conversation_config.conversation.client_events, CLIENT_EVENTS)
  assert.equal(agent.conversation_config.conversation.max_duration_seconds, 900)
  assert.equal(agent.conversation_config.tts.voice_id, 'voice_abc123')
  assert.match(agent.conversation_config.agent.prompt.prompt, /placeholder/i)
  assert.ok(!/alpha Co|Charleston/.test(JSON.stringify(agent)), 'no business facts live on the ElevenLabs side')
  // Second run: everything exists → PATCH only, same shapes.
  const updated = await setupElevenLabsAgent({ ...opts, apply: true })
  assert.equal(updated.action, 'updated')
  assert.deepEqual(writes.slice(8).map((w) => w[0]), [...Array(7).fill('update_tool'), 'update_agent'])
  assert.equal(writes.at(-1)[1].conversation_config.tts, undefined)
  assert.deepEqual(agentBody({ name: 'n', hostname: 'h', toolIds: ['t'], voiceId: '', llm: 'gpt-4o-mini' }).conversation_config.agent.prompt.llm, 'gpt-4o-mini')
  assert.equal(clientToolConfig({ name: 'x', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string', description: 'A' } }, required: ['a'] } }).parameters.properties.a.description, 'A')
  agents.push({ agent_id: 'agent_dupe', name: AGENT_NAME })
  assert.equal((await setupElevenLabsAgent({ ...opts, apply: true })).error, 'duplicate_agents')
  agents.pop()
  tools.push({ id: 'tool_dupe', tool_config: { type: 'client', name: 'book_appointment' } })
  assert.equal((await setupElevenLabsAgent({ ...opts, apply: true })).error, 'duplicate_tools')
  assert.ok(!lines.join('\n').includes(EL_KEY))
  assert.ok(!JSON.stringify(writes).includes(EL_KEY))
})

test('turn metrics: first/median/p95 response from end of user speech to first agent audio, interruptions, tools, reconnects; every key is one the server keeps', () => {
  let t = 1000
  const m = createTurnMetrics(() => t)
  assert.deepEqual(m.snapshot(), { turns: 0, interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0 })
  m.agentStarted() // the greeting: no user turn pending, not counted
  for (const ms of [800, 1200, 400, 3000]) {
    m.userFinished()
    t += ms
    m.agentStarted()
  }
  m.agentStarted() // a second 'speaking' flip without a new user turn is ignored
  m.interrupted()
  m.tool(true)
  m.tool(false)
  m.reconnected()
  const s = m.snapshot()
  assert.deepEqual(s, { turns: 4, interruptions: 1, toolCalls: 2, toolFailures: 1, reconnects: 1, firstResponseMs: 800, medianResponseMs: 800, p95ResponseMs: 3000 })
  assert.deepEqual(cleanMetrics(s), s, 'the server keeps every metric the adapter reports')
  assert.deepEqual(ADAPTER_STATES, ['idle', 'connecting', 'connected', 'reconnecting', 'stopping', 'stopped', 'failed'])
})

// A fake @elevenlabs/client: captures startSession options and lets the test drive the SDK callbacks.
function fakeSdk() {
  const sessions = []
  return {
    sessions,
    load: async () => ({
      Conversation: {
        startSession: async (opts) => {
          if (opts.signedUrl.includes('fail')) throw new Error('socket refused')
          const sess = { opts, ended: false, endSession: async () => { sess.ended = true; opts.onDisconnect({ reason: 'user' }) } }
          sessions.push(sess)
          queueMicrotask(() => opts.onConnect({ conversationId: 'conv_el_1' }))
          return sess
        },
      },
    }),
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

test('browser adapter: signed URL + overrides from our route, client tools forwarded to our tool route with the latest user words, transcripts posted, metrics measured, reconnects limited', async () => {
  const sdk = fakeSdk()
  const posts = []
  let signedUrls = 0
  let toolStatus = 200
  const post = async (path, { body }) => {
    posts.push([path, body])
    if (path === '/api/platform/voice-lab/elevenlabs') {
      signedUrls++
      return { status: 200, data: { signedUrl: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_abc123&conversation_signature=s${signedUrls}`, expiresAt: Date.now() + 60_000, overrides: { agent: { prompt: { prompt: 'OUR PROMPT' }, firstMessage: 'Hi', language: 'en' } }, dynamicVariables: { business_name: 'alpha Co' }, clientTools: VOICE_TOOL_NAMES } }
    }
    if (path === '/api/platform/voice-lab/tool') return toolStatus === 200 ? { status: 200, data: { result: { ok: true, served: true, simulated: true } } } : { status: toolStatus, data: { error: 'not_found' } }
    if (path === '/api/platform/voice-lab/session') return { status: 200, data: { ok: true, added: body.lines.length } }
    throw new Error(path)
  }
  let t = 10_000
  const events = []
  const adapter = createElevenLabsAdapter({ sdk: sdk.load, post, now: () => t })
  assert.equal(adapter.state, 'idle')
  await adapter.start({ customer: 'alpha', id: 'conv1', token: 'tok1', onEvent: (type, payload) => events.push({ type, ...payload }) })
  await tick()
  assert.equal(adapter.state, 'connected')
  const opts = sdk.sessions[0].opts
  assert.equal(opts.connectionType, 'websocket')
  assert.match(opts.signedUrl, /conversation_signature=s1$/)
  assert.equal(opts.overrides.agent.prompt.prompt, 'OUR PROMPT')
  assert.deepEqual(Object.keys(opts.clientTools), VOICE_TOOL_NAMES)
  assert.equal(posts[0][0], '/api/platform/voice-lab/elevenlabs')
  assert.deepEqual(posts[0][1], { customer: 'alpha', id: 'conv1', token: 'tok1' })
  // The caller speaks, the agent calls a tool: our tool route gets the session + the caller's latest words.
  opts.onMessage({ message: 'I am in two nine four zero one', role: 'user', source: 'user', event_id: 1 })
  t += 650
  opts.onModeChange({ mode: 'speaking' })
  const result = await opts.clientTools.check_service_area({ zip: '29401' })
  assert.deepEqual(result, { ok: true, served: true, simulated: true })
  const toolPost = posts.find(([p]) => p === '/api/platform/voice-lab/tool')
  assert.deepEqual(toolPost[1], { customer: 'alpha', id: 'conv1', token: 'tok1', name: 'check_service_area', input: { zip: '29401' }, userText: 'I am in two nine four zero one' })
  opts.onMessage({ message: 'Yes, we service 29401.', role: 'agent', source: 'ai', event_id: 2 })
  opts.onModeChange({ mode: 'listening' })
  opts.onInterruption({ event_id: 3 })
  // A refused tool call is answered honestly, never thrown (a throw would become an SDK error string read aloud).
  toolStatus = 404
  const refused = await opts.clientTools.book_appointment({ slot_id: 'x', confirmation_quote: 'yes' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'not_found')
  toolStatus = 200
  const m = adapter.metrics()
  assert.deepEqual([m.firstResponseMs, m.turns, m.interruptions, m.toolCalls, m.toolFailures], [650, 1, 1, 2, 1])
  assert.deepEqual(events.filter((e) => e.type === 'transcript').map((e) => [e.who, e.text]), [['customer', 'I am in two nine four zero one'], ['receptionist', 'Yes, we service 29401.']])
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => [e.name, e.ok, e.simulated]), [['check_service_area', true, true], ['book_appointment', false, false]])
  // Transcript lines are batched to the session route.
  await new Promise((r) => setTimeout(r, 900))
  const tr = posts.filter(([p, b]) => p === '/api/platform/voice-lab/session' && b.action === 'transcript')
  assert.equal(tr.length, 1)
  assert.deepEqual(tr[0][1].lines.map((l) => l.who), ['customer', 'receptionist'])
  // A dropped connection reconnects with a FRESH signed URL, at most twice; the third drop ends in error.
  opts.onDisconnect({ reason: 'error', message: 'socket closed', context: { type: 'close' } })
  await tick()
  await tick()
  assert.equal(sdk.sessions.length, 2)
  assert.match(sdk.sessions[1].opts.signedUrl, /s2$/)
  assert.equal(adapter.state, 'connected')
  sdk.sessions[1].opts.onDisconnect({ reason: 'error', message: 'x', context: { type: 'close' } })
  await tick()
  await tick()
  assert.equal(sdk.sessions.length, 3)
  assert.equal(adapter.metrics().reconnects, MAX_RECONNECTS)
  sdk.sessions[2].opts.onDisconnect({ reason: 'error', message: 'x', context: { type: 'close' } })
  await tick()
  await tick()
  assert.equal(adapter.state, 'failed')
  assert.equal(sdk.sessions.length, 3, 'no fourth connection')
  assert.deepEqual(events.filter((e) => e.type === 'error').map((e) => e.code), ['disconnected'])
  assert.equal(events.filter((e) => e.type === 'status' && e.state === 'reconnecting').length, 2)
  assert.equal(events.at(-1).type, 'status')
  // Credentials: the adapter never saw a key, only signed URLs and session tokens.
  assert.ok(!JSON.stringify(posts).includes(EL_KEY))
})

test('browser adapter: a refused connection ends in a coded error; stop() ends the SDK session and reports ended with final metrics', async () => {
  const sdk = fakeSdk()
  const events = []
  const refusing = createElevenLabsAdapter({ sdk: sdk.load, post: async () => ({ status: 404, data: { error: 'elevenlabs_not_configured' } }) })
  await refusing.start({ customer: 'alpha', id: 'c', token: 't', onEvent: (type, payload) => events.push({ type, ...payload }) })
  assert.equal(refusing.state, 'failed')
  assert.deepEqual(events.filter((e) => e.type === 'error'), [{ type: 'error', code: 'elevenlabs_not_configured', fatal: true }])
  assert.equal(sdk.sessions.length, 0)
  const sdkFail = fakeSdk()
  const failing = createElevenLabsAdapter({ sdk: sdkFail.load, post: async () => ({ status: 200, data: { signedUrl: 'wss://api.elevenlabs.io/fail', overrides: {}, clientTools: [] } }) })
  const ev2 = []
  await failing.start({ customer: 'alpha', id: 'c', token: 't', onEvent: (type, payload) => ev2.push({ type, ...payload }) })
  assert.equal(failing.state, 'failed')
  assert.equal(ev2.find((e) => e.type === 'error').code, 'connect_failed')
  const good = fakeSdk()
  const ev3 = []
  const adapter = createElevenLabsAdapter({ sdk: good.load, post: async (path) => (path === '/api/platform/voice-lab/elevenlabs' ? { status: 200, data: { signedUrl: 'wss://api.elevenlabs.io/ok', overrides: {}, clientTools: VOICE_TOOL_NAMES } } : { status: 200, data: { ok: true } }) })
  await adapter.start({ customer: 'alpha', id: 'c', token: 't', onEvent: (type, payload) => ev3.push({ type, ...payload }) })
  await tick()
  assert.equal(adapter.state, 'connected')
  await adapter.stop({ outcome: 'booked' })
  assert.equal(good.sessions[0].ended, true)
  assert.equal(adapter.state, 'stopped')
  assert.deepEqual(ev3.at(-1), { type: 'status', state: 'stopped', reason: 'stopped', reconnects: 0, outcome: 'booked' })
  assert.equal(ev3.at(-2).type, 'metrics')
  await adapter.stop() // idempotent
  assert.equal(adapter.state, 'stopped')
})
