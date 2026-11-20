// Flagship homepage (2026-11-20): the AI conversation simulation (Mode A), the mode switch to the booking demo
// (Mode B), industry switching from the hero and the industries section, reset, keyboard use, reduced motion, the
// mobile menu, CTA destinations, the protected logo, and no sideways scroll at every brief width. The page calls no
// AI, calendar or voice provider; the simulation stores nothing.
import { test, expect } from './test.js'
import { SCENARIOS } from '../../src/content/conversation.js'

const LOGO_SVG = '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" class="logo-bg"></rect><rect x="7" y="9" width="18" height="16" rx="3" fill="none" stroke="#FF6A1A" stroke-width="2.2"></rect><path d="M11 6.5v4M21 6.5v4" stroke="#FF6A1A" stroke-width="2.2" stroke-linecap="round"></path><path d="m12 17.5 3 3 5.5-6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})
const demo = (page) => page.locator('#demo')
const events = (page) => page.evaluate(() => window.__gsuEvents || [])

test('the logo is the protected brand asset: exact SVG, orange and wordmark in header and footer @mobile', async ({ page }) => {
  for (const where of ['header', 'footer']) {
    const logo = page.locator(`${where} .logo`).first()
    expect((await logo.locator('svg').evaluate((s) => s.outerHTML)).replace(/\s+/g, ' ')).toBe(LOGO_SVG)
    await expect(logo).toHaveText('GetShowUps')
    expect(await logo.locator('svg rect[stroke]').evaluate((r) => getComputedStyle(r).stroke)).toBe('rgb(255, 106, 26)')
    expect(await logo.locator('svg').boundingBox()).toMatchObject({ width: 28, height: 28 })
  }
})

test('first viewport: headline, a real conversation excerpt, one primary and one secondary CTA that work @mobile', async ({ page }) => {
  const hero = page.locator('.hero')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('More booked jobs. Less chasing.')
  await expect(hero.getByText('My pool is green. I’m in Mount Pleasant and need someone Friday.')).toBeVisible()
  await expect(hero.getByRole('list', { name: 'What the AI understood' })).toContainText('Green pool cleanup')
  await expect(hero.getByText(/Simulation · Tidewater Pools is an example/)).toBeVisible()
  await expect(hero.getByText('$499/month')).toBeVisible()
  await hero.getByRole('link', { name: 'See it answer a customer' }).click()
  await expect(page).toHaveURL(/#demo$/)
  await expect(demo(page)).toBeInViewport()
  // Primary CTA: closed enrollment → the early-access calendar section; open → sign-up with the founding plan.
  await expect(hero.getByRole('link', { name: /Request early access/ })).toHaveAttribute('href', '/#book-demo')
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: true } }))
  await page.reload()
  await expect(page.locator('.hero').getByRole('link', { name: /Get started/ })).toHaveAttribute('href', '/dashboard?plan=founding')
})

