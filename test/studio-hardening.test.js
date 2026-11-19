// Website Studio hardening (2026-11-19): where a photo is used (draft, live, saved versions, History, logos,
// content.design images), delete / hide / show with isolation, replace-everywhere-in-the-draft, and the opt-in phone
// copies for the older design renderer (stored content without the opt-in renders byte-identical).
// node:sqlite D1, Map KV. No network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { photoUsage, readAsset, usedBy, listAssets } from '../server/assets.js'
import { validateContent } from '../server/website.js'
import { renderSite } from '../server/site-render.js'
import { specImages } from '../server/site-spec.js'
import { ERASED_TABLES } from '../server/deletion.js'
import { draftPlaces, replacePhoto, usageText } from '../src/dashboard/photo-refs.js'
import * as assetsRoute from '../functions/api/dashboard/website/assets.js'
import * as siteAssetRoute from '../functions/site-assets/[id].js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
let env, db, kv

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.includes(f)) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  return { sql, prepare: (q) => stmt(q) }
}
function seed(id, owner) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, origin = ORIGIN, url = `${ORIGIN}/x`, params } = {}) {
  const h = {}
  if (cookie) h.Cookie = cookie
  if (body) h['Content-Type'] = 'application/json'
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(url, { method, headers: h, body: body && JSON.stringify(body) }), env, params })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}
const photo = (customer, id) => db.sql.prepare("INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?, ?, 'image/jpeg', x'ffd8ffe000104a464946', 10, 1)").run(id, customer)
const DESIGN = { name: 'Pro', palette: 'navy', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'about', 'gallery'], heroImage: 'stock:tools-flat', aboutImage: 'stock:tools-blue' }
const content = (extra = {}) => ({ template: 'clean', color: 'ocean', headline: 'Heating and cooling', intro: 'Book online.', about: 'Local team.', services: [{ name: 'AC repair', price: '', description: '' }], area: 'Charleston', highlights: [], logo: null, hero: null, photos: [], seoTitle: '', seoDescription: '', ...extra })
const setDraft = (customer, c, live = null) =>
  db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, ?, ?, 1) ON CONFLICT (customer) DO UPDATE SET draft = excluded.draft, live_version = excluded.live_version').run(customer, JSON.stringify(c), live, live ? 1 : null)
const addVersion = (customer, version, c) => db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, ?, ?, 1)').run(customer, version, JSON.stringify(c))
const ids = (...d) => d.map((x) => String(x).repeat(32))

beforeEach(() => {
  db = d1()
  kv = new Map()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
})

test('usage: draft, live, saved versions, History and logos are told apart; content.design photos count (they used to be missed)', async () => {
  const [inDraft, inLive, inOldVersion, inDesign, oldLogo, inCheckpoint, copy, unused] = ids(1, 2, 3, 4, 5, 6, 7, 8)
  for (const id of [inDraft, inLive, inOldVersion, inDesign, oldLogo, inCheckpoint, copy, unused]) photo('pools', id)
  addVersion('pools', 1, content({ hero: inOldVersion, logo: oldLogo }))
  addVersion('pools', 2, content({ hero: inLive, design: { ...DESIGN, aboutImage: `asset:${inDesign}` } }))
  setDraft('pools', content({ hero: inDraft, variants: { [inDraft]: copy } }), 2)
  db.sql.prepare("INSERT INTO website_generations (id, customer, content, source, created_at) VALUES ('g1', 'pools', ?, 'template', 1)").run(JSON.stringify({ kind: 'checkpoint', draft: content({ hero: inCheckpoint }) }))
  const u = await photoUsage(db, 'pools')
  assert.deepEqual(u.get(inDraft), { draft: true, live: false, versions: 0, history: false, logo: false })
  assert.deepEqual(u.get(copy), { draft: true, live: false, versions: 0, history: false, logo: false }, 'a phone copy counts where its photo does')
  assert.deepEqual(u.get(inLive), { draft: false, live: true, versions: 1, history: false, logo: false })
  assert.deepEqual(u.get(inDesign), { draft: false, live: true, versions: 1, history: false, logo: false }, 'content.design aboutImage')
  assert.deepEqual(u.get(inOldVersion), { draft: false, live: false, versions: 1, history: false, logo: false })
  assert.equal(u.get(oldLogo).logo, true)
  assert.equal(u.get(inCheckpoint).history, true)
  assert.equal(u.has(unused), false)
  assert.ok(usedBy({ design: { ...DESIGN, heroImage: `asset:${inDesign}` } }).has(inDesign))

  // Route: own photos only, with usage; another business sees only its own (none here).
  const c = await cookieFor('owner@pools.example')
  const s = await cookieFor('owner@salon.example')
  const mine = (await call(assetsRoute, 'GET', { cookie: c, url: `${ORIGIN}/api/dashboard/website/assets?usage=1` })).json.assets
  assert.equal(mine.length, 8)
  assert.deepEqual(mine.find((a) => a.id === inDesign).usage.live, true)
  assert.equal(mine.find((a) => a.id === unused).usage, null)
  assert.deepEqual((await call(assetsRoute, 'GET', { cookie: s, url: `${ORIGIN}/api/dashboard/website/assets?usage=1` })).json.assets, [])
  assert.equal((await call(assetsRoute, 'GET', { url: `${ORIGIN}/api/dashboard/website/assets?usage=1` })).status, 401)
})

