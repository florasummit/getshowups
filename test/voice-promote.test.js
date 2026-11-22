// Promote a staged provider to 100% (server/voice/global.js checkGlobalPromotion / promoteGlobalProvider): rollout
// pins are released into following the default (never a permanent override), deliberate overrides only when included
// and acknowledged, provider-level verification (a finished production-path session on a test business) stands in for
// per-business tests (a WARNING acknowledged explicitly), real incompatibilities block all-or-nothing, the batch is
// guarded (a business changed under the checklist = nothing applied), sessions stay pinned, rollback restores pins and
// overrides, the route is admin-only with the provider typed back. Harness shared with test/voice-global.test.js.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { getVoiceSettings, saveVoicePreferences, switchProvider } from '../server/voice/settings.js'
import { checkGlobalPromotion, getGlobalDefault, globalOverview, promoteGlobalProvider, providerDistribution, providerVerification, rollbackGlobalProvider, switchGlobalProvider } from '../server/voice/global.js'
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

const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
const kinds = async () => Object.fromEntries((await providerDistribution(env)).businesses.map((b) => [b.id, `${b.provider}:${b.kind}`]))
const defaultsRows = () => db.sql.prepare('SELECT count(*) AS n FROM receptionist_voice_defaults').get().n
const versionsOf = () => Object.fromEntries(db.sql.prepare('SELECT customer, version FROM receptionist_voice_settings ORDER BY customer').all().map((r) => [r.customer, r.version]))

