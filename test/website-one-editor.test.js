// Product Excellence, website builder (findings WEB-01, WEB-06, WEB-07, WEB-09): whichever way a website is started it
// ends as the multi-page website the full editor uses. Real routes on the SQLite-backed fake D1; no model is called
// (the three designs are the standard layouts).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { lookFromDesign, missingFor, starterSite, starterTheme } from '../server/site-starter.js'
import { PALETTES, FONTS, presetDesigns } from '../server/site-design.js'
import { validateSpec } from '../server/site-spec.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as preview from '../functions/api/dashboard/website/preview.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 864e5
let env, db, kv

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
function seed(id, { name, industry, phone = '', services = '[]', cities = '[]' }) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, name, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, ?, ?, '', ?, ?, ?)").run(id, phone, industry, services, cities, now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(id) {
  const email = `owner@${id}.example`
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, path = '/x' } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) h.Cookie = cookie
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

beforeEach(() => {
  db = d1()
  kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
  }
  seed('pools', { name: 'Clear Pools', industry: 'Pool service', phone: '(843) 555-0100', services: JSON.stringify([{ name: 'Weekly pool care', price: '$180+' }]), cities: JSON.stringify(['Charleston']) })
  seed('books', { name: 'Ledger & Co', industry: 'Accounting' })
})

test('a design’s look becomes the theme of the multi-page website; unknown options keep the starter look', () => {
  const base = starterTheme('pool')
  const look = lookFromDesign({ name: 'Deep End', palette: 'midnight', fonts: 'strong', hero: 'immersive', services: 'rows', shape: 'sharp', heroImage: 'stock:pool-ripples' }, base)
  assert.equal(look.name, 'Deep End')
  assert.equal(look.theme.colors.bg, PALETTES.midnight.bg)
  assert.equal(look.theme.colors.accent, PALETTES.midnight.accent)
  assert.equal(look.theme.headingFont, FONTS.strong.headFile)
  assert.equal(look.theme.radius, 0)
  assert.deepEqual([look.heroLayout, look.servicesLayout, look.heroImage], ['overlay', 'rows', 'stock:pool-ripples'])
  assert.equal(lookFromDesign({ palette: 'nope', fonts: 'strong' }, base), base)
  assert.equal(lookFromDesign(null, base), base)
  // Every preset design of an industry gives a site that validates, with the conversion-first home in the same order.
  const content = { headline: 'Pool care in Charleston', intro: 'Weekly visits.', about: '', area: 'Charleston', services: [{ id: 'sa', name: 'Weekly pool care', price: '$180+', description: '' }], hero: null, logo: null }
  const biz = { name: 'Clear Pools', industry: 'Pool service', phone: '(843) 555-0100', visit: true, chat: false, cities: ['Charleston'], hoursConfirmed: true, policies: {} }
  for (const design of presetDesigns('pool')) {
    const { site } = starterSite(content, biz, { kinds: ['contact', 'privacy'], design })
    const { spec } = validateSpec(site, { services: content.services, assetIds: { has: () => true } })
    assert.deepEqual(spec.pages.map((p) => p.slug), ['', 'contact', 'privacy'])
    assert.deepEqual(spec.pages[0].sections.map((s) => s.type).slice(0, 3), ['hero', 'services', 'steps'])
    assert.equal(spec.theme.colors.bg, PALETTES[design.palette].bg)
    assert.equal(spec.pages[0].sections[0].heading, 'Pool care in Charleston')
    // A text-only design never gets a photo it didn't choose; a design with a photo keeps it.
    assert.equal(Boolean(spec.pages[0].sections[0].image), Boolean(design.heroImage))
  }
})

test('WEB-01: "Create my website" from the Website tab → the chosen design is saved as the multi-page website (same editor, History, pages); the preview shows exactly that', async () => {
  const c = await cookieFor('pools')
  const before = (await call(website, 'GET', { cookie: c })).json
  assert.equal(before.website.generated, true)
  assert.deepEqual([before.missing, before.stock], [[], []], 'nothing is derived before a multi-page draft exists')
  const gen = (await call(website, 'POST', { cookie: c, body: { action: 'template' } })).json.generation
  assert.equal(gen.designs.length, 3)
  // The preview of each design is the multi-page website it becomes (its Contact page is in the menu).
  const pv = await call(preview, 'GET', { cookie: c, path: `/api/dashboard/website/preview?generation=${gen.id}&option=1&studio=1` })
  assert.equal(pv.status, 200)
  assert.match(pv.text, /<header class="nav /)
  assert.match(pv.text, new RegExp(`generation=${gen.id}&amp;option=1&amp;studio=1&amp;page=contact`))
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.generated, true, 'looking changes nothing')
  // Choosing it: the draft is the multi-page website with that design's look, the business's own services and nothing invented.
  const r = await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: gen.id, option: 1, studio: true } })
  assert.equal(r.status, 200)
  const draft = r.json.website.draft
  assert.equal(draft.site.name, gen.designs[1].name)
  assert.equal(draft.site.theme.colors.bg, PALETTES[gen.designs[1].palette].bg)
  assert.deepEqual(draft.site.pages.map((p) => p.slug), ['', 'contact', 'privacy'])
  const services = draft.site.pages[0].sections.find((s) => s.type === 'services')
  assert.deepEqual(services.items.map((x) => x.serviceId), draft.services.map((s) => s.id))
  assert.equal(draft.services[0].name, 'Weekly pool care')
  assert.equal(r.json.website.published, false, 'still a private draft')
  assert.deepEqual(r.json.missing, ['policies'], 'what the website still lacks is derived from the records')
  // The same draft is what every later load returns (the full editor opens on it).
  assert.ok((await call(website, 'GET', { cookie: c })).json.website.draft.site)
  // A second design can't silently replace a multi-page website.
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: gen.id, option: 0, studio: true } })).status, 409)
})

