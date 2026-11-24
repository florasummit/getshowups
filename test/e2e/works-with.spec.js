// The "Works with" strip: verified names only, plain text, one still row, no sideways scroll.
import { test, expect } from './test.js'

const NAMES = ['Google Calendar', 'Google sign-in', 'Claude', 'OpenAI']

test('plain-text verified names, no logos, no partnership wording, fits every width @mobile', async ({ page }) => {
  await page.goto('/')
  const strip = page.locator('[data-works-with]')
  await expect(strip.getByRole('heading', { name: 'Works with' })).toBeVisible()
  await expect(strip.getByRole('listitem')).toHaveText(NAMES)
  await expect(strip.locator('img, svg, picture, a, button')).toHaveCount(0)
  expect(await strip.innerText()).not.toMatch(/Google Ads|Stripe|Meta|Facebook|Instagram|partner|certified|official|sponsor/i)
  await expect(strip).toContainText('no endorsement implied')
  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    for (const li of await strip.getByRole('listitem').all()) {
      const b = await li.boundingBox()
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(width)
    }
  }
})
