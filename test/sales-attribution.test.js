// GetShowUps selling itself, closed loop (server/sales-attribution.js): prospects of the sales business grouped by
// acquisition source, matched to the business they later created (owner sign-in = prospect email, created after the
// inquiry, never a test business), paying only in live billing, CAC only from GetShowUps' own measured spend; booking-page
// links that aren't one of the business's campaigns keep their utm codes (server/ads/attribution.js). Counts only.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { salesAttribution } from '../server/sales-attribution.js'
import { recordAttribution } from '../server/ads/attribution.js'
import { growthMeasure } from '../server/growth.js'

const DAY = 86400000
const now = Date.now()
let env, db
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
  return { sql, prepare: (q) => stmt(q) }
}
const biz = (id, createdAt, owner = `owner@${id}.example`) => {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?)").run(id, id, createdAt, createdAt)
  if (owner) db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, createdAt)
}
const lead = (id, email, at = now - 20 * DAY) => db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, 'getshowups', 'P', ?, '1', 'pool company, misses web inquiries', '', 'new', ?, ?, ?)").run(id, email, `h${id}`, at, at)
const attr = (leadId, source, campaign, details) => db.sql.prepare("INSERT INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?, 'getshowups', ?, ?, ?, 1)").run(leadId, source, campaign, JSON.stringify(details))
const sub = (customer, status, livemode) => {
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, updated_at) VALUES (?, ?, ?, 'founding', ?, 49900, 'usd', 1)").run(customer, `cus_${customer}`, `sub_${customer}`, status)
  db.sql.prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?, ?, 1)').run(customer, livemode)
}