test('production shape: Retell → ElevenLabs staged pins all six; the promotion is blocked until the provider is verified on the production path; then one acknowledged, confirmed promotion releases all six pins into following ElevenLabs (no overrides created), a business created later inherits, a repeat is stale; ElevenLabs → OpenAI and OpenAI → Retell promotions move the rows; rollback restores the previous distribution', async () => {
  for (const id of ids) await seed(id)
  markTest('zeta')
  // Stage ElevenLabs: nobody is verified, so every business is pinned to Retell (what production did).
  const staged = await switchGlobalProvider(env, admin, { provider: 'elevenlabs', mode: 'staged', confirm: true, version: 0 })
  assert.equal(staged.ok, true, staged.error)
  assert.deepEqual([staged.applied, staged.global.pinned.map((p) => [p.customer, p.version, p.provider]).sort()], [{ switched: 0, pinned: 6, overrides: 0 }, ids.map((id) => [id, 1, 'retell']).sort()])
  assert.deepEqual(await kinds(), Object.fromEntries(ids.map((id) => [id, 'retell:pin'])))
  let ov = await globalOverview(env)
  assert.deepEqual([ov.current.provider, ov.counts.total, ov.counts.inherited, ov.counts.pins, ov.counts.independent, ov.counts.usingDefault, ov.rollout.sessions, ov.rollout.version], ['elevenlabs', 6, 0, 6, 0, 0, 0, 1])
  // Not verified on the production path yet: blocked at the provider level, every business listed as blocked by it.
  let check = await checkGlobalPromotion(env, { provider: 'elevenlabs' })
  assert.deepEqual([check.ok, check.blockers, check.verification.ok, check.verification.missing, check.counts.blocked, check.counts.pins], [false, ['provider_not_verified'], false, ['session', 'audio', 'tools', 'booking', 'clean_end'], 6, 6])
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 1 })).error, 'blocked')
  // A Lab session does not count as production-path verification; a finished admin test session on the test business does.
  db.sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES ('lab1', 'zeta', 'voice', ?, '[]', ?, ?)").run(JSON.stringify({ lab: { provider: 'elevenlabs', startedAt: 1, endedAt: 2, metrics: { micLive: 1, audioReceived: 1 } }, tools: [{ name: 'find_available_times', ok: true }, { name: 'book_appointment', ok: true }] }), Date.now(), Date.now())
  assert.equal((await providerVerification(env, 'elevenlabs')).ok, false, 'Lab sessions never stand for the production path')
  evidence('zeta', 'elevenlabs')
  const ver = await providerVerification(env, 'elevenlabs')
  assert.deepEqual([ver.ok, ver.finished, ver.businesses, ver.safeguards.concurrentSessions], [true, 1, ['zeta'], 3])
  check = await checkGlobalPromotion(env, { provider: 'elevenlabs' })
  assert.deepEqual([check.ok, check.blockers, check.counts.promote, check.counts.pinsToRelease, check.counts.unverified, check.counts.blocked, check.summary], [true, [], 6, 6, 5, 0, { total: 6, usingTarget: 0, pinsToRelease: 6, overridesToReplace: 0, overridesUntouched: 0, suspended: 0, blocked: 0, willChange: 6, newProvider: 'elevenlabs', previousProvider: 'elevenlabs' }])
  assert.deepEqual(check.warnings.map((w) => [w.code, w.count]), [['unverified', 5]])
  const zeta = check.businesses.find((b) => b.id === 'zeta')
  const alpha = check.businesses.find((b) => b.id === 'alpha')
  assert.deepEqual([zeta.status, zeta.action, zeta.kind, zeta.warnings, alpha.status, alpha.action, alpha.warnings, alpha.blockers], ['promote', 'release_pin', 'pin', [], 'promote', 'release_pin', ['unverified'], []])
  assert.ok(alpha.facts.some((f) => /seven receptionist tools/.test(f)) && alpha.facts.some((f) => /Calendar connected/.test(f)), 'verified facts are listed per business')
  // Guards, in order: admin, acknowledgement, confirmation, version. Nothing changes meanwhile.
  assert.equal((await promoteGlobalProvider(env, { email: 'owner@alpha.example' }, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 1 })).error, 'not_platform_admin')
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', confirm: true, version: 1 })).error, 'acknowledgement_required')
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, version: 1 })).error, 'confirmation_required')
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 0 })).error, 'stale')
  assert.deepEqual([defaultsRows(), await kinds()], [1, Object.fromEntries(ids.map((id) => [id, 'retell:pin']))])
  // The promotion: six pins released in ONE action; all six follow ElevenLabs; no override rows created.
  const pr = await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 1 })
  assert.equal(pr.ok, true, pr.error)
  assert.deepEqual([pr.applied, pr.global.version, pr.global.mode, pr.global.previous, pr.global.provider, pr.distribution.byProvider, pr.distribution.byKind], [{ promoted: 6, pinsReleased: 6, overridesReplaced: 0, moved: 0, excluded: 0, total: 6 }, 2, 'all', 'elevenlabs', 'elevenlabs', { retell: 0, openai: 0, elevenlabs: 6 }, { inherited: 6, pin: 0, override: 0 }])
  assert.deepEqual(pr.global.switched.map((m) => [m.customer, m.kind, m.from]).sort(), ids.map((id) => [id, 'pin', 'retell']).sort())
  assert.deepEqual(await kinds(), Object.fromEntries(ids.map((id) => [id, 'elevenlabs:inherited'])))
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM receptionist_voice_inherit').get().n, 6)
  assert.deepEqual([audits('receptionist.global_provider_promoted').length, audits('receptionist.provider_promoted').map((a) => a.customer).sort(), audits('receptionist.global_promotion_blocked').length], [1, [...ids].sort(), 1])
  assert.match(audits('receptionist.global_provider_promoted')[0].details, /"acknowledgedUnverified":5/)
  await seed('eta')
  assert.deepEqual((await kinds()).eta, 'elevenlabs:inherited')
  // The same request again applies nothing: the checklist finds nothing to promote (and the version moved anyway).
  const again = await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 1 })
  assert.deepEqual([again.error, again.check.blockers], ['blocked', ['no_change']])
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'openai', acknowledgeUnverified: true, confirm: true, version: 1 })).error, 'blocked', 'unverified provider')
  assert.equal(defaultsRows(), 2)
  ov = await globalOverview(env)
  assert.deepEqual([ov.counts.inherited, ov.counts.pins, ov.counts.usingDefault, ov.current.canRollBack, ov.rollout.provider, ov.rollout.businesses], [7, 0, 7, true, 'elevenlabs', 0])
  // ElevenLabs → OpenAI (verified on zeta): the seven rows move; then OpenAI → Retell.
  evidence('zeta', 'openai')
  const toOpenai = await promoteGlobalProvider(env, admin, { provider: 'openai', acknowledgeUnverified: true, confirm: true, version: 2 })
  assert.equal(toOpenai.ok, true, toOpenai.error)
  assert.deepEqual([toOpenai.applied.moved, toOpenai.applied.pinsReleased, toOpenai.distribution.byProvider, toOpenai.global.previous], [6, 0, { retell: 0, openai: 7, elevenlabs: 0 }, 'elevenlabs'])
  assert.deepEqual((await kinds()).eta, 'openai:inherited', 'a business without a row follows without any write')
  evidence('zeta', 'retell')
  const toRetell = await promoteGlobalProvider(env, admin, { provider: 'retell', acknowledgeUnverified: true, confirm: true, version: 3 })
  assert.equal(toRetell.ok, true, toRetell.error)
  assert.deepEqual([toRetell.distribution.byProvider, (await getGlobalDefault(db)).version], [{ retell: 7, openai: 0, elevenlabs: 0 }, 4])
  // Rollback of the last promotion: back to OpenAI for everyone (rows moved back), still following.
  const rb = await rollbackGlobalProvider(env, admin, { confirm: true, version: 4 })
  assert.equal(rb.ok, true, rb.error)
  assert.deepEqual([rb.global.provider, rb.global.mode, rb.undone, (await providerDistribution(env)).byProvider], ['openai', 'rollback', { unpinned: 0, moved: 6, pinsRestored: 0, overridesRestored: 0, kept: [] }, { retell: 0, openai: 7, elevenlabs: 0 }])
  assert.ok(!JSON.stringify([check, pr, toOpenai, toRetell, rb, ov]).match(/SECRET|owner@/), 'no secrets, no emails')
})

