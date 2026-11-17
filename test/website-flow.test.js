// Website Studio end to end, across industries (real routes, real crawler/import/validation/rendering/publishing; the
// old websites are served by a mocked fetch). One content system: approved imported content becomes website content
// (services always shown, About/Contact/Privacy pages, legal text word for word), the preview shows the draft, publishing
// needs an explicit legal review, the published pages and the static download match, and nothing is duplicated by a
// repeated import. Three businesses with no shared assumptions: a pool service, an HVAC company and a hair salon.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { validateSpec, keepLegalPages } from '../server/site-spec.js'
import { legalSections, starterSite, starterPrivacy } from '../server/site-starter.js'
import { crc32 } from '../server/zip.js'
import * as importApi from '../functions/api/dashboard/website/import.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as preview from '../functions/api/dashboard/website/preview.js'
import * as exporter from '../functions/api/dashboard/website/export.js'
import * as publicHome from '../functions/p/[customer].js'
import * as publicPage from '../functions/p/[customer]/[page].js'

const ORIGIN = 'https://getshowups.com'
const DAY = 864e5
let env, db, kv, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
const BIZ = {
  pools: { name: 'Clear Pools', industry: 'Pool service', phone: '(843) 555-0100', host: 'www.clearpools.example' },
  hvac: { name: 'Northwind Air', industry: 'HVAC', phone: '(612) 555-0142', host: 'www.northwindair.example' },
  salon: { name: 'Luna Hair Studio', industry: 'Hair salon', phone: '(512) 555-0177', host: 'www.lunasalon.example' },
}
function seed(id) {
  const now = Date.now()
  const b = BIZ[id]
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, b.name, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, ?, ?, '', '[]', '[]', ?)").run(id, b.phone, b.industry, now)
  kv.set(`google:${id}`, 'record')
}
async function cookieFor(id) {
  const email = `owner@${id}.example`
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, params, path = '/x', origin = ORIGIN } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}${path}`, { method, headers: h, body: body && JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const buf = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder().decode(buf)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, bytes: buf, headers: res.headers }
}

// Old websites (public pages of three different businesses).
const html = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title}"></head><body>${body}</body></html>`
const POLICY = (name) =>
  `<h1>Privacy Policy</h1><h2>What we collect</h2><p>When you request service we collect your name, phone number and address.</p><ul><li>Contact details you give us</li><li>Photos you choose to send</li></ul><h2>Reviews and offers</h2><p>We may ask you to leave reviews. We never sell your details, and asking us questions is always free.</p><h2>Contact</h2><p>Email ${name} to see or delete your details.</p>`
