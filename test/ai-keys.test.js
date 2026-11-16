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
import { anthropicSchemaProblems } from './schema-limits.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
const CLAUDE_KEY = 'sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ'
const OPENAI_KEY = 'sk-proj-' + 'B'.repeat(40) + 'QRST'
let env, db, kv, calls, providerReply, origFetch, accounts
// Exactly these models are tested in a test (the shipped seed marks others tested; pinned in its own test below).
const testedModels = (ids) => {
  db.sql.prepare("UPDATE ai_model_registry SET status = 'supported' WHERE status = 'tested'").run()
  db.sql.prepare(`UPDATE ai_model_registry SET status = 'tested' WHERE model IN (${ids.map(() => '?').join(',')})`).run(...ids)
}

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
  // What each provider account offers (tests change it to simulate new or retired models).
  accounts = {
    anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-legacy-2'],
    openai: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4.1', 'gpt-5-mini', 'gpt-4o-realtime-preview', 'text-embedding-3-small', 'dall-e-3', 'gpt-7-nova'],
  }
  // GetShowUps has tested these end to end (the registry is editable without a deployment).
  testedModels(['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-4o-mini'])
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), WEBSITE_STUDIO_ENABLED: 'true', WEBSITE_STUDIO_BUSINESSES: 'pools,salon', ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }
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
      if (u.pathname === '/v1/models') return Response.json({ data: accounts.anthropic.map((id) => ({ id, type: 'model', display_name: id, max_tokens: 128000, capabilities: { structured_outputs: { supported: !id.includes('legacy') }, effort: { supported: true } } })), has_more: false, first_id: 'a', last_id: 'a' })
      if (u.pathname === '/v1/messages') {
        if (providerReply?.status) return Response.json({ type: 'error', error: { type: providerReply.type || 'invalid_request_error', message: 'mock' } }, { status: providerReply.status })
        return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body?.model, stop_reason: providerReply?.stop || 'end_turn', content: [{ type: 'text', text: JSON.stringify(providerReply?.raw || generated()) }], usage: { input_tokens: 1200, output_tokens: 900 } })
      }
    }
    if (u.hostname === 'api.openai.com') {
      if (bad) return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 })
      if (u.pathname === '/v1/models') return Response.json({ data: accounts.openai.map((id) => ({ id, object: 'model', owned_by: 'openai' })) })
      if (u.pathname === '/v1/chat/completions') {
        if (providerReply?.status) return Response.json({ error: { type: providerReply.type, code: providerReply.code } }, { status: providerReply.status })
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
  const k = ok.json.key
  assert.deepEqual([k.provider, k.label, k.hint, k.status, k.model, k.budgetCents, k.spentUsd], ['anthropic', 'Claude (Anthropic)', 'WXYZ', 'ok', 'auto', 1000, 0])
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

test('generation with the own Claude key: Opus 5.5 + strict JSON schema, no server-side fallback; output still filtered; billed to the owner, not us', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  const r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.generation.source, 'ai')
  const req = calls.find((x) => x.path === '/v1/messages')
  assert.ok(req.headers['x-api-key'] === CLAUDE_KEY || req.headers.authorization === `Bearer ${CLAUDE_KEY}`, 'sent with the business’s own key')
  assert.equal(req.body.model, 'claude-opus-5-5')
  assert.equal(req.body.fallbacks, undefined, 'no server-side fallback (owner decision 2026-11-16)')
  assert.ok(!String(req.headers['anthropic-beta'] || '').includes('server-side-fallback'))
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
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'x' } })).json.error, 'provider_billing')
})

