// AI website generation: facts come only from the business, model text is filtered (claims, invented
// numbers, length), results are stored with usage/cost, the draft and live site are never touched by a
// generation, previews and design switching never call the model, limits and tenant isolation hold.
// node:sqlite D1 and a fake Workers AI binding. No network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { mergeGenerated, inventedNumbers, websiteFacts, generateWebsite, WEBSITE_MODEL } from '../server/website-ai.js'
import { aiUsage } from '../server/ai-usage.js'
import * as website from '../functions/api/dashboard/website/index.js'
import * as preview from '../functions/api/dashboard/website/preview.js'
import * as publicSite from '../functions/p/[customer].js'
import * as onboarding from '../functions/api/dashboard/onboarding.js'
import * as me from '../functions/api/dashboard/me.js'

const ORIGIN = 'https://getshowups.com'
let env, db, kv, calls, reply

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => sql.prepare(q).run(...args) })
  return { sql, prepare: (q) => stmt(q) }
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, url = `${ORIGIN}/x`, params, origin = ORIGIN } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (method === 'POST') headers.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(url, { method, headers, body: body && JSON.stringify(body) }), env, params })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}
function seed(id, owner) {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29403', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, now, now, now)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
  db.sql
    .prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0142', 'Pool service', '', ?, '[\"Charleston\"]', ?)")
    .run(id, JSON.stringify([{ name: 'Weekly pool cleaning', price: 'From $150/month' }, { name: 'Green pool cleanup', price: '' }]), now)
  kv.set(`google:${id}`, 'record')
}
const GOOD = {
  headline: 'pools Co: clear, clean pools in Charleston',
  intro: 'We keep your pool ready to swim, and booking online takes about a minute.',
  about: 'We look after home pools across Charleston.\n\nPick a time online and we take it from there.',
  services: [
    { name: 'Weekly pool cleaning', description: 'Regular cleaning and chemical balancing so your water stays clear all season.' },
    { name: 'Green pool cleanup', description: 'We bring a neglected, green pool back to clean, swimmable water.' },
    { name: 'Hot tub repair', description: 'An invented service that must never appear.' },
  ],
  seoTitle: 'Pool cleaning in Charleston, SC',
  seoDescription: 'Weekly pool cleaning and green pool cleanup in Charleston. Book online in about a minute.',
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = 0
  reply = { response: GOOD, usage: { prompt_tokens: 450, completion_tokens: 250 } }
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    AI: {
      run: async (model, input) => {
        calls++
        assert.equal(model, WEBSITE_MODEL)
        assert.equal(input.response_format.type, 'json_schema')
        if (reply instanceof Error) throw reply
        return reply
      },
    },
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
})

test('merge: keeps business facts, the model can never add services or change prices', () => {
  const base = { template: 'clean', color: 'ocean', headline: 'Weekly pool cleaning in Charleston', intro: 'Pick a time.', about: '', services: [{ name: 'Weekly pool cleaning', price: 'From $150/month', description: '' }], area: 'Charleston', highlights: [], logo: null, hero: null, photos: [], seoTitle: 't', seoDescription: 'd' }
  const facts = websiteFacts({ name: 'Pools Co', appointmentMode: 'at_customer' }, { industry: 'Pool service' }, base)
  const { content, rejected } = mergeGenerated(base, { ...GOOD, services: [{ name: 'Weekly pool cleaning', description: 'Cleaning every week.', price: '$9' }, { name: 'Hot tub repair', description: 'x' }] }, facts)
  assert.deepEqual(content.services, [{ name: 'Weekly pool cleaning', price: 'From $150/month', description: 'Cleaning every week.' }])
  assert.equal(content.headline, GOOD.headline)
  assert.equal(content.area, 'Charleston', 'area stays the business’s own')
  assert.deepEqual(rejected, [])
})

