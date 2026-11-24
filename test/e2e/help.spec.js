// Contextual help: opens beside the setting or number, no request, keyboard, focus back, phone sheet.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('help opens without any request, explains, closes with Escape and gives focus back @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  await page.waitForLoadState('networkidle')
  const calls = []
  page.on('request', (r) => calls.push(r.url()))
  const tip = page.getByRole('button', { name: 'Help: Booking hours' })
  await tip.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('[data-help-panel="hours"]')
  await expect(panel).toBeFocused()
  for (const t of ['Why it matters', 'Next step', 'See an example']) await expect(panel).toContainText(t)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/help-${page.viewportSize().width}.png` })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(tip).toBeFocused()
  expect(calls).toEqual([])
})

// A funnel with and without spend, served to the real page: the numbers here are this test's, never a business's.
const funnel = (spend, days = 30) => ({
  funnel: {
    range: { days, from: '2026-01-01T00:00:00.000Z' },
    spend: { cents: spend, clicks: spend == null ? null : 41, fetchedAt: null, firstDay: spend == null ? null : days === 90 ? '2026-02-10' : '2026-01-01' },
    stages: { leads: 6, qualified: 5, outsideArea: 1, booked: 3, attended: 2, outcomeRecorded: 3, completed: 2 },
    cost: { perLead: spend && 2000, perQualified: spend && 2400, perBooking: spend && 4000, perAttended: spend && 6000, perCompleted: spend && 6000 },
    revenue: { estimatedCents: 40000, invoicedCents: 38000, paidCents: null },
    roas: null,
    attribution: { allLeads: 9, adLeads: 6, importedLeads: 0, unattributed: 3 },
  },
  diagnostics: [],
})
const size = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

test('a metric is selected as a whole, stays in view, and its explanation is ordered: facts, meaning, why, next, ask @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')
  const stats = page.getByRole('region', { name: 'Last 30 days', exact: true })
  await expect(stats.locator('.help-tip')).toHaveCount(0)
  const calls = []
  page.on('request', (r) => calls.push(r.url()))
  const card = stats.getByRole('button', { name: /New inquiries/ })
  expect((await card.boundingBox()).height).toBeGreaterThanOrEqual(44)
  await card.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('[data-help-panel="inquiries"]')
  await expect(panel).toBeFocused()
  await expect(card).toHaveClass(/is-selected/)
  await expect(card).toHaveAttribute('aria-expanded', 'true')
  await expect(panel).toContainText('Measured from your records')
  const text = await panel.innerText()
  const at = ['Measured from your records', 'left their details in the last 30 days', 'Why it matters', 'Next step', 'See an example', 'Ask a follow-up'].map((x) => text.indexOf(x))
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(at[0]).toBeGreaterThan(-1)
  await page.waitForTimeout(700)
  // Nothing covers the metric: it is beside the docked panel, or above the sheet.
  const [a, b] = [await card.boundingBox(), await panel.boundingBox()]
  expect(a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1).toBe(true)
  expect(a.y).toBeGreaterThanOrEqual(0)
  expect(await size(page)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/metric-${page.viewportSize().width}.png` })
  // Another metric swaps the content; the same one closes it; Escape returns focus.
  const booked = stats.getByRole('button', { name: /^\d+ ?Booked/ })
  await booked.click()
  await expect(page.locator('[data-help-panel="booked"]')).toBeFocused()
  await expect(card).not.toHaveClass(/is-selected/)
  await booked.click()
  await expect(page.locator('.help-panel')).toHaveCount(0)
  await card.click()
  await page.keyboard.press('Escape')
  await expect(card).toBeFocused()
  expect(calls).toEqual([])
  // Leaving the page closes it.
  await card.click()
  await page.goto('/dashboard/settings')
  await expect(page.locator('.help-panel')).toHaveCount(0)
})