test('billing problems are billing, not rate limits: OpenAI credit_balance_exhausted / insufficient_quota, Anthropic 402 billing_error', async () => {
  const { openAiError, claudeError } = await import('../server/ai-providers.js')
  // The exact response from the failed live test (2026-11-15): HTTP 429, type insufficient_quota, code credit_balance_exhausted.
  assert.deepEqual(openAiError(429, { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining.' } }), { error: 'provider_billing', detail: { status: 429, type: 'insufficient_quota', code: 'credit_balance_exhausted' } })
  assert.equal(openAiError(429, { error: { type: 'insufficient_quota', code: 'some_new_billing_code' } }).error, 'provider_billing', 'type alone is enough')
  assert.equal(openAiError(429, { error: { type: 'requests', code: 'rate_limit_exceeded' } }).error, 'provider_rate_limited', 'a real rate limit stays a rate limit')
  assert.equal(openAiError(400, { error: { type: 'invalid_request_error', code: null } }).error, 'provider_rejected')
  assert.equal(openAiError(401, {}).error, 'invalid_key')
  assert.equal(openAiError(429, { error: { code: 'x'.repeat(200) } }).detail.code, null, 'only short identifiers are kept')
  assert.equal(claudeError({ status: 402, error: { type: 'error', error: { type: 'billing_error' } } }).error, 'provider_billing')
  assert.equal(claudeError({ status: 400, error: { type: 'error', error: { type: 'invalid_request_error' } } }).error, 'provider_rejected')
  assert.equal(claudeError({ status: 429 }).error, 'provider_rate_limited')
  assert.equal(claudeError(new Error('socket hang up')).error, 'provider_unavailable')
  // Through the API: the owner gets 402 provider_billing, nothing is charged to the limit, and the request isn't retried.
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'openai', key: OPENAI_KEY, model: 'gpt-4o-mini' } })
  providerReply = { status: 429, type: 'insufficient_quota', code: 'credit_balance_exhausted' }
  let r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.deepEqual([r.status, r.json.error], [402, 'provider_billing'])
  assert.equal(calls.filter((x) => x.path === '/v1/chat/completions').length, 1, 'no retry')
  assert.equal(db.sql.prepare('SELECT cost_micros FROM ai_key_usage').get().cost_micros, 0)
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY, model: 'claude-opus-5-5' } })
  providerReply = { status: 402, type: 'billing_error' }
  r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.deepEqual([r.status, r.json.error], [402, 'provider_billing'])
})

test('start from a design never uses the own key (no provider call)', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  const before = calls.length
  const r = await call(website, 'POST', { cookie: c, body: { action: 'template' } })
  assert.deepEqual([r.status, r.json.generation.source], [200, 'template'])
  assert.equal(calls.length, before)
})

test('shipped registry: only the models verified live end to end are tested, so a new owner on Auto is not refused', async () => {
  const fresh = d1()
  assert.deepEqual(fresh.sql.prepare("SELECT provider || ':' || model m FROM ai_model_registry WHERE status = 'tested' ORDER BY provider").all().map((r) => r.m), ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'])
  // With that seed, Auto works out of the box: a new Claude key on Auto gets Sonnet 5.5 (no "no tested model" dead end).
  db = fresh
  env.ONBOARDING_DB = db
  seed('pools', 'owner@pools.example')
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })
  assert.equal((await call(aiKey, 'GET', { cookie: c })).json.key.model, 'auto')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 200)
  assert.equal(calls.findLast((x) => x.path === '/v1/messages').body.model, 'claude-sonnet-5-5')
})

test('models are discovered from the customer’s account and filtered for compatibility; new ones appear without a deployment', async () => {
  const c = await cookieFor('owner@pools.example')
  let k = (await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'openai', key: OPENAI_KEY } })).json.key
  const ids = (key) => key.choices.map((x) => `${x.id}:${x.status}`)
  assert.deepEqual(ids(k), ['gpt-5-mini:supported', 'gpt-4.1:supported', 'gpt-4o-mini:tested', 'gpt-7-nova:unpriced'], 'best first, cheaper first at equal quality; audio/embedding/image models and dated snapshots filtered out; an unpriced new model is shown, not selectable')
  assert.equal(k.choices.find((x) => x.id === 'gpt-7-nova').selectable, false)
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'model', model: 'gpt-7-nova' } })).json, { error: 'invalid_model' }, 'unpriced → spend could not be bounded')
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'model', model: 'text-embedding-3-small' } })).json, { error: 'invalid_model' })
  // The provider releases a new model and GetShowUps prices it (registry row, no deployment): it becomes selectable after a refresh.
  accounts.openai.push('gpt-5.4-mini')
  db.sql.prepare("INSERT INTO ai_model_registry (provider, model, status, quality, input_per_m, output_per_m, updated_at) VALUES ('openai', 'gpt-7-nova', 'supported', 3, 1.0, 5.0, 1)").run()
  k = (await call(aiKey, 'POST', { cookie: c, body: { action: 'refresh' } })).json.key
  assert.ok(k.choices.some((x) => x.id === 'gpt-5.4-mini' && x.selectable))
  assert.ok(k.choices.some((x) => x.id === 'gpt-7-nova' && x.selectable))
  // A stale catalog refreshes on its own (older than a day) when the owner opens settings.
  accounts.openai.push('gpt-5-nano')
  db.sql.prepare('UPDATE ai_credentials SET catalog_at = ?').run(Date.now() - 2 * DAY)
  assert.ok((await call(aiKey, 'GET', { cookie: c })).json.key.choices.some((x) => x.id === 'gpt-5-nano'))
  // Anthropic: compatibility from the Models API capabilities.
  k = (await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })).json.key
  assert.ok(!k.choices.some((x) => x.id === 'claude-legacy-2'), 'no structured outputs → not offered')
  assert.equal(k.choices[0].id, 'claude-opus-5-5')
  assert.equal((await call(aiKey, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'model', model: 'gpt-4o' } })).status, 404, 'isolated: no key, nothing to change')
})

