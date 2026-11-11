// On-site visit businesses (appointment mode 'at_customer') in the browser, against the real Functions
// on local workerd with mock Google. at_business behavior is covered by app.spec.js (unchanged).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('visit booking: service address is required and lands on the calendar event', async ({ page }) => {
  await page.goto(`/book/${fixtures.E2E_HOME_CUSTOMER}`)
  await expect(page.getByRole('heading', { name: 'Book a visit' })).toBeVisible()
  await expect(page.getByLabel('ZIP', { exact: true })).toBeVisible()
  await page.getByLabel('What do you need?').fill('Green pool cleanup')
  await page.getByLabel('Name').fill('Robin Homeowner')
  await page.getByLabel('Phone').fill('(555) 010-0177')
  await page.getByLabel('Email').fill('robin@example.net')
  await page.getByLabel('Street address').fill('21 Tide Ln')
  await page.getByLabel('City').fill('Charleston')
  await page.getByLabel('State').fill('zz')
  await page.getByLabel('ZIP', { exact: true }).fill('29403')
  await page.getByRole('button', { name: 'Choose a time' }).click()
  await expect(page.getByRole('alert')).toHaveText('Please enter the two-letter state, like SC.')
  await page.getByLabel('State').fill('sc')
  await page.getByRole('button', { name: 'Choose a time' }).click()
  await expect(page.getByRole('heading', { name: 'Pick a visit time' })).toBeVisible()
  // The mock calendar is shared by all businesses and other specs book the first slot in parallel,
  // so take the last offered slot to avoid a cross-spec race (production calendars are separate).
  await page.locator('.slot').last().click()
  await page.getByRole('button', { name: /^Book / }).click()
  await expect(page.getByRole('heading', { name: 'Visit booked' })).toBeVisible()
  await expect(page.getByText('E2E Home Service will visit 21 Tide Ln.')).toBeVisible()

  const events = await (await page.request.get(`${mock}/__events`)).json()
  const event = events.find((e) => e.attendees?.[0]?.email === 'robin@example.net')
  expect(event.location).toBe('21 Tide Ln, Charleston, SC 29403')
})

test('owner records visit outcome separately from job completion, then reports job value', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_HOME_SESSION_TOKEN)
  await page.goto('/dashboard/appointments')
  const pending = page.locator('.card', { has: page.getByRole('heading', { name: 'How did these visits go?' }) })
  const row = pending.locator('.row', { hasText: 'Val Visit' })
  await expect(row.getByText('7 Harbor Way, Charleston, SC 29403')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Couldn’t visit' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Visited, not done' })).toBeVisible()
  await row.getByRole('button', { name: 'Job done' }).click()
  await pending.locator('.row', { hasText: 'Val Visit' }).getByRole('button', { name: 'Done', exact: true }).click()

  const results = page.locator('.card', { has: page.getByRole('heading', { name: 'Past' }) })
  await expect(results.locator('.row', { hasText: 'Val Visit' }).locator('.tag--ok')).toHaveText('Job done')
  await results.getByRole('button', { name: 'Add job value' }).click()
  await results.getByLabel('Job value in dollars').fill('350')
  await results.getByRole('button', { name: 'Save' }).click()
  await expect(results.getByRole('button', { name: '$350' })).toBeVisible()

  await page.getByRole('link', { name: 'Overview' }).click()
  await expect(page.getByRole('region', { name: 'Last 30 days', exact: true }).locator('.stat', { hasText: 'Visits' }).locator('.stat-value')).toHaveText('1')
  await expect(page.getByRole('region', { name: 'Last 30 days', exact: true }).locator('.stat', { hasText: 'Show-up rate' })).toHaveCount(0)
})

test('settings: mode choice shown and saved; hours label reflects visits', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_HOME_SESSION_TOKEN)
  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByLabel('At the customer’s location')).toBeChecked()
  await expect(page.getByLabel('Visit length')).toBeVisible()
})

test('at_business regression: booking page has no address step @mobile', async ({ page }) => {
  await page.goto(`/book/${fixtures.E2E_CUSTOMER}`)
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible()
  await expect(page.getByLabel('Street address')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('visit outcome buttons stay inside the card on mobile @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_HOME_SESSION_TOKEN)
  await page.goto('/dashboard')
  const row = page.locator('.row', { hasText: 'Mo Mobile' })
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'How did these visits go?' }) })
  await expect(row.getByRole('button', { name: 'Job done' })).toBeVisible()
  const [c, b] = [await card.boundingBox(), await row.getByRole('button', { name: 'Job done' }).boundingBox()]
  expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width)
  expect(b.x).toBeGreaterThanOrEqual(c.x)
})

test('visit booking page fits on mobile @mobile', async ({ page }) => {
  await page.goto(`/book/${fixtures.E2E_HOME_CUSTOMER}`)
  await expect(page.getByLabel('Street address')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