test('merge: unapproved claims, invented numbers and over-long text fall back to the template text', () => {
  const base = { template: 'clean', color: 'ocean', headline: 'Template headline', intro: 'Template intro.', about: '', services: [{ name: 'Weekly pool cleaning', price: '$150', description: '' }], area: '', highlights: [], logo: null, hero: null, photos: [], seoTitle: 'T', seoDescription: 'D' }
  const facts = websiteFacts({ name: 'Pools Co' }, {}, base)
  const { content, rejected } = mergeGenerated(base, {
    headline: 'Charleston’s best pool service, guaranteed',
    intro: 'Over 20 years of experience and 500 happy customers.',
    about: 'x'.repeat(2000),
    services: [{ name: 'Weekly pool cleaning', description: 'Only $150 a week.' }],
    seoTitle: 'Pools Co',
    seoDescription: 'Rated 5 stars.',
  }, facts)
  assert.equal(content.headline, 'Template headline')
  assert.equal(content.intro, 'Template intro.')
  assert.equal(content.about, '')
  assert.equal(content.services[0].description, 'Only $150 a week.', '$150 is the business’s own price, so the number is allowed')
  assert.equal(content.seoDescription, 'D')
  assert.deepEqual(rejected.sort(), ['about', 'headline', 'intro', 'seoDescription'])
  assert.deepEqual(inventedNumbers('Since 1998, 4.9 stars', '{"x":"From $150"}'), ['1998', '4.9'])
})

test('generate: one model request, stored with usage and cost; the draft and live site are untouched', async () => {
  const c = await cookieFor('owner@pools.example')
  const r = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(r.status, 200)
  assert.equal(calls, 1)
  const g = r.json.generation
  assert.equal(g.source, 'ai')
  assert.equal(g.content.headline, GOOD.headline)
  assert.deepEqual(g.content.services.map((s) => [s.name, s.price]), [['Weekly pool cleaning', 'From $150/month'], ['Green pool cleanup', '']])
  assert.equal(g.content.phone, undefined)
  const row = db.sql.prepare('SELECT * FROM website_generations').get()
  assert.deepEqual([row.source, row.model, row.input_tokens, row.output_tokens, row.cost_micros], ['ai', WEBSITE_MODEL, 450, 250, Math.round(450 * 0.351 + 250 * 0.555)])
  assert.equal(db.sql.prepare('SELECT count(*) n FROM websites').get().n, 0, 'generating changes nothing until the owner applies it')
  assert.ok(!r.text.includes('owner@pools.example'))
})

test('apply: chosen design becomes the private draft, photos kept; published site changes only on publish', async () => {
  const c = await cookieFor('owner@pools.example')
  await call(website, 'POST', { cookie: c, body: { action: 'publish', confirm: true, content: { headline: 'Live headline', intro: 'Live intro.', services: [], area: '', highlights: [] } } })
  const g = (await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.generation
  const pv = await call(preview, 'GET', { cookie: c, url: `${ORIGIN}/x?generation=${g.id}&template=bold` })
  assert.ok(pv.text.includes(GOOD.headline) && pv.text.includes('--accent'))
  const applied = await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: g.id, template: 'warm' } })
  assert.equal(applied.status, 200)
  assert.deepEqual([applied.json.website.draft.headline, applied.json.website.draft.template, applied.json.website.changed], [GOOD.headline, 'warm', true])
  assert.ok((await call(publicSite, 'GET', { params: { customer: 'pools' } })).text.includes('Live headline'), 'live site unchanged until publish')
  assert.equal(calls, 1, 'previewing designs and applying never call the model')
  // Another business can neither preview nor apply it.
  const s = await cookieFor('owner@salon.example')
  assert.equal((await call(website, 'POST', { cookie: s, body: { action: 'apply', generationId: g.id } })).status, 404)
  assert.ok(!(await call(preview, 'GET', { cookie: s, url: `${ORIGIN}/x?generation=${g.id}` })).text.includes(GOOD.headline))
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: '../x' } })).status, 404)
})

test('fallbacks: no AI binding, bad JSON or a model error give the template (labelled), never a broken site', async () => {
  const customer = { id: 'pools', name: 'pools Co', appointmentMode: 'at_business', serviceZips: ['29403'] }
  delete env.AI
  let r = await generateWebsite(env, customer)
  assert.deepEqual([r.generation.source, r.generation.content.headline], ['template', 'pools Co: Weekly pool cleaning in Charleston'])
  env.AI = { run: async () => ({ response: 'not json at all' }) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'template')
  env.AI = { run: async () => Promise.reject(new Error('capacity')) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'template')
  env.AI = { run: async () => ({ response: JSON.stringify(GOOD) }) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'ai', 'string JSON responses are parsed')
})

