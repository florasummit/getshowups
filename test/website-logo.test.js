// Website logo state and uploaded-file lifecycle (2026-11-21): content.logo === null means "no logo, on purpose" and the
// current website is authoritative. Remove / replace change only the pointer (the file stays in the media library,
// marked Logo); nothing automatic (generation, revision, apply, import, checkpoint restore) brings a logo back; a version
// restore brings its logo back only while the file exists; permanent deletion is refused while the live website or the
// draft shows the file, otherwise every stored reference is invalidated first. node:sqlite D1, Map KV. No network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { contentAssetIds, logoAssetIdsFor, restore, validateContent, withoutAsset, withoutMissingAssets } from '../server/website.js'
import { listAssets, photoUsage, PUBLIC_MAX_AGE } from '../server/assets.js'
import { restoreCheckpoint, saveCheckpoint } from '../server/website-history.js'
import { generateWebsite, reviseWebsite } from '../server/website-ai.js'
import { renderSite } from '../server/site-render.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as assets from '../functions/api/dashboard/website/assets.js'
import * as publicSite from '../functions/p/[customer].js'
import * as siteAsset from '../functions/site-assets/[id].js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
let env, db, kv

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  const batch = async (list) => {
    sql.exec('BEGIN')
    try {
      for (const s of list) sql.prepare(s.q).run(...s.args)
      sql.exec('COMMIT')
    } catch (e) {
      sql.exec('ROLLBACK')
      throw e
    }
  }
  return { sql, prepare: (q) => stmt(q), batch }
}
function seed(id, owner) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, raw, params, origin = ORIGIN, url = `${ORIGIN}/x` } = {}) {
  const h = {}
  if (cookie) h.Cookie = cookie
  if (body) h['Content-Type'] = 'application/json'
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(url, { method, headers: h, body: raw ?? (body && JSON.stringify(body)) }), env, params })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const SITE = { pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'hero', id: 'top', layout: 'minimal', heading: 'Pools, handled.' }] }] }
const content = (extra = {}) => ({ template: 'clean', color: 'ocean', headline: 'Pool cleaning in Charleston', intro: 'Pick a time online.', about: '', services: [{ name: 'Weekly cleaning', price: 'From $150', description: '' }], area: 'Charleston', highlights: [], logo: null, hero: null, photos: [], seoTitle: '', seoDescription: '', ...extra })
const ids = (...d) => d.map((x) => String(x).repeat(32))
const photo = (customer, id) => db.sql.prepare("INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?, ?, 'image/png', x'89504e470d0a1a0a', 8, 1)").run(id, customer)
const draftOf = (customer) => JSON.parse(db.sql.prepare('SELECT draft FROM websites WHERE customer = ?').get(customer).draft)
const versionOf = (customer, v) => JSON.parse(db.sql.prepare('SELECT content FROM website_versions WHERE customer = ? AND version = ?').get(customer, v).content)
const icon = (html) => html.match(/<link rel="icon" href="([^"]+)"/)?.[1] || null

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
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
})

