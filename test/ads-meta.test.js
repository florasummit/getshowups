// Meta Marketing API adapter: OAuth connect (state, scopes, long-lived exchange, encrypted storage,
// account auto-select), account selection, dry-run and mocked real launches (always PAUSED, idempotent,
// partial failure), error mapping + retry, status/budget changes, insights normalization, and the
// lead-ads webhook (signature, handshake, idempotency, isolation). Real handlers + migrations on
// node:sqlite (D1 stand-in), Map KV, mocked Graph API. Nothing here talks to Meta. Run: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { getConnection, loadToken, saveToken, upsertConnection } from '../server/ads/connections.js'
import { fetchDailyMetrics, launchCampaign, mapError, metaBase, setDailyBudget, setStatus } from '../server/ads/meta.js'
import * as start from '../functions/api/ads/meta/start.js'
import * as callback from '../functions/api/ads/meta/callback.js'
import * as accounts from '../functions/api/ads/meta/accounts.js'
import * as webhook from '../functions/api/ads/meta/webhook.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const APP_SECRET = 'meta-app-secret-test'
const G = 'https://graph.facebook.com/v27.0'
const SHORT = 'EAAshort-token-test'
const LONG = 'EAAlong-lived-token-test'
const LEAD_EMAIL = 'fb.lead@example.net'
const LEAD_PHONE = '555-010-0142'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => {
      const r = sql.prepare(q).run(...args)
      return { meta: { changes: r.changes } }
    },
  })
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

let env, db, kv, r2, logs, responses, calls, meta, origFetch, origError

function seed(id, owner) {
  const now = Date.now()
  db.sql
    .prepare(
      "INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)",
    )
    .run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}

