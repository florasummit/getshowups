// Campaign templates (server/ads/templates.js, /api/dashboard/ads/templates): curated templates pass the spec and
// claims rules for a real business, fit it (name, town, ZIPs, exclusions), are suggested by trade, and become ONE
// editable Google draft with an attributable landing page; an imported Search campaign becomes a normalized saved
// template (no account identifiers, only this business's own); saved drafts too; session business only; nothing
// before migration 0037. node:sqlite D1, real handlers, no network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { validateSpec } from '../server/ads/spec.js'
import { saveProfile } from '../server/ads/campaigns.js'
import { TEMPLATES, normalizeImported, startFromTemplate, suggestTemplates, templateSpec } from '../server/ads/templates.js'
import * as route from '../functions/api/dashboard/ads/templates.js'
import * as campaignRoute from '../functions/api/dashboard/ads/campaign.js'

const ORIGIN = 'https://getshowups.com'
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()
function d1(files = MIGRATIONS) {
  const sql = new DatabaseSync(':memory:')
  for (const f of files) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
let env, db
const now = Date.now()
const PROFILE = { website: '', industry: 'Pool service', services: ['Weekly pool cleaning', 'Pool repair'], serviceArea: { zips: ['29403', '29401'], cities: ['Charleston', 'Mount Pleasant'] }, exclusions: 'commercial pools', customerValueCents: 30000, objective: 'leads', monthlyBudgetCents: 60000, approvedClaims: [] }
const customer = { id: 'pools', name: 'Harbor Pool Co' }
function seed(id, owner) {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403,29401', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, id === 'pools' ? 'Harbor Pool Co' : `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
}
async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, now, now + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) headers.Cookie = cookie
  if (method === 'POST') headers.Origin = ORIGIN
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
const imported = (customerId, overrides = {}) => {
  const settings = { keywords: [{ text: 'Pool Cleaning Charleston', match: 'PHRASE', adGroupId: '8001' }, { text: 'pool service near me', match: 'EXACT', adGroupId: '8001' }, { text: 'bad chars $$$', match: 'BROAD', adGroupId: '8001' }], negativeKeywords: ['jobs', 'diy'], ads: [{ id: '9001', headlines: ['Charleston Pool Cleaning', 'Weekly Pool Service', 'Book a Visit Online', 'Licensed and Insured Pros'], descriptions: ['Clear water every week. Pick a time that suits you.', 'Tell us about your pool and choose a visit.'], finalUrls: ['https://harborpool.example/book'] }], finalUrls: ['https://harborpool.example/book'], locationIds: ['1015360'], bidding: 'TARGET_SPEND', ...overrides }
  db.sql.prepare("INSERT INTO ad_imported_campaigns (id, customer, platform, external_id, name, channel_type, status, daily_budget_cents, settings, first_seen_at, synced_at) VALUES (?, ?, 'google', ?, ?, ?, 'ENABLED', 2500, ?, ?, ?)").run(`imp${customerId}0001`, customerId, '70000000001', 'Pool Cleaning – Charleston', overrides.channel_type || 'SEARCH', JSON.stringify(settings), now, now)
  return `imp${customerId}0001`
}

beforeEach(async () => {
  db = d1()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) } }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  await saveProfile(db, 'pools', PROFILE, now)
})