test('AI conversation: pool scenario end to end — facts, checks, replies, booked; no API calls; nothing stored', async ({ page }) => {
  const api = []
  page.on('request', (r) => /\/api\/(?!enrollment)/.test(r.url()) && api.push(r.url()))
  const d = demo(page)
  await expect(d.getByRole('tab', { name: 'AI conversation' })).toHaveAttribute('aria-selected', 'true')
  await expect(d.getByText(/nothing is sent, booked or stored/)).toBeVisible()
  const pool = SCENARIOS[0]
  for (const [i, t] of pool.turns.entries()) {
    await expect(d.locator('[data-send]')).toHaveText(i === 0 ? /Send the first message/ : /Send the next message/)
    await expect(d.locator('.cv-preview')).toContainText(t.customer.slice(0, 20))
    await d.locator('[data-send]').click()
    await expect(d.locator('.cv-msg--customer').nth(i)).toHaveText(new RegExp(t.customer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await expect(d.locator('.cv-msg--ai').nth(i)).toContainText(t.reply.slice(0, 24))
    for (const [, v] of t.recognized) await expect(d.locator('.cv-facts').nth(i)).toContainText(v.replace(/ ✓.*/, ''))
    await expect(d.locator('.cv-check').nth(i)).toHaveText(t.check)
  }
  await expect(d.locator('.cv-done')).toHaveText(/Booked on the calendar/)
  await expect(d.locator('[data-send]')).toBeDisabled()
  // The owner's view afterwards: real dashboard labels, no personal data beyond the fictional example.
  await d.locator('[data-owner]').click()
  await expect(d.getByRole('region', { name: 'Your dashboard' })).toContainText('Booked the appointment')
  await d.getByRole('button', { name: 'Back to the conversation' }).click()
  await d.getByRole('button', { name: 'Start over' }).first().click()
  await expect(d.locator('.cv-msg--customer')).toHaveCount(0)
  await expect(d.locator('[data-send]')).toHaveText(/Send the first message/)
  expect(api).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0)
  const names = (await events(page)).map((e) => e.name)
  expect(names).toEqual(expect.arrayContaining(['conversation_started', 'conversation_finished']))
  expect(JSON.stringify(await events(page))).not.toMatch(/Jamie|843|Harbor/)
})

test('industry switching: hero buttons, the demo tabs and the industries section all change the scenario and reset it @mobile', async ({ page }) => {
  const d = demo(page)
  await page.locator('.hero [data-try="hvac"]').click()
  await expect(d.locator('[data-conversation]')).toHaveAttribute('data-industry', 'hvac')
  await expect(d.locator('.cv-preview')).toContainText('My AC stopped cooling')
  await d.locator('[data-send]').click()
  await expect(d.locator('.cv-facts').first()).toContainText('Possibly urgent')
  await expect(d.locator('.cv-check').first()).toContainText('urgency before offering times')
  // Switching trade resets progress.
  await d.getByRole('button', { name: /Roofing/ }).click()
  await expect(d.locator('[data-conversation]')).toHaveAttribute('data-industry', 'roofing')
  await expect(d.locator('.cv-msg--customer')).toHaveCount(0)
  await expect(d.getByRole('button', { name: /Roofing/ })).toContainText('upcoming')
  await d.locator('[data-send]').click()
  await expect(d.locator('.cv-facts').first()).toContainText('Storm damage')
  await page.locator('#industries').getByRole('link', { name: /pool service conversation/ }).click()
  await expect(d.locator('[data-conversation]')).toHaveAttribute('data-industry', 'pool')
  await expect(d.locator('.cv-msg--customer')).toHaveCount(0)
})

test('HVAC urgency and roofing hand-off scripts complete; every scenario ends booked only after a clear yes', async ({ page }) => {
  const d = demo(page)
  for (const s of SCENARIOS) {
    await d.getByRole('button', { name: new RegExp(`^${s.label}`) }).click()
    for (let i = 0; i < s.turns.length; i++) {
      await d.locator('[data-send]').click()
      await expect(d.locator('.cv-msg--ai').nth(i)).toContainText(s.turns[i].reply.slice(0, 16)) // one reply per send
    }
    await expect(d.locator('.cv-done')).toBeVisible()
    const text = await d.locator('.cv-chat').innerText()
    expect(text).toMatch(/yes|please|fine/i) // the customer's own confirming words precede the booking line
    expect(text).not.toMatch(/\$\d/) // no prices are ever stated by the scripted AI
  }
})

test('mode switch: the booking page & dashboard demo (Mode B) still works inside the showcase, and back @mobile', async ({ page }) => {
  const d = demo(page)
  await d.getByRole('tab', { name: 'Booking page & dashboard' }).click()
  await expect(d.locator('[data-demo]')).toBeVisible()
  await expect(d.locator('[data-demo]')).toHaveAttribute('data-stage', 'inquiry')
  await expect(d.getByText('Simulation · example business · nothing is sent or booked')).toBeVisible()
  await d.getByRole('button', { name: 'Continue' }).click()
  await expect(d.locator('[data-demo]')).toHaveAttribute('data-stage', 'time')
  await d.getByRole('tab', { name: 'AI conversation' }).click()
  await expect(d.locator('[data-conversation]')).toBeVisible()
  await d.locator('.cv-side-actions').getByRole('button', { name: /booking page instead/ }).isVisible()
})

test('keyboard only: send, read, switch mode and start over without a mouse; focus is visible', async ({ page }) => {
  const d = demo(page)
  await d.locator('[data-send]').focus()
  await page.keyboard.press('Enter')
  await expect(d.locator('.cv-msg--ai').first()).toBeVisible()
  await expect(d.locator('[data-send]')).toBeFocused() // focus is kept while the reply types (never disabled mid-turn)
  await expect(d.locator('[data-send]')).not.toHaveAttribute('aria-busy', 'true')
  await page.keyboard.press('Space')
  await expect(d.locator('.cv-msg--customer')).toHaveCount(2)
  await d.getByRole('button', { name: 'Start over' }).first().focus()
  await page.keyboard.press('Enter')
  await expect(d.locator('.cv-msg--customer')).toHaveCount(0)
  await d.getByRole('tab', { name: 'Booking page & dashboard' }).focus()
  await page.keyboard.press('Enter')
  await expect(d.locator('[data-demo]')).toBeVisible()
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement, ':focus-visible').outlineStyle)
  expect(ring).not.toBe('none')
})

