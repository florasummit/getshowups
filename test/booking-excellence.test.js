// Customer booking and chat, Product Excellence (docs/quality/USABILITY_FINDINGS.md BOOK-03, BOOK-09, BOOK-10, CHAT-02):
// one set of field rules for the page and the server, refused submissions never use up the attempt limit while a valid
// flood is limited at the same threshold, the lockout says when it ends, the booking API offers the business's own
// phone, and a business's booking/chat page never leaves with GetShowUps' marketing title, description or price.
// Real handlers + migrations on node:sqlite, mocked Google. Nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { EMAIL_RE } from '../server/auth.js'
import { createSalesBusiness } from '../server/sales.js'
import { validateAddress, validateLead } from '../server/booking.js'
import { addressProblems, leadProblems, LEAD_EMAIL_RE, phoneOk, ZIP_SHAPE_RE } from '../server/lead-fields.js'
import { normalizeZip } from '../server/zipcode.js'
import { RULES } from '../server/ratelimit.js'
import { neutralHead, publicPageKind, withPublicHead, PUBLIC_HEAD } from '../server/public-head.js'
import { lockoutText, telHref, zoneName } from '../src/public/head.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
let env, db, kv, origFetch

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => {
      if (a.some((x) => x === undefined)) throw new TypeError('undefined bound') // like D1
      return stmt(q, a)
    },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        const out = []
        for (const s of list) out.push({ meta: { changes: sql.prepare(s.q).run(...s.args).changes } })
        sql.exec('COMMIT')
        return out
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

