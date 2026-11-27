// Global default AI voice provider (migration 0036, server/voice/global.js): resolution override → global default →
// retell (existing behaviour byte-for-byte while nothing is set); owner saves keep a business following the default,
// an admin switch makes an override, a per-business rollback can return it to following; the global switch checks
// every inherited business with the per-business checklist, refuses "all at once" while any is unverified, pins the
// unverified ones in a staged rollout (never silently switched), leaves overrides alone, moves verified ones; the
// sequence Retell → OpenAI → ElevenLabs → Retell; sessions stay pinned and concurrent businesses stay isolated; global
// rollback undoes exactly what the version did and reports what it kept; the console route is admin-only with the
// provider typed back. Harness shared with test/voice-customer.test.js.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { getVoiceSettings, providerOverview, rollbackProvider, saveVoicePreferences, switchProvider } from '../server/voice/settings.js'
import { checkGlobalSwitch, getGlobalDefault, globalOverview, rollbackGlobalProvider, switchGlobalProvider } from '../server/voice/global.js'
import { listVoiceBusinesses } from '../server/voice/admin.js'
import { startVoiceCall } from '../server/receptionist/voice.js'
import * as consoleApi from '../functions/api/platform/voice-provider.js'
import * as voiceApi from '../functions/api/receptionist/[customer]/voice.js'
import * as connectApi from '../functions/api/receptionist/[customer]/voice-connect.js'

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
const state = (convId) => JSON.parse(db.sql.prepare('SELECT state FROM receptionist_conversations WHERE id = ?').get(convId).state)
const markTest = (id) => db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'staff', 1)").run(id)
const admin = { email: 'staff@getshowups.com' }

const ADMIN = 'staff@getshowups.com'
const inheritRow = (id) => Boolean(db.sql.prepare('SELECT 1 FROM receptionist_voice_inherit WHERE customer = ?').get(id))
// A finished admin test session on `provider` with audio both ways and both booking tools = activation evidence.
const evidence = (id, provider) => {
  const t = Date.now() - 60_000
  const cid = `conv_${id}_${provider}_${Math.random().toString(36).slice(2, 8)}`
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, '[]', ?, ?)").run(cid, id, JSON.stringify({ voice: { provider, startedAt: t - 90_000, endedAt: t, test: true, metrics: { micLive: 1, audioReceived: 1 } }, tools: [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true, simulated: true }] }), t - 90_000, t)
}
const audits = (action) => db.sql.prepare('SELECT actor, action, customer, details FROM admin_audit WHERE action = ? ORDER BY id').all(action)
const resolved = async (ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await getVoiceSettings(db, id).then((s) => `${s.provider}:${s.inherited ? 'global' : 'override'}`)])))

test('resolution and existing behaviour: nothing set = retell (same Retell call body as before); an owner save keeps the business following the global default; an admin switch is an override; a per-business rollback returns it to following when the default still is that provider', async () => {
  await seed('alpha')
  const alpha = await cust('alpha')
  assert.deepEqual(await getGlobalDefault(db), { provider: 'retell', version: 0, previous: null, mode: null, pinned: [], switched: [], setAt: null, setBy: null })
  let s = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([s.provider, s.inherited, s.defaultProvider, s.defaultVersion, s.version], ['retell', true, 'retell', 0, 0])
  assert.equal((await startVoiceCall(env, alpha)).ok, true)
  // PoolThru regression guard: the same call as before, plus Retell's own 15-minute end (the only override).
  const sent = JSON.parse(fetches.find((f) => f.url.endsWith('/v3/create-web-call')).init.body)
  assert.deepEqual(Object.keys(sent).sort(), ['agent_id', 'agent_override', 'agent_version', 'metadata'])
  assert.deepEqual(sent.agent_override, { agent: { max_call_duration_ms: 900_000 } })
  // Owner save: a row appears, the business still follows the global default.
  assert.equal((await saveVoicePreferences(env, alpha, { personality: 'warm', version: 0 }, 'owner@alpha.example')).ok, true)
  s = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([s.provider, s.inherited, s.version, inheritRow('alpha')], ['retell', true, 1, true])
  // Admin switch (verified): an explicit override; the previous configuration remembers it was inherited.
  markTest('alpha')
  evidence('alpha', 'openai')
  const sw = await switchProvider(env, alpha, admin, { provider: 'openai', useDefaultVoice: true, confirm: true, version: 1 })
  assert.equal(sw.ok, true, sw.error)
  s = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([s.provider, s.inherited, s.previous.provider, s.previous.inherited, inheritRow('alpha')], ['openai', false, 'retell', true, false])
  assert.deepEqual((await providerOverview(env, alpha)).inherited, false)
  // Rollback: back to retell AND back to following the default (which still is retell).
  assert.equal((await rollbackProvider(env, alpha, admin, { confirm: true, version: s.version })).ok, true)
  s = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([s.provider, s.inherited, inheritRow('alpha')], ['retell', true, true])
  assert.deepEqual(JSON.parse(audits('receptionist.provider_rolled_back')[0].details).inherited, true)
})

