// Calls from Google ads (server/ads/calls.js): read-only, no caller details; owner marks survive re-reads; linking never moves a
// person's first source; an added caller keeps Google's campaign and gets no automatic message; tenant isolation; fail-soft.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { saveToken, upsertConnection } from '../server/ads/connections.js'
import { ADS_SCOPE } from '../server/ads/google.js'
import { addCaller, callReport, linkCall, markHandled, syncCalls } from '../server/ads/calls.js'
import { channels } from '../server/ads/economics.js'

const now = Date.parse('2026-11-23T15:00:00Z')
let sql, env, rows, queries, orig, setupOk, callStatus
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const call = (id, t, status, seconds, campaign = '7001') => ({ callView: { resourceName: `customers/1234567890/callViews/${id}`, startCallDateTime: t, callStatus: status, callDurationSeconds: String(seconds), callTrackingDisplayLocation: 'AD', callerAreaCode: '843' }, campaign: { id: campaign } })
beforeEach(async () => {
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) })
  const kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), GOOGLE_ADS_RETRY_MS: '1',
    ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) },
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
  }
  for (const id of ['pools', 'other']) sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', '29401', '09:00', '17:00', '1,2,3,4,5', 1, 1, 1)").run(id, id)
  sql.prepare("INSERT INTO ad_imported_campaigns (id, customer, platform, external_id, name, first_seen_at, synced_at) VALUES ('imp1', 'pools', 'google', '7001', 'Pool calls', 1, 1)").run()
  await saveToken(env, 'google', 'pools', { refreshToken: 'rt', clientId: 'cid', scope: ADS_SCOPE })
  await upsertConnection(env, 'pools', 'google', { accountId: '1234567890', extra: { testAccount: true }, currency: 'USD', status: 'connected' })
  rows = [call('c1', '2026-11-22 09:15:00', 'MISSED', 0), call('c2', '2026-11-21 14:05:00', 'RECEIVED', 184), call('c3', 'bad', 'RECEIVED', 1), call('c4', '2026-11-20 10:00:00', 'SOMETHING_NEW', 5, 'x')]
  queries = []
  setupOk = true
  callStatus = 200
  orig = globalThis.fetch
  globalThis.fetch = async (u, init = {}) => {
    if (String(u) === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'at', scope: ADS_SCOPE })
    const q = JSON.parse(init.body).query
    queries.push([String(u), q])
    if (/FROM call_view/.test(q)) return callStatus === 200 ? reply(200, [{ results: rows }]) : reply(callStatus, { error: {} })
    if (!setupOk) return reply(400, { error: {} })
    if (/FROM customer LIMIT/.test(q)) return reply(200, [{ results: [{ customer: { timeZone: 'America/New_York', callReportingSetting: { callReportingEnabled: true } } }] }])
    return reply(200, [{ results: /campaign_asset/.test(q) ? [{ campaignAsset: { asset: 'a/1' } }] : [] }])
  }
})
afterEach(() => void (globalThis.fetch = orig))
const db = () => env.ONBOARDING_DB
const cust = { id: 'pools', name: 'pools', serviceZips: ['29401'], timezone: 'America/New_York', automations: true }

test('reads only: no caller detail asked for or stored; unreadable rows skipped; owner marks survive the next read; 90 then 7 days', async () => {
  assert.deepEqual(await syncCalls(env, 'pools', { now }), { ok: true, calls: 3 })
  assert.ok(queries.every(([u, q]) => /searchStream$/.test(u) && !/area_code|country_code|caller/.test(q)))
  assert.ok(queries[0][1].includes("'2026-08-25 00:00:00'"))
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM google_calls').all()).includes('843'))
  const c1 = sql.prepare("SELECT * FROM google_calls WHERE id = 'c1'").get()
  assert.equal(new Date(c1.started_at).toISOString(), '2026-11-22T14:15:00.000Z')
  assert.equal(sql.prepare("SELECT status FROM google_calls WHERE id = 'c4'").get().status, 'UNKNOWN')
  await markHandled(db(), 'pools', 'c1', true, now)
  queries = []
  await syncCalls(env, 'pools', { now })
  assert.ok(queries[0][1].includes("'2026-11-16 00:00:00'"))
  const r = await callReport(db(), 'pools', { now })
  assert.deepEqual(r.totals, { calls: 3, answered: 1, missed: 1, missedOpen: 0 })
  assert.deepEqual([r.setup.reporting, r.setup.numbersOnAds], [true, 1])
  assert.equal(r.calls.find((c) => c.id === 'c2').campaign, 'Pool calls')
})

