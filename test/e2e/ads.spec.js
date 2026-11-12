// Ads flow in the browser against the real Functions on local workerd: business details → starter
// plan (no AI key in e2e) → editable preview → budget approval → owner approval → non-spending check.
// Live launch stays disabled (ADS_LIVE_LAUNCH unset), so nothing can be created or spent.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('owner drafts, previews, edits and approves a budget; approval enforces it @mobile', async ({ page, context }, testInfo) => {
  // Each project gets its own seeded business so the flow starts from scratch in both.
  await useSession(context, testInfo.project.name === 'mobile' ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  // Overview shows the Advertising row (Ads switched on); nothing is recorded yet, so money values are
  // shown as unavailable ('—'), never as $0 or an estimate.
  const adsRow = page.locator('[data-ads-results]')
  await expect(adsRow.getByRole('heading', { name: 'Advertising' })).toBeVisible()
  for (const label of ['Ad spend', 'Clicks', 'Leads from ads', 'Bookings', 'Show-ups', 'Cost per booking', 'Cost per show-up']) {
    await expect(adsRow.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(adsRow.locator('.stat', { hasText: 'Ad spend' }).locator('.stat-value')).toHaveText('—')
  await expect(adsRow.locator('.stat', { hasText: 'Cost per show-up' }).locator('.stat-value')).toHaveText('—')
  await expect(adsRow.getByText('no ad spend recorded')).toBeVisible()
  await page.getByRole('link', { name: 'Ads', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()

  await page.getByLabel('What kind of business?').fill('Pool service')
  await page.getByLabel(/Services you want customers for/).fill('Weekly pool cleaning\nPool repair')
  await page.getByLabel('ZIP codes you serve').fill('29403, 29407')
  await page.getByLabel('Typical first job ($)').fill('300')
  await page.getByLabel('Monthly ad budget ($)').fill('600')
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Draft my plan' }).click()
  await expect(page.getByText('Starter draft (AI planning is not switched on).')).toBeVisible()
  const campaign = page.locator('.campaign').first()
  await expect(campaign.getByLabel('Ad preview')).toContainText('Book Online in Minutes')

  // Approval is blocked until a budget is approved; the checkbox is required.
  await campaign.getByRole('button', { name: 'Approve' }).click()
  await expect(campaign.getByRole('alert')).toHaveText('Approve a monthly budget first.')
  const budget = page.locator('.card', { has: page.getByRole('heading', { name: 'Monthly ad budget' }) })
  await budget.getByLabel('Monthly limit ($)').fill('300')
  await expect(budget.getByRole('button', { name: 'Approve budget' })).toBeDisabled()
  await budget.getByRole('checkbox').check()
  await budget.getByRole('button', { name: 'Approve budget' }).click()
  await expect(budget.getByText('Approved: $300/month')).toBeVisible()

  // The $600/mo draft no longer fits a $300/mo approval → shown as a problem, then fixed by editing.
  const c = page.locator('.campaign').first()
  await c.getByRole('button', { name: 'Approve' }).click()
  await expect(c.getByText('dailyBudgetCents: exceeds the approved budget')).toBeVisible()
  await c.getByText('Edit ad').click()
  await c.getByLabel('Daily budget ($)').fill('9')
  await c.getByRole('button', { name: 'Save changes' }).click()
  // Local e2e runs on http://127.0.0.1, so the booking-page ad URL is not https and approval stays
  // blocked (production is https; the approve → launch-gate path is covered in test/ads.test.js).
  await expect(c.locator('.problems')).toHaveText('finalUrl: https URL required')
  await c.getByRole('button', { name: 'Approve' }).click()
  await expect(c.locator('.problems')).not.toContainText('exceeds the approved budget')
  await expect(c.locator('.chip')).toHaveText('draft')
  await expect(page.getByText('Owner approved a monthly ad budget')).toBeVisible()
  // No horizontal overflow on phones.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('connect Google Ads: a Google Ads TEST account is connected and clearly labelled (mock API)', async ({ page, context }) => {
  // Google sign-in for Ads and the Google Ads API are local stand-ins (MOCK DATA: one test account, no
  // campaigns, no metrics). Nothing here reaches Google, creates a campaign or spends money.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads:owner@e2e.example')
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Ad accounts' }) })
  await accounts.getByRole('link', { name: 'Connect' }).first().click()
  await page.waitForURL(/\/dashboard/)
  await page.goto('/dashboard/ads')
  await expect(accounts.getByText('Connected: MOCK Google Ads test account')).toBeVisible()
  await expect(accounts.locator('[data-test-account]')).toHaveText('Google Ads test account: ads never run and nothing is charged. Results here are test data.')
  // Reading the account works and is read-only; the Overview labels test-account figures.
  const read = await (await page.request.get('/api/ads/google/campaigns')).json()
  expect(read).toEqual({ testAccount: true, campaigns: [] })
  await page.goto('/dashboard')
  await expect(page.locator('[data-ads-results]')).toContainText('Google Ads test account: no real ads ran')
})

test('per-business flag: a business not listed in ADS_BUSINESSES has no Ads tab and no Ads routes', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_OTHER_SESSION_TOKEN)
  expect((await (await page.request.get('/api/dashboard/me')).json()).features.ads).toBe(false)
  expect((await page.request.get('/api/dashboard/ads')).status()).toBe(404)
  expect((await page.request.get('/api/ads/google/campaigns')).status()).toBe(404)
  await page.goto('/dashboard')
  await expect(page.getByRole('link', { name: 'Ads', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-ads-results]')).toHaveCount(0)
})

test('booking page passes ad attribution with the lead', async ({ page }) => {
  let sent
  page.on('request', (r) => {
    if (r.url().endsWith('/lead') && r.method() === 'POST') sent = r.postDataJSON()
  })
  await page.goto(`/book/${fixtures.E2E_CUSTOMER}?utm_source=google&utm_medium=paid&utm_campaign=abc123def456`)
  await page.getByLabel('What do you need?').fill('Pool opening')
  await page.getByLabel('Name').fill('Ad Clicker')
  await page.getByLabel('Phone').fill('(555) 010-0166')
  await page.getByLabel('Email').fill('adclick@example.net')
  const zip = page.getByLabel('ZIP', { exact: true })
  if (await zip.count()) await zip.fill('29403')
  await page.getByRole('button', { name: /Choose a time/ }).click()
  await expect(page.getByRole('heading', { name: /Pick a/ })).toBeVisible()
  expect(sent.attribution).toEqual({ utm_source: 'google', utm_medium: 'paid', utm_campaign: 'abc123def456' })
})
