// Generated websites: images and headlines must fit the business. Images never cross industries (a pool
// service never gets a living room, a cleaner never gets a pool), an unknown industry gets text-led layouts
// instead of unrelated photos, owner photos win, headlines use the brand and city (never ZIP codes), and
// existing drafts/published sites are untouched by generation. node:sqlite D1, fake Workers AI. No network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { generateWebsite, reviseWebsite, websiteFacts, mergeGenerated } from '../server/website-ai.js'
import { brandName, generateContent } from '../server/website.js'
import { INDUSTRIES, industryKey, presetDesigns, stockFor, STOCK_IDS } from '../server/site-design.js'
import STOCK from '../server/stock-photos.js'

let env, db, reply

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  return { sql, prepare: (q) => stmt(q) }
}

// profile: null = no business profile row (PoolThru in production today: services only on the landing page).
function seed(id, name, { profile = null, services = [], zips = '29403' } = {}) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, name, zips, now, now, now)
  if (profile) {
    db.sql
      .prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '', ?, '', ?, ?, ?)")
      .run(id, profile.industry, JSON.stringify(services.map((n) => ({ name: n, price: '' }))), JSON.stringify(profile.cities || []), now)
  } else {
    db.sql
      .prepare("INSERT INTO landing_pages (customer, headline, intro, services, area, highlights, published, published_at, updated_at) VALUES (?, '', 'Book online.', ?, '', '[]', 0, NULL, ?)")
      .run(id, JSON.stringify(services), now)
  }
}
const customer = (id) => {
  const r = db.sql.prepare('SELECT * FROM customers WHERE id = ?').get(id)
  return { id: r.id, name: r.name, serviceZips: r.service_zips.split(',').filter(Boolean), appointmentMode: 'at_customer' }
}

const ALL_STOCK = STOCK.map((s) => `stock:${s.id}`)
const stockIn = (designs) => designs.flatMap((d) => [d.heroImage, d.aboutImage]).filter((r) => r?.startsWith('stock:')).map((r) => r.slice(6))
const PREFIX = { pool: /^pool-/, cleaning: /^clean-/, lawn: /^(lawn|garden)-/, trades: /^tools-/ }

beforeEach(() => {
  db = d1()
  // The model tries to use every photo in the library, including other industries' (and off-list) ones.
  reply = (n = 3) => ({
    headline: 'Efficient Pool Service in 29403',
    intro: 'Pick a time online.',
    about: 'We help.',
    services: [],
    seoTitle: 'Service in 29403',
    seoDescription: 'Book online.',
    designs: Array.from({ length: n }, (_, i) => ({ name: 'X', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'about'], heroImage: ALL_STOCK[(i * 7) % ALL_STOCK.length], aboutImage: 'stock:home-living' })),
    design: { name: 'X', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services'], heroImage: 'stock:home-kitchen', aboutImage: 'stock:pool-water' },
  })
  env = { ONBOARDING_DB: db, AI: { run: async () => ({ response: reply(), usage: {} }) } }
  seed('poolthru-llc', 'Poolthru LLC', { services: ['Weekly pool cleaning · From $150/month', 'Green pool cleanup'] }) // as in production: no profile, ZIP only
  seed('sparkle', 'Sparkle Maids Inc.', { profile: { industry: 'House cleaning', cities: ['Mount Pleasant'] }, services: ['Deep clean', 'Move-out clean'] })
  seed('greenway', 'Greenway Lawn Co', { profile: { industry: 'Lawn care', cities: ['Summerville'] }, services: ['Weekly mowing', 'Hedge trimming'] })
  seed('ace', 'Ace Plumbing LLC', { profile: { industry: 'Plumbing', cities: ['Charleston'] }, services: ['Drain cleaning', 'Water heater repair'] })
  seed('books', 'Ledger & Co', { profile: { industry: 'Bookkeeping', cities: ['Columbia'] }, services: ['Monthly bookkeeping'] })
})