const SITES = {
  'www.clearpools.example': {
    '/': html('Clear Pools', '<h1>Pool cleaning in Charleston</h1><p>Weekly pool care for Charleston homes, done right every week of the season.</p>'),
    '/services': html('Services — Clear Pools', '<h1>Services</h1><h3>Weekly Pool Care</h3><p>$180+</p><p>Skimming, brushing and balanced water every week, with a note after each visit.</p><h3>Green Pool Cleanup</h3><p>$400+</p><p>We bring cloudy or green water back to clear in a few visits.</p>'),
    '/about': html('About — Clear Pools', '<h2>Who we are</h2><p>A small Charleston team focused on reliable weekly visits and clear communication with every customer.</p>'),
    '/contact': html('Contact — Clear Pools', '<h1>Get a quote</h1><p>Send us a message.</p>'),
    '/privacy-policy': html('Privacy Policy — Clear Pools', POLICY('Clear Pools')),
  },
  'www.northwindair.example': {
    '/': html('Northwind Air', '<h1>Heating and cooling in Minneapolis</h1><p>Furnace and air conditioning service for Minneapolis homes, from tune-ups to repairs.</p>'),
    '/services': html('Services — Northwind Air', '<h1>What we do</h1><h3>AC Tune-Up</h3><p>$129</p><p>A full check of your air conditioner before summer, with a written report.</p><h3>Furnace Repair</h3><p>$95 diagnostic</p><p>We find the fault and quote the repair before any work starts.</p>'),
    '/about-us': html('About us — Northwind Air', '<h2>About Northwind Air</h2><p>Northwind Air is a family heating and cooling company working across Minneapolis and nearby towns.</p>'),
    '/contact-us': html('Contact us — Northwind Air', '<h1>Contact us</h1><p>Call or send a message.</p>'),
    '/privacy': html('Privacy — Northwind Air', POLICY('Northwind Air')),
  },
  'www.lunasalon.example': {
    '/': html('Luna Hair Studio', '<h1>Hair studio in Austin</h1><p>Cuts, colour and styling in a calm East Austin studio, by appointment.</p>'),
    '/menu': html('Menu — Luna Hair Studio', '<h1>Services</h1><h3>Women’s Cut</h3><p>$65</p><p>Consultation, wash, precision cut and blow-dry, tailored to your hair.</p><h3>Full Colour</h3><p>from $120</p><p>Root-to-tip colour with a gloss, after a strand test at your first visit.</p>'),
    '/about': html('About — Luna Hair Studio', '<h2>Our studio</h2><p>Luna Hair Studio is an independent salon with three stylists and a quiet, unhurried approach.</p>'),
    '/book': html('Book — Luna Hair Studio', '<h1>Book an appointment</h1><p>Choose a time.</p>'),
  },
}
const FILES = { '/site-fonts/': 'font', '/site-stock/': 'img' }

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
    // Pages static assets (stock photos, fonts) for the static download.
    ASSETS: { fetch: async (req) => (Object.keys(FILES).some((p) => new URL(req.url).pathname.startsWith(p)) ? new Response(new Uint8Array([1, 2, 3])) : new Response('nf', { status: 404 })) },
  }
  for (const id of Object.keys(BIZ)) seed(id)
  origFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    const s = SITES[u.hostname]
    if (s) {
      if (u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } })
      if (u.pathname === '/sitemap.xml') return new Response(`<urlset>${Object.keys(s).map((p) => `<url><loc>https://${u.hostname}${p}</loc></url>`).join('')}</urlset>`, { headers: { 'content-type': 'application/xml' } })
      return s[u.pathname] === undefined ? new Response('nf', { status: 404 }) : new Response(s[u.pathname], { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

// Lists the names inside a stored .zip (central directory).
function zipNames(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = bytes.length - 22
  while (i > 0 && v.getUint32(i, true) !== 0x06054b50) i--
  let at = v.getUint32(i + 16, true)
  const names = []
  for (let n = v.getUint16(i + 10, true); n > 0; n--) {
    const len = v.getUint16(at + 28, true)
    names.push(new TextDecoder().decode(bytes.slice(at + 46, at + 46 + len)))
    at += 46 + len + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return names
}

async function importAndApply(id, { pages, fields } = {}) {
  const c = await cookieFor(id)
  const start = await call(importApi, 'POST', { cookie: c, body: { action: 'start', url: BIZ[id].host, confirm: true } })
  assert.equal(start.status, 200, `${id} import: ${start.text}`)
  const imp = start.json.import
  const s = imp.suggestion
  const chosenFields = fields || Object.keys(s.content)
  const chosenPages = pages || s.pages.filter((p) => !p.exists && p.source !== 'starter').map((p) => p.kind)
  const r = await call(importApi, 'POST', { cookie: c, body: { action: 'apply', importId: imp.id, fields: chosenFields, photos: [], pages: chosenPages } })
  assert.equal(r.status, 200, `${id} apply: ${r.text}`)
  return { c, imp, apply: r.json }
}

for (const id of Object.keys(BIZ)) {
  test(`${id}: existing website → scan → review → import → pages generated (services shown) → preview → legal review → publish → public pages match`, async () => {
    const b = BIZ[id]
    const { c, imp, apply } = await importAndApply(id, id === 'salon' ? { pages: ['services', 'about', 'contact', 'privacy'] } : {})
    // Scan summary: what was found, what's missing, what needs review.
    const offers = Object.fromEntries(imp.suggestion.pages.map((p) => [p.kind, p.source]))
    assert.equal(offers.privacy, id === 'salon' ? 'starter' : 'imported', 'a policy is copied when found, otherwise a starter draft is offered')
    assert.equal(apply.siteCreated, true, 'no website yet → one is built from the business records + approved content')
    const draft = (await call(website, 'GET', { cookie: c })).json.website.draft
    const site = draft.site
    const slugs = site.pages.map((p) => p.slug)
    assert.deepEqual(slugs, ['', 'services', 'about', 'contact', 'privacy'])
    // Imported services appear on the website automatically, with their stated prices; nothing invented.
    const listed = site.pages.flatMap((p) => p.sections.filter((s) => s.type === 'services'))
    assert.ok(listed.length >= 1)
    const prices = draft.services.map((s) => s.price)
    assert.deepEqual(prices, { pools: ['$180+', '$400+'], hvac: ['$129', '$95 diagnostic'], salon: ['$65', 'from $120'] }[id])
    for (const sec of listed) assert.equal(sec.items.length, draft.services.length, 'every service in every services section')
    // Legal page: word for word (incl. words the marketing-claims filter would remove), headings kept, marked for review.
    const policy = site.pages.find((p) => p.slug === 'privacy')
    assert.equal(policy.legal, true)
    const policyText = policy.sections.map((s) => `${s.heading}\n${s.body}`).join('\n')
    if (id !== 'salon') {
      assert.equal(policy.source.kind, 'imported')
      assert.match(policy.source.url, new RegExp(`^https://${b.host.replace(/\./g, '\\.')}/privacy`))
      assert.match(policyText, /asking us questions is always free/)
      assert.match(policyText, /We may ask you to leave reviews/)
      assert.match(policyText, /• Contact details you give us/)
      assert.deepEqual(policy.sections.map((s) => s.heading).filter(Boolean), ['Privacy Policy', 'What we collect', 'Reviews and offers', 'Contact'])
    } else {
      assert.equal(policy.source.kind, 'starter')
      assert.equal(policyText.includes('Chat and voice'), false, 'no chat sentence when the receptionist is off')
    }
    // Preview = the draft (owner-only).
    const pv = await call(preview, 'GET', { cookie: c, path: '/api/dashboard/website/preview?page=services' })
    assert.equal(pv.status, 200)
    for (const s of draft.services) assert.ok(pv.text.includes(s.name.replace(/’/g, '&#8217;')) || pv.text.includes(s.name) || pv.text.includes(s.name.replace(/’/g, '&rsquo;')), `${s.name} on the Services page`)
    assert.equal((await call(preview, 'GET', { path: '/api/dashboard/website/preview' })).status, 401, 'drafts are private')
    // Publishing needs the explicit legal review.
    const no = await call(website, 'POST', { cookie: c, body: { action: 'publish', content: draft, confirm: true } })
    assert.deepEqual([no.status, no.json.error], [400, 'legal_review_required'])
    const yes = await call(website, 'POST', { cookie: c, body: { action: 'publish', content: draft, confirm: true, legalReviewed: true } })
    assert.equal(yes.status, 200, yes.text)
    // Public pages: navigation matches the pages (policy in the footer), every page renders, the policy is verbatim.
    const home = await call(publicHome, 'GET', { params: { customer: id }, path: `/p/${id}` })
    assert.equal(home.status, 200)
    const nav = home.text.match(/<header class="nav[\s\S]*?<\/header>/)[0]
    assert.deepEqual([...nav.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]), [`/p/${id}`, `/p/${id}/services`, `/p/${id}/about`, `/p/${id}/contact`])
    assert.match(home.text.match(/<footer[\s\S]*<\/footer>/)[0], new RegExp(`href="/p/${id}/privacy">Privacy policy</a>`))
    for (const slug of slugs.slice(1)) assert.equal((await call(publicPage, 'GET', { params: { customer: id, page: slug }, path: `/p/${id}/${slug}` })).status, 200, slug)
    const pub = await call(publicPage, 'GET', { params: { customer: id, page: 'privacy' }, path: `/p/${id}/privacy` })
    if (id !== 'salon') assert.match(pub.text, /asking us questions is always free/)
    assert.doesNotMatch(pub.text, /Ready when you are/, 'no sales band on a policy page')
    // No pool-service assumptions outside the pool business.
    if (id !== 'pools') for (const r of [home, pub]) assert.doesNotMatch(r.text.replace(/<style[\s\S]*?<\/style>/g, ''), /\bpools?\b/i)
    // Static download (own hosting): every page + README; same pages as GetShowUps hosting.
    const zip = await call(exporter, 'GET', { cookie: c, path: '/api/dashboard/website/export?format=static' })
    assert.equal(zip.status, 200)
    assert.equal(zip.headers.get('Content-Type'), 'application/zip')
    const names = zipNames(zip.bytes)
    for (const n of ['index.html', 'services/index.html', 'about/index.html', 'contact/index.html', 'privacy/index.html', 'README.txt']) assert.ok(names.includes(n), n)
    assert.ok(names.some((n) => n.startsWith('site-fonts/')), 'fonts included')
    // Contact forms only work on GetShowUps hosting: the downloaded pages carry none (never a form that can't send),
    // booking stays an absolute link to GetShowUps, and the README says so.
    const files = new TextDecoder().decode(zip.bytes)
    assert.doesNotMatch(files, /<form\b/, 'no contact form in the static files')
    assert.match(files, new RegExp(`href="https://getshowups\\.com/book/${id}"`))
    assert.match(files, /Contact forms only work on GetShowUps hosting and are not included here\./)
    // The same Contact page on GetShowUps hosting has the working form.
    assert.match((await call(publicPage, 'GET', { params: { customer: id, page: 'contact' }, path: `/p/${id}/contact` })).text, /<form id="f-contact" class="lead-form"/)
  })
}

test('repeated import and selective import: nothing duplicated, existing content and edits kept, only what was chosen changes', async () => {
  const { c, imp } = await importAndApply('hvac')
  const before = (await call(website, 'GET', { cookie: c })).json.website.draft
  // The owner edits the headline; a second import that brings only old addresses + pages changes nothing else.
  const edited = { ...before, headline: 'Furnace and AC help, any season' }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: edited } })).status, 200)
  const again = await call(importApi, 'POST', { cookie: c, body: { action: 'apply', importId: imp.id, fields: ['redirects'], photos: [], pages: ['services', 'about', 'contact', 'privacy'] } })
  assert.equal(again.status, 200)
  assert.deepEqual(again.json.pagesAdded, [], 'pages the site has are never added twice')
  const after = (await call(website, 'GET', { cookie: c })).json.website.draft
  assert.equal(after.headline, 'Furnace and AC help, any season')
  assert.equal(after.site.pages.length, before.site.pages.length)
  assert.equal(after.site.pages.flatMap((p) => p.sections).filter((s) => s.type === 'services').length, before.site.pages.flatMap((p) => p.sections).filter((s) => s.type === 'services').length)
  assert.equal(after.services.length, 2)
  // The second view offers those pages as existing (not again).
  const view = (await call(importApi, 'GET', { cookie: c })).json.import
  assert.ok(view.suggestion.pages.every((p) => p.exists))
})

