// Legal pages in Website Studio (src/dashboard/site-templates.js + server/site-spec.js + renderer + middleware): the
// Studio's Privacy Policy and Terms of Service page types are legal pages (kept word for word, footer links, never
// in the navigation), owner-editable text only, kept through an AI redesign, served at /privacy and /terms on the
// GetShowUps address and on a connected domain, with old addresses forwarded; drafts stay private; one tenant's
// legal text never reaches another's site; a site without a terms page links to none.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pageTemplate, PAGE_TYPES, LEGAL_PAGES, termsSections } from '../src/dashboard/site-templates.js'
import { validateSpec, keepLegalPages, LIMITS } from '../server/site-spec.js'
import { renderV2 } from '../server/site-render-v2.js'

// A minimal site + business the way the Studio holds them (site-templates needs biz.services/photos/area; the spec
// validator needs the records context).
const biz = { name: 'Pools Co', services: [{ id: 'svc1', name: 'Weekly cleaning', description: '' }], photos: [], area: 'Charleston' }
const baseSite = () => ({ pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'hero', id: 'hero-1', heading: 'Pools Co', text: 'Pick a time online.' }] }], footer: { layout: 'simple' } })
const ctx = () => ({ services: [{ id: 'svc1', name: 'Weekly cleaning', price: 'From $150' }], towns: ['Charleston'], phone: '', claims: [], photoIds: [] })

test('page types: Privacy Policy and Terms of Service exist; their templates are legal pages with text sections only; the terms skeleton states no obligation, price or guarantee', () => {
  assert.deepEqual(PAGE_TYPES.map(([k]) => k).slice(-2), ['privacy', 'terms'])
  assert.deepEqual(Object.keys(LEGAL_PAGES), ['privacy', 'terms'])
  const site = baseSite()
  const privacy = pageTemplate('privacy', biz, site)
  const terms = pageTemplate('terms', biz, site)
  for (const p of [privacy, terms]) {
    assert.equal(p.legal, true)
    assert.equal(p.source.kind, 'starter')
    assert.ok(p.sections.length >= 1 && p.sections.every((s) => s.type === 'text'))
    assert.ok(p.seoTitle.includes('Pools Co'))
  }
  assert.deepEqual([privacy.slug, privacy.navLabel, terms.slug, terms.navLabel], ['privacy', 'Privacy', 'terms', 'Terms'])
  const text = terms.sections.map((s) => `${s.heading} ${s.body}`).join(' ')
  assert.doesNotMatch(text, /\$\d|guarantee|refund within|% off|licensed|insured/i)
  assert.ok(terms.sections.slice(1, -1).every((s) => /^\[.*\]$/.test(s.body)), 'every middle section is a bracketed prompt the owner replaces')
  assert.equal(termsSections(biz, (type, extra) => ({ type, id: 'x', ...extra })).length, 5)
})

test('validation: an owner-added legal page keeps its words (no marketing filter), is text-only, carries legal + source; AI output (facts context) can never mark a page legal; a redesign keeps legal pages', () => {
  const site = baseSite()
  site.pages.push(pageTemplate('privacy', biz, site), pageTemplate('terms', biz, site))
  // Owner save (no factsText): legal survives, including words the marketing filter would otherwise touch.
  site.pages[2].sections[1].body = 'Refunds within 30 days are free. We are licensed and insured. Reviews are welcome.'
  site.pages[2].sections.push({ type: 'cta', id: 'cta-9', heading: 'Book' }) // not allowed on a legal page
  const owner = validateSpec(site, ctx())
  const terms = owner.spec.pages.find((p) => p.slug === 'terms')
  assert.equal(terms.legal, true)
  assert.equal(terms.source.kind, 'starter')
  assert.equal(terms.sections[1].body, 'Refunds within 30 days are free. We are licensed and insured. Reviews are welcome.')
  assert.ok(terms.sections.every((s) => s.type === 'text'), 'the call-to-action was dropped, not rendered')
  assert.ok(owner.warnings.some((w) => w.reason === 'type'))
  // The same page from the AI designer (facts context) is not legal: the owner's text is never claimed by the model.
  const ai = validateSpec(site, { ...ctx(), factsText: 'FACTS' })
  assert.equal(ai.spec.pages.find((p) => p.slug === 'terms').legal, undefined)
  // A redesign (new spec without the legal pages) keeps them, word for word, within the page limit.
  const redesign = validateSpec(baseSite(), { ...ctx(), factsText: 'FACTS' }).spec
  const kept = keepLegalPages(redesign, owner.spec)
  assert.deepEqual(kept.pages.filter((p) => p.legal).map((p) => p.slug), ['privacy', 'terms'])
  assert.equal(kept.pages.find((p) => p.slug === 'terms').sections[1].body, terms.sections[1].body)
  assert.ok(kept.pages.length <= LIMITS.pages)
})

