// Managed websites: generation, private drafts and preview, publish/unpublish, version rollback, legacy
// landing pages preserved, images (type checks, ownership, published-only), hosting that follows the
// subscription, customer domains (ownership proof before attach, collisions, routing, disconnect),
// pilot billing exemption, attendance corrections with history, and test-record separation.
// node:sqlite D1, Map KV, mocked DNS / hosting provider / HTTPS probe. No network.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { validateContent, hostingStatus, HOSTING_GRACE_MS } from '../server/website.js'
import { renderSite } from '../server/site-render.js'
import { normalizeHostname, checkDomain, checkDueDomains, claimDomain, disconnectDomain, platformOf, TOKEN_REUSE_MS, apexStatus, nsProviderOf, APEX_PROBE_PATH } from '../server/domains.js'
import { sniffImage } from '../server/assets.js'
import { readiness } from '../server/onboarding.js'
import { customerRows, growth } from '../server/metrics.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as preview from '../functions/api/dashboard/website/preview.js'
import * as assets from '../functions/api/dashboard/website/assets.js'
import * as exporter from '../functions/api/dashboard/website/export.js'
import * as domain from '../functions/api/dashboard/domain.js'
import * as publicSite from '../functions/p/[customer].js'
import * as siteAsset from '../functions/site-assets/[id].js'
import * as middleware from '../functions/_middleware.js'
import * as siteForm from '../functions/api/site-form/[customer].js'
import * as siteIcon from '../functions/site-icon/[id].js'
import { formToken } from '../server/site-form.js'
import * as billing from '../functions/api/dashboard/billing.js'
import * as outcome from '../functions/api/dashboard/outcome.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as testMark from '../functions/api/dashboard/test-mark.js'
import * as ghlRoute from '../functions/api/dashboard/ghl.js'
import { smsHandledByGhl } from '../server/ghl.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
let env, db, kv, dns, provider, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  // D1 batch: all statements in one transaction.
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
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, raw, params, origin = ORIGIN, url = `${ORIGIN}/x`, headers = {} } = {}) {
  const h = { ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(url, { method, headers: h, body: raw ?? (body && JSON.stringify(body)) }), env, params })
  const buf = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder().decode(buf)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, buf, headers: res.headers }
}
const content = (extra = {}) => ({ headline: 'Pool cleaning in Charleston', intro: 'Pick a time online.', services: [{ name: 'Weekly cleaning', price: 'From $150' }], area: 'Charleston', highlights: [], ...extra })
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

beforeEach(() => {
  db = d1()
  kv = new Map()
  dns = { TXT: {}, CNAME: {}, A: {}, NS: {}, google: {}, apex: {} } // google: per-resolver overrides ("CNAME:name" → values); apex: { "<apex>": { status, location } }
  provider = { domains: new Map(), calls: [] }
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    WEBSITE_STUDIO_ENABLED: 'true', // Website Studio pilot (old-address redirects come from it)
    WEBSITE_STUDIO_BUSINESSES: 'pools',
    WEBSITE_STUDIO_PUBLISH: 'true', // these tests publish redirects on purpose; the pilot's 'off' is tested in ai-designer
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  origFetch = globalThis.fetch
  // Mocked DNS-over-HTTPS, hosting-provider API and HTTPS site probe.
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    if (u.hostname === 'cloudflare-dns.com' || u.hostname === 'dns.google') {
      const type = u.searchParams.get('type')
      const name = u.searchParams.get('name')
      const values = (u.hostname === 'dns.google' && dns.google[`${type}:${name}`]) || dns[type]?.[name] || []
      const code = { TXT: 16, CNAME: 5, A: 1, NS: 2 }[type]
      return new Response(JSON.stringify({ Status: 0, Answer: values.map((data) => ({ type: code, data: type === 'TXT' ? `"${data}"` : type === 'A' ? data : `${data}.` })) }))
    }
    if (u.pathname === APEX_PROBE_PATH) {
      const f = dns.apex[u.hostname]
      if (!f) return new Response('ok', { status: 200 })
      if (f.https === false && u.protocol === 'https:') throw new Error('no certificate')
      return new Response('', { status: f.status || 301, headers: { Location: f.location.replace('{path}', u.pathname).replace('{query}', u.search) } })
    }
    if (u.hostname === 'api.cloudflare.com') {
      provider.calls.push([init.method, u.pathname, init.headers?.Authorization])
      const name = decodeURIComponent(u.pathname.split('/domains/')[1] || '')
      if (init.method === 'POST') {
        const n = JSON.parse(init.body).name
        provider.domains.set(n, { name: n, status: 'pending' })
        return new Response(JSON.stringify({ success: true, result: provider.domains.get(n) }))
      }
      if (init.method === 'DELETE') {
        provider.domains.delete(name)
        return new Response(JSON.stringify({ success: true, result: {} }))
      }
      const d = provider.domains.get(name)
      return d ? new Response(JSON.stringify({ success: true, result: d })) : new Response(JSON.stringify({ success: false }), { status: 404 })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})
const withProvider = () => Object.assign(env, { CF_API_TOKEN: 'cf_SECRET_TOKEN', CF_ACCOUNT_ID: 'acc', CF_PAGES_PROJECT: 'getshowups' })
const probeOk = async () => true
const probeFail = async () => false

// ---------- website content ----------

test('draft is generated from business details, passes the claims filter, and is private until published', async () => {
  const c = await cookieFor('owner@pools.example')
  const { json } = await call(website, 'GET', { cookie: c })
  assert.equal(json.website.generated, true)
  assert.equal(json.website.published, false)
  assert.equal(json.website.draft.area, '', 'a bare ZIP list is not shown as the service area (ZIPs still qualify leads)')
  assert.equal(json.url, `${ORIGIN}/p/pools`)
  assert.equal(json.ready, true)
  assert.deepEqual(validateContent(json.website.draft)[0], [], 'generated content passes its own rules')
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 404)
})

test('validation: claims, limits, templates, colours and images that are not the business’s own', async () => {
  assert.deepEqual(validateContent(content({ highlights: ['5-star reviews', 'Satisfaction guaranteed'] }))[0], ['highlights:unapproved_claim'])
  assert.deepEqual(validateContent(content({ about: 'Best prices guaranteed.' }))[0], ['about:unapproved_claim'])
  assert.deepEqual(validateContent(content({ highlights: ['Licensed and insured'] }), ['Licensed and insured'])[0], [])
  assert.deepEqual(validateContent(content({ template: 'neon' }))[0], ['template'])
  assert.deepEqual(validateContent(content({ color: '#ff0000' }))[0], ['color'])
  assert.deepEqual(validateContent(content({ headline: '' }))[0], ['headline'])
  assert.deepEqual(validateContent(content({ hero: 'a'.repeat(32) }), [], new Set())[0], ['images'])
  assert.deepEqual(validateContent(content({ photos: ['b'.repeat(32), 'b'.repeat(32)] }), [], new Set(['b'.repeat(32)]))[0], ['photos'])
})

