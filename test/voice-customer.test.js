// Customer-facing voice sessions on every provider (server/voice/customer.js + functions/api/receptionist/[customer]/
// voice*, PR #117): the provider is decided server-side from the business's setting (the browser cannot choose), each
// provider gets its own connection payload, sessions are pinned to the provider they started with, tools run through
// our server bound to the session's business (real bookings for customers, dry run for admin tests), limits bound
// sessions, lifecycle is recorded, evidence of a verified test unlocks activation, and no fallback ever happens.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { providerEvidence, customerVoiceStatus, businessMinutesToday, providerMinutesToday, voiceSessionHistory, MAX_CONNECTS, VOICE_SESSION_MAX_MS } from '../server/voice/customer.js'
import { checkProviderSwitch, getVoiceSettings, providerOverview, rollbackProvider, switchProvider } from '../server/voice/settings.js'
import { providerVerification } from '../server/voice/global.js'
import { labMinutesToday, cleanDisconnect } from '../server/voice/sessions.js'
import * as voiceApi from '../functions/api/receptionist/[customer]/voice.js'
import * as connectApi from '../functions/api/receptionist/[customer]/voice-connect.js'
import * as toolApi from '../functions/api/receptionist/[customer]/voice-tool.js'
import * as sessionApi from '../functions/api/receptionist/[customer]/voice-session.js'
import * as infoApi from '../functions/api/receptionist/[customer]/index.js'
import * as chatApi from '../functions/api/receptionist/[customer]/chat.js'