test('render: legal pages are footer links (Privacy, Terms), never navigation; /privacy and /terms resolve as pages with the page base of the address; a site without terms links no terms', () => {
  const site = baseSite()
  site.pages.push(pageTemplate('privacy', biz, site), pageTemplate('terms', biz, site))
  const spec = validateSpec(site, ctx()).spec
  const info = { name: 'Pools Co', legalName: 'Pools Co LLC', phone: '', services: [], towns: [], hours: null }
  const ours = renderV2(info, spec, { pageBase: '/p/pools', canonical: 'https://getshowups.com/p/pools', bookUrl: '/book/pools' })
  assert.match(ours, /href="\/p\/pools\/privacy"[^>]*>Privacy</)
  assert.match(ours, /href="\/p\/pools\/terms"[^>]*>Terms</)
  assert.doesNotMatch(ours.split('<footer')[0], /href="\/p\/pools\/terms"/, 'not in the navigation')
  const own = renderV2(info, spec, { pageBase: '', canonical: 'https://www.poolsco.com/', bookUrl: 'https://getshowups.com/book/pools', page: 'terms' })
  assert.match(own, /href="\/privacy"[^>]*>Privacy</)
  assert.match(own, /<h1[^>]*>Terms of Service<\/h1>/)
  assert.match(own, /legal-doc/)
  assert.doesNotMatch(own, /getshowups\.com\/privacy"/, 'the business has its own privacy page: no GetShowUps fallback')
  const noTerms = renderV2(info, validateSpec(baseSite(), ctx()).spec, { pageBase: '', canonical: 'https://www.poolsco.com/', bookUrl: '/book', privacyUrl: 'https://getshowups.com/privacy' })
  assert.doesNotMatch(noTerms, />Terms</, 'no dead terms link')
  assert.match(noTerms, /href="https:\/\/getshowups\.com\/privacy"/, 'GetShowUps’ own privacy page as the fallback')
})

// Served pages: the middleware on a connected domain and the /p address; drafts private; tenant isolation.
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
}
let env, db, kv
beforeEach(() => {
  db = d1()
  kv = new Map([['google:pools', 'record'], ['google:salon', 'record']]) // hosted sites need a connected calendar (businessForSite)
  env = { ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40) }
  const now = Date.now()
  for (const id of ['pools', 'salon']) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  }
})

test('serving: a published legal page answers at /terms on the GetShowUps address and on the connected domain (refresh = direct GET); /terms-of-service forwards; drafts are private; the other tenant never sees it', async () => {
  const { saveDraft, publish } = await import('../server/website.js')
  const site = baseSite()
  site.pages.push(pageTemplate('privacy', biz, site), pageTemplate('terms', biz, site))
  site.pages[2].sections[1].body = 'POOLS-ONLY-TERMS-TEXT'
  const spec = validateSpec(site, ctx()).spec
  const now = Date.now()
  const poolsContent = { headline: 'Pools Co', intro: 'x', services: [{ name: 'Weekly cleaning', price: 'From $150' }], area: 'Charleston', highlights: [], site: spec }
  await saveDraft(db, 'pools', poolsContent, now)
  const publicSite = await import('../functions/p/[customer].js')
  const publicPage = await import('../functions/p/[customer]/[page].js')
  const get = (mod, url, params) => mod.onRequestGet({ request: new Request(url), env, params, waitUntil: () => {} })
  // Draft only: nothing public.
  assert.equal((await get(publicPage, 'https://getshowups.com/p/pools/terms', { customer: 'pools', page: 'terms' })).status, 404)
  await publish(db, 'pools', poolsContent, now + 1)
  const r = await get(publicPage, 'https://getshowups.com/p/pools/terms', { customer: 'pools', page: 'terms' })
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /POOLS-ONLY-TERMS-TEXT/)
  assert.match(html, /href="\/p\/pools\/privacy"/)
  // Another business's site never carries this text.
  const salonContent = { headline: 'Salon Co', intro: 'x', services: [{ name: 'Cut', price: '$40' }], area: 'Charleston', highlights: [], site: validateSpec(baseSite(), ctx()).spec }
  await saveDraft(db, 'salon', salonContent, now)
  await publish(db, 'salon', salonContent, now + 2)
  const other = await (await get(publicSite, 'https://getshowups.com/p/salon', { customer: 'salon' })).text()
  assert.doesNotMatch(other, /POOLS-ONLY-TERMS-TEXT|\/terms"/)
  // Connected domain: the middleware serves /terms directly and forwards the old /terms-of-service address.
  db.sql.prepare("INSERT INTO website_domains (customer, hostname, verify_token, status, verified_at, attached_at, connected_at, created_at, updated_at) VALUES ('pools', 'www.poolsco.com', 'tok_0123456789abcdef', 'connected', ?, ?, ?, ?, ?)").run(now, now, now, now, now)
  const mw = await import('../functions/_middleware.js')
  const viaHost = (path) => mw.onRequest({ request: new Request(`https://www.poolsco.com${path}`), env, next: async () => new Response('next', { status: 200 }), waitUntil: () => {} })
  const t = await viaHost('/terms')
  assert.equal(t.status, 200)
  assert.match(await t.text(), /POOLS-ONLY-TERMS-TEXT/)
  const old = await viaHost('/terms-of-service')
  assert.equal(old.status, 301)
  assert.equal(old.headers.get('location'), 'https://www.poolsco.com/terms')
  const oldPrivacy = await viaHost('/privacy-policy')
  assert.equal(oldPrivacy.headers.get('location'), 'https://www.poolsco.com/privacy')
})
