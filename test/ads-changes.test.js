// Owner-approved changes to the account's own (imported) campaigns (server/ads/changes.js, /api/dashboard/ads/imported):
// propose → current/proposed/effect → approve (confirm) → applied through the Google Ads API → read back → recorded
// (requests, ad_actions, audit log). Pausing and lowering always work; starting and raising go through the serving
// guard and the ads hold; shared budgets and removed campaigns are refused; a newer proposal replaces an older one;
// requests expire; another business can't touch them; nothing happens on Google before the approval step.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { saveToken, upsertConnection } from '../server/ads/connections.js'
import * as G from '../server/ads/google.js'
import { applyChange, cancelChange, expectedEffect, listChanges, proposeChange, REQUEST_TTL_MS } from '../server/ads/changes.js'
import * as route from '../functions/api/dashboard/ads/imported.js'

const ORIGIN = 'https://getshowups.com'
const ADS = 'https://googleads.googleapis.com/v26'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const ACCT = '1234567890'
const now = Date.now()
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
let env, db, kv, calls, logs, origFetch, origError, google, testAccount
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const campaignOnGoogle = { id: '70000000001', status: 'ENABLED', amountMicros: '25000000', shared: false }
function defaultGoogle(path, body) {
  const q = body?.query || ''
  if (/googleAds:search$/.test(path)) {
    if (q.includes('FROM customer ')) return reply(200, { results: [{ customer: { id: ACCT, descriptiveName: 'Pools Ads', currencyCode: 'USD', testAccount } }] })
    if (/WHERE campaign\.id = 70000000001/.test(q)) return reply(200, { results: [{ campaign: { resourceName: `customers/${ACCT}/campaigns/70000000001`, id: '70000000001', status: campaignOnGoogle.status, campaignBudget: `customers/${ACCT}/campaignBudgets/70000000001`, advertisingChannelType: 'SEARCH' }, campaignBudget: { resourceName: `customers/${ACCT}/campaignBudgets/70000000001`, amountMicros: campaignOnGoogle.amountMicros, explicitlyShared: campaignOnGoogle.shared } }] })
    return reply(200, { results: [] })
  }
  if (/campaigns:mutate$/.test(path)) {
    campaignOnGoogle.status = body.operations[0].update.status
    return reply(200, { results: [{ resourceName: body.operations[0].update.resourceName }] })
  }
  if (/campaignBudgets:mutate$/.test(path)) {
    campaignOnGoogle.amountMicros = body.operations[0].update.amountMicros
    return reply(200, { results: [{ resourceName: body.operations[0].update.resourceName }] })
  }
  throw new Error(`unexpected ads path ${path}`)
}
const imported = (id, customer, extra = {}) =>
  db.sql.prepare("INSERT INTO ad_imported_campaigns (id, customer, platform, external_id, name, channel_type, status, daily_budget_cents, settings, first_seen_at, synced_at) VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)").run(id, customer, extra.externalId || '70000000001', extra.name || 'Pool Cleaning – Charleston', extra.channel || 'SEARCH', extra.status || 'ENABLED', extra.budget ?? 2500, JSON.stringify(extra.settings || {}), now, now)
