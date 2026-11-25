// ChatGPT Ads (OpenAI Ads API): the switch, the owner's key (validated before storing, encrypted, never shown), tenant
// isolation, spec validation (claims, limits, market/region locations), the starter draft, dry run, the no-sandbox rule
// (paused creation only for OPENAI_ADS_VERIFY_BUSINESSES, never for a test business, never a Start without the live
// switch), idempotent paused creation, read-back, the safety stop, metrics and attribution. Real handlers + every
// migration on SQLite; OpenAI is a stand-in behind fetch; nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { loadToken } from '../server/ads/connections.js'
import { validateSpec } from '../server/ads/spec.js'
import { buildPayloads, fetchDailyMetrics, mapError, openaiBase, starterSpec, trackingTemplate } from '../server/ads/openai.js'
import { launch, setCampaignStatus, setCampaignBudget, verifyLaunched, approveCampaign, saveDraft } from '../server/ads/campaigns.js'
import { enforceAdsHold } from '../server/ads/holds.js'
import { recordAttribution } from '../server/ads/attribution.js'
import { AD_SOURCES } from '../server/ads/funnel.js'
import * as keyRoute from '../functions/api/ads/openai/key.js'
import * as locRoute from '../functions/api/ads/openai/locations.js'
import * as campaignRoute from '../functions/api/dashboard/ads/campaign.js'
import * as adsIndex from '../functions/api/dashboard/ads/index.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const API = 'https://api.ads.openai.com/v1'
const GOOD = 'oai-ads-key-pools-0123456789abcdefWXYZ'
const OTHER = 'oai-ads-key-other-account-9876543210QRST'
const BAD = 'oai-ads-key-revoked-000000000000000000'

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    // D1 (and Node 24's SQLite) refuse undefined parameters; Node 26 binds them as NULL, so check like production does.
    bind: (...a) => {
      if (a.some((x) => x === undefined)) throw new TypeError(`undefined bound in: ${q.slice(0, 60)}`)
      return stmt(q, a)
    },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
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

let env, db, kv, calls, oai, responses, logs, origFetch, origError

// OpenAI Ads stand-in: one ad account per key; objects keyed by id; `fail` injects a status for "METHOD path" once.
function fakeOpenAi() {
  const m = { seq: 0, objects: {}, fail: {}, insights: [], idem: {}, forceActive: false }
  const accounts = { [GOOD]: { id: 'acct_pools', name: 'Pools Ads', status: 'active', timezone: 'America/New_York', currency_code: 'USD', url: 'https://pools.example', preview_url: null, review: {} }, [OTHER]: { id: 'acct_other', name: 'Other', status: 'active', timezone: 'UTC', currency_code: 'USD', url: 'x', preview_url: null, review: {} } }
  m.handle = (method, path, body, headers, query) => {
    const k = `${method} ${path.replace(/\/[a-z]+_\d+/g, '/:id')}`
    if (m.fail[k]?.times > 0) {
      m.fail[k].times--
      return [m.fail[k].status, { error: { message: 'Account owner@pools.example is not allowed', type: 'invalid_request_error' } }]
    }
    const acct = accounts[(headers.authorization || '').replace('Bearer ', '')]
    if (!acct) return [401, { error: { message: 'Invalid API key' } }]
    if (k === 'GET /ad_account') return [200, acct]
    if (k === 'GET /geo_lookup/search') return [200, { query: query.get('q'), count: 2, results: [{ id: '3000123', name: 'Charleston', canonical_name: 'Charleston, SC (market)', type: 'market', country_code: 'US', parent_id: null, parent_country: 'US' }, { id: 'bad id!', name: 'x', canonical_name: 'x', type: 'market', country_code: 'US', parent_id: null, parent_country: 'US' }] }]
    const create = /^\/(campaigns|ad_groups|ads)$/.exec(path)
    if (method === 'POST' && create) {
      const idem = headers['idempotency-key']
      if (idem && m.idem[idem]) return [200, m.objects[m.idem[idem]]]
      const prefix = { campaigns: 'cmpn', ad_groups: 'adgrp', ads: 'ad' }[create[1]]
      const id = `${prefix}_${++m.seq}`
      m.objects[id] = { id, kind: create[1], account: acct.id, ...body, status: m.forceActive ? 'active' : body.status, ...(create[1] === 'ads' ? { review_status: 'in_review' } : {}) }
      if (idem) m.idem[idem] = id
      return [200, m.objects[id]]
    }
    const action = /^\/(campaigns|ad_groups|ads)\/([a-z]+_\d+)\/(pause|activate)$/.exec(path)
    if (method === 'POST' && action) {
      const o = m.objects[action[2]]
      if (!o || o.account !== acct.id) return [404, { error: {} }]
      o.status = action[3] === 'pause' ? 'paused' : 'active'
      return [200, o]
    }
    const one = /^\/(campaigns|ad_groups|ads)\/([a-z]+_\d+)$/.exec(path)
    if (one) {
      const o = m.objects[one[2]]
      if (!o || o.account !== acct.id) return [404, { error: {} }]
      if (method === 'POST') Object.assign(o, body)
      return [200, o]
    }
    if (method === 'GET' && /^\/campaigns\/[a-z]+_\d+\/insights$/.test(path)) return [200, { object: 'list', data: m.insights, count: m.insights.length, first_id: null, last_id: null, has_more: false }]
    return [404, { error: {} }]
  }
  return m
}

