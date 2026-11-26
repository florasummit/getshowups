// One service catalog for websites (finding WEB-14): a website service linked to Settings → Services shows the catalog's
// name, price and description at request time (all three renderers), a service hidden there is not shown, an unlinked
// one renders from its own copy exactly as before; editing a service in the website editor writes the catalog through
// the same validation as Settings → Services. Real routes on the SQLite-backed fake D1; nothing leaves the process.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { renderSite } from '../server/site-render.js'
import { validateContent } from '../server/website.js'
import { starterSite } from '../server/site-starter.js'
import { presetDesigns } from '../server/site-design.js'
import { addToCatalog, catalogEdits, catalogLinks, editorServices, parseCatalog, withCatalog } from '../server/website-catalog.js'
import { bookingServices, readServices } from '../server/services.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as preview from '../functions/api/dashboard/website/preview.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 864e5
const valid = (body) => {
  const [errors, c] = validateContent(body)
  assert.deepEqual(errors, [])
  return c
}
const BASE = { template: 'clean', color: 'ocean', headline: 'Pool care in Charleston', intro: 'Pool care you can book online.', about: '', area: 'Charleston', highlights: [], logo: null, hero: null, photos: [] }
const svcs = (...l) => l.map(([name, price, description = '']) => ({ name, price, description }))
const legacy = (services) => valid({ ...BASE, services })
const v2 = (services) => {
  const c = legacy(services)
  return valid({ ...c, site: starterSite(c, { name: 'Harbor Pools', industry: 'Pool service', phone: '8435550100', visit: true, chat: false }, { now: 1_700_000_000_000 }).site })
}
const BIZ = { id: 'harbor', name: 'Harbor Pools', appointmentMode: 'at_customer', phone: '(843) 555-0100', cities: ['Charleston'] }
const OPTS = { canonical: 'https://getshowups.com/p/harbor', bookUrl: 'https://getshowups.com/book/harbor', year: 2026, pageBase: '/p/harbor' }
const catalog = (...l) => readServices(l.map(([name, price, extra = {}]) => ({ name, price, ...extra })))

test('linked by name (content saved before links): every renderer shows the catalog price; unlinked ones keep their copy', () => {
  const services = svcs(['Weekly pool care', '$280+'], ['One-time cleaning', '$150+'])
  const cat = catalog(['weekly  POOL care', '$295'], ['Green pool cleanup', '$350'])
  for (const content of [legacy(services), { ...legacy(services), design: presetDesigns('pool')[0] }, v2(services)]) {
    const before = renderSite(BIZ, content, OPTS)
    const after = renderSite({ ...BIZ, catalog: cat }, content, OPTS)
    assert.match(before, /\$280\+/)
    assert.doesNotMatch(after, /\$280\+/, 'the website shows the Settings price')
    assert.match(after, /\$295/)
    assert.match(after, /\$150\+/, 'a service the catalog does not have renders from the website copy')
    assert.doesNotMatch(after, /Green pool cleanup/, 'the website decides which services it lists')
  }
})

test('a catalog equal to the website copy (or none at all) renders byte-identical HTML', () => {
  const services = svcs(['Weekly pool care', '$280+', 'Every week.'], ['One-time cleaning', ''])
  for (const content of [legacy(services), { ...legacy(services), design: presetDesigns('pool')[0] }, v2(services)]) {
    const golden = renderSite(BIZ, content, OPTS)
    assert.equal(renderSite({ ...BIZ, catalog: catalog(['Weekly pool care', '$280+', { description: 'Every week.' }], ['One-time cleaning', '']) }, content, OPTS), golden)
    // A catalog made in setup has no descriptions: the website's own description stays.
    assert.equal(renderSite({ ...BIZ, catalog: catalog(['Weekly pool care', '$280+'], ['One-time cleaning', '']) }, content, OPTS), golden)
    assert.equal(renderSite({ ...BIZ, catalog: [] }, content, OPTS), golden)
    assert.equal(renderSite({ ...BIZ, catalog: null }, content, OPTS), golden)
  }
})

