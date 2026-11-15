// Bring-your-own AI key (server/ai-credentials.js, server/ai-providers.js, /api/dashboard/ai-key) and its use by the
// website writer. Provider APIs are mocked through fetch (the Anthropic SDK uses global fetch). No network, no real keys.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { openKey, sealKey } from '../server/ai-credentials.js'
import { strictSchema } from '../server/ai-providers.js'
import { schemaFor } from '../server/website-ai.js'
import * as aiKey from '../functions/api/dashboard/ai-key.js'
import * as website from '../functions/api/dashboard/website/index.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
const CLAUDE_KEY = 'sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ'
const OPENAI_KEY = 'sk-proj-' + 'B'.repeat(40) + 'QRST'
let env, db, kv, calls, providerReply, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
function seed(id, owner) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Pools`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '', 'Pool service', '', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$180+' }]), now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, origin = ORIGIN } = {}) {
  const h = {}
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}/x`, { method, headers: h, body: body && JSON.stringify(body) }), env })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text), text }
}
const generated = (extra = {}) => ({
  headline: 'Clear, safe pools in Charleston',
  intro: 'Weekly pool care from a local team. Satisfaction guaranteed.',
  about: 'We look after pools across Charleston.',
  services: [{ name: 'Weekly pool care', description: 'Skimming, brushing and balanced water.' }],
  seoTitle: 'Pool care in Charleston',
  seoDescription: 'Weekly pool care in Charleston, booked online.',
  designs: [0, 1, 2].map((i) => ({ name: `Option ${i}`, palette: ['lagoon', 'navy', 'midnight'][i], fonts: 'modern', hero: 'typographic', services: 'cards', about: 'plain', shape: 'soft', sections: ['services', 'about'], heroImage: 'none', aboutImage: 'none' })),
  ...extra,
})

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  providerReply = null
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const u = new URL(req.url)
    const body = req.method === 'POST' ? await req.clone().json().catch(() => null) : null
    const headers = Object.fromEntries(req.headers)
    calls.push({ host: u.hostname, path: u.pathname, headers, body })
    const auth = headers['x-api-key'] || (headers.authorization || '').replace(/^Bearer /, '')
    const bad = auth.includes('BAD')
    if (u.hostname === 'api.anthropic.com') {
      if (bad) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })
      if (u.pathname === '/v1/models') return Response.json({ data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false, first_id: 'a', last_id: 'a' })
      if (u.pathname === '/v1/messages') {
        if (providerReply?.status) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'credit' } }, { status: providerReply.status })
        return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: providerReply?.stop || 'end_turn', content: [{ type: 'text', text: JSON.stringify(providerReply?.raw || generated()) }], usage: { input_tokens: 1200, output_tokens: 900 } })
      }
    }
    if (u.hostname === 'api.openai.com') {
      if (bad) return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })
      if (u.pathname === '/v1/models') return Response.json({ data: [] })
      if (u.pathname === '/v1/chat/completions') {
        if (providerReply?.status) return Response.json({ error: { code: providerReply.code } }, { status: providerReply.status })
        return Response.json({ model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(providerReply?.raw || generated()) } }], usage: { prompt_tokens: 1000, completion_tokens: 800 } })
      }
    }
    throw new Error(`unexpected fetch ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

test('sealed keys: encrypted under a derived key and bound to business + provider; never stored in plain text', async () => {
  const sealed = await sealKey(env, 'pools', 'anthropic', CLAUDE_KEY)
  assert.ok(!sealed.includes('sk-ant') && !sealed.includes('WXYZ'))
  assert.equal(await openKey(env, 'pools', 'anthropic', sealed), CLAUDE_KEY)
  await assert.rejects(openKey(env, 'salon', 'anthropic', sealed), 'another business cannot open it')
  await assert.rejects(openKey(env, 'pools', 'openai', sealed), 'another provider cannot open it')
  await assert.rejects(openKey({ ...env, TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)) }, 'pools', 'anthropic', sealed), 'a different master key cannot open it')
})

test('API: validated before storing, never returned, owner-only, isolated, removable, rate-limited', async () => {
  const c = await cookieFor('owner@pools.example')
  assert.equal((await call(aiKey, 'POST', { body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })).status, 401)
  assert.equal((await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY }, origin: 'https://evil.example' })).status, 403)
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: 'hello' } })).json, { error: 'invalid_key_format' })
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'grok', key: CLAUDE_KEY } })).json, { error: 'invalid_provider' })
  const bad = await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: 'sk-ant-api03-BAD' + 'x'.repeat(30) } })
  assert.deepEqual([bad.status, bad.json.error], [400, 'invalid_key'])
  assert.equal(db.sql.prepare('SELECT count(*) n FROM ai_credentials').get().n, 0, 'invalid keys are never stored')

  const ok = await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  assert.equal(ok.status, 200)
  assert.deepEqual({ ...ok.json.key, validatedAt: 0 }, { provider: 'anthropic', label: 'Claude (Anthropic)', hint: 'WXYZ', status: 'ok', validatedAt: 0 })
  assert.ok(calls.some((x) => x.host === 'api.anthropic.com' && x.path === '/v1/models' && (x.headers['x-api-key'] || x.headers.authorization) === (x.headers['x-api-key'] ? CLAUDE_KEY : `Bearer ${CLAUDE_KEY}`)), 'validated with a read-only call')
  const row = db.sql.prepare('SELECT * FROM ai_credentials').get()
  assert.ok(!JSON.stringify(row).includes(CLAUDE_KEY.slice(0, 20)), 'not stored in plain text')
  for (const r of [ok, await call(aiKey, 'GET', { cookie: c }), await call(website, 'GET', { cookie: c })]) assert.ok(!r.text.includes(CLAUDE_KEY.slice(0, 20)), 'never returned')
  assert.equal((await call(website, 'GET', { cookie: c })).json.aiKey.hint, 'WXYZ')
  assert.equal((await call(aiKey, 'GET', { cookie: await cookieFor('owner@salon.example') })).json.key, null, 'isolated')
  // Replace with OpenAI, then remove.
  assert.equal((await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'openai', key: OPENAI_KEY } })).json.key.provider, 'openai')
  assert.equal(db.sql.prepare('SELECT count(*) n FROM ai_credentials').get().n, 1)
  assert.equal((await call(aiKey, 'POST', { cookie: c, body: { action: 'remove' } })).json.key, null)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM ai_credentials').get().n, 0)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM audit_log WHERE action IN ('ai.key_saved', 'ai.key_removed')").get().n, 3)
  for (let i = 0; i < 10; i++) await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  assert.equal((await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })).status, 429)
})

test('generation with the own Claude key: Opus 5.5 + strict JSON schema + refusal fallback; output still filtered; billed to the owner, not us', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  const r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.generation.source, 'ai')
  const req = calls.find((x) => x.path === '/v1/messages')
  assert.ok(req.headers['x-api-key'] === CLAUDE_KEY || req.headers.authorization === `Bearer ${CLAUDE_KEY}`, 'sent with the business’s own key')
  assert.equal(req.body.model, 'claude-opus-5-5')
  assert.equal(req.body.fallbacks, 'default')
  assert.equal(req.body.output_config.format.type, 'json_schema')
  assert.equal(req.body.output_config.format.schema.additionalProperties, false)
  assert.deepEqual(req.body.output_config.format.schema.required.sort(), Object.keys(schemaFor([]).properties).sort())
  assert.ok(!('tool_choice' in req.body), 'no forced tool use (unsupported on Opus 5.5)')
  assert.match(req.body.system, /Facts|facts|claims|invent/i)
  assert.ok(!/guaranteed/i.test(JSON.stringify(r.json.generation.content)), 'the claims filter still applies to the model output')
  const g = db.sql.prepare('SELECT model, cost_micros, input_tokens FROM website_generations').get()
  assert.deepEqual({ ...g }, { model: 'anthropic:claude-opus-5-5', cost_micros: 0, input_tokens: 1200 })
  assert.ok(!calls.some((x) => x.host !== 'api.anthropic.com'), 'the included model was not used')
})

test('own-key errors are explained, the dead key is marked, and nothing falls back silently; OpenAI path uses strict json_schema', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  providerReply = { status: 400 }
  assert.deepEqual((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.error, 'provider_rejected')
  providerReply = { stop: 'refusal' }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'make it bolder' } })).json.error, 'ai_declined')
  providerReply = { raw: generated({ designs: 'not an array' }) }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 200, 'malformed designs are repaired from presets')
  // Key revoked at the provider after saving → 400 invalid_key, marked, not retried.
  db.sql.prepare('UPDATE ai_credentials SET sealed = ?1').run(await sealKey(env, 'pools', 'anthropic', 'sk-ant-api03-BAD' + 'x'.repeat(30)))
  providerReply = null
  const dead = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.deepEqual([dead.status, dead.json.error], [400, 'invalid_key'])
  assert.equal(db.sql.prepare('SELECT status FROM ai_credentials').get().status, 'invalid')
  assert.equal((await call(website, 'GET', { cookie: c })).json.aiKey.status, 'invalid')

  // OpenAI.
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'openai', key: OPENAI_KEY } })
  const r = await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'more premium' } })
  assert.equal(r.status, 200)
  const req = calls.findLast((x) => x.path === '/v1/chat/completions')
  assert.equal(req.headers.authorization, `Bearer ${OPENAI_KEY}`)
  assert.equal(req.body.response_format.type, 'json_schema')
  assert.equal(req.body.response_format.json_schema.strict, true)
  assert.equal(req.body.response_format.json_schema.schema.properties.design.additionalProperties, false)
  providerReply = { status: 429, code: 'insufficient_quota' }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'x' } })).json.error, 'provider_rejected')
})

test('strictSchema closes every object and lists every property as required', () => {
  const s = strictSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' } } } } } })
  assert.deepEqual(s, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' } }, additionalProperties: false, required: ['c'] } } }, additionalProperties: false, required: ['a', 'b'] })
})
