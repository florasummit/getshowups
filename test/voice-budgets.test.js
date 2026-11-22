// Voice cost controls (server/voice/budgets.js, charges.js, compare.js; PR after #124): configurable daily limits per
// provider and per test business that refuse a start at the ceiling (customer path AND Lab), near-exhaustion warnings,
// verified charges from the providers' own records (Retell call cost in cents, ElevenLabs conversation credits + USD
// when reported) attributed to the right session and never invented, provider balances only where an API exists, a
// comparison per provider from session records, and tenant isolation on every one of them.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { budgetState, providerDailyLimit, testDailyMinutes, testMinutesToday, SESSION_CEILING_MS } from '../server/voice/budgets.js'
import { fetchCharge, recordCharges, providerBalances, chargeRef, CHARGE_SUPPORT } from '../server/voice/charges.js'
import { providerComparison, budgetOverview } from '../server/voice/compare.js'
import { providerMinutesToday } from '../server/voice/customer.js'
import { startLabSession, endLabSession, loadLabSession, recordLabProviderSession } from '../server/voice/sessions.js'
import * as voiceApi from '../functions/api/receptionist/[customer]/voice.js'
import * as sessionApi from '../functions/api/receptionist/[customer]/voice-session.js'
import * as labSessionApi from '../functions/api/platform/voice-lab/session.js'
import * as labStatusApi from '../functions/api/platform/voice-lab/status.js'

