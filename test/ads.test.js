// Advertising engine: strategy (AI + template, claim filtering, refusal), spend guardrails, owner
// approval, non-spending validation, live-launch switch, optimizer rules (pause/recommend only,
// idempotent), results honesty, attribution, tenant isolation, and GHL SMS ownership.
// node:sqlite D1, Map KV, mocked AI client, no network.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { sha256Hex, encrypt } from '../server/google-oauth.js'
import { validateSpec, unapprovedClaims, dailyCeilingCents } from '../server/ads/spec.js'
import { generatePlan, templatePlan, sanitizePlan, draftSpecs } from '../server/ads/strategy.js'
import { evaluate, runOptimizer } from '../server/ads/optimizer.js'
import { validateProfile, saveProfile, adResults, syncMetrics } from '../server/ads/campaigns.js'
import { recordAttribution } from '../server/ads/attribution.js'
import { processDueMessages } from '../server/messages.js'
import * as adsIndex from '../functions/api/dashboard/ads/index.js'
import * as adsProfile from '../functions/api/dashboard/ads/profile.js'
import * as adsPlan from '../functions/api/dashboard/ads/plan.js'
import * as adsBudget from '../functions/api/dashboard/ads/budget.js'
import * as adsCampaign from '../functions/api/dashboard/ads/campaign.js'
import * as adsCreative from '../functions/api/dashboard/ads/creative.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 86400000
const PROFILE = {
  website: 'https://poolthru.example',
  industry: 'Pool service',
  services: ['Weekly pool cleaning', 'Pool repair'],
  serviceArea: { zips: ['29403', '29407'], cities: ['Charleston'] },
  exclusions: 'commercial pools',
  customerValueCents: 30000,
  objective: 'leads',
  monthlyBudgetCents: 60000,
  approvedClaims: [],
}

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

let env, db, kv, logs, origError, origFetch, fetches

function seed(id, owner) {
  const now = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ADS_ENABLED: 'true',
    ADS_BUSINESSES: 'pools,salon', // per-business Ads flag (server/ads/access.js)
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
  fetches = []
  origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    fetches.push(String(url))
    throw new Error(`unexpected network call: ${url}`)
  }
})
afterEach(() => {
  console.error = origError
  globalThis.fetch = origFetch
})

async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, origin = ORIGIN } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && origin) headers.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({
    request: new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}
const owner = () => cookieFor('owner@pools.example')
const customer = { id: 'pools', name: 'PoolThru' }

const fakeClient = (response) => ({ calls: [], beta: { messages: { create: async function (p) { fakeClient.last = p; return typeof response === 'function' ? response(p) : response } } } })
const aiPlan = {
  recommendedChannels: ['google'],
  googleBudgetShare: 1,
  rationale: 'Search first.',
  google: {
    keywords: [{ text: 'pool cleaning charleston', match: 'PHRASE' }, { text: 'commercial pools', match: 'PHRASE' }],
    negativeKeywords: ['jobs', 'diy'],
    headlines: ['Charleston Pool Cleaning', 'Weekly Pool Service', '#1 Pool Company', 'Guaranteed Clean Pools', 'Book Online Today', 'This headline is far longer than thirty characters'],
    descriptions: ['Weekly cleaning for Charleston homes. Pick a time online.', 'Licensed and insured techs.', 'Tell us about your pool and choose a time that suits you.'],
  },
  meta: { primaryTexts: ['Pool looking green? Book a cleaning.'], headlines: ['Book a pool visit'], callToAction: 'GET_QUOTE' },
  imageConcepts: ['A sparkling backyard pool on a sunny day, no people.'],
  videoConcepts: ['Slow pan over a clean pool.'],
  tracking: ['Lead form submit'],
  landing: 'Booking page',
}

// ---------- spec + strategy ----------
test('claims: guarantees, discounts, credentials, superlatives, reviews and speed need owner approval', () => {
  assert.deepEqual(unapprovedClaims('Guaranteed clean or 20% off'), ['guarantee', 'discount'])
  assert.deepEqual(unapprovedClaims('Licensed and insured'), ['credential'])
  assert.deepEqual(unapprovedClaims('Licensed and insured', ['Licensed and insured']), [])
  assert.deepEqual(unapprovedClaims('5 star reviews, same-day service'), ['reviews', 'speed'])
  assert.deepEqual(unapprovedClaims('Weekly pool cleaning in Charleston'), [])
})

test('strategy: AI output is filtered to platform limits, approved claims and exclusions', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 3000 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(aiPlan) }] })
  const r = await generatePlan(env, customer, PROFILE, { client })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'ai')
  assert.deepEqual(r.plan.google.headlines, ['Charleston Pool Cleaning', 'Weekly Pool Service', 'Book Online Today'])
  assert.deepEqual(r.plan.google.descriptions.length, 2, 'credential claim dropped')
  assert.ok(!r.plan.google.keywords.some((k) => k.text === 'commercial pools'), 'excluded service is not a keyword')
  const p = fakeClient.last
  assert.equal(p.model, 'claude-opus-5-5')
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01'])
  assert.equal(p.fallbacks, 'default')
  assert.equal(p.output_config.format.type, 'json_schema')
  assert.equal(p.temperature, undefined)
  // Cost recorded from real usage: 2000×$4/M + 3000×$20/M = $0.068 → 7¢.
  assert.equal(db.sql.prepare("SELECT cost_cents FROM ai_usage WHERE kind = 'strategy'").get().cost_cents, 7)
})

