// Public enrollment status (GET /api/enrollment): visitors learn enrollment is closed before Google sign-in.
// It must agree with the server's own sign-up rule (POST /api/dashboard/business) and reveal one boolean only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enrollmentOpen } from '../server/onboarding.js'
import { onRequestGet } from '../functions/api/enrollment.js'

const PLAN = { id: 'founding', name: 'Founding', stripe_price_id: 'price_test', trial_days: 0, entitlements: '{}', active: 1, created_at: 1 }
// Plans come from D1; anything else (rate-limit rows) fails, and the rate limiter fails open by design.
const db = (plans) => ({
  prepare: (q) => {
    const s = {
      bind: () => s,
      all: async () => {
        if (/FROM plans/.test(q)) return { results: plans }
        throw new Error('not in this stub')
      },
      first: async () => {
        throw new Error('not in this stub')
      },
      run: async () => {
        throw new Error('not in this stub')
      },
    }
    return s
  },
})
const TEST_BILLING = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }

test('closed while billing is sandbox-only (today in production): admins/testers sign in, the public is told', async () => {
  assert.equal(await enrollmentOpen({ ...TEST_BILLING, ONBOARDING_DB: db([PLAN]) }), false)
})

test('open once live billing is on', async () => {
  assert.equal(await enrollmentOpen({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_LIVE_ENABLED: 'true', ONBOARDING_DB: db([PLAN]) }), true)
})

test('closed when billing is half-configured (fails closed, like POST /api/dashboard/business)', async () => {
  assert.equal(await enrollmentOpen({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', ONBOARDING_DB: db([PLAN]) }), false)
  assert.equal(await enrollmentOpen({ STRIPE_SECRET_KEY: 'sk_test_x', ONBOARDING_DB: db([PLAN]) }), false)
})

test('billing not configured or no plan on sale: unbilled setup, so not shown as closed', async () => {
  assert.equal(await enrollmentOpen({ ONBOARDING_DB: db([]) }), true)
  assert.equal(await enrollmentOpen({ ...TEST_BILLING, ONBOARDING_DB: db([]) }), true)
})

test('route returns exactly { open } with no-store, and 503 without storage', async () => {
  const req = new Request('https://getshowups.com/api/enrollment', { headers: { 'cf-connecting-ip': '203.0.113.7' } })
  const res = await onRequestGet({ request: req, env: { ...TEST_BILLING, ONBOARDING_DB: db([PLAN]) } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { open: false })
  assert.match(res.headers.get('Cache-Control') || '', /no-store/)
  const none = await onRequestGet({ request: req, env: {} })
  assert.equal(none.status, 503)
  assert.deepEqual(await none.json(), { error: 'not_configured' })
})

test('a storage failure is an allowlisted error, never details', async () => {
  const broken = { prepare: () => ({ bind: () => broken, all: async () => Promise.reject(new Error('D1 secret detail')), first: async () => null, run: async () => ({}) }) }
  const res = await onRequestGet({ request: new Request('https://getshowups.com/api/enrollment'), env: { ...TEST_BILLING, ONBOARDING_DB: broken } })
  assert.equal(res.status, 503)
  const body = await res.text()
  assert.equal(body, JSON.stringify({ error: 'unavailable' }))
})
