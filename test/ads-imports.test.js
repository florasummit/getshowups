// Existing Google Ads campaigns read into GetShowUps (server/ads/imports.js, /api/dashboard/ads/imported): the
// account's own campaigns are imported read-only (type, status, budget, settings, Google-reported daily metrics),
// GetShowUps' own campaigns are skipped, re-runs are idempotent, removed campaigns are marked, detail failures
// leave a partial copy, the cron reads due businesses, the route is session-bound and isolated, and nothing exists
// before migration 0037. Real handlers + migrations on node:sqlite, Map KV, mocked fetch. Nothing talks to Google.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { saveToken, upsertConnection } from '../server/ads/connections.js'
import * as G from '../server/ads/google.js'
import { CHANNEL_LABEL, importsReady, listImported, statusLabel, syncAllImported, syncImportedCampaigns } from '../server/ads/imports.js'
import * as route from '../functions/api/dashboard/ads/imported.js'
import * as accounts from '../functions/api/ads/google/accounts.js'

const ORIGIN = 'https://getshowups.com'
const ADS = 'https://googleads.googleapis.com/v26'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const RT = '1//ads-refresh-SECRET'
const AT = 'ya29.ads-access-SECRET'
const ACCT = '1234567890'
const DAY = 86400000

const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()
function d1(files = MIGRATIONS) {
  const sql = new DatabaseSync(':memory:')
  for (const f of files) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}

let env, db, kv, calls, logs, origFetch, origError, google
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const now = Date.now()
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)