test('strategy: refusal, invalid JSON and API errors return codes and keep no stray reservations', async () => {
  const refused = await generatePlan(env, customer, PROFILE, { client: fakeClient({ stop_reason: 'refusal', usage: {}, content: [] }) })
  assert.deepEqual(refused, { ok: false, error: 'ai_declined' })
  const bad = await generatePlan(env, customer, PROFILE, { client: fakeClient({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'not json' }] }) })
  assert.equal(bad.error, 'ai_invalid_output')
  const before = db.sql.prepare('SELECT count(*) AS n FROM ai_usage').get().n
  const err = await generatePlan(env, customer, PROFILE, { client: fakeClient(() => { throw Object.assign(new Error('boom secret-detail'), { status: 500 }) }) })
  assert.equal(err.ok, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ai_usage').get().n, before, 'failed call refunded')
  assert.ok(!logs.join('\n').includes('secret-detail'), 'provider messages are not logged')
})

test('strategy: without an API key a labelled template plan is produced and every draft validates', () => {
  const plan = templatePlan(customer, PROFILE)
  assert.match(plan.rationale, /without AI/)
  const [spec] = draftSpecs(customer, PROFILE, plan, { dailyCeilingCents: 1900, bookingUrl: `${ORIGIN}/book/pools` }).map((d) => ({ ...d.spec, finalUrl: d.url('abc') }))
  const [errors, normalized] = validateSpec(spec, { ceilingDailyCents: 1900 })
  assert.deepEqual(errors, [])
  assert.equal(normalized.dailyBudgetCents, 1900)
  assert.match(normalized.finalUrl, /utm_campaign=abc/)
})

test('strategy: sanitizePlan never throws on garbage and defaults to Google', () => {
  const plan = sanitizePlan({ recommendedChannels: ['tiktok'], google: { keywords: [{ text: '<script>' }] } }, PROFILE)
  assert.deepEqual(plan.recommendedChannels, ['google'])
  assert.deepEqual(plan.google.keywords, [{ text: 'script', match: 'PHRASE' }])
})