test('scope and incompatibilities: a deliberate override is excluded unless included (then replaced and restored by the rollback as an override); a voice chosen on another provider is a technical blocker that refuses the whole promotion (nothing changes); suspended businesses are excluded; a business that cannot book gets a warning, not a block; a business that changes under the checklist makes the guarded batch apply nothing', async () => {
  for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) await seed(id)
  markTest('alpha')
  evidence('alpha', 'elevenlabs')
  setProvider('gamma', 'openai') // a deliberate admin override (no inherit row, never pinned by a rollout)
  assert.equal((await saveVoicePreferences(env, await cust('delta'), { voiceId: 'retell-Cimo', version: 0 }, 'owner@delta.example')).ok, true) // a Retell voice while following
  kv.delete('google:epsilon') // cannot book on any provider
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'beta'").run()
  assert.deepEqual(await kinds(), { alpha: 'retell:inherited', beta: 'retell:inherited', gamma: 'openai:override', delta: 'retell:inherited', epsilon: 'retell:inherited' })
  let check = await checkGlobalPromotion(env, { provider: 'elevenlabs' })
  const by = (c) => Object.fromEntries(c.businesses.map((b) => [b.id, [b.status, b.action, b.reason || null, b.blockers, b.warnings]]))
  assert.deepEqual(by(check), {
    alpha: ['promote', 'follow', null, [], []],
    beta: ['excluded', 'none', 'suspended', [], []],
    gamma: ['excluded', 'none', 'override_not_included', [], []],
    delta: ['blocked', 'follow', null, ['voice_replacement_required'], ['unverified']],
    epsilon: ['promote', 'follow', null, [], ['booking_not_ready', 'unverified']],
  })
  assert.deepEqual([check.ok, check.blockers, check.counts.blocked, check.counts.excluded, check.summary.suspended, check.summary.overridesUntouched, check.warnings.map((w) => w.code)], [false, ['businesses_blocked'], 1, 2, 1, 1, ['unverified', 'booking_not_ready']])
  assert.equal((await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 0 })).error, 'blocked')
  assert.deepEqual([defaultsRows(), await kinds()], [0, { alpha: 'retell:inherited', beta: 'retell:inherited', gamma: 'openai:override', delta: 'retell:inherited', epsilon: 'retell:inherited' }])
  // The owner drops the Retell voice: delta is compatible now. Include the deliberate override: gamma is replaced.
  assert.equal((await saveVoicePreferences(env, await cust('delta'), { voiceId: '', version: 1 }, 'owner@delta.example')).ok, true)
  check = await checkGlobalPromotion(env, { provider: 'elevenlabs', includeOverrides: true })
  assert.deepEqual([check.ok, by(check).gamma, check.counts.overridesToReplace, check.summary.overridesUntouched], [true, ['promote', 'replace_override', null, [], ['unverified']], 1, 0])
  // Guarded batch: a business changes between the checklist and the write → the whole batch is refused, nothing applied.
  const origBatch = db.batch
  const before = versionsOf()
  db.batch = async (list) => {
    db.sql.prepare("UPDATE receptionist_voice_settings SET personality = 'warm', version = version + 1 WHERE customer = 'gamma'").run()
    return origBatch(list)
  }
  const raced = await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', includeOverrides: true, acknowledgeUnverified: true, confirm: true, version: 0 })
  db.batch = origBatch
  assert.deepEqual([raced.error, raced.version, defaultsRows(), db.sql.prepare('SELECT count(*) AS n FROM receptionist_voice_inherit').get().n], ['stale', 0, 0, 1], JSON.stringify(raced))
  assert.deepEqual(versionsOf(), { ...before, gamma: before.gamma + 1 }, 'only the simulated concurrent edit happened')
  assert.deepEqual((await kinds()).gamma, 'openai:override')
  // Now for real.
  const pr = await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', includeOverrides: true, acknowledgeUnverified: true, confirm: true, version: 0 })
  assert.equal(pr.ok, true, pr.error)
  assert.deepEqual([pr.applied, pr.distribution.byProvider], [{ promoted: 4, pinsReleased: 0, overridesReplaced: 1, moved: 1, excluded: 1, total: 5 }, { retell: 0, openai: 0, elevenlabs: 5 }])
  // beta is suspended: excluded from the checks and writes, but it has no provider of its own, so it follows the new default (no sessions while suspended).
  assert.deepEqual(await kinds(), { alpha: 'elevenlabs:inherited', beta: 'elevenlabs:inherited', gamma: 'elevenlabs:inherited', delta: 'elevenlabs:inherited', epsilon: 'elevenlabs:inherited' })
  assert.deepEqual(pr.global.switched.map((m) => [m.customer, m.kind, m.from]).sort(), [['delta', 'inherited', 'retell'], ['gamma', 'override', 'openai']])
  assert.deepEqual((await getVoiceSettings(db, 'gamma')).personality, 'warm', 'the owner edit survived')
  // Rollback: gamma is an OpenAI override again (not a pin), delta's row moves back, beta untouched.
  const rb = await rollbackGlobalProvider(env, admin, { confirm: true, version: 1 })
  assert.equal(rb.ok, true, rb.error)
  assert.deepEqual([rb.undone, await kinds(), rb.global.pinned], [{ unpinned: 0, moved: 1, pinsRestored: 0, overridesRestored: 1, kept: [] }, { alpha: 'retell:inherited', beta: 'retell:inherited', gamma: 'openai:override', delta: 'retell:inherited', epsilon: 'retell:inherited' }, []])
  assert.equal(inheritRow('gamma'), false)
})