test('every curated template passes the spec limits and the claims filter for a real business, fits it (name, town, ZIPs, exclusions), and is suggested by trade', () => {
  for (const t of TEMPLATES) {
    const spec = templateSpec(t, customer, PROFILE, { dailyCents: null, bookingUrl: `${ORIGIN}/book/pools` })
    const [errors, valid] = validateSpec(spec, { approvedClaims: [] })
    assert.deepEqual(errors, [], `${t.id}: ${errors.join('; ')}`)
    assert.equal(valid.google.headlines[0], 'Harbor Pool Co')
    assert.ok(valid.google.headlines.includes('Serving Charleston'), t.id)
    assert.deepEqual(valid.geo.zips, ['29403', '29401'])
    assert.ok(valid.google.negativeKeywords.includes('commercial pools'), 'owner exclusions are always negatives')
    assert.ok(valid.google.keywords.some((k) => k.text.endsWith(' charleston')), 'a local keyword from the town on record')
    assert.equal(valid.dailyBudgetCents, t.startingDailyCents)
    assert.ok(valid.google.headlines.every((h) => h.length <= 30) && valid.google.descriptions.every((d) => d.length <= 90))
  }
  // A chosen budget below the platform floor is raised to it; the business's claims never slip in.
  assert.equal(templateSpec(TEMPLATES[0], customer, PROFILE, { dailyCents: 100, bookingUrl: 'https://x' }).dailyBudgetCents, 500)
  const risky = templateSpec(TEMPLATES[0], { id: 'x', name: 'Best #1 Pools' }, PROFILE, { dailyCents: null, bookingUrl: 'https://x' })
  assert.ok(!risky.google.headlines.includes('Best #1 Pools'), 'a superlative in the business name is not an ad headline')
  const ids = (p) => suggestTemplates(p).filter((t) => t.suggested).map((t) => t.id)
  assert.deepEqual(ids(PROFILE), ['pool_cleaning', 'pool_repair'])
  assert.deepEqual(ids({ industry: 'Heating & air', services: ['AC repair'] }), ['hvac_maintenance', 'hvac_repair'])
  assert.deepEqual(ids({ industry: 'Roofing', services: [] }), ['roofing'])
  assert.deepEqual(ids({ industry: 'Dog grooming', services: [] }), [])
  assert.equal(suggestTemplates(PROFILE).length, TEMPLATES.length, 'the rest still follow')
})

test('starting from a curated template creates ONE editable Google draft with the attributable booking link; a second start is refused while it is open; the draft goes through the normal approve path', async () => {
  const cookie = await session('owner@pools.example')
  const list = (await call(route, 'GET', '/api/dashboard/ads/templates', { cookie })).json()
  assert.deepEqual([list.curated[0].id, list.curated[0].suggested, list.saved, list.savedReady], ['pool_cleaning', true, [], true])
  const r = await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'start', templateId: 'pool_repair', dailyCents: 1800 } })
  assert.equal(r.status, 200, r.text)
  const { campaignId, template, errors } = r.json()
  assert.deepEqual([template, errors], [{ source: 'curated', id: 'pool_repair', name: 'Pool repair' }, []])
  const row = db.sql.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(campaignId)
  const spec = JSON.parse(row.spec)
  assert.deepEqual([row.customer, row.platform, row.status, row.daily_budget_cents, row.platform_campaign_id], ['pools', 'google', 'draft', 1800, null])
  assert.equal(spec.finalUrl, `${ORIGIN}/book/pools?utm_source=google&utm_medium=paid&utm_campaign=${campaignId}`)
  assert.deepEqual(spec.template, { source: 'curated', id: 'pool_repair' })
  // One open draft per business: the next start says so and names it.
  const again = await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'start', templateId: 'pool_cleaning' } })
  assert.deepEqual([again.status, again.json().error, again.json().campaignIds], [409, 'draft_exists', [campaignId]])
  // Unknown or malformed template ids: nothing created.
  for (const templateId of ['nope', 'DROP TABLE', '../x']) assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'start', templateId } })).status, 404)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = 'pools'").get().n, 1)
  // The owner can approve it only with a budget approval, exactly like a planned draft.
  const approve = await call(campaignRoute, 'POST', '/api/dashboard/ads/campaign', { cookie, body: { action: 'approve', id: campaignId } })
  assert.deepEqual([approve.status, approve.json().error], [409, 'budget_approval_required'])
  // Without business details nothing starts; a business before payment or unknown gets nothing (session checks).
  const salon = await session('owner@salon.example')
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie: salon, body: { action: 'start', templateId: 'roofing' } })).json().error, 'profile_required')
  assert.equal((await call(route, 'GET', '/api/dashboard/ads/templates')).status, 401)
})