test('spec: budget above the approved ceiling is rejected', () => {
  const spec = { platform: 'google', name: 'x', dailyBudgetCents: 2000, geo: { zips: ['29403'] }, finalUrl: 'https://a.example', google: { keywords: [{ text: 'pool', match: 'PHRASE' }], negativeKeywords: [], headlines: ['A', 'B', 'C'], descriptions: ['d1', 'd2'] } }
  assert.deepEqual(validateSpec(spec, { ceilingDailyCents: 1999 })[0], ['dailyBudgetCents: exceeds the approved budget'])
  assert.deepEqual(validateSpec(spec, { ceilingDailyCents: 2000 })[0], [])
})

// ---------- routes ----------
test('routes: auth, same-origin and tenant isolation', async () => {
  for (const [mod, method, path] of [[adsIndex, 'GET', '/api/dashboard/ads'], [adsProfile, 'POST', '/x'], [adsPlan, 'POST', '/x'], [adsBudget, 'POST', '/x'], [adsCampaign, 'POST', '/x'], [adsCreative, 'POST', '/x']]) {
    assert.equal((await call(mod, method, path)).status, 401)
    if (method === 'POST') assert.equal((await call(mod, method, path, { cookie: await owner(), origin: 'https://evil.example', body: {} })).status, 403)
  }
  const c = await owner()
  assert.equal((await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })).status, 200)
  const plan = await call(adsPlan, 'POST', '/x', { cookie: c, body: {} })
  assert.equal(plan.status, 201)
  const id = plan.json.campaignIds[0]
  const other = await cookieFor('owner@salon.example')
  for (const action of ['approve', 'validate', 'pause', 'remove']) {
    assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: other, body: { action, id, confirm: true } })).status, action === 'remove' ? 409 : 404, `${action} on another business's campaign`)
  }
  const view = await call(adsIndex, 'GET', '/x', { cookie: other })
  assert.deepEqual(view.json.campaigns, [])
  assert.equal(view.json.profile, null)
})

test('routes: profile validation rejects bad input with field codes', async () => {
  const r = await call(adsProfile, 'POST', '/x', { cookie: await owner(), body: { ...PROFILE, website: 'javascript:alert(1)', serviceArea: { zips: ['abc'] }, monthlyBudgetCents: 100 } })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json.fields.sort(), ['monthlyBudget', 'website', 'zips'])
  assert.deepEqual(validateProfile({ ...PROFILE }).errors, undefined)
})

test('profile website: every business can type example.com / www / http / https; saved normalized; unsafe refused', async () => {
  const owners = { pools: await owner(), salon: await cookieFor('owner@salon.example') }
  const cases = [
    ['pools', 'poolthru.example', 'https://poolthru.example'],
    ['salon', 'www.salon.example/book?ref=1', 'https://www.salon.example/book?ref=1'],
    ['pools', 'http://poolthru.example', 'http://poolthru.example'],
    ['salon', 'https://shop.salon.example', 'https://shop.salon.example'],
    ['pools', '', ''],
  ]
  for (const [biz, input, saved] of cases) {
    const r = await call(adsProfile, 'POST', '/x', { cookie: owners[biz], body: { ...PROFILE, website: input } })
    assert.equal(r.status, 200, `${biz} ${input}`)
    assert.equal(r.json.profile.website, saved)
    const view = await call(adsIndex, 'GET', '/x', { cookie: owners[biz] })
    assert.equal(view.json.profile.website, saved, 'stored normalized, per business')
  }
  // Each business keeps its own value.
  assert.equal((await call(adsIndex, 'GET', '/x', { cookie: owners.salon })).json.profile.website, 'https://shop.salon.example')
  for (const input of ['javascript:alert(1)', 'ftp://salon.example', 'localhost:8788', 'http://169.254.169.254/', 'https://u:p@salon.example', 'not a url']) {
    const r = await call(adsProfile, 'POST', '/x', { cookie: owners.salon, body: { ...PROFILE, website: input } })
    assert.deepEqual([r.status, r.json.fields], [400, ['website']], input)
  }
  assert.equal((await call(adsIndex, 'GET', '/x', { cookie: owners.salon })).json.profile.website, 'https://shop.salon.example', 'a refused save changes nothing')
  // A value saved before this change (https) is returned exactly as stored.
  await saveProfile(db, 'pools', validateProfile({ ...PROFILE, website: 'https://poolthru.example' }).profile)
  assert.equal((await call(adsIndex, 'GET', '/x', { cookie: owners.pools })).json.profile.website, 'https://poolthru.example')
})