function seed(id, owner) {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(method, body, cookie) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', Cookie: cookie }
  if (method === 'POST') Object.assign(headers, { Origin: ORIGIN, 'Content-Type': 'application/json' })
  const res = await route[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(`${ORIGIN}/api/dashboard/ads/imported`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
const customer = { id: 'pools', name: 'Pools Co' }

beforeEach(async () => {
  db = d1()
  kv = new Map()
  calls = []
  logs = []
  testAccount = true
  Object.assign(campaignOnGoogle, { status: 'ENABLED', amountMicros: '25000000', shared: false })
  google = defaultGoogle
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_ADS_RETRY_MS: '0', GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) } }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  await saveToken(env, 'google', 'pools', { refreshToken: 'rt', clientId: 'cid', scope: G.ADS_SCOPE })
  await upsertConnection(env, 'pools', 'google', { accountId: ACCT, extra: { testAccount: true }, currency: 'USD', status: 'connected' })
  imported('imppools0001', 'pools')
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return reply(200, { access_token: 'at', scope: G.ADS_SCOPE })
    if (!u.startsWith(ADS)) throw new Error(`unexpected ${u}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: u.slice(ADS.length), body })
    return google(u.slice(ADS.length), body)
  }
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
})
const mutates = () => calls.filter((c) => /mutate$/.test(c.path))

test('pause: proposed (nothing on Google) → the owner approves → applied through the API, read back, our copy follows, recorded and audited', async () => {
  const p = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, 'owner:o@pools.example', now)
  assert.equal(p.ok, true, JSON.stringify(p))
  assert.deepEqual([p.request.field, p.request.current, p.request.proposed, p.request.status], ['status', { status: 'ENABLED', dailyBudgetCents: 2500 }, { status: 'PAUSED' }, 'proposed'])
  assert.match(p.request.effect, /Delivery stops within minutes/)
  assert.equal(mutates().length, 0, 'nothing on Google before approval')
  const a = await applyChange(env, customer, p.request.id, 'owner:o@pools.example', now + 1000)
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.deepEqual([mutates().length, campaignOnGoogle.status, a.google], [1, 'PAUSED', { status: 'PAUSED', dailyBudgetCents: 2500 }])
  assert.equal(db.sql.prepare("SELECT status FROM ad_imported_campaigns WHERE id = 'imppools0001'").get().status, 'PAUSED')
  assert.deepEqual({ ...db.sql.prepare("SELECT status, result FROM ad_change_requests WHERE id = ?").get(p.request.id) }, { status: 'applied', result: JSON.stringify({ google: { status: 'PAUSED', dailyBudgetCents: 2500 } }) })
  const action = db.sql.prepare("SELECT kind, status, reason, actor FROM ad_actions WHERE campaign_id = 'imppools0001'").get()
  assert.deepEqual([action.kind, action.status, action.actor], ['imported_pause', 'applied', 'owner:o@pools.example'])
  assert.match(action.reason, /^Paused Pool Cleaning – Charleston/)
  const audit = { ...db.sql.prepare("SELECT action, outcome, customer FROM audit_log WHERE action = 'ads.imported_pause'").get() }
  assert.deepEqual(audit, { action: 'ads.imported_pause', outcome: 'success', customer: 'pools' })
  const lc = await listChanges(db, 'pools', { now: now + 2000 })
  assert.deepEqual([lc.imppools0001.open.length, lc.imppools0001.recent[0].status], [0, 'applied'])
  // Applying twice does nothing more; cancelling an applied one is refused.
  assert.equal((await applyChange(env, customer, p.request.id, 'owner:o', now)).error, 'not_found')
  assert.equal((await cancelChange(env, customer, p.request.id)).error, 'not_found')
})

test('start and raise go through the serving guard and the hold; lowering always works; shared budgets and removed campaigns are refused; proposals replace, expire and cancel', async () => {
  db.sql.prepare("UPDATE ad_imported_campaigns SET status = 'PAUSED' WHERE id = 'imppools0001'").run()
  campaignOnGoogle.status = 'PAUSED'
  // Not a test account and no live switch: starting is refused by Google's guard; nothing changed; recorded as failed.
  testAccount = false
  const start = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'ENABLED' }, 'owner:o', now)
  const refused = await applyChange(env, customer, start.request.id, 'owner:o', now)
  assert.deepEqual([refused.ok, refused.error, campaignOnGoogle.status, mutates().length], [false, 'test_account_required', 'PAUSED', 0])
  assert.equal(db.sql.prepare('SELECT status FROM ad_change_requests WHERE id = ?').get(start.request.id).status, 'failed')
  // With the live switch (approval) the same request would apply; here a test account lets it through.
  testAccount = true
  const again = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'ENABLED' }, 'owner:o', now)
  const ok = await applyChange(env, customer, again.request.id, 'owner:o', now)
  assert.deepEqual([ok.ok, campaignOnGoogle.status], [true, 'ENABLED'])
  // Budget: lowering always applies; raising needs the guard; the value is read back.
  const lower = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 1500 }, 'owner:o', now)
  assert.match(lower.request.effect, /Lowers the average daily budget from \$25 to \$15 \(about \$456 a month at most\)/)
  testAccount = false
  assert.deepEqual([(await applyChange(env, customer, lower.request.id, 'owner:o', now)).ok, campaignOnGoogle.amountMicros], [true, '15000000'])
  const raise = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 3000 }, 'owner:o', now)
  assert.match(raise.request.effect, /Raises the average daily budget from \$15 to \$30/)
  assert.equal((await applyChange(env, customer, raise.request.id, 'owner:o', now)).error, 'test_account_required')
  // Ads hold (suspended business): starting or raising waits; lowering still works.
  testAccount = true
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'pools'").run()
  const held = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 3000 }, 'owner:o', now)
  assert.deepEqual((await applyChange(env, customer, held.request.id, 'owner:o', now)).error, 'ads_on_hold')
  const lowerHeld = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 1000 }, 'owner:o', now)
  assert.equal((await applyChange(env, customer, lowerHeld.request.id, 'owner:o', now)).ok, true)
  db.sql.prepare("UPDATE customers SET status = 'active' WHERE id = 'pools'").run()
  // Refusals before anything is written.
  assert.equal((await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 1000 }, 'o', now)).error, 'no_change')
  assert.equal((await proposeChange(env, customer, { importedId: 'imppools0001', field: 'daily_budget', value: 100 }, 'o', now)).error, 'invalid_budget')
  assert.equal((await proposeChange(env, customer, { importedId: 'imppools0001', field: 'name', value: 'x' }, 'o', now)).error, 'invalid_request')
  imported('imppools0002', 'pools', { externalId: '70000000002', status: 'REMOVED' })
  assert.equal((await proposeChange(env, customer, { importedId: 'imppools0002', field: 'status', value: 'PAUSED' }, 'o', now)).error, 'campaign_removed')
  imported('imppools0003', 'pools', { externalId: '70000000003', settings: { sharedBudget: true } })
  assert.equal((await proposeChange(env, customer, { importedId: 'imppools0003', field: 'daily_budget', value: 1000 }, 'o', now)).error, 'shared_budget')
  // A newer proposal replaces the older one; an old one expires; cancel works once.
  const a = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, 'o', now)
  const b = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, 'o', now + 1)
  assert.equal(db.sql.prepare('SELECT status FROM ad_change_requests WHERE id = ?').get(a.request.id).status, 'cancelled')
  assert.equal((await applyChange(env, customer, b.request.id, 'o', now + REQUEST_TTL_MS + 60_000)).error, 'request_expired')
  const c = await proposeChange(env, customer, { importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, 'o', now)
  assert.deepEqual([(await cancelChange(env, customer, c.request.id)).ok, (await cancelChange(env, customer, c.request.id)).ok], [true, false])
})

test('route: session business only, confirm required, isolation, allowlisted errors; the payload carries open requests and no tokens', async () => {
  const pools = await session('owner@pools.example')
  const salon = await session('owner@salon.example')
  assert.equal((await call('POST', { action: 'propose', importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, salon)).status, 404, 'another business')
  const p = await call('POST', { action: 'propose', importedId: 'imppools0001', field: 'status', value: 'PAUSED' }, pools)
  assert.equal(p.status, 200, p.text)
  const req = p.json().request
  assert.deepEqual([req.status, p.json().changes.imppools0001.open.length], ['proposed', 1])
  assert.equal((await call('POST', { action: 'apply', id: req.id }, pools)).status, 400, 'confirm required')
  assert.equal((await call('POST', { action: 'apply', id: req.id, confirm: true }, salon)).status, 404)
  const a = await call('POST', { action: 'apply', id: req.id, confirm: true }, pools)
  assert.equal(a.status, 200, a.text)
  assert.deepEqual([a.json().google, a.json().campaigns[0].status], [{ status: 'PAUSED', dailyBudgetCents: 2500 }, 'PAUSED'])
  assert.ok(!a.text.includes('"at"') || !a.text.includes('ya29'), 'no token')
  assert.equal((await call('POST', { action: 'propose', importedId: 'imppools0001', field: 'daily_budget', value: 2500 }, pools)).json().error, 'no_change')
  assert.equal((await call('POST', { action: 'cancel', id: 'nope-nope' }, pools)).status, 404)
  const g = await call('GET', undefined, pools)
  assert.deepEqual([g.status, g.json().changes.imppools0001.recent.length], [200, 1])
  assert.deepEqual(expectedEffect('status', { status: 'PAUSED' }, { status: 'ENABLED' }, { channelType: 'LOCAL_SERVICES' }).startsWith('Google starts offering'), true)
})
