// Recommendations for the account's own campaigns (server/ads/recommend.js): deterministic, recommendation-only,
// minimum data, never more spend; the cron writes each finding once per campaign/rule/day; the Ads tab lists the
// newest per rule. Attribution of leads to an imported campaign through its own link parameters (source
// google_ads_imported) is counted apart from GetShowUps' campaigns in the funnel and the results route.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { evaluateImported, listRecommendations, recommendImported } from '../server/ads/recommend.js'
import { recordAttribution } from '../server/ads/attribution.js'
import { funnel } from '../server/ads/funnel.js'
import { importedTotals } from '../server/ads/imports.js'
import * as results from '../functions/api/dashboard/results.js'

const ORIGIN = 'https://getshowups.com'
const now = Date.now()
const DAY = 86400000
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
let db, env
const search = (over = {}) => ({ id: 'imp0001', customer: 'pools', channel_type: 'SEARCH', status: 'ENABLED', daily_budget_cents: 2500, settings: { networks: { googleSearch: true, searchPartners: false, display: false }, geoTargetType: 'PRESENCE' }, ...over })
const fresh = { spend14Cents: 30000, clicks14: 120, conversions14: 6, lastFetchedAt: now - 3600_000, gsuLeads14: 0 }
const imported = (id, customer, over = {}) =>
  db.sql.prepare("INSERT INTO ad_imported_campaigns (id, customer, platform, external_id, name, channel_type, status, daily_budget_cents, settings, first_seen_at, synced_at) VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)").run(id, customer, over.externalId || '70000000001', over.name || 'Pool Cleaning', over.channel || 'SEARCH', over.status || 'ENABLED', over.budget ?? 2500, JSON.stringify(over.settings || { networks: { display: true } }), now, now)
const metrics = (id, customer, n, spend, clicks, conv) => {
  for (let i = 1; i <= n; i++) db.sql.prepare('INSERT INTO ad_imported_metrics_daily (imported_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(id, customer, day(now - i * DAY), spend, clicks, conv, now)
}

beforeEach(() => {
  db = d1()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } }
  for (const id of ['pools', 'salon']) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  }
})

test('rules: minimum data, never more spend, each finding explains itself; paused campaigns and stale numbers are handled first', () => {
  const rules = (c, s, lsa = null, ctx = {}) => evaluateImported(c, s, lsa, ctx, now).map((d) => d.rule)
  assert.deepEqual(rules(search({ status: 'PAUSED' }), fresh), [], 'only running campaigns')
  assert.deepEqual(rules(search(), { ...fresh, lastFetchedAt: now - 40 * 3600_000 }), ['stale'])
  assert.deepEqual(rules(search(), { ...fresh, spend14Cents: 5000, clicks14: 100, conversions14: 0 }), [], 'not enough spend to judge')
  assert.deepEqual(rules(search(), { ...fresh, conversions14: 0 }), ['no_conversions'])
  assert.deepEqual(rules(search(), { ...fresh, conversions14: 0, gsuLeads14: 3 }), [], 'GetShowUps leads count as results')
  assert.deepEqual(rules(search(), { ...fresh, spend14Cents: 33000 }), ['budget_limited'])
  assert.deepEqual(rules(search({ settings: { networks: { display: true, searchPartners: true }, geoTargetType: 'PRESENCE_OR_INTEREST' } }), fresh), ['display_on', 'partners_on', 'geo_interest'])
  const all = evaluateImported(search({ settings: { networks: { display: true } } }), { ...fresh, conversions14: 0 }, null, {}, now)
  for (const d of all) {
    assert.ok(d.title && d.observed && d.suggestion && d.mechanism && ['high', 'medium', 'low'].includes(d.confidence) && d.limits && /approval/.test(d.approval), d.rule)
    assert.ok(!/raise|increase/i.test(d.suggestion) || /Only you decide/.test(d.suggestion), 'never recommends more spend by itself')
  }
  assert.equal(all[0].id, `imp0001:no_conversions:${day(now)}`)
  // Local Services: charged leads and cost per charged lead against the first-job value.
  const lsa = search({ channel_type: 'LOCAL_SERVICES' })
  assert.deepEqual(rules(lsa, fresh, { spendCents: 20000, charged: 0, total: 3, costPerChargedLeadCents: null }), ['lsa_no_charged_leads'])
  assert.deepEqual(rules(lsa, fresh, { spendCents: 60000, charged: 6, total: 8, costPerChargedLeadCents: 10000 }, { customerValueCents: 15000 }), ['lsa_cpl_high'])
  assert.deepEqual(rules(lsa, fresh, { spendCents: 60000, charged: 6, total: 8, costPerChargedLeadCents: 10000 }, { customerValueCents: 30000 }), [], 'within half the job value')
  assert.deepEqual(rules(lsa, fresh, { spendCents: 60000, charged: 3, total: 3, costPerChargedLeadCents: 20000 }, { customerValueCents: 15000 }), [], 'fewer than 5 charged leads: no judgement')
})