test('an imported Search campaign of THIS business becomes a normalized saved template: owner words kept, risky claims and bad keywords dropped, no account identifiers; other businesses and other campaign types are refused', async () => {
  const cookie = await session('owner@pools.example')
  const id = imported('pools')
  const n = normalizeImported(db.sql.prepare('SELECT * FROM ad_imported_campaigns WHERE id = ?').get(id), PROFILE)
  assert.equal(n.ok, true)
  assert.deepEqual(n.spec.google.keywords, [{ text: 'pool cleaning charleston', match: 'PHRASE' }, { text: 'pool service near me', match: 'EXACT' }, { text: 'bad chars', match: 'PHRASE' }])
  assert.deepEqual(n.spec.google.headlines, ['Charleston Pool Cleaning', 'Weekly Pool Service', 'Book a Visit Online'], '"Licensed and Insured" needs an approved claim')
  assert.deepEqual([n.spec.finalUrl, n.spec.geo.zips, n.spec.dailyBudgetCents, n.spec.template], ['https://harborpool.example/book', ['29403', '29401'], 2500, { source: 'imported', externalId: '70000000001' }])
  assert.ok(!JSON.stringify(n.spec).includes('8001') && !JSON.stringify(n.spec).includes('1015360') && !JSON.stringify(n.spec).includes('9001'), 'no ad group, location or ad ids')
  const r = await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'save_from_imported', importedId: id } })
  assert.equal(r.status, 200, r.text)
  const saved = (await call(route, 'GET', '/api/dashboard/ads/templates', { cookie })).json().saved
  assert.deepEqual([saved.length, saved[0].source, saved[0].name, saved[0].keywords.length, saved[0].landing], [1, 'imported', 'Pool Cleaning – Charleston', 3, 'https://harborpool.example/book'])
  // Starting from it keeps its own https landing page and the business's current ZIP codes; the draft validates.
  const start = await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'start', savedId: saved[0].id } })
  assert.equal(start.status, 200, start.text)
  const spec = JSON.parse(db.sql.prepare('SELECT spec FROM ad_campaigns WHERE id = ?').get(start.json().campaignId).spec)
  assert.deepEqual([spec.finalUrl, validateSpec(spec)[0], spec.template.source], ['https://harborpool.example/book', [], 'imported'])
  // Another business cannot copy it; a Local Services campaign cannot be copied; too little text is refused.
  const salon = await session('owner@salon.example')
  await saveProfile(db, 'salon', { ...PROFILE, industry: 'Salon' }, now)
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie: salon, body: { action: 'save_from_imported', importedId: id } })).status, 404)
  assert.deepEqual((await call(route, 'GET', '/api/dashboard/ads/templates', { cookie: salon })).json().saved, [])
  const lsa = imported('salon', { channel_type: 'LOCAL_SERVICES' })
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie: salon, body: { action: 'save_from_imported', importedId: lsa } })).json().error, 'unsupported_campaign_type')
  assert.equal(normalizeImported({ channel_type: 'SEARCH', name: 'x', settings: { keywords: [], ads: [] } }, PROFILE).error, 'not_enough_to_copy')
  // A draft becomes a saved template too (minus its attribution link); removing one is the owner's own only.
  const fromDraft = await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'save_from_draft', campaignId: start.json().campaignId, name: 'My spring version' } })
  assert.equal(fromDraft.status, 200, fromDraft.text)
  const two = (await call(route, 'GET', '/api/dashboard/ads/templates', { cookie })).json().saved
  assert.deepEqual([two.length, two[0].name, two[0].source], [2, 'My spring version', 'saved'])
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie: salon, body: { action: 'remove', id: two[0].id } })).status, 404)
  assert.equal((await call(route, 'POST', '/api/dashboard/ads/templates', { cookie, body: { action: 'remove', id: two[0].id } })).status, 200)
  assert.equal((await call(route, 'GET', '/api/dashboard/ads/templates', { cookie })).json().saved.length, 1)
})

test('before migration 0037: curated templates still work, saved ones report not ready, nothing breaks', async () => {
  const old = d1(MIGRATIONS.filter((f) => !f.startsWith('0037')))
  old.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('pools', 'Harbor Pool Co', 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(now, now, now)
  await saveProfile(old, 'pools', PROFILE, now)
  const e = { ...env, ONBOARDING_DB: old }
  assert.deepEqual(await startFromTemplate(e, customer, PROFILE, { savedId: 'abcdefgh1234' }, { bookingUrl: 'https://x' }), { ok: false, error: 'not_found' })
  const r = await startFromTemplate(e, customer, PROFILE, { templateId: 'roofing' }, { bookingUrl: `${ORIGIN}/book/pools` })
  assert.equal(r.ok, true)
  const { listTemplates } = await import('../server/ads/templates.js')
  assert.deepEqual(await listTemplates(old, 'pools'), { ready: false, saved: [] })
})
