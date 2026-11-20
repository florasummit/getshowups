// Customers keep editing while we deploy: a page left open (an older draft, another tab or device, an older release's
// bundle) must never publish or save over newer work, a restore must never lose the unpublished draft, and the
// invented-number check compares whole numbers (not digit substrings of a phone or ZIP).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { inventedNumbers } from '../server/fact-numbers.js'
import { inventedNumbers as reexported } from '../server/website-ai.js'
import { validateSpec } from '../server/site-spec.js'
import { shouldReload } from '../src/lib/lazy.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as profileApi from '../functions/api/dashboard/profile.js'
import * as policiesApi from '../functions/api/dashboard/policies.js'
import * as hoursApi from '../functions/api/dashboard/hours.js'

const ORIGIN = 'https://getshowups.com'
const ID = 'clear-pools'
let env, db

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}

beforeEach(() => {
  db = d1()
  const kv = new Map([[`google:${ID}`, 'record']])
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
  }
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, 'Clear Pools', 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(ID, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${ID}.example`, ID, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0100', 'Pool service', '', '[]', '[]', ?)").run(ID, now)
})

async function cookie() {
  const token = 'deploysafetyowner'.padEnd(43, 'Q')
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), `owner@${ID}.example`, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(method, body, mod = website) {
  const headers = { 'CF-Connecting-IP': '203.0.113.9', Cookie: await cookie() }
  if (method === 'POST') headers.Origin = ORIGIN
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}/api/dashboard/x`, { method, headers, body: body && JSON.stringify(body) }), env, params: {}, waitUntil: () => {} })
  return { status: res.status, json: await res.json() }
}
const row = () => db.sql.prepare('SELECT draft, live_version, updated_at FROM websites WHERE customer = ?').get(ID)
const tick = () => new Promise((r) => setTimeout(r, 3))

test('publish from a page showing an older draft: 409 conflict, nothing published, the newer draft kept', async () => {
  const first = (await call('GET')).json.website
  assert.equal((await call('POST', { action: 'save', content: { ...first.draft, headline: 'Saved first' } })).status, 200)
  await tick()
  const opened = (await call('GET')).json.website // tab A opens the editor on the saved draft
  assert.ok(Number.isFinite(opened.updatedAt))
  const savedA = (await call('POST', { action: 'save', content: { ...opened.draft, headline: 'Newer, from another tab' }, baseUpdatedAt: row().updated_at })).json.website
  await tick()
  // Tab A still shows the draft it opened with, and publishes it.
  const stale = await call('POST', { action: 'publish', content: { ...opened.draft, headline: 'Old tab' }, confirm: true, baseUpdatedAt: opened.updatedAt })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error, 'conflict')
  assert.equal(stale.json.website.draft.headline, 'Newer, from another tab', 'the 409 carries the latest draft to review')
  assert.equal(row().live_version, null, 'nothing went live')
  assert.equal(JSON.parse(row().draft).headline, 'Newer, from another tab')
  assert.equal(db.sql.prepare('SELECT count(*) n FROM website_versions WHERE customer = ?').get(ID).n, 0)
  // Publishing the draft the owner actually sees works.
  const ok = await call('POST', { action: 'publish', content: savedA.draft, confirm: true, baseUpdatedAt: savedA.updatedAt })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.website.liveVersion ?? row().live_version, 1)
})

test('publish without baseUpdatedAt (a page from before this release) still works', async () => {
  const w = (await call('GET')).json.website
  const r = await call('POST', { action: 'publish', content: { ...w.draft, headline: 'From an older page' }, confirm: true })
  assert.equal(r.status, 200)
  assert.equal(row().live_version, 1)
})

test('publish never moves the draft version stamp backwards: an editor holding the pre-publish stamp gets a conflict', async () => {
  const w = (await call('GET')).json.website
  const saved = (await call('POST', { action: 'save', content: { ...w.draft, headline: 'One' } })).json.website
  // Force the race the old code allowed: the last save is stamped in the future relative to the publish clock.
  db.sql.prepare('UPDATE websites SET updated_at = updated_at + 60000 WHERE customer = ?').run(ID)
  const before = row().updated_at
  assert.equal((await call('POST', { action: 'publish', content: { ...saved.draft, headline: 'Published' }, confirm: true })).status, 200)
  assert.ok(row().updated_at > before, 'stamp moved forward')
  const r = await call('POST', { action: 'save', content: { ...saved.draft, headline: 'Stale editor' }, baseUpdatedAt: before })
  assert.equal(r.status, 409)
  assert.equal(JSON.parse(row().draft).headline, 'Published')
})

test('restoring an earlier version keeps the unpublished draft as a checkpoint first', async () => {
  const w = (await call('GET')).json.website
  assert.equal((await call('POST', { action: 'publish', content: { ...w.draft, headline: 'Version one' }, confirm: true })).status, 200)
  await tick()
  assert.equal((await call('POST', { action: 'publish', content: { ...w.draft, headline: 'Version two' }, confirm: true })).status, 200)
  await tick()
  assert.equal((await call('POST', { action: 'save', content: { ...w.draft, headline: 'Unpublished work' } })).status, 200)
  await tick()
  const r = await call('POST', { action: 'restore', version: 1, confirm: true })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(row().draft).headline, 'Version one')
  const kept = db.sql
    .prepare("SELECT content FROM website_generations WHERE customer = ? AND json_extract(content, '$.reason') = 'before_version_restore'")
    .all(ID)
    .map((x) => JSON.parse(x.content).draft.headline)
  assert.deepEqual(kept, ['Unpublished work'])
  assert.ok(r.json.checkpoints.some((c) => c.reason === 'before_version_restore'), 'listed in the editor history')
})