test('public serving: a photo the live content.design shows (not in hero/photos) is served; it used to 404 on the live site', async () => {
  const [p] = ids('a')
  photo('pools', p)
  addVersion('pools', 1, content({ design: { ...DESIGN, heroImage: `asset:${p}` } }))
  setDraft('pools', content(), 1)
  assert.equal((await readAsset(db, p))?.published, true)
  const res = await siteAssetRoute.onRequestGet({ request: new Request(`${ORIGIN}/site-assets/${p}`), env, params: { id: p } })
  assert.equal(res.status, 200)
})

test('delete: refused while anything recoverable uses it (with where); its phone copy goes with it; other businesses and cross-site requests refused', async () => {
  const c = await cookieFor('owner@pools.example')
  const s = await cookieFor('owner@salon.example')
  const [design, spare, spareCopy, keptCopy] = ids('b', 'c', 'd', 'e')
  for (const id of [design, spare, spareCopy, keptCopy]) photo('pools', id)
  addVersion('pools', 1, content({ design: { ...DESIGN, heroImage: `asset:${design}` }, photos: [keptCopy] }))
  setDraft('pools', content({ variants: { [spare]: spareCopy } }), 1)
  const del = (cookie, id, origin) => call(assetsRoute, 'POST', { cookie, body: { action: 'delete', id }, origin })
  const refused = await del(c, design)
  assert.deepEqual([refused.status, refused.json.error, refused.json.usage.live], [409, 'in_use', true])
  assert.equal((await del(s, spare)).status, 404, 'another business’s photo')
  assert.equal((await del(c, spare, 'https://evil.example')).status, 403, 'same-origin only')
  assert.equal((await del(c, 'not-an-id')).status, 400)
  const ok = await del(c, spare)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json.removed.sort(), [spare, spareCopy].sort(), 'the unused phone copy is removed with its photo')
  const left = db.sql.prepare("SELECT id FROM website_assets WHERE customer = 'pools'").all().map((r) => r.id)
  assert.deepEqual(left.sort(), [design, keptCopy].sort())
})