test('an existing designed site without a services section gets one (once) when services are imported; nothing else replaced', async () => {
  const c = await cookieFor('pools')
  const designed = { headline: 'Pools done right', intro: 'Weekly care.', services: [], site: { pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'hero', id: 'top', heading: 'Pools done right' }] }, { slug: 'services', navLabel: 'Services', sections: [{ type: 'text', id: 'how', heading: 'How it works', body: 'Book online.' }] }] } }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: designed } })).status, 200)
  const start = await call(importApi, 'POST', { cookie: c, body: { action: 'start', url: BIZ.pools.host, confirm: true } })
  const r = await call(importApi, 'POST', { cookie: c, body: { action: 'apply', importId: start.json.import.id, fields: ['services'], photos: [], pages: [] } })
  assert.deepEqual([r.status, r.json.servicesSection, r.json.siteCreated], [200, true, false])
  const site = (await call(website, 'GET', { cookie: c })).json.website.draft.site
  const services = site.pages.find((p) => p.slug === 'services')
  assert.deepEqual(services.sections.map((s) => s.type), ['text', 'services', 'cta'], 'added to the Services page, after its first section')
  assert.equal(site.pages[0].sections[0].heading, 'Pools done right', 'the home page is untouched')
  const twice = await call(importApi, 'POST', { cookie: c, body: { action: 'apply', importId: start.json.import.id, fields: ['services'], photos: [], pages: [] } })
  assert.equal(twice.json.servicesSection, false)
})

