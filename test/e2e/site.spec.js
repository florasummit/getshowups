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

test('one Get started action: every start link carries the founding plan to sign-up', async ({ page }) => {
  const starts = page.locator('a[href="/dashboard?plan=founding"]')
  // header, mobile nav, hero, pricing, footer CTA
  await expect(starts).toHaveCount(5)
  await expect(page.getByRole('main').getByRole('link', { name: /Get started/ }).first()).toBeVisible()
  await expect(page.locator('a[href="/dashboard"]').first()).toHaveText('Sign in')
  // The sign-up screen itself is exercised in selfserve.spec.js (signed out, /api/dashboard/me is a 401 there).
})

test('no unsupported claims: no AI texting or missed-call promises outside the labelled simulation', async ({ page }) => {
  // The simulation is a scripted preview; everything else on the page must describe only what works today.
  const text = await page.evaluate(() => {
    const body = document.body.cloneNode(true)
    body.querySelector('#simulation')?.remove()
    return body.innerText
  })
  for (const claim of [/AI assistant/i, /qualifies them by text/i, /missed[- ]call text/i, /instant SMS/i]) expect(text).not.toMatch(claim)
  await expect(page.getByText('Text messaging and ad management are coming soon', { exact: false })).toBeVisible()
})

// Regression guard: the interactive SMS simulation is a product demonstration that must stay on the homepage,
// clearly labelled as a scripted simulation (texting is not live).
test('SMS simulation: on the homepage, labelled, Next/Play/Pause/Reset, scenarios, keyboard', async ({ page }) => {
  await expect(page.getByRole('banner').getByRole('link', { name: 'Simulation' })).toHaveAttribute('href', '#simulation')
  const sim = page.locator('#simulation')
  await expect(sim.getByRole('heading', { name: 'Watch one lead go from inquiry to appointment' })).toBeVisible()
  const note = sim.getByRole('note')
  await expect(note).toContainText('Simulation only.')
  await expect(note).toContainText('Text messaging is coming soon')
  const progress = sim.locator('.sim-progress')
  const log = sim.getByRole('list', { name: 'Simulated conversation' })
  await expect(log).toHaveAttribute('aria-live', 'polite')
  await expect(progress).toHaveText(/^Step 1 of \d+$/)
  const total = Number((await progress.textContent()).match(/of (\d+)/)[1])
  const reset = sim.getByRole('button', { name: 'Reset' })
  const next = sim.getByRole('button', { name: /Next step/ })
  await expect(reset).toBeDisabled()

  // Next step (keyboard): one message per step, stage progress follows.
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(progress).toHaveText(`Step 2 of ${total}`)
  await expect(log.locator('li')).toHaveCount(2)
  await page.keyboard.press('Space')
  await expect(progress).toHaveText(`Step 3 of ${total}`)
  await expect(sim.locator('.sim-stage[aria-current="step"]')).toHaveCount(1)

  // Reset returns to the first message.
  await reset.click()
  await expect(progress).toHaveText(`Step 1 of ${total}`)
  await expect(log.locator('li')).toHaveCount(1)

  // Play advances on its own; Pause stops it; Next is disabled while playing.
  await sim.getByRole('button', { name: 'Play' }).click()
  await expect(next).toBeDisabled()
  await expect(progress).toHaveText(`Step 2 of ${total}`, { timeout: 5000 })
  await sim.getByRole('button', { name: 'Pause' }).click()
  const paused = await progress.textContent()
  await page.waitForTimeout(2000)
  await expect(progress).toHaveText(paused)

  // Run to the end: the call to action appears and points at the booking section; Replay restarts.
  for (let i = 0; i < total && (await next.isEnabled()); i++) await next.click()
  await expect(progress).toHaveText(`Step ${total} of ${total}`)
  await expect(sim.getByRole('link', { name: /book a call/ })).toHaveAttribute('href', '#book-demo')
  await expect(sim.getByRole('button', { name: 'Replay' })).toBeVisible()

  // Every scenario plays from its first step; switching scenarios resets the thread.
  const choices = sim.getByRole('group', { name: 'Choose a scenario' }).getByRole('button')
  const n = await choices.count()
  expect(n).toBeGreaterThanOrEqual(2)
  for (let i = 0; i < n; i++) {
    await choices.nth(i).click()
    await expect(choices.nth(i)).toHaveAttribute('aria-pressed', 'true')
    await expect(progress).toHaveText(/^Step 1 of \d+$/)
    await expect(log.locator('li')).toHaveCount(1)
  }
})

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

  test('SMS simulation fits a phone screen and its controls work', async ({ page }) => {
    const sim = page.locator('#simulation')
    await sim.scrollIntoViewIfNeeded()
    await sim.getByRole('button', { name: /Next step/ }).click()
    await expect(sim.locator('.sim-progress')).toHaveText(/^Step 2 of \d+$/)
    for (const sel of ['.sim', '.sim-phone', '.sim-controls']) {
      const box = await sim.locator(sel).first().boundingBox()
      expect(box.x, `${sel} starts on screen`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `${sel} fits the viewport`).toBeLessThanOrEqual(390 + 1)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

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