test('hide: only for photos history alone uses; hidden photos leave the list and pickers but are kept and still served; show again; isolation', async () => {
  const c = await cookieFor('owner@pools.example')
  const s = await cookieFor('owner@salon.example')
  const [old, inDraft, live] = ids('f', 1, 2)
  for (const id of [old, inDraft, live]) photo('pools', id)
  addVersion('pools', 1, content({ hero: old }))
  addVersion('pools', 2, content({ hero: live }))
  setDraft('pools', content({ hero: inDraft }), 2)
  const act = (cookie, action, id) => call(assetsRoute, 'POST', { cookie, body: { action, id } })
  assert.deepEqual([(await act(c, 'hide', inDraft)).status, (await act(c, 'hide', inDraft)).json.error], [409, 'in_draft'])
  assert.deepEqual([(await act(c, 'hide', live)).status, (await act(c, 'hide', live)).json.error], [409, 'live'])
  assert.equal((await act(s, 'hide', old)).status, 404)
  assert.equal((await act(c, 'hide', old)).status, 200)
  assert.equal((await act(c, 'hide', old)).status, 200, 'hiding twice is harmless')
  assert.equal((await listAssets(db, 'pools')).some((a) => a.id === old), false, 'left out of the photo list and pickers')
  assert.equal((await call(assetsRoute, 'GET', { cookie: c })).json.assets.some((a) => a.id === old), false)
  const withHidden = (await call(assetsRoute, 'GET', { cookie: c, url: `${ORIGIN}/api/dashboard/website/assets?usage=1` })).json.assets
  assert.equal(withHidden.find((a) => a.id === old).hidden, true)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM website_assets WHERE id = ?').get(old).n, 1, 'bytes kept')
  assert.equal((await readAsset(db, old, 'pools'))?.asset?.id, old, 'still served to the owner (restoring a version shows it)')
  // Delete is still refused (a saved version shows it); cleanup keeps it.
  assert.equal((await act(c, 'delete', old)).status, 409)
  assert.equal((await act(s, 'show', old)).status, 404)
  assert.equal((await act(c, 'show', old)).status, 200)
  assert.equal((await listAssets(db, 'pools')).some((a) => a.id === old), true)
  assert.equal((await act(c, 'nonsense', old)).status, 400)
})

test('hide before migration 0030 is applied: not_available, and listing/deleting work as before', async () => {
  db = d1({ skip: ['0030_website_asset_hidden.sql'] })
  env.ONBOARDING_DB = db
  seed('pools', 'owner@pools.example')
  const c = await cookieFor('owner@pools.example')
  const [a, b] = ids(3, 4)
  photo('pools', a)
  photo('pools', b)
  addVersion('pools', 1, content({ hero: a }))
  setDraft('pools', content(), null)
  assert.deepEqual([(await call(assetsRoute, 'POST', { cookie: c, body: { action: 'hide', id: a } })).json.error], ['not_available'])
  assert.equal((await call(assetsRoute, 'GET', { cookie: c })).json.assets.length, 2)
  assert.equal((await call(assetsRoute, 'POST', { cookie: c, body: { action: 'delete', id: b } })).status, 200)
})

test('account deletion erases hidden-photo rows', () => {
  assert.ok(ERASED_TABLES.includes('website_asset_hidden'))
})

// ---- Replace everywhere in the draft (browser helper; the server validates the save as usual) ----
const SITE = (a, b) => ({
  pages: [
    { slug: '', navLabel: 'Home', sections: [
      { type: 'hero', id: 'top', image: `asset:${a}` },
      { type: 'gallery', id: 'work', images: [`asset:${a}`, `asset:${b}`] },
      { type: 'composition', id: 'c1', blocks: [{ kind: 'media', image: `asset:${a}` }, { kind: 'heading', text: 'Hi' }] },
      { type: 'cta', id: 'book', hidden: true, backgroundImage: `asset:${a}` },
    ] },
    { slug: 'about', navLabel: 'About', sections: [{ type: 'imageText', id: 'story', image: `asset:${b}` }, { type: 'features', id: 'f', items: [{ image: `asset:${a}` }] }] },
  ],
})

