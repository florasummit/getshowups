// GetShowUps' own acquisition funnel, end to end through the real handlers (founder-approved 2026-11-25): the homepage
// "Request early access" link (salesBookingHref) → the GetShowUps booking page → lead with the link's campaign codes →
// a 20-minute call booked on the founder's calendar with Google's invitation (sendUpdates=all, the prospect as
// attendee) → the owner's follow-up flag for a prospect who didn't book → Admin → Growth's sales attribution (prospect →
// consultation by source). Real handlers + migrations on node:sqlite, mocked Google. Nothing leaves the process.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { createSalesBusiness, SALES_NOTES } from '../server/sales.js'
import { salesAttribution } from '../server/sales-attribution.js'
import { attention } from '../server/attention.js'
import { salesBookingHref } from '../src/lib/enrollment.js'
import { getSettings } from '../server/receptionist/engine.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as enrollment from '../functions/api/enrollment.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SCOPE = 'openid https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
const CAL = 'https://www.googleapis.com/calendar/v3'
let env, db, kv, events, origFetch

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
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
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
  events = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    // Production-like: Stripe in test mode (enrollment closed) and the receptionist's model key present (fake).
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-fake-key-for-tests-0000000000',
  }
  // The sales business exactly as the console creates it (server/sales.js), with the founder's calendar connected.
  const r = await createSalesBusiness(env, { email: 'staff@getshowups.com' }, 'sales')
  assert.equal(r.ok, true, JSON.stringify(r))
  kv.set('google:getshowups', JSON.stringify({ customer: 'getshowups', email: 'founder@getshowups.example', scope: SCOPE, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt'), connectedAt: 'x' }))
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: SCOPE }]
    else if (u === `${CAL}/freeBusy`) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u === `${CAL}/calendars/primary/events?sendUpdates=all`) {
      const body = JSON.parse(init.body)
      events.push(body)
      out = [200, { id: body.id }]
    } else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

async function call(mod, method, path, { body, params } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.7', ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, params, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) }
}
// What the booking page sends: the link's utm/gclid codes (src/booking/BookingPage.jsx).
const attributionFrom = (href) => {
  const q = new URL(href, ORIGIN).searchParams
  return Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'gclid'].filter((k) => q.get(k)).map((k) => [k, q.get(k)]))
}
const P = { customer: 'getshowups' }

test('homepage link: own booking page with the button location; inbound campaign codes are kept, unsafe values dropped', () => {
  assert.equal(salesBookingHref('hero', ''), '/book/getshowups?utm_source=homepage&utm_medium=site&utm_campaign=cta_hero')
  assert.equal(salesBookingHref('pricing', '?utm_source=openai&utm_medium=paid&utm_campaign=gsu-gpt-a&gclid=Cj0KCQiA1234567890'), '/book/getshowups?utm_source=openai&utm_medium=paid&utm_campaign=gsu-gpt-a&gclid=Cj0KCQiA1234567890')
  assert.equal(salesBookingHref('hero', '?utm_source=<script>&name=Jamie'), '/book/getshowups?utm_source=homepage&utm_medium=site&utm_campaign=cta_hero', 'never a personal value or markup')
})

test('the homepage gets salesChat only while the sales business is bookable and its receptionist is on', async () => {
  assert.equal((await call(enrollment, 'GET', '/api/enrollment')).json().salesChat, true)
  kv.delete('google:getshowups')
  assert.equal((await call(enrollment, 'GET', '/api/enrollment')).json().salesChat, false, 'no calendar → the homepage keeps its previous early-access section')
})

test('end to end: homepage hero → booking page → qualified lead → call booked with Google invitation → reported by source; an unbooked prospect is flagged for follow-up', async () => {
  // 1. The booking page loads with real open times and the sales wording.
  const info = await call(bookInfo, 'GET', '/api/book/getshowups', { params: P })
  assert.equal(info.status, 200, info.text)
  assert.equal(info.json().slotMinutes, 20)
  const slot = info.json().slots.find((s) => Date.parse(s) > Date.now() + 30 * 60_000)
  assert.ok(slot, 'open consultation times are offered')
  // 2. A prospect from the hero button leaves details (what they do = the qualifying answer).
  const attr = attributionFrom(salesBookingHref('hero', ''))
  const lead = await call(bookLead, 'POST', '/api/book/getshowups/lead', { params: P, body: { name: 'Dana Harbor', email: 'dana@harbor-pools.example', phone: '843-555-0142', need: 'Pool service, 3 trucks, website inquiries come in at night', attribution: attr } })
  assert.equal(lead.status, 201, lead.text)
  const { leadId, leadToken } = lead.json()
  const la = db.sql.prepare('SELECT source, details FROM lead_attribution WHERE lead_id = ?').get(leadId)
  assert.equal(la.source, 'booking_page')
  assert.deepEqual(JSON.parse(la.details), { medium: 'site', gclid: null, utmSource: 'homepage', utmCampaign: 'cta_hero' })
  assert.equal(db.sql.prepare('SELECT status FROM leads WHERE id = ?').get(leadId).status, 'new', 'qualified (not out of area: the sales business screens no ZIP)')
  // 3. The 20-minute call is booked on the founder's calendar; Google sends the invitation to the prospect.
  const appt = await call(bookAppt, 'POST', '/api/book/getshowups/appointment', { params: P, body: { leadId, leadToken, start: slot } })
  assert.equal(appt.status, 201, appt.text)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].attendees.map((a) => a.email), ['dana@harbor-pools.example'])
  assert.equal(Date.parse(events[0].end.dateTime) - Date.parse(events[0].start.dateTime), 20 * 60_000)
  // 4. A second prospect (link from a ChatGPT ad) asks but doesn't book: the owner's dashboard flags it.
  const other = await call(bookLead, 'POST', '/api/book/getshowups/lead', { params: P, body: { name: 'Sam Lee', email: 'sam@clearwater.example', phone: '843-555-0199', need: 'Pool repair company', attribution: attributionFrom(salesBookingHref('hero', '?utm_source=openai&utm_medium=paid&utm_campaign=gsu-gpt-a')) } })
  assert.equal(other.status, 201)
  assert.equal((await attention(env, 'getshowups')).unbooked.total, 1, '"1 person asked but hasn’t booked yet"')
  // 5. Admin → Growth: prospects and calls by source.
  const r = await salesAttribution(env, {})
  assert.equal(r.prospects, 2)
  assert.equal(r.consultationsBooked, 1)
  const by = Object.fromEntries(r.bySource.map((s) => [`${s.source}|${s.campaign}`, s]))
  assert.equal(by['link:homepage|cta_hero'].consultationsBooked, 1)
  assert.equal(by['link:openai|gsu-gpt-a'].prospects, 1)
  assert.equal(by['link:openai|gsu-gpt-a'].consultationsBooked, 0)
})

test('the sales assistant uses the founder-approved answers: pool-first, not-a-fit rule, what is not live, the listed price only', async () => {
  const s = await getSettings(db, 'getshowups')
  assert.equal(s.knowledge, SALES_NOTES)
  for (const must of [/pool service and repair companies first/, /Probably not a fit/, /answering the phone, text messages, automatic email reminders and follow-ups, and running ads from GetShowUps/, /\$499 a month, billed monthly, no setup fee, no free trial/, /No customer results to share yet/, /20-minute call with the founder/]) assert.match(SALES_NOTES, must)
  assert.doesNotMatch(SALES_NOTES, /guarantee|#1|best in|testimonial/i)
})