test('existing single-page websites are never converted by themselves: without the flag the design stays as it was; the owner can move it, and the old draft is kept in History', async () => {
  const c = await cookieFor('pools')
  const gen = (await call(website, 'POST', { cookie: c, body: { action: 'template' } })).json.generation
  const applied = (await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: gen.id, option: 0 } })).json
  assert.equal(applied.website.draft.site, undefined)
  assert.equal(applied.website.draft.design.name, gen.designs[0].name)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: applied.website.draft, confirm: true } })).status, 200)
  const liveBefore = db.sql.prepare("SELECT content FROM website_versions WHERE customer = 'pools' ORDER BY version DESC LIMIT 1").get().content
  // Loading, saving and publishing again never add pages to it.
  const again = (await call(website, 'GET', { cookie: c })).json.website
  assert.equal(again.draft.site, undefined)
  // The owner asks for the full editor: draft only, the design's look kept, the draft from before kept in History.
  const moved = await call(website, 'POST', { cookie: c, body: { action: 'starter' } })
  assert.equal(moved.status, 200)
  assert.equal(moved.json.website.draft.site.theme.colors.bg, PALETTES[gen.designs[0].palette].bg)
  assert.equal(moved.json.website.draft.headline, applied.website.draft.headline)
  assert.equal(moved.json.website.changed, true, 'the live website differs from the draft until the owner publishes')
  assert.equal(db.sql.prepare("SELECT content FROM website_versions WHERE customer = 'pools' ORDER BY version DESC LIMIT 1").get().content, liveBefore, 'the live version is untouched')
  const kept = moved.json.checkpoints.find((x) => x.reason === 'before_editor_switch')
  assert.ok(kept)
  const back = await call(website, 'POST', { cookie: c, body: { action: 'restoreCheckpoint', id: kept.id } })
  assert.equal(back.json.website.draft.site, undefined, 'the single-page draft comes back from History')
})

test('WEB-06: what is missing is derived on every load, with a services section that is hidden or absent reported as such', async () => {
  const c = await cookieFor('books')
  const made = (await call(website, 'POST', { cookie: c, body: { action: 'starter' } })).json
  assert.deepEqual(made.starterMissing, ['phone', 'services', 'area', 'policies'])
  assert.deepEqual(made.missing, ['phone', 'services', 'area', 'policies'])
  assert.deepEqual((await call(website, 'GET', { cookie: c })).json.missing, ['phone', 'services', 'area', 'policies'], 'still there after a reload')
  // A record added in Settings resolves its line.
  db.sql.prepare("UPDATE business_profiles SET phone = '(512) 555-0111', cities = '[\"Austin\"]' WHERE customer = 'books'").run()
  assert.deepEqual((await call(website, 'GET', { cookie: c })).json.missing, ['services', 'policies'])
  // Pure rule: services on record but no visible section showing them.
  const biz = { phone: 'x', hoursConfirmed: true, cities: ['A'], policies: { beforeVisit: 'Be home.' }, visit: false }
  const site = (sections) => ({ services: [{ id: 'sa', name: 'Tax return' }], site: { pages: [{ slug: '', sections }] } })
  assert.deepEqual(missingFor(site([{ type: 'hero' }]), biz), ['services_section'])
  assert.deepEqual(missingFor(site([{ type: 'services', hidden: true }]), biz), ['services_section'])
  assert.deepEqual(missingFor(site([{ type: 'services' }]), biz), [])
  assert.deepEqual(missingFor({ services: [] }, biz), [], 'a single-page website has no such list')
})