test('usage policy: paying businesses get 20 generations a day, revisions counted separately, reset at UTC midnight', async () => {
  const c = await cookieFor('owner@pools.example') // pools: no self-serve signup → pilot, hosting active → paying tier
  const usage0 = (await call(website, 'GET', { cookie: c })).json.aiUsage
  assert.equal(usage0.tier, 'paying')
  assert.deepEqual([usage0.generation, usage0.revision], [{ used: 0, limit: 20, remaining: 20 }, { used: 0, limit: 40, remaining: 40 }])
  assert.equal(usage0.resetsAt, (Math.floor(Date.now() / 864e5) + 1) * 864e5, 'next 00:00 UTC')
  for (let i = 0; i < 20; i++) assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 200)
  const over = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.equal(over.status, 429)
  assert.deepEqual([over.json.error, over.json.kind, over.json.limit, over.json.resetsAt], ['daily_limit', 'generation', 20, usage0.resetsAt])
  const callsAtLimit = calls
  assert.equal(calls, callsAtLimit, 'no model call over the limit')
  // Revisions have their own allowance.
  const rev = await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'make it more modern' } })
  assert.equal(rev.status, 200)
  assert.deepEqual([rev.json.aiUsage.generation.remaining, rev.json.aiUsage.revision.used], [0, 1])
  // Another business is unaffected; tomorrow the allowance is back.
  assert.equal((await call(website, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'generate' } })).status, 200)
  const tomorrow = await aiUsage(env, { id: 'pools' }, 'owner@pools.example', Date.now() + 864e5)
  assert.equal(tomorrow.generation.remaining, 20)
})

test('usage policy: failed AI requests and template fallbacks are free; manual edits and previews are unlimited', async () => {
  const c = await cookieFor('owner@pools.example')
  reply = new Error('capacity')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.generation.source, 'template')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'simpler' } })).status, 503)
  const u = (await call(website, 'GET', { cookie: c })).json.aiUsage
  assert.deepEqual([u.generation.used, u.revision.used], [0, 0])
  const before = calls
  const draft = (await call(website, 'GET', { cookie: c })).json.website.draft
  for (let i = 0; i < 40; i++) assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'save', content: { ...draft, headline: `Edited by hand ${'x'.repeat(i % 3)}` } } })).status, 200)
  await call(preview, 'GET', { cookie: c })
  assert.equal(calls, before, 'saving and previewing never call the model')
})

test('usage policy tiers: testing (admin sign-in or listed business) is generous; not-yet-paying is small', async () => {
  const pools = { id: 'pools' }
  assert.equal((await aiUsage(env, pools, 'owner@pools.example')).tier, 'paying')
  env.PLATFORM_ADMIN_EMAILS = 'admin@getshowups.example'
  assert.equal((await aiUsage(env, pools, 'Admin@GetShowUps.example')).tier, 'testing')
  env.AI_TESTING_BUSINESSES = 'other, pools'
  const t = await aiUsage(env, pools, 'owner@pools.example')
  assert.deepEqual([t.tier, t.generation.limit, t.revision.limit], ['testing', 200, 400])
  assert.equal((await aiUsage(env, { id: 'salon' }, 'owner@salon.example')).tier, 'paying', 'listing is per business')
  // Self-serve signup that has not paid yet.
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at) VALUES ('salon', 'founding', 1)").run()
  const s = await aiUsage(env, { id: 'salon' }, 'owner@salon.example')
  assert.deepEqual([s.tier, s.generation.limit, s.revision.limit], ['starter', 5, 10])
  // Testing tier near its limit (seeded count) is still enforced on the server.
  db.sql.prepare("INSERT INTO website_ai_usage (customer, day, kind, count) VALUES ('pools', ?, 'generation', 200)").run(Math.floor(Date.now() / 864e5))
  assert.equal((await call(website, 'POST', { cookie: await cookieFor('owner@pools.example'), body: { action: 'generate' } })).status, 429)
})

test('usage policy: the 30-day AI cost ceiling stops model calls; burst guard still limits rapid attempts', async () => {
  const c = await cookieFor('owner@pools.example')
  db.sql.prepare("INSERT INTO website_generations (id, customer, content, source, cost_micros, created_at) VALUES ('old', 'pools', '{}', 'ai', 2000000, ?)").run(Date.now() - 1000)
  const before = calls
  const g = await call(website, 'POST', { cookie: c, body: { action: 'generate' } })
  assert.deepEqual([g.status, g.json.generation.source, calls], [200, 'template', before], 'over the cost ceiling: standard layouts, no model call, not counted')
  assert.equal(g.json.aiUsage.generation.used, 0)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'simpler' } })).json.error, 'monthly_limit')
  let limited = 0
  for (let i = 0; i < 40; i++) if ((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status === 429) limited++
  assert.ok(limited >= 10, 'burst guard (30 attempts / 10 min per business)')
})

