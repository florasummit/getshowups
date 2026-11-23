// Google Local Services Ads (server/ads/lsa.js): Google's leads for a business's Local Services campaign are read
// into lsa_leads without contact details (90 days first, 30 days restated), mapped to the imported campaign, counted
// by type/status/charged, with cost per CHARGED lead from the campaign's own spend; nothing is read for a business
// without such a campaign; the readiness checklist states facts only. node:sqlite D1, mocked fetch, no Google.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { saveToken, upsertConnection } from '../server/ads/connections.js'
import * as G from '../server/ads/google.js'
import { lsaReadiness, lsaSummary, syncLsaLeads } from '../server/ads/lsa.js'
import { listImported, syncImportedCampaigns } from '../server/ads/imports.js'

const ADS = 'https://googleads.googleapis.com/v26'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const ACCT = '1234567890'
const DAY = 86400000
const now = Date.parse('2026-11-23T15:00:00Z')
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
let env, db, kv, calls, origFetch, leads, campaigns
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const LSA = { id: '70000000002', name: 'Service Area Leads', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'LOCAL_SERVICES', biddingStrategyType: 'MANUAL_CPA' }
const lead = (id, type, status, charged, daysAgo, credit) => ({ localServicesLead: { id, leadType: type, leadStatus: status, leadCharged: charged, ...(credit ? { creditDetails: { creditState: credit } } : {}), categoryId: 'xcat:service_area_business_pool_cleaner', creationDateTime: `${ymd(now - daysAgo * DAY)} 10:15:00`, campaign: `customers/${ACCT}/campaigns/${LSA.id}`, contactDetails: { phoneNumber: '+18435550100', consumerName: 'Leak Test' } } })