test('WEB-07 / WEB-09: the editor is offered its industry’s own licensed photos only, and its preview frame carries no "Only you can see this" strip', async () => {
  const c = await cookieFor('pools')
  const made = (await call(website, 'POST', { cookie: c, body: { action: 'starter' } })).json
  assert.ok(made.stock.length > 0 && made.stock.every((ref) => /^stock:pool-/.test(ref)), 'pool photos for a pool business')
  const b = await cookieFor('books')
  assert.deepEqual((await call(website, 'POST', { cookie: b, body: { action: 'starter' } })).json.stock, [], 'no licensed photos for this industry: none offered')
  const inEditor = await call(preview, 'POST', { cookie: c, body: { content: made.website.draft, page: '' } })
  assert.equal(inEditor.status, 200)
  assert.doesNotMatch(inEditor.json.html, /Only you can see this/)
  // The private preview page (new tab) still says what it is.
  assert.match((await call(preview, 'GET', { cookie: c, path: '/api/dashboard/website/preview' })).text, /Preview\. Only you can see this\./)
})

// ---- WEB-08: the included "Describe a change" on a multi-page website (server/website-revise.js) ----
test('WEB-08: a change request on a multi-page website is ONE included-model request → a pending version; only what changed is written onto the owner’s pages; legal pages, sections and hand-made colours stay', async () => {
  const { reviseView, applyRevision } = await import('../server/website-revise.js')
  const c = await cookieFor('pools')
  let draft = (await call(website, 'POST', { cookie: c, body: { action: 'starter' } })).json.website.draft
  // The owner edits by hand first: a headline on the page and a brand colour.
  draft.site.pages[0].sections[0].heading = 'Pool care, done right'
  draft.site.theme.colors.accent = '#7c3aed'
  draft = (await call(website, 'POST', { cookie: c, body: { action: 'save', content: draft } })).json.website.draft
  const privacyBefore = JSON.stringify(draft.site.pages.find((p) => p.legal))
  const structure = (d) => d.site.pages.map((p) => [p.slug, p.sections.map((s) => s.id)])
  // The writer is shown the page as it is now (the hand-edited headline, not the stale flat field).
  assert.equal(reviseView(draft).headline, 'Pool care, done right')
  assert.equal(reviseView(draft).site, undefined)
  let asked = 0
  let shown = null
  env.AI = {
    run: async (_model, body) => {
      asked++
      shown = JSON.stringify(body.messages)
      const current = JSON.parse(shown.match(/\{\\"headline\\".*?\\"design\\":\{.*?\}\}/)?.[0].replaceAll('\\"', '"') || 'null')
      // Rewords the introduction, invents a rating (must be refused), keeps the design exactly as shown.
      return { response: JSON.stringify({ headline: current?.headline || 'Pool care, done right', intro: 'Friendly weekly pool care for Charleston homes.', about: '', services: [{ name: 'Weekly pool care', description: 'Rated 5 stars by 300 customers.' }], seoTitle: '', seoDescription: '', design: current?.design || null }), usage: { prompt_tokens: 10, completion_tokens: 10 } }
    },
  }
  const left = (await call(website, 'GET', { cookie: c })).json.aiUsage.revision.remaining
  const r = await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'Make the introduction friendlier' } })
  assert.equal(r.status, 200)
  assert.equal(asked, 1, 'one request to the included model')
  assert.match(shown, /Pool care, done right/)
  assert.equal(r.json.aiUsage.revision.remaining, left - 1, 'the same daily allowance')
  // Pending: nothing saved yet; the private preview shows the draft with the change.
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.site.pages[0].sections[0].text, draft.site.pages[0].sections[0].text)
  const pv = await call(preview, 'GET', { cookie: c, path: `/api/dashboard/website/preview?generation=${r.json.generation.id}&option=0` })
  assert.equal(pv.status, 200)
  assert.match(pv.text, /Friendly weekly pool care for Charleston homes\./)
  assert.match(pv.text, /<header class="nav /, 'still the multi-page website')
  // Keep it: only the introduction changed.
  const kept = await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: r.json.generation.id, option: 0 } })
  assert.equal(kept.status, 200)
  const after = kept.json.website.draft
  assert.equal(after.site.pages[0].sections[0].text, 'Friendly weekly pool care for Charleston homes.')
  assert.equal(after.site.pages[0].sections[0].heading, 'Pool care, done right', 'the hand-written headline stays')
  assert.equal(after.site.theme.colors.accent, '#7c3aed', 'a colour the request did not change is not reset')
  assert.deepEqual(structure(after), structure(draft), 'no page or section added, removed or moved')
  assert.equal(JSON.stringify(after.site.pages.find((p) => p.legal)), privacyBefore, 'the legal page is untouched')
  assert.ok(!JSON.stringify(after).includes('Rated 5 stars'), 'an invented claim never reaches the draft')
  assert.equal(kept.json.website.published, false, 'nothing is published by keeping a change')
  assert.ok(kept.json.checkpoints.some((x) => x.reason === 'before_ai_change'), 'the draft from before is kept in History')
  // Pure rule: a changed palette changes the colours; an unchanged one never does; a result without a basis is not this.
  const g = { basis: { headline: 'A', intro: 'B', about: '', services: [], design: { palette: 'lagoon', fonts: 'modern', shape: 'round', heroImage: null } }, content: { headline: 'A', intro: 'B', about: '', services: [] }, designs: [{ palette: 'midnight', fonts: 'modern', shape: 'round', heroImage: null }] }
  const dark = applyRevision(after, g)
  assert.deepEqual(dark.changed, ['colours'])
  assert.equal(dark.content.site.theme.colors.bg, PALETTES.midnight.bg)
  assert.deepEqual(applyRevision(after, { ...g, designs: [g.basis.design] }).changed, [])
  // Three new designs can still never replace a multi-page website.
  const gen = (await call(website, 'POST', { cookie: c, body: { action: 'template' } })).json.generation
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: gen.id, option: 0 } })).json.error, 'designed_site')
})

