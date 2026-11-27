// Receptionist voice management (migration 0035): the normalized voice catalog (provider lists, cache, validation),
// owner voice preferences (voice from the ACTIVE provider only, personality, pace where supported, optimistic
// concurrency, tenant isolation), the admin-only provider switch (checklist, blockers incl. "test only", explicit
// voice replacement, confirmation, atomic write, audit, rollback), and how the preferences reach each provider
// (Retell agent_override on the customer call and the Lab call, ElevenLabs tts override, OpenAI voice, the prompt's
// personality block). Existing businesses (no row) behave byte-for-byte as before.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { catalogFor, validateVoice, normalizeRetellVoice, normalizeElevenlabsVoice, CATALOG_TTL_MS } from '../server/voice/catalog.js'
import { checkProviderSwitch, getVoiceSettings, LIVE_PROVIDERS, ownerView, PERSONALITIES, providerOverview, rollbackProvider, saveVoicePreferences, switchProvider } from '../server/voice/settings.js'
import { PROVIDER_IDS, sessionVoiceFor, paceFor } from '../server/voice/style.js'
import { PROVIDERS } from '../server/voice/providers.js'
import { knowledgeFor, systemPrompt } from '../server/receptionist/knowledge.js'
import { startVoiceCall } from '../server/receptionist/voice.js'
import { connectRetellLab } from '../server/voice/retell.js'
import { connectElevenLabs } from '../server/voice/elevenlabs.js'
import { startLabSession } from '../server/voice/sessions.js'
import { startConversation } from '../server/receptionist/engine.js'
import * as ownerApi from '../functions/api/dashboard/receptionist/index.js'
import * as voicesApi from '../functions/api/dashboard/receptionist/voices.js'

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
const cust = async (id) => customerFromRow(await getCustomer(db, id))
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
const admin = { email: 'staff@getshowups.com' }
// Evidence of a verified session: a finished Lab/customer-path session on the provider with audio both ways and the
// availability + booking tools (what server/voice/customer.js providerEvidence reads).
const labCall = (id, provider, endedAgoMs = 60_000) => {
  const t = Date.now() - endedAgoMs
  const cid = `conv_${id}_${provider}_${Math.random().toString(36).slice(2, 8)}`
  const p = provider === 'retell-lab' ? 'retell' : provider
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, '[]', ?, ?)").run(cid, id, JSON.stringify({ lab: { provider: p, startedAt: t - 60000, endedAt: t, metrics: { micLive: 1, audioReceived: 1 } }, tools: [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true, simulated: true }] }), t - 60000, t)
  db.sql.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(`lab_${cid}`, id, cid, provider, t - 60000, t)
}