function seed(id, owner) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  db.sql
    .prepare("INSERT INTO ad_profiles (customer, website, industry, services, service_area, objective, approved_claims, updated_at) VALUES (?, 'https://pools.example', 'pool', ?, ?, 'leads', '[]', ?)")
    .run(id, JSON.stringify(['Pool repair', 'Green pool cleanup']), JSON.stringify({ zips: ['29403', '29401'] }), now)
  db.sql.prepare("INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES (?, ?, 90000, ?, 1)").run(`ba-${id}`, id, owner)
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  responses = []
  oai = fakeOpenAi()
  env = {
    ADS_ENABLED: 'true',
    OPENAI_ADS_ENABLED: 'true',
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    OPENAI_ADS_RETRY_DELAY_MS: '1',
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    assert.ok(u.href.startsWith(API), `unexpected ${u.origin}`)
    assert.ok(init.signal, 'every OpenAI call has a timeout')
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    const path = u.pathname.replace('/v1', '')
    calls.push({ method, path, body, idem: headers['idempotency-key'] || null, query: u.searchParams })
    const [status, out] = oai.handle(method, path, body, headers, u.searchParams)
    return new Response(JSON.stringify(out), { status })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const out = logs.join('\n') + responses.join('\n') + JSON.stringify(db.sql.prepare('SELECT * FROM ad_connections').all()) + JSON.stringify(db.sql.prepare('SELECT * FROM ad_actions').all())
  for (const secret of [GOOD, OTHER, BAD, 'owner@pools.example is not allowed']) assert.ok(!out.includes(secret), `leaked ${secret}`)
  for (const v of kv.values()) for (const secret of [GOOD, OTHER]) assert.ok(!v.includes(secret), 'stored key is encrypted')
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: ORIGIN } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env })
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text) }
}
const owner = () => session('owner@pools.example')
const customer = () => db.sql.prepare("SELECT * FROM customers WHERE id = 'pools'").get()
const connect = async (key = GOOD, cookie) => call(keyRoute, 'POST', '/api/ads/openai/key', { cookie: cookie || (await owner()), body: { action: 'save', apiKey: key } })

const SPEC = {
  platform: 'openai',
  name: 'Pool repair Charleston',
  dailyBudgetCents: 1500,
  geo: { zips: ['29403'] },
  finalUrl: `${ORIGIN}/book/pools`,
  openai: { title: 'Pools Co pool repair', body: 'Pool repair in Charleston. See open times and book online.', contextHints: ['pool pump not working', 'green pool cleanup'], locations: [{ id: '3000123', name: 'Charleston, SC (market)', type: 'market' }] },
}
async function approvedDraft(spec = SPEC) {
  const s = await saveDraft(env, customer(), { spec })
  assert.ok(s.ok, JSON.stringify(s))
  assert.deepEqual(s.errors, [])
  assert.ok((await approveCampaign(env, customer(), s.id, 'owner@pools.example')).ok)
  return s.id
}
const row = (id) => db.sql.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(id)
const posts = () => calls.filter((c) => c.method === 'POST')

// ---------- the switch ----------