test('a released pin whose owner then chooses a voice on the promoted provider is kept there by the rollback (reported); a pin restored by a rollback is still a rollout pin (released by the next promotion), while an admin switch after a pin makes it a deliberate override', async () => {
  for (const id of ['alpha', 'beta', 'gamma']) await seed(id)
  markTest('alpha')
  evidence('alpha', 'elevenlabs')
  assert.equal((await switchGlobalProvider(env, admin, { provider: 'elevenlabs', mode: 'staged', confirm: true, version: 0 })).ok, true)
  assert.deepEqual(await kinds(), { alpha: 'elevenlabs:inherited', beta: 'retell:pin', gamma: 'retell:pin' })
  // An admin switches gamma on purpose: no longer a rollout pin.
  evidence('gamma', 'openai')
  markTest('gamma')
  assert.equal((await switchProvider(env, await cust('gamma'), admin, { provider: 'openai', useDefaultVoice: true, confirm: true, version: 1 })).ok, true)
  assert.deepEqual((await kinds()).gamma, 'openai:override')
  const pr = await promoteGlobalProvider(env, admin, { provider: 'elevenlabs', acknowledgeUnverified: true, confirm: true, version: 1 })
  assert.equal(pr.ok, true, pr.error)
  assert.deepEqual([pr.applied.pinsReleased, pr.applied.excluded, await kinds()], [1, 1, { alpha: 'elevenlabs:inherited', beta: 'elevenlabs:inherited', gamma: 'openai:override' }])
  // beta's owner picks an ElevenLabs voice meanwhile; the rollback keeps beta on ElevenLabs as an override and says so.
  assert.equal((await saveVoicePreferences(env, await cust('beta'), { voiceId: 'cjVigY5qzO86Huf0OWal', version: 2 }, 'owner@beta.example')).ok, true)
  const rb = await rollbackGlobalProvider(env, admin, { confirm: true, version: 2 })
  assert.equal(rb.ok, true, rb.error)
  assert.deepEqual([rb.undone.kept, rb.global.provider, await kinds()], [[{ id: 'beta', reason: 'voice_on_new_provider' }], 'elevenlabs', { alpha: 'elevenlabs:inherited', beta: 'elevenlabs:pin', gamma: 'openai:override' }])
  assert.deepEqual((await getVoiceSettings(db, 'beta')).voiceName, 'Eric', 'the voice was never substituted')
  // A restored pin is released by the next promotion: stage OpenAI, promote it.
  const rb2 = await (async () => {
    evidence('alpha', 'openai')
    await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', confirm: true, version: 3 })
    return promoteGlobalProvider(env, admin, { provider: 'openai', includeOverrides: false, acknowledgeUnverified: true, confirm: true, version: 4 })
  })()
  assert.equal(rb2.error, 'blocked', 'beta keeps an ElevenLabs voice: a real incompatibility blocks the OpenAI promotion by name')
  assert.deepEqual(rb2.check.businesses.find((b) => b.id === 'beta').blockers, ['voice_replacement_required'])
})