test('replace: every draft slot of the photo changes (sections, gallery without duplicates, opening blocks, older-format hero/photos/design); nothing else does', () => {
  const [a, b, c] = ids(5, 6, 7)
  const draft = content({ hero: a, photos: [a, b], logo: a, design: { ...DESIGN, heroImage: `asset:${a}` }, site: SITE(a, b) })
  const places = draftPlaces(draft, a).map((p) => p.label)
  assert.deepEqual(places, ['Home · Hero', 'Home · Gallery', 'Home · Hero', 'Home · Booking (hidden)', 'About · Benefits', 'Main photo', 'Photo gallery', 'Design photo'])
  const { content: out, count } = replacePhoto(draft, a, b)
  assert.equal(count, 8)
  assert.equal(JSON.stringify(out).includes(`asset:${a}`), false)
  assert.deepEqual(out.site.pages[0].sections[1].images, [`asset:${b}`], 'no duplicate in a gallery that already had the new photo')
  assert.deepEqual(out.photos, [b])
  assert.equal(out.hero, b)
  assert.equal(out.logo, a, 'the logo is never swapped for a photo')
  assert.equal(draft.hero, a, 'the input is not changed (undo keeps it)')
  assert.equal(replacePhoto(draft, c, b).count, 0)
  // The browser walk covers exactly the slots the server's spec walk covers.
  const fromServer = specImages(SITE(a, b))
  const browserIds = new Set([a, b].filter((id) => draftPlaces({ site: SITE(a, b) }, id).length))
  assert.deepEqual([...fromServer].sort(), [...browserIds].sort())
  assert.deepEqual(usageText([{ label: 'Home · Hero' }], { live: true, versions: 2, history: true }), ['Home · Hero', 'your live website', '2 saved versions', 'earlier drafts (History / undo)'])
})

// ---- Phone copies for the older design renderer: opt-in only ----
const BIZ = { id: 'golden-designed-hvac', name: 'Lowcountry Air', appointmentMode: 'at_customer', phone: '(843) 555-0100', cities: ['Charleston'] }
const OPTS = { canonical: 'https://getshowups.com/p/x', bookUrl: '/book/x', year: 2026 }

test('design renderer: stored content without responsiveImages renders byte-identical even with phone copies on record; with the opt-in, owner photos get srcset', () => {
  const [hero, small, g1, g1s] = ids(8, 9, 'a', 'b')
  const base = content({ hero, photos: [g1], design: DESIGN })
  const before = renderSite(BIZ, base, OPTS)
  assert.equal(renderSite(BIZ, { ...base, variants: { [hero]: small, [g1]: g1s } }, OPTS), before, 'copies alone change nothing')
  assert.equal(renderSite(BIZ, { ...base, responsiveImages: false, variants: { [hero]: small } }, OPTS), before)
  const after = renderSite(BIZ, { ...base, responsiveImages: true, variants: { [hero]: small, [g1]: g1s } }, OPTS)
  assert.match(after, new RegExp(`src="/site-assets/${hero}" srcset="/site-assets/${small} 800w, /site-assets/${hero} 1600w" sizes="\\(max-width:900px\\) 100vw, 45vw"`))
  assert.match(after, new RegExp(`src="/site-assets/${g1}" srcset="/site-assets/${g1s} 800w, /site-assets/${g1} 1600w"`))
  // A photo without a copy keeps its plain tag under the opt-in too.
  assert.match(renderSite(BIZ, { ...base, responsiveImages: true, variants: {} }, OPTS), new RegExp(`src="/site-assets/${hero}" alt=""`))
  // Stored fixtures and their exact HTML are checked by test/render-golden.test.js (unchanged by this work).
})

test('validation: responsiveImages is stored only when exactly true', () => {
  const v = (x) => validateContent(content(x))[1]
  assert.equal(v({ responsiveImages: true }).responsiveImages, true)
  for (const x of [false, 'true', 1, null]) assert.equal('responsiveImages' in v({ responsiveImages: x }), false)
  assert.equal('responsiveImages' in v({}), false, 'older content stays comparable (no new field)')
})

test('browser resize: EXIF orientation applied while decoding, and the limit message has no stale number', () => {
  const src = readFileSync(new URL('../src/lib/images.js', import.meta.url), 'utf8')
  assert.match(src, /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/)
  assert.doesNotMatch(src, /photo limit \(\d+\)/)
})