test('linked by catalogId: a rename in Settings → Services follows; description from the catalog when it has one', () => {
  const cat = catalog(['Weekly service', '$310', { id: 'sv_weekly01', description: 'Chemicals included.' }])
  const content = legacy([{ name: 'Weekly pool care', price: '$280+', description: 'Old words.', catalogId: 'sv_weekly01' }])
  assert.equal(content.services[0].catalogId, 'sv_weekly01', 'the link is stored with the website service')
  const html = renderSite({ ...BIZ, catalog: cat }, content, OPTS)
  assert.match(html, /Weekly service/)
  assert.match(html, /\$310/)
  assert.match(html, /Chemicals included\./)
  assert.doesNotMatch(html, /Weekly pool care|Old words/)
  // A stale link (the service was deleted in Settings) renders from the copy, as before.
  assert.equal(renderSite({ ...BIZ, catalog: catalog(['Other', '$1']) }, content, OPTS), renderSite(BIZ, content, OPTS))
})

test('hidden in Settings → Services: not shown on the website (single page and multi-page); a section left empty is not shown', () => {
  const services = svcs(['Weekly pool care', '$280+'], ['One-time cleaning', '$150+'])
  const cat = catalog(['Weekly pool care', '$280+', { hidden: true }], ['One-time cleaning', '$150+'])
  for (const content of [legacy(services), { ...legacy(services), design: presetDesigns('pool')[0] }, v2(services)]) {
    const html = renderSite({ ...BIZ, catalog: cat }, content, OPTS)
    assert.doesNotMatch(html, /Weekly pool care/)
    assert.match(html, /One-time cleaning/)
  }
  const all = catalog(['Weekly pool care', '$280+', { hidden: true }], ['One-time cleaning', '$150+', { hidden: true }])
  const shown = withCatalog(v2(services), all)
  const sections = shown.site.pages.flatMap((p) => p.sections).filter((s) => s.type === 'services')
  assert.ok(sections.length && sections.every((s) => s.hidden === true && s.items.length === 0))
  // The editor's live preview of unsaved typing: values as typed, the hidden flag still applies.
  const typed = withCatalog(legacy(svcs(['Weekly pool care', '$999'], ['One-time cleaning', '$150+'])), catalog(['Weekly pool care', '$280+'], ['One-time cleaning', '$150+', { hidden: true }]), { values: false })
  assert.deepEqual(typed.services.map((s) => s.price), ['$999'])
})

test('name links are unambiguous only: two catalog services (or two website services) with one name → the copy', () => {
  assert.deepEqual(catalogLinks(svcs(['Cleaning', '$1']), catalog(['Cleaning', '$2'], ['cleaning', '$3'])), [null])
  assert.deepEqual(catalogLinks(svcs(['Cleaning', '$1'], ['Cleaning', '$4']), catalog(['Cleaning', '$2'])), [null, null])
  const one = catalog(['Cleaning', '$2'])
  assert.equal(catalogLinks(svcs(['  CLEANING ', '$1']), one)[0].id, one[0].id)
})

