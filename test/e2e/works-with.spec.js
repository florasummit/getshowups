// The "Works with" strip: verified names only, plain text, pausable, still under reduced motion, no sideways scroll.
import { test, expect } from './test.js'

const NAMES = ['Google Calendar', 'Google sign-in', 'Claude', 'OpenAI', 'Your own domain']
const anim = (page) => page.locator('.ww-track').evaluate((e) => [getComputedStyle(e).animationName, getComputedStyle(e).animationPlayState])

test('plain-text verified names, no logos, no partnership wording; pause stops the motion @mobile', async ({ page }) => {
  await page.goto('/')
  const strip = page.locator('[data-works-with]')
  await expect(strip.getByRole('heading', { name: 'Works with' })).toBeVisible()
  await expect(strip.getByRole('listitem')).toHaveText(NAMES) // the loop's copy is hidden from assistive technology
  await expect(strip.locator('img, svg, picture, a')).toHaveCount(0)
  expect(await strip.innerText()).not.toMatch(/Google Ads|Stripe|Meta|Facebook|Instagram|partner|certified|official|sponsor/i)
  await expect(strip).toContainText('No affiliation or endorsement implied')
  expect(await anim(page)).toEqual(['ww-move', 'running'])
  await strip.getByRole('button', { name: 'Pause moving list' }).click()
  await page.mouse.move(0, 0)
  expect(await anim(page)).toEqual(['ww-move', 'paused'])
  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const [a, b] = await page.locator('.ww-group').evaluateAll((l) => l.map((e) => e.getBoundingClientRect().width))
    expect(Math.abs(a - b), 'equal halves: seamless loop').toBeLessThan(1)
    expect(a).toBeGreaterThanOrEqual((await page.locator('.ww-window').boundingBox()).width - 1)
  }
})

test('reduced motion: a still list, every name visible once @mobile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  expect((await anim(page))[0]).toBe('none')
  const w = await page.locator('.ww-window').boundingBox()
  for (const li of await page.locator('.ww-group').first().locator('li').all()) {
    const b = await li.boundingBox()
    expect(b.x + b.width).toBeLessThanOrEqual(w.x + w.width + 1)
  }
  await expect(page.locator('.ww-copy')).toBeHidden()
  await expect(page.locator('.ww-pause')).toBeHidden()
})