// The established advertiser's account (MOCK DATA): one running Search campaign with details, one paused Local
// Services campaign, one of GetShowUps' own (tagged), one removed.
const SEARCH = { id: '70000000001', name: 'Pool Cleaning – Charleston', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SEARCH', biddingStrategyType: 'TARGET_SPEND', startDateTime: '2026-03-01 00:00:00', networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } }
const LSA = { id: '70000000002', name: 'Service Area Leads', status: 'PAUSED', servingStatus: 'NONE', advertisingChannelType: 'LOCAL_SERVICES', biddingStrategyType: 'MANUAL_CPA' }
const OURS = { id: '70000000009', name: 'Pools Co — Search [gsu:campaign00001]', status: 'PAUSED', advertisingChannelType: 'SEARCH' }
let accountCampaigns
let failing = new Set() // detail resources whose query fails (partial copy)
function defaultGoogle(path, body) {
  const q = body?.query || ''
  if (path === '/customers:listAccessibleCustomers') return reply(200, { resourceNames: [`customers/${ACCT}`] })
  if (/googleAds:search$/.test(path)) {
    if (q.includes('FROM customer ')) return reply(200, { results: [{ customer: { id: ACCT, descriptiveName: 'Pools Ads', currencyCode: 'USD', testAccount: true } }] })
    if (q.includes('FROM customer_client')) return reply(200, { results: [{ customerClient: { id: ACCT, manager: false, descriptiveName: 'Pools Ads', currencyCode: 'USD', testAccount: true } }] })
    return reply(200, { results: [] })
  }
  if (!/googleAds:searchStream$/.test(path)) throw new Error(`unexpected ads path ${path}`)
  const inIds = q.match(/campaign\.id IN \(([^)]*)\)/)?.[1]?.split(',').map((s) => s.trim()) || []
  const wanted = (c) => inIds.includes(c.id)
  for (const res of failing) if (q.includes(`FROM ${res}`)) return reply(500, { error: { code: 500, status: 'INTERNAL', message: 'mock' } })
  if (/FROM campaign WHERE campaign\.status != 'REMOVED' ORDER BY campaign\.id/.test(q)) {
    return reply(200, [{ results: accountCampaigns.map((c) => ({ campaign: c, campaignBudget: { amountMicros: c.id === SEARCH.id ? '25000000' : c.id === LSA.id ? '40000000' : '9000000', explicitlyShared: c.id === LSA.id ? false : c.shared === true } })) }])
  }
  if (/segments\.date BETWEEN/.test(q)) {
    const [, since, until] = q.match(/BETWEEN '(\S+)' AND '(\S+)'/)
    const results = []
    const base = Date.parse(`${until}T00:00:00Z`)
    for (const c of accountCampaigns.filter(wanted)) {
      if (c.id !== SEARCH.id) continue
      for (let n = 1; n <= 100; n++) {
        const date = ymd(base - n * DAY) // Google reports finished days (yesterday and earlier)
        if (date < since || date > until) continue
        results.push({ campaign: { id: c.id }, segments: { date }, metrics: { costMicros: '21000000', impressions: '180', clicks: '9', conversions: 0.5 } })
      }
    }
    return reply(200, [{ results }])
  }
  if (/FROM campaign_criterion/.test(q)) return reply(200, [{ results: accountCampaigns.filter(wanted).filter((c) => c.id === SEARCH.id).flatMap((c) => [{ campaign: { id: c.id }, campaignCriterion: { type: 'LOCATION', negative: false, location: { geoTargetConstant: 'geoTargetConstants/1015360' } } }, { campaign: { id: c.id }, campaignCriterion: { type: 'KEYWORD', negative: true, keyword: { text: 'Jobs' } } }, { campaign: { id: c.id }, campaignCriterion: { type: 'LANGUAGE', negative: false, language: { languageConstant: 'languageConstants/1000' } } }]) }])
  if (/FROM ad_group WHERE/.test(q)) return reply(200, [{ results: accountCampaigns.filter(wanted).filter((c) => c.id === SEARCH.id).map((c) => ({ campaign: { id: c.id }, adGroup: { id: '80000000001', name: 'Weekly cleaning', status: 'ENABLED' } })) }])
  if (/FROM ad_group_criterion/.test(q)) return reply(200, [{ results: accountCampaigns.filter(wanted).filter((c) => c.id === SEARCH.id).flatMap((c) => [{ campaign: { id: c.id }, adGroup: { id: '80000000001' }, adGroupCriterion: { keyword: { text: 'Pool Cleaning Charleston', matchType: 'PHRASE' }, status: 'ENABLED' } }, { campaign: { id: c.id }, adGroup: { id: '80000000001' }, adGroupCriterion: { keyword: { text: 'pool service near me', matchType: 'EXACT' }, status: 'ENABLED' } }]) }])
  if (/FROM ad_group_ad/.test(q)) return reply(200, [{ results: accountCampaigns.filter(wanted).filter((c) => c.id === SEARCH.id).map((c) => ({ campaign: { id: c.id }, adGroup: { id: '80000000001' }, adGroupAd: { status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED' }, ad: { id: '90000000001', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://harborpool.example/book'], responsiveSearchAd: { headlines: [{ text: 'Charleston Pool Cleaning' }, { text: 'Book a Visit Online' }], descriptions: [{ text: 'Clear water every week.' }] } } } })) }])
  if (/FROM campaign_conversion_goal/.test(q)) return reply(200, [{ results: accountCampaigns.filter(wanted).filter((c) => c.id === SEARCH.id).map((c) => ({ campaign: { id: c.id }, campaignConversionGoal: { category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true } })) }])
  if (/FROM geo_target_constant/.test(q)) return reply(200, [{ results: [{ geoTargetConstant: { id: '1015360', name: 'Charleston', canonicalName: 'Charleston, South Carolina, United States', targetType: 'City' } }] }])
  return reply(200, [{ results: [] }])
}

function seed(id, owner) {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}
async function connected(customer = 'pools', accountId = ACCT) {
  await saveToken(env, 'google', customer, { refreshToken: RT, clientId: 'cid', scope: G.ADS_SCOPE })
  await upsertConnection(env, customer, 'google', { accountId, extra: { testAccount: true }, currency: 'USD', status: 'connected' })
}
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, waitUntil } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST') headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, waitUntil })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  logs = []
  accountCampaigns = [SEARCH, LSA, OURS]
  failing = new Set()
  google = defaultGoogle
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    GOOGLE_ADS_RETRY_MS: '0',
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: AT, scope: G.ADS_SCOPE })
    if (u.startsWith(ADS)) {
      const path = u.slice(ADS.length)
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ path, body })
      return google(path, body)
    }
    throw new Error(`unexpected ${u}`)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  for (const s of [RT, AT]) assert.ok(!logs.join('\n').includes(s), `must not leak ${s}`)
})