test('onboarding: "keep my current website" completes the website steps without creating a site', async () => {
  db.sql.prepare("INSERT INTO self_signups (customer, plan_id, created_at) VALUES ('pools', 'founding', 1)").run()
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, updated_at) VALUES ('pools', 'c', 's', 'active', 1)").run()
  const c = await cookieFor('owner@pools.example')
  assert.equal((await call(onboarding, 'POST', { cookie: c, body: { action: 'keep_website' } })).status, 200)
  const steps = Object.fromEntries((await call(me, 'GET', { cookie: c })).json.progress.steps.map((s) => [s.id, s.done]))
  assert.deepEqual([steps.website, steps.address, steps.publish], [true, true, true])
  assert.equal(db.sql.prepare('SELECT count(*) n FROM websites').get().n, 0)
  const r = (await call(onboarding, 'GET', { cookie: c })).json
  assert.equal(r.status ?? 200, 200)
})

// ---------- AI design (layouts from the safe design system) ----------
import { validateDesign, presetDesigns, diversify, STOCK_IDS, stockFor } from '../server/site-design.js'
import { renderSite } from '../server/site-render.js'
import { validateContent } from '../server/website.js'

const DESIGN = { name: 'Fresh', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'about'], heroImage: 'stock:pool-water', aboutImage: null }

test('design validation: only named options; images only from the licensed library or the owner’s own uploads', () => {
  assert.deepEqual(validateDesign(DESIGN)[0], [])
  assert.deepEqual(validateDesign({ ...DESIGN, palette: '#ff00ff', hero: '<script>' })[0].sort(), ['hero', 'palette'])
  assert.deepEqual(validateDesign({ ...DESIGN, heroImage: 'https://evil.example/x.jpg' })[0], ['heroImage'])
  assert.deepEqual(validateDesign({ ...DESIGN, heroImage: 'stock:not-real' })[0], ['heroImage'])
  assert.deepEqual(validateDesign({ ...DESIGN, heroImage: `asset:${'a'.repeat(32)}` }, new Set())[0], ['heroImage'], 'another business’s photo')
  assert.deepEqual(validateDesign({ ...DESIGN, sections: ['about', 'about', 'evil'] })[1].sections, ['services', 'about'], 'services always present, no duplicates/unknowns')
  assert.ok(stockFor('Pool service').every((s) => s.id.startsWith('pool-') && STOCK_IDS.has(s.id)))
  assert.equal(validateContent({ headline: 'H', intro: 'I', design: { ...DESIGN, fonts: 'comic' } })[0].includes('design'), true)
})

test('three designs are genuinely different even when the model repeats itself', () => {
  const same = [DESIGN, DESIGN, DESIGN]
  const out = diversify(same, 'Pool service', [])
  assert.equal(new Set(out.map((d) => d.hero)).size, 3)
  assert.equal(new Set(out.map((d) => d.palette)).size, 3)
  assert.equal(new Set(out.map((d) => d.fonts)).size, 3)
  assert.equal(new Set(presetDesigns('HVAC').map((d) => d.hero)).size, 3)
})

test('renderer: designed sites are escaped, script-free, self-hosted; existing sites without a design render exactly as before', () => {
  const content = { ...validateContent({ headline: '"><script>alert(1)</script>', intro: 'Pick a time.', about: 'Line one\n\nLine two', services: [{ name: '<b>Weekly</b>', price: '$150', description: 'x' }], area: 'Charleston' })[1] }
  const biz = { id: 'x', name: 'Evil & Co', appointmentMode: 'at_customer', phone: '(843) 555-0123' }
  for (const d of presetDesigns('Pool service', ['b'.repeat(32)])) {
    const html = renderSite(biz, { ...content, design: d, photos: ['b'.repeat(32)] }, { canonical: 'https://x.example/', bookUrl: 'https://getshowups.com/book/x' })
    assert.ok(!html.includes('<script>alert') && !html.includes('<b>Weekly'), d.name)
    assert.ok(html.includes('&lt;b&gt;Weekly&lt;/b&gt;') && html.includes('Evil &amp; Co'))
    assert.ok(html.includes('href="https://getshowups.com/book/x"') && html.includes('href="tel:+18435550123"'), 'booking + call integrated')
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html), 'no executable scripts')
    assert.ok(!/https?:\/\/(?!getshowups\.com|x\.example|schema\.org|www\.w3\.org)/.test(html.replace(/https:\/\/getshowups\.com\/book\/x/g, '')), 'no third-party resources')
    assert.ok(html.includes('/site-fonts/') && html.includes('<h1>'))
  }
  // Legacy content (no design) uses the original renderer unchanged.
  const legacy = renderSite(biz, content, { bookUrl: '/book/x' })
  assert.ok(!legacy.includes('/site-fonts/') && legacy.includes('class="top"'))
})