test('setup unreadable = not known, never “off”; Google failing is reported; before the migration nothing is read', async () => {
  setupOk = false
  await syncCalls(env, 'pools', { now })
  assert.deepEqual([(await callReport(db(), 'pools', { now })).setup.reporting, (await callReport(db(), 'pools', { now })).setup.numbersOnAds], [null, null])
  callStatus = 400
  assert.equal((await syncCalls(env, 'pools', { now })).ok, false)
  sql.exec('DROP TABLE google_calls')
  assert.deepEqual(await syncCalls(env, 'pools', { now }), { ok: true, skipped: 'not_ready' })
  assert.deepEqual(await callReport(db(), 'pools', { now }), { ready: false })
})

test('an added caller becomes one customer with Google’s campaign, no automatic message; a person already recorded keeps their first source', async () => {
  await syncCalls(env, 'pools', { now })
  assert.deepEqual(await addCaller(env, cust, 'call', 'c2', { name: 'A', phone: '1', need: 'x' }, now), { ok: false, error: 'invalid_name' })
  const body = { name: 'Ann Caller', phone: '(843) 555-0142', need: 'Opening', zip: '29401' }
  const r = await addCaller(env, cust, 'call', 'c2', body, now)
  assert.ok(r.ok && /\/book\/pools/.test(r.bookUrl))
  assert.equal((await addCaller(env, cust, 'call', 'c2', body, now)).error, 'already_linked')
  assert.deepEqual({ ...sql.prepare('SELECT source, campaign_id FROM lead_attribution WHERE lead_id = ?').get(r.leadId) }, { source: 'google_ads_imported', campaign_id: 'imp1' })
  assert.equal(sql.prepare('SELECT count(*) AS n FROM messages').get().n, 0)
  assert.deepEqual((await channels(db(), 'pools', { now })).channels.map((c) => [c.key, c.inquiries]), [['google_ads_imported', 1]])
  // Unlink, then again: the same customer, never a second one.
  await linkCall(db(), 'pools', 'call', 'c2', null, now)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM lead_attribution').get().n, 0)
  assert.equal((await addCaller(env, cust, 'call', 'c2', body, now)).leadId, r.leadId)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM leads').get().n, 1)
  // Someone already recorded through the booking page also called: linked, not moved.
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('old', 'pools', 'Old', '', '', 'x', '29401', 'new', 'h', 1, 1)").run()
  sql.prepare("INSERT INTO lead_attribution (lead_id, customer, source, details, created_at) VALUES ('old', 'pools', 'booking_page', '{}', 1)").run()
  await linkCall(db(), 'pools', 'call', 'c1', 'old', now)
  await linkCall(db(), 'pools', 'call', 'c1', null, now)
  assert.equal(sql.prepare("SELECT source FROM lead_attribution WHERE lead_id = 'old'").get().source, 'booking_page')
})

test('another business’s call or customer is never reachable', async () => {
  await syncCalls(env, 'pools', { now })
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('theirs', 'other', 'T', '', '', 'x', '29401', 'new', 'h2', 1, 1)").run()
  assert.equal((await linkCall(db(), 'pools', 'call', 'c1', 'theirs')).error, 'lead_not_found')
  assert.equal((await linkCall(db(), 'other', 'call', 'c1', 'theirs')).error, 'not_found')
  assert.equal((await markHandled(db(), 'other', 'c1', true)).error, 'not_found')
  assert.equal((await addCaller(env, { ...cust, id: 'other' }, 'call', 'c1', { name: 'Zed', phone: '8435550100', need: 'xx' })).error, 'not_found')
  assert.equal((await linkCall(db(), 'pools', 'nope', 'c1', null)).error, 'not_found')
})