test('logo lifecycle through the routes: upload → replace → remove (explicit null) → reload → publish (no logo, letter-mark icon) → restore the old version brings it back → remove again; the files stay in the library marked Logo', async () => {
  const c = await cookieFor('owner@pools.example')
  const s = await cookieFor('owner@salon.example')
  const upload = async () => (await call(assets, 'POST', { cookie: c, raw: PNG })).json.asset.id
  const save = (body) => call(website, 'POST', { cookie: c, body: { action: 'save', ...body } })
  const first = await upload()
  const second = await upload()
  // Upload, then set it as the logo (one pointer; the server checks ownership).
  const base = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal(base.draft.logo, null, 'a fresh draft has no logo')
  assert.equal((await save({ content: content({ logo: first, site: SITE }), baseUpdatedAt: base.updatedAt })).status, 200)
  assert.equal(draftOf('pools').logo, first)
  // Another business can't point its site at this file.
  assert.deepEqual((await call(website, 'POST', { cookie: s, body: { action: 'save', content: content({ logo: first }) } })).json.fields, ['images'])
  // Replace: only the pointer changes; no new rows beyond the two uploads.
  let w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal((await save({ content: { ...w.draft, logo: second }, baseUpdatedAt: w.updatedAt })).status, 200)
  assert.equal(draftOf('pools').logo, second)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_assets WHERE customer = 'pools'").get().n, 2)
  // Publish with the logo: version 1 shows it (icon = the logo).
  w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: w.draft, confirm: true, baseUpdatedAt: w.updatedAt } })).status, 200)
  assert.equal(icon((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text), `/site-assets/${second}`)
  assert.equal((await call(siteAsset, 'GET', { params: { id: second } })).headers.get('Cache-Control'), `public, max-age=${PUBLIC_MAX_AGE}`)
  // Remove from the website: explicit null, saved with the editor's stamp, still null after a reload.
  w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal((await save({ content: { ...w.draft, logo: null }, baseUpdatedAt: w.updatedAt })).status, 200)
  w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal(w.draft.logo, null)
  assert.equal(draftOf('pools').logo, null, 'stored as explicit null')
  assert.equal(w.changed, true, 'removing the logo is an unpublished change')
  // The files stay in the library, both marked Logo (they were the logo), so photo pickers and the AI never place them.
  const listed = w.published ? (await call(website, 'GET', { cookie: c })).json.assets : []
  assert.deepEqual(listed.map((a) => [a.id, a.logo === true]).sort(), [[first, true], [second, true]].sort())
  assert.deepEqual([...(await logoAssetIdsFor(db, 'pools'))].sort(), [first, second].sort())
  // Publish without the logo: the live site falls back to the letter mark; the old version still has the logo.
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: w.draft, confirm: true, baseUpdatedAt: w.updatedAt } })).status, 200)
  const live = (await call(publicSite, 'GET', { params: { customer: 'pools' } })).text
  assert.match(icon(live), /^\/site-icon\/pools\.svg\?c=/)
  assert.ok(!live.includes('/site-assets/'), 'no image of the removed logo anywhere on the live site')
  assert.equal(versionOf('pools', 1).logo, second)
  assert.equal(versionOf('pools', 2).logo, null)
  // Restoring version 1 is an owner action: its logo comes back (file still exists).
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 1, confirm: true } })).status, 200)
  assert.equal(draftOf('pools').logo, second)
  assert.equal(icon((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text), `/site-assets/${second}`)
  // Remove again and publish: version 3 without a logo; the draft stays null across reloads.
  w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: { ...w.draft, logo: null }, confirm: true, baseUpdatedAt: w.updatedAt } })).status, 200)
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.logo, null)
  assert.equal(versionOf('pools', 3).logo, null)
  // Pick the first file again later: allowed (it is still the owner's).
  w = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal((await save({ content: { ...w.draft, logo: first }, baseUpdatedAt: w.updatedAt })).status, 200)
  assert.equal(draftOf('pools').logo, first)
})

test('nothing automatic sets a logo the draft does not have: template/AI generation, revision, apply, checkpoint restore and starter keep null', async () => {
  const c = await cookieFor('owner@pools.example')
  const [old] = ids('a')
  photo('pools', old)
  // History: version 1 had the logo; the draft has explicitly none.
  db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 1, ?, 1)').run('pools', JSON.stringify(content({ logo: old })))
  db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, 1, 1, 1)').run('pools', JSON.stringify(content({ logo: null })))
  const customer = { id: 'pools', name: 'pools Co', serviceZips: ['29403'], appointmentMode: 'at_business' }
  // Generation and revision (the routes pass the draft's logo; null stays null, and the old logo is never offered).
  const g = await generateWebsite(env, customer, { logo: null, useAi: false })
  assert.equal(g.generation.content.logo, null)
  assert.ok(!JSON.stringify(g.generation.designs).includes(old))
  env.AI = { run: async () => ({ response: { headline: 'Pools Co pool care', intro: 'Pick a time.', about: 'We help.', services: [], seoTitle: 't', seoDescription: 'd', logo: old, design: { name: 'X', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services'], heroImage: `asset:${old}`, aboutImage: null } }, usage: {} }) }
  const r = await reviseWebsite(env, customer, draftOf('pools'), 'make it more modern')
  assert.ok(r.ok)
  assert.equal(r.generation.content.logo ?? null, null, 'a model answer naming the logo is ignored')
  assert.ok(!JSON.stringify(r.generation.designs).includes(old), 'the old logo is never placed as a photo')
  // Apply the generation: the draft keeps its (null) logo.
  const applied = await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: g.generation.id, option: 0 } })
  assert.equal(applied.status, 200)
  assert.equal(draftOf('pools').logo, null)
  assert.equal(applied.json.website.draft.logo, null)
  // A checkpoint taken while the logo was set restores its logo only while the file exists (owner action)...
  const cp = await saveCheckpoint(db, 'pools', content({ logo: old }), 'autosave', 5)
  const back = await call(website, 'POST', { cookie: c, body: { action: 'restoreCheckpoint', id: cp } })
  assert.equal(back.status, 200)
  assert.equal(draftOf('pools').logo, old)
  // ...and not once the file is gone: the restore succeeds without it instead of failing.
  db.sql.prepare('DELETE FROM website_assets WHERE id = ?').run(old)
  const cp2 = await saveCheckpoint(db, 'pools', content({ logo: old, hero: old }), 'autosave', 6)
  const gone = await restoreCheckpoint(db, 'pools', cp2, { assetIds: new Set(), current: content() })
  assert.equal(gone.ok, true)
  assert.deepEqual([gone.content.logo, gone.content.hero], [null, null])
  // Version restore with a missing file: the logo does not come back; the version row is cleaned.
  assert.equal(await restore(db, 'pools', 1), true)
  assert.equal(draftOf('pools').logo, null)
  assert.equal(versionOf('pools', 1).logo, null)
})

