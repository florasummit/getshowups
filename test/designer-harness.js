// Shared harness for the AI designer tests (test/designer-intents.test.js, test/designer-security.test.js): the same
// SQLite-backed fake D1, seeded businesses, session cookies, route caller and mocked Claude/OpenAI as
// test/ai-designer.test.js. No network, no real keys.
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { toCompact } from '../server/ai-designer.js'
import { sealKey } from '../server/ai-credentials.js'

export const ORIGIN = 'https://getshowups.com'
export const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
export const DAY = 864e5
export const CLAUDE_KEY = 'sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ'
export const SERVICES = [{ name: 'One Time Service', price: '$150+' }, { name: 'Weekly Pool Care', price: '$280+' }, { name: 'Pool Winterization', price: '$350+' }]
export const LOGO_ID = 'c'.repeat(32)
export const PHOTO_ID = 'a'.repeat(32)
export const PHOTO_2 = 'b'.repeat(32)
export const OTHER_PHOTO = 'd'.repeat(32) // owned by the salon, never by pools

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

export const DESIGN = (extra = {}) => ({
  name: 'Lowcountry Blue',
  direction: 'Quiet coastal editorial: grotesk over water, sand and teal',
  theme: { colors: { bg: '#f4f8f7', surface: '#e3eeec', ink: '#10292b', muted: '#4b6466', accent: '#0f5c63', onAccent: '#ffffff', line: '#cfdedb' }, headingFont: 'syne', bodyFont: 'manrope', headingWeight: 700, headingCase: 'none', headingTracking: -0.03, baseSize: 17, scale: 1.3, lineHeight: 1.6, radius: 18, density: 'airy', maxWidth: 1240, buttons: 'pill', motion: 'subtle' },
  nav: { layout: 'left', sticky: true, showBook: true },
  footer: { layout: 'statement', text: 'Clear water, all season.' },
  pages: [
    { slug: '', navLabel: 'Home', seoTitle: 'Pool care in Charleston', seoDescription: 'Weekly pool care across Charleston.', sections: [
      { type: 'hero', id: 'top', layout: 'overlay', image: `asset:${PHOTO_ID}`, images: [`asset:${PHOTO_2}`], heading: 'Clear water, every week.', text: 'Pool care for Charleston homes.', primaryCta: { label: 'Book a visit', target: 'book' }, secondaryCta: { label: 'See services', target: 'page:services' }, height: 'tall', overlay: 0.4 },
      { type: 'imageText', id: 'about', heading: 'About us', body: 'A small team that looks after pools across Charleston.', image: `asset:${PHOTO_2}`, imageSide: 'left' },
      { type: 'features', id: 'why', background: 'ink', heading: 'Why us', items: [{ icon: 'water', title: 'Balanced water', text: 'Tested at every visit.' }, { icon: 'calendar', title: 'Book online', text: 'Pick a time that suits you.' }] },
      { type: 'text', id: 'promise', heading: 'Our promise', body: 'We turn up when we say we will.' },
      { type: 'area', id: 'area', heading: 'Where we work' },
    ] },
    { slug: 'services', navLabel: 'Services', sections: [{ type: 'services', id: 'services', heading: 'Services', layout: 'rows', items: [{ serviceIndex: 1, text: 'Weekly skimming, brushing and balancing.' }] }, { type: 'cta', id: 'book', heading: 'Ready for clear water?', image: `asset:${PHOTO_ID}`, cta: { label: 'Book now', target: 'book' } }, { type: 'contact', id: 'contact', heading: 'Talk to us', showPhone: true }] },
  ],
  ...extra,
})

// A server-sent-events body like the Messages API stream.
function sse(text, { stop = 'end_turn' } = {}) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const chunks = text.match(/[\s\S]{1,500}/g) || []
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4200, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...chunks.map((c) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 6100 } }),
    ev('message_stop', {}),
  ].join('')
}