test('sessions stay pinned across a promotion and concurrent businesses stay isolated; the console route needs a platform admin, same origin, the provider typed back, the acknowledgement and the version; the GET checklist is read-only', async () => {
  await seed('alpha')
  await seed('beta')
  markTest('beta')
  evidence('beta', 'openai')
  env.RECEPTIONIST_VOICE_CONCURRENT = '10'
  assert.equal((await switchGlobalProvider(env, admin, { provider: 'openai', mode: 'staged', confirm: true, version: 0 })).ok, true)
  assert.deepEqual(await kinds(), { alpha: 'retell:pin', beta: 'openai:inherited' })
  const running = (await start('alpha')).json()
  assert.equal(running.provider, 'retell')
  const staff = await session(ADMIN)
  const owner = await session('owner@alpha.example')
  const post = (body, cookie = staff, origin = ORIGIN) => call(consoleApi, 'POST', '/api/platform/voice-provider', { cookie, origin, body })
  assert.equal((await post({ action: 'global_promote_check' }, null)).status, 401)
  assert.equal((await post({ action: 'global_promote_check' }, owner)).status, 403)
  assert.equal((await call(consoleApi, 'GET', '/api/platform/voice-provider?global_promote_check=openai', { cookie: owner })).status, 403)
  assert.equal((await post({ action: 'global_promote', confirmProvider: 'openai', acknowledgeUnverified: true, confirm: true, version: 1 }, owner)).status, 403)
  assert.equal((await post({ action: 'global_promote', confirmProvider: 'openai', acknowledgeUnverified: true, confirm: true, version: 1 }, staff, 'https://evil.example')).status, 403)
  assert.deepEqual([(await post({ action: 'global_promote', confirmProvider: 'retell', acknowledgeUnverified: true, confirm: true, version: 1 })).status, (await post({ action: 'global_promote', acknowledgeUnverified: true, confirm: true, version: 1 })).json().error], [400, 'confirm_provider_mismatch'])
  assert.deepEqual([(await post({ action: 'global_promote', confirmProvider: 'openai', confirm: true, version: 1 })).status, (await post({ action: 'global_promote', confirmProvider: 'openai', confirm: true, version: 1 })).json().error], [409, 'acknowledgement_required'])
  assert.deepEqual([(await post({ action: 'global_promote', confirmProvider: 'openai', acknowledgeUnverified: true, confirm: true, version: 0 })).status, (await post({ action: 'global_promote', confirmProvider: 'openai', acknowledgeUnverified: true, confirm: true, version: 0 })).json().error], [409, 'stale'])
  const chk = await call(consoleApi, 'GET', '/api/platform/voice-provider?global_promote_check=openai', { cookie: staff })
  assert.deepEqual([chk.status, chk.json().check.ok, chk.json().check.counts.pinsToRelease, chk.json().check.counts.unverified], [200, true, 1, 1])
  assert.deepEqual([(await getGlobalDefault(db)).version, await kinds()], [1, { alpha: 'retell:pin', beta: 'openai:inherited' }], 'nothing changed')
  const pr = await post({ action: 'global_promote', confirmProvider: 'OpenAI', acknowledgeUnverified: true, confirm: true, version: 1 })
  assert.equal(pr.status, 200, JSON.stringify(pr.json()))
  assert.deepEqual([pr.json().global.current.provider, pr.json().global.current.version, pr.json().applied.pinsReleased, pr.json().distribution.byProvider, pr.json().businesses.find((b) => b.id === 'alpha').inherited], ['openai', 2, 1, { retell: 0, openai: 2, elevenlabs: 0 }, true])
  // The running Retell session is still Retell; a NEW alpha session is OpenAI; beta runs at the same time, isolated.
  assert.equal(state(running.conversationId).voice.provider, 'retell')
  assert.equal((await connect('alpha', running)).json().error, 'wrong_provider')
  const [a, b] = await Promise.all([start('alpha'), start('beta')])
  assert.deepEqual([a.json().provider, b.json().provider, state(a.json().conversationId).voice.provider, db.sql.prepare('SELECT customer FROM receptionist_conversations WHERE id = ?').get(b.json().conversationId).customer], ['openai', 'openai', 'openai', 'beta'])
  assert.equal((await call(connectApi, 'POST', '/api/receptionist/beta/voice-connect', { params: { customer: 'beta' }, body: { id: a.json().conversationId, token: a.json().token } })).status, 404, 'another business never reaches the session')
  // The overview's rollout status counts the new sessions on the promoted provider since the promotion.
  const g = (await call(consoleApi, 'GET', '/api/platform/voice-provider', { cookie: staff })).json().global
  assert.deepEqual([g.rollout.provider, g.rollout.sessions, g.rollout.businesses, g.rollout.inProgress, g.rollout.connectionFailures, g.counts.pins, g.counts.usingDefault], ['openai', 2, 2, 2, 0, 0, 2])
  const rb = await post({ action: 'global_rollback', confirmProvider: 'openai', confirm: true, version: 2 })
  assert.equal(rb.status, 200, JSON.stringify(rb.json()))
  assert.deepEqual([rb.json().undone.pinsRestored, await kinds(), state(a.json().conversationId).voice.provider], [1, { alpha: 'retell:pin', beta: 'openai:inherited' }, 'openai'])
})
