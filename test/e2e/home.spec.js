// Homepage conversion experience: hero, CTA destinations, the interactive "See it work" demo (simulation only),
// funnel events (in-page only, no personal data), keyboard use, reduced motion and every required width.
import { test, expect } from './test.js'

let errors
let apiCalls
const openModeB = async (page) => {
  await page.locator('#demo').getByRole('tab', { name: 'Booking page & dashboard' }).click()
  await expect(page.locator('[data-demo]')).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  errors = []
  apiCalls = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) apiCalls.push(`${r.method()} ${u.pathname}`)
  })
  await page.goto('/', { waitUntil: 'networkidle' }) // page-load reads (enrollment) finish before the demo starts
  // The booking-page demo (Mode B) lives behind the showcase's second tab since the flagship redesign (flagship.spec.js
  // covers Mode A, the AI conversation, and the hero's trade buttons which now pick the conversation's scenario).
  await openModeB(page)
  await page.evaluate(() => window.scrollTo(0, 0))
})
test.afterEach(() => expect(errors, 'no console or page errors').toEqual([]))

const demo = (page) => page.locator('[data-demo]')
const events = (page) => page.evaluate(() => (window.__gsuEvents || []).map((e) => ({ name: e.name, props: e.props })))

test('hero: outcome first, price visible, honest early access, See it work opens the demo @mobile', async ({ page }) => {
  const hero = page.locator('.hero')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('More booked jobs. Less chasing.')
  await expect(hero.getByText('$499/month')).toBeVisible()
  await expect(hero.getByText('Ad spend separate', { exact: false })).toBeVisible()
  // Enrollment is closed on this server (sandbox billing, like production): the primary action is early access.
  const early = hero.getByRole('link', { name: /Request early access/ })
  await expect(early).toHaveAttribute('href', '/#book-demo')
  await expect(hero.getByText('Online enrollment isn’t open yet', { exact: false })).toBeVisible()
  await expect(page.locator('a[href="/dashboard?plan=founding"]')).toHaveCount(0)

  await hero.getByRole('link', { name: 'See it answer a customer' }).click()
  await expect(page).toHaveURL(/#demo$/)
  await expect(demo(page)).toBeInViewport()
  await expect(demo(page).getByRole('note')).toHaveText(/Simulation · example business · nothing is sent or booked/)
  expect((await events(page)).map((e) => e.name)).toContain('hero_cta')

  await page.goto('/')
  await page.locator('.hero').getByRole('link', { name: /Request early access/ }).click()
  await expect(page).toHaveURL(/#book-demo$/)
  await expect(page.locator('#book-demo')).toBeInViewport()
  await expect(page.locator('#book-demo').getByRole('heading', { name: 'Request early access' })).toBeVisible()
  await expect(page.locator('#book-demo').getByText('What happens next')).toBeVisible()
  expect(await events(page)).toContainEqual({ name: 'early_access_cta', props: { location: 'hero' } })
})

test('demo, in-area path: inquiry → times → booked → outcome → summary; owner view follows each step; nothing sent @mobile', async ({ page }) => {
  const d = demo(page)
  const owner = d.locator('[data-owner]')
  const before = apiCalls.length
  await expect(d).toHaveAttribute('data-industry', 'pool')
  await expect(owner.getByRole('heading', { name: 'Waiting for an inquiry' })).toBeVisible()

  // Inquiry: the chosen request is what the owner sees.
  await d.getByRole('radio', { name: 'Green pool' }).check()
  await expect(d.locator('[data-request-text]')).toContainText('turned green')
  await d.getByRole('button', { name: 'Continue' }).click()
  await expect(d).toHaveAttribute('data-stage', 'time')
  await expect(owner.getByRole('heading', { name: 'Haven’t booked yet' })).toBeVisible()
  await expect(owner.locator('[data-lead]')).toContainText('turned green')
  await expect(owner.getByText('ZIP 29464: in your service area')).toBeVisible()
  await expect(d.locator('.dm-stage[aria-current="step"]')).toHaveText(/Booking/)

  // Booking: nothing until a time is chosen; then the owner sees it on the calendar.
  const book = d.getByRole('button', { name: /Choose a time|^Book / })
  await expect(book).toBeDisabled()
  await d.getByRole('group', { name: 'Day' }).getByRole('button').nth(1).click()
  await d.getByRole('radio', { name: '1:00 PM' }).check()
  await expect(book).toBeEnabled()
  await book.click()
  await expect(d.getByRole('heading', { name: 'Visit booked' })).toBeVisible()
  await expect(d.getByText('A calendar invitation is on its way to jordan@example.com.')).toBeVisible()
  await expect(owner.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  await expect(owner.getByText('On your Google Calendar')).toBeVisible()
  await expect(owner.locator('.dm-lead-when')).toContainText('1:00 PM · 60 min visit')

  // After the visit: the owner records the outcome and (optionally) their own estimate.
  await owner.getByRole('button', { name: 'Job done' }).click()
  await owner.getByRole('button', { name: 'Save $350' }).click()
  const summary = owner.locator('[data-summary]')
  await expect(summary).toContainText('Inquiries1')
  await expect(summary).toContainText('Job done1')
  await expect(summary).toContainText('$350')
  await expect(summary.getByText('never counted as money received', { exact: false })).toBeVisible()
  await expect(d.locator('.dm-stage.is-done')).toHaveCount(4)
  await expect(d.getByRole('link', { name: /Request early access/ })).toHaveAttribute('href', '/#book-demo')

  // Start over resets everything.
  await d.getByRole('button', { name: 'Start over' }).click()
  await expect(d).toHaveAttribute('data-stage', 'inquiry')
  await expect(d.getByRole('radio', { name: 'Weekly service' })).toBeChecked()
  await expect(owner.getByRole('heading', { name: 'Waiting for an inquiry' })).toBeVisible()

  // The whole run called no API, and the funnel events carry codes only.
  expect(apiCalls.slice(before)).toEqual([])
  const ev = await events(page)
  expect(ev.map((e) => e.name)).toEqual(expect.arrayContaining(['demo_started', 'demo_step', 'demo_finished', 'demo_reset']))
  expect(ev).toContainEqual({ name: 'demo_finished', props: { industry: 'pool', outcome: 'done' } })
  expect(JSON.stringify(ev)).not.toMatch(/Jordan|example\.com|555|Harbor|turned green/i)
})

test('demo, outside the area: no times, owner approves (link) or declines (kept, never bookable)', async ({ page }) => {
  const d = demo(page)
  const owner = d.locator('[data-owner]')
  await d.getByRole('radio', { name: /29910 · Bluffton/ }).check()
  await d.getByRole('button', { name: 'Continue' }).click()
  await expect(d.getByText('We may be able to help in your area.')).toBeVisible()
  await expect(d.getByRole('radio', { name: /AM|PM/ })).toHaveCount(0)
  await expect(owner.getByRole('heading', { name: 'Coverage review needed' })).toBeVisible()
  await expect(owner.getByText('ZIP 29910: not in your listed ZIPs')).toBeVisible()
  await expect(d.locator('.dm-stage[aria-current="step"]')).toHaveText(/Service-area check/)

  await owner.getByRole('button', { name: 'Decline' }).click()
  await expect(owner.getByRole('heading', { name: 'Area declined' })).toBeVisible()
  await expect(owner.getByText('ZIP 29910: area declined')).toBeVisible()
  await expect(d.getByRole('radio', { name: /AM|PM/ })).toHaveCount(0)

  await d.getByRole('button', { name: 'Start over' }).click()
  await d.getByRole('radio', { name: /29910 · Bluffton/ }).check()
  await d.getByRole('button', { name: 'Continue' }).click()
  await owner.getByRole('button', { name: 'Approve area' }).click()
  await expect(d.getByText('Opened from the booking link Tidewater Pools sent.')).toBeVisible()
  await expect(owner.getByText('ZIP 29910: area approved')).toBeVisible()
  await expect(d.getByRole('radio', { name: '8:00 AM' })).toBeVisible()
})

test('industry switching: hero buttons and the demo tabs change business, requests and ZIPs, and reset progress', async ({ page }) => {
  const d = demo(page)
  await d.getByRole('button', { name: 'Continue' }).click()
  await expect(d).toHaveAttribute('data-stage', 'time')

  // The hero's trade buttons now pick the AI conversation's scenario (flagship.spec.js); Mode B's own trade tabs
  // still switch its business, and switching resets progress.
  await d.getByRole('group', { name: 'Business type' }).getByRole('button', { name: 'Electrical' }).click()
  await expect(d).toHaveAttribute('data-industry', 'electrical')
  await expect(d).toHaveAttribute('data-stage', 'inquiry')
  await expect(d.getByRole('group', { name: 'Business type' }).getByRole('button', { name: 'Electrical' })).toHaveAttribute('aria-pressed', 'true')
  await expect(d.getByText('Bright Line Electric').first()).toBeVisible()
  await expect(d.getByRole('radio', { name: 'EV charger' })).toBeVisible()
  await expect(d.getByRole('radio', { name: /29405 · North Charleston/ })).toBeChecked()

  await d.getByRole('group', { name: 'Business type' }).getByRole('button', { name: 'HVAC' }).click()
  await expect(d.getByText('Lowcountry Air').first()).toBeVisible()
  await expect(d.getByRole('radio', { name: 'AC not cooling' })).toBeChecked()
  await d.getByRole('button', { name: 'Continue' }).click()
  await d.getByRole('radio', { name: '7:30 AM' }).check()
  await d.getByRole('button', { name: /^Book / }).click()
  await expect(d.locator('.dm-lead-when')).toContainText('90 min visit')
  expect(await events(page)).toEqual(expect.arrayContaining([{ name: 'demo_industry', props: { industry: 'electrical' } }, { name: 'demo_industry', props: { industry: 'hvac' } }]))
})

test('keyboard only: the demo can be completed without a mouse and focus follows the change', async ({ page }) => {
  const d = demo(page)
  await d.getByRole('radio', { name: 'Weekly service' }).focus()
  await page.keyboard.press('ArrowRight') // radio group: next request
  await expect(d.getByRole('radio', { name: 'Green pool' })).toBeChecked()
  await d.getByRole('button', { name: 'Continue' }).focus()
  await page.keyboard.press('Enter')
  await expect(d.getByRole('heading', { name: 'Pick a visit time' })).toBeFocused()
  await d.getByRole('radio', { name: '8:00 AM' }).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Tab') // → Book button (radios are one tab stop)
  await page.keyboard.press('Enter')
  await expect(d.locator('[data-owner]').getByRole('heading', { name: 'Upcoming' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(d.getByRole('button', { name: 'Job done' })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(d.getByRole('button', { name: /^Save \$/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(d.locator('[data-summary]')).toBeVisible()
  // Every control in the demo has an accessible name.
  for (const el of await d.locator('button, a, input').all()) {
    const name = await el.evaluate((e) => (e.labels?.[0]?.textContent || e.getAttribute('aria-label') || e.textContent || '').trim())
    expect(name.length, await el.evaluate((e) => e.outerHTML.slice(0, 80))).toBeGreaterThan(0)
  }
})

test('reduced motion: no animations or smooth scrolling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await openModeB(page)
  await demo(page).getByRole('button', { name: 'Continue' }).click()
  const lead = demo(page).locator('[data-lead]')
  const dur = await lead.evaluate((e) => parseFloat(getComputedStyle(e).animationDuration))
  expect(dur).toBeLessThan(0.001)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto')
})

for (const width of [320, 375, 390, 768, 1024, 1440]) {
  test(`no sideways scroll and a usable first screen at ${width}px`, async ({ browser }) => {
    const mobile = width < 768
    const ctx = await browser.newContext({ viewport: { width, height: mobile ? 760 : 900 }, isMobile: mobile, hasTouch: mobile })
    const page = await ctx.newPage()
    await page.goto('/')
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - Math.min(innerWidth, screen.width))
    expect(await wide()).toBeLessThanOrEqual(0)
    // Headline and primary action on the first screen.
    const cta = page.locator('.hero').getByRole('link', { name: /Request early access|Get started/ })
    await expect(cta).toBeInViewport()
    const box = await cta.boundingBox()
    expect(box.height).toBeGreaterThanOrEqual(44)
    await openModeB(page)
    // Walk the demo to the end: still no sideways scroll.
    const d = demo(page)
    await d.getByRole('button', { name: 'Continue' }).click()
    await d.getByRole('radio', { name: '10:30 AM' }).check()
    await d.getByRole('button', { name: /^Book / }).click()
    await d.getByRole('button', { name: 'Job done' }).click()
    await d.getByRole('button', { name: 'Skip' }).click()
    await expect(d.locator('[data-summary]')).toBeVisible()
    expect(await wide()).toBeLessThanOrEqual(0)
    await ctx.close()
  })
}

test('early access: when the GetShowUps business runs its own receptionist (enrollment.salesChat), the section offers that chat; otherwise nothing is shown @mobile', async ({ page }) => {
  // This server has no GetShowUps business record: salesChat is false, no chat link.
  await expect(page.locator('#book-demo [data-sales-chat]')).toHaveCount(0)
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: false, salesChat: true } }))
  await page.reload({ waitUntil: 'networkidle' })
  await openModeB(page)
  const link = page.locator('#book-demo [data-sales-chat]')
  await expect(link).toHaveText('Ask our AI about GetShowUps')
  await expect(link).toHaveAttribute('href', '/chat/getshowups')
  await expect(page.locator('#book-demo').getByRole('heading', { name: 'Request early access' })).toBeVisible()
})

test('early access goes through our own booking page when it runs: every button carries its location, campaign codes from the ad are kept, the section offers open times @mobile', async ({ page }) => {
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: false, salesChat: true } }))
  await page.goto('/', { waitUntil: 'networkidle' })
  const hero = page.locator('.hero').getByRole('link', { name: /Request early access/ })
  await expect(hero).toHaveAttribute('href', '/book/getshowups?utm_source=homepage&utm_medium=site&utm_campaign=cta_hero')
  await expect(page.locator('#pricing [data-start-location="pricing"]')).toHaveAttribute('href', /utm_campaign=cta_pricing$/)
  await openModeB(page)
  const section = page.locator('#book-demo [data-sales-booking]')
  await expect(section.getByRole('link', { name: 'See open times' })).toHaveAttribute('href', '/book/getshowups?utm_source=homepage&utm_medium=site&utm_campaign=cta_section')
  await expect(page.locator('#book-demo iframe')).toHaveCount(0)
  await expect(page.locator('#book-demo').getByText('Pick a time on our booking page. It goes straight onto our calendar.')).toBeVisible()
  // A visitor from an ad keeps the ad's codes all the way to the booking page.
  await page.goto('/?utm_source=openai&utm_medium=paid&utm_campaign=gsu-gpt-a', { waitUntil: 'networkidle' })
  await expect(page.locator('.hero').getByRole('link', { name: /Request early access/ })).toHaveAttribute('href', '/book/getshowups?utm_source=openai&utm_medium=paid&utm_campaign=gsu-gpt-a')
})