test('global sequence Retell → OpenAI → ElevenLabs → Retell (staged): verified inherited businesses switch, unverified ones are pinned by name (never switched silently), explicit overrides are untouched, "all at once" is refused while any is unverified, a business created later follows the new default; version checks and audit trail; the console list shows inherited vs override', async () => {
  for (const id of ['alpha', 'beta', 'gamma', 'delta']) await seed(id)
  markTest('alpha')
  markTest('delta')
  evidence('alpha', 'openai')
  evidence('alpha', 'elevenlabs')
  evidence('alpha', 'retell')
  evidence('delta', 'openai')
  setProvider('gamma', 'elevenlabs') // an explicit override (no inherit row)
  assert.equal((await saveVoicePreferences(env, await cust('delta'), { voiceId: 'retell-Cimo', version: 0 }, 'owner@delta.example')).ok, true) // a Retell voice: cannot move to OpenAI
  let check = await checkGlobalSwitch(env, { provider: 'openai' })
  assert.deepEqual([check.ok, check.blockers, check.counts], [true, [], { total: 4, inherited: 3, overrides: 1, switch: 1, pinned: 2 }])
  const byId = Object.fromEntries(check.businesses.map((b) => [b.id, [b.status, b.blockers]]))
  assert.deepEqual(byId, { alpha: ['switch', []], beta: ['pinned', ['test_session_required']], gamma: ['override', []], delta: ['pinned', ['voice_replacement_required']] }, JSON.stringify(byId))
  assert.deepEqual((await checkGlobalSwitch(env, { provider: 'retell' })).blockers, ['no_change'])
  assert.deepEqual((await checkGlobalSwitch(env, { provider: 'nope' })).blockers, ['invalid_provider'])
  assert.ok((await checkGlobalSwitch({ ...env, OPENAI_API_KEY: '' }, { provider: 'openai' })).blockers.includes('not_configured'))
  assert.ok((await checkGlobalSwitch({ ...env, VOICE_PROVIDERS_DISABLED: 'openai' }, { provider: 'openai' })).blockers.includes('disabled'))
  // Guards: admin only; "all" refused with unverified businesses; confirmation; version. Nothing changes meanwhile.
  assert.equal((await switchGlobalProvider(env, { email: 'owner@alpha.example' }, { provider: 'openai', mode: 'all', confirm: true, version: 0 })).error, 'not_platform_admin')
  const all = await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'all', confirm: true, version: 0 })
  assert.deepEqual([all.error, all.reason], ['blocked', 'unverified_businesses'])
  assert.equal((await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', version: 0 })).error, 'confirmation_required')
  assert.equal((await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', confirm: true, version: 4 })).error, 'stale')
  assert.equal((await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'nope', confirm: true, version: 0 })).error, 'invalid_mode')
  assert.deepEqual([(await getGlobalDefault(db)).version, await resolved(['alpha', 'beta', 'gamma', 'delta'])], [0, { alpha: 'retell:global', beta: 'retell:global', gamma: 'elevenlabs:override', delta: 'retell:global' }])
  // Staged: alpha follows OpenAI; beta and delta are pinned to Retell (overrides now); gamma untouched.
  const sw1 = await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', confirm: true, version: 0 })
  assert.equal(sw1.ok, true, sw1.error)
  assert.deepEqual([sw1.global.provider, sw1.global.version, sw1.global.previous, sw1.global.mode, sw1.applied], ['openai', 1, 'retell', 'staged', { switched: 0, pinned: 2, overrides: 1 }])
  assert.deepEqual(sw1.global.pinned.map((p) => p.customer).sort(), ['beta', 'delta'])
  assert.deepEqual(await resolved(['alpha', 'beta', 'gamma', 'delta']), { alpha: 'openai:global', beta: 'retell:override', gamma: 'elevenlabs:override', delta: 'retell:override' })
  const delta = await getVoiceSettings(db, 'delta')
  assert.deepEqual([delta.voiceId, delta.voiceProvider], ['retell-Cimo', 'retell'], 'the pinned business keeps its voice')
  assert.deepEqual(audits('receptionist.global_provider_switched').map((a) => [a.actor, a.customer]), [[ADMIN, null]])
  assert.match(audits('receptionist.global_provider_switched')[0].details, /"from":"retell","to":"openai","mode":"staged"/)
  assert.deepEqual(audits('receptionist.provider_pinned').map((a) => a.customer).sort(), ['beta', 'delta'])
  assert.deepEqual(audits('receptionist.global_provider_blocked').length, 1)
  // A business created later follows the new default without any edit.
  await seed('epsilon')
  assert.deepEqual(await resolved(['epsilon']), { epsilon: 'openai:global' })
  const listed = Object.fromEntries((await listVoiceBusinesses(env)).map((b) => [b.id, `${b.provider}:${b.inherited ? 'global' : 'override'}`]))
  assert.deepEqual(listed, { alpha: 'openai:global', beta: 'retell:override', gamma: 'elevenlabs:override', delta: 'retell:override', epsilon: 'openai:global' })
  // → ElevenLabs: alpha verified there; epsilon is not → pinned to OpenAI (today's provider for it).
  check = await checkGlobalSwitch(env, { provider: 'elevenlabs' })
  assert.deepEqual(check.counts, { total: 5, inherited: 2, overrides: 3, switch: 1, pinned: 1 })
  const sw2 = await switchGlobalProvider(env, admin, { provider: 'elevenlabs', mode: 'staged', confirm: true, version: 1 })
  assert.equal(sw2.ok, true, sw2.error)
  assert.deepEqual(await resolved(['alpha', 'epsilon', 'gamma']), { alpha: 'elevenlabs:global', epsilon: 'openai:override', gamma: 'elevenlabs:override' })
  // → Retell: only alpha still follows; verified on Retell too; "all" is possible now (nobody blocked).
  check = await checkGlobalSwitch(env, { provider: 'retell' })
  assert.deepEqual([check.counts.inherited, check.counts.pinned, check.counts.switch], [1, 0, 1])
  const sw3 = await switchGlobalProvider(env, admin, { provider: 'retell', mode: 'all', confirm: true, version: 2 })
  assert.equal(sw3.ok, true, sw3.error)
  assert.deepEqual([(await getGlobalDefault(db)).provider, (await getGlobalDefault(db)).version, await resolved(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])], ['retell', 3, { alpha: 'retell:global', beta: 'retell:override', gamma: 'elevenlabs:override', delta: 'retell:override', epsilon: 'openai:override' }])
  const ov = await globalOverview(env)
  assert.deepEqual([ov.ready, ov.current.provider, ov.current.version, ov.current.previous, ov.current.canRollBack, ov.counts.total, ov.counts.inherited, ov.counts.overrides, ov.counts.pins, ov.counts.independent], [true, 'retell', 3, 'elevenlabs', true, 5, 1, 4, 3, 1])
  assert.ok(!JSON.stringify([check, sw1, sw2, sw3, ov]).match(/SECRET|owner@/), 'no secrets, no emails')
})