test('the chosen model is used and kept; Auto picks only tested models within the limit and never moves to a pricier one; retired models are not silently replaced', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY, model: 'claude-sonnet-5-5' } })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  let req = calls.findLast((x) => x.path === '/v1/messages')
  assert.deepEqual([req.body.model, req.body.fallbacks], ['claude-sonnet-5-5', undefined], 'manual choice (untested but supported) is honoured, never substituted')
  // Retired at the provider: reported and refused, never swapped.
  accounts.anthropic = accounts.anthropic.filter((id) => id !== 'claude-sonnet-5-5')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'refresh' } })
  const k = (await call(aiKey, 'GET', { cookie: c })).json.key
  assert.deepEqual([k.model, k.modelUnavailable], ['claude-sonnet-5-5', true])
  const before = calls.filter((x) => x.path === '/v1/messages').length
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'x' } })).json.error, 'model_unavailable')
  assert.equal(calls.filter((x) => x.path === '/v1/messages').length, before, 'no request sent')
  // Auto: tested models only; best quality within the limit.
  await call(aiKey, 'POST', { cookie: c, body: { action: 'model', model: 'auto' } })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  req = calls.findLast((x) => x.path === '/v1/messages')
  assert.equal(req.body.model, 'claude-opus-5-5', 'tested, best quality, worst case fits $10')
  assert.equal(db.sql.prepare('SELECT auto_model FROM ai_credentials').get().auto_model, 'claude-opus-5-5')
  // A tighter limit with $0.66 already spent: Opus' worst case ($0.37) no longer fits $1, Haiku's does → Auto steps DOWN.
  db.sql.prepare("UPDATE ai_key_usage SET cost_micros = 660000 WHERE model = 'anthropic:claude-opus-5-5'").run()
  await call(aiKey, 'POST', { cookie: c, body: { action: 'budget', cents: 100 } })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(calls.findLast((x) => x.path === '/v1/messages').body.model, 'claude-haiku-5-5')
  // Opus gets cheaper? No: a more expensive model than the current pick is never chosen automatically, even with room.
  await call(aiKey, 'POST', { cookie: c, body: { action: 'budget', cents: 5000 } })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(calls.findLast((x) => x.path === '/v1/messages').body.model, 'claude-haiku-5-5', 'stays on the cheaper pick')
  assert.equal(calls.findLast((x) => x.path === '/v1/messages').body.fallbacks, undefined, 'no refusal fallback')
  // Untested models are never Auto picks.
  db.sql.prepare("UPDATE ai_model_registry SET status = 'supported'").run()
  db.sql.prepare("UPDATE ai_credentials SET auto_model = NULL").run()
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.error, 'no_tested_model')
})

test('hard spending limit: a request whose worst case would cross the monthly limit is refused before it is sent', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY, model: 'claude-opus-5-5' } })
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'budget', cents: 50 } })).json, { error: 'invalid_budget' })
  await call(aiKey, 'POST', { cookie: c, body: { action: 'budget', cents: 100 } })
  // Opus writer worst case: 12k in × $4 + 16k out × $20 per M = $0.368 → fits $1 twice, not three times.
  for (let i = 0; i < 2; i++) assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 200)
  db.sql.prepare('UPDATE ai_key_usage SET cost_micros = 368000').run()
  const sent = calls.filter((x) => x.path === '/v1/messages').length
  const r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.deepEqual([r.status, r.json.error], [402, 'budget_reached'])
  assert.equal(calls.filter((x) => x.path === '/v1/messages').length, sent, 'refused before sending')
  assert.equal((await call(aiKey, 'GET', { cookie: c })).json.key.spentUsd, 0.74)
})

test('requests never ask for more output than the model allows (GPT-4o mini: 16,384), and the worst case uses that cap', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'openai', key: OPENAI_KEY, model: 'gpt-4o-mini' } })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(calls.findLast((x) => x.path === '/v1/chat/completions').body.max_completion_tokens, 16000, 'writer cap is below the ceiling')
  const { outputCap } = await import('../server/ai-models.js')
  assert.equal(outputCap('designer', { max_output: 16384 }, null), 16384)
  assert.equal(outputCap('designer', null, { maxOutput: 128000 }), 32000)
  assert.equal(outputCap('writer', null, null), 16000)
})