test('starting fresh: pages from the business records only (no AI, no retyping); starter privacy matches what the site does and needs review', async () => {
  const c = await cookieFor('salon')
  const r = await call(website, 'POST', { cookie: c, body: { action: 'starter' } })
  assert.equal(r.status, 200, r.text)
  const site = r.json.website.draft.site
  assert.deepEqual(site.pages.map((p) => p.slug), ['', 'contact', 'privacy'])
  assert.equal(site.pages[2].source.kind, 'starter')
  assert.equal(site.pages[1].sections[0].type, 'contact')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'starter' } })).json.error, 'designed_site', 'never replaces a designed site')
  assert.match(starterPrivacy({ name: 'X', chat: true }), /Chat and voice: .*AI assistant/)
  assert.doesNotMatch(starterPrivacy({ name: 'X', chat: false }), /AI assistant/)
})

test('legal text: kept word for word only on legal pages; AI output can never mark a page legal; redesigns keep legal pages; incomplete or over-long policies are refused, not shortened', () => {
  const risky = 'We may ask for reviews. Questions are always free, guaranteed.'
  const raw = { pages: [{ slug: '', sections: [{ type: 'hero', heading: 'Hi' }] }, { slug: 'privacy', navLabel: 'Privacy', legal: true, source: { kind: 'imported', url: 'https://www.x.example/privacy', at: 1 }, sections: [{ type: 'text', heading: 'Policy', body: risky }, { type: 'cta', heading: 'Buy now' }] }, { slug: 'about', sections: [{ type: 'text', heading: 'About', body: risky }] }] }
  const { spec } = validateSpec(raw, {})
  const priv = spec.pages.find((p) => p.slug === 'privacy')
  assert.equal(priv.sections.length, 1, 'legal pages hold text only (no buttons, no sales band)')
  assert.equal(priv.sections[0].body, risky)
  assert.deepEqual(priv.source, { kind: 'imported', url: 'https://www.x.example/privacy', at: 1 })
  assert.equal(spec.pages.find((p) => p.slug === 'about').sections.find((s) => s.type === 'text')?.body || '', '', 'the same words elsewhere go through the claims filter')
  const ai = validateSpec(raw, { factsText: 'Hi' }).spec
  assert.ok(!ai.pages.some((p) => p.legal), 'AI output is never legal text')
  const redesign = keepLegalPages(validateSpec({ pages: [{ slug: '', sections: [{ type: 'hero', heading: 'New' }] }, { slug: 'privacy', sections: [{ type: 'text', heading: 'AI wrote this', body: 'Rewritten.' }] }] }, { factsText: 'New Rewritten' }).spec, spec)
  assert.equal(redesign.pages.find((p) => p.slug === 'privacy').sections[0].body, risky)
  // Crawled policies: headings kept; refused when the crawl was cut short or a paragraph is too long.
  const ok = legalSections({ text: [{ tag: 'h1', text: 'Privacy' }, { tag: 'p', text: 'One.' }, { tag: 'li', text: 'Two' }] })
  assert.deepEqual(ok.sections.map((s) => [s.heading, s.body]), [['Privacy', 'One.\n\n• Two']])
  assert.deepEqual(legalSections({ truncated: true, text: [{ tag: 'p', text: 'x' }] }), { ok: false, reason: 'incomplete' })
  assert.deepEqual(legalSections({ text: [{ tag: 'p', text: 'x'.repeat(2500) }] }), { ok: false, reason: 'too_long' })
  assert.deepEqual(legalSections({ text: Array.from({ length: 14 }, (_, i) => [{ tag: 'h2', text: `H${i}` }, { tag: 'p', text: 'p' }]).flat() }), { ok: false, reason: 'too_long' })
})