// Root cause of the studio-editor e2e flake (CI 2026-11-27): a Terms page added in the editor lost its legal flag on its
// first save (the save guard only kept pages that were legal before), so the page silently became an ordinary page and
// the editor, which takes the server's copy after a save, then offered every section type on it.
test('owner-added legal pages: the Studio\'s Terms / Privacy types stay legal through a save; no other page can be made legal by a save', async () => {
  const { pageTemplate } = await import('../src/dashboard/site-templates.js')
  const c = await cookieFor('pools')
  const gen = (await call(website, 'POST', { cookie: c, body: { action: 'template' } })).json.generation
  const applied = (await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: gen.id, option: 0, studio: true } })).json.website
  const draft = structuredClone(applied.draft)
  const biz = { name: 'Pools', services: draft.services, photos: [], area: '' }
  // "Add a page" → Terms of Service (a NEW page at its fixed address, from the Studio's template).
  draft.site.pages.push(pageTemplate('terms', biz, draft.site))
  // Attempts to make other text legal: an existing ordinary page, and a new page at another address.
  draft.site.pages.find((p) => p.slug === 'contact').legal = true
  draft.site.pages.push({ ...pageTemplate('terms', biz, draft.site), slug: 'offers', navLabel: 'Offers' })
  const r = await call(website, 'POST', { cookie: c, body: { action: 'save', content: draft, baseUpdatedAt: applied.updatedAt } })
  assert.equal(r.status, 200)
  const pages = Object.fromEntries(r.json.website.draft.site.pages.map((p) => [p.slug, p]))
  assert.equal(pages.terms.legal, true, 'the Studio\'s Terms page is still a legal page after its first save')
  assert.equal(pages.terms.source?.kind, 'starter')
  assert.ok(pages.terms.sections.every((s) => s.type === 'text'))
  assert.equal(pages.contact.legal, undefined, 'an existing page is never turned legal by a save')
  assert.equal(pages.offers.legal, undefined, 'a page at any other address is never legal')
  // And it stays legal on the next save (kept, as before).
  const again = await call(website, 'POST', { cookie: c, body: { action: 'save', content: r.json.website.draft, baseUpdatedAt: r.json.website.updatedAt } })
  assert.equal(again.json.website.draft.site.pages.find((p) => p.slug === 'terms').legal, true)
  // A page that was ordinary at /terms can't be flipped to legal later either.
  const plain = structuredClone(again.json.website.draft)
  plain.site.pages = plain.site.pages.filter((p) => p.slug !== 'terms')
  const removed = await call(website, 'POST', { cookie: c, body: { action: 'save', content: plain, baseUpdatedAt: again.json.website.updatedAt } })
  const ordinary = structuredClone(removed.json.website.draft)
  ordinary.site.pages.push({ slug: 'terms', navLabel: 'Terms', sections: [{ type: 'text', id: 't-1', heading: 'Terms', body: 'Ordinary words.' }] })
  const saved1 = await call(website, 'POST', { cookie: c, body: { action: 'save', content: ordinary, baseUpdatedAt: removed.json.website.updatedAt } })
  const flipped = structuredClone(saved1.json.website.draft)
  Object.assign(flipped.site.pages.find((p) => p.slug === 'terms'), { legal: true, source: { kind: 'starter' } })
  const saved2 = await call(website, 'POST', { cookie: c, body: { action: 'save', content: flipped, baseUpdatedAt: saved1.json.website.updatedAt } })
  assert.equal(saved2.json.website.draft.site.pages.find((p) => p.slug === 'terms').legal, undefined, 'an ordinary page is never turned legal')
})