const ORIGIN = 'https://getshowups.com'
const RETELL = 'http://127.0.0.1:9951'
const EL = 'http://127.0.0.1:9952'
const OPENAI = 'https://api.openai.com'
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
let env, db, kv, fetches, origFetch, responses, busy
beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  busy = []
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
    RECEPTIONIST_VOICE_BUSINESSES: 'alpha',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === `${RETELL}/list-voices`) return json(200, [{ voice_id: 'retell-Cimo', voice_name: 'Cimo', provider: 'elevenlabs', gender: 'male' }, { voice_id: '11labs-Adrian', voice_name: 'Adrian', provider: 'elevenlabs', gender: 'male' }])
    if (u === `${RETELL}/v3/create-web-call`) return json(201, { call_id: `call_${fetches.length}abcdef`, access_token: 'web_access_token', transport: 'gateway', ice_servers: [] })
    if (u.startsWith(`${EL}/v2/voices`)) return json(200, { voices: [{ voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', labels: { gender: 'male' }, preview_url: 'https://x.example/eric.mp3' }], has_more: false })
    if (u.startsWith(`${EL}/v1/convai/conversation/get-signed-url`)) return json(200, { signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_el0123456789&conversation_signature=sig${fetches.length}` })
    if (u === `${OPENAI}/v1/realtime/client_secrets`) {
      const body = JSON.parse(init.body)
      return json(200, { value: `ek_short_${fetches.length}`, expires_at: Math.floor(Date.now() / 1000) + 170, session: body.session })
    }
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy } } })
    if (u.includes('/events?sendUpdates=all')) return json(200, { id: JSON.parse(init.body).id })
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
  for (const r of responses) for (const s of SECRETS) assert.ok(!r.includes(s), 'a secret reached a response')
})

async function seed(id, { on = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401,29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run.', ?, ?, ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), JSON.stringify(['Charleston']), t)
  if (on) db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES (?, 1, 'ai_first', ?, ?)").run(id, `Thanks for calling ${id} Co!`, t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
const cust = async (id) => customerFromRow(await getCustomer(db, id))
const setProvider = (id, provider, voiceId = null, voiceName = null) => db.sql.prepare("INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, version, updated_by, updated_at) VALUES (?, ?, ?, ?, 'standard', 'normal', 'en', 1, 'ref:x', 1) ON CONFLICT(customer) DO UPDATE SET provider = excluded.provider, voice_id = excluded.voice_id, voice_name = excluded.voice_name, version = version + 1").run(id, provider, voiceId, voiceName)
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
let ipN = 0
async function call(mod, method, path, { cookie, origin = ORIGIN, body, params } = {}) {
  const h = { 'CF-Connecting-IP': `203.0.113.${(ipN++ % 200) + 1}` } // per-IP limits are not what these tests measure
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}
const start = (id, body = {}, cookie) => call(voiceApi, 'POST', `/api/receptionist/${id}/voice`, { params: { customer: id }, body, cookie })
const connect = (id, s) => call(connectApi, 'POST', `/api/receptionist/${id}/voice-connect`, { params: { customer: id }, body: { id: s.conversationId, token: s.token } })
const tool = (id, s, name, input, userText = '') => call(toolApi, 'POST', `/api/receptionist/${id}/voice-tool`, { params: { customer: id }, body: { id: s.conversationId, token: s.token, name, input, userText } })
const sess = (id, s, body) => call(sessionApi, 'POST', `/api/receptionist/${id}/voice-session`, { params: { customer: id }, body: { id: s.conversationId, token: s.token, ...body } })
const details = (d) => ({ name: '', phone: '', email: '', zip: '', street: '', city: '', state: '', need: '', ...d })
const state = (convId) => JSON.parse(db.sql.prepare('SELECT state FROM receptionist_conversations WHERE id = ?').get(convId).state)
const markTest = (id) => db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'staff', 1)").run(id)
const admin = { email: 'staff@getshowups.com' }

test('the provider is chosen server-side: Retell by default with the same payload as before; a business activated on OpenAI gets a short-lived client secret with OUR instructions, tools and voice; on ElevenLabs a signed URL with OUR overrides, greeting variable and client tools; the browser cannot pick a provider; no secret reaches the browser', async () => {
  await seed('alpha')
  const r0 = await start('alpha', { provider: 'elevenlabs', test: undefined })
  assert.equal(r0.status, 200)
  const d0 = r0.json()
  assert.deepEqual([d0.provider, typeof d0.accessToken, typeof d0.callId, typeof d0.conversationId, typeof d0.token], ['retell', 'string', 'string', 'string', 'string'], 'Retell, whatever the browser says')
  assert.equal(JSON.parse(fetches.find((f) => f.url.endsWith('/v3/create-web-call')).init.body).agent_override, undefined, 'no row = the same call as before')
  assert.equal(state(d0.conversationId).voice.provider, 'retell')
  setProvider('alpha', 'openai', 'cedar', 'Cedar')
  const r1 = await start('alpha')
  assert.equal(r1.status, 200, JSON.stringify(r1.json()))
  const d1 = r1.json()
  assert.deepEqual([d1.provider, d1.clientSecret.startsWith('ek_'), d1.greeting, d1.sessionConfig.audio.output.voice, d1.sessionConfig.tools.length], ['openai', true, 'Thanks for calling alpha Co!', 'cedar', 7])
  assert.match(d1.sessionConfig.instructions, /alpha Co/)
  assert.ok(!('clientSecret' in d0))
  const minted = JSON.parse(fetches.find((f) => f.url.endsWith('/client_secrets')).init.body)
  assert.equal(minted.session.audio.output.voice, 'cedar')
  const row = db.sql.prepare("SELECT * FROM receptionist_calls WHERE conversation_id = ? AND provider = 'openai'").get(d1.conversationId)
  assert.ok(row.call_id.startsWith('web_') && row.ended_at === null)
  assert.equal(state(d1.conversationId).voice.connects, 1)
  setProvider('alpha', 'elevenlabs', 'cjVigY5qzO86Huf0OWal', 'Eric')
  const r2 = await start('alpha')
  assert.equal(r2.status, 200, JSON.stringify(r2.json()))
  const d2 = r2.json()
  assert.deepEqual([d2.provider, d2.signedUrl.startsWith('wss://'), d2.clientTools.length, d2.dynamicVariables.greeting, d2.dynamicVariables.dry_run, d2.overrides.tts], ['elevenlabs', true, 7, 'Thanks for calling alpha Co!', false, { voiceId: 'cjVigY5qzO86Huf0OWal' }])
  assert.match(d2.overrides.agent.prompt.prompt, /alpha Co/)
  assert.equal(d2.overrides.agent.firstMessage, undefined)
  // Lab accounting never counts customer sessions.
  assert.equal(await labMinutesToday(env), 0)
  assert.ok((await businessMinutesToday(env, 'alpha')) >= 0)
})

test('no fallback, clear errors, bounded: an unconfigured or switched-off active provider refuses (the customer can keep typing), the Retell release gate still applies to customers, concurrency and daily minutes are capped per business and per provider', async () => {
  await seed('alpha')
  await seed('beta')
  setProvider('alpha', 'openai')
  assert.deepEqual([(await start('alpha', {}, undefined)).status, (await start('alpha')).json().provider], [200, 'openai'])
  env.OPENAI_API_KEY = ''
  let r = await start('alpha')
  assert.deepEqual([r.status, r.json().error], [503, 'voice_not_configured'], 'never silently Retell instead')
  assert.equal(fetches.filter((f) => f.url.endsWith('/v3/create-web-call')).length, 0)
  env.OPENAI_API_KEY = SECRETS[2]
  env.VOICE_PROVIDERS_DISABLED = 'openai'
  r = await start('alpha')
  assert.deepEqual([r.status, r.json().error], [503, 'voice_unavailable'])
  delete env.VOICE_PROVIDERS_DISABLED
  assert.deepEqual((await start('beta')).json().error, 'voice_not_available', 'Retell for a business not released')
  // Concurrency: 3 open sessions, the 4th waits.
  env.RECEPTIONIST_VOICE_CONCURRENT = '3'
  assert.equal((await start('alpha')).status, 200)
  r = await start('alpha')
  assert.deepEqual([r.status, r.json().error], [429, 'voice_busy'])
  // Daily minutes per business: an old long session today uses up the budget.
  env.RECEPTIONIST_VOICE_DAILY_MINUTES = '10'
  db.sql.prepare("UPDATE receptionist_calls SET ended_at = created_at + 11 * 60000 WHERE customer = 'alpha'").run()
  r = await start('alpha')
  assert.deepEqual([r.status, r.json().error], [429, 'voice_limit'])
  delete env.RECEPTIONIST_VOICE_DAILY_MINUTES
  db.sql.prepare("UPDATE receptionist_calls SET ended_at = created_at + 1000 WHERE customer = 'alpha'").run()
  env.VOICE_PROVIDER_DAILY_MINUTES = '1'
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES ('web_old', 'beta', 'c_old', 'openai', ?, ?)").run(Date.now() - 5 * 60000, Date.now() - 60000)
  r = await start('alpha')
  assert.deepEqual([r.status, r.json().error], [429, 'voice_limit'], 'platform-wide ceiling per provider')
})

test('admin test sessions on the customer path: only a signed-in platform admin on an admin-marked test business, dry-run tools, the Retell release gate and the receptionist on/off switch do not apply; everyone else is refused', async () => {
  await seed('alpha', { on: false })
  await seed('beta')
  assert.deepEqual((await start('alpha', { test: { provider: 'openai' } })).json().error, 'test_not_allowed', 'anonymous')
  assert.deepEqual((await start('alpha', { test: { provider: 'openai' } }, await session('owner@alpha.example'))).json().error, 'test_not_allowed', 'owner')
  const staff = await session('staff@getshowups.com')
  assert.deepEqual((await start('alpha', { test: { provider: 'openai' } }, staff)).json().error, 'not_test_business', 'admin, not a test business')
  markTest('alpha')
  assert.deepEqual((await start('alpha', { test: { provider: 'nope' } }, staff)).json().error, 'invalid_provider')
  assert.deepEqual((await start('alpha', { test: { provider: 'elevenlabs', voiceId: 'unknownVoice' } }, staff)).json().error, 'voice_unknown')
  const r = await start('alpha', { test: { provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal' } }, staff)
  assert.equal(r.status, 200, JSON.stringify(r.json()))
  const d = r.json()
  assert.deepEqual([d.provider, d.test, d.dynamicVariables.dry_run, d.overrides.tts], ['elevenlabs', true, true, { voiceId: 'cjVigY5qzO86Huf0OWal' }])
  assert.equal(state(d.conversationId).voice.test, true)
  assert.match(state(d.conversationId).voice.by, /^ref:/)
  // Customers of this business (receptionist off) still get nothing.
  assert.deepEqual((await start('alpha')).json().error, 'receptionist_off')
  // Retell test for a business NOT in the release list.
  markTest('beta')
  env.RECEPTIONIST_VOICE_BUSINESSES = ''
  assert.deepEqual((await start('beta')).json().error, 'voice_not_available')
  const rb = (await start('beta', { test: { provider: 'retell' } }, staff)).json()
  assert.equal(rb.provider, 'retell', JSON.stringify(rb))
})

test('sessions are pinned: a session started on OpenAI reconnects on OpenAI after the business is switched to ElevenLabs (bounded reconnects), while a NEW session takes the new provider; another business’s token never reaches the session', async () => {
  await seed('alpha')
  await seed('beta')
  env.RECEPTIONIST_VOICE_CONCURRENT = '10' // several sessions stay open in this test on purpose
  setProvider('alpha', 'openai')
  const s = (await start('alpha')).json()
  setProvider('alpha', 'elevenlabs')
  const c1 = await connect('alpha', s)
  assert.deepEqual([c1.status, c1.json().provider, typeof c1.json().clientSecret, c1.json().connectionsLeft], [200, 'openai', 'string', MAX_CONNECTS - 2])
  const c2 = await connect('alpha', s)
  assert.equal(c2.json().connectionsLeft, 0)
  assert.deepEqual([(await connect('alpha', s)).status, (await connect('alpha', s)).json().error], [429, 'reconnect_limit'])
  assert.equal((await start('alpha')).json().provider, 'elevenlabs', 'new sessions use the new provider')
  const wrong = await call(connectApi, 'POST', '/api/receptionist/beta/voice-connect', { params: { customer: 'beta' }, body: { id: s.conversationId, token: s.token } })
  assert.equal(wrong.status, 404)
  assert.equal((await call(connectApi, 'POST', '/api/receptionist/alpha/voice-connect', { params: { customer: 'alpha' }, body: { id: s.conversationId, token: 'wrong' } })).status, 404)
  // A Retell session cannot "reconnect" through this route (Retell's socket handles it); while it runs, the same
  // conversation cannot start a second one; once Retell's socket ended it (receptionist_calls.ended_at), "Talk again"
  // works and the earlier session counts as finished.
  setProvider('alpha', 'retell')
  const rs = (await start('alpha')).json()
  assert.equal((await connect('alpha', rs)).json().error, 'wrong_provider')
  assert.equal((await start('alpha', { conversationId: rs.conversationId, token: rs.token })).json().error, 'voice_in_progress')
  db.sql.prepare('UPDATE receptionist_calls SET ended_at = ?1 WHERE conversation_id = ?2').run(Date.now(), rs.conversationId)
  const again = (await start('alpha', { conversationId: rs.conversationId, token: rs.token })).json()
  assert.deepEqual([again.provider, again.conversationId], ['retell', rs.conversationId])
})

test('tools run on our server bound to the session’s business: a customer session on OpenAI books for REAL through every guard (one appointment, one Google event, a repeat is refused); an admin test session only simulates; the transcript is kept; ending records metrics and frees the line but leaves the conversation open for typing', async () => {
  await seed('alpha')
  await seed('beta')
  setProvider('alpha', 'openai')
  const s = (await start('alpha')).json()
  assert.equal((await tool('alpha', s, 'nope', {})).status, 400)
  assert.equal((await call(toolApi, 'POST', '/api/receptionist/beta/voice-tool', { params: { customer: 'beta' }, body: { id: s.conversationId, token: s.token, name: 'check_service_area', input: { zip: '29401', place: '' } } })).status, 404, 'alpha’s session is not reachable as beta')
  const area = (await tool('alpha', s, 'check_service_area', { zip: '29401', place: '' }, 'my zip is two nine four zero one')).json().result
  assert.equal(area.served, true)
  const saved = (await tool('alpha', s, 'save_customer_details', details({ name: 'Pat Lee', phone: '843-555-0142', zip: '29401', need: 'Weekly pool care' }), 'Pat Lee, 843-555-0142, 29401')).json().result
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const times = (await tool('alpha', s, 'find_available_times', { date: '', part_of_day: 'any' }, 'what do you have')).json().result
  assert.ok(times.options?.length > 0)
  const booked = (await tool('alpha', s, 'book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes please book it' }, 'yes please book it')).json().result
  assert.deepEqual([booked.ok, booked.booked, booked.simulated], [true, true, undefined], JSON.stringify(booked))
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = 'alpha'").get().n, 1, 'a real appointment')
  assert.equal(fetches.filter((f) => f.url.includes('/events?sendUpdates=all')).length, 1, 'one Google event')
  const again = (await tool('alpha', s, 'book_appointment', { slot_id: times.options[0].slot_id, confirmation_quote: 'yes please book it' }, 'yes please book it')).json().result
  assert.ok(again.ok === false || again.already_booked === true, `a repeated booking call never books twice: ${JSON.stringify(again)}`)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = 'alpha'").get().n, 1)
  // Transcript + end.
  assert.equal((await sess('alpha', s, { action: 'transcript', lines: [{ who: 'customer', text: 'Hi there', at: Date.now() }, { who: 'receptionist', text: 'Thanks for calling alpha Co!', at: Date.now() }] })).json().added, 2)
  const end = await sess('alpha', s, { action: 'end', metrics: { firstResponseMs: 900, turns: 3, micLive: 1, audioReceived: 1, audioSeconds: 42, secret: 'nope' }, outcome: 'ended' })
  assert.equal(end.status, 200)
  const v = end.json().voice
  assert.deepEqual([v.provider, v.metrics.micLive, v.metrics.audioReceived, v.metrics.firstResponseMs, 'secret' in v.metrics, v.outcome, 'estimatedMicros' in v], ['openai', 1, 1, 900, false, 'ended', true])
  assert.ok(db.sql.prepare('SELECT ended_at FROM receptionist_calls WHERE conversation_id = ?').get(s.conversationId).ended_at > 0)
  const st = state(s.conversationId)
  assert.equal(st.endedAt, undefined, 'the conversation stays open: the customer can keep typing')
  assert.ok(st.log.some((l) => l.text === 'Hi there'))
  assert.ok(st.tools.some((t) => t.name === 'book_appointment' && t.ok))
  assert.deepEqual((await sess('alpha', s, { action: 'end', metrics: {} })).json().already, true)
  assert.equal((await tool('alpha', s, 'check_service_area', { zip: '29401', place: '' })).json().result.error, 'conversation_ended', 'no tools after the voice part ended')
  // The chat continues in the same conversation (text path) — nothing about the voice session blocks it.
  // (The chat route needs the model; only the authorization of the same token is exercised here.)
  assert.notEqual((await call(chatApi, 'POST', '/api/receptionist/alpha/chat', { params: { customer: 'alpha' }, body: { text: 'thanks', conversationId: s.conversationId, token: s.token } })).status, 404)
  // Admin test session: the same tools, simulated.
  markTest('alpha')
  const staff = await session('staff@getshowups.com')
  const t = (await start('alpha', { test: { provider: 'elevenlabs' } }, staff)).json()
  await tool('alpha', t, 'save_customer_details', details({ name: 'Test Caller', phone: '843-555-0199', zip: '29403', need: 'Weekly pool care' }), 'Test Caller 843-555-0199 29403')
  const tt = (await tool('alpha', t, 'find_available_times', { date: '', part_of_day: 'any' }, 'times')).json().result
  const tb = (await tool('alpha', t, 'book_appointment', { slot_id: tt.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')).json().result
  assert.deepEqual([tb.ok, tb.booked, tb.simulated], [true, true, true])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = 'alpha'").get().n, 1, 'nothing new was booked by the test')
})

test('readiness is evidence-based and activation follows it: OpenAI is “needs a test” until a finished session on this business shows audio both ways and the booking tools; then the checklist passes, Activate switches new sessions to OpenAI (customers’ voice becomes available even outside the Retell release list), existing sessions stay pinned, rollback returns to Retell; every step audited', async () => {
  await seed('alpha')
  markTest('alpha')
  const alpha = await cust('alpha')
  const staff = await session('staff@getshowups.com')
  env.RECEPTIONIST_VOICE_BUSINESSES = ''
  let ov = await providerOverview(env, alpha)
  assert.deepEqual(ov.providers.map((p) => [p.id, p.state, p.customerPath, p.testUrl]), [
    ['retell', 'active', true, '/chat/alpha?test=retell'],
    ['openai', 'needs_test', true, '/chat/alpha?test=openai'],
    ['elevenlabs', 'needs_test', true, '/chat/alpha?test=elevenlabs'],
  ])
  assert.ok((await checkProviderSwitch(env, alpha, { provider: 'openai', useDefaultVoice: true })).blockers.includes('test_session_required'))
  // A test session with tools but no audio evidence is not enough.
  const t1 = (await start('alpha', { test: { provider: 'openai' } }, staff)).json()
  await tool('alpha', t1, 'save_customer_details', details({ name: 'Test Caller', phone: '843-555-0199', zip: '29403', need: 'Weekly pool care' }), 'Test Caller 843-555-0199 29403')
  const tt = (await tool('alpha', t1, 'find_available_times', { date: '', part_of_day: 'any' }, 'times')).json().result
  await tool('alpha', t1, 'book_appointment', { slot_id: tt.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')
  await sess('alpha', t1, { action: 'end', metrics: { micLive: 0, audioReceived: 1 } })
  let ev = await providerEvidence(env, 'alpha', 'openai')
  assert.deepEqual([ev.ok, ev.sessions, ev.tools, ev.audio, ev.missing], [false, 1, true, false, ['audio']])
  // A second test session with audio both ways and the tools: verified.
  const t2 = (await start('alpha', { test: { provider: 'openai' } }, staff)).json()
  await tool('alpha', t2, 'save_customer_details', details({ name: 'Test Caller', phone: '843-555-0199', zip: '29403', need: 'Weekly pool care' }), 'Test Caller 843-555-0199 29403')
  const tt2 = (await tool('alpha', t2, 'find_available_times', { date: '', part_of_day: 'any' }, 'times')).json().result
  await tool('alpha', t2, 'book_appointment', { slot_id: tt2.options[0].slot_id, confirmation_quote: 'yes book it' }, 'yes book it')
  await sess('alpha', t2, { action: 'end', metrics: { micLive: 1, audioReceived: 1, firstResponseMs: 800 } })
  ev = await providerEvidence(env, 'alpha', 'openai')
  assert.deepEqual([ev.ok, ev.sessions, ev.missing], [true, 2, []])
  ov = await providerOverview(env, alpha)
  assert.equal(ov.providers.find((p) => p.id === 'openai').state, 'ready')
  assert.equal(ov.providers.find((p) => p.id === 'elevenlabs').state, 'needs_test')
  const check = await checkProviderSwitch(env, alpha, { provider: 'openai', useDefaultVoice: true })
  assert.deepEqual([check.ok, check.blockers], [true, []], JSON.stringify(check.checks))
  // A customer session running on Retell right now stays on Retell after the switch.
  env.RECEPTIONIST_VOICE_BUSINESSES = 'alpha'
  const running = (await start('alpha')).json()
  assert.equal(running.provider, 'retell')
  const cur = await getVoiceSettings(db, 'alpha')
  const sw = await switchProvider(env, alpha, admin, { provider: 'openai', useDefaultVoice: true, confirm: true, version: cur.version })
  assert.equal(sw.ok, true, sw.error)
  assert.equal(state(running.conversationId).voice.provider, 'retell')
  env.RECEPTIONIST_VOICE_BUSINESSES = ''
  assert.equal(await customerVoiceStatus(env, 'alpha'), 'available', 'the activated provider needs no Retell release entry')
  const info = (await call(infoApi, 'GET', '/api/receptionist/alpha', { params: { customer: 'alpha' } })).json()
  assert.deepEqual([info.voice, info.voiceStatus], [true, 'available'])
  const fresh = (await start('alpha')).json()
  assert.deepEqual([fresh.provider, typeof fresh.clientSecret], ['openai', 'string'])
  assert.equal((await providerOverview(env, alpha)).current, 'openai')
  // Rollback: back to Retell; new sessions follow.
  const after = await getVoiceSettings(db, 'alpha')
  assert.equal((await rollbackProvider(env, alpha, admin, { confirm: true, version: after.version })).ok, true)
  env.RECEPTIONIST_VOICE_BUSINESSES = 'alpha'
  assert.equal((await start('alpha')).json().provider, 'retell')
  const actions = db.sql.prepare("SELECT action FROM admin_audit WHERE customer = 'alpha' ORDER BY id").all().map((a) => a.action)
  assert.deepEqual(actions, ['receptionist.provider_switched', 'receptionist.provider_rolled_back'])
})

// Production 2026-11-22 (gsu-stripe-test-pools): ElevenLabs test calls ended 3–5 s after the signed URL as "The call
// dropped" with nothing recorded about why, a retry replaced the record, two attempts never ended and were counting
// toward the daily minutes "until now".
test('a dropped call is diagnosable from the records and never eats the day: the end carries the adapter’s disconnect record (sanitized; garbage dropped), the console history and the provider verification show a connection failure with its close code, a retry on the same conversation keeps the earlier attempt, and a call row never ended counts at most the session ceiling toward the daily minutes', async () => {
  await seed('alpha')
  markTest('alpha')
  const staff = await session('staff@getshowups.com')
  const s = (await start('alpha', { test: { provider: 'elevenlabs' } }, staff)).json()
  assert.equal(s.provider, 'elevenlabs')
  // The browser's end after the provider closed the socket during the handshake (SDK SessionConnectionError, 1008).
  const end = await sess('alpha', s, { action: 'end', metrics: { micLive: 0, audioReceived: 0, turns: 0 }, outcome: 'provider_refused', disconnect: { phase: 'start', code: 'provider_refused', closeCode: 1008, reason: "Override for field 'first_message' is not allowed by config\u0000\n<b>", extra: 'dropped' } })
  assert.equal(end.status, 200)
  const record = { phase: 'start', code: 'provider_refused', closeCode: 1008, reason: "Override for field 'first_message' is not allowed by config <b>" }
  assert.deepEqual([end.json().voice.outcome, end.json().voice.disconnect], ['provider_refused', record])
  const hist = await voiceSessionHistory(env, 'alpha')
  assert.deepEqual([hist[0].id, hist[0].outcome, hist[0].disconnect, hist[0].evidence], [s.conversationId, 'provider_refused', record, false])
  const ver = await providerVerification(env, 'elevenlabs')
  assert.deepEqual([ver.ok, ver.latest.path, ver.latest.cleanEnd, ver.latest.outcome, ver.latest.disconnect, ver.missing.includes('clean_end')], [false, 'connection', false, 'provider_refused', record, true])
  // Talk again on the same conversation: the earlier attempt stays in the record (history entry #1), the new attempt
  // is the session; garbage in a disconnect record is never stored (no valid code → no record).
  const s2 = (await start('alpha', { conversationId: s.conversationId, token: s.token, test: { provider: 'elevenlabs' } }, staff)).json()
  assert.deepEqual([s2.conversationId, s2.token], [s.conversationId, s.token], 'a session resumed on the conversation returns ITS token (production 2026-11-22: it returned none, the page lost its credential, the retry could never be ended)')
  assert.deepEqual(state(s.conversationId).voiceHistory.map((h) => [h.outcome, h.disconnect.closeCode]), [['provider_refused', 1008]])
  const bad = (await sess('alpha', s2, { action: 'end', metrics: {}, outcome: 'socket_closed', disconnect: { phase: 'nope', code: 'Bad Code!', closeCode: '1006' } })).json().voice
  assert.deepEqual([bad.outcome, bad.disconnect], ['socket_closed', null])
  assert.deepEqual((await sess('alpha', s2, { action: 'end', metrics: {}, outcome: 'x', disconnect: { code: 'late' } })).json().already, true, 'an end is recorded once')
  assert.deepEqual((await voiceSessionHistory(env, 'alpha')).slice(0, 2).map((h) => [h.id, h.kind, h.outcome, h.disconnect?.closeCode ?? null, h.tools.count]), [[s.conversationId, 'test', 'socket_closed', null, 0], [`${s.conversationId}#1`, 'test', 'provider_refused', 1008, 0]])
  const ver2 = await providerVerification(env, 'elevenlabs')
  assert.deepEqual([ver2.latest.path, ver2.latest.outcome, ver2.latest.disconnect, ver2.finished], ['connection', 'socket_closed', null, 1], 'the newest attempt is the latest; a failure outcome without a record still counts as a connection failure')
  // A valid record with an unknown phase lands on "start"; close codes outside 1000–4999 are dropped.
  assert.deepEqual(cleanDisconnect({ phase: 'later', code: 'provider_closed', closeCode: 5000, reason: 7 }), { phase: 'start', code: 'provider_closed', closeCode: null, reason: null })
  assert.equal(cleanDisconnect({ reason: 'no code' }), null)
  // Minutes: rows never ended count at most the 15-minute ceiling (the whole day's budget otherwise goes to one
  // abandoned call), on every sum: per business, per provider, the Lab.
  const now = Date.now()
  const day = now - (now % 864e5)
  const created = Math.max(day, now - 3 * 3600_000)
  const ran = Math.min(now - created, VOICE_SESSION_MAX_MS)
  const before = [await businessMinutesToday(env, 'alpha', now), await providerMinutesToday(env, 'elevenlabs', now), await labMinutesToday(env, now)]
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES ('web_dangling', 'alpha', 'convx', 'elevenlabs', ?), ('lab_dangling', 'alpha', 'convy', 'elevenlabs', ?)").run(created, created)
  const after = [await businessMinutesToday(env, 'alpha', now), await providerMinutesToday(env, 'elevenlabs', now), await labMinutesToday(env, now)]
  const added = after.map((m, i) => m - before[i])
  const cap = Math.ceil(ran / 60_000) + 1
  assert.ok(added.every((m) => m <= cap * 2), `at most two capped rows: ${added} ≤ ${cap * 2}`)
  assert.ok(added[2] <= cap, `the Lab sum counts its own row only, capped: ${added[2]} ≤ ${cap}`)
  if (ran === VOICE_SESSION_MAX_MS) assert.ok(added[0] >= 29 && added[0] <= 31 && added[2] >= 14 && added[2] <= 16, `15 min per row, never 180: ${added}`)
  assert.ok((await businessMinutesToday(env, 'alpha', now)) < 120, 'the business can still start a test today')
})