test('budget: owner must confirm; campaigns cannot be approved above the ceiling; launch is off by default', async () => {
  const c = await owner()
  await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })
  const { json: plan } = await call(adsPlan, 'POST', '/x', { cookie: c, body: {} })
  const id = plan.campaignIds[0]
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })).json.error, 'budget_approval_required')
  assert.equal((await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 30000 } })).json.error, 'confirmation_required')
  assert.equal((await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 999, confirm: true } })).json.error, 'invalid_budget')
  // Approve $300/mo (≈ $9.86/day) while the draft asks for the $600/mo profile budget (≈ $19.73/day).
  assert.equal((await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 30000, confirm: true } })).status, 200)
  const over = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })
  assert.equal(over.json.error, 'invalid_spec')
  assert.ok(over.json.errors.includes('dailyBudgetCents: exceeds the approved budget'))
  // Owner edits the draft to fit → approval succeeds and is audited.
  const view = await call(adsIndex, 'GET', '/x', { cookie: c })
  const spec = { ...view.json.campaigns[0].spec, dailyBudgetCents: dailyCeilingCents(30000) }
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'save', id, spec } })).status, 200)
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })).status, 200)
  // A second campaign cannot take the business over the combined ceiling.
  const second = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'save', spec: { ...spec, name: 'Second' } } })
  const r2 = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id: second.json.id } })
  assert.ok(r2.json.errors.includes('dailyBudgetCents: exceeds the approved budget'))
  // Live launch and resume are disabled without the operator switch; nothing is called.
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'launch', id } })).json.error, 'confirmation_required')
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'launch', id, confirm: true } })).json.error, 'live_launch_disabled')
  assert.equal(fetches.length, 0, 'no platform calls')
  const kinds = db.sql.prepare("SELECT kind FROM ad_actions WHERE customer = 'pools' ORDER BY at").all().map((r) => r.kind)
  assert.ok(kinds.includes('budget_approve') && kinds.includes('approve'))
})

test('editing an approved campaign returns it to draft (approval covers what the owner saw)', async () => {
  const c = await owner()
  await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })
  await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 60000, confirm: true } })
  const { json: plan } = await call(adsPlan, 'POST', '/x', { cookie: c, body: {} })
  const id = plan.campaignIds[0]
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })).status, 200)
  const { json: view } = await call(adsIndex, 'GET', '/x', { cookie: c })
  await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'save', id, spec: { ...view.campaigns[0].spec, name: 'Edited' } } })
  assert.equal(db.sql.prepare('SELECT status FROM ad_campaigns WHERE id = ?').get(id).status, 'draft')
})

test('validate: Meta dry run needs an approved image and creates nothing', async () => {
  const c = await owner()
  await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })
  db.sql.prepare("INSERT INTO ad_creatives (id, customer, kind, provider, status, prompt, storage_key, mime, created_at, updated_at) VALUES ('img00001', 'pools', 'image', 'openai', 'approved', 'p', 'k', 'image/png', 1, 1)").run()
  const spec = { version: 1, platform: 'meta', name: 'Meta test', dailyBudgetCents: 800, geo: { zips: ['29403'] }, meta: { primaryTexts: ['Pool looking green? Book a visit.'], headlines: ['Book a pool visit'], callToAction: 'GET_QUOTE', destination: 'instant_form', imageCreativeIds: ['img00001'], videoCreativeIds: [], formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'] } }
  const saved = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'save', spec } })
  assert.deepEqual(saved.json.errors, [])
  const v = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'validate', id: saved.json.id } })
  assert.equal(v.status, 200)
  assert.deepEqual(v.json, { validated: true, live: false })
  assert.equal(fetches.length, 0)
  assert.equal(db.sql.prepare('SELECT platform_campaign_id FROM ad_campaigns WHERE id = ?').get(saved.json.id).platform_campaign_id, null)
})