const rows = () => db.sql.prepare("SELECT external_id, name, channel_type, status, serving_status, daily_budget_cents, settings FROM ad_imported_campaigns WHERE customer = 'pools' ORDER BY external_id").all()

test('first read: the account’s own campaigns are imported read-only with settings and 90 days of Google metrics; GetShowUps’ own campaign is skipped', async () => {
  await connected()
  const r = await syncImportedCampaigns(env, 'pools', { now })
  assert.deepEqual([r.ok, r.campaigns, r.imported, r.updated, r.removed, r.partial, r.testAccount], [true, 2, 2, 0, 0, false, true])
  const got = rows()
  assert.deepEqual(got.map((x) => [x.external_id, x.channel_type, x.status, x.daily_budget_cents]), [['70000000001', 'SEARCH', 'ENABLED', 2500], ['70000000002', 'LOCAL_SERVICES', 'PAUSED', 4000]])
  const s = JSON.parse(got[0].settings)
  assert.deepEqual(s.locations, [{ name: 'Charleston, South Carolina, United States', type: 'City' }])
  assert.deepEqual(s.negativeKeywords, ['jobs'])
  assert.deepEqual(s.keywords.map((k) => `${k.text}|${k.match}`), ['pool cleaning charleston|PHRASE', 'pool service near me|EXACT'])
  assert.deepEqual([s.ads[0].headlines, s.ads[0].finalUrls, s.finalUrls, s.conversionGoals, s.bidding, s.languages, s.geoTargetType, s.startDate, s.endDate], [['Charleston Pool Cleaning', 'Book a Visit Online'], ['https://harborpool.example/book'], ['https://harborpool.example/book'], [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE' }], 'TARGET_SPEND', 1, 'PRESENCE', '2026-03-01', null])
  // The list query names only fields that exist in the v26 reference (campaign.start_date does not; the
  // date-time fields do). Production refused the first version with queryError.UNRECOGNIZED_FIELD.
  const listQuery = calls.find((c) => /FROM campaign WHERE campaign\.status/.test(c.body?.query || '')).body.query
  assert.ok(listQuery.includes('campaign.start_date_time, campaign.end_date_time') && !/campaign\.start_date[, ]/.test(listQuery) && !/campaign\.end_date[, ]/.test(listQuery), listQuery)
  assert.equal(s.externalId, undefined, 'settings never duplicate identifiers kept in columns')
  // Metrics: 90 days requested for the new campaigns, one row per day for the Search campaign.
  const m = calls.find((c) => /segments\.date BETWEEN/.test(c.body?.query || '')).body.query
  assert.ok(m.includes(`BETWEEN '${ymd(now - 90 * DAY)}' AND '${ymd(now)}'`), m)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM ad_imported_metrics_daily WHERE customer = 'pools'").get().n, 90)
  assert.equal(r.metricsRows, 90)
  // Only Google's reporting resources were queried: no mutate, no details for the Local Services campaign.
  assert.ok(calls.every((c) => !/mutate/.test(c.path)))
  assert.ok(calls.filter((c) => /FROM ad_group_criterion/.test(c.body?.query || '')).every((c) => !c.body.query.includes(LSA.id)))
  const state = db.sql.prepare("SELECT synced_at, result FROM ad_import_state WHERE customer = 'pools'").get()
  assert.equal(state.synced_at, now)
  assert.equal(JSON.parse(state.result).ok, true)
})

test('later reads are idempotent (same ids, 3-day metrics restated); a campaign Google stops listing is marked removed, never deleted', async () => {
  await connected()
  await syncImportedCampaigns(env, 'pools', { now })
  const idsBefore = db.sql.prepare('SELECT id FROM ad_imported_campaigns ORDER BY external_id').all().map((r) => r.id)
  calls = []
  const later = now + 2 * DAY
  accountCampaigns = [{ ...SEARCH, name: 'Pool Cleaning – Charleston (renamed)', status: 'PAUSED' }, OURS] // LSA gone
  const r = await syncImportedCampaigns(env, 'pools', { now: later })
  assert.deepEqual([r.imported, r.updated, r.removed, r.campaigns], [0, 1, 1, 1])
  assert.deepEqual(db.sql.prepare('SELECT id FROM ad_imported_campaigns ORDER BY external_id').all().map((r) => r.id), idsBefore)
  assert.deepEqual(rows().map((x) => [x.name, x.status]), [['Pool Cleaning – Charleston (renamed)', 'PAUSED'], ['Service Area Leads', 'REMOVED']])
  const m = calls.find((c) => /segments\.date BETWEEN/.test(c.body?.query || '')).body.query
  assert.ok(m.includes(`BETWEEN '${ymd(later - 3 * DAY)}' AND '${ymd(later)}'`), 'only recent days restated')
  assert.ok(!m.includes(LSA.id), 'removed campaigns are not synced')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM ad_imported_metrics_daily WHERE customer = 'pools'").get().n, 92, '90 + 2 new days')
  // Third read a minute later: nothing changes, nothing is duplicated.
  const again = await syncImportedCampaigns(env, 'pools', { now: later + 60000 })
  assert.deepEqual([again.imported, again.removed], [0, 0])
})

test('a failing detail query leaves a partial copy (list and metrics still arrive); Google errors are recorded and mapped', async () => {
  await connected()
  failing = new Set(['ad_group_ad'])
  const r = await syncImportedCampaigns(env, 'pools', { now })
  assert.deepEqual([r.ok, r.partial, r.campaigns], [true, true, 2])
  const s = JSON.parse(rows()[0].settings)
  assert.deepEqual([s.ads, s.keywords.length], [[], 2])
  // Access revoked: reconnect_required, connection marked, state records the failure.
  google = (path, body) => (/listAccessible|searchStream|search$/.test(path) ? reply(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'mock', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { authenticationError: 'OAUTH_TOKEN_REVOKED' } }] }] } }) : defaultGoogle(path, body))
  const bad = await syncImportedCampaigns(env, 'pools', { now: now + DAY })
  assert.equal(bad.ok, false)
  assert.equal(JSON.parse(db.sql.prepare("SELECT result FROM ad_import_state WHERE customer = 'pools'").get().result).ok, false)
  // The copy from the good read is still there for the owner.
  assert.equal(rows().length, 2)
})