function google(path, body) {
  const q = body?.query || ''
  if (path === '/customers:listAccessibleCustomers') return reply(200, { resourceNames: [`customers/${ACCT}`] })
  if (/googleAds:search$/.test(path)) return reply(200, { results: q.includes('FROM customer ') ? [{ customer: { id: ACCT, descriptiveName: 'Pools Ads', currencyCode: 'USD', testAccount: true } }] : [] })
  if (/FROM campaign WHERE campaign\.status != 'REMOVED' ORDER BY/.test(q)) return reply(200, [{ results: campaigns.map((c) => ({ campaign: c, campaignBudget: { amountMicros: '40000000', explicitlyShared: false } })) }])
  if (/segments\.date BETWEEN/.test(q)) {
    const [, since, until] = q.match(/BETWEEN '(\S+)' AND '(\S+)'/)
    const base = Date.parse(`${until}T00:00:00Z`)
    const results = []
    for (let n = 1; n <= 100; n++) {
      const date = ymd(base - n * DAY)
      if (date >= since && date <= until) results.push({ campaign: { id: LSA.id }, segments: { date }, metrics: { costMicros: '8000000', impressions: '0', clicks: '0', conversions: 0 } })
    }
    return reply(200, [{ results }])
  }
  if (/FROM local_services_lead /.test(q)) {
    assert.ok(!q.includes('contact_details') && !q.includes('note'), 'no contact details or notes are ever selected')
    const since = q.match(/creation_date_time >= '(\d{4}-\d{2}-\d{2})/)[1]
    return reply(200, [{ results: leads.filter((l) => l.localServicesLead.creationDateTime >= since) }])
  }
  return reply(200, [{ results: [] }])
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  calls = []
  campaigns = [LSA]
  leads = [lead('6001', 'PHONE_CALL', 'BOOKED', true, 2), lead('6002', 'PHONE_CALL', 'ACTIVE', true, 5), lead('6003', 'MESSAGE', 'ACTIVE', true, 9), lead('6004', 'PHONE_CALL', 'DECLINED', false, 12), lead('6005', 'PHONE_CALL', 'EXPIRED', true, 20, 'CREDITED'), lead('6006', 'BOOKING', 'NEW', false, 27), lead('6007', 'PHONE_CALL', 'EXPIRED', true, 60)]
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: KEY, ONBOARDING_DB: db, GOOGLE_ADS_RETRY_MS: '0', GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) } }
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('pools', 'Pools Co', 'UTC', '29403,29401', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(now, now, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('pools', '(843) 555-0199', 'Pool service', '', '[]', '[]', ?)").run(now)
  await saveToken(env, 'google', 'pools', { refreshToken: 'rt', clientId: 'cid', scope: G.ADS_SCOPE })
  await upsertConnection(env, 'pools', 'google', { accountId: ACCT, extra: { testAccount: true }, currency: 'USD', status: 'connected' })
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'at', scope: G.ADS_SCOPE })
    if (!u.startsWith(ADS)) throw new Error(`unexpected ${u}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: u.slice(ADS.length), body })
    return google(u.slice(ADS.length), body)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

test('leads are read for a business with a Local Services campaign (90 days first, 30 days later), mapped to the campaign, kept without contact details; re-reads update status', async () => {
  const r = await syncImportedCampaigns(env, 'pools', { now })
  assert.deepEqual([r.ok, r.campaigns, r.lsaLeads], [true, 1, 7])
  const q = calls.find((c) => /FROM local_services_lead /.test(c.body?.query || '')).body.query
  assert.ok(q.includes(`creation_date_time >= '${ymd(now - 90 * DAY)} 00:00:00'`), q)
  const rows = db.sql.prepare('SELECT * FROM lsa_leads ORDER BY id').all()
  assert.equal(rows.length, 7)
  assert.ok(rows.every((x) => x.imported_id && x.customer === 'pools' && !JSON.stringify(x).includes('5550100') && !JSON.stringify(x).includes('Leak Test')))
  assert.deepEqual(rows.map((x) => [x.lead_type, x.lead_status, x.charged, x.credit_state]).slice(0, 2), [['PHONE_CALL', 'BOOKED', 1, null], ['PHONE_CALL', 'ACTIVE', 1, null]])
  // A later read: 30-day window; a lead's status changed in Google → updated, nothing duplicated.
  calls = []
  leads[1] = lead('6002', 'PHONE_CALL', 'BOOKED', true, 5)
  const again = await syncLsaLeads(env, 'pools', { now: now + DAY })
  assert.deepEqual([again.ok, again.since], [true, ymd(now + DAY - 30 * DAY)])
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM lsa_leads').get().n, 7)
  assert.equal(db.sql.prepare("SELECT lead_status FROM lsa_leads WHERE id = '6002'").get().lead_status, 'BOOKED')
})

test('summary: counts by type/status, charged and credited, cost per CHARGED lead from the campaign’s own spend; period bounds; nothing without a campaign', async () => {
  await syncImportedCampaigns(env, 'pools', { now })
  const imported = db.sql.prepare("SELECT id FROM ad_imported_campaigns WHERE customer = 'pools'").get().id
  const s = (await lsaSummary(db, 'pools', { days: 30, now }))[imported]
  assert.deepEqual([s.total, s.charged, s.credited, s.booked], [6, 4, 1, 1])
  assert.deepEqual(s.byType, { PHONE_CALL: 4, MESSAGE: 1, BOOKING: 1 })
  assert.deepEqual([s.spendCents, s.costPerChargedLeadCents], [30 * 800, Math.round((30 * 800) / 4)])
  assert.equal(s.recent.length, 6)
  assert.ok(s.recent.every((l) => Object.keys(l).sort().join() === 'categoryId,charged,createdAt,creditState,id,status,type'))
  const week = (await lsaSummary(db, 'pools', { days: 7, now }))[imported]
  assert.deepEqual([week.total, week.charged, week.costPerChargedLeadCents], [2, 2, Math.round((7 * 800) / 2)])
  // The Ads tab payload carries the leads on the Local Services campaign and no readiness checklist.
  const l = await listImported(db, 'pools', { days: 30, now })
  assert.deepEqual([l.campaigns[0].leads.total, l.campaigns[0].leads.costPerChargedLeadCents, l.localServices.hasCampaign, l.localServices.readiness], [6, 6000, true, null])
  // A business without a Local Services campaign: nothing is read; the checklist states facts from its records.
  campaigns = [{ id: '70000000001', name: 'Search only', status: 'ENABLED', advertisingChannelType: 'SEARCH' }]
  db.sql.prepare('DELETE FROM lsa_leads').run()
  db.sql.prepare('DELETE FROM ad_imported_metrics_daily').run()
  db.sql.prepare('DELETE FROM ad_imported_campaigns').run()
  calls = []
  const r = await syncImportedCampaigns(env, 'pools', { now })
  assert.equal(r.lsaLeads, undefined)
  assert.ok(!calls.some((c) => /local_services_lead/.test(c.body?.query || '')), 'no lead query without a Local Services campaign')
  const l2 = await listImported(db, 'pools', { days: 30, now })
  assert.equal(l2.localServices.hasCampaign, false)
  const items = Object.fromEntries(l2.localServices.readiness.items.map((i) => [i.id, i.state]))
  assert.deepEqual(items, { category: 'likely', location: 'likely', google_account: 'owner', business_profile: 'owner', screening: 'owner', billing: 'owner', phone: 'done' })
  assert.equal(l2.localServices.readiness.canCreateHere, false)
})

test('readiness never claims Google’s decision: unknown trade and missing records are "check", nothing is "done" without a record', () => {
  const r = lsaReadiness({ industry: 'Quantum consulting', zips: [], profilePhone: false, gbpConnected: false })
  assert.deepEqual(Object.fromEntries(r.items.map((i) => [i.id, i.state])), { category: 'check', location: 'check', google_account: 'owner', business_profile: 'check', screening: 'owner', billing: 'owner', phone: 'check' })
  assert.equal(r.items.find((i) => i.id === 'business_profile').state, 'check')
  assert.equal(lsaReadiness({ gbpConnected: true }).items.find((i) => i.id === 'business_profile').state, 'done')
  assert.match(r.note, /Google only creates Local Services campaigns in its own setup/)
})
