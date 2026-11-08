// Public marketing site smoke tests (static build served by wrangler pages dev).
import { test, expect } from './test.js'

let errors
test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto('/')
})

test.afterEach(() => {
  expect(errors, 'no console or page errors').toEqual([])
})

test('homepage renders headline, metadata, and all sections', async ({ page }) => {
  await expect(page).toHaveTitle(/GetShowUps/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Turn More Leads Into Appointments That Actually Show Up')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /appointment/)
  for (const id of ['how-it-works', 'features', 'simulation', 'pricing', 'book-demo', 'faq']) {
    await expect(page.locator(`#${id}`)).toBeAttached()
  }
})

test('every Book a Demo link targets the booking section', async ({ page }) => {
  const links = page.locator('a[href="#book-demo"]')
  // header, mobile nav, hero, pricing, footer CTA, footer link (+1 when the simulation finishes)
  await expect(links).toHaveCount(6)
  await page.getByRole('main').getByRole('link', { name: /Book a Demo/ }).first().click()
  await expect(page.locator('#book-demo')).toBeInViewport()
})

test('booking section is honest when no calendar is configured', async ({ page }) => {
  const section = page.locator('#book-demo')
  await expect(section.getByText('Online booking isn’t connected yet')).toBeVisible()
  await expect(section.locator('iframe')).toHaveCount(0)
  await expect(section.locator('input, textarea, form')).toHaveCount(0)
})

test('simulation is labeled and steps through scenarios', async ({ page }) => {
  const sim = page.locator('#simulation')
  await expect(sim.getByText('Simulation only.')).toBeVisible()
  await expect(sim.getByText('Step 1 of 13')).toBeVisible()
  await sim.getByRole('button', { name: 'Next step' }).click()
  await expect(sim.getByText('Step 2 of 13')).toBeVisible()
  await sim.getByRole('button', { name: 'Missed call' }).click()
  await expect(sim.getByRole('button', { name: 'Missed call' })).toHaveAttribute('aria-pressed', 'true')
  await expect(sim.getByText('Step 1 of 16')).toBeVisible()
  await sim.getByRole('button', { name: 'Next step' }).click()
  await sim.getByRole('button', { name: 'Reset' }).click()
  await expect(sim.getByText('Step 1 of 16')).toBeVisible()
})

test('pricing is marked as proposed and FAQ expands', async ({ page }) => {
  const pricing = page.locator('#pricing')
  await expect(pricing.locator('.price-amount')).toContainText('$299/month')
  await expect(pricing.getByText('Proposed pricing')).toBeVisible()
  const item = page.locator('#faq details').first()
  await item.locator('summary').click()
  await expect(item).toHaveAttribute('open', '')
})

test('unknown paths fall back to the site, not an error @mobile', async ({ page }) => {
  const res = await page.goto('/some/unknown/path')
  expect(res.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test.describe('mobile navigation @mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('menu opens, closes on link and Escape, no horizontal overflow', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Open menu' })
    await expect(toggle).toBeVisible()
    await toggle.click()
    const nav = page.locator('#mobile-nav')
    await expect(nav).toBeVisible()
    await nav.getByRole('link', { name: 'Pricing' }).click()
    await expect(nav).toBeHidden()
    await expect(page.locator('#pricing')).toBeInViewport()

    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(nav).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(nav).toBeHidden()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