test('save → preview (owner only) → publish (confirmed) → public; unpublish → 404; nothing private leaks', async () => {
  const c = await cookieFor('owner@pools.example')
  const bad = await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ highlights: ['Best in town, guaranteed'] }) } })
  assert.deepEqual([bad.status, bad.json.fields], [400, ['highlights:unapproved_claim']])
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ headline: 'Private draft headline' }) } })).status, 200)
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 404, 'a saved draft is not public')

  const pv = await call(preview, 'GET', { cookie: c })
  assert.equal(pv.status, 200)
  assert.ok(pv.text.includes('Private draft headline') && pv.text.includes('Only you can see this'))
  assert.match(pv.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/)
  assert.ok(!pv.text.includes('href="https://getshowups.com/book'), 'preview links are inert')
  assert.equal((await call(preview, 'GET', {})).status, 401)
  const other = await call(preview, 'GET', { cookie: await cookieFor('owner@salon.example') })
  assert.ok(!other.text.includes('Private draft headline'), 'another business never sees this draft')

  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content() } })).json.error, 'confirmation_required')
  const pub = await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  assert.deepEqual([pub.status, pub.json.website.published, pub.json.website.liveVersion], [200, true, 1])
  const site = await call(publicSite, 'GET', { params: { customer: 'pools' }, url: `${ORIGIN}/p/pools?utm_source=google&gclid=abc&evil=<x>` })
  assert.equal(site.status, 200)
  assert.ok(site.text.includes('Pool cleaning in Charleston'))
  assert.ok(site.text.includes('href="https://getshowups.com/book/pools?utm_source=google&amp;gclid=abc"'), 'ad parameters carried, others dropped')
  assert.ok(site.text.includes('<link rel="canonical" href="https://getshowups.com/p/pools">'))
  assert.ok(site.text.includes('"@type":"LocalBusiness"'))
  assert.ok(!site.text.includes('owner@pools.example'))
  assert.match(site.headers.get('Content-Security-Policy'), /default-src 'none'/)
  assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(site.text), 'no executable scripts on business sites')
  // A real business is indexable; once marked as a test business its site is never indexed (meta + header).
  assert.ok(!site.text.includes('name="robots"') && !site.headers.get('X-Robots-Tag'), 'real business: indexable')
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('pools', 1, 'founder@getshowups.example', ?)").run(Date.now())
  const testSite = await call(publicSite, 'GET', { params: { customer: 'pools' } })
  assert.equal(testSite.status, 200)
  assert.ok(testSite.text.includes('<meta name="robots" content="noindex">'))
  assert.equal(testSite.headers.get('X-Robots-Tag'), 'noindex')
  assert.ok(testSite.text.includes('<link rel="canonical"'), 'canonical kept')
  db.sql.prepare("DELETE FROM test_businesses WHERE customer = 'pools'").run()

  await call(website, 'POST', { cookie: c, body: { action: 'unpublish' } })
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 404)
})

test('versions: every publish is kept; restoring an earlier version makes it live again', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ headline: 'Version one' }), confirm: true } })
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ headline: 'Version two' }), confirm: true } })
  const w = (await call(website, 'GET', { cookie: c })).json.website
  assert.deepEqual(w.versions.map((v) => [v.version, v.live]), [[2, true], [1, false]])
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('Version two'))
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 1, confirm: true } })).status, 200)
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('Version one'))
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.headline, 'Version one', 'editing continues from the restored version')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 9, confirm: true } })).status, 404)
  // Another business can't restore (or see) these versions.
  assert.equal((await call(website, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'restore', version: 1, confirm: true } })).status, 404)
})

test('legacy landing page (e.g. PoolThru) stays live as the website, including through the first edit', async () => {
  db.sql
    .prepare("INSERT INTO landing_pages (customer, headline, intro, services, area, highlights, published, published_at, updated_at) VALUES ('pools', 'Pool service in Charleston', 'Book online.', ?, 'Charleston', '[]', 1, 5, 5)")
    .run(JSON.stringify(['Weekly cleaning · $150', 'Repairs']))
  const site = await call(publicSite, 'GET', { params: { customer: 'pools' } })
  assert.equal(site.status, 200)
  assert.ok(site.text.includes('Pool service in Charleston') && site.text.includes('$150'))
  const c = await cookieFor('owner@pools.example')
  const w = (await call(website, 'GET', { cookie: c })).json.website
  assert.deepEqual([w.published, w.generated, w.draft.services[0].name, w.draft.services[0].price], [true, false, 'Weekly cleaning', '$150'])
  // Saving a private draft does not take the live page down.
  await call(website, 'POST', { cookie: c, body: { action: 'save', content: { ...w.draft, headline: 'Unpublished change' } } })
  const after = await call(publicSite, 'GET', { params: { customer: 'pools' } })
  assert.ok(after.text.includes('Pool service in Charleston') && !after.text.includes('Unpublished change'))
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.changed, true)
})

test('guards: cross-site writes, signed-out, unbookable businesses, suspended businesses, bad ids', async () => {
  const c = await cookieFor('owner@pools.example')
  assert.equal((await call(website, 'POST', { cookie: c, origin: 'https://evil.example', body: { action: 'save', content: content() } })).status, 403)
  assert.equal((await call(website, 'GET', {})).status, 401)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'nope' } })).status, 400)
  seed('draftco', 'owner@draft.example', { bookable: false })
  const d = await cookieFor('owner@draft.example')
  assert.equal((await call(website, 'POST', { cookie: d, body: { action: 'publish', content: content(), confirm: true } })).json.error, 'not_ready')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'pools'").run()
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 404)
  assert.equal((await call(publicSite, 'GET', { params: { customer: '../x' } })).status, 404)
})

test('renderer escapes every value and keeps phone/booking links well formed', () => {
  const html = renderSite({ id: 'x', name: '<b>Evil & Co</b>', appointmentMode: 'at_customer', phone: '(843) 555-0123' }, { ...validateContent(content({ headline: '"><script>alert(1)</script>', about: 'Line one\n\nLine two' }))[1] }, { canonical: 'https://x.example/', bookUrl: 'https://getshowups.com/book/x' })
  assert.ok(!html.includes('<script>alert(1)'))
  assert.ok(html.includes('&lt;b&gt;Evil &amp; Co&lt;/b&gt;'))
  assert.ok(html.includes('href="tel:+18435550123"'))
  assert.ok(html.includes('Book a visit'))
  assert.ok(html.includes('<p>Line one</p><p>Line two</p>'))
  assert.ok(!html.includes('</script><script'), 'JSON-LD cannot break out')
})

// ---------- images ----------

test('images: only real JPEG/PNG/WebP within limits; served to the owner, public only once published', async () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(JPEG), 'image/jpeg')
  assert.equal(sniffImage(SVG), null)
  const c = await cookieFor('owner@pools.example')
  assert.equal((await call(assets, 'POST', { cookie: c, raw: SVG })).status, 415)
  assert.equal((await call(assets, 'POST', { cookie: c, raw: new Uint8Array(1_000_001).fill(0xff) })).status, 413)
  assert.equal((await call(assets, 'POST', { cookie: c, raw: PNG, origin: 'https://evil.example' })).status, 403)
  const up = await call(assets, 'POST', { cookie: c, raw: PNG })
  assert.equal(up.status, 201)
  const id = up.json.asset.id
  // Owner sees it (preview); the public and other businesses do not, until a live version uses it.
  const own = await call(siteAsset, 'GET', { cookie: c, params: { id } })
  assert.deepEqual([own.status, own.headers.get('Content-Type'), own.headers.get('Cache-Control')], [200, 'image/png', 'private, no-store'])
  assert.deepEqual([...own.buf], [...PNG])
  assert.equal((await call(siteAsset, 'GET', { params: { id } })).status, 404)
  assert.equal((await call(siteAsset, 'GET', { cookie: await cookieFor('owner@salon.example'), params: { id } })).status, 404)
  // Another business can't put this image on its site.
  const steal = await call(website, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'save', content: content({ hero: id }) } })
  assert.deepEqual(steal.json.fields, ['images'])
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ hero: id, logo: id }), confirm: true } })
  const pub = await call(siteAsset, 'GET', { params: { id } })
  assert.deepEqual([pub.status, pub.headers.get('Cache-Control'), pub.headers.get('X-Content-Type-Options')], [200, 'public, max-age=86400', 'nosniff'])
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes(`/site-assets/${id}`))
  assert.equal((await call(siteAsset, 'GET', { params: { id: 'not-an-id' } })).status, 404)
})

test('export: the owner downloads their own content and images; nobody else’s', async () => {
  const c = await cookieFor('owner@pools.example')
  const id = (await call(assets, 'POST', { cookie: c, raw: JPEG })).json.asset.id
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ photos: [id] }), confirm: true } })
  const ex = await call(exporter, 'GET', { cookie: c })
  assert.equal(ex.status, 200)
  assert.match(ex.headers.get('Content-Disposition'), /pools-website-export\.json/)
  assert.equal(ex.json.website.versions.length, 1)
  assert.equal(ex.json.images[0].id, id)
  assert.deepEqual([...Buffer.from(ex.json.images[0].base64, 'base64')], [...JPEG])
  const salon = await call(exporter, 'GET', { cookie: await cookieFor('owner@salon.example') })
  assert.deepEqual(salon.json.images, [])
  assert.equal((await call(exporter, 'GET', {})).status, 401)
})

