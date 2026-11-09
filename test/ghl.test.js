// GoHighLevel one-way sync: owner config (verify, encrypt, hide token), idempotent contact +
// opportunity creation, one-time workflow enrollment, stage updates, retry/error handling, tenant
// isolation, no PII/token leakage, and the smsHandledByGhl switch. node:sqlite D1, Map KV, mocked GHL.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { sha256Hex } from '../server/google-oauth.js'
import { GHL_BASE, ghlBase, getGhlConfig, smsHandledByGhl, syncLead, syncStage } from '../server/ghl.js'
import * as route from '../functions/api/dashboard/ghl.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const TOKEN = 'pit-0123456789abcdef0123456789abcdef'
const STAGES = { new: 'st_new', booked: 'st_booked', showed: 'st_showed', noShow: 'st_noshow', completed: 'st_done' }
const CONFIG = { token: TOKEN, locationId: 'loc_1', pipelineId: 'pipe_1', stageIds: STAGES, smsVia: 'getshowups' }
const LEAD = { name: 'Jamie Rivera', email: 'lead@example.net', phone: '555-010-0199', need: 'Weekly pool cleaning', zip: '29403' }

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q) }
}

let env, db, kv, calls, logs, responses, script, origFetch, origError, origLog

function seed(id, owner) {
  const now = Date.now()
  db.sql
    .prepare(
      "INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)",
    )
    .run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}