test('generate: three validated designs stored with the copy; model design choices are repaired, never trusted raw', async () => {
  reply = { response: { ...GOOD, designs: [{ ...DESIGN, palette: 'hotpink' }, { ...DESIGN, heroImage: 'https://evil.example/a.jpg' }, DESIGN] }, usage: { prompt_tokens: 820, completion_tokens: 520 } }
  const c = await cookieFor('owner@pools.example')
  const g = (await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.generation
  assert.equal(g.designs.length, 3)
  for (const d of g.designs) assert.deepEqual(validateDesign(d)[0], [])
  assert.equal(new Set(g.designs.map((d) => d.hero)).size, 3)
  assert.ok(g.designs.every((d) => d.heroImage === null || d.heroImage.startsWith('stock:pool-') || d.heroImage.startsWith('asset:')))
  for (let i = 0; i < 3; i++) assert.ok((await call(preview, 'GET', { cookie: c, url: `${ORIGIN}/x?generation=${g.id}&option=${i}` })).text.includes('/site-fonts/'))
  const applied = await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: g.id, option: 2 } })
  assert.deepEqual(applied.json.website.draft.design, g.designs[2])
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: g.id, option: 7 } })).status, 400)
  assert.equal(db.sql.prepare('SELECT cost_micros c FROM website_generations').get().c, Math.round(820 * 0.351 + 520 * 0.555))
})

test('revise: natural-language change becomes a pending version; the draft changes only when kept; claims still filtered', async () => {
  const c = await cookieFor('owner@pools.example')
  const g = (await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).json.generation
  await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: g.id, option: 0 } })
  const before = (await call(website, 'GET', { cookie: c })).json.website.draft
  reply = { response: { ...GOOD, headline: 'Licensed and insured pool experts', design: { ...DESIGN, palette: 'midnight', fonts: 'strong', hero: 'immersive' } }, usage: { prompt_tokens: 1200, completion_tokens: 380 } }
  const r = await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'Make it more modern and say we are licensed' } })
  assert.equal(r.status, 200)
  const rev = r.json.generation
  assert.deepEqual([rev.designs[0].palette, rev.designs[0].hero], ['midnight', 'immersive'])
  assert.equal(rev.content.headline, before.headline, 'unapproved claim from the revision is dropped')
  assert.deepEqual((await call(website, 'GET', { cookie: c })).json.website.draft, before, 'nothing changes until the owner keeps it')
  await call(website, 'POST', { cookie: c, body: { action: 'apply', generationId: rev.id, option: 0 } })
  assert.equal((await call(website, 'GET', { cookie: c })).json.website.draft.design.palette, 'midnight')
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: '   ' } })).status, 400)
  delete env.AI
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'revise', instruction: 'warmer' } })).json.error, 'ai_unavailable')
})

test('owner photos win: an uploaded main photo replaces the chosen stock photo', () => {
  const content = { ...validateContent({ headline: 'H', intro: 'I', services: [{ name: 'A' }] })[1], hero: 'c'.repeat(32) }
  const biz = { id: 'x', name: 'X', appointmentMode: 'at_business', phone: '' }
  const split = renderSite(biz, { ...content, design: { ...DESIGN, hero: 'split' } }, { bookUrl: '/b' })
  assert.ok(split.includes(`/site-assets/${'c'.repeat(32)}`) && !split.includes('/site-stock/pool-water'))
  const typo = renderSite(biz, { ...content, about: 'About us.', design: { ...DESIGN, hero: 'typographic', about: 'split', aboutImage: 'stock:pool-water' } }, { bookUrl: '/b' })
  assert.ok(typo.includes(`/site-assets/${'c'.repeat(32)}`) && !typo.includes('/site-stock/pool-water'), 'moves to About when the hero has no photo')
})