test('off by default: no routes, no drafts, no starter, nothing sent to OpenAI', async () => {
  delete env.OPENAI_ADS_ENABLED
  const cookie = await owner()
  assert.equal((await call(keyRoute, 'GET', '/api/ads/openai/key', { cookie })).status, 404)
  assert.equal((await call(keyRoute, 'POST', '/api/ads/openai/key', { cookie, body: { action: 'save', apiKey: GOOD } })).status, 404)
  assert.equal((await call(locRoute, 'GET', '/api/ads/openai/locations?q=charleston', { cookie })).status, 404)
  assert.equal((await call(campaignRoute, 'POST', '/api/dashboard/ads/campaign', { cookie, body: { action: 'start_openai' } })).status, 404)
  assert.equal((await saveDraft(env, customer(), { spec: SPEC })).error, 'platform_unavailable')
  const ads = (await call(adsIndex, 'GET', '/api/dashboard/ads', { cookie })).json()
  assert.equal(ads.capabilities.openai, false)
  assert.equal(calls.length, 0)
})

// ---------- the owner's key ----------

test('key: validated read-only before storing; wrong format or a refused key is never stored; only the last 4 are shown', async () => {
  const cookie = await owner()
  assert.equal((await connect('short', cookie)).json().error, 'invalid_key_format')
  const bad = await connect(BAD, cookie)
  assert.equal(bad.status, 400)
  assert.equal(bad.json().error, 'invalid_key')
  assert.equal(kv.size, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ad_connections').get().n, 0)
  const ok = await connect(GOOD, cookie)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json().account, { id: 'acct_pools', name: 'Pools Ads', currency: 'USD', status: 'active' })
  assert.equal(ok.json().last4, 'WXYZ')
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /ad_account', 'GET /ad_account'])
  assert.equal((await loadToken(env, 'openai', 'pools')).apiKey, GOOD, 'decrypts for the server only')
  const view = (await call(keyRoute, 'GET', '/api/ads/openai/key', { cookie })).json()
  assert.equal(view.connected, true)
  assert.equal(view.last4, 'WXYZ')
  const ads = (await call(adsIndex, 'GET', '/api/dashboard/ads', { cookie })).json()
  assert.equal(ads.connections.openai.last4, 'WXYZ')
  assert.equal(ads.capabilities.openai, true)
})

test('key: tenant isolation — another business never sees or uses this connection', async () => {
  await connect()
  const salon = await session('owner@salon.example')
  assert.equal((await call(keyRoute, 'GET', '/api/ads/openai/key', { cookie: salon })).json().connected, false)
  assert.equal((await call(locRoute, 'GET', '/api/ads/openai/locations?q=charleston', { cookie: salon })).status, 404)
  const id = await approvedDraft()
  const salonCustomer = db.sql.prepare("SELECT * FROM customers WHERE id = 'salon'").get()
  assert.equal((await launch(env, salonCustomer, id, 'owner@salon.example', { live: true })).error, 'not_found')
  assert.equal((await setCampaignStatus(env, salonCustomer, id, 'paused', 'owner:x')).error, 'not_found')
})

test('disconnect needs confirmation, refuses while a campaign runs, then forgets the key', async () => {
  const cookie = await owner()
  await connect(GOOD, cookie)
  assert.equal((await call(keyRoute, 'POST', '/api/ads/openai/key', { cookie, body: { action: 'disconnect' } })).status, 400)
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('run1', 'pools', 'openai', 'active', '{}', 1000, 1, 1)").run()
  assert.equal((await call(keyRoute, 'POST', '/api/ads/openai/key', { cookie, body: { action: 'disconnect', confirm: true } })).json().error, 'campaigns_running')
  db.sql.prepare("UPDATE ad_campaigns SET status = 'paused' WHERE id = 'run1'").run()
  assert.equal((await call(keyRoute, 'POST', '/api/ads/openai/key', { cookie, body: { action: 'disconnect', confirm: true } })).status, 200)
  assert.equal(kv.size, 0)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM ad_connections WHERE platform = 'openai'").get().n, 0)
})

test('locations: markets and regions through the business key; malformed ids dropped; never stored', async () => {
  const cookie = await owner()
  assert.equal((await call(locRoute, 'GET', '/api/ads/openai/locations?q=charleston', { cookie })).json().error, 'not_connected')
  await connect(GOOD, cookie)
  const r = await call(locRoute, 'GET', '/api/ads/openai/locations?q=charleston', { cookie })
  assert.deepEqual(r.json().results, [{ id: '3000123', name: 'Charleston, SC (market)', type: 'market', countryCode: 'US' }])
  assert.equal((await call(locRoute, 'GET', '/api/ads/openai/locations?q=c', { cookie })).status, 400)
})