test('global rollback undoes what the version did: pinned businesses follow the default again, moved rows go back, a business whose owner chose a voice on the new provider meanwhile is kept there (reported, never a substituted voice), overrides untouched; a rollback cannot be rolled back; version checks', async () => {
  for (const id of ['alpha', 'beta', 'gamma', 'zeta']) await seed(id)
  markTest('alpha')
  markTest('zeta')
  evidence('alpha', 'openai')
  evidence('zeta', 'openai')
  setProvider('gamma', 'elevenlabs')
  await saveVoicePreferences(env, await cust('alpha'), { personality: 'calm', version: 0 }, 'owner@alpha.example') // a row that follows the default
  await saveVoicePreferences(env, await cust('zeta'), { personality: 'upbeat', version: 0 }, 'owner@zeta.example')
  const sw = await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', confirm: true, version: 0 })
  assert.equal(sw.ok, true, sw.error)
  assert.deepEqual([sw.global.switched.map((x) => x.customer).sort(), sw.global.pinned.map((x) => x.customer)], [['alpha', 'zeta'], ['beta']])
  assert.deepEqual(await resolved(['alpha', 'beta', 'gamma', 'zeta']), { alpha: 'openai:global', beta: 'retell:override', gamma: 'elevenlabs:override', zeta: 'openai:global' })
  assert.deepEqual([(await getVoiceSettings(db, 'alpha')).version, (await getVoiceSettings(db, 'alpha')).voiceProvider], [2, 'openai'])
  // Meanwhile alpha's owner chooses an OpenAI voice.
  assert.equal((await saveVoicePreferences(env, await cust('alpha'), { voiceId: 'cedar', version: 2 }, 'owner@alpha.example')).ok, true)
  assert.equal((await rollbackGlobalProvider(env, { email: 'owner@alpha.example' }, { confirm: true, version: 1 })).error, 'not_platform_admin')
  assert.equal((await rollbackGlobalProvider(env, admin, { version: 1 })).error, 'confirmation_required')
  assert.equal((await rollbackGlobalProvider(env, admin, { confirm: true, version: 0 })).error, 'stale')
  const rb = await rollbackGlobalProvider(env, admin, { confirm: true, version: 1 })
  assert.equal(rb.ok, true, rb.error)
  assert.deepEqual([rb.global.provider, rb.global.version, rb.global.mode, rb.global.previous, rb.undone], ['retell', 2, 'rollback', 'openai', { unpinned: 1, moved: 1, pinsRestored: 0, overridesRestored: 0, kept: [{ id: 'alpha', reason: 'voice_on_new_provider' }] }])
  assert.deepEqual(await resolved(['alpha', 'beta', 'gamma', 'zeta']), { alpha: 'openai:override', beta: 'retell:global', gamma: 'elevenlabs:override', zeta: 'retell:global' })
  const alpha = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([alpha.voiceId, alpha.voiceProvider], ['cedar', 'openai'], 'kept with its voice, as an override')
  assert.deepEqual([(await getVoiceSettings(db, 'zeta')).voiceProvider, (await getVoiceSettings(db, 'zeta')).personality], ['retell', 'upbeat'])
  assert.deepEqual(audits('receptionist.global_provider_rolled_back').length, 1)
  assert.deepEqual(audits('receptionist.provider_pinned').map((a) => [a.customer, JSON.parse(a.details).reason || null]), [['beta', null], ['alpha', 'voice_on_new_provider']])
  assert.equal((await rollbackGlobalProvider(env, admin, { confirm: true, version: 2 })).error, 'nothing_to_roll_back')
  assert.equal((await globalOverview(env)).current.canRollBack, false)
})