test('catalog: Retell and ElevenLabs lists are normalized (ids well-formed, presentation terms only from the provider, https previews only), cached for a day, refreshed on demand, stale-but-served on a provider failure; OpenAI is the documented fixed list without samples; the three provider ids agree', async () => {
  assert.deepEqual(PROVIDER_IDS, PROVIDERS)
  assert.deepEqual(LIVE_PROVIDERS, ['retell', 'openai', 'elevenlabs'], 'every provider has the customer-facing path (activation is evidence-based, settings.js)')
  const r = await catalogFor(env, 'retell')
  assert.deepEqual([r.source, r.voices.map((v) => v.id)], ['provider', ['retell-Cimo', '11labs-Adrian', '11labs-Myra']], 'the malformed id is dropped')
  assert.deepEqual(r.voices[0], { provider: 'retell', id: 'retell-Cimo', name: 'Cimo', preview: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cimo.mp3', language: null, accent: 'American', gender: 'masculine', age: 'Middle Aged', description: null, available: true })
  assert.equal(r.voices[2].preview, null, 'an http preview is never offered')
  assert.equal(normalizeRetellVoice({ voice_id: 'v1', voice_name: 'X', gender: 'nonbinary' }).gender, null, 'only the provider’s own stated values map; nothing is inferred from a name')
  const n = fetches.length
  const again = await catalogFor(env, 'retell')
  assert.deepEqual([again.source, fetches.length], ['cache', n])
  const refreshed = await catalogFor(env, 'retell', { refresh: true })
  assert.deepEqual([refreshed.source, fetches.length], ['provider', n + 1])
  const expired = await catalogFor(env, 'retell', { now: Date.now() + CATALOG_TTL_MS + 1 })
  assert.equal(expired.source, 'provider', 'after a day the list is re-read')
  retellStatus = 500
  const stale = await catalogFor(env, 'retell', { refresh: true })
  assert.deepEqual([stale.source, stale.stale, stale.error, stale.voices.length], ['cache', true, 'retell_http_500', 3])
  const e = await catalogFor(env, 'elevenlabs')
  assert.deepEqual(e.voices.map((v) => [v.id, v.name, v.gender, v.accent, v.language, v.description]), [
    ['cjVigY5qzO86Huf0OWal', 'Eric', 'masculine', 'American', 'en', 'friendly'],
    ['EXAVITQu4vr4xnSDxMaL', 'Sarah', 'feminine', 'American', null, null],
  ])
  assert.equal(normalizeElevenlabsVoice({ voice_id: 'x1', name: 'N', labels: {} }).gender, null)
  const o = await catalogFor(env, 'openai')
  assert.deepEqual([o.source, o.voices.length, o.voices[0].preview, o.voices[0].gender], ['fixed', 10, null, null])
  assert.equal((await catalogFor({ ...env, OPENAI_API_KEY: '' }, 'openai')).error, 'not_configured')
  assert.equal((await catalogFor({ ...env, RETELL_API_KEY: '', ONBOARDING_DB: d1() }, 'retell')).error, 'not_configured')
  // Validation: well-formed AND present.
  assert.equal((await validateVoice(env, 'retell', 'nope nope')).error, 'invalid_voice_id')
  assert.equal((await validateVoice(env, 'retell', 'retell-Unknown')).error, 'voice_unknown')
  assert.equal((await validateVoice(env, 'retell', 'cjVigY5qzO86Huf0OWal')).error, 'voice_unknown', 'an ElevenLabs id is not a Retell voice')
  assert.equal((await validateVoice(env, 'retell', '11labs-Adrian')).voice.name, 'Adrian')
  assert.equal((await validateVoice({ ...env, RETELL_API_KEY: '', ONBOARDING_DB: d1() }, 'retell', '11labs-Adrian')).error, 'provider_not_configured')
  for (const f of fetches) assert.ok(!JSON.stringify(f.init.body || '').includes('SECRET'))
})

test('owner preferences: a voice from the active provider’s catalog, a personality and a pace are saved per business with a version; wrong ids, other providers’ voices, unknown presets and a stale version are refused; another business keeps its defaults; no provider name reaches the owner', async () => {
  await seed('alpha')
  await seed('beta')
  const alpha = await cust('alpha')
  assert.deepEqual(await getVoiceSettings(db, 'alpha'), { provider: 'retell', voiceProvider: 'retell', inherited: true, defaultProvider: 'retell', defaultVersion: 0, voiceId: null, voiceName: null, personality: 'standard', pace: 'normal', language: 'en', previous: null, version: 0, updatedAt: null }, 'no row = today’s configuration (follows the global default, retell)')
  assert.equal((await saveVoicePreferences(env, alpha, { voiceId: 'nope nope', version: 0 }, 'owner@alpha.example')).error, 'invalid_voice_id')
  assert.equal((await saveVoicePreferences(env, alpha, { voiceId: 'cjVigY5qzO86Huf0OWal', version: 0 }, 'owner@alpha.example')).error, 'voice_unknown', 'an ElevenLabs voice cannot be chosen while Retell is active')
  assert.equal((await saveVoicePreferences(env, alpha, { personality: 'sassy', version: 0 }, 'owner@alpha.example')).error, 'invalid_personality')
  assert.equal((await saveVoicePreferences(env, alpha, { pace: 'warp', version: 0 }, 'owner@alpha.example')).error, 'invalid_pace')
  assert.equal((await saveVoicePreferences(env, alpha, { voiceId: '11labs-Adrian', version: 3 }, 'owner@alpha.example')).error, 'stale')
  const r = await saveVoicePreferences(env, alpha, { voiceId: '11labs-Adrian', personality: 'calm', pace: 'slower', version: 0 }, 'owner@alpha.example')
  assert.equal(r.ok, true, r.error)
  assert.deepEqual([r.settings.voiceId, r.settings.voiceName, r.settings.personality, r.settings.pace, r.settings.version], ['11labs-Adrian', 'Adrian', 'calm', 'slower', 1])
  // Concurrent conflicting change: the second writer with the old version loses, nothing is overwritten silently.
  const [a, b] = await Promise.all([saveVoicePreferences(env, alpha, { personality: 'warm', version: 1 }, 'owner@alpha.example'), saveVoicePreferences(env, alpha, { personality: 'upbeat', version: 1 }, 'owner@alpha.example')])
  assert.deepEqual([a.ok, b.ok].sort(), [false, true])
  assert.equal((a.ok ? b : a).error, 'stale')
  assert.equal((await getVoiceSettings(db, 'alpha')).version, 2)
  assert.deepEqual(await getVoiceSettings(db, 'beta'), { provider: 'retell', voiceProvider: 'retell', inherited: true, defaultProvider: 'retell', defaultVersion: 0, voiceId: null, voiceName: null, personality: 'standard', pace: 'normal', language: 'en', previous: null, version: 0, updatedAt: null }, 'tenant isolation')
  // Back to the standard voice.
  const back = await saveVoicePreferences(env, alpha, { voiceId: '', version: 2 }, 'owner@alpha.example')
  assert.deepEqual([back.settings.voiceId, back.settings.voiceName, back.settings.personality], [null, null, a.ok ? 'warm' : 'upbeat'])
  const view = ownerView(back.settings, env)
  assert.ok(!JSON.stringify(view).match(/retell|openai|elevenlabs/i), 'owners never see a provider name')
  assert.deepEqual(view.capabilities, { voiceChoice: true, previews: true, pace: true, languages: ['en'] })
  assert.deepEqual(view.personalities.map((p) => p.id), Object.keys(PERSONALITIES))
  // Pace is refused where the provider does not support it (a business on OpenAI, seeded as such).
  db.sql.prepare("UPDATE receptionist_voice_settings SET provider = 'openai', voice_id = NULL, voice_name = NULL WHERE customer = 'alpha'").run()
  db.sql.prepare("DELETE FROM receptionist_voice_inherit WHERE customer = 'alpha'").run() // an admin override, not the owner's inherited row
  const cur = await getVoiceSettings(db, 'alpha')
  assert.equal((await saveVoicePreferences(env, alpha, { pace: 'faster', version: cur.version }, 'owner@alpha.example')).error, 'pace_unsupported')
  assert.equal(ownerView(cur, env).capabilities.pace, false)
  assert.equal((await saveVoicePreferences(env, alpha, { voiceId: 'cedar', version: cur.version }, 'owner@alpha.example')).settings.voiceName, 'Cedar')
  const audit = db.sql.prepare("SELECT action, outcome FROM audit_log WHERE action = 'receptionist.voice'").all()
  assert.ok(audit.length >= 3 && audit.every((e) => e.outcome === 'success'))
})

test('routes: the owner gets voice preferences + the active catalog (never another provider’s, never a provider name); saving is same-origin and versioned; provider actions are 403 for owners and work only for a platform admin who is a member; the catalog refresh is admin-only', async () => {
  await seed('alpha')
  const owner = await session('owner@alpha.example')
  const g = await call(ownerApi, 'GET', '/api/dashboard/receptionist', { cookie: owner })
  assert.equal(g.status, 200)
  assert.deepEqual([g.json().voice.voiceId, g.json().voice.version, g.json().admin, g.json().providers], [null, 0, undefined, undefined])
  assert.ok(!JSON.stringify(g.json().voice).match(/retell|openai|elevenlabs/i))
  const v = await call(voicesApi, 'GET', '/api/dashboard/receptionist/voices?provider=elevenlabs&refresh=1', { cookie: owner })
  assert.equal(v.status, 200)
  assert.deepEqual([v.json().provider, v.json().voices.map((x) => x.name), v.json().capabilities.pace], [undefined, ['Cimo', 'Adrian', 'Myra'], true], 'the owner gets the ACTIVE provider’s list whatever the query says')
  assert.equal(v.json().voices[2].preview, null)
  assert.equal((await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: owner, origin: 'https://evil.example', body: { action: 'voice', voiceId: '11labs-Adrian', version: 0 } })).status, 403)
  const s = await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: owner, body: { action: 'voice', voiceId: '11labs-Adrian', personality: 'professional', pace: 'faster', version: 0 } })
  assert.equal(s.status, 200)
  assert.deepEqual([s.json().voice.voiceName, s.json().voice.personality, s.json().voice.pace, s.json().voice.version], ['Adrian', 'professional', 'faster', 1])
  assert.equal((await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: owner, body: { action: 'voice', personality: 'calm', version: 0 } })).status, 409, 'stale version')
  assert.equal((await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: owner, body: { action: 'voice', voiceId: 'cjVigY5qzO86Huf0OWal', version: 1 } })).json().error, 'voice_unknown')
  for (const action of ['provider_check', 'provider_switch', 'provider_rollback']) {
    assert.equal((await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: owner, body: { action, provider: 'elevenlabs', confirm: true, version: 1 } })).status, 403, `${action} is admin-only`)
  }
  // A platform admin who is a member of the business sees the provider view and may check / switch.
  const staff = await session('staff@getshowups.com', 'alpha')
  const ga = await call(ownerApi, 'GET', '/api/dashboard/receptionist', { cookie: staff })
  assert.equal(ga.json().admin, true)
  assert.deepEqual(ga.json().providers.providers.map((p) => [p.id, p.state, p.configured, p.phone, p.customerPath, p.blockers]), [
    ['retell', 'active', true, false, true, []],
    ['openai', 'needs_test', true, false, true, ['needs_test']],
    ['elevenlabs', 'needs_test', true, false, true, ['needs_test']],
  ])
  const va = await call(voicesApi, 'GET', '/api/dashboard/receptionist/voices?provider=elevenlabs', { cookie: staff })
  assert.deepEqual([va.json().provider, va.json().voices.map((x) => x.name)], ['elevenlabs', ['Eric', 'Sarah']])
  const chk = await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: staff, body: { action: 'provider_check', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal' } })
  assert.equal(chk.status, 200)
  assert.ok(chk.json().check.blockers.includes('test_session_required'))
  const sw = await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: staff, body: { action: 'provider_switch', provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 1 } })
  assert.deepEqual([sw.status, sw.json().error], [409, 'blocked'], 'an unverified provider can never be activated for customers')
  assert.equal((await getVoiceSettings(db, 'alpha')).provider, 'retell')
  // An admin who is NOT a member of any business has no session business at all (requireSession refuses).
  env.PLATFORM_ADMIN_EMAILS = 'staff@getshowups.com,other@getshowups.com'
  const outsider = await session('other@getshowups.com')
  assert.notEqual((await call(ownerApi, 'POST', '/api/dashboard/receptionist', { cookie: outsider, body: { action: 'provider_check', provider: 'retell' } })).status, 200)
  // Membership of ANOTHER business never reaches alpha's settings (the session business is the only one in play).
  await seed('beta')
  const betaAdmin = await session('other@getshowups.com', 'beta')
  const gb = await call(ownerApi, 'GET', '/api/dashboard/receptionist', { cookie: betaAdmin })
  assert.deepEqual([gb.status, gb.json().voice.voiceId, gb.json().providers.current], [200, null, 'retell'], 'beta’s defaults, not alpha’s Adrian')
})

