// Platform admin console and admin-invitation onboarding, against the real Functions on local workerd.
// Email delivery is not configured in tests, so the console must say so instead of claiming it sent.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('customers without platform access are refused', async ({ page, context }) => {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/google/start?next=/admin')
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  expect((await page.request.get('/api/platform/overview')).status()).toBe(403)
})

test('admin sees customers, metrics, and customer detail without lead contact data', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Customers' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'MRR' }).locator('.stat-value')).toHaveText('No billing yet')
  await page.getByRole('button', { name: 'More metrics' }).click()
  await expect(page.locator('.kv').getByText('Needs cost data').first()).toBeVisible()

  await page.getByLabel('Search customers').fill(fixtures.E2E_CUSTOMER)
  await page.locator('.row--link', { hasText: fixtures.E2E_CUSTOMER_NAME }).click()
  await expect(page.getByRole('heading', { level: 1, name: fixtures.E2E_CUSTOMER_NAME })).toBeVisible()
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.locator('.kv').getByText('healthy')).toBeVisible()
  const detail = await (await page.request.get(`/api/platform/customer?id=${fixtures.E2E_CUSTOMER}`)).text()
  expect(detail).not.toContain('pat@example.net')
  expect(detail).not.toContain('555-010-0100')
})

test('admin suspends and reactivates an account (audited); booking page pauses meanwhile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const book = () => page.request.get(`/api/book/${fixtures.E2E_SPARE_CUSTOMER}`)
  expect((await book()).status()).toBe(200)
  await page.goto('/admin')
  await page.locator('.row--link', { hasText: 'E2E Spare Co' }).first().click()
  await page.getByRole('button', { name: 'Suspend account' }).click()
  await page.getByRole('button', { name: 'Confirm: pause booking page' }).click()
  await expect(page.getByRole('button', { name: 'Reactivate account' })).toBeVisible()
  expect((await book()).status()).toBe(404)
  await expect(page.locator('.card', { hasText: 'Audit trail' }).getByText('customer.suspend')).toBeVisible()
  await page.getByRole('button', { name: 'Reactivate account' }).click()
  await expect(page.getByRole('button', { name: 'Suspend account' })).toBeVisible()
  expect((await book()).status()).toBe(200)
})

test('admin-assisted setup: invite → owner signs in with Google → joins → connects own calendar step', async ({ page, context, browser }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Invite customer' }).click()
  await page.getByLabel('Owner’s Google email').fill('owner@bluewave.example')
  await page.getByLabel('Business name').fill('Blue Wave Pools')
  await page.getByRole('button', { name: 'Create invitation' }).click()
  await expect(page.getByText('Email delivery isn’t configured. Send this link yourself:')).toBeVisible()
  const link = await page.getByLabel('Invitation link').inputValue()
  expect(link).toMatch(/\/dashboard\?invite=[A-Za-z0-9_-]{43}$/)

  // Wrong Google account: refused with a clear explanation.
  const intruderCtx = await browser.newContext()
  const intruder = await intruderCtx.newPage()
  await returnFromGoogle(intruder, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', 'login:someone.else@example.org')
  await intruder.goto(link)
  await expect(intruder.getByRole('heading', { name: 'Join Blue Wave Pools' })).toBeVisible()
  await intruder.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(intruder.getByRole('heading', { name: 'Invitation not accepted' })).toBeVisible()
  await expect(intruder.getByText(/This invitation is for o•••@bluewave\.example/)).toBeVisible()
  await intruderCtx.close()

  // The invited owner joins and lands on the step to authorize their own Google Calendar.
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await returnFromGoogle(owner, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', 'login:owner@bluewave.example')
  await owner.goto(link)
  await owner.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(owner.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await expect(owner.locator('[aria-current="step"]')).toContainText('Calendar')
  const state = await (await owner.request.get('/api/dashboard/me')).json()
  expect(state.customer.name).toBe('Blue Wave Pools')
  await ownerCtx.close()

  await page.goto('/admin')
  await page.getByLabel('Search customers').fill('blue wave')
  await expect(page.locator('.row--link', { hasText: 'Blue Wave Pools' })).toContainText('Connect calendar')
})

test('billing stays hidden when Stripe is not configured', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  expect(await (await page.request.get('/api/dashboard/billing')).json()).toEqual({ configured: false })
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Booking hours' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Plan' })).toHaveCount(0)
})