test('creative routes: not configured → 503; cross-tenant asset fetch → 404', async () => {
  const c = await owner()
  assert.equal((await call(adsCreative, 'POST', '/x', { cookie: c, body: { action: 'image', prompt: 'A clean backyard pool at noon' } })).status, 503)
  db.sql.prepare("INSERT INTO ad_creatives (id, customer, kind, provider, status, prompt, storage_key, mime, created_at, updated_at) VALUES ('img00002', 'pools', 'image', 'openai', 'ready', 'p', 'k2', 'image/png', 1, 1)").run()
  env.AD_ASSETS = { get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }
  assert.equal((await call(adsCreative, 'GET', '/x?id=img00002', { cookie: c })).status, 200)
  assert.equal((await call(adsCreative, 'GET', '/x?id=img00002', { cookie: await cookieFor('owner@salon.example') })).status, 404)
  assert.equal((await call(adsCreative, 'POST', '/x', { cookie: await cookieFor('owner@salon.example'), body: { action: 'approve', id: 'img00002' } })).status, 404)
})

// ---------- optimizer ----------
const camp = (over = {}) => ({ id: 'camp0001', customer: 'pools', platform: 'google', status: 'active', daily_budget_cents: 1000, ...over })
const fresh = { spend14Cents: 0, clicks14: 0, conversions14: 0, lastFetchedAt: Date.now(), yesterdaySpendCents: 0, businessMonthSpendCents: 0, leads14: 0, ownerResumedToday: false }

test('optimizer: rules pause on ceiling/overspend, alert on stale data and tracking, recommend budget cuts only', () => {
  const ctx = { approvalMonthlyCents: 30000, customerValueCents: 30000 }
  assert.equal(evaluate(camp({ status: 'paused' }), fresh, ctx).length, 0, 'only active campaigns')
  assert.equal(evaluate(camp(), fresh, { ...ctx, approvalMonthlyCents: null })[0].kind, 'pause')
  assert.deepEqual(evaluate(camp(), { ...fresh, businessMonthSpendCents: 30000 }, ctx).map((d) => [d.rule, d.status]), [['month_ceiling', 'applied']])
  assert.deepEqual(evaluate(camp(), { ...fresh, yesterdaySpendCents: 1300 }, ctx).map((d) => d.rule), ['overspend'])
  assert.deepEqual(evaluate(camp(), { ...fresh, yesterdaySpendCents: 1300, ownerResumedToday: true }, ctx).map((d) => d.rule), [], 'owner override respected')
  assert.deepEqual(evaluate(camp(), { ...fresh, lastFetchedAt: Date.now() - 40 * 3600000 }, ctx).map((d) => d.rule), ['stale_data'])
  assert.deepEqual(evaluate(camp(), { ...fresh, spend14Cents: 10000, clicks14: 200 }, ctx), [], 'not enough spend to judge')
  assert.deepEqual(evaluate(camp(), { ...fresh, spend14Cents: 20000, clicks14: 80 }, ctx).map((d) => [d.rule, d.status]), [['tracking', 'recommended'], ['no_results', 'recommended']])
  const cut = evaluate(camp(), { ...fresh, spend14Cents: 70000, clicks14: 80, leads14: 2 }, ctx)
  assert.deepEqual(cut.map((d) => [d.kind, d.status]), [['budget_down', 'recommended']])
  assert.equal(cut[0].details.toCents, 800)
  // Never an increase, whatever the data.
  for (const s of [{ ...fresh, spend14Cents: 20000, leads14: 100 }, { ...fresh, spend14Cents: 99999, leads14: 1 }]) {
    for (const d of evaluate(camp(), s, ctx)) assert.ok(['pause', 'alert', 'budget_down'].includes(d.kind) && !(d.details.toCents > 1000))
  }
})