// ---------- the spec ----------

test('spec: chat-card limits, claims filter, https landing page, 1–25 markets or regions', () => {
  assert.deepEqual(validateSpec(SPEC)[0], [])
  const bad = (patch) => validateSpec({ ...SPEC, ...patch, openai: { ...SPEC.openai, ...(patch.openai || {}) } })[0].join(' | ')
  assert.match(bad({ openai: { title: 'Hi' } }), /openai\.title/)
  assert.match(bad({ openai: { title: 'x'.repeat(51) } }), /openai\.title/)
  assert.match(bad({ openai: { body: 'y'.repeat(101) } }), /openai\.body/)
  assert.match(bad({ openai: { body: 'Guaranteed best in Charleston' } }), /unapproved claim \(guarantee\).*unapproved claim \(superlative\)|unapproved claim/)
  assert.match(bad({ openai: { contextHints: ['top-rated pool company'] } }), /contextHints\[0\]: unapproved claim/)
  assert.match(bad({ openai: { locations: [] } }), /openai\.locations/)
  assert.match(bad({ openai: { locations: [{ id: '29403', name: 'ZIP', type: 'zip' }] } }), /openai\.locations/, 'a ZIP is not a ChatGPT Ads location')
  assert.match(bad({ finalUrl: 'http://pools.example' }), /finalUrl/)
  assert.deepEqual(validateSpec({ ...SPEC, openai: { ...SPEC.openai, body: 'Guaranteed repairs.' } }, { approvedClaims: ['guaranteed'] })[0], [])
})

test('starter draft from the business records: booking page, services as context, no locations yet; one open draft', async () => {
  const cookie = await owner()
  const r = await call(campaignRoute, 'POST', '/api/dashboard/ads/campaign', { cookie, body: { action: 'start_openai' } })
  assert.equal(r.status, 200)
  const spec = JSON.parse(row(r.json().id).spec)
  assert.equal(spec.platform, 'openai')
  assert.equal(spec.finalUrl, `${ORIGIN}/book/pools`)
  assert.deepEqual(spec.openai.contextHints, ['Pool repair', 'Green pool cleanup'])
  assert.deepEqual(spec.openai.locations, [])
  assert.ok(r.json().errors.some((e) => e.startsWith('openai.locations')), 'the owner must pick a market first')
  assert.equal((await call(campaignRoute, 'POST', '/api/dashboard/ads/campaign', { cookie, body: { action: 'start_openai' } })).json().error, 'draft_exists')
  assert.deepEqual(starterSpec({ name: 'A'.repeat(80) }).openai.title.length <= 50, true)
})

// ---------- creation, the no-sandbox rule ----------

test('dry run builds exactly the paused payloads and sends nothing', async () => {
  await connect()
  calls.length = 0
  const id = await approvedDraft()
  assert.deepEqual(await launch(env, customer(), id, 'owner@pools.example', { live: false }), { ok: true, validated: true, live: false })
  assert.equal(calls.length, 0)
  const p = buildPayloads({ id, spec: SPEC })
  assert.equal(p.campaign.status, 'paused')
  assert.equal(p.adGroup.status, 'paused')
  assert.equal(p.ad.status, 'paused')
  assert.equal(p.campaign.budget.daily_spend_limit_micros, 15_000_000)
  assert.equal(p.campaign.landing_page_configuration.query_string_template, `utm_source=openai&utm_medium=paid&utm_campaign=${id}`)
  assert.deepEqual(p.campaign.targeting, { locations: { include: [{ id: '3000123' }] } })
  assert.equal(p.ad.creative.type, 'chat_card')
})

test('no sandbox: without the live switch nothing is created unless the business is on the verify list (never a test business)', async () => {
  await connect()
  const id = await approvedDraft()
  calls.length = 0
  assert.equal((await launch(env, customer(), id, 'owner@pools.example', { live: true })).error, 'live_launch_disabled')
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'salon'
  assert.equal((await launch(env, customer(), id, 'owner@pools.example', { live: true })).error, 'live_launch_disabled')
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'pools'
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('pools', 1, 'admin@x', 1)").run()
  assert.equal((await launch(env, customer(), id, 'owner@pools.example', { live: true })).error, 'live_launch_disabled', 'a test business never touches a real ad account')
  assert.equal(posts().length, 0)
})