function addLead(id, customer, status = 'new') {
  db.sql
    .prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'h', 1, 1)")
    .run(id, customer, LEAD.name, LEAD.email, LEAD.phone, LEAD.need, LEAD.zip, status)
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  script = {} // "METHOD /path" → array of [status, body] served once each before the default
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    MESSAGE_TEST_RECIPIENTS: 'lead@example.net',
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  let n = 0
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    assert.equal(u.origin, GHL_BASE, 'only GHL is called')
    const key = `${init.method} ${u.pathname}`
    calls.push({ key, search: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
    const queued = script[key]?.shift()
    if (queued === 'throw') throw new TypeError('fetch failed')
    if (queued) return new Response(JSON.stringify(queued[1]), { status: queued[0] })
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return new Response('{"message":"Invalid JWT"}', { status: 401 })
    let out
    if (key === 'GET /opportunities/pipelines') out = { pipelines: [{ id: 'pipe_1', name: 'Leads', stages: Object.values(STAGES).map((id) => ({ id })) }] }
    else if (key === 'POST /contacts/upsert') out = { new: true, contact: { id: `ct_${++n}` } }
    else if (key === 'POST /opportunities') out = { opportunity: { id: `op_${++n}` } }
    else if (key.startsWith('PUT /opportunities/')) out = { opportunity: { id: u.pathname.split('/').pop() } }
    else if (/^POST \/contacts\/[^/]+\/workflow\//.test(key)) out = { succeeded: true }
    else throw new Error(`unexpected ${key}`)
    return new Response(JSON.stringify(out), { status: 200 })
  }
  logs = []
  responses = []
  origError = console.error
  origLog = console.log
  console.error = console.log = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  console.log = origLog
  const out = [...logs, ...responses].join('\n')
  for (const secret of [TOKEN, LEAD.email, LEAD.phone, LEAD.name]) assert.ok(!out.includes(secret), 'no token or lead PII in logs/responses')
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function req(method, { cookie, body, origin = ORIGIN } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && origin) headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await route[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(`${ORIGIN}/api/dashboard/ghl`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, json: JSON.parse(text) }
}
const connect = async (customer, extra = {}) => {
  const r = await req('POST', { cookie: await session(`owner@${customer}.example`), body: { ...CONFIG, ...extra } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  calls.length = 0
}
const count = (prefix) => calls.filter((c) => c.key.startsWith(prefix)).length
const links = (customer) => db.sql.prepare('SELECT entity, local_id, ghl_id FROM ghl_links WHERE customer = ? ORDER BY local_id').all(customer)

// ---------- config ----------

test('config: owner saves after one verify call; token encrypted at rest; GET hides it', async () => {
  const cookie = await session('owner@pools.example')
  const r = await req('POST', { cookie, body: CONFIG })
  assert.equal(r.status, 200)
  assert.equal(r.json.connected, true)
  assert.equal(r.json.token, undefined)
  assert.deepEqual(calls.map((c) => c.key), ['GET /opportunities/pipelines'])
  assert.equal(calls[0].search, '?locationId=loc_1')
  assert.equal(calls[0].headers.Version, 'v3')
  assert.ok(!kv.get('ghl:pools').includes(TOKEN), 'stored encrypted')
  const g = await req('GET', { cookie })
  assert.deepEqual(g.json, { connected: true, locationId: 'loc_1', pipelineId: 'pipe_1', stageIds: STAGES, workflowId: null, smsVia: 'getshowups', savedAt: g.json.savedAt })
  assert.equal((await getGhlConfig(env, 'pools')).token, TOKEN)
})

test('config: invalid token (401/403) → invalid_token, nothing stored', async () => {
  const cookie = await session('owner@pools.example')
  for (const status of [401, 403]) {
    script['GET /opportunities/pipelines'] = [[status, { message: 'Unauthorized' }]]
    const r = await req('POST', { cookie, body: CONFIG })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'invalid_token')
  }
  assert.equal(kv.has('ghl:pools'), false)
})

test('config: unknown pipeline, bad input, and sms via ghl without workflow are rejected', async () => {
  const cookie = await session('owner@pools.example')
  assert.equal((await req('POST', { cookie, body: { ...CONFIG, pipelineId: 'pipe_x' } })).json.error, 'pipeline_not_found')
  assert.equal((await req('POST', { cookie, body: { ...CONFIG, stageIds: { ...STAGES, noShow: '' } } })).json.error, 'invalid_stages')
  assert.equal((await req('POST', { cookie, body: { ...CONFIG, token: 'short' } })).json.error, 'invalid_token_format')
  assert.equal((await req('POST', { cookie, body: { ...CONFIG, smsVia: 'ghl' } })).json.error, 'workflow_required_for_sms')
  assert.equal(kv.has('ghl:pools'), false)
})

test('config: signed-out and cross-origin requests are refused; disconnect removes it', async () => {
  assert.equal((await req('GET', {})).status, 401)
  assert.equal((await req('POST', { body: CONFIG })).status, 401)
  const cookie = await session('owner@pools.example')
  assert.equal((await req('POST', { cookie, body: CONFIG, origin: 'https://evil.example' })).status, 403)
  assert.equal((await req('POST', { cookie, body: CONFIG, origin: null })).status, 403)
  assert.equal(calls.length, 0)
  await connect('pools')
  const d = await req('POST', { cookie, body: { disconnect: true } })
  assert.deepEqual(d.json, { connected: false })
  assert.equal(kv.has('ghl:pools'), false)
  assert.equal((await req('GET', { cookie })).json.connected, false)
})

test('config: one owner cannot read or change another business', async () => {
  await connect('pools')
  const salon = await session('owner@salon.example')
  assert.equal((await req('GET', { cookie: salon })).json.connected, false)
  await req('POST', { cookie: salon, body: { disconnect: true } })
  assert.equal(kv.has('ghl:pools'), true)
  kv.set('ghl:salon', kv.get('ghl:pools')) // a config copied under another key is not honored
  assert.equal(await getGhlConfig(env, 'salon'), null)
})

// ---------- sync ----------

test('syncLead: not connected is a no-op', async () => {
  addLead('L1', 'pools')
  assert.deepEqual(await syncLead(env, 'pools', 'L1'), { ok: true, skipped: 'not_connected' })
  assert.equal(calls.length, 0)
})

test('syncLead: creates one contact and one opportunity; reruns create no duplicates', async () => {
  await connect('pools')
  addLead('L1', 'pools')
  assert.deepEqual(await syncLead(env, 'pools', 'L1'), { ok: true })
  const upsert = calls.find((c) => c.key === 'POST /contacts/upsert').body
  assert.equal(upsert.locationId, 'loc_1')
  assert.equal(upsert.firstName, 'Jamie')
  assert.equal(upsert.lastName, 'Rivera')
  const opp = calls.find((c) => c.key === 'POST /opportunities').body
  assert.deepEqual([opp.pipelineId, opp.pipelineStageId, opp.status, opp.contactId], ['pipe_1', 'st_new', 'open', 'ct_1'])
  for (let i = 0; i < 3; i++) assert.equal((await syncLead(env, 'pools', 'L1')).ok, true)
  assert.equal(count('POST /contacts/upsert'), 1)
  assert.equal(count('POST /opportunities'), 1)
  assert.deepEqual(links('pools').map((l) => l.entity), ['contact', 'opportunity'])
})

test('syncLead: workflow enrollment happens once; test mode holds non-allowlisted leads', async () => {
  await connect('pools', { workflowId: 'wf_1', smsVia: 'ghl' })
  addLead('L1', 'pools')
  await syncLead(env, 'pools', 'L1')
  await syncLead(env, 'pools', 'L1')
  assert.equal(count('POST /contacts/ct_1/workflow/wf_1'), 1)

  env.MESSAGE_TEST_RECIPIENTS = 'someone-else@example.org'
  addLead('L2', 'pools')
  assert.deepEqual(await syncLead(env, 'pools', 'L2'), { ok: true, skipped: 'test_mode', contactCreated: true })
  assert.equal(calls.filter((c) => c.key.includes('/workflow/')).length, 1, 'no enrollment outside the allowlist')
})

test('syncStage: moves through booked → showed → completed with job value', async () => {
  await connect('pools')
  addLead('L1', 'pools')
  await syncLead(env, 'pools', 'L1')
  assert.deepEqual(await syncStage(env, 'pools', 'L1', 'booked'), { ok: true })
  await syncStage(env, 'pools', 'L1', 'showed')
  await syncStage(env, 'pools', 'L1', 'completed', 45000)
  const puts = calls.filter((c) => c.key === 'PUT /opportunities/op_2').map((c) => c.body)
  assert.deepEqual(puts, [
    { pipelineStageId: 'st_booked', status: 'open' },
    { pipelineStageId: 'st_showed', status: 'open' },
    { pipelineStageId: 'st_done', status: 'won', monetaryValue: 450 },
  ])
  await syncStage(env, 'pools', 'L1', 'noShow')
  assert.deepEqual(calls.at(-1).body, { pipelineStageId: 'st_noshow', status: 'lost' })
  assert.equal((await syncStage(env, 'pools', 'L1', 'paid')).error, 'invalid_stage')
  assert.equal((await syncStage(env, 'pools', 'L1', 'completed', -5)).error, 'invalid_value')
})

test('syncStage: syncs the lead first when it was never copied', async () => {
  await connect('pools')
  addLead('L1', 'pools', 'booked')
  assert.deepEqual(await syncStage(env, 'pools', 'L1', 'booked'), { ok: true })
  assert.equal(count('POST /opportunities'), 1)
  assert.equal(calls.find((c) => c.key === 'POST /opportunities').body.pipelineStageId, 'st_booked')
})

test('retry: one jittered retry on 429 succeeds; repeated 5xx returns an error without throwing', async () => {
  await connect('pools')
  addLead('L1', 'pools')
  script['POST /contacts/upsert'] = [[429, { message: 'Too many' }]]
  assert.deepEqual(await syncLead(env, 'pools', 'L1'), { ok: true })
  assert.equal(count('POST /contacts/upsert'), 2)

  addLead('L2', 'pools')
  script['POST /contacts/upsert'] = [[502, {}], [503, {}]]
  assert.deepEqual(await syncLead(env, 'pools', 'L2'), { ok: false, error: 'provider_error' })
  script['POST /contacts/upsert'] = ['throw', 'throw']
  assert.deepEqual(await syncLead(env, 'pools', 'L2'), { ok: false, error: 'network_error' })
  assert.equal(links('pools').filter((l) => l.local_id === 'L2').length, 0)
  // Later success still links exactly once.
  assert.equal((await syncLead(env, 'pools', 'L2')).ok, true)
  assert.equal(links('pools').filter((l) => l.local_id === 'L2').length, 2)
})

test('isolation: a business cannot sync or stage another business lead', async () => {
  await connect('pools')
  await connect('salon')
  addLead('L1', 'pools')
  assert.deepEqual(await syncLead(env, 'salon', 'L1'), { ok: false, error: 'lead_not_found' })
  await syncLead(env, 'pools', 'L1')
  calls.length = 0
  assert.equal((await syncStage(env, 'salon', 'L1', 'booked')).ok, false)
  assert.equal(count('PUT '), 0)
  assert.equal(links('salon').length, 0)
})

test('smsHandledByGhl: true only when connected with smsVia ghl and a workflow', async () => {
  assert.equal(await smsHandledByGhl(env, 'pools'), false)
  await connect('pools')
  assert.equal(await smsHandledByGhl(env, 'pools'), false)
  await connect('pools', { workflowId: 'wf_1', smsVia: 'ghl' })
  assert.equal(await smsHandledByGhl(env, 'pools'), true)
  assert.equal(await smsHandledByGhl(env, 'salon'), false)
})

test('ghlBase: mock origin is honored only for loopback', () => {
  assert.equal(ghlBase({}), GHL_BASE)
  assert.equal(ghlBase({ GHL_API_MOCK_ORIGIN: 'http://127.0.0.1:8787' }), 'http://127.0.0.1:8787')
  assert.equal(ghlBase({ GHL_API_MOCK_ORIGIN: 'https://evil.example' }), GHL_BASE)
})