test('failed requests that the provider still bills count toward the limit; the ledger holds tokens only', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY, model: 'claude-opus-5-5' } })
  providerReply = { stop: 'max_tokens' }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.error, 'ai_invalid_output')
  const rows = db.sql.prepare('SELECT * FROM ai_key_usage').all()
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['cost_micros', 'created_at', 'customer', 'id', 'input_tokens', 'kind', 'model', 'ok', 'output_tokens', 'provider', 'state'])
  // Settled to the reported tokens: 1,200 × $4 + 900 × $20 per M = $0.0228.
  assert.deepEqual([rows[0].state, rows[0].ok, rows[0].input_tokens, rows[0].output_tokens, rows[0].cost_micros], ['settled', 0, 1200, 900, 22800])
  assert.ok((await call(aiKey, 'GET', { cookie: c })).json.key.spentUsd > 0)
})

test('concurrent requests cannot both use the same headroom: the worst case is reserved atomically before sending', async () => {
  const { reserveUsage } = await import('../server/ai-models.js')
  const ids = await Promise.all(Array.from({ length: 5 }, () => reserveUsage(env.ONBOARDING_DB, 'pools', 'anthropic', 'claude-opus-5-5', 'writer', 0.4, 1)))
  assert.equal(ids.filter(Boolean).length, 2, '$1 holds two $0.40 worst cases, not five')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM ai_key_usage WHERE state = 'reserved'").get().n, 2)
  // The limit covers the business across providers (switching keys doesn't reset it).
  assert.equal(await reserveUsage(env.ONBOARDING_DB, 'pools', 'openai', 'gpt-4o-mini', 'writer', 0.3, 1), null)
})

test('no usage report (timeout / provider error) keeps the worst case reserved; refusals before work are released', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY, model: 'claude-opus-5-5' } })
  providerReply = { status: 500 }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.error, 'provider_unavailable')
  let row = db.sql.prepare('SELECT state, cost_micros FROM ai_key_usage').get()
  assert.equal(row.state, 'unknown')
  assert.ok(row.cost_micros >= 368000, 'worst case kept: it may have been billed')
  assert.equal(calls.filter((x) => x.path === '/v1/messages').length, 1, 'no retry (a retry would be a second billed request)')
  db.sql.prepare('DELETE FROM ai_key_usage').run()
  providerReply = { status: 400 }
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  row = db.sql.prepare('SELECT state, cost_micros FROM ai_key_usage').get()
  assert.deepEqual([row.state, row.cost_micros], ['settled', 0])
})

test('discovered is not compatible: a model without structured outputs is never selectable or picked by Auto, even if marked tested', async () => {
  db.sql.prepare("INSERT INTO ai_model_registry (provider, model, status, quality, input_per_m, output_per_m, updated_at) VALUES ('anthropic', 'claude-legacy-2', 'tested', 9, 0.01, 0.01, 1)").run()
  const c = await cookieFor('owner@pools.example')
  const k = (await call(aiKey, 'POST', { cookie: c, body: { action: 'save', provider: 'anthropic', key: CLAUDE_KEY } })).json.key
  assert.ok(!k.choices.some((x) => x.id === 'claude-legacy-2'))
  assert.deepEqual((await call(aiKey, 'POST', { cookie: c, body: { action: 'model', model: 'claude-legacy-2' } })).json, { error: 'invalid_model' })
  await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(calls.findLast((x) => x.path === '/v1/messages').body.model, 'claude-opus-5-5', 'Auto: tested AND compatible on this account')
  // Nothing in the product marks a model tested: discovery/refresh never write the registry.
  const before = db.sql.prepare('SELECT model, status FROM ai_model_registry ORDER BY provider, model').all()
  accounts.anthropic.push('claude-new-9')
  await call(aiKey, 'POST', { cookie: c, body: { action: 'refresh' } })
  assert.deepEqual(db.sql.prepare('SELECT model, status FROM ai_model_registry ORDER BY provider, model').all(), before)
})

test('the website writer schema sent to Claude/OpenAI stays within Anthropic’s structured-output limits', async () => {
  const { SCHEMA } = await import('../server/website-ai.js')
  assert.deepEqual(anthropicSchemaProblems(strictSchema(SCHEMA)), [])
  assert.ok(anthropicSchemaProblems({ type: 'object', properties: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { anyOf: [{ type: 'string' }, { type: 'null' }] }])), additionalProperties: false, required: Array.from({ length: 17 }, (_, i) => `f${i}`) }).some((p) => p.includes('17 union-typed')), 'the check itself catches the failure mode')
})

test('strictSchema closes every object and lists every property as required', () => {
  const s = strictSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' } } } } } })
  assert.deepEqual(s, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string' } }, additionalProperties: false, required: ['c'] } } }, additionalProperties: false, required: ['a', 'b'] })
})