// ---------- hosting follows the subscription ----------

test('hosting: pilots always hosted; self-serve hosted while paid, 14-day transition after it ends, then offline (content kept)', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  assert.deepEqual(await hostingStatus(db, 'pools'), { status: 'active', exempt: true })
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES ('pools', 'founding', 1, 2)").run()
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at) VALUES ('pools', 'cus_1', 'sub_1', 'active', ?, 1)").run(Date.now() + 10 * DAY)
  assert.equal((await hostingStatus(db, 'pools')).status, 'active')
  db.sql.prepare("UPDATE subscriptions SET status = 'past_due'").run()
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 200, 'no lock-out during payment retries')
  const ended = Date.now() - 2 * DAY
  db.sql.prepare("UPDATE subscriptions SET status = 'canceled', current_period_end = ?").run(ended)
  assert.equal((await hostingStatus(db, 'pools')).status, 'grace')
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 200)
  assert.equal((await hostingStatus(db, 'pools', ended + HOSTING_GRACE_MS + 1)).status, 'ended')
  db.sql.prepare('UPDATE subscriptions SET current_period_end = ?').run(Date.now() - HOSTING_GRACE_MS - DAY)
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 404)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })).json.error, 'plan_required')
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.headline, 'Pool cleaning in Charleston', 'content is kept')
  db.sql.prepare("UPDATE subscriptions SET status = 'active', current_period_end = ?").run(Date.now() + 30 * DAY)
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 200, 'resubscribing brings it straight back')
})

// ---------- domains ----------

test('domain input: normalised; our own and platform hosts reserved; apex domains steered to www', () => {
  assert.deepEqual(normalizeHostname('https://WWW.PoolThru.com/about?x=1'), [null, { hostname: 'www.poolthru.com', apex: false }])
  assert.deepEqual(normalizeHostname('book.example.co.uk'), [null, { hostname: 'book.example.co.uk', apex: false }])
  assert.equal(normalizeHostname('example.co.uk')[1].apex, true)
  assert.equal(normalizeHostname('poolthru.com')[1].apex, true)
  for (const bad of ['', 'localhost', 'not a domain', '1.2.3.4', 'a@b.com', '-x.com', 'x.c']) assert.equal(normalizeHostname(bad)[0], 'invalid_domain', bad)
  for (const r of ['getshowups.com', 'evil.getshowups.com', 'getshowups.pages.dev', 'x.workers.dev']) assert.equal(normalizeHostname(r)[0], 'reserved_domain', r)
})

test('domain: ownership TXT first; nothing attached before proof; then CNAME + certificate + HTTPS check → connected', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  const apex = await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'poolsco.com' } })
  assert.deepEqual([apex.status, apex.json.error, apex.json.suggestion], [400, 'apex_domain', 'www.poolsco.com'])
  const r = await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })
  assert.equal(r.status, 200)
  const d = r.json.domain
  assert.deepEqual([d.status, d.step, d.records[0].type, d.records[0].name], ['pending', 'verify', 'TXT', '_getshowups.www.poolsco.com'])
  assert.equal(provider.calls.length, 0, 'nothing attached before ownership is proven')
  // Wrong TXT value: still pending.
  dns.TXT['_getshowups.www.poolsco.com'] = ['gsu-verify=wrong']
  assert.equal(await checkDomain(env, 'www.poolsco.com'), 'pending')
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  assert.deepEqual(provider.calls[0], ['POST', '/client/v4/accounts/acc/pages/projects/getshowups/domains', 'Bearer cf_SECRET_TOKEN'])
  // Moving from Squarespace: the screen is told where www points today (public DNS, read live, never stored), so it
  // says to CHANGE that existing record rather than add a second one.
  dns.CNAME['www.poolsco.com'] = ['ext-cust.squarespace.com']
  const pointing = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([pointing.step, pointing.records[0]], ['point', { type: 'CNAME', name: 'www.poolsco.com', host: 'www', zone: 'poolsco.com', value: 'getshowups.pages.dev' }])
  assert.deepEqual(pointing.current, { target: 'ext-cust.squarespace.com', ours: false, platform: { id: 'squarespace', name: 'Squarespace' } })
  assert.equal(db.sql.prepare("SELECT detail FROM website_domains WHERE hostname = 'www.poolsco.com'").get().detail, 'waiting_for_cname')
  dns.CNAME['www.poolsco.com'] = ['old-host.example.net']
  assert.deepEqual((await call(domain, 'GET', { cookie: c })).json.domain.current, { target: 'old-host.example.net', ours: false, platform: null })
  assert.deepEqual(['shops.myshopify.com', 'www123.wixdns.net', 'example.com.evilsquarespace.com.attacker.net', 'squarespace.com'].map((t) => platformOf(t)?.id ?? null), ['shopify', 'wix', null, 'squarespace'])
  // CNAME added and the provider is active, but HTTPS doesn't serve us yet: still securing.
  dns.CNAME['www.poolsco.com'] = ['getshowups.pages.dev']
  provider.domains.get('www.poolsco.com').status = 'active'
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeOk }), 'connected')
  // Without a reachable HTTPS check, a validated certificate from hosting is required instead.
  db.sql.prepare("UPDATE website_domains SET status = 'securing' WHERE hostname = 'www.poolsco.com'").run()
  Object.assign(provider.domains.get('www.poolsco.com'), { validation_data: { status: 'active' }, verification_data: { status: 'active' } })
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'connected')
  const ok = (await call(domain, 'GET', { cookie: c })).json
  assert.deepEqual([ok.domain.status, ok.domain.url, ok.domain.current], ['connected', 'https://www.poolsco.com', null], 'no live DNS lookup once connected')
  assert.ok(!JSON.stringify(ok).includes('cf_SECRET_TOKEN'))
  // The site's canonical address becomes the domain.
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('<link rel="canonical" href="https://www.poolsco.com/">'))
  // DNS later moved away: needs attention (never silently "connected").
  dns.CNAME['www.poolsco.com'] = ['elsewhere.example']
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'needs_attention')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain.detail, 'dns_changed')
})

test('domain: provider-relative Host shown; a record the provider doubled (Host typed as the full name) or a wrong value is reported, not "waiting"', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  assert.deepEqual(d.records[0], { type: 'TXT', name: '_getshowups.www.poolsco.com', host: '_getshowups.www', zone: 'poolsco.com', value: d.records[0].value })
  // Nothing anywhere: plain waiting, with the time of the check.
  assert.equal(await checkDomain(env, 'www.poolsco.com'), 'pending')
  let v = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.equal(v.detail, 'waiting_for_record')
  assert.ok(v.checkedAt > 0)
  // The exact production failure: Squarespace appended the zone to the full name typed into Host.
  dns.TXT['_getshowups.www.poolsco.com.poolsco.com'] = [d.records[0].value]
  assert.equal(await checkDomain(env, 'www.poolsco.com'), 'pending')
  v = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([v.status, v.detail, v.verifiedAt], ['pending', 'record_doubled', null])
  assert.equal(provider.calls.length, 0, 'a doubled record never counts as proof')
  // Appended the hostname instead of the zone: also recognised.
  delete dns.TXT['_getshowups.www.poolsco.com.poolsco.com']
  dns.TXT['_getshowups.www.poolsco.com.www.poolsco.com'] = [d.records[0].value]
  await checkDomain(env, 'www.poolsco.com')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain.detail, 'record_doubled')
  // A different verification value at the right name.
  dns.TXT['_getshowups.www.poolsco.com'] = ['gsu-verify=someoneelse']
  await checkDomain(env, 'www.poolsco.com')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain.detail, 'wrong_value')
  // Corrected: verified and attached.
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  v = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([v.step, v.records[0].host, v.records[0].name], ['point', 'www', 'www.poolsco.com'])
  // Step 2 with the same mistake: CNAME at www.poolsco.com.poolsco.com.
  dns.CNAME['www.poolsco.com.poolsco.com'] = ['getshowups.pages.dev']
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain.detail, 'cname_doubled')
})