test('optimizer: applies safety pauses once per day (idempotent) and records failures', async () => {
  const now = Date.now()
  await saveProfile(db, 'pools', validateProfile(PROFILE).profile)
  db.sql.prepare("INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES ('ap1', 'pools', 30000, 'o', ?)").run(now)
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES ('camp0001', 'pools', 'google', 'active', '{}', 1000, '123', 1, 1)").run()
  const today = new Date(now).toISOString().slice(0, 10)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, fetched_at) VALUES ('camp0001', 'pools', ?, 30500, ?)").run(today, now)
  let pauses = 0
  const failing = await runOptimizer(env, { pause: async () => ({ ok: false, error: 'platform_unavailable' }), now })
  assert.equal(failing.failed, 1)
  assert.equal(db.sql.prepare("SELECT status FROM ad_campaigns WHERE id = 'camp0001'").get().status, 'active', 'local state follows the platform')
  db.sql.prepare('DELETE FROM ad_actions').run()
  const r = await runOptimizer(env, { pause: async () => (pauses++, { ok: true }), now })
  assert.deepEqual([r.paused, pauses], [1, 1])
  db.sql.prepare("UPDATE ad_campaigns SET status = 'active' WHERE id = 'camp0001'").run()
  await runOptimizer(env, { pause: async () => (pauses++, { ok: true }), now: now + 1000 })
  assert.equal(pauses, 1, 'same rule, same day → no repeat')
  const action = db.sql.prepare('SELECT actor, kind, status FROM ad_actions').get()
  assert.deepEqual({ ...action }, { actor: 'optimizer', kind: 'pause', status: 'applied' })
})

test('metrics sync: adapter failures are counted, rows upsert idempotently', async () => {
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, created_at, updated_at) VALUES ('camp0002', 'pools', 'meta', 'active', '{}', 1000, '9', '{}', 1, 1)").run()
  const r = await syncMetrics(env)
  assert.deepEqual(r, { synced: 0, failed: 1 }, 'no campaignId in platform_ids → not_launched, counted')
})

// ---------- results + attribution ----------
test('results: unavailable (null) without data; cost per booking only when measurable; revenue is reported only', async () => {
  const empty = await adResults(db, 'pools')
  assert.equal(empty.spendCents, null)
  assert.equal(empty.costPerBookingCents, null)
  assert.equal(empty.reportedRevenueCents, null)
  assert.equal(empty.verifiedPaymentsCents, null)
  assert.equal(empty.incrementalRevenueCents, null)
  const now = Date.now()
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('camp0003', 'pools', 'google', 'active', '{}', 1000, 1, 1)").run()
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, clicks, fetched_at) VALUES ('camp0003', 'pools', ?, 5000, 10, ?)").run(new Date(now).toISOString().slice(0, 10), now)
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('lead0001', 'pools', 'n', 'e@x.example', '5', 'need', '29403', 'booked', 'h', ?, ?)").run(now, now)
  assert.deepEqual(await recordAttribution(env, 'pools', 'lead0001', { utm_source: 'google', utm_campaign: 'camp0003' }), { source: 'google_ads', campaignId: 'camp0003' })
  const r = await adResults(db, 'pools')
  assert.equal(r.spendCents, 5000)
  assert.equal(r.qualifiedLeads, 1)
  assert.equal(r.costPerQualifiedLeadCents, 5000)
  assert.equal(r.costPerBookingCents, null, 'no bookings → unavailable, not zero')
})