test('ad results: the row is selected; measured, reported, recorded, estimated and unavailable are told apart @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  let spend = 12000
  await page.route('**/api/dashboard/results?*', (r) => r.fulfill({ json: funnel(spend, Number(new URL(r.request().url()).searchParams.get('days'))) }))
  await page.goto('/dashboard/ads')
  const ar = page.getByRole('region', { name: 'Ad results' })
  await expect(ar.locator('.help-tip')).toHaveCount(0)
  const row = ar.getByRole('row', { name: /^Booked/ })
  await row.getByRole('cell').first().click() // anywhere on the row
  await expect(row).toHaveClass(/is-selected/)
  const panel = page.locator('.help-panel')
  await expect(panel).toContainText('$40 each')
  await expect(panel).toContainText('Measured from your records')
  await page.waitForTimeout(700)
  const [a, b] = [await row.boundingBox(), await panel.boundingBox()]
  expect(a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1).toBe(true)
  expect(await size(page)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/results-${page.viewportSize().width}.png` })
  await ar.getByRole('button', { name: 'Ad spend' }).click()
  await expect(panel).toContainText('Reported by Google')
  await ar.getByRole('button', { name: /Estimated job value/ }).click()
  await expect(panel).toContainText('Includes estimates')
  await ar.getByRole('button', { name: /Invoiced/ }).click()
  await expect(panel).toContainText('Recorded by you')
  await ar.getByRole('button', { name: /^— ?Paid$/ }).click()
  await expect(panel).toContainText('Not available yet')
  await expect(panel.locator('[data-ask-idea]').first()).toHaveText('Why isn’t this available yet?')
  // The value shown follows the page when the period changes.
  await ar.getByRole('button', { name: 'Ad spend' }).click()
  await expect(panel).toContainText('$120')
  spend = null
  await ar.getByRole('button', { name: '90 days' }).click()
  await expect(panel).toContainText('No ad spend reported for this period yet.')
  await expect(panel.locator('[data-ask-idea]')).toHaveCount(1)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `test-results/results-blank-${page.viewportSize().width}.png` })
})

test('reduced motion, and the tablet width uses the sheet without covering the metric', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 900, height: 800 })
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard')
  const card = page.getByRole('region', { name: 'Last 30 days', exact: true }).getByRole('button', { name: /New inquiries/ })
  await card.click()
  const panel = page.locator('.help-panel')
  expect(await panel.evaluate((e) => getComputedStyle(e).animationName)).toBe('none')
  expect(await card.evaluate((e) => parseFloat(getComputedStyle(e, '::after').transitionDuration))).toBeLessThan(0.01)
  const [a, b] = [await card.boundingBox(), await panel.boundingBox()]
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1)
  expect(await size(page)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: 'test-results/metric-900.png' })
})

test('the AI answer follows the selected period: 7, 30 and 90 days, also when switched while the panel is open @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const asked = []
  let hold = null
  await page.route('**/api/dashboard/results?*', async (r) => {
    const days = Number(new URL(r.request().url()).searchParams.get('days'))
    if (hold) await hold.results
    await r.fulfill({ json: funnel(days * 1000, days) })
  })
  await page.route('**/api/dashboard/assist', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { enabled: true } })
    const b = r.request().postDataJSON()
    asked.push(b.days)
    if (hold?.answer) await hold.answer
    await r.fulfill({ json: { answer: `Answer about ${b.days} days.`, days: b.days } }).catch(() => {})
  })
  await page.goto('/dashboard/ads')
  const ar = page.getByRole('region', { name: 'Ad results' })
  await ar.getByRole('button', { name: 'Ad spend' }).click()
  const panel = page.locator('.help-panel')
  const idea = panel.locator('[data-ask-idea]').first()
  for (const days of [30, 7, 90]) {
    await page.evaluate(() => scrollTo(0, 0))
    await ar.getByRole('button', { name: `${days} days` }).click()
    await expect(panel.locator('.help-fact')).toContainText(`Last ${days} days`)
    await expect(panel.locator('.help-fact')).toContainText(`$${days * 10}`)
    await expect(panel.getByText(/^Answer about/)).toHaveCount(0) // the previous period's answer is gone
    await idea.click()
    await expect(panel).toContainText(`Answer about ${days} days.`)
    await expect(panel).toContainText(`the last ${days} days of results`)
  }
  expect(asked).toEqual([30, 7, 90])
  // After switching periods and reading answers the selected row is still in the open.
  await page.waitForTimeout(800)
  const [a, b] = [await ar.getByRole('row', { name: /^Ad spend/ }).boundingBox(), await panel.boundingBox()]
  expect(a.y >= 0 && (a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1)).toBe(true)
  await expect(panel).toContainText('Ad spend is recorded from 2026-02-10') // partial data is disclosed
  // While the next period loads nothing can be asked; a draft question is kept.
  await panel.getByRole('textbox').fill('How is it going?')
  let go
  hold = { results: new Promise((d) => (go = d)) }
  await ar.getByRole('button', { name: '7 days' }).click()
  await expect(panel.locator('.help-fact')).toContainText('Updating…')
  await expect(panel.getByRole('button', { name: 'Send question' })).toBeDisabled()
  go()
  await expect(panel.locator('.help-fact')).toContainText('Last 7 days')
  await expect(panel.getByRole('textbox')).toHaveValue('How is it going?')
  // An answer still on its way when the period changes is dropped.
  let answer
  hold = { answer: new Promise((d) => (answer = d)) }
  await panel.getByRole('button', { name: 'Send question' }).click()
  await expect.poll(() => asked.length).toBe(4)
  await ar.getByRole('button', { name: '30 days' }).click()
  await expect(panel.locator('.help-fact')).toContainText('Last 30 days')
  answer()
  await page.waitForTimeout(400)
  await expect(panel.getByText(/^Answer about/)).toHaveCount(0)
  expect(await size(page)).toBeLessThanOrEqual(0)
})