test('industry is recognised from the business details; PoolThru without a profile is still a pool service', () => {
  assert.equal(industryKey({ industry: null, services: [{ name: 'Weekly pool cleaning' }], name: 'Poolthru LLC' }), 'pool')
  assert.equal(industryKey({ name: 'Poolthru LLC' }), 'pool', 'brand name alone is enough')
  assert.equal(industryKey({ industry: 'House cleaning', services: ['Pool deck wash'] }), 'cleaning', 'their chosen industry wins over a service name')
  assert.equal(industryKey({ industry: 'Lawn care' }), 'lawn')
  assert.equal(industryKey({ industry: 'Plumbing', services: [{ name: 'Drain cleaning' }] }), 'trades')
  assert.equal(industryKey({ industry: 'Bookkeeping', name: 'Ledger & Co' }), null)
})

test('stock photo sets are disjoint per industry; unknown industries get none (no generic houses or interiors)', () => {
  const seen = new Map()
  for (const key of Object.keys(INDUSTRIES)) {
    const ids = stockFor(key).map((s) => s.id)
    assert.ok(ids.length >= 2, `${key} has photos`)
    assert.ok(ids.every((id) => PREFIX[key].test(id) && STOCK_IDS.has(id)), `${key} uses only its own photos`)
    for (const id of ids) {
      assert.ok(!seen.has(id), `${id} is in both ${seen.get(id)} and ${key}`)
      seen.set(id, key)
    }
  }
  assert.deepEqual(stockFor(null), [])
  assert.deepEqual(stockFor('pool').filter((s) => /home-|clean-|living|kitchen/.test(s.id)), [])
  for (const s of STOCK) assert.ok(s.license === 'CC0 1.0' && /^https:\/\/stocksnap\.io\//.test(s.source), `${s.id} is licensed and sourced`)
})

test('presets: each industry gets its own photos, palette and named direction; unknown → text-led, no photo', () => {
  for (const key of Object.keys(INDUSTRIES)) {
    const p = presetDesigns(key)
    assert.ok(stockIn(p).length > 0 && stockIn(p).every((id) => PREFIX[key].test(id)), key)
    assert.deepEqual(p.map((d) => d.palette), INDUSTRIES[key].palettes)
    assert.deepEqual(p.map((d) => d.name), INDUSTRIES[key].names)
    assert.equal(new Set(p.map((d) => d.hero)).size, 3)
  }
  const none = presetDesigns(null)
  assert.deepEqual(stockIn(none), [])
  assert.ok(none.every((d) => d.heroImage === null && d.aboutImage === null))
  assert.equal(new Set(none.map((d) => d.hero)).size, 3)
  // Owner photos come first, for any industry.
  const own = presetDesigns(null, ['a'.repeat(32)])
  assert.equal(own[0].heroImage, `asset:${'a'.repeat(32)}`)
})

test('generate: the model cannot place another industry\'s photo (PoolThru, cleaning, lawn, plumbing, unknown)', async () => {
  const cases = [['poolthru-llc', 'pool'], ['sparkle', 'cleaning'], ['greenway', 'lawn'], ['ace', 'trades'], ['books', null]]
  for (const [id, key] of cases) {
    const g = (await generateWebsite(env, customer(id))).generation
    assert.equal(g.source, 'ai')
    const used = stockIn(g.designs)
    if (key) assert.ok(used.every((s) => PREFIX[key].test(s)), `${id}: ${used.join(', ')}`)
    else assert.deepEqual(used, [], `${id}: no stock photos for an unknown industry`)
    if (key === 'pool') assert.ok(!used.some((s) => /^home-|^clean-/.test(s)), 'no house, kitchen or living room for PoolThru')
  }
})

test('generate: headlines use the brand and city, never ZIP codes; the AI prompt gets no ZIPs', async () => {
  let prompt = ''
  env.AI.run = async (_m, input) => {
    prompt = input.messages.map((m) => m.content).join('\n')
    return { response: reply(), usage: {} }
  }
  const pool = (await generateWebsite(env, customer('poolthru-llc'))).generation.content
  assert.ok(!/29403/.test(prompt), 'ZIP codes are not offered to the model as an area')
  assert.ok(prompt.includes('"brandName":"Poolthru"') && prompt.includes('clear blue water'))
  assert.equal(pool.headline, 'Poolthru: Weekly pool cleaning', 'ZIP headline from the model rejected; brand template used')
  assert.ok(!/\b\d{5}\b/.test(pool.seoTitle) && !/\b\d{5}\b/.test(pool.headline))

  reply = () => ({ headline: 'Sparkle Maids: spotless homes in Mount Pleasant', intro: 'Pick a time online.', about: 'We clean homes.', services: [], seoTitle: 'Sparkle Maids | House cleaning', seoDescription: 'Book online.', designs: [] })
  assert.equal((await generateWebsite(env, customer('sparkle'))).generation.content.headline, 'Sparkle Maids: spotless homes in Mount Pleasant')
  reply = () => ({ headline: 'Spotless homes in Mount Pleasant', intro: 'Pick a time online.', about: 'x', services: [], seoTitle: 't', seoDescription: 'd', designs: [] })
  assert.equal((await generateWebsite(env, customer('sparkle'))).generation.content.headline, 'Sparkle Maids: Deep clean in Mount Pleasant', 'a headline without the brand falls back')
  assert.equal(brandName('Poolthru LLC'), 'Poolthru')
  assert.equal(brandName('Ledger & Co'), 'Ledger & Co')
  assert.equal(websiteFacts(customer('poolthru-llc'), null, await generateContent(db, customer('poolthru-llc'))).serviceArea, null)
})

test('ZIP codes are allowed only when the owner explicitly asks for them in a revision', () => {
  const base = { headline: 'Poolthru: Weekly pool cleaning', intro: 'i', about: '', services: [], area: '', highlights: [], seoTitle: 't', seoDescription: 'd' }
  const facts = { brandName: 'Poolthru', serviceZips: ['29403'] }
  const raw = { headline: 'Poolthru pool care for 29403' }
  assert.equal(mergeGenerated(base, raw, facts).content.headline, base.headline)
  assert.equal(mergeGenerated(base, raw, facts, [], { allowZip: true }).content.headline, raw.headline)
})

test('revise: an existing draft\'s off-industry photo is dropped, not kept; drafts and live sites are not changed', async () => {
  const draft = { ...(await generateContent(db, customer('poolthru-llc'))), design: { name: 'Old', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services'], heroImage: 'stock:home-lawn', aboutImage: 'stock:home-kitchen' } }
  db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, 1, 1, 1)').run('poolthru-llc', JSON.stringify(draft))
  const before = db.sql.prepare("SELECT draft, live_version FROM websites WHERE customer = 'poolthru-llc'").get()
  const r = await reviseWebsite(env, customer('poolthru-llc'), draft, 'make it more modern')
  assert.ok(r.ok)
  const [d] = r.generation.designs
  assert.ok([d.heroImage, d.aboutImage].every((x) => x === null || /^stock:pool-/.test(x)), `${d.heroImage} / ${d.aboutImage}`)
  await generateWebsite(env, customer('poolthru-llc'))
  assert.deepEqual({ ...db.sql.prepare("SELECT draft, live_version FROM websites WHERE customer = 'poolthru-llc'").get() }, { ...before }, 'stored draft and live version untouched')
})

// ---------- the logo is never used as a photo ----------
const LOGO = 'a'.repeat(32)
const PHOTO = 'b'.repeat(32)
const addAsset = (id, customerId) =>
  db.sql.prepare("INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?, ?, 'image/png', x'00', 1, ?)").run(id, customerId, Date.now())

test('generate: the business logo is never offered or placed as a hero/About photo (as happened on PoolThru)', async () => {
  addAsset(LOGO, 'poolthru-llc')
  // The model tries to place the logo asset as the hero in every design.
  reply = () => ({
    headline: 'Pool service in Charleston', intro: 'Pick a time online.', about: 'We help.', services: [], seoTitle: 'Pool service', seoDescription: 'Book online.',
    designs: Array.from({ length: 3 }, () => ({ name: 'X', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'about'], heroImage: `asset:${LOGO}`, aboutImage: `asset:${LOGO}` })),
  })
  let prompt = ''
  env.AI = { run: async (_m, input) => ((prompt = JSON.stringify(input)), { response: reply(), usage: {} }) }
  const g = (await generateWebsite(env, customer('poolthru-llc'), { logo: LOGO })).generation
  const refs = g.designs.flatMap((d) => [d.heroImage, d.aboutImage])
  assert.ok(!refs.includes(`asset:${LOGO}`), refs.join(', '))
  assert.ok(!prompt.includes(LOGO), 'the logo is not offered to the model as an image')
  // A real owner photo is still used first.
  addAsset(PHOTO, 'poolthru-llc')
  const g2 = (await generateWebsite(env, customer('poolthru-llc'), { logo: LOGO, draftPhotos: [PHOTO] })).generation
  assert.ok(!g2.designs.flatMap((d) => [d.heroImage, d.aboutImage]).includes(`asset:${LOGO}`))
})

test('render: a saved design that placed the logo as the hero shows the design\'s other photo; the logo stays in the header', async () => {
  const { renderDesigned } = await import('../server/site-designed.js')
  const biz = { id: 'poolthru-llc', name: 'Poolthru LLC', phone: '', appointmentMode: 'at_customer' }
  const content = {
    headline: 'Pool service in Charleston', intro: 'Book online.', about: 'We help.', services: [], area: 'Charleston', highlights: [], photos: [], logo: LOGO,
    design: { name: 'Clear Water', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'sharp', sections: ['services', 'about'], heroImage: `asset:${LOGO}`, aboutImage: 'stock:pool-backyard' },
  }
  const html = renderDesigned(biz, content, { canonical: 'https://x.example/', bookUrl: '/book/poolthru-llc' })
  assert.equal(html.split(`/site-assets/${LOGO}`).length - 1, 1, 'logo only once (header)')
  assert.match(html, /<a class="brand"[^>]*><img src="\/site-assets\/a{32}"/)
  assert.ok(html.includes('/site-stock/pool-backyard'), 'hero falls back to the design\'s other photo')
  // Unaffected: a real photo as hero still renders.
  const normal = renderDesigned(biz, { ...content, design: { ...content.design, heroImage: 'stock:pool-water' } }, { canonical: 'https://x.example/', bookUrl: '/b' })
  assert.ok(normal.includes('/site-stock/pool-water') && normal.includes('/site-stock/pool-backyard'))
})

test('render: the statement layout sets only a short lead in display type; long text continues as body (same words)', async () => {
  const { renderDesigned } = await import('../server/site-designed.js')
  const about = 'We understand that maintaining a pool can be time-consuming. We handle the upkeep so you can focus on enjoying your outdoor space. Our process is simple: you pick a time online.'
  const biz = { id: 'p', name: 'P', phone: '', appointmentMode: 'at_customer' }
  const d = { name: 'Deep End', palette: 'midnight', fonts: 'strong', hero: 'immersive', services: 'rows', about: 'statement', shape: 'sharp', sections: ['about'], heroImage: 'stock:pool-loungers', aboutImage: null }
  const html = renderDesigned(biz, { headline: 'H', intro: 'I', about, services: [], area: '', highlights: [], photos: [], design: d }, { canonical: 'https://x.example/', bookUrl: '/b' })
  const at = html.indexOf('class="wrap ab-statement"')
  const block = html.slice(at, html.indexOf('</section>', at))
  assert.match(block, /<p>We understand that maintaining a pool can be time-consuming\.<\/p>\s*<p>We handle the upkeep/)
  const short = renderDesigned(biz, { headline: 'H', intro: 'I', about: 'Family-run since day one.', services: [], area: '', highlights: [], photos: [], design: d }, { canonical: 'https://x.example/', bookUrl: '/b' })
  assert.match(short, /<p>Family-run since day one\.<\/p>/)
})
