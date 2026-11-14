// Autonomous journey (MOCK Google: the local stand-in issues codes and tokens; nothing reaches Google).
// The runner decides each next step from backend state (test/e2e/journey.js); this spec only supplies how to
// perform each step with mocked OAuth, then verifies the backend result.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'
import { detect, runJourney } from './journey.js'

// One stateful business (e2e-journey) walked through in order; a retry would start from changed state.
test.describe.configure({ mode: 'serial', timeout: 90_000, retries: 0 })

const EMAIL = fixtures.E2E_JOURNEY_EMAIL
const MOCK_ACTIONS = {
  // Google sign-in (openid email) → our callback with a mock code.
  async sign_in(page) {
    await returnFromGoogle(page, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${EMAIL}`)
    await page.goto('/dashboard')
    await page.getByRole('link', { name: 'Continue with Google' }).click()
    await page.waitForURL('**/dashboard**')
  },
  // Calendar connection (calendar.freebusy + calendar.events.owned).
  async setup_calendar(page) {
    await page.unroute('**/api/google/oauth/start').catch(() => {})
    await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${EMAIL}`)
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Connect Google Calendar' }).click()
    await page.waitForLoadState('networkidle')
  },
  async ads_profile(page) {
    await page.goto('/dashboard/ads')
    await page.getByLabel('What kind of business?').fill('Pool service')
    await page.getByLabel(/Services you want customers for/).fill('Weekly pool cleaning, Pool repair')
    await page.getByLabel('ZIP codes you serve').fill('29403')
    await page.getByLabel('Typical first job ($)').fill('175')
    await page.getByLabel('Monthly ad budget ($)').fill('500')
    await page.getByRole('button', { name: 'Save details' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
  },
  // Google Ads connection (adwords); the mock sign-in reaches exactly one Google Ads TEST account.
  async ads_connect(page) {
    await page.unroute('**/api/ads/google/start').catch(() => {})
    await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', `ads-one:${EMAIL}`)
    await page.goto('/dashboard/ads')
    const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
    await accounts.getByRole('link', { name: /^(Connect|Reconnect)$/ }).first().click()
    await page.waitForURL('**/dashboard/ads**')
    await page.waitForLoadState('networkidle')
  },
  async ads_reconnect(page) {
    await MOCK_ACTIONS.ads_connect(page)
  },
  async ads_choose_account(page) {
    await page.goto('/dashboard/ads')
    const pick = page.getByRole('group', { name: 'Choose a Google Ads account' })
    await pick.getByRole('listitem').filter({ hasText: 'Test account' }).first().getByRole('button').click()
    await expect(page.locator('[data-ads-account]')).toBeVisible()
  },
}

test('cold start: the journey discovers every step (sign-in → Calendar → Ads details → Google Ads) and verifies the backend', async ({ page }, testInfo) => {
  const r = await runJourney(page, MOCK_ACTIONS)
  await testInfo.attach('journey-trace.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' })
  expect(r.diagnosis).toBeUndefined()
  expect(r.ok).toBe(true)
  expect(r.trace.map((t) => t.state)).toEqual(['sign_in', 'setup_calendar', 'ads_profile', 'ads_connect', 'ready'])
  // Backend, not navigation: the right business, a healthy Calendar, a Google Ads TEST account connected.
  expect(r.final.business).toBe(fixtures.E2E_JOURNEY_CUSTOMER)
  expect((await (await page.request.get('/api/dashboard/calendar')).json()).status).toBe('healthy')
  const ads = await (await page.request.get('/api/dashboard/ads')).json()
  expect([ads.connections.google.status, ads.connections.google.testAccount, ads.capabilities.sandbox]).toEqual(['connected', true, true])
  // And the customer sees it.
  await page.goto('/dashboard/ads')
  await expect(page.locator('[data-conn-status][data-platform="google"]')).toHaveText('✓Connected')
})

test('self-heals: an expired Google Ads sign-in is detected and repaired by reconnecting', async ({ page }, testInfo) => {
  // Re-use the signed-in owner from the previous step: sign in again through the journey (cookie per test).
  expect((await runJourney(page, MOCK_ACTIONS)).ok).toBe(true)
  // Degrade: Google later rejects the stored Ads sign-in (MOCK ads-revoked), noticed when the accounts load.
  await page.unroute('**/api/ads/google/start').catch(() => {})
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', `ads-revoked:${EMAIL}`)
  await page.goto('/dashboard/ads')
  await page.getByRole('link', { name: 'Reconnect' }).first().click()
  await page.waitForURL('**/dashboard/ads**')
  await page.request.get('/api/ads/google/accounts')
  expect((await detect(page)).state).toBe('ads_reconnect')
  const r = await runJourney(page, MOCK_ACTIONS)
  await testInfo.attach('journey-trace.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' })
  expect(r.trace.map((t) => t.state)).toEqual(['ads_reconnect', 'ready'])
  expect((await (await page.request.get('/api/dashboard/ads')).json()).connections.google.status).toBe('connected')
})

test('a step that does not change the backend is diagnosed (path + alerts), never retried forever', async ({ page, context }) => {
  // A business still missing its Calendar; the "action" deliberately does nothing.
  await useSession(context, fixtures.E2E_OTHER_SESSION_TOKEN)
  await page.goto('/dashboard?code=SHOULD-NOT-APPEAR')
  const r = await runJourney(page, { setup_calendar: async () => {} }, { settleMs: 1500 })
  expect(r.ok).toBe(false)
  expect(r.trace.map((t) => t.state)).toEqual(['setup_calendar', 'setup_calendar'])
  expect(r.diagnosis.reason).toBe('"setup_calendar" did not change after its action')
  expect(r.diagnosis.path).toBe('/dashboard')
  expect(JSON.stringify(r)).not.toContain('SHOULD-NOT-APPEAR')
})