test('different industries get different looks from the same builder; words only from the records', () => {
  const content = (services) => ({ headline: 'H', intro: 'I', services: services.map((name) => ({ name, price: '' })) })
  const pool = starterSite(content(['Weekly pool care']), { name: 'A', industry: 'Pool service' }).site
  const clean = starterSite(content(['Deep clean']), { name: 'B', industry: 'House cleaning' }).site
  const other = starterSite(content(['Consultation']), { name: 'C', industry: 'Accounting' }).site
  assert.notDeepEqual(pool.theme.colors, other.theme.colors)
  assert.notEqual(pool.name, clean.name)
  assert.equal(other.pages[0].sections[0].image, null, 'unknown industry → no unrelated stock photo')
  assert.ok(String(pool.pages[0].sections[0].image).startsWith('stock:pool'))
})

test('a save can never create a legal page (which would skip the claims filter); legal pages made by the server stay legal through edits', async () => {
  const { c } = await importAndApply('hvac')
  const draft = (await call(website, 'GET', { cookie: c })).json.website.draft
  const crafted = { ...draft, site: { ...draft.site, pages: [...draft.site.pages.filter((p) => p.slug !== 'about'), { slug: 'terms', navLabel: 'Terms', legal: true, source: { kind: 'owner' }, sections: [{ type: 'text', heading: 'Terms', body: 'Guaranteed #1 best in town, 24/7, licensed and insured.' }] }] } }
  const saved = (await call(website, 'POST', { cookie: c, body: { action: 'save', content: crafted } })).json.website.draft
  const terms = saved.site.pages.find((p) => p.slug === 'terms')
  assert.equal(terms?.legal, undefined, 'not legal')
  assert.ok(!JSON.stringify(saved).includes('Guaranteed #1'), 'and its claims were filtered like any other page')
  const privacy = saved.site.pages.find((p) => p.slug === 'privacy')
  assert.equal(privacy.legal, true, 'the imported policy stays legal after an edit')
  assert.match(JSON.stringify(privacy), /always free/)
})

test('isolation and access: signed-out and other businesses get nothing; an import id is only usable by its business; exports are the session business only', async () => {
  const { imp } = await importAndApply('pools')
  const other = await cookieFor('hvac')
  assert.equal((await call(importApi, 'POST', { cookie: other, body: { action: 'apply', importId: imp.id, fields: ['headline'], photos: [], pages: ['about'] } })).status, 404)
  assert.equal((await call(importApi, 'POST', { body: { action: 'start', url: BIZ.pools.host, confirm: true } })).status, 401)
  assert.equal((await call(website, 'POST', { cookie: other, body: { action: 'starter' }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(exporter, 'GET', { path: '/api/dashboard/website/export?format=static' })).status, 401)
  assert.deepEqual((await call(exporter, 'GET', { cookie: other, path: '/api/dashboard/website/export?format=static' })).json, { error: 'not_published' })
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'standard CRC-32 (zip readers check it)')
})