test('reduced motion: no transitions, no typing delay, no smooth scrolling @mobile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto')
  const d = demo(page)
  const t0 = Date.now()
  await d.locator('[data-send]').click()
  await expect(d.locator('.cv-msg--ai').first()).toBeVisible()
  expect(Date.now() - t0).toBeLessThan(600)
  expect(await d.locator('.cv-facts').first().evaluate((e) => getComputedStyle(e).transitionDuration)).toMatch(/^(0s|0\.01ms|1e-05s)$/)
})

test('mobile menu: opens, lists every section, closes on a link and on Escape; both CTAs present @mobile', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone layout only')
  const toggle = page.getByRole('button', { name: 'Open menu' })
  await toggle.click()
  const nav = page.getByRole('navigation', { name: 'Mobile' })
  await expect(nav).toBeVisible()
  for (const l of ['See it work', 'How it works', 'Teach Your AI', 'Pricing', 'FAQ']) await expect(nav.getByRole('link', { name: l })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/dashboard')
  await expect(nav.getByRole('link', { name: /Request early access/ })).toBeVisible()
  await nav.getByRole('link', { name: 'Pricing' }).click()
  await expect(nav).toBeHidden()
  await expect(page.locator('#pricing')).toBeInViewport()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.keyboard.press('Escape')
  await expect(nav).toBeHidden()
})

test('every section and CTA destination; header adapts over dark sections; no sideways scroll at 320–1440 @mobile', async ({ page }) => {
  for (const id of ['problem', 'demo', 'simulation', 'how-it-works', 'teach', 'industries', 'pricing', 'book-demo', 'faq']) await expect(page.locator(`#${id}`)).toBeAttached()
  for (const [href] of [['/dashboard'], ['/privacy'], ['#book-demo']]) await expect(page.locator(`a[href="${href}"]`).first()).toBeAttached()
  await page.locator('#demo').evaluate((e) => window.scrollTo(0, e.offsetTop + 200))
  await expect(page.locator('.site-header')).toHaveClass(/is-dark/)
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.locator('.site-header')).not.toHaveClass(/is-dark/)
  for (const w of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w}px`).toBeLessThanOrEqual(0)
  }
})

test('honest claims: pilot and upcoming are labelled; no invented metrics, testimonials or live-feature promises', async ({ page }) => {
  const text = await page.evaluate(() => document.body.innerText)
  expect(text).toMatch(/In pilot with founding customers/)
  expect(text).toMatch(/Roofing\s*Upcoming/i)
  for (const bad of [/\d+% (more|fewer|increase)/i, /customers? (love|trust) us/i, /testimonial/i, /guarantee/i, /(start|get|try|with) (your |a )?free trial/i, /instant SMS/i, /missed[- ]call text/i]) expect(text).not.toMatch(bad)
  expect(text).toMatch(/Text messaging, email reminders and ad management are coming soon/)
})