test('legacy content without a logo field validates to null and renders exactly like explicit null', () => {
  // Stored before the logo field existed: no `logo` key at all.
  const { logo: _none, ...legacy } = content({ photos: [], hero: null })
  assert.equal('logo' in legacy, false)
  const [errors, c] = validateContent(legacy)
  assert.deepEqual(errors, [])
  assert.equal(c.logo, null)
  const biz = { id: 'pools', name: 'Pools Co', phone: '', appointmentMode: 'at_business' }
  const opts = { canonical: 'https://getshowups.com/p/pools', bookUrl: '/book/pools', year: 2026 }
  assert.equal(renderSite(biz, legacy, opts), renderSite(biz, { ...legacy, logo: null }, opts))
  assert.match(renderSite(biz, legacy, opts), /<a class="brand"[^>]*>Pools Co<\/a>/)
})

test('validateContent photoIds: the logo is checked against owned files while AI-designed pages may place only photos (never the logo)', () => {
  const [logo, pic] = ids('b', 'c')
  const spec = { pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'hero', id: 'top', layout: 'split', heading: 'Pools', image: `asset:${logo}` }, { type: 'gallery', id: 'work', images: [`asset:${pic}`, `asset:${logo}`] }] }] }
  const [errors, c] = validateContent(content({ logo, site: spec }), [], new Set([logo, pic]), { photoIds: new Set([pic]) })
  assert.deepEqual(errors, [])
  assert.equal(c.logo, logo, 'the logo pointer is valid')
  assert.ok(!JSON.stringify(c.site).includes(logo), 'the logo is not accepted as a photo')
  assert.ok(JSON.stringify(c.site).includes(pic))
  // Without photoIds nothing changes for existing callers.
  assert.ok(JSON.stringify(validateContent(content({ logo, site: spec }), [], new Set([logo, pic]))[1].site).includes(logo))
})

