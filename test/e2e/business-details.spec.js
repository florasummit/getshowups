// Business details (docs/quality/USABILITY_FINDINGS.md SET-03, BOOK-08; migration 0045): Settings → Booking hours
// "Different hours on some days" saves and reloads; the booking page of a business customers come to shows the address
// its owner chose to show (time step summary and the confirmation). Own business: e2e-details (no other spec uses it).
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { chooseService, chooseTime, fillDetails } from './booking-flow.js'
import { fixtures } from '../../playwright.config.js'

const ADDRESS = '12 Harbor St, Suite 2, Charleston, SC 29401'

test('settings: a Friday that closes at 4 pm saves, survives a reload, and only Friday changes', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_DETAILS_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  const card = page.locator('#booking-hours')
  await expect(card.locator('[data-hours-note]')).toContainText('apply to every day you select, unless you give a day its own hours below')
  const more = card.locator('[data-day-hours]')
  await more.locator('summary').click()
  // Every selected day is listed, prefilled with the usual hours.
  await expect(more.locator('[data-day]')).toHaveCount(5)
  await expect(more.getByLabel('Monday from')).toHaveValue('09:00')
  await expect(more.getByLabel('Friday to')).toHaveValue('17:00')
  // A day too short for one appointment is refused, naming the day.
  await more.getByLabel('Friday to').fill('09:30')
  await card.getByRole('button', { name: 'Save hours' }).click()
  await expect(card.getByRole('alert')).toContainText('On Friday, at least one appointment has to fit')
  await more.getByLabel('Friday to').fill('16:00')
  await card.getByRole('button', { name: 'Save hours' }).click()
  await expect(card.getByText('Saved.')).toBeVisible()
  const me = await (await page.request.get('/api/dashboard/me')).json()
  expect(me.customer.dayHours).toEqual({ 5: { start: '09:00', end: '16:00' } })
  expect([me.customer.dayStart, me.customer.dayEnd]).toEqual(['09:00', '17:00'])
  // After a reload the disclosure opens by itself on the day that differs.
  await page.reload()
  await expect(page.locator('#booking-hours [data-day-hours]')).toHaveAttribute('open', '')
  await expect(page.locator('#booking-hours').getByLabel('Friday to')).toHaveValue('16:00')
  await expect(page.locator('#booking-hours').getByLabel('Thursday to')).toHaveValue('17:00')
  // The booking page offers no Friday time at or after 4 pm.
  const info = await (await page.request.get(`/api/book/${fixtures.E2E_DETAILS_CUSTOMER}`)).json()
  const late = info.slots.filter((s) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(s)).map((x) => [x.type, x.value]))
    return p.weekday === 'Fri' && Number(p.hour) >= 16
  })
  expect(late).toEqual([])
  // The address card in Business shows the stored address and the choice to show it.
  const address = page.locator('#business [data-business-address-form]')
  await expect(address.getByLabel('Street')).toHaveValue('12 Harbor St')
  await expect(address.getByLabel('Show this address to customers')).toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('booking page: customers who come to the business see its address with the time and on the confirmation', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': '198.51.100.45' })
  await page.goto(`/book/${fixtures.E2E_DETAILS_CUSTOMER}`)
  await chooseService(page, { need: 'A studio visit' })
  await expect(page.locator('.bk-side [data-business-address]')).toHaveText(ADDRESS)
  await chooseTime(page)
  await fillDetails(page, { need: 'A studio visit', name: 'Robin Shore', email: 'robin@details.example' })
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await expect(page.locator('.bk-done [data-business-address]')).toHaveText(`Where: ${ADDRESS}`)
})