test('provider switch: the checklist blocks test-only providers, unconfigured providers, missing test sessions, unready booking and an incompatible voice unless replaced explicitly; a passing switch needs confirmation + the current version, writes once, keeps the previous configuration and is audited; rollback restores it; nothing changes on a blocked attempt', async () => {
  await seed('alpha')
  const alpha = await cust('alpha')
  // A business seeded on OpenAI with an OpenAI voice (how a Lab-era record could look) wants Retell, the live provider.
  db.sql.prepare("INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, version, updated_by, updated_at) VALUES ('alpha', 'openai', 'cedar', 'Cedar', 'warm', 'faster', 'en', 1, 'ref:x', 1)").run()
  let c = await checkProviderSwitch(env, alpha, { provider: 'retell' })
  assert.deepEqual(c.blockers, ['voice_replacement_required', 'test_session_required'])
  assert.ok(c.checks.find((x) => x.id === 'voice').note.includes('cannot transfer'))
  c = await checkProviderSwitch(env, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })
  assert.deepEqual(c.blockers, ['test_session_required'])
  labCall('alpha', 'retell-lab')
  c = await checkProviderSwitch(env, alpha, { provider: 'retell', useDefaultVoice: true })
  assert.deepEqual([c.ok, c.blockers, c.voice], [true, [], null])
  c = await checkProviderSwitch(env, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })
  assert.deepEqual([c.ok, c.voice, c.transfer], [true, { id: 'retell-Cimo', name: 'Cimo' }, { personality: true, pace: true, voice: false }])
  assert.ok(c.consequences.some((t) => t.includes('sessions already in progress stay on OpenAI Realtime')))
  assert.ok(c.consequences.some((t) => t.includes('Voice becomes "Cimo"')))
  // Other blockers, each on its own.
  assert.ok((await checkProviderSwitch({ ...env, RETELL_API_KEY: '' }, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })).blockers.includes('not_configured'))
  assert.ok((await checkProviderSwitch(env, alpha, { provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal' })).blockers.includes('test_session_required'))
  assert.ok((await checkProviderSwitch({ ...env, VOICE_PROVIDERS_DISABLED: 'retell' }, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })).blockers.includes('disabled'))
  assert.ok((await checkProviderSwitch(env, { ...alpha, status: 'suspended' }, { provider: 'retell', voiceId: 'retell-Cimo' })).blockers.includes('business_not_eligible'))
  kv.delete('google:alpha')
  assert.ok((await checkProviderSwitch(env, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })).blockers.includes('booking_not_ready'))
  kv.set('google:alpha', 'tok')
  assert.ok((await checkProviderSwitch(env, alpha, { provider: 'retell', voiceId: 'retell-Unknown' })).blockers.includes('voice_unknown'))
  assert.equal((await checkProviderSwitch(env, alpha, { provider: 'nope' })).blockers[0], 'invalid_provider')
  // Switching: admin only; blocked attempts change nothing but are audited; confirmation and version are required.
  assert.equal((await switchProvider(env, alpha, { email: 'owner@alpha.example' }, { provider: 'retell', voiceId: 'retell-Cimo', confirm: true, version: 1 })).error, 'not_platform_admin')
  const blocked = await switchProvider(env, alpha, admin, { provider: 'elevenlabs', voiceId: 'cjVigY5qzO86Huf0OWal', confirm: true, version: 1 })
  assert.deepEqual([blocked.error, (await getVoiceSettings(db, 'alpha')).provider], ['blocked', 'openai'])
  assert.equal((await switchProvider(env, alpha, admin, { provider: 'retell', voiceId: 'retell-Cimo', version: 1 })).error, 'confirmation_required')
  assert.equal((await switchProvider(env, alpha, admin, { provider: 'retell', voiceId: 'retell-Cimo', confirm: true, version: 0 })).error, 'stale')
  const sw = await switchProvider(env, alpha, admin, { provider: 'retell', voiceId: 'retell-Cimo', confirm: true, version: 1 })
  assert.equal(sw.ok, true, sw.error)
  const after = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([after.provider, after.voiceId, after.voiceName, after.personality, after.pace, after.version], ['retell', 'retell-Cimo', 'Cimo', 'warm', 'faster', 2])
  assert.deepEqual(after.previous.provider, 'openai')
  assert.deepEqual([after.previous.voiceId, after.previous.pace], ['cedar', 'faster'])
  const actions = db.sql.prepare("SELECT action, details FROM admin_audit WHERE customer = 'alpha' ORDER BY id").all()
  assert.deepEqual(actions.map((a) => a.action), ['receptionist.provider_switch_blocked', 'receptionist.provider_switched'])
  assert.match(actions[1].details, /"from":"openai"/)
  assert.match(actions[1].details, /"to":"retell"/)
  assert.match(actions[1].details, /"outcome":"success"/)
  assert.ok(!actions.some((a) => /SECRET|cedar@/.test(a.details)))
  assert.equal((await checkProviderSwitch(env, alpha, { provider: 'retell', voiceId: 'retell-Cimo' })).blockers[0], 'no_change')
  const ov = await providerOverview(env, alpha)
  assert.deepEqual([ov.current, ov.providers.find((p) => p.id === 'retell').state, ov.providers.find((p) => p.id === 'retell').evidence.ok], ['retell', 'active', true])
  // Rollback: admin only, confirmed, versioned; restores provider + voice + pace and clears `previous`; audited.
  assert.equal((await rollbackProvider(env, alpha, { email: 'owner@alpha.example' }, { confirm: true, version: 2 })).error, 'not_platform_admin')
  assert.equal((await rollbackProvider(env, alpha, admin, { version: 2 })).error, 'confirmation_required')
  assert.equal((await rollbackProvider(env, alpha, admin, { confirm: true, version: 1 })).error, 'stale')
  const rb = await rollbackProvider(env, alpha, admin, { confirm: true, version: 2 })
  assert.equal(rb.ok, true, rb.error)
  const restored = await getVoiceSettings(db, 'alpha')
  assert.deepEqual([restored.provider, restored.voiceId, restored.voiceName, restored.pace, restored.previous, restored.version], ['openai', 'cedar', 'Cedar', 'faster', null, 3])
  assert.equal((await rollbackProvider(env, alpha, admin, { confirm: true, version: 3 })).error, 'nothing_to_roll_back')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'receptionist.provider_rolled_back'").get().n, 1)
})

