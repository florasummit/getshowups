// Session ends while the owner is typing: the page says so once, keeps the text, and continues after signing in again.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('expired session: a clear notice, typed text kept, continues after sign-in; never shown before signing in @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  const box = page.locator('textarea[name="beforeVisit"]')
  await box.fill('Please unlock the side gate.')
  await expect(page.locator('[data-signed-out]')).toHaveCount(0)
  await context.clearCookies()
  await page.locator('form:has(textarea[name="beforeVisit"])').getByRole('button', { name: /Save/ }).click()
  const notice = page.locator('[data-signed-out]')
  await expect(notice).toContainText('You’ve been signed out')
  await expect(box).toHaveValue('Please unlock the side gate.')
  await notice.getByRole('button', { name: 'I’ve signed in' }).click()
  await expect(notice).toContainText('Still signed out')
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await notice.getByRole('button', { name: 'I’ve signed in' }).click()
  await expect(notice).toHaveCount(0)
  await expect(box).toHaveValue('Please unlock the side gate.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})