test('withoutAsset: every reference goes (logo, hero, gallery, phone copies, older design, pages: images, backgrounds, benefit images, photo blocks); unrelated content is returned untouched', () => {
  const [a, b, small] = ids(1, 2, 3)
  const site = {
    pages: [
      { slug: '', navLabel: 'Home', sections: [
        { type: 'hero', id: 'top', image: `asset:${a}`, imageAlt: 'x' },
        { type: 'gallery', id: 'work', images: [`asset:${a}`, `asset:${b}`] },
        { type: 'composition', id: 'c1', blocks: [{ kind: 'media', image: `asset:${a}` }, { kind: 'heading', text: 'Hi', image: `asset:${a}` }, { kind: 'media', image: `asset:${b}` }] },
        { type: 'cta', id: 'book', backgroundImage: `asset:${a}` },
        { type: 'features', id: 'f', items: [{ image: `asset:${a}`, title: 'One' }, { image: `asset:${b}`, title: 'Two' }] },
      ] },
    ],
  }
  const c = content({ logo: a, hero: a, photos: [a, b], variants: { [a]: small }, design: { heroImage: `asset:${a}`, aboutImage: 'stock:pool-water' }, site })
  const { content: out, changed } = withoutAsset(c, a)
  assert.equal(changed, true)
  assert.ok(!JSON.stringify(out).includes(a), 'no reference left')
  assert.deepEqual([out.logo, out.hero, out.photos, out.variants, out.design.heroImage, out.design.aboutImage], [null, null, [b], undefined, null, 'stock:pool-water'])
  const [hero, gallery, comp, cta, features] = out.site.pages[0].sections
  assert.deepEqual([hero.image, hero.imageAlt], [undefined, 'x'])
  assert.deepEqual(gallery.images, [`asset:${b}`])
  assert.deepEqual(comp.blocks, [{ kind: 'heading', text: 'Hi' }, { kind: 'media', image: `asset:${b}` }], 'a photo block of the deleted file is removed; another block kind only loses the image')
  assert.equal('backgroundImage' in cta, false)
  assert.deepEqual(features.items, [{ title: 'One' }, { image: `asset:${b}`, title: 'Two' }])
  assert.deepEqual([...contentAssetIds(c)].sort(), [a, b, small].sort())
  // Nothing to remove: the same object comes back (so stored JSON stays byte-identical).
  const other = content({ hero: b, site })
  assert.equal(withoutAsset(other, small).content, other)
  assert.equal(withoutAsset(other, small).changed, false)
  assert.equal(withoutMissingAssets(other, new Set([a, b])).content, other)
  assert.equal(withoutMissingAssets(other, new Set([b])).changed, true)
})