test('domain: without hosting-provider credentials a verified domain waits (admin is alerted), never claims to be connected', async () => {
  const c = await cookieFor('owner@pools.example')
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'book.poolsco.com' } })).json.domain
  dns.TXT[`_getshowups.book.poolsco.com`] = [d.records[0].value]
  assert.equal(await checkDomain(env, 'book.poolsco.com'), 'verifying')
  const v = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([v.status, v.detail, v.step, v.records], ['verifying', 'activation_pending', 'activate', []])
  assert.ok((await customerRows(env)).find((r) => r.id === 'pools').attention.includes('domain_activation'))
})

test('domain reconnect: the same business keeps its verification value (ownership re-proven); expired or other-business claims get a new one', async () => {
  const H = 'www.poolsco.com'
  const tok = () => db.sql.prepare('SELECT verify_token t, customer, status, verified_at, attached_at FROM website_domains WHERE hostname = ?').get(H)
  const t0 = Date.now()
  assert.equal((await claimDomain(env, 'pools', H, t0)).ok, true)
  const first = tok().t
  dns.TXT[`_getshowups.${H}`] = [`gsu-verify=${first}`]
  assert.equal(await checkDomain(env, H, { now: t0 + 1 }), 'verifying', 'verified (no hosting provider here)')
  assert.ok(tok().verified_at)
  // Disconnect, reconnect (also after a typo detour): same value, but ownership must be proven again.
  assert.equal((await disconnectDomain(env, 'pools', t0 + 2)).ok, true)
  assert.equal((await claimDomain(env, 'pools', 'www.poolsc0.com', t0 + 3)).ok, true)
  assert.equal((await disconnectDomain(env, 'pools', t0 + 4)).ok, true)
  assert.equal((await claimDomain(env, 'pools', H, t0 + 5)).ok, true)
  assert.deepEqual({ ...tok() }, { t: first, customer: 'pools', status: 'pending', verified_at: null, attached_at: null })
  assert.equal(await checkDomain(env, H, { now: t0 + 6 }), 'verifying', 'the existing TXT record verifies again')
  // Removed longer than the reuse window: a new value.
  await disconnectDomain(env, 'pools', t0 + 7)
  assert.equal((await claimDomain(env, 'pools', H, t0 + 7 + TOKEN_REUSE_MS + 1)).ok, true)
  const second = tok().t
  assert.notEqual(second, first)
  assert.equal(await checkDomain(env, H, { now: t0 + 8 + TOKEN_REUSE_MS }), 'pending', 'the old record no longer verifies')
  // Another business takes over the removed hostname: a fresh value; the previous owner's record proves nothing.
  await disconnectDomain(env, 'pools', t0 + 9 + TOKEN_REUSE_MS)
  dns.TXT[`_getshowups.${H}`] = [`gsu-verify=${second}`]
  assert.equal((await claimDomain(env, 'salon', H, t0 + 10 + TOKEN_REUSE_MS)).ok, true)
  const salon = tok()
  assert.equal(salon.customer, 'salon')
  assert.ok(![first, second].includes(salon.t))
  assert.equal(await checkDomain(env, H, { now: t0 + 11 + TOKEN_REUSE_MS }), 'pending')
  assert.equal(db.sql.prepare('SELECT detail FROM website_domains WHERE hostname = ?').get(H).detail, 'wrong_value')
  // …and when it comes back to the first business, that business gets a fresh value too (the row was another's).
  await disconnectDomain(env, 'salon', t0 + 12 + TOKEN_REUSE_MS)
  assert.equal((await claimDomain(env, 'pools', H, t0 + 13 + TOKEN_REUSE_MS)).ok, true)
  assert.ok(![first, second, salon.t].includes(tok().t))
})

test('domain claims under concurrency: duplicates are idempotent; one business, one domain; one owner per hostname', async () => {
  // Same business, same hostname, three at once: all succeed, one row, one value.
  const same = await Promise.all([1, 2, 3].map(() => claimDomain(env, 'pools', 'www.race.example')))
  assert.ok(same.every((r) => r.ok), JSON.stringify(same))
  assert.equal(new Set(same.map((r) => r.domain.records[0].value)).size, 1)
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_domains WHERE hostname = 'www.race.example'").get().n, 1)
  // Same business, two hostnames at once: exactly one wins, the other is told to disconnect first.
  await disconnectDomain(env, 'pools')
  const two = await Promise.all([claimDomain(env, 'pools', 'www.one.example'), claimDomain(env, 'pools', 'www.two.example')])
  assert.deepEqual(two.map((r) => r.ok).sort(), [false, true])
  assert.equal(two.find((r) => !r.ok).error, 'already_has_domain')
  assert.equal(db.sql.prepare("SELECT count(*) n FROM website_domains WHERE customer = 'pools' AND status <> 'removed'").get().n, 1)
  // Two businesses, one hostname at once: one owner; the other is refused and nothing of the winner's changes.
  const both = await Promise.all([claimDomain(env, 'salon', 'www.contested.example'), claimDomain(env, 'pools', 'www.contested.example')])
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true])
  const loser = both.find((r) => !r.ok)
  assert.ok(['domain_in_use', 'already_has_domain'].includes(loser.error))
  const row = db.sql.prepare("SELECT customer, verify_token FROM website_domains WHERE hostname = 'www.contested.example'").get()
  assert.equal(row.customer, both[0].ok ? 'salon' : 'pools')
  // A later attempt by another business on an ACTIVE claim is refused and leaves it untouched.
  const other = row.customer === 'salon' ? 'pools' : 'salon'
  if (other === 'pools') await disconnectDomain(env, 'pools')
  assert.equal((await claimDomain(env, other, 'WWW.Contested.Example')).error, 'domain_in_use')
  assert.deepEqual({ ...db.sql.prepare("SELECT customer, verify_token FROM website_domains WHERE hostname = 'www.contested.example'").get() }, { ...row })
})

test('domain: one business per hostname; no takeover; one domain per business; cross-site and signed-out refused', async () => {
  const a = await cookieFor('owner@pools.example')
  const b = await cookieFor('owner@salon.example')
  await call(domain, 'POST', { cookie: a, body: { action: 'connect', hostname: 'www.shared.example' } })
  const steal = await call(domain, 'POST', { cookie: b, body: { action: 'connect', hostname: 'WWW.Shared.Example' } })
  assert.deepEqual([steal.status, steal.json.error], [409, 'domain_in_use'])
  assert.equal(db.sql.prepare("SELECT customer FROM website_domains WHERE hostname = 'www.shared.example'").get().customer, 'pools')
  assert.equal((await call(domain, 'POST', { cookie: a, body: { action: 'connect', hostname: 'www.second.example' } })).json.error, 'already_has_domain')
  assert.equal((await call(domain, 'POST', { cookie: a, origin: 'https://evil.example', body: { action: 'disconnect' } })).status, 403)
  assert.equal((await call(domain, 'GET', {})).status, 401)
  assert.equal((await call(domain, 'GET', { cookie: b })).json.domain, null, 'salon sees nothing about the pools domain')
  // After pools disconnects, salon can claim it, but only with a NEW token it must prove again.
  const oldToken = db.sql.prepare("SELECT verify_token t FROM website_domains WHERE hostname = 'www.shared.example'").get().t
  assert.equal((await call(domain, 'POST', { cookie: a, body: { action: 'disconnect' } })).status, 200)
  const claimed = await call(domain, 'POST', { cookie: b, body: { action: 'connect', hostname: 'www.shared.example' } })
  assert.equal(claimed.json.domain.status, 'pending')
  assert.notEqual(db.sql.prepare("SELECT verify_token t FROM website_domains WHERE hostname = 'www.shared.example'").get().t, oldToken)
})

test('domain disconnect: removed from hosting first; website content untouched; GetShowUps address keeps working', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  await checkDomain(env, 'www.poolsco.com', { probe: probeFail })
  assert.ok(provider.domains.has('www.poolsco.com'))
  assert.equal((await call(domain, 'POST', { cookie: c, body: { action: 'disconnect' } })).status, 200)
  assert.ok(!provider.domains.has('www.poolsco.com'), 'detached from hosting')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain, null)
  assert.equal((await call(publicSite, 'GET', { params: { customer: 'pools' } })).status, 200)
  assert.equal((await call(domain, 'POST', { cookie: c, body: { action: 'disconnect' } })).status, 404)
})