beforeEach(async () => {
  db = d1()
  kv = new Map()
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
  }
  // A bookable business with no services: the page asks the open "What do you need?".
  assert.equal((await createSalesBusiness(env, { email: 'staff@getshowups.com' }, 'sales')).ok, true)
  db.sql.prepare("UPDATE business_profiles SET services = '[]', phone = '+18435550100' WHERE customer = 'getshowups'").run()
  kv.set('google:getshowups', JSON.stringify({ customer: 'getshowups', email: 'owner@pools.example', scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
  origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.at', scope: SCOPE }))
    if (u.endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }))
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function call(mod, method, path, { body, ip = '203.0.113.9' } = {}) {
  const headers = { 'CF-Connecting-IP': ip, ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params: { customer: 'getshowups' }, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, res, json: () => JSON.parse(text) }
}
const PERSON = { name: 'Dana Harbor', email: 'dana@harbor.example', phone: '843-555-0142', need: 'Weekly pool cleaning' }
const lead = (patch = {}, opts) => call(bookLead, 'POST', '/api/book/getshowups/lead', { body: { ...PERSON, ...patch }, ...opts })
const counted = () => db.sql.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'bookLead%'").get().n

test('BOOK-09 one rule: the page and the server share the field rules; every problem is listed at once, the server reports the first', () => {
  assert.equal(LEAD_EMAIL_RE.source, EMAIL_RE.source, 'the same email rule as sign-in')
  const empty = { name: '', email: '', phone: '', need: '', address: { street: '', city: '', state: '', zip: '' } }
  assert.deepEqual(leadProblems(empty), ['invalid_name', 'invalid_email', 'invalid_phone', 'invalid_need'])
  assert.deepEqual(leadProblems(empty, 'at_customer'), ['invalid_name', 'invalid_email', 'invalid_phone', 'invalid_need', 'invalid_street', 'invalid_city', 'invalid_state', 'invalid_zip'])
  assert.deepEqual(leadProblems(PERSON), [])
  // validateLead's answer is always the first problem of the shared list (many shapes, both modes, both phone rules).
  const address = { street: '21 Tide Ln', city: 'Charleston', state: 'SC', zip: '29403' }
  const bodies = [empty, PERSON, { ...PERSON, name: 'J' }, { ...PERSON, email: 'nope' }, { ...PERSON, phone: '5550142' }, { ...PERSON, need: 'x' }, { ...PERSON, address }, { ...PERSON, address: { ...address, state: 'ZZ' } }, { ...PERSON, address: { ...address, zip: '2940' } }, { ...PERSON, email: 'nope', address: { ...address, street: 'Tide' } }]
  for (const body of bodies) for (const mode of ['at_business', 'at_customer']) for (const fullNumber of [false, true]) assert.equal(validateLead(body, mode, { fullNumber })[0] ?? null, leadProblems(body, mode, { fullNumber })[0] ?? null, JSON.stringify([body, mode, fullNumber]))
  assert.deepEqual(addressProblems({ ...address, city: '9' }), ['invalid_city'])
  assert.equal(validateAddress({ ...address, state: 'zz' })[0], 'invalid_state')
  assert.deepEqual(validateAddress({ ...address, state: 'sc' })[1], { ...address, unit: '' }, 'cleaned value as before')
  // The ZIP shape the first step accepts is exactly what the server's normalizeZip accepts.
  for (const z of ['29403', ' 29403 ', '29403-1234', '29403 1234', '294031234', '2940', '29403-12', 'abcde', '']) assert.equal(ZIP_SHAPE_RE.test(z), Boolean(normalizeZip(z)), z)
})

test('BOOK-09 phone: on the booking page a US number needs its area code; other entry points keep the rule they had', () => {
  for (const ok of ['8435550142', '(843) 555-0142', '843.555.0142', '1 843 555 0142', '+1 843 555 0142', '+44 20 7946 0958', '+61 2 9374 4000', '020 7946 0958']) assert.equal(phoneOk(ok, { fullNumber: true }), true, ok)
  for (const bad of ['5550142', '555-0142', '12345678', '843555014', '+1 843 555 014', '+1 843 555 01422', 'call me', '', '12']) assert.equal(phoneOk(bad, { fullNumber: true }), false, bad)
  // Without fullNumber (website forms, the receptionist, ad leads): unchanged — 7 digits and the usual punctuation.
  assert.equal(phoneOk('555-0142'), true)
  assert.equal(phoneOk('12'), false)
  assert.equal(validateLead({ ...PERSON, phone: '555-0142' })[0], null)
  assert.equal(validateLead({ ...PERSON, phone: '555-0142' }, 'at_business', { fullNumber: true })[0], 'invalid_phone')
})

test('BOOK-09 route: the public lead route refuses an 8-digit phone and accepts a full one', async () => {
  assert.equal((await lead({ phone: '5550 1422' })).json().error, 'invalid_phone')
  assert.equal((await lead()).status, 201)
})

test('BOOK-10: a submission refused for a missing or malformed field does not count toward the limit', async () => {
  const refusals = [{ name: '' }, { email: 'nope' }, { phone: '12345678' }, { need: '' }, { website: 'http://spam' }]
  for (let i = 0; i < 40; i++) {
    const r = await lead(refusals[i % refusals.length])
    assert.equal(r.status, 400, `refusal ${i}`)
  }
  assert.equal(counted(), 0, 'no counter was touched by a refused submission')
  // …so the customer who then fixes the form is not locked out.
  assert.equal((await lead()).status, 201)
  assert.equal(counted(), 2, 'one use per visitor + one per business')
})

test('BOOK-10: a flood of valid submissions is still limited at the same threshold, with Retry-After; limits unchanged', async () => {
  assert.deepEqual([RULES.bookLead, RULES.bookLeadPerBusiness], [{ limit: 10, windowSec: 600 }, { limit: 100, windowSec: 3600 }])
  for (let i = 0; i < RULES.bookLead.limit; i++) assert.equal((await lead({ email: `dana${i}@harbor.example` })).status, 201, `lead ${i}`)
  const blocked = await lead({ email: 'dana-last@harbor.example' })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json().error, 'rate_limited')
  const retry = Number(blocked.res.headers.get('Retry-After'))
  assert.ok(retry >= 1 && retry <= RULES.bookLead.windowSec, `Retry-After ${retry}`)
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, RULES.bookLead.limit, 'nothing stored past the limit')
  // A locked-out visitor's malformed submission is told what is wrong (not counted); another visitor is unaffected.
  assert.equal((await lead({ name: '' })).json().error, 'invalid_name')
  assert.equal((await lead({ email: 'other@harbor.example' }, { ip: '203.0.113.77' })).status, 201)
})

