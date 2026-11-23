// Visual tour: every key screen, desktop and phone, on a fictional business with real-looking history
// (seed-tour.mjs). Read-only (no clicks that change data). Always checks the basics every screen must meet:
// exactly one page heading, no sideways scrolling, nothing announced as an error. With TOUR_SHOTS=<dir> it also saves
// full-page screenshots for visual review (before/after comparisons).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const ID = fixtures.E2E_TOUR_CUSTOMER
const SHOTS = process.env.TOUR_SHOTS
const SCREENS = [
  ['overview', '/dashboard', true],
  ['appointments', '/dashboard/appointments', true],
  ['followups', '/dashboard/followups', true],
  ['receptionist', '/dashboard/receptionist', true],
  ['website', '/dashboard/website', true],
  ['settings', '/dashboard/settings', true],
  ['ads', '/dashboard/ads', true],
  ['chat', `/chat/${ID}`, false],
  ['booking', `/book/${ID}`, false],
]

for (const [name, path, owner] of SCREENS) {
  test(`tour: ${name} @mobile`, async ({ page, context }, info) => {
    if (owner) await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
    // The tour business's domain still points at Squarespace (public DNS, mocked).
    if (name === 'website') await page.request.post(`http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}/__dns`, { data: { type: 'CNAME', name: 'www.harborpool.example', values: ['ext-cust.squarespace.com'] } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(path)
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 })
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no sideways scrolling').toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
    if (name === 'overview') {
      // Attention rows: on a phone the sentence keeps the full width and the action sits beneath it; on a desktop beside it.
      const row = page.locator('.ui-attention-list li').first()
      const text = await row.locator('.ui-attention-text').boundingBox()
      const btn = await row.locator('.btn').boundingBox()
      if (info.project.name === 'mobile') expect(btn.y, 'action below the sentence').toBeGreaterThanOrEqual(text.y + text.height - 1)
      else expect(btn.x, 'action beside the sentence').toBeGreaterThan(text.x + text.width - 1)
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png`, fullPage: true, animations: 'disabled' })
    if (name === 'receptionist' && SHOTS) {
      const open = page.getByRole('button', { name: /Morgan Diaz/ }).first()
      if (await open.count()) {
        await open.click()
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: `${SHOTS}/${info.project.name}-receptionist-detail.png`, fullPage: true, animations: 'disabled' })
      }
    }
  })
}