test('hostname routing: a connected domain serves only its own business; unknown hosts and other paths are safe', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ headline: 'Pools on their own domain' }), confirm: true } })
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  await checkDomain(env, 'www.poolsco.com', { probe: probeFail })
  const passed = []
  const run = async (url, method = 'GET') => {
    const res = await middleware.onRequest({ request: new Request(url, { method }), env, next: async () => (passed.push(url), new Response('static')) })
    return { status: res.status, text: await res.text(), location: res.headers.get('Location') }
  }
  // Our own hosts pass straight through.
  assert.equal((await run('https://getshowups.com/dashboard')).text, 'static')
  assert.equal((await run('https://getshowups.pages.dev/')).text, 'static')
  const home = await run('https://www.poolsco.com/')
  assert.equal(home.status, 200)
  assert.ok(home.text.includes('Pools on their own domain'))
  const token = db.sql.prepare("SELECT verify_token t FROM website_domains WHERE hostname = 'www.poolsco.com'").get().t
  assert.equal((await run('https://www.poolsco.com/.well-known/getshowups-site')).text, token.slice(0, 12))
  assert.match((await run('https://www.poolsco.com/robots.txt')).text, /Sitemap: https:\/\/www\.poolsco\.com\/sitemap\.xml/)
  assert.match((await run('https://www.poolsco.com/sitemap.xml')).text, /<loc>https:\/\/www\.poolsco\.com\/<\/loc>/)
  assert.equal((await run('https://www.poolsco.com/dashboard')).location, 'https://getshowups.com/dashboard')
  assert.equal((await run('https://www.poolsco.com/p/salon')).location, 'https://www.poolsco.com/', 'cannot reach another business through this domain')
  assert.equal((await run('https://www.poolsco.com/api/dashboard/me')).location, 'https://www.poolsco.com/')
  assert.equal((await run('https://www.poolsco.com/', 'POST')).status, 405)
  assert.equal((await run('https://unknown.example/')).status, 404)
  // A claimed-but-unproven domain never routes.
  await call(domain, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'connect', hostname: 'www.salonco.com' } })
  assert.equal((await run('https://www.salonco.com/')).status, 404)
})

test('old-site addresses: published redirects send /services, /about and /contact to the right place on the connected domain; drafts never redirect', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  const redirects = [{ from: '/services', to: '/#services' }, { from: '/About/', to: '/#about' }, { from: '/request-service', to: 'book' }, { from: '/careers', to: '/' }]
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ redirects }), confirm: true } })
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  await checkDomain(env, 'www.poolsco.com', { probe: probeFail })
  const loc = async (url) => (await middleware.onRequest({ request: new Request(url), env, next: async () => new Response('static') })).headers.get('Location')
  assert.equal(await loc('https://www.poolsco.com/services'), 'https://www.poolsco.com/#services')
  assert.equal(await loc('https://www.poolsco.com/about'), 'https://www.poolsco.com/#about', 'stored lower-case without trailing slash')
  assert.equal(await loc('https://www.poolsco.com/Services/'), 'https://www.poolsco.com/#services')
  assert.equal(await loc('https://www.poolsco.com/request-service'), 'https://getshowups.com/book/pools')
  assert.equal(await loc('https://www.poolsco.com/anything-else'), 'https://www.poolsco.com/')
  // A redirect only in the private draft does nothing until published.
  await call(website, 'POST', { cookie: c, body: { action: 'save', content: content({ redirects: [...redirects, { from: '/gallery', to: '/#about' }] }) } })
  assert.equal(await loc('https://www.poolsco.com/gallery'), 'https://www.poolsco.com/')
  // Targets are fixed choices; sources are paths only.
  for (const bad of [[{ from: '/x', to: 'https://evil.example' }], [{ from: 'https://evil.example/x', to: '/' }], [{ from: '/x', to: '/' }, { from: '/x/', to: '/#about' }], [{ from: '/x', to: 'javascript:alert(1)' }]]) {
    assert.deepEqual(validateContent(content({ redirects: bad }))[0], ['redirects'], JSON.stringify(bad))
  }
  assert.equal('redirects' in validateContent(content())[1], false, 'no empty list added to older content')
})

test('cron domain checks are bounded and pick up due domains', async () => {
  const c = await cookieFor('owner@pools.example')
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  db.sql.prepare('UPDATE website_domains SET checked_at = 0').run()
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  assert.deepEqual(await checkDueDomains(env, { probe: probeFail }), { verifying: 1 })
  assert.deepEqual(await checkDueDomains(env, { probe: probeFail }), {}, 'not re-checked within 10 minutes')
})

// ---------- pilot billing exemption (PoolThru) ----------

test('pilot accounts are never asked to pay: no plan item, no checkout, an abandoned placeholder is ignored', async () => {
  Object.assign(env, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Founding', 'price_X', 0, '{}', 1, 1)").run()
  // Exactly PoolThru's production state: an 'incomplete' placeholder (no subscription), no self-serve signup.
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, status, updated_at) VALUES ('pools', 'cus_placeholder', 'incomplete', 1)").run()
  const customer = { id: 'pools', hoursConfirmed: true }
  const r = await readiness(env, customer, { calendarStatus: 'healthy' })
  assert.ok(!r.items.some((i) => i.id === 'subscription'), 'no "Fix your plan" for a pilot')
  assert.notEqual(r.next, 'subscription')
  const c = await cookieFor('owner@pools.example')
  const info = (await call(billing, 'GET', { cookie: c })).json
  assert.equal(info.billed, false)
  const before = db.sql.prepare('SELECT count(*) n FROM subscriptions').get().n
  assert.deepEqual((await call(billing, 'POST', { cookie: c, body: { action: 'checkout', plan: 'founding' } })).json, { error: 'not_billed' })
  assert.equal(db.sql.prepare('SELECT count(*) n FROM subscriptions').get().n, before, 'no billing record created')
  // Self-serve businesses are still billed (paid enforcement unchanged).
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at) VALUES ('salon', 'founding', 1)").run()
  const s = await readiness(env, { id: 'salon', hoursConfirmed: true }, { calendarStatus: 'healthy' })
  assert.deepEqual(s.items.find((i) => i.id === 'subscription'), { id: 'subscription', state: 'action', detail: 'not_started' })
  assert.equal((await call(billing, 'GET', { cookie: await cookieFor('owner@salon.example') })).json.billed, true)
})

// ---------- attendance corrections ----------

let slot = 0
function appointment(customer, { email = 'jo@example.net', ago = 2 * DAY, status = 'booked' } = {}) {
  const id = crypto.randomUUID().replaceAll('-', '')
  const lead = `L${id.slice(0, 15)}`
  const start = Date.now() - ago + ++slot * 3600e3 * (ago > 0 ? -1 : 1)
  db.sql
    .prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Jo', ?, '555-010-0100', 'Cleaning', 'booked', 'x', ?, ?)")
    .run(lead, customer, email, start - DAY, start - DAY)
  db.sql.prepare('INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, customer, lead, start, start + 3600e3, status, start - DAY, start - DAY)
  return { id, lead }
}

test('attendance: no-show ↔ showed ↔ not recorded, all reversible; history kept; counts never double', async () => {
  const c = await cookieFor('owner@pools.example')
  const { id, lead } = appointment('pools')
  const post = (body) => call(outcome, 'POST', { cookie: c, body: { id, ...body } })
  const stats = async () => (await call(overviewApi, 'GET', { cookie: c })).json.stats
  assert.equal((await post({ outcome: 'no_show' })).status, 200)
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(lead).status, 'new', 'no-show reopens the lead')
  assert.deepEqual([(await stats()).noShow, (await stats()).showed], [1, 0])
  assert.equal((await post({ outcome: 'showed' })).status, 200) // accidental click corrected
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(lead).status, 'booked')
  assert.deepEqual([(await stats()).noShow, (await stats()).showed, (await stats()).booked], [0, 1, 1])
  assert.equal((await post({ outcome: 'no_show' })).status, 200)
  assert.equal((await post({ outcome: 'clear' })).status, 200)
  const s = await stats()
  assert.deepEqual([s.noShow, s.showed, s.booked, s.showRate], [0, 0, 1, null])
  assert.equal((await call(overviewApi, 'GET', { cookie: c })).json.needsOutcome[0].id, id, 'back in "did they show up?"')
  const history = db.sql.prepare('SELECT from_status, to_status, changed_by FROM appointment_changes WHERE appointment_id = ? ORDER BY id').all(id)
  assert.deepEqual(history.map((h) => `${h.from_status}>${h.to_status}`), ['booked>no_show', 'no_show>showed', 'showed>no_show', 'no_show>booked'])
  assert.ok(history.every((h) => h.changed_by === 'owner@pools.example'))
  // The pending rebook message from the no-show is skipped once corrected (re-checked at send time).
  assert.equal((await post({ outcome: 'clear', work: 'completed' })).status, 400)
})

