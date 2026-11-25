// When something can't load: say so with a retry, never an empty form (saving one would erase what's stored), never a
// blank page, never a lost draft. Leaving with unsaved text asks first.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

const failOnce = async (page, path) => {
  let fail = true
  await page.route(`**${path}`, (r) => (fail && r.request().method() === 'GET' ? r.fulfill({ status: 503, json: { error: 'storage_error' } }) : r.continue()))
  return () => (fail = false)
}
test.beforeEach(async ({ context }) => useSession(context, fixtures.E2E_SESSION_TOKEN))

test('settings: details and notes that fail to load show a retry, not an empty form that could erase them @mobile', async ({ page }) => {
  const a = await failOnce(page, '/api/dashboard/profile')
  const b = await failOnce(page, '/api/dashboard/policies')
  await page.goto('/dashboard/settings')
  await expect(page.locator('[data-load-error]')).toHaveCount(3)
  await expect(page.locator('textarea[name="description"], textarea[name="beforeVisit"]')).toHaveCount(0)
  a()
  b()
  for (const n of [3, 2, 1]) {
    await expect(page.locator('[data-load-error]')).toHaveCount(n)
    await page.locator('[data-load-error]').first().getByRole('button', { name: 'Retry' }).click()
  }
  await expect(page.locator('textarea[name="beforeVisit"]')).toBeVisible()
})

test('appointments: a load failure is said, then recovers', async ({ page }) => {
  const ok = await failOnce(page, '/api/dashboard/overview')
  await page.goto('/dashboard/appointments')
  await expect(page.locator('[data-load-error]')).toContainText('your appointments')
  ok()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
})

test('changing tabs with unsaved text asks first; staying keeps the text @mobile', async ({ page }) => {
  await page.goto('/dashboard/settings')
  await page.locator('textarea[name="beforeVisit"]').fill('Unsaved words')
  const asked = []
  page.on('dialog', (d) => (asked.push(d.message()), asked.length === 1 ? d.dismiss() : d.accept()))
  const tab = page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Overview' })
  await tab.click()
  await expect(page.locator('textarea[name="beforeVisit"]')).toHaveValue('Unsaved words')
  await tab.click()
  await expect(page.locator('textarea[name="beforeVisit"]')).toHaveCount(0)
  expect(asked).toHaveLength(2)
})

test('booking page: times that fail to load offer a retry; each step moves focus to its heading @mobile', async ({ page }) => {
  const ok = await failOnce(page, `/api/book/${fixtures.E2E_CUSTOMER}`)
  await page.goto(`/book/${fixtures.E2E_CUSTOMER}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We can’t load times right now')
  ok()
  await page.getByRole('button', { name: 'Try again' }).click()
  // A business without services or a service area: open times come first.
  await expect(page.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible()
  await page.locator('.bk-slot').last().click()
  await page.getByRole('button', { name: /^Continue with / }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeFocused()
})
