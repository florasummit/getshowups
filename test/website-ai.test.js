// AI website generation: facts come only from the business, model text is filtered (claims, invented
// numbers, length), results are stored with usage/cost, the draft and live site are never touched by a
// generation, previews and design switching never call the model, limits and tenant isolation hold.
// node:sqlite D1 and a fake Workers AI binding. No network.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { mergeGenerated, inventedNumbers, websiteFacts, generateWebsite, MONTHLY_GENERATIONS, WEBSITE_MODEL } from '../server/website-ai.js'
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
  headline: 'Clear, clean pools in Charleston',
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
  assert.deepEqual([r.generation.source, r.generation.content.headline], ['template', 'Weekly pool cleaning in Charleston'])
  env.AI = { run: async () => ({ response: 'not json at all' }) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'template')
  env.AI = { run: async () => Promise.reject(new Error('capacity')) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'template')
  env.AI = { run: async () => ({ response: JSON.stringify(GOOD) }) }
  assert.equal((await generateWebsite(env, customer)).generation.source, 'ai', 'string JSON responses are parsed')
})

test('limits: 10 generations per business per day (rate limit) and a monthly AI cap; edits never call the model', async () => {
  const c = await cookieFor('owner@pools.example')
  for (let i = 0; i < 10; i++) assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 200)
  assert.equal((await call(website, 'POST', { cookie: c, body: { action: 'generate' } })).status, 429)
  assert.equal((await call(website, 'POST', { cookie: await cookieFor('owner@salon.example'), body: { action: 'generate' } })).status, 200, 'per business')
  const before = calls
  const now = Date.now()
  for (let i = 0; i < MONTHLY_GENERATIONS; i++) db.sql.prepare("INSERT INTO website_generations (id, customer, content, source, created_at) VALUES (?, 'salon', '{}', 'ai', ?)").run(`old${i}`, now - 1000)
  const capped = await generateWebsite(env, { id: 'salon', name: 'salon Co', serviceZips: [] })
  assert.deepEqual([capped.generation.source, calls], ['template', before], 'over the monthly cap: template, no model call')
  const draft = (await call(website, 'GET', { cookie: c })).json.website.draft
  await call(website, 'POST', { cookie: c, body: { action: 'save', content: { ...draft, headline: 'Edited by hand' } } })
  await call(preview, 'GET', { cookie: c })
  assert.equal(calls, before, 'saving and previewing never call the model')
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