// → the harness: { env, db, kv, requests, mock (mock.nextDesign = the model's next answer), helpers…, restore() }.
export function setup() {
  const db = d1()
  const kv = new Map()
  const requests = []
  const mock = { nextDesign: { reply: 'A calm, coastal design with a clear path to booking.', site: DESIGN() } }
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40), WEBSITE_STUDIO_ENABLED: 'true', WEBSITE_STUDIO_PUBLISH: 'true', ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } }
  const now = Date.now()
  const seed = (id, owner) => {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Pools LLC`, now, now, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, now)
    db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0100', 'Pool service', '', ?, '[\"Charleston\",\"Mount Pleasant\"]', ?)").run(id, JSON.stringify(SERVICES), now)
    kv.set(`google:${id}`, 'record')
  }
  seed('pools', 'owner@pools.example')
  seed('salon', 'owner@salon.example')
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, updated_at) VALUES ('pools', 'c', 's', 'active', 1)").run()
  const addAsset = (customer, id) => db.sql.prepare("INSERT OR IGNORE INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?, ?, 'image/jpeg', x'ffd8ff', 3, 1)").run(id, customer)
  addAsset('pools', LOGO_ID)
  addAsset('pools', PHOTO_ID)
  addAsset('pools', PHOTO_2)
  addAsset('salon', OTHER_PHOTO)
  const classic = () => ({ template: 'clean', color: 'ocean', headline: 'Pool care in Charleston', intro: 'Weekly pool care.', about: 'We look after pools.', services: SERVICES.map((s) => ({ ...s, description: '' })), area: '', highlights: [], logo: LOGO_ID, hero: PHOTO_ID, photos: [PHOTO_2], seoTitle: '', seoDescription: '' })
  const setDraft = (customer, content) => {
    db.sql.prepare('DELETE FROM websites WHERE customer = ?').run(customer)
    db.sql.prepare('INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, ?, NULL, NULL, 1)').run(customer, JSON.stringify(content))
    // As saveDraft would: a logo that is set is remembered as "was the logo" (server/website.js rememberLogoStatement).
    if (typeof content.logo === 'string') db.sql.prepare("INSERT INTO website_generations (id, customer, content, source, model, cost_micros, created_at) SELECT ?, ?, ?, 'template', NULL, 0, 1 WHERE NOT EXISTS (SELECT 1 FROM website_generations WHERE customer = ? AND json_extract(content, '$.kind') = 'logo' AND json_extract(content, '$.asset') = ?)").run([...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join(''), customer, JSON.stringify({ kind: 'logo', asset: content.logo }), customer, content.logo)
  }
  setDraft('pools', classic())
  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const u = new URL(req.url)
    if (u.hostname === 'api.anthropic.com' && u.pathname === '/v1/messages') {
      const body = await req.clone().json()
      requests.push({ body, auth: req.headers.get('authorization') || req.headers.get('x-api-key') })
      const nd = Array.isArray(mock.nextDesign) ? (mock.nextDesign.length > 1 ? mock.nextDesign.shift() : mock.nextDesign[0]) : mock.nextDesign
      if (nd instanceof Error) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad' } }, { status: 401 })
      return new Response(sse(JSON.stringify({ ...nd, site: nd.rawSite || toCompact(nd.site) })), { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  const cookieFor = async (email) => {
    const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
    db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
    return `__Host-gsu_session=${token}`
  }
  const call = async (mod, method, { cookie, body, origin = ORIGIN, url = `${ORIGIN}/x`, params } = {}) => {
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
  const addKey = async (customer, model = 'claude-opus-5-5') => {
    const t = Date.now()
    db.sql
      .prepare("INSERT INTO ai_credentials (customer, provider, sealed, hint, model, catalog, catalog_at, monthly_budget_cents, status, validated_at, created_at, updated_at) VALUES (?, 'anthropic', ?, 'WXYZ', ?, ?, ?, 1000, 'ok', ?, ?, ?)")
      .run(customer, await sealKey(env, customer, 'anthropic', CLAUDE_KEY), model, JSON.stringify([{ id: model, label: model, compatible: true }]), t, t, t, t)
  }
  const events = (text) => text.trim().split('\n').map((l) => JSON.parse(l))
  const storedDraft = (customer) => JSON.parse(db.sql.prepare('SELECT draft FROM websites WHERE customer = ?').get(customer).draft)
  const turns = (customer) => db.sql.prepare('SELECT role, text, generation_id FROM website_design_turns WHERE customer = ? ORDER BY rowid').all(customer)
  return { env, db, kv, requests, mock, cookieFor, call, addKey, addAsset, classic, setDraft, storedDraft, turns, events, restore: () => (globalThis.fetch = origFetch) }
}