beforeEach(() => {
  db = d1()
  env = { ONBOARDING_DB: db, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', GOOGLE_TOKENS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) }, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)) }
  biz('getshowups', now - 100 * DAY, 'founder@getshowups.example')
  // Prospects: two from a ChatGPT/Google link run directly in the ad platform (utm codes), one from a GetShowUps Google
  // campaign, one with nothing recorded, one internal (never counted).
  lead('p1', 'Owner1@Pools.example')
  lead('p2', 'owner2@spa.example')
  lead('p3', 'owner3@hvac.example')
  lead('p4', 'owner4@roof.example')
  lead('p5', 'someone@getshowups.com')
  db.sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES ('gsuCamp001', 'getshowups', 'google', 'active', '{}', 2500, 'g1', 1, 1)").run()
  attr('p1', 'booking_page', null, { medium: 'paid', gclid: null, utmSource: 'openai', utmCampaign: 'gsu-chatgpt-1' })
  attr('p2', 'booking_page', null, { medium: 'paid', gclid: null, utmSource: 'openai', utmCampaign: 'gsu-chatgpt-1' })
  attr('p3', 'google_ads', 'gsuCamp001', { medium: 'cpc', gclid: 'present' })
  // p1 became a business (owner sign-in = prospect email, any case) after the inquiry and pays in LIVE mode; p3 became one
  // but pays in test mode; p2's address owns a business created BEFORE the inquiry (an existing customer, not a win).
  biz('pools1', now - 10 * DAY, 'owner1@pools.example')
  sub('pools1', 'active', 1)
  biz('hvac3', now - 5 * DAY, 'owner3@hvac.example')
  sub('hvac3', 'active', 0)
  biz('spa2', now - 60 * DAY, 'owner2@spa.example')
  sub('spa2', 'active', 1)
  // A test business created by a prospect's address never counts.
  lead('p6', 'owner6@test.example')
  biz('test6', now - 2 * DAY, 'owner6@test.example')
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('test6', 1, 'admin', 1)").run()
  db.sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES ('a1', 'getshowups', 'p1', ?, ?, 'showed', 1, 1), ('a3', 'getshowups', 'p3', ?, ?, 'booked', 1, 1)").run(now - 15 * DAY, now - 15 * DAY + 1, now - 14 * DAY, now - 14 * DAY + 1)
  db.sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES ('gsuCamp001', 'getshowups', ?, 30000, 4000, 60, 0, 1)").run(new Date(now - 20 * DAY).toISOString().slice(0, 10))
})

test('no sales business → null (shown as "set it up"), never zeros', async () => {
  db = d1()
  env.ONBOARDING_DB = db
  assert.equal(await salesAttribution(env, { now }), null)
})

test('test-mode billing: prospects, consultations and businesses by source; nobody counts as paying; no CAC', async () => {
  const r = await salesAttribution(env, { now })
  assert.equal(r.live, false)
  assert.equal(r.prospects, 5, 'the internal address is excluded')
  assert.equal(r.consultationsBooked, 2)
  assert.equal(r.consultationsAttended, 1)
  assert.equal(r.businessesCreated, 2, 'p1 and p3; p2 owned a business before asking; the test business never counts')
  assert.equal(r.paying, null)
  assert.equal(r.cacCents, null)
  assert.equal(r.spendCents, 30000)
  const by = Object.fromEntries(r.bySource.map((s) => [`${s.source}|${s.campaign}`, s]))
  assert.deepEqual(by['link:openai|gsu-chatgpt-1'], { source: 'link:openai', campaign: 'gsu-chatgpt-1', prospects: 2, qualified: 2, consultationsBooked: 1, consultationsAttended: 1, businessesCreated: 1, paying: null, revenueCents: null })
  assert.equal(by['google_ads|gsuCamp001'].businessesCreated, 1)
  assert.equal(by['direct|null'].prospects, 2)
  assert.ok(!JSON.stringify(r).includes('@'), 'counts only: no email ever leaves')
})

test('live billing: only active LIVE subscriptions of businesses created after the inquiry are paying; CAC = own spend ÷ paying', async () => {
  env.STRIPE_LIVE_ENABLED = 'true'
  env.STRIPE_SECRET_KEY = 'sk_live_fake'
  const r = await salesAttribution(env, { now })
  assert.equal(r.live, true)
  assert.equal(r.paying, 1, 'pools1 only: hvac3 is a test-mode subscription, spa2 predates the inquiry')
  assert.equal(r.cacCents, 30000)
  assert.equal(r.bySource.find((s) => s.source === 'link:openai').paying, 1)
})

test('booking-page links keep their utm codes when they are not one of the business’s campaigns', async () => {
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('n1', 'getshowups', 'P', 'n1@x.example', '1', 'x', '', 'new', 'h', 1, 1), ('n2', 'getshowups', 'P', 'n2@x.example', '1', 'x', '', 'new', 'h2', 1, 1)").run()
  assert.deepEqual(await recordAttribution(env, 'getshowups', 'n1', { utm_source: 'openai', utm_medium: 'paid', utm_campaign: 'gsu-chatgpt-1' }), { source: 'booking_page', campaignId: null })
  assert.deepEqual(JSON.parse(db.sql.prepare("SELECT details FROM lead_attribution WHERE lead_id = 'n1'").get().details), { medium: 'paid', gclid: null, utmSource: 'openai', utmCampaign: 'gsu-chatgpt-1' })
  // A GetShowUps campaign link is attributed to the campaign as before (no extra codes).
  assert.deepEqual(await recordAttribution(env, 'getshowups', 'n2', { utm_source: 'google', utm_campaign: 'gsuCamp001' }), { source: 'google_ads', campaignId: 'gsuCamp001' })
  assert.deepEqual(JSON.parse(db.sql.prepare("SELECT details FROM lead_attribution WHERE lead_id = 'n2'").get().details), { medium: null, gclid: null })
})

test('Growth shows prospects → businesses (→ paying) by source and a CAC only when it can be computed', async () => {
  const m = await growthMeasure(env, now)
  const by = Object.fromEntries(m.items.map((i) => [i.key, i]))
  assert.equal(by.salesBusinesses.value, 2)
  assert.match(by.salesBusinesses.note, /openai \(gsu-chatgpt-1\) 2 → 1/)
  assert.equal(by.salesPaying.kind, 'test')
  assert.equal(by.cac.value, null)
  env.STRIPE_LIVE_ENABLED = 'true'
  env.STRIPE_SECRET_KEY = 'sk_live_fake'
  const live = Object.fromEntries((await growthMeasure(env, now)).items.map((i) => [i.key, i]))
  assert.equal(live.salesPaying.value, 1)
  assert.equal(live.cac.value, 30000)
  assert.equal(live.cac.kind, 'live')
})
