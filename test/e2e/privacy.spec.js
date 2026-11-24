// The public privacy policy: readable without sign-in and without JavaScript, linked where people connect Google.
import { test, expect } from './test.js'

test('privacy policy: no sign-in, protection section, no sideways scroll @mobile', async ({ page, request }) => {
  const raw = await request.get('/privacy')
  expect(raw.status()).toBe(200)
  const html = await raw.text()
  for (const x of ['How we protect your data', 'AES-256-GCM', 'Google data and AI', 'Retention and deletion', '<title>Privacy Policy']) expect(html).toContain(x)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'How we protect your data' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
  await page.goto('/dashboard')
  await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy')
  await page.goto('/')
  await expect(page.locator('footer').getByRole('link', { name: /Privacy/ })).toBeVisible()
})

test('privacy policy without JavaScript', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  const p = await ctx.newPage()
  await p.goto('/privacy')
  await expect(p.getByText('Encryption at rest:')).toBeVisible()
  await ctx.close()
})