test('permanent delete: refused while the live website or the draft shows the file (with where); allowed when only history does, then versions, checkpoints and designer turns can never bring it back; copies and marks go; recorded', async () => {
  const c = await cookieFor('owner@pools.example')
  const s = await cookieFor('owner@salon.example')
  const [logo, logoSmall, pic, picSmall, theirs] = ids('d', 'e', 'f', 1, 2)
  for (const id of [logo, logoSmall, pic, picSmall]) photo('pools', id)
  photo('salon', theirs)
  // As a real save stores it (validated and repaired), so the version renders.
  const [v1Errors, v1] = validateContent(content({ logo, hero: pic, variants: { [pic]: picSmall, [logo]: logoSmall }, site: { ...SITE, pages: [{ ...SITE.pages[0], sections: [{ ...SITE.pages[0].sections[0], layout: 'split', image: `asset:${pic}` }] }] } }), [], new Set([logo, logoSmall, pic, picSmall]))
  assert.deepEqual(v1Errors, [])
  assert.ok(JSON.stringify(v1.site).includes(pic))
  db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 1, ?, 1)').run('pools', JSON.stringify(v1))
  db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 1, ?, 1)').run('salon', JSON.stringify(content({ hero: theirs })))
  db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, 1, 1, 1)').run('pools', JSON.stringify(v1))
  db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, 1, 1, 1)').run('salon', JSON.stringify(content({ hero: theirs })))
  const cp = await saveCheckpoint(db, 'pools', v1, 'autosave', 2)
  db.sql.prepare("INSERT INTO website_generations (id, customer, content, source, created_at) VALUES ('t1', 'pools', ?, 'ai', 3)").run(JSON.stringify({ kind: 'designer', site: v1.site, previous: v1.site, reply: 'Done.' }))
  db.sql.prepare('INSERT INTO website_asset_hidden (asset, customer, hidden_at) VALUES (?, ?, 1)').run(logoSmall, 'pools')
  const destroy = (cookie, id, extra = {}) => call(assets, 'POST', { cookie, body: { action: 'destroy', id, confirm: true, ...extra } })
  // Guards: sign-in, confirmation, ownership (another business: 404, never a hint), same-origin, id shape.
  assert.equal((await call(assets, 'POST', { body: { action: 'destroy', id: logo, confirm: true } })).status, 401)
  assert.equal((await call(assets, 'POST', { cookie: c, body: { action: 'destroy', id: logo } })).json.error, 'confirmation_required')
  assert.equal((await destroy(s, logo)).status, 404)
  assert.equal((await destroy(c, theirs)).status, 404)
  assert.equal((await call(assets, 'POST', { cookie: c, body: { action: 'destroy', id: logo, confirm: true }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await destroy(c, 'nope')).status, 400)
  // Live and draft show it: refused with the machine code, nothing changed.
  const liveRefused = await destroy(c, logo)
  assert.deepEqual([liveRefused.status, liveRefused.json.error, liveRefused.json.usage.live], [409, 'live', true])
  // Taken off the website and published without it (version 2). A file only the DRAFT shows → in_draft.
  const noLogo = { ...v1, logo: null }
  const [draftOnly] = ids(3)
  photo('pools', draftOnly)
  db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 2, ?, 4)').run('pools', JSON.stringify(noLogo))
  db.sql.prepare('UPDATE websites SET draft = ?, live_version = 2 WHERE customer = ?').run(JSON.stringify({ ...noLogo, photos: [draftOnly] }), 'pools')
  assert.deepEqual([(await destroy(c, draftOnly)).status, (await destroy(c, draftOnly)).json.error], [409, 'in_draft'])
  assert.deepEqual([(await destroy(c, pic)).status, (await destroy(c, pic)).json.error], [409, 'live'], 'the photo is still on the live site')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_assets WHERE customer = 'pools'").get().n, 5, 'nothing deleted by a refusal')
  db.sql.prepare('DELETE FROM website_assets WHERE id = ?').run(draftOnly)
  db.sql.prepare('UPDATE websites SET draft = ? WHERE customer = ?').run(JSON.stringify(noLogo), 'pools')
  // Only history shows the logo now (version 1, the checkpoint, the designer turn's variants are not images; the
  // logo itself is in version 1 and the checkpoint): delete for good.
  const u = (await photoUsage(db, 'pools')).get(logo)
  assert.deepEqual([u.draft, u.live, u.versions, u.history, u.logo], [false, false, 1, true, true])
  const ok = await destroy(c, logo)
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.deepEqual(ok.json.removed.sort(), [logo, logoSmall].sort(), 'its phone-sized copy goes with it')
  // Version 1 showed it; version 2 only named its phone copy (content.variants): both rows are cleaned.
  assert.deepEqual(ok.json.references, { versions: 2, checkpoints: 1, turns: 0 })
  assert.deepEqual(ok.json.storage.deleted, true)
  assert.equal(ok.json.storage.cache.maxAge, 86400, 'the real Cache-Control max-age of /site-assets')
  assert.match(ok.json.storage.cache.note, /24 hours/)
  // Rows: gone (bytes, hidden mark, "was the logo" mark); the other photo, its copy and the other business untouched.
  assert.deepEqual(db.sql.prepare("SELECT id FROM website_assets WHERE customer = 'pools' ORDER BY id").all().map((r) => r.id), [pic, picSmall].sort())
  assert.equal(db.sql.prepare('SELECT count(*) n FROM website_assets WHERE id = ?').get(theirs).n, 1)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM website_asset_hidden WHERE asset = ?').get(logoSmall).n, 0)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_generations WHERE json_extract(content, '$.kind') = 'logo'").get().n, 0)
  // Every stored copy no longer names it: a version restore or checkpoint restore cannot resurrect it.
  assert.equal(versionOf('pools', 1).logo, null)
  assert.deepEqual(versionOf('pools', 1).variants, { [pic]: picSmall }, 'only the deleted file’s copy entry left the map')
  assert.equal(versionOf('pools', 1).hero, pic, 'the other photo stays')
  assert.ok(!JSON.stringify(versionOf('salon', 1)).includes(theirs) === false, 'the other business’s version is untouched')
  const cpRow = JSON.parse(db.sql.prepare('SELECT content FROM website_generations WHERE id = ?').get(cp).content)
  assert.equal(cpRow.draft.logo, null)
  assert.equal(cpRow.draft.hero, pic)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 1, confirm: true } })).status, 200)
  assert.equal(draftOf('pools').logo, null, 'restoring the old version brings the site back without the deleted logo')
  const live = (await call(publicSite, 'GET', { params: { customer: 'pools' } })).text
  assert.ok(!live.includes(logo) && live.includes(pic))
  assert.equal((await call(siteAsset, 'GET', { cookie: c, params: { id: logo } })).status, 404, 'no longer served, not even to the owner')
  // The library no longer lists it; usage no longer knows it.
  assert.deepEqual((await listAssets(db, 'pools')).map((a) => a.id).sort(), [pic, picSmall].sort())
  assert.equal((await photoUsage(db, 'pools')).has(logo), false)
  assert.equal((await logoAssetIdsFor(db, 'pools')).has(logo), false)
  // Recorded (ids and counts only; the owner's email is a ref, never stored).
  const ev = db.sql.prepare("SELECT actor, actor_type, resource_type, resource_id, details FROM audit_log WHERE action = 'website.asset_deleted' AND customer = 'pools'").get()
  assert.ok(ev, 'audit_log row')
  assert.deepEqual([ev.actor_type, ev.resource_type, ev.resource_id], ['owner', 'website_asset', logo])
  assert.ok(!ev.actor.includes('@') && !ev.details.includes('@'))
  assert.deepEqual(JSON.parse(ev.details), { removed: 2, bytes: 16, versions: 2, checkpoints: 1, turns: 0 })
  // A designer turn that placed a photo: its spec loses the reference too (the photo is only in history after the owner
  // takes it off the draft and publishes).
  db.sql.prepare('INSERT INTO website_versions (customer, version, content, created_at) VALUES (?, 3, ?, 5)').run('pools', JSON.stringify(content()))
  db.sql.prepare('UPDATE websites SET draft = ?, live_version = 3 WHERE customer = ?').run(JSON.stringify(content()), 'pools')
  const ok2 = await destroy(c, pic)
  assert.equal(ok2.status, 200)
  // Versions 1 and 2, the autosave checkpoint and the restore's own "before_version_restore" checkpoint, the designer turn.
  assert.deepEqual(ok2.json.references, { versions: 2, checkpoints: 2, turns: 1 })
  assert.deepEqual(ok2.json.removed.sort(), [pic, picSmall].sort())
  const turn = JSON.parse(db.sql.prepare("SELECT content FROM website_generations WHERE id = 't1'").get().content)
  assert.ok(!JSON.stringify(turn).includes(pic))
  assert.equal(turn.reply, 'Done.', 'the rest of the turn is kept')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_assets WHERE customer = 'pools'").get().n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM website_assets WHERE id = ?').get(theirs).n, 1)
})

