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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('More booked jobs. Less chasing.')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /appointment/)
  // #simulation stays as an alias of the demo so old links still land on it.
  for (const id of ['problem', 'demo', 'simulation', 'how-it-works', 'teach', 'industries', 'pricing', 'book-demo', 'faq']) {
    await expect(page.locator(`#${id}`)).toBeAttached()
  }
})

test('one Get started action: every start link carries the founding plan to sign-up (enrollment open)', async ({ page }) => {
  // Go-live state (live billing on). The e2e server itself is sandbox-only, like production today.
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: true } }))
  await page.reload()
  const starts = page.locator('a[href="/dashboard?plan=founding"]')
  // header, mobile nav, hero, pricing, footer CTA
  await expect(starts).toHaveCount(5)
  await expect(page.getByRole('main').getByRole('link', { name: /Get started/ }).first()).toBeVisible()
  await expect(page.locator('a[href="/dashboard"]').first()).toHaveText('Sign in')
  // The sign-up screen itself is exercised in selfserve.spec.js (signed out, /api/dashboard/me is a 401 there).
})

test('enrollment closed (sandbox billing, as in production today): visitors are told before Google sign-in @mobile', async ({ page }) => {
  // Real endpoint: the e2e server has test-mode Stripe and no live billing.
  expect((await (await page.request.get('/api/enrollment')).json()).open).toBe(false)
  const early = page.locator('a[href="/#book-demo"]', { hasText: 'Request early access' })
  await expect(early).toHaveCount(5) // header, mobile nav, hero, pricing, footer CTA
  await expect(page.locator('a[href="/dashboard?plan=founding"]')).toHaveCount(0)
  await expect(page.locator('.hero').getByText('Online enrollment isn’t open yet', { exact: false })).toBeVisible()
  await expect(page.locator('#pricing').getByText('Online enrollment isn’t open yet', { exact: false })).toBeVisible()
  // Existing accounts, invitations and testers still sign in.
  await expect(page.locator('a[href="/dashboard"]').first()).toHaveText('Sign in')
  await page.getByRole('main').getByRole('link', { name: 'Request early access' }).first().click()
  await expect(page).toHaveURL(/#book-demo$/)
  await expect(page.locator('#book-demo')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('no unsupported claims anywhere on the page, the interactive demo included', async ({ page }) => {
  // The demo is a simulation but it must still only show what works today (no texting, reminders or AI replies).
  const text = await page.evaluate(() => document.body.innerText)
  for (const claim of [/AI assistant/i, /qualifies them by text/i, /missed[- ]call text/i, /instant SMS/i]) expect(text).not.toMatch(claim)
  // Email messages to real customers are off in production (MESSAGES_LIVE unset: test recipients only), so the page
  // must not present email confirmations, reminders or follow-ups as working today.
  for (const claim of [/email confirmations/i, /reminds (them|customers)/i, /reminder emails/i, /get a follow-up/i]) expect(text).not.toMatch(claim)
  await expect(page.getByText('Text messaging, email reminders and ad management are coming soon', { exact: false })).toBeVisible()
})

// The scripted SMS simulation (texting isn't live) was replaced by the booking demo (#demo, home.spec.js), which shows
// only what works today. Its labelling, controls, keyboard use and phone fit are covered there.

test('booking section is honest when no calendar is configured', async ({ page }) => {
  const section = page.locator('#book-demo')
  await expect(section.getByText('Online booking isn’t connected yet')).toBeVisible()
  await expect(section.locator('iframe')).toHaveCount(0)
  await expect(section.locator('input, textarea, form')).toHaveCount(0)
})

test('pricing shows the founding plan, no trial, ad spend separate; FAQ expands', async ({ page }) => {
  const pricing = page.locator('#pricing')
  await expect(pricing.locator('.price-amount')).toContainText('$499/month')
  await expect(pricing.getByText('No free trial', { exact: false })).toBeVisible()
  await expect(pricing.getByText('Advertising spend is separate', { exact: false })).toBeVisible()
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