test('sessions stay pinned across a global change and concurrent businesses stay isolated: a Retell session running on alpha keeps Retell after the default moves to OpenAI, a new alpha session gets OpenAI, beta (override) runs ElevenLabs at the same time, each conversation bound to its own business; the console route is admin-only with the provider typed back', async () => {
  await seed('alpha')
  await seed('beta')
  markTest('alpha')
  evidence('alpha', 'openai')
  setProvider('beta', 'elevenlabs')
  env.RECEPTIONIST_VOICE_CONCURRENT = '10'
  const running = (await start('alpha')).json()
  assert.equal(running.provider, 'retell')
  const staff = await session(ADMIN)
  const owner = await session('owner@alpha.example')
  const post = (body, cookie = staff, origin = ORIGIN) => call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie, origin, body })
  assert.equal((await post({ action: 'global_check', provider: 'openai' }, null)).status, 401)
  assert.equal((await post({ action: 'global_check', provider: 'openai' }, owner)).status, 403)
  assert.equal((await post({ action: 'global_switch', provider: 'openai', confirmProvider: 'openai', mode: 'staged', confirm: true, version: 0 }, owner)).status, 403)
  assert.equal((await post({ action: 'global_switch', provider: 'openai', confirmProvider: 'openai', mode: 'staged', confirm: true, version: 0 }, staff, 'https://evil.example')).status, 403)
  assert.deepEqual([(await post({ action: 'global_switch', provider: 'openai', confirmProvider: 'elevenlabs', mode: 'staged', confirm: true, version: 0 })).status, (await post({ action: 'global_switch', provider: 'openai', mode: 'staged', confirm: true, version: 0 })).json().error], [400, 'confirm_provider_mismatch'])
  assert.equal((await getGlobalDefault(db)).version, 0, 'nothing changed')
  const g = await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: staff })
  assert.deepEqual([g.json().global.current.provider, g.json().global.counts.total, g.json().global.counts.inherited, g.json().global.counts.overrides], ['retell', 2, 1, 1])
  const chk = await call(consoleApi, 'GET', '/api/platform/voice-provider?global_check=openai', { cookie: staff })
  assert.deepEqual([chk.status, chk.json().check.counts.switch, chk.json().check.counts.overrides], [200, 1, 1])
  const sw = await post({ action: 'global_switch', provider: 'openai', confirmProvider: 'OpenAI', mode: 'all', confirm: true, version: 0 })
  assert.equal(sw.status, 200, JSON.stringify(sw.json()))
  assert.deepEqual([sw.json().global.current.provider, sw.json().applied, sw.json().businesses.find((b) => b.id === 'alpha').inherited], ['openai', { switched: 0, pinned: 0, overrides: 1 }, true])
  // The running session is still Retell (its reconnect route refuses as before); a NEW alpha session is OpenAI.
  assert.equal(state(running.conversationId).voice.provider, 'retell')
  assert.equal((await connect('alpha', running)).json().error, 'wrong_provider')
  const [a, b] = await Promise.all([start('alpha'), start('beta')])
  assert.deepEqual([a.json().provider, typeof a.json().clientSecret, b.json().provider, typeof b.json().signedUrl], ['openai', 'string', 'elevenlabs', 'string'])
  assert.deepEqual([state(a.json().conversationId).voice.provider, state(b.json().conversationId).voice.provider], ['openai', 'elevenlabs'])
  assert.deepEqual([db.sql.prepare('SELECT customer FROM receptionist_conversations WHERE id = ?').get(a.json().conversationId).customer, db.sql.prepare('SELECT customer FROM receptionist_conversations WHERE id = ?').get(b.json().conversationId).customer], ['alpha', 'beta'])
  assert.equal((await call(connectApi, 'POST', '/api/receptionist/beta/voice-connect', { params: { customer: 'beta' }, body: { id: a.json().conversationId, token: a.json().token } })).status, 404, 'another business never reaches the session')
  // Rollback through the route: the previous provider must be typed; then alpha follows Retell again.
  assert.equal((await post({ action: 'global_rollback', confirmProvider: 'openai', confirm: true, version: 1 })).json().error, 'confirm_provider_mismatch')
  const rb = await post({ action: 'global_rollback', confirmProvider: 'retell', confirm: true, version: 1 })
  assert.equal(rb.status, 200, JSON.stringify(rb.json()))
  assert.deepEqual([rb.json().global.current.provider, (await start('alpha')).json().provider, state(a.json().conversationId).voice.provider], ['retell', 'retell', 'openai'])
})