test('attendance: only the business’s own, already-started, non-cancelled appointments can be changed', async () => {
  const c = await cookieFor('owner@pools.example')
  const future = appointment('pools', { ago: -2 * DAY })
  const cancelled = appointment('pools', { status: 'cancelled' })
  const other = appointment('salon')
  for (const id of [future.id, cancelled.id, other.id]) assert.equal((await call(outcome, 'POST', { cookie: c, body: { id, outcome: 'showed' } })).status, 404)
  assert.equal((await call(outcome, 'POST', { cookie: c, body: { id: other.id, outcome: 'showed' }, origin: 'https://evil.example' })).status, 403)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM appointment_changes').get().n, 0)
})

test('self-serve businesses that finished onboarding before the website steps existed stay on their dashboard', async () => {
  const { progress } = await import('../server/customers.js')
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES ('pools', 'founding', 1, 2)").run()
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, updated_at) VALUES ('pools', 'cus_1', 'sub_1', 'active', 1)").run()
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('pools', '', 'Pool service', '', '[{\"name\":\"Cleaning\",\"price\":\"\"}]', '[]', 1)").run()
  const p = await progress(env, { id: 'pools', hoursConfirmed: true })
  assert.equal(p.selfServe, true)
  assert.equal(p.complete, true)
})

// ---------- test data ----------

test('test records: internal and owner-made bookings are tagged and excluded from results; owners can re-mark', async () => {
  const c = await cookieFor('owner@pools.example')
  env.PLATFORM_ADMIN_EMAILS = 'ops@getshowups.com, founder@florasummit.example'
  const real = appointment('pools', { email: 'customer@example.net' })
  const internal = appointment('pools', { email: 'QA@GetShowUps.com' })
  const own = appointment('pools', { email: 'owner@pools.example' })
  const admin = appointment('pools', { email: 'founder@florasummit.example' })
  for (const a of [real, internal, own, admin]) await call(outcome, 'POST', { cookie: c, body: { id: a.id, outcome: 'showed' } })
  let o = (await call(overviewApi, 'GET', { cookie: c })).json
  assert.deepEqual([o.stats.leads, o.stats.booked, o.stats.showed], [1, 1, 1], 'only the real customer counts')
  assert.deepEqual(o.recent.filter((r) => r.test).map((r) => r.leadId).sort(), [internal.lead, own.lead, admin.lead].sort(), 'tests are still listed, tagged')
  // Owner marks the real one as a test, and an auto-detected one as real.
  assert.equal((await call(testMark, 'POST', { cookie: c, body: { leadId: real.lead, isTest: true } })).status, 200)
  assert.equal((await call(testMark, 'POST', { cookie: c, body: { leadId: own.lead, isTest: false } })).status, 200)
  o = (await call(overviewApi, 'GET', { cookie: c })).json
  assert.deepEqual([o.stats.showed, o.recent.find((r) => r.leadId === own.lead).test], [1, false])
  // Nothing was deleted.
  assert.equal(db.sql.prepare("SELECT count(*) n FROM appointments WHERE customer = 'pools'").get().n, 4)
  // Admin metrics exclude tests too.
  const rows = await customerRows(env)
  assert.equal(rows.find((r) => r.id === 'pools').booked30, 1)
  const ready = await readiness(env, { id: 'salon', hoursConfirmed: true }, { calendarStatus: 'healthy' })
  appointment('salon', { email: 'owner@salon.example' })
  assert.equal((await readiness(env, { id: 'salon', hoursConfirmed: true }, { calendarStatus: 'healthy' })).items.find((i) => i.id === 'booking').state, 'pending', 'a test booking is not "receiving bookings"')
  assert.equal(ready.next, 'page', 'next step is the website, not a false "receiving bookings"')
  const g = await growth(env, rows)
  assert.equal(g.showUpRate30, 100)
  // Isolation and validation.
  const salon = await cookieFor('owner@salon.example')
  assert.equal((await call(testMark, 'POST', { cookie: salon, body: { leadId: real.lead, isTest: false } })).status, 404)
  assert.equal((await call(testMark, 'POST', { cookie: c, body: { leadId: real.lead, isTest: 'yes' } })).status, 400)
  assert.equal((await call(testMark, 'POST', { cookie: c, origin: 'https://evil.example', body: { leadId: real.lead, isTest: false } })).status, 403)
})

// ---------- release switches ----------

test('GHL release switch: off → route 404 and SMS never handed to GHL even with a stored config', async () => {
  const { encrypt } = await import('../server/google-oauth.js')
  kv.set('ghl:pools', await encrypt(env, JSON.stringify({ customer: 'pools', token: 't'.repeat(30), locationId: 'l', pipelineId: 'p', stageIds: {}, smsVia: 'ghl', workflowId: 'w' })))
  assert.equal(await smsHandledByGhl(env, 'pools'), false)
  assert.equal((await call(ghlRoute, 'GET', { cookie: await cookieFor('owner@pools.example') })).status, 404)
  env.GHL_ENABLED = 'true'
  assert.equal(await smsHandledByGhl(env, 'pools'), true)
})

// ---------- advertising: website → booking attribution and the Overview row ----------