test('attribution: another business’s campaign id or a mismatched platform is not attributed', async () => {
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('salon001', 'salon', 'google', 'active', '{}', 1000, 1, 1)").run()
  for (const [i, utm] of [{ utm_source: 'google', utm_campaign: 'salon001' }, { utm_source: 'meta', utm_campaign: 'salon001' }, { utm_source: "x'; DROP", utm_campaign: '1' }, null].entries()) {
    db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, 'pools', 'n', 'e', '5', 'n', '1', 'new', 'h', 1, 1)").run(`lead10${i}`)
    assert.deepEqual(await recordAttribution(env, 'pools', `lead10${i}`, utm), { source: 'booking_page', campaignId: null })
  }
})

test('GHL owns texting: due SMS for that business is skipped as ghl_sms, email still goes through the normal path', async () => {
  kv.set('ghl:pools', await encrypt(env, JSON.stringify({ customer: 'pools', token: 'pit-'.padEnd(40, 'x'), locationId: 'l', pipelineId: 'p', stageIds: {}, smsVia: 'ghl', workflowId: 'wf1' })))
  const now = Date.now()
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('lead2001', 'pools', 'n', 'e@x.example', '+15550100199', 'need', '1', 'new', 'h', ?, ?)").run(now, now)
  db.sql.prepare("INSERT INTO sms_consents (lead_id, customer, wording, consented_at) VALUES ('lead2001', 'pools', 'v1', ?)").run(now)
  db.sql.prepare("INSERT INTO messages (id, customer, lead_id, kind, channel, send_at, status, created_at, updated_at) VALUES ('m1', 'pools', 'lead2001', 'lead_followup_1', 'sms', ?, 'scheduled', ?, ?)").run(now - 1000, now, now)
  env.GHL_ENABLED = 'true'
  Object.assign(env, { TWILIO_ACCOUNT_SID: 'AC'.padEnd(34, '0'), TWILIO_AUTH_TOKEN: 't'.repeat(32), TWILIO_MESSAGING_SERVICE_SID: 'MG'.padEnd(34, '0') })
  await processDueMessages(env, now)
  const m = db.sql.prepare("SELECT status, error FROM messages WHERE id = 'm1'").get()
  assert.deepEqual({ ...m }, { status: 'skipped', error: 'ghl_sms' })
  assert.equal(fetches.length, 0, 'no text sent by us')
})

test('live switch on: launch without a connected account fails safely, records the error, spends nothing; resume blocked at the monthly ceiling', async () => {
  env.ADS_LIVE_LAUNCH = 'true'
  const c = await owner()
  await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })
  await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 60000, confirm: true } })
  const { json: plan } = await call(adsPlan, 'POST', '/x', { cookie: c, body: {} })
  const id = plan.campaignIds[0]
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })).status, 200)
  const r = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'launch', id, confirm: true } })
  assert.equal(r.status, 400)
  assert.equal(db.sql.prepare('SELECT status FROM ad_campaigns WHERE id = ?').get(id).status, 'error')
  assert.equal(fetches.length, 0, 'no platform call without a connection')
  // A launched, paused campaign cannot be resumed once the month’s approved spend is used.
  db.sql.prepare("UPDATE ad_campaigns SET status = 'paused', platform_campaign_id = '1', platform_ids = '{\"campaignId\":\"1\"}' WHERE id = ?").run(id)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, fetched_at) VALUES (?, 'pools', ?, 60000, ?)").run(id, new Date().toISOString().slice(0, 10), Date.now())
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'resume', id } })).json.error, 'monthly_budget_reached')
  delete env.ADS_LIVE_LAUNCH
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'resume', id } })).json.error, 'live_launch_disabled')
})