test('listImported: labels, period totals, Google’s numbers only; nothing before migration 0037', async () => {
  await connected()
  await syncImportedCampaigns(env, 'pools', { now })
  const l = await listImported(db, 'pools', { days: 30, now })
  assert.equal(l.ready, true)
  assert.deepEqual(l.campaigns.map((c) => [c.name, c.channelLabel, c.state, c.dailyBudgetCents]), [['Pool Cleaning – Charleston', 'Search', 'running', 2500], ['Service Area Leads', 'Local Services', 'paused', 4000]])
  assert.deepEqual(l.campaigns[0].metrics, { spendCents: 30 * 2100, clicks: 270, impressions: 5400, conversions: 15, days: 30 })
  assert.equal(l.campaigns[1].metrics, null)
  assert.deepEqual(l.totals, { campaigns: 2, running: 1, spendCents: 63000, clicks: 270, conversions: 15 })
  assert.deepEqual([(await listImported(db, 'pools', { days: 7, now })).totals.spendCents, (await listImported(db, 'pools', { days: 90, now })).totals.spendCents], [7 * 2100, 90 * 2100])
  assert.deepEqual((await listImported(db, 'salon', { now })).campaigns, [], 'isolated')
  assert.deepEqual([CHANNEL_LABEL.PERFORMANCE_MAX, statusLabel('ENABLED', 'ENDED'), statusLabel('ENABLED', 'PENDING'), statusLabel('ENABLED', 'SUSPENDED'), statusLabel('REMOVED')], ['Performance Max', 'ended', 'scheduled', 'not serving', 'removed'])
  // Before 0037: hidden, never broken.
  const old = d1(MIGRATIONS.filter((f) => !f.startsWith('0037')))
  assert.equal(await importsReady(old), false)
  assert.deepEqual(await listImported(old, 'pools'), { ready: false })
  assert.deepEqual(await syncImportedCampaigns({ ...env, ONBOARDING_DB: old }, 'pools'), { ok: false, error: 'not_ready' })
  assert.deepEqual(await syncAllImported({ ...env, ONBOARDING_DB: old }), { skipped: 'not_ready' })
})