test('ads: a click that lands on the website keeps its campaign through booking; Overview shows real ad results only', async () => {
  const c = await cookieFor('owner@pools.example')
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('campweb1', 'pools', 'google', 'active', '{}', 1000, 1, 1)").run()
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })).status, 200)

  // Ad click → customer website → its booking link → booking page sends the same parameters with the lead.
  const site = await call(publicSite, 'GET', { params: { customer: 'pools' }, url: `${ORIGIN}/p/pools?utm_source=google&utm_medium=cpc&utm_campaign=campweb1&gclid=Cj0KCQabc123xyz` })
  const href = site.text.match(/href="(https:\/\/getshowups\.com\/book\/pools\?[^"]+)"/)[1].replaceAll('&amp;', '&')
  const attribution = Object.fromEntries(new URL(href).searchParams)
  assert.deepEqual(attribution, { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'campweb1', gclid: 'Cj0KCQabc123xyz' })
  const lead = (n) => call(bookLead, 'POST', { params: { customer: 'pools' }, body: { name: `Ad Lead ${n}`, email: `ad${n}@example.net`, phone: '(843) 555-0142', need: 'Weekly cleaning', zip: '29403', attribution } })
  const ids = []
  for (const n of [1, 2, 3, 4]) {
    const r = await lead(n)
    assert.equal(r.status, 201, r.text)
    ids.push(r.json.leadId ?? r.json.id)
  }
  const attributed = db.sql.prepare("SELECT source, campaign_id FROM lead_attribution WHERE customer = 'pools' ORDER BY lead_id").all().map((r) => ({ ...r }))
  assert.equal(attributed.length, 4)
  assert.ok(attributed.every((a) => a.source === 'google_ads' && a.campaign_id === 'campweb1'), 'credited to the campaign, not a plain booking-page lead')

  // Outcomes: lead 1 booked + showed, lead 2 booked (upcoming), lead 3 no booking, lead 4 is a test record.
  const appt = (id, leadId, status, startOffset) =>
    db.sql
      .prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?, 'pools', ?, ?, ?, ?, ?, ?)")
      .run(id, leadId, now + startOffset, now + startOffset + 3600000, status, now, now)
  appt('a'.repeat(32), ids[0], 'showed', -86400000)
  appt('b'.repeat(32), ids[1], 'booked', 86400000)
  appt('c'.repeat(32), ids[3], 'showed', -3600000)
  db.sql.prepare("INSERT INTO test_marks (lead_id, customer, is_test, marked_by, marked_at) VALUES (?, 'pools', 1, 'owner', ?)").run(ids[3], now)
  // Noise that must not count: another business's ad lead and spend, a plain booking-page lead.
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('campsal1', 'salon', 'google', 'active', '{}', 1000, 1, 1)").run()
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, clicks, fetched_at) VALUES ('campsal1', 'salon', ?, 99900, 999, ?)").run(day, now)
  assert.equal((await call(bookLead, 'POST', { params: { customer: 'pools' }, body: { name: 'Organic', email: 'o@example.net', phone: '(843) 555-0142', need: 'Green pool', zip: '29403' } })).status, 201)

  // Switch off (production today): no advertising row at all.
  assert.equal((await call(overviewApi, 'GET', { cookie: c })).json.ads, null)
  env.ADS_ENABLED = 'true'
  // Master switch on but this business is not listed: still no advertising row.
  assert.equal((await call(overviewApi, 'GET', { cookie: c })).json.ads, null)
  env.ADS_BUSINESSES = 'pools'
  // No spend recorded yet: spend, clicks and costs are unavailable (null), never zero or estimated.
  assert.deepEqual((await call(overviewApi, 'GET', { cookie: c })).json.ads, { spendCents: null, clicks: null, leads: 3, booked: 2, showed: 1, costPerBookingCents: null, costPerShowUpCents: null, testAccount: false })
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, clicks, fetched_at) VALUES ('campweb1', 'pools', ?, 12000, 48, ?)").run(day, now)
  assert.deepEqual((await call(overviewApi, 'GET', { cookie: c })).json.ads, { spendCents: 12000, clicks: 48, leads: 3, booked: 2, showed: 1, costPerBookingCents: 6000, costPerShowUpCents: 12000, testAccount: false })
  // Figures from a Google Ads TEST account are flagged so the dashboard labels them as test data.
  db.sql.prepare("INSERT INTO ad_connections (customer, platform, account_id, extra, status, connected_at, updated_at) VALUES ('pools', 'google', '1234567890', '{\"testAccount\":true}', 'connected', 1, 1)").run()
  assert.equal((await call(overviewApi, 'GET', { cookie: c })).json.ads.testAccount, true)
  // Per-business flag: salon is not listed, so it has no advertising row even with the master switch on.
  const salonCookie = await cookieFor('owner@salon.example')
  assert.equal((await call(overviewApi, 'GET', { cookie: salonCookie })).json.ads, null)
  env.ADS_BUSINESSES = 'pools,salon'
  // Tenant isolation: the other business sees only its own spend and no leads.
  const salon = (await call(overviewApi, 'GET', { cookie: salonCookie })).json.ads
  assert.deepEqual([salon.spendCents, salon.leads, salon.costPerBookingCents], [99900, 0, null])
})