test('billing access rule: with Stripe configured, launch needs an active or trialing subscription', async () => {
  Object.assign(env, { ADS_LIVE_LAUNCH: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' })
  const c = await owner()
  await call(adsProfile, 'POST', '/x', { cookie: c, body: PROFILE })
  await call(adsBudget, 'POST', '/x', { cookie: c, body: { monthlyCents: 60000, confirm: true } })
  const { json: plan } = await call(adsPlan, 'POST', '/x', { cookie: c, body: {} })
  const id = plan.campaignIds[0]
  await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'approve', id } })
  const r = await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'launch', id, confirm: true } })
  assert.deepEqual([r.status, r.json.error], [402, 'subscription_required'])
  db.sql.prepare("INSERT INTO subscriptions (customer, status, updated_at) VALUES ('pools', 'past_due', 1)").run()
  assert.equal((await call(adsCampaign, 'POST', '/x', { cookie: c, body: { action: 'launch', id, confirm: true } })).json.error, 'subscription_required')
  assert.equal(db.sql.prepare('SELECT status FROM ad_campaigns WHERE id = ?').get(id).status, 'approved', 'still approved, nothing attempted')
})

test('per-business flag: with the master switch on, only businesses in ADS_BUSINESSES see Ads (default: nobody)', async () => {
  const me = await import('../functions/api/dashboard/me.js')
  const onboarding = await import('../functions/api/dashboard/onboarding.js')
  const routes = [[adsIndex, 'GET'], [adsProfile, 'POST'], [adsPlan, 'POST'], [adsBudget, 'POST'], [adsCampaign, 'POST'], [adsCreative, 'POST'], [adsCreative, 'GET']]
  const pools = await owner()
  const salon = await cookieFor('owner@salon.example')
  const adsItem = async (cookie) => (await call(onboarding, 'GET', '/api/dashboard/onboarding', { cookie })).json.readiness.items.find((i) => i.id === 'ads')
  delete env.ADS_BUSINESSES // default
  for (const [mod, method] of routes) assert.equal((await call(mod, method, '/x', { cookie: pools, body: method === 'POST' ? PROFILE : undefined })).status, 404)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: pools })).json.features.ads, false)
  assert.deepEqual(await adsItem(pools), { id: 'ads', state: 'off', detail: 'not_available_yet' })
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ad_profiles').get().n, 0, 'nothing written')

  env.ADS_BUSINESSES = 'pools'
  assert.equal((await call(adsIndex, 'GET', '/x', { cookie: pools })).status, 200)
  assert.equal((await call(adsProfile, 'POST', '/x', { cookie: pools, body: PROFILE })).status, 200)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: pools })).json.features.ads, true)
  assert.deepEqual(await adsItem(pools), { id: 'ads', state: 'pending', detail: 'connect_in_ads' })
  // The unlisted business still sees nothing, and cannot write.
  for (const [mod, method] of routes) assert.equal((await call(mod, method, '/x', { cookie: salon, body: method === 'POST' ? PROFILE : undefined })).status, 404)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: salon })).json.features.ads, false)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM ad_profiles WHERE customer = 'salon'").get().n, 0)
  // Master switch off overrides the list.
  env.ADS_ENABLED = 'false'
  assert.equal((await call(adsIndex, 'GET', '/x', { cookie: pools })).status, 404)
  assert.equal((await call(me, 'GET', '/api/dashboard/me', { cookie: pools })).json.features.ads, false)
})

test('release switch: without ADS_ENABLED every ads dashboard route is 404 and me reports ads off', async () => {
  delete env.ADS_ENABLED
  const c = await owner()
  for (const [mod, method] of [[adsIndex, 'GET'], [adsProfile, 'POST'], [adsPlan, 'POST'], [adsBudget, 'POST'], [adsCampaign, 'POST'], [adsCreative, 'POST'], [adsCreative, 'GET']]) {
    assert.equal((await call(mod, method, '/x', { cookie: c, body: method === 'POST' ? PROFILE : undefined })).status, 404)
  }
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM ad_profiles').get().n, 0)
  const me = await import('../functions/api/dashboard/me.js')
  assert.deepEqual((await call(me, 'GET', '/api/dashboard/me', { cookie: c })).json.features, { ads: false, ghl: false })
})
