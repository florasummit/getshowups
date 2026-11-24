// Contextual help: opens beside the setting or number, no request, keyboard, focus back, phone sheet.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('help opens without any request, explains, closes with Escape and gives focus back @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  await page.waitForLoadState('networkidle')
  const calls = []
  page.on('request', (r) => calls.push(r.url()))
  const tip = page.getByRole('button', { name: 'Help: Booking hours' })
  await tip.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('[data-help-panel="hours"]')
  await expect(panel).toBeFocused()
  for (const t of ['Why it matters', 'Example', 'Next step']) await expect(panel).toContainText(t)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/help-${page.viewportSize().width}.png` })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(tip).toBeFocused()
  expect(calls).toEqual([])
})

test('numbers say whether they are measured or estimated', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Help: New inquiries' }).first().click()
  await expect(page.locator('[data-help-panel]')).toContainText('Measured from your records')
  await page.locator('[data-help-panel]').getByRole('button', { name: 'Close' }).click()
  await page.goto('/dashboard/ads')
  await page.getByRole('button', { name: 'Help: Estimated, invoiced and paid' }).click()
  await expect(page.locator('[data-help-panel]')).toContainText('Includes estimates')
})