// Fake Graph API state. Handlers return [status, body]; `fail` injects errors by "METHOD path".
function fakeMeta() {
  const m = { seq: 100, objects: {}, fail: {}, adAccounts: [{ id: 'act_111', name: 'Pools Ads', currency: 'USD', account_status: 1 }], pages: [{ id: '222', name: 'Pools Page' }], leads: {}, insights: [] }
  m.handle = (method, path, params) => {
    const k = `${method} ${path}`
    const f = m.fail[k]
    if (f && f.times > 0) {
      f.times--
      return f.response
    }
    if (k === 'GET /oauth/access_token') {
      if (params.grant_type === 'fb_exchange_token') return params.fb_exchange_token === SHORT ? [200, { access_token: LONG, token_type: 'bearer', expires_in: 5183944 }] : [400, { error: { code: 190 } }]
      return params.code === 'good-code' ? [200, { access_token: SHORT, expires_in: 3600 }] : [400, { error: { code: 100, message: 'bad code for owner@pools.example' } }]
    }
    if (params.access_token !== LONG && !String(params.access_token).startsWith('PAGE')) return [400, { error: { code: 190 } }]
    if (k === 'GET /me/adaccounts') return [200, { data: m.adAccounts }]
    if (k === 'GET /me/accounts') return [200, { data: m.pages }]
    const list = /^\/([\w]+)\/(campaigns|adsets|ads)$/.exec(path)
    if (method === 'GET' && list) return [200, { data: Object.values(m.objects).filter((o) => o.edge === list[2] && o.parent === list[1]) }]
    const create = /^\/(act_\d+|\d+)\/(campaigns|adsets|ads|adcreatives|adimages|leadgen_forms)$/.exec(path)
    if (method === 'POST' && create) {
      const edge = create[2]
      if (edge === 'adimages') return [200, { images: { 'upload.png': { hash: `hash${++m.seq}` } } }]
      const id = String(++m.seq)
      const parent = edge === 'adsets' ? params.campaign_id : edge === 'ads' ? params.adset_id : create[1]
      m.objects[id] = { id, edge, parent, ...params }
      return [200, { id }]
    }
    if (method === 'GET' && /^\/\d+$/.test(path) && path.slice(1) in m.leads) return [200, m.leads[path.slice(1)]]
    if (method === 'GET' && /^\/\d+$/.test(path) && params.fields === 'access_token') return [200, { access_token: 'PAGE-token', id: path.slice(1) }]
    if (method === 'POST' && /^\/\d+$/.test(path)) {
      const o = m.objects[path.slice(1)]
      if (!o) return [400, { error: { code: 100 } }]
      Object.assign(o, params)
      return [200, { success: true }]
    }
    if (method === 'GET' && /^\/\d+\/insights$/.test(path)) return [200, { data: m.insights }]
    return [404, { error: { code: 803 } }]
  }
  return m
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  r2 = new Map()
  responses = []
  calls = []
  meta = fakeMeta()
  env = {
    ADS_ENABLED: 'true',
    ADS_BUSINESSES: 'pools,salon', // per-business Ads flag (server/ads/access.js)
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    AD_ASSETS: { get: async (k) => (r2.has(k) ? { arrayBuffer: async () => r2.get(k).buffer } : null), put: async (k, v) => r2.set(k, v) },
    META_APP_ID: '123456',
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: 'verify-me-test',
    META_RETRY_DELAY_MS: '1',
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    assert.ok(u.href.startsWith(G), `unexpected ${u.origin}`)
    assert.ok(init.signal, 'every Graph call has a timeout signal')
    const method = init.method || 'GET'
    const params = method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(init.body))
    for (const [k, v] of Object.entries(params)) if (/^[[{]/.test(v)) params[k] = JSON.parse(v)
    const path = u.pathname.replace('/v27.0', '')
    calls.push({ method, path, params })
    const [status, body] = meta.handle(method, path, params)
    return new Response(JSON.stringify(body), { status })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const out = logs.join('\n') + responses.join('\n')
  for (const secret of [SHORT, LONG, APP_SECRET, 'PAGE-token', LEAD_EMAIL, LEAD_PHONE, 'owner@pools.example']) assert.ok(!out.includes(secret), `leaked ${secret}`)
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, headers: extra = {} } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...extra }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && !('Origin' in extra)) headers.Origin = ORIGIN
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
    env,
  })
  const text = await res.clone().text()
  responses.push(text, res.headers.get('Location') || '')
  return { res, status: res.status, text, json: () => JSON.parse(text), location: res.headers.get('Location') }
}
const setCookieValue = (res) => /__Host-gsu_meta_oauth=([^;]*)/.exec(res.headers.get('Set-Cookie') || '')?.[1]

async function connect(email = 'owner@pools.example') {
  const cookie = await session(email)
  const s = await call(start, 'GET', '/api/ads/meta/start', { cookie })
  const state = new URL(s.location).searchParams.get('state')
  return call(callback, 'GET', `/api/ads/meta/callback?code=good-code&state=${state}`, { cookie: `${cookie}; __Host-gsu_meta_oauth=${setCookieValue(s.res)}` })
}

async function connected(customer = 'pools') {
  await saveToken(env, 'meta', customer, { accessToken: LONG, expiresAt: Date.now() + 864e5 })
  await upsertConnection(env, customer, 'meta', { accountId: 'act_111', accountName: 'Pools Ads', currency: 'USD', extra: { pageId: '222' }, status: 'connected' })
}

function approvedImage(customer = 'pools', id = 'img1', status = 'approved') {
  const key = `creatives/${customer}/${id}.png`
  r2.set(key, new Uint8Array([137, 80, 78, 71]))
  db.sql
    .prepare("INSERT INTO ad_creatives (id, customer, kind, provider, status, prompt, storage_key, mime, created_at, updated_at) VALUES (?, ?, 'image', 'openai', ?, 'p', ?, 'image/png', 1, 1)")
    .run(id, customer, status, key)
}