test('verify mode: campaign, ad group and ad created PAUSED with idempotency keys, read back, and can never be started', async () => {
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'getshowups,pools'
  await connect()
  const id = await approvedDraft()
  calls.length = 0
  const r = await launch(env, customer(), id, 'owner@pools.example', { live: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.verification, { ok: true, failed: [] })
  assert.deepEqual(posts().map((c) => [c.path, c.body.status, c.idem]), [
    ['/campaigns', 'paused', `gsu-${id}-campaignId`],
    ['/ad_groups', 'paused', `gsu-${id}-adGroupId`],
    ['/ads', 'paused', `gsu-${id}-adId`],
  ])
  assert.ok(posts()[0].body.name.startsWith(`[gsu:${id}]`))
  assert.equal(posts()[1].body.campaign_id, 'cmpn_1')
  assert.equal(posts()[2].body.ad_group_id, 'adgrp_2')
  const saved = row(id)
  assert.equal(saved.status, 'paused')
  assert.equal(saved.platform_campaign_id, 'cmpn_1')
  assert.deepEqual(JSON.parse(saved.platform_ids), { accountId: 'acct_pools', campaignId: 'cmpn_1', adGroupId: 'adgrp_2', adId: 'ad_3' })
  // Starting, resuming and budget changes need the live switch; nothing is activated.
  assert.equal((await setCampaignStatus(env, customer(), id, 'active', 'owner:x')).error, 'live_launch_disabled')
  assert.equal((await setCampaignBudget(env, customer(), id, 1000, 'owner:x')).error, 'live_launch_disabled')
  assert.ok(Object.values(oai.objects).every((o) => o.status === 'paused'))
  assert.equal(calls.filter((c) => c.path.endsWith('/activate')).length, 0)
})

test('a lost response never duplicates: the retry reuses the idempotency keys and creates only what is missing', async () => {
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'pools'
  await connect()
  const id = await approvedDraft()
  oai.fail['POST /ads'] = { status: 500, times: 1 }
  assert.equal((await launch(env, customer(), id, 'owner@pools.example', { live: true })).error, 'transient')
  assert.equal(row(id).status, 'error')
  assert.deepEqual(Object.keys(JSON.parse(row(id).platform_ids)).sort(), ['accountId', 'adGroupId', 'campaignId'])
  assert.ok((await approveCampaign(env, customer(), id, 'owner@pools.example')).ok)
  calls.length = 0
  assert.ok((await launch(env, customer(), id, 'owner@pools.example', { live: true })).ok)
  assert.deepEqual(posts().map((c) => c.path), ['/ads'])
  assert.equal(Object.values(oai.objects).filter((o) => o.kind === 'campaigns').length, 1)
})

test('anything OpenAI reports as running is paused at once and the launch fails', async () => {
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'pools'
  await connect()
  const id = await approvedDraft()
  oai.forceActive = true
  assert.equal((await launch(env, customer(), id, 'owner@pools.example', { live: true })).error, 'not_paused')
  assert.equal(oai.objects.cmpn_1.status, 'paused')
  assert.equal(row(id).status, 'error')
})

test('live switch: start turns on ad, ad group, campaign; the safety stop pauses it, even with ChatGPT Ads switched off', async () => {
  env.ADS_LIVE_LAUNCH = 'true'
  await connect()
  const id = await approvedDraft()
  assert.ok((await launch(env, customer(), id, 'owner@pools.example', { live: true })).ok)
  calls.length = 0
  assert.ok((await setCampaignStatus(env, customer(), id, 'active', 'owner:x')).ok)
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/ads/ad_3/activate', '/ad_groups/adgrp_2/activate', '/campaigns/cmpn_1/activate'])
  delete env.OPENAI_ADS_ENABLED
  const r = await enforceAdsHold(env, 'pools', { hold: { reason: 'suspended' } })
  assert.equal(r.paused, 1, JSON.stringify(r))
  assert.equal(oai.objects.cmpn_1.status, 'paused')
  assert.equal(row(id).status, 'paused')
  assert.equal((await setCampaignStatus(env, customer(), id, 'active', 'owner:x')).error, 'platform_unavailable')
})

test('read-back finds differences and reconciles a campaign archived in Ads Manager; another account is never touched', async () => {
  env.OPENAI_ADS_VERIFY_BUSINESSES = 'pools'
  await connect()
  const id = await approvedDraft()
  await launch(env, customer(), id, 'owner@pools.example', { live: true })
  oai.objects.ad_3.creative.title = 'Edited in Ads Manager'
  db.sql.prepare("UPDATE ad_actions SET at = 0 WHERE kind = 'verify'").run()
  await verifyLaunched(env)
  const last = db.sql.prepare("SELECT status, reason FROM ad_actions WHERE kind = 'verify' ORDER BY at DESC LIMIT 1").get()
  assert.equal(last.status, 'failed')
  assert.match(last.reason, /Checked on ChatGPT Ads: 1 difference\(s\): ad text/)
  oai.objects.cmpn_1.status = 'archived'
  db.sql.prepare("UPDATE ad_actions SET at = 0 WHERE kind = 'verify'").run()
  await verifyLaunched(env)
  assert.equal(row(id).status, 'error')
  // The owner connects a key for a different ad account: the old campaign is never acted on through it.
  db.sql.prepare("UPDATE ad_campaigns SET status = 'paused' WHERE id = ?").run(id)
  await connect(OTHER)
  calls.length = 0
  assert.equal((await setCampaignStatus(env, customer(), id, 'paused', 'owner:x')).error, 'account_changed')
  assert.equal(calls.length, 0)
})

test('metrics: daily rows in the account time zone, spend to cents; a revoked key asks to reconnect', async () => {
  await connect()
  oai.objects.cmpn_9 = { id: 'cmpn_9', kind: 'campaigns', account: 'acct_pools', status: 'paused' }
  oai.insights = [
    { readable_time: '2026-11-20', impressions: 900, clicks: 21, spend: 12.5, conversions: 2 },
    { readable_time: 'garbage', impressions: 1, clicks: 1, spend: 1, conversions: 0 },
  ]
  const r = await fetchDailyMetrics(env, 'pools', { platform_ids: JSON.stringify({ accountId: 'acct_pools', campaignId: 'cmpn_9' }) }, '2026-11-18', '2026-11-21')
  assert.deepEqual(r.rows, [{ date: '2026-11-20', spendCents: 1250, impressions: 900, clicks: 21, conversions: 2 }])
  const q = calls.at(-1).query
  assert.deepEqual(JSON.parse(q.get('time_ranges[]')), { type: 'date_range', since: '2026-11-18', until: '2026-11-21', timezone: 'America/New_York' })
  assert.equal(q.get('time_granularity'), 'daily')
  oai.fail['GET /campaigns/:id/insights'] = { status: 401, times: 2 }
  assert.equal((await fetchDailyMetrics(env, 'pools', { platform_ids: JSON.stringify({ accountId: 'acct_pools', campaignId: 'cmpn_9' }) }, '2026-11-18', '2026-11-21')).error, 'reconnect_required')
  assert.equal(db.sql.prepare("SELECT status FROM ad_connections WHERE platform = 'openai'").get().status, 'reconnect_required')
})

test('attribution: a click on our ChatGPT ad (utm_source=openai) is an ad lead of that campaign, only for its own business', async () => {
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('oai1', 'pools', 'openai', 'paused', '{}', 1000, 1, 1)").run()
  for (const [lead, biz] of [['l1', 'pools'], ['l2', 'salon']]) db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'n', 'e', '5', 'n', '29403', 'new', 'h', 1, 1)").run(lead, biz)
  const utm = Object.fromEntries(new URLSearchParams(trackingTemplate('oai1')))
  assert.deepEqual(await recordAttribution(env, 'pools', 'l1', utm), { source: 'openai_ad_click', campaignId: 'oai1' })
  assert.deepEqual(await recordAttribution(env, 'salon', 'l2', utm), { source: 'booking_page', campaignId: null })
  assert.ok(AD_SOURCES.includes('openai_ad_click'))
})

test('errors are allowlisted codes from the HTTP status; the mock origin is loopback-only', () => {
  assert.equal(mapError(401).error, 'reconnect_required')
  assert.equal(mapError(429).retryable, true)
  assert.equal(mapError(418).error, 'invalid_request')
  assert.equal(openaiBase({ OPENAI_ADS_API_MOCK_ORIGIN: 'https://evil.example' }), API)
  assert.equal(openaiBase({ OPENAI_ADS_API_MOCK_ORIGIN: 'http://127.0.0.1:8787' }), 'http://127.0.0.1:8787/openai-ads/v1')
})
