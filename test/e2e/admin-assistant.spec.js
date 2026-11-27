// Platform-admin assistant (server/admin-assist/): "This week" on Admin → Overview (no AI) and the Assistant panel from
// the admin header (desktop side panel, phone bottom sheet). The model is the scripted Workers AI stand-in
// (test/e2e/mock-google.mjs); a consequential request is answered without it. Owners never reach it.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 60_000 })

test('owners never reach the admin assistant', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  expect((await page.request.get('/api/platform/assist')).status()).toBe(403)
  expect((await page.request.post('/api/platform/assist', { data: { question: 'What needs me this week?' }, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(403)
  expect((await page.request.post('/api/platform/assist-approve', { data: { proposal: { type: 'run_reconciliation', before: {} }, confirm: true }, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(403)
})

test('This week on Overview, then the Assistant panel: brief first, an answer from the records, a refusal without AI @mobile', async ({ page, context }, testInfo) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const week = page.locator('[data-this-week]')
  await expect(week.getByRole('heading', { name: 'This week' })).toBeVisible()
  await expect(week).toContainText('From the records, no AI.')
  // Every item links to the admin page that resolves it.
  for (const href of await week.locator('[data-brief-items] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) expect(href).toMatch(/^\/admin/)

  await page.locator('[data-admin-assistant]').click()
  const panel = page.locator('[data-admin-panel]')
  await expect(panel.getByRole('heading', { name: 'Assistant' })).toBeVisible()
  await expect(panel.locator('[data-admin-brief]')).toContainText(/This week|Nothing urgent/)
  await panel.getByRole('button', { name: 'Is anything broken?' }).click()
  const answer = panel.locator('[data-admin-entry="answer"]')
  await expect(answer).toContainText('Start with the urgent items')
  await expect(answer.locator('[data-sources]')).toContainText('open incidents')

  await panel.getByLabel('Ask the assistant').fill('Refund the last payment for that business')
  await panel.getByRole('button', { name: 'Send question' }).click()
  await expect(panel.locator('[data-admin-entry="not_here"]')).toContainText('Money only moves in Stripe')
  await expect(panel.locator('[data-admin-proposal]')).toHaveCount(0)

  // No sideways scroll with the panel open (docked on desktop, a sheet on phones).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (testInfo.project.name === 'mobile') {
    const box = await panel.boundingBox()
    expect(Math.round(box.x)).toBe(0)
  }
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('[data-admin-assistant]')).toHaveAttribute('aria-expanded', 'false')
})