test('BOOK-10: the lockout message says when to try again', () => {
  const now = Date.parse('2026-11-26T15:00:10Z')
  const text = lockoutText(432, now)
  assert.match(text, /^Too many attempts\. Please try again in about 8 minutes \(after \d{1,2}:\d{2}\s?[AP]M\)\./)
  assert.match(lockoutText(30, now), /in about a minute/)
  assert.equal(lockoutText(0), 'Too many attempts. Please wait a few minutes and try again.')
})

test('BOOK-03 / CHAT-02: the booking API offers the business phone on record, and nothing else about the owner', async () => {
  const info = (await call(bookInfo, 'GET', '/api/book/getshowups')).json()
  assert.equal(info.phone, '+18435550100')
  assert.equal(telHref('(843) 555-0100'), 'tel:8435550100')
  assert.ok(!JSON.stringify(info).includes('owner@pools.example') && !JSON.stringify(info).includes('staff@getshowups.com'))
  assert.equal(info.reach, null, 'a phone on record is the way to reach the business')
  db.sql.prepare("UPDATE business_profiles SET phone = '' WHERE customer = 'getshowups'").run()
  const none = (await call(bookInfo, 'GET', '/api/book/getshowups')).json()
  assert.deepEqual([none.phone, none.reach], ['', null], 'no phone, no live website, chat not answering: nothing to offer, so nothing is offered')
  // No phone, but the chat page would open: that public page is offered.
  env.RECEPTIONIST_ANTHROPIC_API_KEY = 'sk-ant-test-not-real'
  assert.deepEqual((await call(bookInfo, 'GET', '/api/book/getshowups')).json().reach, { kind: 'chat', url: 'https://getshowups.com/chat/getshowups' })
  delete env.RECEPTIONIST_ANTHROPIC_API_KEY
})

test('BOOK-08: a time zone is named in plain words', () => {
  assert.match(zoneName('America/New_York', Date.parse('2026-11-28T14:00:00Z')), /^Eastern (Standard )?Time$/)
  assert.match(zoneName('America/Los_Angeles', Date.parse('2026-07-01T14:00:00Z')), /^Pacific (Daylight )?Time$/)
  assert.equal(zoneName('Not/AZone'), 'Not/AZone')
})

test('CHAT-02: a business’s booking and chat pages leave without GetShowUps’ marketing title, description, price or share card', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /\$499/, 'the marketing page itself still carries its own description')
  for (const kind of ['book', 'chat']) {
    const out = neutralHead(html, kind)
    assert.ok(out.includes(`<title>${PUBLIC_HEAD[kind].title}</title>`))
    assert.ok(out.includes(`<meta name="description" content="${PUBLIC_HEAD[kind].description}" />`))
    assert.doesNotMatch(out, /\$\d|founding plan|Turn More Leads|og:|twitter:/)
    assert.ok(out.includes('<div id="root"></div>') && out.includes('favicon'), 'the app shell is untouched')
  }
  assert.deepEqual(['/book/e2e-pool', '/chat/e2e-pool/', '/book/getshowups', '/chat/getshowups', '/', '/dashboard', '/book/e2e-pool/x', '/api/book/e2e-pool'].map(publicPageKind), ['book', 'chat', null, null, null, null, null, null])
  const page = () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"abc"', 'Content-Length': String(html.length) } })
  const get = (path, init) => withPublicHead(page(), new URL(ORIGIN + path), new Request(ORIGIN + path, init))
  const book = await get('/book/e2e-pool')
  assert.doesNotMatch(await book.text(), /\$499/)
  assert.deepEqual([book.headers.get('ETag'), book.headers.get('Content-Length'), book.headers.get('Content-Type')], [null, null, 'text/html; charset=utf-8'])
  // Everything else passes through untouched: other pages, GetShowUps' own booking page, non-HTML, non-200, non-GET.
  assert.match(await (await get('/')).text(), /\$499/)
  assert.match(await (await get('/book/getshowups')).text(), /\$499/)
  const asset = new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  assert.equal(await withPublicHead(asset, new URL(`${ORIGIN}/book/e2e-pool`), new Request(`${ORIGIN}/book/e2e-pool`)), asset)
  const missing = new Response('x', { status: 404, headers: { 'Content-Type': 'text/html' } })
  assert.equal(await withPublicHead(missing, new URL(`${ORIGIN}/chat/e2e-pool`), new Request(`${ORIGIN}/chat/e2e-pool`)), missing)
})