test('catalogEdits: what the owner changed goes to the catalog; a value the editor merely still shows is never written back', () => {
  const cat = catalog(['Weekly pool care', '$295'], ['Green pool cleanup', '$350'])
  const stored = svcs(['Weekly pool care', '$280+'])
  // Unchanged since the last save ($280+ is stale; Settings says $295): nothing is written.
  assert.equal(catalogEdits(svcs(['Weekly pool care', '$280+']), stored, cat).catalog, null)
  // The owner typed a new price: the catalog gets it, validated, with ids kept and the link stored.
  const r = catalogEdits(svcs(['Weekly pool care', '$300']), stored, cat)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.catalog.map((s) => [s.id, s.name, s.price]), [[cat[0].id, 'Weekly pool care', '$300'], [cat[1].id, 'Green pool cleanup', '$350']])
  assert.equal(r.services[0].catalogId, cat[0].id)
  // A rename by website id (multi-page site) keeps the catalog service.
  const ren = catalogEdits([{ id: 'va', name: 'Weekly care', price: '$295', description: '', catalogId: cat[0].id }], [{ id: 'va', name: 'Weekly pool care', price: '$295', description: '', catalogId: cat[0].id }], cat, { designed: true })
  assert.equal(ren.catalog[0].name, 'Weekly care')
  assert.equal(ren.catalog[0].id, cat[0].id)
  // A website-only service edited stays website-only; a claim is refused like Settings → Services refuses it.
  assert.equal(catalogEdits(svcs(['Pool opening', '$90']), svcs(['Pool opening', '$80']), cat).catalog, null)
  assert.deepEqual(catalogEdits(svcs(['Weekly pool care', '#1 rated']), stored, cat).errors.length > 0, true)
})

test('addToCatalog: a new service is visible and bookable; the same name is that service; the catalog limit holds', () => {
  const cat = catalog(['Weekly pool care', '$295'])
  const [e1, s1, next] = addToCatalog(cat, { name: 'Pool opening', price: '$120' })
  assert.equal(e1, null)
  assert.equal(next.length, 2)
  assert.deepEqual(bookingServices(next, 60).map((s) => [s.name, s.price, s.flow]), [['Weekly pool care', '$295', 'book'], ['Pool opening', '$120', 'book']])
  assert.match(s1.id, /^sv_/)
  const [e2, same, none] = addToCatalog(next, { name: 'pool OPENING' })
  assert.deepEqual([e2, same.id, none], [null, s1.id, null])
  const full = catalog(...Array.from({ length: 16 }, (_, i) => [`S${i}`, '']))
  assert.equal(addToCatalog(full, { name: 'One more' })[0], 'services_full')
  assert.equal(addToCatalog(cat, { name: '' })[0], 'services')
})

test('editorServices: linked services show the catalog with their id; stale links are dropped; hidden ids listed', () => {
  const cat = catalog(['Weekly pool care', '$295', { hidden: true }])
  const { content, hidden } = editorServices(legacy([...svcs(['Weekly pool care', '$280+']), { name: 'Gone', price: '', description: '', catalogId: 'sv_deleted1' }]), cat)
  assert.deepEqual(content.services.map((s) => [s.name, s.price, s.catalogId]), [['Weekly pool care', '$295', cat[0].id], ['Gone', '', undefined]])
  assert.deepEqual(hidden, [cat[0].id])
  assert.equal(parseCatalog('not json'), null)
  assert.equal(parseCatalog(null), null)
})

