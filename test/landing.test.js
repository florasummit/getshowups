// Business landing pages: template draft, claims filter, publish/unpublish, public visibility only for
// published pages of bookable businesses, tenant isolation, and no contact data in the public payload.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { validatePage } from '../server/landing.js'
import * as landing from '../functions/api/dashboard/landing.js'
import * as publicPage from '../functions/api/page/[customer].js'
import * as ghlRoute from '../functions/api/dashboard/ghl.js'
import { smsHandledByGhl } from '../server/ghl.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
let env, db, kv

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  return { sql, prepare: (q) => stmt(q) }
}
function seed(id, owner, { zips = '29403,29407', bookable = true } = {}) {
  const now = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)")
    .run(id, `${id} Co`, zips, bookable ? now : null, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  if (bookable) kv.set(`google:${id}`, 'record')
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, params, origin = ORIGIN } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (method === 'POST' && origin) headers.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}/x`, { method, headers, body: body && JSON.stringify(body) }), env, params })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text), text }
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
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
})

test('draft is generated from business details, makes no claims, and is not public until published', async () => {
  const c = await cookieFor('owner@pools.example')
  const { json } = await call(landing, 'GET', { cookie: c })
  assert.equal(json.page.generated, true)
  assert.equal(json.page.published, false)
  assert.match(json.page.area, /29403, 29407/)
  assert.equal(json.url, `${ORIGIN}/p/pools`)
  assert.deepEqual(validatePage(json.page)[0], [], 'template passes its own claims filter')
  assert.equal((await call(publicPage, 'GET', { params: { customer: 'pools' } })).status, 404)
})

test('draft uses the ad profile (services, cities, owner-approved claims) when present', async () => {
  db.sql
    .prepare("INSERT INTO ad_profiles (customer, industry, services, service_area, approved_claims, updated_at) VALUES ('pools', 'Pool service', ?, ?, ?, 1)")
    .run(JSON.stringify(['Weekly pool cleaning', 'Pool repair']), JSON.stringify({ zips: ['29403'], cities: ['Charleston'] }), JSON.stringify(['Licensed and insured']))
  const { json } = await call(landing, 'GET', { cookie: await cookieFor('owner@pools.example') })
  assert.equal(json.page.headline, 'Weekly pool cleaning in Charleston')
  assert.deepEqual(json.page.highlights, ['Licensed and insured'])
  assert.deepEqual(validatePage({ ...json.page }, ['Licensed and insured'])[0], [])
})

test('publish → public; unapproved claims rejected; unpublish → 404; public payload has no contact data', async () => {
  const c = await cookieFor('owner@pools.example')
  const page = { headline: 'Pool cleaning in Charleston', intro: 'Pick a time online.', services: ['Weekly cleaning'], area: 'Charleston', highlights: [] }
  const bad = await call(landing, 'POST', { cookie: c, body: { ...page, highlights: ['5-star reviews', 'Satisfaction guaranteed'], publish: true } })
  assert.deepEqual([bad.status, bad.json.fields], [400, ['highlights:unapproved_claim']])
  assert.equal((await call(landing, 'POST', { cookie: c, body: { ...page } })).status, 400, 'publish flag required')
  assert.equal((await call(landing, 'POST', { cookie: c, body: { ...page, publish: true } })).json.page.published, true)
  const pub = await call(publicPage, 'GET', { params: { customer: 'pools' } })
  assert.equal(pub.status, 200)
  assert.deepEqual(Object.keys(pub.json).sort(), ['appointmentMode', 'area', 'headline', 'highlights', 'intro', 'name', 'services'])
  assert.ok(!pub.text.includes('owner@pools.example'))
  await call(landing, 'POST', { cookie: c, body: { ...page, publish: false } })
  assert.equal((await call(publicPage, 'GET', { params: { customer: 'pools' } })).status, 404)
})

test('isolation and guards: other businesses, cross-site writes, unbookable businesses, bad ids', async () => {
  const c = await cookieFor('owner@pools.example')
  const page = { headline: 'Pool cleaning', intro: 'Pick a time.', services: [], area: '', highlights: [], publish: true }
  assert.equal((await call(landing, 'POST', { cookie: c, body: page, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(landing, 'GET', {})).status, 401)
  await call(landing, 'POST', { cookie: c, body: page })
  const salon = await call(landing, 'GET', { cookie: await cookieFor('owner@salon.example') })
  assert.equal(salon.json.page.generated, true, 'salon sees its own draft, not the pools page')
  assert.equal((await call(publicPage, 'GET', { params: { customer: 'salon' } })).status, 404)
  seed('draftco', 'owner@draft.example', { bookable: false })
  await call(landing, 'POST', { cookie: await cookieFor('owner@draft.example'), body: page })
  assert.equal((await call(publicPage, 'GET', { params: { customer: 'draftco' } })).status, 404, 'unfinished setup is never public')
  assert.equal((await call(publicPage, 'GET', { params: { customer: '../x' } })).status, 404)
})

test('GHL release switch: off → route 404 and SMS never handed to GHL even with a stored config', async () => {
  const { encrypt } = await import('../server/google-oauth.js')
  kv.set('ghl:pools', await encrypt(env, JSON.stringify({ customer: 'pools', token: 't'.repeat(30), locationId: 'l', pipelineId: 'p', stageIds: {}, smsVia: 'ghl', workflowId: 'w' })))
  assert.equal(await smsHandledByGhl(env, 'pools'), false)
  assert.equal((await call(ghlRoute, 'GET', { cookie: await cookieFor('owner@pools.example') })).status, 404)
  env.GHL_ENABLED = 'true'
  assert.equal(await smsHandledByGhl(env, 'pools'), true)
})