const SPEC = {
  platform: 'meta',
  name: 'Spring pool opening',
  dailyBudgetCents: 2500,
  geo: { zips: ['29403', '29401'] },
  meta: { primaryTexts: ['Get your pool ready.'], headlines: ['Pool opening'], callToAction: 'GET_QUOTE', destination: 'instant_form', imageCreativeIds: ['img1'], videoCreativeIds: [], formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'] },
}
const CAMPAIGN = { id: 'cmp1', spec: SPEC }
const writes = () => calls.filter((c) => c.method === 'POST')

// ---------- OAuth ----------

test('oauth: not configured → 503 not_configured, no Graph calls', async () => {
  delete env.META_APP_SECRET
  const cookie = await session('owner@pools.example')
  for (const mod of [start, callback, accounts]) {
    const r = await call(mod, 'GET', '/api/ads/meta/x', { cookie })
    assert.equal(r.status, 503)
    assert.equal(r.json().error, 'not_configured')
  }
  assert.equal(calls.length, 0)
})

test('oauth start: requires a session; redirects to the Meta dialog with state, scopes, sealed cookie', async () => {
  assert.equal((await call(start, 'GET', '/api/ads/meta/start')).status, 401)
  const r = await call(start, 'GET', '/api/ads/meta/start', { cookie: await session('owner@pools.example') })
  assert.equal(r.status, 302)
  const u = new URL(r.location)
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v27.0/dialog/oauth')
  assert.equal(u.searchParams.get('client_id'), '123456')
  assert.equal(u.searchParams.get('redirect_uri'), `${ORIGIN}/api/ads/meta/callback`)
  const scopes = u.searchParams.get('scope').split(',')
  for (const s of ['ads_management', 'ads_read', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval', 'business_management']) assert.ok(scopes.includes(s), s)
  assert.ok(u.searchParams.get('state').length >= 32)
  const sealed = setCookieValue(r.res)
  assert.ok(sealed && !sealed.includes('pools') && !sealed.includes(u.searchParams.get('state')), 'cookie is encrypted')
  assert.match(r.res.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax; Max-Age=600/)
})

test('oauth callback: exchanges for a long-lived token, stores it encrypted, auto-selects one account + page', async () => {
  const r = await connect()
  assert.equal(r.status, 303)
  assert.equal(r.location, '/dashboard?ads=meta_connected')
  assert.ok(calls.some((c) => c.params.grant_type === 'fb_exchange_token' && c.params.fb_exchange_token === SHORT))
  const raw = kv.get('ads:meta:pools')
  assert.ok(raw && !raw.includes(LONG) && !raw.includes(SHORT), 'token encrypted at rest')
  const tok = await loadToken(env, 'meta', 'pools')
  assert.equal(tok.accessToken, LONG)
  assert.ok(tok.expiresAt > Date.now() + 59 * 864e5)
  const conn = await getConnection(env, 'pools', 'meta')
  assert.equal(conn.status, 'connected')
  assert.equal(conn.account_id, 'act_111')
  assert.equal(conn.extra.pageId, '222')
  assert.equal(await getConnection(env, 'salon', 'meta'), null, 'other business untouched')
  assert.ok(!JSON.stringify(db.sql.prepare('SELECT * FROM ad_connections').all()).includes(LONG), 'no token in D1')
})

test('oauth callback: several accounts → needs_account; selection validated against the lists', async () => {
  meta.adAccounts.push({ id: 'act_333', name: 'Second', currency: 'USD', account_status: 1 }, { id: 'act_444', name: 'Disabled', currency: 'USD', account_status: 2 })
  assert.equal((await connect()).location, '/dashboard?ads=meta_connected')
  assert.equal((await getConnection(env, 'pools', 'meta')).status, 'needs_account')
  const cookie = await session('owner@pools.example')
  const list = await call(accounts, 'GET', '/api/ads/meta/accounts', { cookie })
  assert.equal(list.status, 200)
  assert.equal(list.json().adAccounts.length, 3)
  assert.equal(list.json().status, 'needs_account')
  for (const body of [{ adAccountId: 'act_999', pageId: '222' }, { adAccountId: 'act_444', pageId: '222' }, { adAccountId: 'act_333', pageId: '999' }, { adAccountId: '333', pageId: '222' }]) {
    const bad = await call(accounts, 'POST', '/api/ads/meta/accounts', { cookie, body })
    assert.equal(bad.status, 400, JSON.stringify(body))
  }
  const cross = await call(accounts, 'POST', '/api/ads/meta/accounts', { cookie, body: { adAccountId: 'act_333', pageId: '222' }, headers: { Origin: 'https://evil.example' } })
  assert.equal(cross.status, 403)
  const ok = await call(accounts, 'POST', '/api/ads/meta/accounts', { cookie, body: { adAccountId: 'act_333', pageId: '222' } })
  assert.equal(ok.status, 200)
  const conn = await getConnection(env, 'pools', 'meta')
  assert.equal(conn.status, 'connected')
  assert.equal(conn.account_id, 'act_333')
  // Another business has no Meta connection and cannot see this one.
  assert.equal((await call(accounts, 'GET', '/api/ads/meta/accounts', { cookie: await session('owner@salon.example') })).status, 404)
})

test('oauth callback: bad state, other business, cancelled, bad code → allowlisted errors, nothing stored', async () => {
  const cookie = await session('owner@pools.example')
  const s = await call(start, 'GET', '/api/ads/meta/start', { cookie })
  const sealed = setCookieValue(s.res)
  const state = new URL(s.location).searchParams.get('state')
  assert.equal((await call(callback, 'GET', `/api/ads/meta/callback?code=good-code&state=wrong`, { cookie: `${cookie}; __Host-gsu_meta_oauth=${sealed}` })).location, '/dashboard?ads_error=expired')
  assert.equal((await call(callback, 'GET', `/api/ads/meta/callback?code=good-code&state=${state}`, { cookie })).location, '/dashboard?ads_error=expired')
  const salon = await session('owner@salon.example')
  assert.equal((await call(callback, 'GET', `/api/ads/meta/callback?code=good-code&state=${state}`, { cookie: `${salon}; __Host-gsu_meta_oauth=${sealed}` })).location, '/dashboard?ads_error=expired')
  assert.equal((await call(callback, 'GET', `/api/ads/meta/callback?error=access_denied&state=${state}`, { cookie: `${cookie}; __Host-gsu_meta_oauth=${sealed}` })).location, '/dashboard?ads_error=cancelled')
  const bad = await call(callback, 'GET', `/api/ads/meta/callback?code=bad-code&state=${state}`, { cookie: `${cookie}; __Host-gsu_meta_oauth=${sealed}` })
  assert.equal(bad.location, '/dashboard?ads_error=invalid_request')
  assert.equal(kv.size, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ad_connections').get().n, 0)
})

// ---------- launch ----------

test('launch dryRun: builds PAUSED payloads with cents budget, ZIP targeting, NONE category, form questions; no writes', async () => {
  await connected()
  const r = await launchCampaign(env, 'pools', CAMPAIGN)
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(writes().length, 0)
  assert.equal(calls.length, 0, 'dry run makes no Graph calls')
  const p = r.payloads
  assert.equal(p.campaign.status, 'PAUSED')
  assert.equal(p.campaign.objective, 'OUTCOME_LEADS')
  assert.deepEqual(p.campaign.special_ad_categories, ['NONE'])
  assert.equal(p.adset.status, 'PAUSED')
  assert.equal(p.adset.daily_budget, 2500)
  assert.deepEqual(p.adset.targeting.geo_locations.zips, [{ key: 'US:29403' }, { key: 'US:29401' }])
  assert.deepEqual(p.adset.promoted_object, { page_id: '222' })
  assert.equal(p.ad.status, 'PAUSED')
  assert.deepEqual(p.leadForm.questions, [{ type: 'FULL_NAME' }, { type: 'PHONE' }, { type: 'EMAIL' }, { type: 'ZIP' }])
  assert.equal(p.leadForm.privacy_policy.url, `${ORIGIN}/privacy`)
  assert.ok(p.campaign.name.startsWith('GSU-cmp1 '))
  assert.ok(!JSON.stringify(r).includes('ACTIVE'))
})

test('launch: unsupported specs refused before any call', async () => {
  await connected()
  assert.equal((await launchCampaign(env, 'pools', { id: 'x', spec: { ...SPEC, meta: { ...SPEC.meta, destination: 'website' } } }, { dryRun: false })).error, 'unsupported_destination')
  assert.equal((await launchCampaign(env, 'pools', { id: 'x', spec: { ...SPEC, meta: { ...SPEC.meta, imageCreativeIds: [] } } }, { dryRun: false })).error, 'image_required')
  assert.equal((await launchCampaign(env, 'salon', CAMPAIGN, { dryRun: false })).error, 'needs_account')
  assert.equal(calls.length, 0)
})

test('launch real (mocked): creates everything PAUSED; rerun is idempotent', async () => {
  await connected()
  approvedImage()
  const r = await launchCampaign(env, 'pools', CAMPAIGN, { dryRun: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  for (const k of ['campaignId', 'adsetId', 'formId', 'creativeId', 'adId']) assert.ok(r.platformIds[k], k)
  assert.equal(r.platformCampaignId, r.platformIds.campaignId)
  const objs = Object.values(meta.objects)
  assert.equal(objs.filter((o) => ['campaigns', 'adsets', 'ads'].includes(o.edge)).length, 3)
  for (const o of objs.filter((x) => ['campaigns', 'adsets', 'ads'].includes(x.edge))) assert.equal(o.status, 'PAUSED')
  assert.ok(!writes().some((c) => c.params.status === 'ACTIVE'), 'never ACTIVE at launch')
  const adset = objs.find((o) => o.edge === 'adsets')
  assert.equal(adset.daily_budget, '2500', 'integer minor units on the wire')
  assert.equal(adset.campaign_id, r.platformIds.campaignId)
  const creative = objs.find((o) => o.edge === 'adcreatives')
  assert.equal(creative.object_story_spec.link_data.call_to_action.value.lead_gen_form_id, r.platformIds.formId)
  assert.equal(creative.object_story_spec.link_data.image_hash, r.platformIds.imageHashes[0])

  // Rerun without saved ids (lost response): found by our tag, nothing new spends.
  const count = Object.keys(meta.objects).length
  calls = []
  const again = await launchCampaign(env, 'pools', CAMPAIGN, { dryRun: false })
  assert.equal(again.platformIds.campaignId, r.platformIds.campaignId)
  assert.equal(again.platformIds.adsetId, r.platformIds.adsetId)
  assert.equal(again.platformIds.adId, r.platformIds.adId)
  assert.ok(!writes().some((c) => /\/(campaigns|adsets|ads)$/.test(c.path)), 'no duplicate campaign/ad set/ad')
  assert.ok(Object.keys(meta.objects).length - count <= 2, 'only form + creative may be recreated')
  // Rerun with saved ids: zero writes.
  calls = []
  await launchCampaign(env, 'pools', { ...CAMPAIGN, platformIds: r.platformIds }, { dryRun: false })
  assert.equal(writes().length, 0)
})

test('launch: unapproved creative is not uploaded', async () => {
  await connected()
  approvedImage('pools', 'img1', 'ready')
  const r = await launchCampaign(env, 'pools', CAMPAIGN, { dryRun: false })
  assert.equal(r.error, 'creative_unavailable')
  assert.ok(!calls.some((c) => c.path.endsWith('/adimages')))
})

test('launch: mid-sequence failure returns partial ids, nothing ACTIVE; creative rejection mapped', async () => {
  await connected()
  approvedImage()
  meta.fail['POST /act_111/ads'] = { times: 1, response: [400, { error: { code: 100, error_subcode: 1487225, message: 'Your ad for owner@pools.example violates policy' } }] }
  const r = await launchCampaign(env, 'pools', CAMPAIGN, { dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'creative_rejected')
  assert.ok(r.platformIds.campaignId && r.platformIds.adsetId && r.platformIds.creativeId)
  assert.equal(r.platformIds.adId, undefined)
  assert.ok(!JSON.stringify(r).includes('violates'), 'provider message not echoed')
  assert.ok(Object.values(meta.objects).every((o) => o.status === undefined || o.status === 'PAUSED'))
  // Resume from partial ids finishes with only the ad.
  calls = []
  const resumed = await launchCampaign(env, 'pools', { ...CAMPAIGN, platformIds: r.platformIds }, { dryRun: false })
  assert.equal(resumed.ok, true)
  assert.deepEqual(writes().map((c) => c.path), ['/act_111/ads'])
})

// ---------- errors ----------

test('errors: 190 → reconnect_required and connection marked; never leaks tokens', async () => {
  await connected()
  await saveToken(env, 'meta', 'pools', { accessToken: 'EAAexpired', expiresAt: Date.now() + 864e5 })
  const r = await setStatus(env, 'pools', { platform_ids: JSON.stringify({ campaignId: '9' }) }, 'PAUSED')
  assert.equal(r.error, 'reconnect_required')
  assert.equal(r.reconnect, true)
  assert.equal((await getConnection(env, 'pools', 'meta')).status, 'reconnect_required')
  assert.ok(!JSON.stringify(r).includes('EAA'))
  // Expired stored token: no call at all.
  await saveToken(env, 'meta', 'salon', { accessToken: LONG, expiresAt: Date.now() - 1 })
  calls = []
  assert.equal((await fetchDailyMetrics(env, 'salon', { platform_ids: '{"campaignId":"9"}' }, '2026-11-01', '2026-11-02')).error, 'reconnect_required')
  assert.equal(calls.length, 0)
})

test('errors: mapping table', () => {
  const e = (code, extra = {}) => ({ error: { code, ...extra } })
  assert.equal(mapError(400, e(190)).error, 'reconnect_required')
  assert.equal(mapError(403, e(10)).error, 'app_not_approved')
  assert.equal(mapError(403, e(200)).error, 'permission_denied')
  assert.equal(mapError(403, e(294)).error, 'permission_denied')
  for (const c of [4, 17, 613, 80000, 80004]) {
    assert.equal(mapError(400, e(c)).error, 'rate_limited', String(c))
    assert.equal(mapError(400, e(c)).retryable, true)
  }
  assert.equal(mapError(400, e(100, { error_subcode: 1487225 })).error, 'creative_rejected')
  assert.equal(mapError(400, e(100, { error_user_title: 'Ad account disabled' })).error, 'account_disabled')
  assert.equal(mapError(500, e(1)).error, 'transient')
  assert.equal(mapError(400, e(100)).error, 'invalid_request')
  assert.ok(!JSON.stringify(mapError(400, e(100, { message: 'secret detail' }))).includes('secret'))
})

test('errors: 613 is retried once then succeeds; repeated throttling surfaces rate_limited', async () => {
  await connected()
  const row = { platform_ids: JSON.stringify({ campaignId: '9', adsetId: '8' }) }
  meta.objects['8'] = { id: '8', edge: 'adsets' }
  meta.fail['POST /8'] = { times: 1, response: [400, { error: { code: 613 } }] }
  const ok = await setDailyBudget(env, 'pools', row, 3000)
  assert.equal(ok.ok, true)
  assert.equal(meta.objects['8'].daily_budget, '3000')
  assert.equal(calls.filter((c) => c.path === '/8').length, 2)
  meta.fail['POST /8'] = { times: 5, response: [400, { error: { code: 613 } }] }
  const limited = await setDailyBudget(env, 'pools', row, 3100)
  assert.equal(limited.error, 'rate_limited')
  assert.equal(limited.retryable, true)
  // Permission errors are not retried.
  meta.fail['POST /8'] = { times: 5, response: [403, { error: { code: 200 } }] }
  calls = []
  assert.equal((await setDailyBudget(env, 'pools', row, 3200)).error, 'permission_denied')
  assert.equal(calls.length, 1)
})

// ---------- status / budget / metrics ----------

test('setStatus: PAUSED pauses the campaign; ACTIVE turns on ad, ad set, campaign; invalid input refused', async () => {
  await connected()
  for (const id of ['1', '2', '3']) meta.objects[id] = { id, status: 'PAUSED' }
  const row = { platform_ids: JSON.stringify({ campaignId: '1', adsetId: '2', adId: '3' }) }
  assert.equal((await setStatus(env, 'pools', row, 'ACTIVE')).ok, true)
  assert.deepEqual(writes().map((c) => c.path), ['/3', '/2', '/1'])
  assert.ok(Object.values(meta.objects).every((o) => o.status === 'ACTIVE'))
  calls = []
  await setStatus(env, 'pools', row, 'PAUSED')
  assert.deepEqual(writes().map((c) => [c.path, c.params.status]), [['/1', 'PAUSED']])
  assert.equal((await setStatus(env, 'pools', row, 'DELETED')).error, 'invalid_request')
  assert.equal((await setStatus(env, 'pools', { platform_ids: '{}' }, 'PAUSED')).error, 'not_launched')
  assert.equal((await setDailyBudget(env, 'pools', row, 12.5)).error, 'invalid_request')
  assert.equal((await setDailyBudget(env, 'pools', row, 0)).error, 'invalid_request')
})

test('metrics: insights normalized to cents and lead conversions per day', async () => {
  await connected()
  meta.insights = [
    { date_start: '2026-11-01', date_stop: '2026-11-01', spend: '12.34', impressions: '1000', clicks: '25', actions: [{ action_type: 'lead', value: '3' }, { action_type: 'link_click', value: '25' }] },
    { date_start: '2026-11-02', date_stop: '2026-11-02', spend: '0', impressions: '0', clicks: '0' },
  ]
  const r = await fetchDailyMetrics(env, 'pools', { platform_ids: '{"campaignId":"9"}' }, '2026-11-01', '2026-11-02')
  assert.deepEqual(r.rows, [
    { date: '2026-11-01', spendCents: 1234, impressions: 1000, clicks: 25, conversions: 3 },
    { date: '2026-11-02', spendCents: 0, impressions: 0, clicks: 0, conversions: 0 },
  ])
  const c = calls.find((x) => x.path === '/9/insights')
  assert.equal(c.params.time_increment, '1')
  assert.deepEqual(c.params.time_range, { since: '2026-11-01', until: '2026-11-02' })
  assert.equal((await fetchDailyMetrics(env, 'pools', { platform_ids: '{"campaignId":"9"}' }, '11/01/2026', '2026-11-02')).error, 'invalid_request')
})

test('metaBase: mock origin honored only for loopback http', () => {
  assert.equal(metaBase({}), G)
  assert.equal(metaBase({ META_API_MOCK_ORIGIN: 'http://127.0.0.1:8787' }), 'http://127.0.0.1:8787/v27.0')
  for (const bad of ['https://evil.example', 'http://localhost:1', 'http://127.0.0.1.evil.example:80']) assert.equal(metaBase({ META_API_MOCK_ORIGIN: bad }), G)
})

// ---------- webhook ----------

const sign = (raw, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
const leadgenBody = (leadgenId, pageId = '222', adId = '555') => JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: '777', ad_id: adId, created_time: 1 } }] }] })
const post = (raw, sig = sign(raw)) => call(webhook, 'POST', '/api/ads/meta/webhook', { body: raw, headers: { 'X-Hub-Signature-256': sig, Origin: '' } })
function metaLead(id) {
  meta.leads[id] = { id, ad_id: '555', form_id: '777', created_time: 'x', field_data: [{ name: 'full_name', values: ['Robin Lee'] }, { name: 'email', values: [LEAD_EMAIL] }, { name: 'phone_number', values: [LEAD_PHONE] }, { name: 'zip_code', values: ['29403'] }] }
}

test('webhook GET: verify-token handshake echoes the challenge only with the right token', async () => {
  const ok = await call(webhook, 'GET', '/api/ads/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me-test&hub.challenge=1158201444')
  assert.equal(ok.status, 200)
  assert.equal(ok.text, '1158201444')
  assert.equal((await call(webhook, 'GET', '/api/ads/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403)
  delete env.META_WEBHOOK_VERIFY_TOKEN
  assert.equal((await call(webhook, 'GET', '/api/ads/meta/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 403)
})

test('webhook POST: invalid or missing signature → 401, nothing recorded', async () => {
  await connected()
  metaLead('9001')
  const raw = leadgenBody('9001')
  assert.equal((await post(raw, sign(raw, 'wrong-secret'))).status, 401)
  assert.equal((await post(raw, '')).status, 401)
  assert.equal((await post(raw, sign(raw + ' '))).status, 401)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM meta_lead_events').get().n, 0)
  assert.equal(calls.length, 0)
})

test('webhook POST: valid lead creates one lead + attribution; duplicates create nothing', async () => {
  await connected()
  metaLead('9001')
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_ids, created_at, updated_at) VALUES ('cmp1', 'pools', 'meta', 'paused', '{}', 2500, ?, 1, 1)").run(JSON.stringify({ campaignId: '1', adId: '555' }))
  const raw = leadgenBody('9001')
  const r = await post(raw)
  assert.equal(r.status, 200)
  assert.equal(r.json().processed, 1)
  const leads = db.sql.prepare('SELECT * FROM leads').all()
  assert.equal(leads.length, 1)
  assert.equal(leads[0].customer, 'pools')
  assert.equal(leads[0].email, LEAD_EMAIL)
  assert.equal(leads[0].need, 'Facebook lead form')
  assert.equal(leads[0].status, 'new')
  const attr = db.sql.prepare('SELECT * FROM lead_attribution').get()
  assert.equal(attr.source, 'meta_lead_form')
  assert.equal(attr.campaign_id, 'cmp1')
  assert.deepEqual(JSON.parse(attr.details), { leadgenId: '9001', adId: '555', formId: '777' })
  assert.ok(!attr.details.includes(LEAD_EMAIL) && !attr.details.includes('Robin'))
  assert.equal(db.sql.prepare('SELECT status FROM meta_lead_events WHERE leadgen_id = ?').get('9001').status, 'created')
  // Meta retries the same event: nothing new, no second lead fetch.
  calls = []
  assert.equal((await post(raw)).status, 200)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM leads').get().n, 1)
  assert.equal(calls.length, 0)
})

test('webhook POST: unknown page ignored; leads go only to the business that owns the page', async () => {
  await connected('pools')
  await saveToken(env, 'meta', 'salon', { accessToken: LONG, expiresAt: Date.now() + 864e5 })
  await upsertConnection(env, 'salon', 'meta', { accountId: 'act_9', extra: { pageId: '333' }, status: 'connected' })
  metaLead('9002')
  const unknown = await post(leadgenBody('9002', '999'))
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json().processed, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM meta_lead_events').get().n, 0)
  await post(leadgenBody('9002', '333'))
  assert.equal(db.sql.prepare('SELECT customer FROM leads').get().customer, 'salon')
  assert.equal(db.sql.prepare('SELECT campaign_id FROM lead_attribution').get().campaign_id, null, "pools' campaigns never attributed to salon")
})

test('webhook POST: lead fetch failure is recorded as failed without leaking details', async () => {
  await connected()
  const r = await post(leadgenBody('9003'))
  assert.equal(r.status, 200)
  assert.equal(db.sql.prepare('SELECT status FROM meta_lead_events WHERE leadgen_id = ?').get('9003').status, 'failed')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM leads').get().n, 0)
})

test('connections: tokens for one business are never readable as another', async () => {
  await saveToken(env, 'meta', 'pools', { accessToken: LONG, expiresAt: Date.now() + 864e5 })
  assert.equal(await loadToken(env, 'meta', 'salon'), null)
  kv.set('ads:meta:salon', await encrypt({ TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)) }, '{"accessToken":"other"}'))
  assert.equal(await loadToken(env, 'meta', 'salon'), null, 'foreign ciphertext rejected')
})