// Website Studio completion (2026-11-16): a multi-page AI-designed site on a connected domain: every page in the sitemap,
// social/SEO tags, its own favicon, and a working contact form that stores the lead with the business's other leads.
test('connected domain, multi-page AI site: sitemap lists every page; SEO tags; own favicon; contact form stores the lead and returns to its page', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  const site = {
    pages: [
      { slug: '', navLabel: 'Home', seoTitle: 'Pool care in Charleston', seoDescription: 'Weekly pool care.', sections: [{ type: 'hero', id: 'top', heading: 'Clear water', image: 'stock:pool-water', primaryCta: { label: 'Book', target: 'book' } }, { type: 'faq', id: 'qs', heading: 'Questions', items: [{ question: 'How do I book?', answer: 'Online in a minute.' }] }] },
      { slug: 'contact', navLabel: 'Contact', seoTitle: 'Contact | Pools', seoDescription: 'Send us a message.', sections: [{ type: 'contact', id: 'reach', heading: 'Contact us', form: 'quote' }] },
    ],
  }
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ site }), confirm: true } })).status, 200)
  const d = (await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })).json.domain
  dns.TXT['_getshowups.www.poolsco.com'] = [d.records[0].value]
  await checkDomain(env, 'www.poolsco.com', { probe: probeFail })
  dns.CNAME['www.poolsco.com'] = ['getshowups.pages.dev']
  provider.domains.get('www.poolsco.com').status = 'active'
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeOk }), 'connected')
  const run = async (url, init = {}) => {
    const res = await middleware.onRequest({ request: new Request(url, init), env, next: async () => new Response('static') })
    return { status: res.status, text: await res.text(), headers: res.headers }
  }
  const map = (await run('https://www.poolsco.com/sitemap.xml')).text
  assert.deepEqual([...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ['https://www.poolsco.com/', 'https://www.poolsco.com/contact'])
  assert.match(map, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/)

  const home = await run('https://www.poolsco.com/')
  assert.match(home.text, /<link rel="canonical" href="https:\/\/www\.poolsco\.com\/">/)
  assert.match(home.text, /<meta property="og:title" content="Pool care in Charleston"><meta property="og:description" content="Weekly pool care\."><meta property="og:url" content="https:\/\/www\.poolsco\.com\/"><meta property="og:image" content="https:\/\/www\.poolsco\.com\/site-stock\//)
  assert.match(home.text, /"@type":"FAQPage"/)
  const icon = home.text.match(/<link rel="icon" href="(\/site-icon\/pools\.svg\?c=[0-9a-f]{6})">/)
  assert.ok(icon, 'the business favicon, never GetShowUps’ icon')
  assert.equal((await run(`https://www.poolsco.com${icon[1].replace(/&amp;/g, '&')}`)).text, 'static', 'served on the business domain')
  const svg = await siteIcon.onRequestGet({ request: new Request(`https://www.poolsco.com${icon[1]}`), params: { id: 'pools.svg' } })
  assert.equal(svg.headers.get('Content-Type'), 'image/svg+xml')
  assert.match(await svg.text(), /^<svg [^>]+><rect [^>]+\/><text [^>]+>P<\/text><\/svg>$/)

  // Old-site addresses on a multi-page site: a redirect may target one of the site's own pages; one to a page that
  // doesn't exist is repaired to the home page (never blocks saving); common old addresses reach a page added later.
  const redirects = [{ from: '/get-a-quote', to: '/contact' }, { from: '/old-about', to: '/about' }, { from: '/request-service', to: 'book' }]
  const saved = (await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content({ site, redirects }), confirm: true } })).json
  assert.deepEqual(saved.website.draft.redirects, [{ from: '/get-a-quote', to: '/contact' }, { from: '/old-about', to: '/' }, { from: '/request-service', to: 'book' }])
  const loc = async (url) => (await run(url)).headers.get('Location')
  assert.equal(await loc('https://www.poolsco.com/get-a-quote'), 'https://www.poolsco.com/contact')
  assert.equal(await loc('https://www.poolsco.com/old-about'), 'https://www.poolsco.com/')
  assert.equal(await loc('https://www.poolsco.com/contact-us'), 'https://www.poolsco.com/contact', 'Squarespace/Wix-style /contact-us reaches the Contact page')
  assert.equal(await loc('https://www.poolsco.com/privacy-policy'), 'https://www.poolsco.com/', 'no Privacy page yet → home')
  assert.equal((await run('https://www.poolsco.com/contact')).status, 200, 'an old address that matches a page is simply that page')
  assert.deepEqual(validateContent(content({ redirects: [{ from: '/x', to: '/contact' }] }))[1].redirects, [{ from: '/x', to: '/' }], 'template content has no pages: page targets fall back to home')

  const page = await run('https://www.poolsco.com/contact')
  assert.match(page.text, /<link rel="canonical" href="https:\/\/www\.poolsco\.com\/contact">/)
  assert.match(page.text, /<form id="f-reach" class="lead-form" method="post" action="https:\/\/getshowups\.com\/api\/site-form\/pools"/)
  assert.match(page.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/getshowups\.com;/)

  // A visitor sends the quote form (the signed render time must be at least a few seconds old).
  const post = async (fields, t) => {
    const body = new URLSearchParams({ t: t ?? (await formToken(env, 'pools', Date.now() - 10_000)), page: 'contact', section: 'reach', kind: 'quote', website: '', ...fields })
    const res = await siteForm.onRequestPost({ request: new Request('https://getshowups.com/api/site-form/pools', { method: 'POST', body, headers: { 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 200)}` } }), env, params: { customer: 'pools' } })
    return { status: res.status, location: res.headers.get('Location') }
  }
  const leads = () => db.sql.prepare("SELECT customer, name, email, need FROM leads WHERE customer = 'pools' ORDER BY created_at").all()
  const before = leads().length
  const ok = await post({ name: 'Dana Shore', email: 'dana@example.net', phone: '(843) 555-0199', zip: '29401', need: 'Weekly cleaning for a small pool' })
  assert.deepEqual(ok, { status: 303, location: 'https://www.poolsco.com/contact?sent=1#f-reach' })
  assert.deepEqual({ ...leads().at(-1) }, { customer: 'pools', name: 'Dana Shore', email: 'dana@example.net', need: 'Quote request: Weekly cleaning for a small pool' })
  const sent = await run('https://www.poolsco.com/contact?sent=1')
  assert.match(sent.text, /Thanks, your quote request is on its way\./)
  assert.equal(sent.headers.get('Cache-Control'), 'no-store', 'a personal result page is not cached')
  // Errors return to the form with the reason; a bot (trap field) is told "sent" and nothing is stored; old/forged
  // render times are refused.
  assert.equal((await post({ name: 'Dana', email: 'not-an-email', phone: '8435550199', need: 'Hi there' })).location, 'https://www.poolsco.com/contact?form=invalid_email#f-reach')
  assert.match((await run('https://www.poolsco.com/contact?form=invalid_email')).text, /<p class="lf-error" role="alert">Please enter a valid email address\.<\/p>/)
  assert.equal((await post({ name: 'Bot', email: 'bot@example.net', phone: '8435550199', need: 'Buy now', website: 'http://spam.example' })).location, 'https://www.poolsco.com/contact?sent=1#f-reach')
  assert.equal((await post({ name: 'Late', email: 'late@example.net', phone: '8435550199', need: 'Hello' }, await formToken(env, 'pools', Date.now() - 2 * 86_400_000))).location, 'https://www.poolsco.com/contact?form=expired#f-reach')
  assert.equal((await post({ name: 'Fast', email: 'fast@example.net', phone: '8435550199', need: 'Hello' }, await formToken(env, 'pools', Date.now()))).location, 'https://www.poolsco.com/contact?form=expired#f-reach')
  assert.equal((await post({ name: 'Forged', email: 'f@example.net', phone: '8435550199', need: 'Hello' }, `${Date.now() - 10_000}.${'A'.repeat(43)}`)).location, 'https://www.poolsco.com/contact?form=expired#f-reach')
  assert.equal(leads().length, before + 1, 'only the real request was stored')
  // A token for one business doesn't work for another.
  assert.equal((await post({ name: 'Cross', email: 'x@example.net', phone: '8435550199', need: 'Hello' }, await formToken(env, 'salon', Date.now() - 10_000))).location, 'https://www.poolsco.com/contact?form=expired#f-reach')
})

test('domain propagation: a www change seen by one public resolver is "propagating", never "waiting"; connected with a split answer says so; the root domain is checked honestly', async () => {
  withProvider()
  const c = await cookieFor('owner@pools.example')
  const r = await call(domain, 'POST', { cookie: c, body: { action: 'connect', hostname: 'www.poolsco.com' } })
  dns.TXT['_getshowups.www.poolsco.com'] = [r.json.domain.records[0].value]
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  // The live PoolThru case (2026-11-22): Cloudflare's resolver still answers the old Squarespace record, Google answers ours.
  dns.CNAME['www.poolsco.com'] = ['ext-sq.squarespace.com']
  dns.google['CNAME:www.poolsco.com'] = ['getshowups.pages.dev']
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'securing')
  assert.equal(db.sql.prepare("SELECT detail FROM website_domains WHERE hostname = 'www.poolsco.com'").get().detail, 'propagating')
  dns.NS['poolsco.com'] = ['ns-cloud-e1.googledomains.com', 'ns-cloud-e2.googledomains.com']
  dns.A['poolsco.com'] = ['198.185.159.144']
  dns.apex['poolsco.com'] = { status: 301, location: 'https://www.poolsco.com{path}' } // forwards, keeps the path, drops the query
  let v = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([v.detail, v.provider, v.resolvers.cloudflare, v.resolvers.google, v.resolvers.cloudflareSees], ['propagating', { id: 'squarespace', name: 'Squarespace Domains' }, false, true, 'ext-sq.squarespace.com'])
  assert.deepEqual([v.apex.state, v.apex.permanent, v.apex.keepsPath, v.apex.keepsQuery, v.apex.canonical], ['forwards', true, true, false, 'https://www.poolsco.com'])
  // Hosting active + HTTPS answers while the split persists: connected, with the split named (visitors on the stale
  // resolver still see the old site), never "waiting for your DNS change".
  provider.domains.get('www.poolsco.com').status = 'active'
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeOk }), 'connected')
  assert.equal(db.sql.prepare("SELECT detail FROM website_domains WHERE hostname = 'www.poolsco.com'").get().detail, 'dns_inconsistent')
  // Both resolvers agree → clean connected on the next check; a later disagreement is reported again, the site stays live.
  dns.CNAME['www.poolsco.com'] = ['getshowups.pages.dev']
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeOk }), 'connected')
  assert.equal(db.sql.prepare("SELECT detail FROM website_domains WHERE hostname = 'www.poolsco.com'").get().detail, null)
  // Root-domain states: forwarding that keeps the query, http-only forwarding, pointing elsewhere, nothing, pointing at us.
  dns.apex['poolsco.com'] = { status: 301, location: 'https://www.poolsco.com{path}{query}' }
  assert.deepEqual((await apexStatus(env, 'www.poolsco.com')).keepsQuery, true)
  dns.apex['poolsco.com'] = { status: 302, location: 'https://www.poolsco.com/', https: false }
  let a = await apexStatus(env, 'www.poolsco.com')
  assert.deepEqual([a.state, a.permanent, a.keepsPath], ['forwards_http', false, false])
  dns.apex['poolsco.com'] = { status: 301, location: 'https://old-host.example.net/' }
  a = await apexStatus(env, 'www.poolsco.com')
  assert.deepEqual([a.state, a.target], ['other', 'https://old-host.example.net'])
  delete dns.apex['poolsco.com']
  assert.equal((await apexStatus(env, 'www.poolsco.com')).state, 'other')
  dns.A['poolsco.com'] = []
  assert.equal((await apexStatus(env, 'www.poolsco.com')).state, 'none')
  dns.CNAME['poolsco.com'] = ['getshowups.pages.dev']
  assert.equal((await apexStatus(env, 'www.poolsco.com')).state, 'points_here')
  assert.equal(await apexStatus(env, 'poolsco.com'), null, 'only for www hostnames')
  // Provider names from nameservers; unknown hosts are not guessed.
  assert.deepEqual([nsProviderOf(['dns1.registrar-servers.com']).id, nsProviderOf(['ns1.domaincontrol.com']).id, nsProviderOf(['ada.ns.cloudflare.com']).id, nsProviderOf(['ns1.unknown.example']).id, nsProviderOf([])], ['namecheap', 'godaddy', 'cloudflare', 'other', null])
  // The GET view never stores any of this and never leaks the provider token.
  const row = db.sql.prepare("SELECT * FROM website_domains WHERE hostname = 'www.poolsco.com'").get()
  assert.ok(!JSON.stringify(row).includes('poolsco.com{path}'))
  assert.ok(!JSON.stringify((await call(domain, 'GET', { cookie: c })).json).includes('cf_SECRET_TOKEN'))
})