test('how the preference reaches each provider: a business with no row makes the same Retell call as before (PoolThru regression guard); a chosen voice + pace ride as agent_override on customer calls and Lab calls; ElevenLabs gets a tts override; OpenAI the voice; the prompt carries the personality block only for a non-standard preset', async () => {
  await seed('alpha')
  const alpha = await cust('alpha')
  const r0 = await startVoiceCall(env, alpha)
  assert.equal(r0.ok, true)
  const body0 = JSON.parse(fetches.find((f) => f.url.endsWith('/v3/create-web-call')).init.body)
  assert.deepEqual(body0.agent_override, { agent: { max_call_duration_ms: 900_000 } }, 'no voice override for a business that changed nothing; only Retell’s 15-minute end')
  await saveVoicePreferences(env, alpha, { voiceId: 'retell-Cimo', pace: 'slower', personality: 'calm', version: 0 }, 'owner@alpha.example')
  const prefs = await getVoiceSettings(db, 'alpha')
  assert.deepEqual(sessionVoiceFor('retell', prefs), { voice_id: 'retell-Cimo', voice_speed: 0.9 })
  assert.equal(sessionVoiceFor('elevenlabs', prefs), null, 'a Retell preference never leaks into another provider’s session')
  assert.equal(paceFor('openai', 'faster'), null)
  const r1 = await startVoiceCall(env, alpha, Date.now(), null, null, sessionVoiceFor('retell', prefs))
  assert.equal(r1.ok, true)
  const body1 = JSON.parse(fetches.filter((f) => f.url.endsWith('/v3/create-web-call')).at(-1).init.body)
  assert.deepEqual(body1.agent_override, { agent: { voice_id: 'retell-Cimo', voice_speed: 0.9, max_call_duration_ms: 900_000 } })
  assert.equal(body1.agent_id, 'agent_abc123def', 'still the one shared agent')
  // Lab (Retell): the admin's candidate voice wins; without one, the business's own voice applies.
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('alpha', 1, 'staff', 1)").run()
  assert.equal((await startLabSession(env, admin, { customer: 'alpha', provider: 'retell', settings: { voice: 'retell-Unknown' } })).error, 'voice_unknown')
  const lab = await startLabSession(env, admin, { customer: 'alpha', provider: 'retell', settings: { voice: '11labs-Adrian' } })
  assert.equal(lab.ok, true, lab.error)
  const conv = { id: lab.session.id, state: { lab: { provider: 'retell', settings: lab.session.settings } } }
  assert.equal((await connectRetellLab(env, { customer: alpha, conv })).ok, true)
  assert.deepEqual(JSON.parse(fetches.filter((f) => f.url.endsWith('/v3/create-web-call')).at(-1).init.body).agent_override, { agent: { voice_id: '11labs-Adrian', max_call_duration_ms: 900_000 } })
  const conv2 = { id: lab.session.id, state: { lab: { provider: 'retell', settings: {} } } }
  assert.equal((await connectRetellLab(env, { customer: alpha, conv: conv2 })).ok, true)
  assert.deepEqual(JSON.parse(fetches.filter((f) => f.url.endsWith('/v3/create-web-call')).at(-1).init.body).agent_override, { agent: { voice_id: 'retell-Cimo', voice_speed: 0.9, max_call_duration_ms: 900_000 } })
  // ElevenLabs: candidate tts override; a Retell-only preference → the agent's own voice.
  const el = await startConversation(env, alpha, 'voice')
  const elConv = { id: el.id, state: { lab: { provider: 'elevenlabs', dryRun: true, settings: { voice: 'cjVigY5qzO86Huf0OWal' } } } }
  const e1 = await connectElevenLabs(env, { customer: alpha, conv: elConv })
  assert.equal(e1.ok, true, e1.error)
  assert.deepEqual(e1.overrides.tts, { voiceId: 'cjVigY5qzO86Huf0OWal' })
  const elConv2 = { id: el.id, state: { lab: { provider: 'elevenlabs', dryRun: true, settings: {} } } }
  assert.equal((await connectElevenLabs(env, { customer: alpha, conv: elConv2 })).overrides.tts, undefined)
  // An admin switch = the row's provider + no inherit row (an explicit override; the owner's save above kept inheriting).
  db.sql.prepare("UPDATE receptionist_voice_settings SET provider = 'elevenlabs', voice_id = 'EXAVITQu4vr4xnSDxMaL', voice_name = 'Sarah', pace = 'faster' WHERE customer = 'alpha'").run()
  db.sql.prepare("DELETE FROM receptionist_voice_inherit WHERE customer = 'alpha'").run()
  const elConv3 = { id: el.id, state: { lab: { provider: 'elevenlabs', dryRun: true, settings: {} } } }
  assert.deepEqual((await connectElevenLabs(env, { customer: alpha, conv: elConv3 })).overrides.tts, { voiceId: 'EXAVITQu4vr4xnSDxMaL', speed: 1.1 })
  // The prompt: personality block for a preset, none for 'standard' (existing prompts byte-identical).
  db.sql.prepare("UPDATE receptionist_voice_settings SET personality = 'standard' WHERE customer = 'alpha'").run()
  const k0 = await knowledgeFor(env, alpha, { greeting: 'Hi from alpha!' })
  const p0 = systemPrompt(k0, 'chat')
  assert.ok(!p0.includes('# Personality'))
  db.sql.prepare("UPDATE receptionist_voice_settings SET personality = 'calm' WHERE customer = 'alpha'").run()
  const k1 = await knowledgeFor(env, alpha, { greeting: 'Hi from alpha!' })
  const p1 = systemPrompt(k1, 'chat')
  assert.ok(p1.startsWith(p0), 'the personality is appended; everything before it is unchanged')
  assert.match(p1, /# Personality\nCalm and reassuring/)
  assert.match(p1, /Facts, prices, the service area, booking steps and every rule above stay exactly as they are/)
  assert.ok(!p1.includes('# Personality\n# Personality'))
})