// ---------- routes ----------
let env, db, kv
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
function seed(id, services) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, 'Clear Pools', 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0100', 'Pool service', '', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify(services), now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(id) {
  const email = `owner@${id}.example`
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, path = '/x' } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', Cookie: cookie }
  if (method === 'POST') h.Origin = ORIGIN
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}${path}`, { method, headers: h, body: body && JSON.stringify(body) }), env, waitUntil: () => {} })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}
const catalogOf = (id) => JSON.parse(db.sql.prepare('SELECT services FROM business_profiles WHERE customer = ?').get(id).services)

beforeEach(() => {
  db = d1()
  kv = new Map()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }
  seed('pools', [{ name: 'Weekly pool care', price: '$180+' }, { name: 'Pool opening', price: '$90' }])
})

test('Studio: a price edited in the website editor is saved to Settings → Services (booking page), the preview agrees, removing only leaves the website', async () => {
  const c = await cookieFor('pools')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'starter' } })).status, 200)
  let s = (await call(website, 'GET', { cookie: c })).json
  const draft = s.website.draft
  assert.ok(draft.site, 'a multi-page website')
  assert.ok(draft.services.every((v) => /^sv_/.test(v.catalogId)), 'every service is linked to the catalog in the editor')
  // The owner types a new price for the first service.
  const edited = structuredClone(draft)
  edited.services[0].price = '$195+'
  let r = await call(website, 'POST', { cookie: c, body: { action: 'save', content: edited, baseUpdatedAt: s.website.updatedAt } })
  assert.equal(r.status, 200)
  assert.equal(catalogOf('pools')[0].price, '$195+', 'Settings → Services has the new price')
  assert.deepEqual(bookingServices(catalogOf('pools'), 60).map((x) => x.price), ['$195+', '$90'], 'the booking page offers it at once')
  // Settings changes the price afterwards: the editor and the preview show Settings' price, and an unrelated save
  // does not write the website's older value back.
  const cat = catalogOf('pools')
  cat[0].price = '$210+'
  db.sql.prepare('UPDATE business_profiles SET services = ? WHERE customer = ?').run(JSON.stringify(cat), 'pools')
  s = (await call(website, 'GET', { cookie: c })).json
  assert.equal(s.website.draft.services[0].price, '$210+')
  const pv = await call(preview, 'GET', { cookie: c, path: '/api/dashboard/website/preview' })
  assert.match(pv.text, /\$210\+/)
  assert.doesNotMatch(pv.text, /\$195\+/)
  const stale = structuredClone(r.json.website.draft) // a tab still showing $195+
  stale.headline = 'Pool care in Charleston, every week'
  r = await call(website, 'POST', { cookie: c, body: { action: 'save', content: stale, baseUpdatedAt: s.website.updatedAt } })
  assert.equal(r.status, 200)
  assert.equal(catalogOf('pools')[0].price, '$210+', 'a value the editor merely still showed is not written back')
  // Removing a service from the website keeps it in the catalog (booking page unchanged).
  const fewer = structuredClone(r.json.website.draft)
  fewer.services.splice(1, 1)
  r = await call(website, 'POST', { cookie: c, body: { action: 'save', content: fewer, baseUpdatedAt: r.json.website.updatedAt } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.website.draft.services.map((v) => v.name), ['Weekly pool care'])
  assert.deepEqual(catalogOf('pools').map((v) => v.name), ['Weekly pool care', 'Pool opening'])
  // A claim typed as a price is refused (same rule as Settings → Services) and nothing is stored.
  const claim = structuredClone(r.json.website.draft)
  claim.services[0].price = '#1 rated'
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: claim, baseUpdatedAt: r.json.website.updatedAt } })).status, 400)
  assert.equal(catalogOf('pools')[0].price, '$210+')
})

test('Studio "Add a service" adds it to Settings → Services (bookable); a same-origin write; same name = no duplicate', async () => {
  const c = await cookieFor('pools')
  const r = await call(website, 'POST', { cookie: c, body: { action: 'addService', service: { name: 'Green pool cleanup', price: '$350' } } })
  assert.equal(r.status, 200)
  assert.equal(r.json.added, true)
  assert.match(r.json.service.id, /^sv_/)
  assert.deepEqual(bookingServices(catalogOf('pools'), 60).map((x) => x.name), ['Weekly pool care', 'Pool opening', 'Green pool cleanup'])
  const again = await call(website, 'POST', { cookie: c, body: { action: 'addService', service: { name: 'green pool cleanup' } } })
  assert.deepEqual([again.status, again.json.added, again.json.service.id], [200, false, r.json.service.id])
  assert.equal(catalogOf('pools').length, 3)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'addService', service: { name: 'Best in town', price: 'Guaranteed lowest price' } } })).status, 400)
  // Cross-site requests are refused before anything is read.
  const res = await website.onRequestPost({ request: new Request(`${ORIGIN}/x`, { method: 'POST', headers: { Cookie: c, Origin: 'https://evil.example', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ action: 'addService', service: { name: 'X' } }) }), env, waitUntil: () => {} })
  assert.equal(res.status, 403)
  assert.equal(catalogOf('pools').length, 3)
})
