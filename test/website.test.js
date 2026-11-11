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
import { normalizeHostname, checkDomain, checkDueDomains } from '../server/domains.js'
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
import * as billing from '../functions/api/dashboard/billing.js'
import * as outcome from '../functions/api/dashboard/outcome.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
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
  dns = { TXT: {}, CNAME: {} }
  provider = { domains: new Map(), calls: [] }
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
  origFetch = globalThis.fetch
  // Mocked DNS-over-HTTPS, hosting-provider API and HTTPS site probe.
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    if (u.hostname === 'cloudflare-dns.com') {
      const type = u.searchParams.get('type')
      const values = dns[type][u.searchParams.get('name')] || []
      return new Response(JSON.stringify({ Status: 0, Answer: values.map((data) => ({ type: type === 'TXT' ? 16 : 5, data: type === 'TXT' ? `"${data}"` : `${data}.` })) }))
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
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 1 } })).status, 200)
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('Version one'))
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.headline, 'Version one', 'editing continues from the restored version')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'restore', version: 9 } })).status, 404)
  // Another business can't restore (or see) these versions.
  assert.equal((await call(website, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'restore', version: 1 } })).status, 404)
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
  const pointing = (await call(domain, 'GET', { cookie: c })).json.domain
  assert.deepEqual([pointing.step, pointing.records[0]], ['point', { type: 'CNAME', name: 'www.poolsco.com', value: 'getshowups.pages.dev' }])
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
  assert.deepEqual([ok.domain.status, ok.domain.url], ['connected', 'https://www.poolsco.com'])
  assert.ok(!JSON.stringify(ok).includes('cf_SECRET_TOKEN'))
  // The site's canonical address becomes the domain.
  await call(website, 'POST', { cookie: c, body: { action: 'publish', content: content(), confirm: true } })
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('<link rel="canonical" href="https://www.poolsco.com/">'))
  // DNS later moved away: needs attention (never silently "connected").
  dns.CNAME['www.poolsco.com'] = ['elsewhere.example']
  assert.equal(await checkDomain(env, 'www.poolsco.com', { probe: probeFail }), 'needs_attention')
  assert.equal((await call(domain, 'GET', { cookie: c })).json.domain.detail, 'dns_changed')
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
