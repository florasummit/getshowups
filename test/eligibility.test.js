// One eligibility rule for the self-service tools (server/eligibility.js): Ads follows billing standing only
// (hostingActive), Teach Your AI and Website Studio need an active business too (businessEligible). Pilots and
// complimentary accounts count; a self-serve sign-up before payment, an ended subscription, a suspended business (for
// the editing tools), a bad id and a failing lookup do not. node:sqlite D1 with every migration; nothing external.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { businessEligible, hostingActive } from '../server/eligibility.js'
import { adsAccess, adsEnabled } from '../server/ads/access.js'
import { studioAccess as teachAccess } from '../server/intelligence/access.js'
import { studioAccess as websiteStudioAccess } from '../server/website-studio.js'

const DAY = 86400000
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.map((s) => sql.prepare(s.q).run(...s.args)) }
}
let db, env
const now = Date.now()
const business = (id, status = 'active') => {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, status, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?)").run(id, `${id} Co`, status, now, now)
  return { id, status }
}
const signup = (id, onboarded = true) => db.sql.prepare('INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES (?, ?, ?, ?)').run(id, 'founding', now, onboarded ? now : null)
const subscription = (id, status, periodEnd = now + 20 * DAY) =>
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES (?, ?, ?, 'founding', ?, 49900, 'usd', ?, ?)").run(id, `cus_${id}`, `sub_${id}`, status, periodEnd, now)

beforeEach(() => {
  db = d1()
  env = { ONBOARDING_DB: db }
})

test('billing standing decides: pilots, paid, trialing, past due and complimentary are in; unpaid sign-ups and ended subscriptions are out', async () => {
  const pilot = business('poolthru-llc') // never billed: no self_signups row
  assert.equal(await hostingActive(env, pilot), true)
  const unpaid = business('fresh-signup')
  signup('fresh-signup', false)
  assert.equal(await hostingActive(env, unpaid), false, 'self-serve before payment')
  for (const [id, status] of [['paid-co', 'active'], ['trial-co', 'trialing'], ['late-co', 'past_due']]) {
    const c = business(id)
    signup(id)
    subscription(id, status)
    assert.equal(await hostingActive(env, c), true, status)
  }
  const ended = business('ended-co')
  signup('ended-co')
  subscription('ended-co', 'canceled', now - 30 * DAY)
  assert.equal(await hostingActive(env, ended), false, 'cancelled subscription, grace over')
  const free = business('internal-co')
  signup('internal-co', false)
  db.sql.prepare("INSERT INTO business_accounts (customer, classification, billing, environment, provider_spend, note, set_by, set_at) VALUES ('internal-co', 'internal_live', 'complimentary', 'production', 'allowed', '', 'ref:x', ?)").run(now)
  assert.equal(await hostingActive(env, free), true, 'complimentary account, nothing to pay')
})

test('the editing tools need an active business; Ads keeps its tab for a suspended one (the hold says why)', async () => {
  const c = business('pools-co')
  assert.equal(await businessEligible(env, c), true)
  assert.equal(await adsAccess(env, c), true)
  const suspended = business('held-co', 'suspended')
  assert.equal(await businessEligible(env, suspended), false)
  assert.equal(await teachAccess(env, suspended), false)
  assert.equal(await websiteStudioAccess(env, suspended), false)
  assert.equal(await adsAccess(env, suspended), true, 'the Ads tab stays so the owner sees why ads are paused')
  assert.equal(await teachAccess(env, c), true, 'Teach Your AI: every eligible business once migration 0033 exists')
  assert.equal(await websiteStudioAccess(env, c), true)
})

test('emergency off switches and the old allowlists', async () => {
  const c = business('pools-co')
  assert.equal(adsEnabled({}), true)
  assert.equal(adsEnabled({ ADS_ENABLED: 'true' }), true)
  assert.equal(adsEnabled({ ADS_ENABLED: 'false' }), false)
  assert.equal(await adsAccess({ ...env, ADS_ENABLED: 'false' }, c), false)
  assert.equal(await teachAccess({ ...env, AI_STUDIO_ENABLED: 'false' }, c), false)
  assert.equal(await websiteStudioAccess({ ...env, WEBSITE_STUDIO_ENABLED: 'false' }, c), false)
  // The retired pilot allowlists change nothing either way.
  assert.equal(await adsAccess({ ...env, ADS_BUSINESSES: 'someone-else' }, c), true)
  assert.equal(await teachAccess({ ...env, AI_STUDIO_BUSINESSES: '' }, c), true)
})

test('fails closed: no business, a bad id, a non-active status, or a failing lookup', async () => {
  assert.equal(await hostingActive(env, null), false)
  assert.equal(await hostingActive(env, { id: 'not a valid id!' }), false)
  assert.equal(await businessEligible(env, { ...business('gone-co'), status: 'deleting' }), false, 'any status but active')
  const broken = { ONBOARDING_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('boom') } }) }) } }
  const origError = console.error
  console.error = () => {}
  try {
    assert.equal(await hostingActive(broken, business('pools-co')), false)
    assert.equal(await adsAccess(broken, { id: 'pools-co', status: 'active' }), false)
  } finally {
    console.error = origError
  }
})