test('the "was the logo" memory: set once (any save path), remembered after removal even when never published, offered to no photo picker, gone with the file; not an AI generation', async () => {
  const c = await cookieFor('owner@pools.example')
  const [logo] = ids(7)
  photo('pools', logo)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ logo }) } })).status, 200)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ logo }) } })).status, 200, 'saving again with the same logo')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_generations WHERE customer = 'pools' AND json_extract(content, '$.kind') = 'logo'").get().n, 1, 'one mark per file')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_generations WHERE customer = 'pools' AND source = 'ai'").get().n, 0, 'never counted as AI use')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ logo: null }) } })).status, 200)
  const listed = (await call(website, 'GET', { cookie: c })).json.assets
  assert.deepEqual(listed.map((a) => [a.id, a.logo]), [[logo, true]], 'still marked Logo although never published and no longer in the draft')
  assert.equal((await listAssets(db, 'pools')).find((a) => a.id === logo).logo, true)
  // Another business's save with the same id is refused and leaves no mark for it.
  const s = await cookieFor('owner@salon.example')
  assert.equal((await call(website, 'POST', { cookie: s, body: { action: 'save', content: content({ logo }) } })).status, 400)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_generations WHERE customer = 'salon'").get().n, 0)
  // Permanent delete (nothing shows it): the mark goes with the file.
  const gone = await call(assets, 'POST', { cookie: c, body: { action: 'destroy', id: logo, confirm: true } })
  assert.equal(gone.status, 200)
  // The save's own autosave checkpoint (Website Studio) named the logo: it is cleaned too, never published anywhere.
  assert.deepEqual(gone.json.references, { versions: 0, checkpoints: 1, turns: 0 })
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_generations WHERE customer = 'pools' AND json_extract(content, '$.kind') = 'logo'").get().n, 0)
  assert.deepEqual((await call(website, 'GET', { cookie: c })).json.assets, [])
})
