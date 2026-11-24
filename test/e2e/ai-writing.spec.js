// Writing help in Settings: improve → use → undo, refusal of invented facts; nothing is saved until the owner saves.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('suggest, use, undo, discard; an invented fact is refused; nothing is saved @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  const saves = []
  page.on('request', (r) => r.method() === 'POST' && /\/api\/dashboard\/(policies|profile)$/.test(r.url()) && saves.push(r.url()))
  await page.goto('/dashboard/settings')
  const box = page.locator('textarea[name="beforeVisit"]')
  const help = page.locator('[data-ai-write="beforeVisit"]')
  await expect(help.locator('[data-ai-action="draft"]')).toHaveCount(0)
  await box.fill('unlock the gate please')
  await help.getByRole('button', { name: 'Improve' }).click()
  await expect(help.locator('.ai-write-suggestion')).toContainText('Kindly note: unlock the gate please')
  await expect(box).toHaveValue('unlock the gate please')
  await help.getByRole('button', { name: 'Use this' }).click()
  await expect(box).toHaveValue('Kindly note: unlock the gate please')
  await help.getByRole('button', { name: 'Undo' }).click()
  await expect(box).toHaveValue('unlock the gate please')
  await box.fill('we keep a lighthouse here')
  await help.getByRole('button', { name: 'Shorten' }).click()
  await expect(help.getByRole('alert')).toContainText('couldn’t confirm')
  await expect(box).toHaveValue('we keep a lighthouse here')
  await page.locator('[data-ai-write="description"]').getByRole('button', { name: 'Draft for me' }).click()
  await expect(page.locator('[data-ai-write="description"] .ai-write-suggestion')).toContainText('Pool care you can book online.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  await page.locator('[data-ai-write="description"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `test-results/ai-writing-${page.viewportSize().width}.png` })
  await page.locator('[data-ai-write="description"]').getByRole('button', { name: 'Discard' }).click()
  expect(saves).toEqual([])
})