test('route: session business only; refresh reads Google now (409 without an account); isolation; the account choice triggers the first read', async () => {
  const pools = await session('owner@pools.example')
  const salon = await session('owner@salon.example')
  assert.equal((await call(route, 'GET', '/api/dashboard/ads/imported')).status, 401)
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/imported', { cookie: pools, body: { action: 'refresh' } })).status, 409, 'no Google Ads account chosen')
  await connected()
  const r = await call(route, 'POST', '/api/dashboard/ads/imported', { cookie: pools, body: { action: 'refresh', days: 7 } })
  assert.equal(r.status, 200, r.text)
  const j = r.json()
  assert.deepEqual([j.campaigns.length, j.days, j.sync.imported, j.totals.spendCents], [2, 7, 2, 7 * 2100])
  const g = (await call(route, 'GET', '/api/dashboard/ads/imported?days=90', { cookie: pools })).json()
  assert.deepEqual([g.campaigns.length, g.days, g.totals.spendCents, typeof g.syncedAt], [2, 90, 90 * 2100, 'number'])
  assert.equal((await call(route, 'GET', '/api/dashboard/ads/imported?days=5', { cookie: pools })).json().days, 30, 'unknown period → 30')
  const other = (await call(route, 'GET', '/api/dashboard/ads/imported', { cookie: salon })).json()
  assert.deepEqual([other.campaigns, other.syncedAt], [[], null])
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/imported', { cookie: pools, body: { action: 'hide' } })).status, 400)
  for (const t of [RT, AT, 'SECRET']) assert.ok(!r.text.includes(t) && !JSON.stringify(g).includes(t))
  // Choosing the account (POST /api/ads/google/accounts) reads the campaigns in the background.
  db.sql.prepare("DELETE FROM ad_imported_metrics_daily WHERE customer = 'pools'").run()
  db.sql.prepare("DELETE FROM ad_imported_campaigns WHERE customer = 'pools'").run()
  const pending = []
  const pick = await call(accounts, 'POST', '/api/ads/google/accounts', { cookie: pools, body: { accountId: ACCT }, waitUntil: (p) => pending.push(p) })
  assert.equal(pick.status, 200, pick.text)
  await Promise.all(pending)
  assert.equal(rows().length, 2, 'imported after the account choice')
})

test('cron: due businesses only (never read, or older than 20 h), bounded per run; one failure never stops the rest', async () => {
  await connected('pools')
  await connected('salon', '9876543210')
  seed('third', 'owner@third.example')
  await connected('third', '5551112222')
  google = (path, body) => (path.includes('/customers/9876543210/') ? reply(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'mock' } }) : defaultGoogle(path, body))
  const r1 = await syncAllImported(env, { now, limit: 2 })
  assert.deepEqual([r1.businesses, r1.synced, r1.failed], [2, 1, 1])
  assert.deepEqual(await syncAllImported(env, { now, limit: 5 }), { businesses: 1, synced: 1, failed: 0 }, 'only the never-read one is still due')
  assert.deepEqual(await syncAllImported(env, { now: now + 2 * 3600_000 }), { businesses: 1, synced: 0, failed: 1 }, 'a failed read is tried again after an hour')
  assert.deepEqual(await syncAllImported(env, { now: now + 25 * 3600_000, limit: 5 }), { businesses: 3, synced: 2, failed: 1 }, 'after 20 h everyone is due again')
})