test('invented numbers: whole numbers only, never digit substrings of a phone or ZIP', () => {
  assert.equal(reexported, inventedNumbers)
  const facts = JSON.stringify({ services: [{ name: 'Pool Cleaning', price: '$1,200' }, { name: 'Filter', price: '$95.00' }], phone: '(954) 555-0123', zips: ['33156'], hours: '09:00-17:00' })
  assert.deepEqual(inventedNumbers('Over 15 years keeping pools clear', facts), ['15'])
  assert.deepEqual(inventedNumbers('12 technicians on call', facts), ['12'])
  assert.deepEqual(inventedNumbers('Over 55 years', facts), ['55'])
  assert.deepEqual(inventedNumbers('Call 555-0199 today', facts), ['0199'])
  // Facts in other spellings still count.
  assert.deepEqual(inventedNumbers('Call (954) 555-0123, 954.555.0123 or +1 954 555 0123', facts), [])
  assert.deepEqual(inventedNumbers('Full cleaning $1200, filter $95, open 9 to 17:00', facts), [])
  assert.deepEqual(inventedNumbers('Serving 33156', facts), [])
  // Unchanged behaviour of the earlier check.
  assert.deepEqual(inventedNumbers('Since 1998, 4.9 stars', '{"x":"From $150"}'), ['1998', '4.9'])
  // Phone numbers of the business in E.164 form.
  assert.deepEqual(inventedNumbers('Call 954-555-0123', '{"phone":"+19545550123"}'), [])
})

test('AI designer text: a number only found inside a ZIP or phone is removed', () => {
  const factsText = JSON.stringify({ phone: '(954) 555-0123', zips: ['33156'], services: [{ name: 'Pool Cleaning', price: '$120' }] })
  const out = (heading) => JSON.stringify(validateSpec({ version: 2, pages: [{ slug: '', title: 'Home', sections: [{ type: 'text', heading, body: 'x' }] }] }, { factsText }).spec)
  assert.ok(!out('Over 15 years').includes('Over 15 years'))
  assert.ok(out('Weekly cleaning from $120').includes('Weekly cleaning from $120'))
})

test('a page open during a deploy reloads once when a part of the app is gone, never in a loop', () => {
  const store = new Map()
  const s = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(shouldReload(1_000_000, s), true)
  assert.equal(shouldReload(1_010_000, s), false, 'still failing right after the reload: show the error')
  assert.equal(shouldReload(1_040_001, s), true, 'a later deploy can reload again')
  assert.equal(shouldReload(1, { getItem: () => { throw new Error('blocked') } }), false)
})

test('business details: a page holding older details gets 409 and nothing is replaced; current page and older releases save', async () => {
  const loaded = (await call('GET', null, profileApi)).json.profile // tab A
  const edit = { phone: '(843) 555-0100', industry: 'Pool service', description: '', cities: 'Charleston', services: [{ name: 'Weekly Pool Care', price: '$180' }] }
  // Tab B (current) adds a service.
  const b = await call('POST', { ...edit, base: loaded }, profileApi)
  assert.equal(b.status, 200)
  // Tab A still has the old details (no services) and saves: refused, B's service kept.
  const a = await call('POST', { ...edit, services: [], description: 'From the older tab', base: loaded }, profileApi)
  assert.equal(a.status, 409)
  assert.equal(a.json.error, 'conflict')
  assert.deepEqual((await call('GET', null, profileApi)).json.profile.services, [{ name: 'Weekly Pool Care', price: '$180' }])
  // Saving again from what B now shows works; a page without `base` (older release, onboarding) still saves.
  assert.equal((await call('POST', { ...edit, description: 'Next', base: b.json.profile }, profileApi)).status, 200)
  assert.equal((await call('POST', { ...edit, description: 'No base' }, profileApi)).status, 200)
})

test('policies: stale page → 409, nothing replaced; fresh and base-less saves work', async () => {
  const loaded = (await call('GET', null, policiesApi)).json.policies
  assert.equal((await call('POST', { beforeVisit: 'Unlock the gate.', cancellation: '', base: loaded }, policiesApi)).status, 200)
  const stale = await call('POST', { beforeVisit: '', cancellation: 'Old tab text', base: loaded }, policiesApi)
  assert.equal(stale.status, 409)
  assert.equal(stale.json.current.beforeVisit, 'Unlock the gate.')
  assert.equal((await call('GET', null, policiesApi)).json.policies.beforeVisit, 'Unlock the gate.')
  assert.equal((await call('POST', { beforeVisit: 'Unlock the gate.', cancellation: 'Call us', base: stale.json.current }, policiesApi)).status, 200)
  assert.equal((await call('POST', { beforeVisit: 'x', cancellation: '' }, policiesApi)).status, 200)
})

test('booking hours: stale page → 409 with the current hours, nothing replaced; fresh and base-less saves work', async () => {
  const loaded = { workdays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', slotMinutes: 60 }
  const b = await call('POST', { ...loaded, dayEnd: '18:00', base: loaded }, hoursApi)
  assert.equal(b.status, 200)
  assert.deepEqual(b.json.hours, { ...loaded, dayEnd: '18:00' })
  const a = await call('POST', { ...loaded, workdays: [1, 2], base: loaded }, hoursApi)
  assert.equal(a.status, 409)
  assert.equal(a.json.current.dayEnd, '18:00')
  const row = db.sql.prepare('SELECT workdays, day_end FROM customers WHERE id = ?').get(ID)
  assert.deepEqual({ ...row }, { workdays: '1,2,3,4,5', day_end: '18:00' })
  assert.equal((await call('POST', { ...loaded, dayEnd: '18:00', workdays: [1, 2], base: b.json.hours }, hoursApi)).status, 200)
  assert.equal((await call('POST', { ...loaded }, hoursApi)).status, 200, 'older page without base')
})