test('cron: findings written once per campaign/rule/day; the Ads tab lists the newest per rule; per business', async () => {
  imported('imp0001', 'pools')
  imported('imp0002', 'salon', { externalId: '70000000009', settings: { networks: { display: false } } })
  metrics('imp0001', 'pools', 14, 2200, 10, 0)
  metrics('imp0002', 'salon', 14, 2200, 10, 1)
  const r1 = await recommendImported(env, { now })
  assert.deepEqual([r1.campaigns, r1.recommended], [2, 2], 'pools: no conversions + display on; salon: nothing')
  assert.deepEqual(await recommendImported(env, { now }), { campaigns: 2, recommended: 0 }, 'same day: no duplicates')
  assert.equal((await recommendImported(env, { now: now + DAY })).recommended, 2, 'next day: recorded again')
  const l = await listRecommendations(db, 'pools', { now: now + DAY })
  assert.deepEqual(l.imp0001.map((x) => [x.rule, x.level]), [['no_conversions', 'act'], ['display_on', 'watch']])
  assert.equal(l.imp0002, undefined)
  assert.deepEqual(Object.keys(await listRecommendations(db, 'salon', { now })), [])
  assert.equal(db.sql.prepare("SELECT status FROM ad_imported_campaigns WHERE id = 'imp0001'").get().status, 'ENABLED', 'nothing changed by itself')
})

test('attribution: a lead from an imported campaign’s own link is credited to it, counted apart from GetShowUps campaigns in the funnel and the results route', async () => {
  imported('imp0001', 'pools')
  metrics('imp0001', 'pools', 10, 2100, 9, 0.5)
  const lead = (id, attribution) => {
    db.sql.prepare("INSERT INTO leads (id, customer, token_hash, name, email, phone, need, zip, status, created_at, updated_at) VALUES (?, 'pools', ?, 'Lead', ?, '+18435550100', 'x', '29403', 'new', ?, ?)").run(id, `hash-${id}`, `${id}@example.net`, now - 3600_000, now - 3600_000)
    return recordAttribution(env, 'pools', id, attribution, now)
  }
  assert.deepEqual(await lead('l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1', { utm_source: 'google', utm_medium: 'paid', utm_campaign: '70000000001' }), { source: 'google_ads_imported', campaignId: 'imp0001' })
  assert.deepEqual(await lead('l2l2l2l2l2l2l2l2l2l2l2l2l2l2l2l2', { utm_source: 'google', utm_campaign: '70009999999' }), { source: 'booking_page', campaignId: null }, 'an unknown Google campaign id is not credited')
  assert.deepEqual(await lead('l3l3l3l3l3l3l3l3l3l3l3l3l3l3l3l3', {}), { source: 'booking_page', campaignId: null })
  const f = await funnel(db, 'pools', { days: 30, scope: 'ads', now })
  assert.deepEqual([f.stages.leads, f.attribution], [0, { allLeads: 3, adLeads: 0, importedLeads: 1, unattributed: 2 }], 'not counted against GetShowUps campaign spend')
  assert.deepEqual(await importedTotals(db, 'pools', { days: 30, now }), { campaigns: 1, spendCents: 21000, clicks: 90, conversions: 5 })
  assert.equal(await importedTotals(db, 'salon', { days: 30, now }), null)
  const token = 'ownerxpoolsxexample'.padEnd(43, 'Q')
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), 'owner@pools.example', now, now + 864e5)
  const res = await results.onRequestGet({ request: new Request(`${ORIGIN}/api/dashboard/results?days=30&scope=ads`, { headers: { Cookie: `__Host-gsu_session=${token}` } }), env })
  const j = await res.json()
  assert.deepEqual([res.status, j.imported, j.funnel.attribution.importedLeads], [200, { campaigns: 1, spendCents: 21000, clicks: 90, conversions: 5 }, 1])
})