const ORIGIN = 'https://getshowups.com'
const RETELL = 'http://127.0.0.1:9961'
const EL = 'http://127.0.0.1:9962'
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
let env, db, kv, fetches, origFetch, responses, retellCalls, elConversations, elSubscription
beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  retellCalls = {}
  elConversations = {}
  elSubscription = { status: 200, body: { tier: 'creator', character_count: 81_000, character_limit: 100_000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 5 * 86400 } }
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test',
    RETELL_API_KEY: SECRETS[0],
    RETELL_AGENT_ID: 'agent_abc123def',
    RETELL_WS_SECRET: 'w'.repeat(40),
    RETELL_API_MOCK_ORIGIN: RETELL,
    ELEVENLABS_API_KEY: SECRETS[1],
    ELEVENLABS_AGENT_ID: 'agent_el0123456789',
    ELEVENLABS_API_MOCK_ORIGIN: EL,
    OPENAI_API_KEY: SECRETS[2],
    VOICE_LAB_ENABLED: 'true',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === `${RETELL}/list-voices`) return json(200, [{ voice_id: 'retell-Cimo', voice_name: 'Cimo', provider: 'elevenlabs', gender: 'male' }])
    if (u === `${RETELL}/v3/create-web-call`) return json(201, { call_id: `call_${fetches.length}abcdef`, access_token: 'web_access_token', transport: 'gateway', ice_servers: [] })
    if (u.startsWith(`${RETELL}/v2/get-call/`)) {
      const id = decodeURIComponent(u.slice(`${RETELL}/v2/get-call/`.length))
      const r = retellCalls[id]
      return r ? json(r.status || 200, r.body) : json(404, { message: 'not found' })
    }
    if (u.startsWith(`${EL}/v2/voices`)) return json(200, { voices: [{ voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', labels: { gender: 'male' }, preview_url: 'https://x.example/eric.mp3' }], has_more: false })
    if (u.startsWith(`${EL}/v1/convai/conversation/get-signed-url`)) return json(200, { signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_el0123456789&conversation_signature=sig${fetches.length}` })
    if (u.startsWith(`${EL}/v1/convai/conversations/`)) {
      const id = decodeURIComponent(u.slice(`${EL}/v1/convai/conversations/`.length))
      const r = elConversations[id]
      return r ? json(r.status || 200, r.body) : json(404, { detail: { status: 'not_found' } })
    }
    if (u === `${EL}/v1/user/subscription`) return json(elSubscription.status, elSubscription.body)
    if (u === 'https://api.openai.com/v1/realtime/client_secrets') return json(200, { value: `ek_short_${fetches.length}`, expires_at: Math.floor(Date.now() / 1000) + 170, session: JSON.parse(init.body).session })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
  for (const r of responses) for (const s of SECRETS) assert.ok(!r.includes(s), 'a secret reached a response')
})

async function seed(id, { test = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run.', ?, ?, ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), JSON.stringify(['Charleston']), t)
  if (test) db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'staff', 1)").run(id)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
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
const start = (id, body, cookie) => call(voiceApi, 'POST', `/api/receptionist/${id}/voice`, { params: { customer: id }, body, cookie })
const sess = (id, s, body) => call(sessionApi, 'POST', `/api/receptionist/${id}/voice-session`, { params: { customer: id }, body: { id: s.conversationId, token: s.token, ...body } })
const state = (convId) => JSON.parse(db.sql.prepare('SELECT state FROM receptionist_conversations WHERE id = ?').get(convId).state)
const admin = { email: 'staff@getshowups.com' }
const day = () => Date.now() - (Date.now() % DAY)
// A finished call row of `minutes` today (created at the start of the day when the day is young enough).
const callRow = (customer, provider, minutes, { callId = `web_${Math.random().toString(36).slice(2, 14)}`, conversationId = 'convx', ended = true } = {}) => {
  const created = Math.max(day(), Date.now() - minutes * 60_000)
  db.sql.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(callId, customer, conversationId, provider, created, ended ? created + minutes * 60_000 : null)
  return callId
}
const voiceConv = (id, customer, provider, { test = true, endedAt = Date.now(), startedAt = Date.now() - 60_000, metrics = { durationSeconds: 60, micLive: 1, audioReceived: 1, medianResponseMs: 700, firstResponseMs: 900 }, tools = [], outcome = 'ended', disconnect = null, charge = null, estimatedMicros = 80_000, callId = null, providerSessionId = null, lab = false, createdAt = Date.now() - 60_000 } = {}) => {
  const v = { provider, startedAt, endedAt, test, metrics, outcome, ...(disconnect ? { disconnect } : {}), ...(charge ? { charge } : {}), estimatedMicros, ...(callId ? { callId } : {}), ...(providerSessionId ? { providerSessionId } : {}) }
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?, ?, 'voice', ?, '[]', ?, ?)").run(id, customer, JSON.stringify(lab ? { lab: { ...v, dryRun: true }, tools } : { voice: v, tools }), createdAt, createdAt)
}

test('limits: per-provider ceilings (default for OpenAI/ElevenLabs, Retell only with its own switch), the per-business test ceiling on the customer path AND the Lab, warnings at 80%, refusals at 100%; another test business is untouched', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await session('staff@getshowups.com')
  // Configuration → limits.
  assert.deepEqual([providerDailyLimit(env, 'openai'), providerDailyLimit(env, 'elevenlabs'), providerDailyLimit(env, 'retell'), testDailyMinutes(env)], [600, 600, null, 30])
  env.VOICE_PROVIDER_DAILY_MINUTES = '100'
  env.VOICE_PROVIDER_DAILY_MINUTES_ELEVENLABS = '5'
  env.VOICE_PROVIDER_DAILY_MINUTES_RETELL = '50'
  env.VOICE_TEST_DAILY_MINUTES = '10'
  assert.deepEqual([providerDailyLimit(env, 'openai'), providerDailyLimit(env, 'elevenlabs'), providerDailyLimit(env, 'retell'), testDailyMinutes(env), providerDailyLimit(env, 'nope')], [100, 5, 50, 10, null])
  assert.deepEqual(budgetState(8, 10), { used: 8, limit: 10, left: 2, share: 0.8, state: 'warn' })
  assert.deepEqual(budgetState(10, 10).state, 'exhausted')
  assert.deepEqual(budgetState(3, null).state, 'uncapped')
  // ElevenLabs platform-wide: 5 minutes used by a CUSTOMER session of beta → alpha's admin test on ElevenLabs is refused
  // (voice_limit), its Retell test still starts; OpenAI unaffected.
  callRow('beta', 'elevenlabs', 5)
  assert.equal(await providerMinutesToday(env, 'elevenlabs'), 5)
  assert.deepEqual([(await start('alpha', { test: { provider: 'elevenlabs' } }, staff)).status, (await start('alpha', { test: { provider: 'elevenlabs' } }, staff)).json().error], [429, 'voice_limit'])
  const ov = await budgetOverview(env)
  assert.deepEqual(ov.providers.find((p) => p.id === 'elevenlabs'), { id: 'elevenlabs', used: 5, limit: 5, left: 0, share: 1, state: 'exhausted', switch: 'VOICE_PROVIDER_DAILY_MINUTES_ELEVENLABS' })
  assert.deepEqual(ov.warnings, ['provider:elevenlabs:exhausted'])
  assert.equal((await start('alpha', { test: { provider: 'openai' } }, staff)).status, 200, 'OpenAI has its own budget')
  db.sql.prepare("UPDATE receptionist_calls SET ended_at = created_at WHERE provider = 'openai'").run() // zero-length, so the sums below are exact
  // Test ceiling per business: alpha has used 9 of 10 test minutes (a Lab call row + an admin test session row);
  // the overview warns; a 10th minute exhausts it: the customer-path test AND a Lab call are refused with test_limit,
  // while beta (0 used) still starts both. Customer sessions of alpha never count toward its test budget.
  const alphaLab = db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES ('alab', 'alpha', 'voice', ?, '[]', ?, ?)").run(JSON.stringify({ lab: { provider: 'retell', startedAt: 1, endedAt: 2 } }), Date.now(), Date.now())
  assert.ok(alphaLab)
  callRow('alpha', 'retell-lab', 4, { callId: 'lab_alpha1', conversationId: 'alab' })
  voiceConv('atest', 'alpha', 'openai', { test: true })
  callRow('alpha', 'openai', 5, { conversationId: 'atest' })
  voiceConv('acust', 'alpha', 'retell', { test: false })
  callRow('alpha', 'retell', 20, { callId: 'call_cust1', conversationId: 'acust' })
  assert.equal(await testMinutesToday(env, 'alpha'), 9)
  assert.equal(await testMinutesToday(env, 'beta'), 0, 'beta’s customer session is not test usage')
  const ov2 = await budgetOverview(env)
  const ta = ov2.testBusinesses.find((b) => b.id === 'alpha')
  assert.deepEqual([ta.used, ta.limit, ta.state, ta.business.used, ov2.warnings.includes('test:alpha:warn')], [9, 10, 'warn', 29, true])
  callRow('alpha', 'openai', 1, { conversationId: 'atest' })
  assert.deepEqual([(await start('alpha', { test: { provider: 'openai' } }, staff)).status, (await start('alpha', { test: { provider: 'openai' } }, staff)).json().error], [429, 'test_limit'])
  const lab = await startLabSession(env, admin, { customer: 'alpha', provider: 'openai' })
  assert.deepEqual([lab.ok, lab.error, lab.httpStatus], [false, 'test_limit', 429])
  assert.equal((await start('beta', { test: { provider: 'openai' } }, staff)).status, 200, 'beta is not alpha')
  const betaLab = await startLabSession(env, admin, { customer: 'beta', provider: 'openai' })
  assert.equal(betaLab.ok, true)
  // The Lab honours the provider ceiling too (Retell capped at 50 by its switch; a 50-minute Retell day → voice_limit).
  await endLabSession(env, await loadLabSession(env, 'beta', betaLab.session.id, betaLab.session.token), {})
  callRow('beta', 'retell', 30, { callId: 'call_r30' })
  assert.equal((await startLabSession(env, admin, { customer: 'beta', provider: 'retell' })).error, 'voice_limit')
  // An un-ended row counts at most the ceiling on the provider sum.
  callRow('beta', 'openai', 600, { ended: false, callId: 'web_open600' })
  assert.ok((await providerMinutesToday(env, 'openai')) <= Math.ceil(SESSION_CEILING_MS / 60_000) + 20)
})

test('verified charges: Retell’s call cost (cents) and ElevenLabs’ conversation cost (credits + USD when reported) are fetched read-only, attributed to the session they belong to and recorded as the provider’s numbers; errors are codes and record nothing; OpenAI is unsupported; a business filter never touches another business; audited', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await session('staff@getshowups.com')
  // Sessions with references: a Retell customer session (call id), an ElevenLabs test session (conversation id), one
  // without a reference, an OpenAI session, and beta's Retell session.
  voiceConv('r1', 'alpha', 'retell', { test: false, callId: 'call_alpha_r1' })
  voiceConv('e1', 'alpha', 'elevenlabs', { providerSessionId: 'conv_alpha_e1' })
  voiceConv('e2', 'alpha', 'elevenlabs', {})
  voiceConv('o1', 'alpha', 'openai', {})
  voiceConv('rb', 'beta', 'retell', { test: false, callId: 'call_beta_rb' })
  voiceConv('rl', 'beta', 'retell', { lab: true, callId: 'call_beta_lab' })
  retellCalls.call_alpha_r1 = { body: { call_id: 'call_alpha_r1', call_status: 'ended', call_cost: { combined_cost: 3.44, total_duration_seconds: 61, total_duration_unit_price: 0.0564, product_costs: [{ product: 'retell_platform', unit_price: 0.0167, cost: 1.02 }, { product: 'elevenlabs_tts', unit_price: 0.0233, cost: 1.42 }, { product: 'llm', cost: 1.0 }] } } }
  retellCalls.call_beta_rb = { body: { call_id: 'call_beta_rb', call_status: 'ongoing' } }
  retellCalls.call_beta_lab = { status: 500, body: {} }
  elConversations.conv_alpha_e1 = { body: { status: 'done', metadata: { call_duration_secs: 70, cost: 12, cost_fiat: 0.1234, charging: { llm_charge: 2, llm_price: 0.02, is_burst: false } } } }
  // Direct fetches: numbers in the provider's unit, nothing converted or invented.
  const r = await fetchCharge(env, 'retell', 'call_alpha_r1', 1000)
  assert.deepEqual(r, { ok: true, charge: { provider: 'retell', source: 'retell_call_cost', ref: 'call_alpha_r1', micros: 34_400, cents: 3.44, products: [{ product: 'retell_platform', cents: 1.02 }, { product: 'elevenlabs_tts', cents: 1.42 }, { product: 'llm', cents: 1 }], durationSeconds: 61, fetchedAt: 1000 } })
  const e = await fetchCharge(env, 'elevenlabs', 'conv_alpha_e1', 1000)
  assert.deepEqual(e, { ok: true, charge: { provider: 'elevenlabs', source: 'elevenlabs_conversation', ref: 'conv_alpha_e1', credits: 12, micros: 123_400, llmCredits: 2, llmMicros: 20_000, burst: false, durationSeconds: 70, fetchedAt: 1000 } })
  assert.deepEqual([(await fetchCharge(env, 'openai', 'x')).error, (await fetchCharge(env, 'retell', '')).error, (await fetchCharge(env, 'retell', 'call_beta_rb')).error, (await fetchCharge(env, 'retell', 'call_beta_lab')).error, (await fetchCharge(env, 'elevenlabs', 'conv_missing')).error], ['unsupported', 'no_reference', 'not_ended', 'http_500', 'not_found'])
  elConversations.conv_nocost = { body: { status: 'done', metadata: { call_duration_secs: 5 } } }
  assert.equal((await fetchCharge(env, 'elevenlabs', 'conv_nocost')).error, 'no_cost_yet')
  elConversations.conv_credits_only = { body: { status: 'done', metadata: { call_duration_secs: 30, cost: 7 } } }
  const co = (await fetchCharge(env, 'elevenlabs', 'conv_credits_only')).charge
  assert.deepEqual([co.credits, co.micros, co.llmCredits], [7, null, null], 'credits without a USD figure stay credits')
  assert.deepEqual([chargeRef('retell', { callId: 'c' }), chargeRef('elevenlabs', { providerSessionId: 'p' }), chargeRef('elevenlabs', { callId: 'c' }), chargeRef('openai', { callId: 'c' })], ['c', 'p', null, null])
  assert.deepEqual(CHARGE_SUPPORT, { retell: 'call_cost', elevenlabs: 'conversation', openai: null })
  // The admin action, alpha only: beta's rows are never read or written; the key never reaches the response.
  const before = db.sql.prepare("SELECT state FROM receptionist_conversations WHERE id = 'rb'").get().state
  const n0 = fetches.length
  const res = await call(labSessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'charges', customer: 'alpha' } })
  assert.equal(res.status, 200)
  const rj = res.json()
  assert.deepEqual([rj.candidates, rj.recorded, rj.errors, rj.skipped.unsupported, rj.skipped.no_reference], [3, 2, [], 0, 1])
  assert.equal(state('r1').voice.charge.micros, 34_400)
  assert.equal(state('e1').voice.charge.credits, 12)
  assert.equal(state('e2').voice.charge, undefined, 'nothing invented for a session without a reference')
  assert.equal(state('o1').voice.charge, undefined, 'OpenAI: not a candidate')
  assert.equal(db.sql.prepare("SELECT state FROM receptionist_conversations WHERE id = 'rb'").get().state, before, 'beta untouched')
  assert.ok(!fetches.slice(n0).some((f) => f.url.includes('call_beta')), 'no provider call for another business')
  assert.deepEqual(db.sql.prepare("SELECT action, customer FROM admin_audit WHERE action = 'voice_lab.charges_fetched'").all().map((r) => ({ ...r })), [{ action: 'voice_lab.charges_fetched', customer: 'alpha' }])
  // Platform-wide: beta's two are tried; the ongoing call and the 500 are recorded as errors (codes), retried only after an hour.
  const all = (await call(labSessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'charges' } })).json()
  assert.deepEqual([all.candidates, all.recorded, all.errors.map((x) => x.error).sort()], [3, 0, ['http_500', 'not_ended']])
  assert.deepEqual([state('rb').voice.charge.error, state('rl').lab.charge.error, state('rb').voice.charge.micros], ['not_ended', 'http_500', undefined])
  const again = (await call(labSessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: staff, body: { action: 'charges' } })).json()
  assert.equal(again.candidates, 1, 'failed lookups are not retried within the hour; the one without a reference stays a candidate')
  // Owners and anonymous users cannot trigger provider reads.
  const owner = await session('owner@alpha.example')
  assert.equal((await call(labSessionApi, 'POST', '/api/platform/voice-lab/session', { cookie: owner, body: { action: 'charges' } })).status, 403)
  assert.equal((await call(labSessionApi, 'POST', '/api/platform/voice-lab/session', { body: { action: 'charges' } })).status, 401)
})

test('provider session ids: the browser’s provider id is recorded once per session on the customer path and the Lab (well-formed only), travels with the end, and is what the charge is looked up by', async () => {
  await seed('alpha')
  const staff = await session('staff@getshowups.com')
  const s = (await start('alpha', { test: { provider: 'elevenlabs' } }, staff)).json()
  assert.deepEqual((await sess('alpha', s, { action: 'provider', providerSessionId: 'bad id!' })).json(), { ok: false, error: 'invalid_reference' })
  assert.deepEqual((await sess('alpha', s, { action: 'provider', providerSessionId: 'conv_0123456789' })).json(), { ok: true })
  assert.deepEqual((await sess('alpha', s, { action: 'provider', providerSessionId: 'conv_0123456789' })).json(), { ok: true, already: true })
  assert.deepEqual((await sess('alpha', s, { action: 'provider', providerSessionId: 'conv_other_9999' })).json(), { ok: false, error: 'already_recorded' })
  const end = (await sess('alpha', s, { action: 'end', metrics: {}, outcome: 'ended', providerSessionId: 'conv_other_9999' })).json()
  assert.equal(end.voice.providerSessionId, 'conv_0123456789', 'the first id stays')
  elConversations.conv_0123456789 = { body: { status: 'done', metadata: { call_duration_secs: 9, cost: 3, cost_fiat: 0.03 } } }
  const r = await recordCharges(env, { customer: 'alpha' })
  assert.deepEqual([r.recorded, state(s.conversationId).voice.charge.credits, state(s.conversationId).voice.charge.micros], [1, 3, 30_000])
  // Lab.
  const lab = await startLabSession(env, admin, { customer: 'alpha', provider: 'elevenlabs' })
  const ls = await loadLabSession(env, 'alpha', lab.session.id, lab.session.token)
  assert.deepEqual(await recordLabProviderSession(env, ls, 'conv_lab_000001'), { ok: true })
  const ended = await endLabSession(env, ls, { metrics: {}, providerSessionId: 'conv_ignored_1' })
  assert.equal(ended.summary.providerSessionId, 'conv_lab_000001')
  const lab2 = await startLabSession(env, admin, { customer: 'alpha', provider: 'elevenlabs' })
  const ls2 = await loadLabSession(env, 'alpha', lab2.session.id, lab2.session.token)
  assert.equal((await endLabSession(env, ls2, { metrics: {}, providerSessionId: 'conv_lab_000002' })).summary.providerSessionId, 'conv_lab_000002', 'an end may carry it when nothing was recorded before')
})

test('comparison and balances: per provider from session records of every kind (counts, failures, booking tool, latency, minutes, estimated vs verified cost, cost per session / per booking), incomplete sessions as codes; balances only where an API exists; the status route carries it all and refuses owners', async () => {
  await seed('alpha')
  await seed('beta')
  const staff = await session('staff@getshowups.com')
  const now = Date.now()
  const tools = (ok) => [{ name: 'find_available_times', ok: true, at: now }, { name: 'book_appointment', ok, at: now }]
  voiceConv('a1', 'alpha', 'elevenlabs', { tools: tools(true), metrics: { durationSeconds: 120, micLive: 1, audioReceived: 1, medianResponseMs: 800, firstResponseMs: 1000 }, estimatedMicros: 160_000, charge: { provider: 'elevenlabs', source: 'elevenlabs_conversation', credits: 20, micros: 200_000 } })
  voiceConv('a2', 'alpha', 'elevenlabs', { tools: tools(false), metrics: { durationSeconds: 60, micLive: 1, audioReceived: 1, medianResponseMs: 600, firstResponseMs: 700 }, estimatedMicros: 80_000 })
  voiceConv('a3', 'alpha', 'elevenlabs', { metrics: { durationSeconds: 3, micLive: 0, audioReceived: 0 }, outcome: 'provider_refused', disconnect: { phase: 'start', code: 'provider_refused', closeCode: 1008, reason: 'x' }, estimatedMicros: 4_000 })
  voiceConv('a4', 'alpha', 'elevenlabs', { endedAt: null, metrics: {}, estimatedMicros: null })
  voiceConv('b1', 'beta', 'retell', { test: false, tools: tools(true), metrics: { durationSeconds: 180 }, estimatedMicros: null, charge: { provider: 'retell', source: 'retell_call_cost', micros: 34_400, cents: 3.44 } })
  voiceConv('b2', 'beta', 'retell', { lab: true, metrics: { durationSeconds: 240 }, estimatedMicros: null, tools: [{ name: 'check_service_area', ok: true, at: now }] })
  voiceConv('old', 'alpha', 'elevenlabs', { createdAt: now - 40 * DAY, startedAt: now - 40 * DAY, endedAt: now - 40 * DAY + 1000, tools: tools(true) })
  const c = await providerComparison(env, { now })
  const el = c.providers.find((p) => p.id === 'elevenlabs')
  assert.deepEqual([el.sessions, el.finished, el.connectionFailures, el.failureRate, el.audioBothWays, el.availability, el.bookings, el.bookingRate, el.medianResponseMs, el.firstResponseMs, el.latencySessions, el.minutes], [4, 3, 1, 0.33, 2, 2, 1, 0.5, 600, 700, 2, 3.1], 'latency = the lower median across sessions that measured it')
  assert.deepEqual([el.estimatedMicros, el.verified, el.costPerSession, el.costPerBooking], [244_000, { sessions: 1, micros: 200_000, usdSessions: 1, credits: 20 }, { estimatedMicros: 81_333, verifiedMicros: 200_000 }, { estimatedMicros: 244_000, verifiedMicros: null }], 'verified per booking only when every finished session has a verified USD charge')
  const rt = c.providers.find((p) => p.id === 'retell')
  assert.deepEqual([rt.sessions, rt.finished, rt.bookings, rt.availability, rt.medianResponseMs, rt.latencySessions, rt.minutes, rt.estimatedMicros, rt.estimate, rt.verified.micros, rt.costPerSession, rt.costPerBooking], [2, 2, 1, 1, null, 0, 7, null, null, 34_400, { estimatedMicros: null, verifiedMicros: 34_400 }, { estimatedMicros: null, verifiedMicros: null }])
  const oa = c.providers.find((p) => p.id === 'openai')
  assert.deepEqual([oa.sessions, oa.finished, oa.failureRate, oa.costPerBooking.estimatedMicros], [0, 0, null, null])
  assert.deepEqual(c.counts, { connectionFailures: 1, incompleteBookings: 2 })
  assert.deepEqual(c.incomplete.map((r) => [r.id, r.reason, r.closeCode]).sort(), [['a2', 'no_booking', null], ['a3', 'connection:provider_refused', 1008], ['b2', 'no_availability', null]])
  assert.ok(!JSON.stringify(c).includes('transcript'), 'codes and counts only')
  // Balances: ElevenLabs' subscription read; Retell and OpenAI say they have none; a provider error is a code.
  const bal = await providerBalances(env, 5000)
  assert.deepEqual(bal.elevenlabs, { supported: true, source: 'elevenlabs_subscription', creditsUsed: 81_000, creditsLimit: 100_000, creditsLeft: 19_000, tier: 'creator', resetAt: elSubscription.body.next_character_count_reset_unix * 1000, fetchedAt: 5000 })
  assert.deepEqual([bal.retell.supported, bal.openai.supported, typeof bal.retell.note], [false, false, 'string'])
  elSubscription = { status: 401, body: { detail: 'nope' } }
  assert.deepEqual((await providerBalances(env, 1)).elevenlabs, { supported: true, error: 'auth_failed', fetchedAt: 1 })
  elSubscription = { status: 200, body: { character_count: 'many' } }
  assert.equal((await providerBalances(env, 1)).elevenlabs.error, 'bad_response')
  // The status route: comparison + budgets always, balances only on request; owners 403; the key never leaks.
  const st = (await call(labStatusApi, 'GET', '/api/platform/voice-lab/status', { cookie: staff })).json()
  assert.deepEqual([st.comparison.providers.length, typeof st.budgets.lab.limit, st.budgets.testBusinesses.map((b) => b.id).sort(), 'balances' in st, st.chargeSupport.openai], [3, 'number', ['alpha', 'beta'], false, null])
  const withBal = (await call(labStatusApi, 'GET', '/api/platform/voice-lab/status?balances=1', { cookie: staff })).json()
  assert.equal(withBal.balances.elevenlabs.supported, true)
  const owner = await session('owner@alpha.example')
  assert.equal((await call(labStatusApi, 'GET', '/api/platform/voice-lab/status?balances=1', { cookie: owner })).status, 403)
  const subscriptionReads = fetches.filter((f) => f.url === `${EL}/v1/user/subscription`).length
  assert.equal(subscriptionReads, 4, 'the subscription is read only when asked (3 direct + 1 route), never on a plain status load')
})
