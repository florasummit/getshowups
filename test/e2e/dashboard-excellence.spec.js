// Dashboard and settings usability findings (docs/quality/USABILITY_FINDINGS.md): DASH-01, 04, 05, 06, SET-01, 03, 04, 06,
// ONB-12, ONB-13. Read-only on the tour business (nothing is saved here); flows that change records are covered where
// their own business lives (modes.spec.js: outcome + amount; selfserve.spec.js: cancel).
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

const phone = (info) => info.project.name === 'mobile'
const zips = async (page) => (await (await page.request.get('/api/dashboard/me')).json()).customer.serviceZips

test('overview: one attention list, people first, one vocabulary; an urgent row is on the first screen @mobile', async ({ page, context }, info) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard')
  const rows = page.locator('.ui-attention-list li')
  await expect(rows.first()).toContainText('waiting for a call back')
  await expect(page.locator('[data-setup-check]')).toHaveCount(0) // no second list on Overview
  await expect(page.getByRole('region', { name: 'Needs your attention' })).toHaveCount(1)
  // Severity words: Urgent / Important only, and the urgent customer comes before any setup notice.
  const pills = await rows.locator('.ui-pill').allInnerTexts()
  expect(new Set(pills.map((t) => t.trim()))).toEqual(new Set(['Urgent', 'Important']))
  await expect(rows.first().locator('.ui-pill')).toHaveText('Urgent')
  const kinds = await rows.evaluateAll((els) => els.map((e) => (e.dataset.check ? 'setup' : 'person')))
  expect(kinds.join(',')).toMatch(/^(person,)+(setup,?)*$/)
  const box = await rows.first().boundingBox()
  if (phone(info)) expect(box.y + box.height, 'the urgent row is inside the first screen').toBeLessThanOrEqual(page.viewportSize().height)
  await expect(page.locator('.app-main')).not.toContainText(/\d{4}-\d{2}-\d{2}/)
  // "Review" lands on the card where that person is, with a way to reach them; Follow-ups shows the same count.
  await rows.filter({ hasText: 'asked but hasn’t booked' }).getByRole('button', { name: 'Review' }).click()
  const card = page.locator('#not-booked')
  await expect(card).toBeInViewport()
  await expect(card.locator('[data-follow-up]').first().getByRole('link', { name: /^Call/ })).toHaveAttribute('href', /^tel:/)
  await card.getByRole('button', { name: 'write to them in Follow-ups' }).click()
  await expect(page.locator('[data-unbooked-count]')).toContainText('1 person asked in the last 30 days and hasn’t booked yet')
  // One statement of whether messages go out: never "on" beside "email isn't available".
  const auto = page.locator('[data-automation]')
  if ((await auto.getAttribute('data-automation')) === 'blocked') await expect(auto).toContainText('nothing is being sent')
  await expect(page.getByText('Email isn’t available right now, so automatic emails are not being sent.')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('settings: the section menu is always in reach and names every card; calendar once; no dead rows; no plan talk without a plan @mobile', async ({ page, context }, info) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  await expect(page.locator('#close')).toContainText('Permanently deletes')
  await page.waitForLoadState('networkidle')
  // Every card heading has an entry.
  const headings = await page.locator('.app-main h2.card-title').allInnerTexts()
  const entries = await page.locator('.settings-jump option').allInnerTexts()
  for (const h of headings) expect(entries.some((e) => e === h || e.startsWith(`${h} (`)), `menu entry for “${h}”`).toBe(true)
  for (const must of ['What customers should know', 'Details on your website (phone number)']) expect(entries).toContain(must)
  // Reachable from the middle of the page, and it takes you there.
  await page.evaluate(() => window.scrollTo(0, 3000))
  const menu = page.locator('[data-settings-menu]')
  await expect(menu).toBeInViewport()
  if (phone(info)) await menu.getByRole('combobox').selectOption('policies')
  else await menu.getByRole('link', { name: 'What customers should know' }).click()
  await expect(page.locator('#policies').getByRole('heading', { name: 'What customers should know' })).toBeInViewport()
  const [m, h] = [await menu.boundingBox(), await page.locator('#policies h2').boundingBox()]
  expect(h.y, 'the heading stops below the menu, not under it').toBeGreaterThanOrEqual(m.y + m.height - 1)
  // Google Calendar: one card, not also a row in Connected services.
  await expect(page.locator('.app-main h2', { hasText: 'Google Calendar' })).toHaveCount(1)
  await expect(page.locator('[data-services] [data-service="calendar"]')).toHaveCount(0)
  // Every "Not connected" row has its action.
  const off = page.locator('[data-services] li', { has: page.locator('.ui-pill', { hasText: 'Not connected' }) })
  for (const row of await off.all()) await expect(row.getByRole('button')).toHaveCount(1)
  // Hours: the card says the times apply to every selected day (SET-03).
  await expect(page.locator('#booking-hours [data-hours-note]')).toContainText('apply to every day you select')
  // A business without a plan is never sent to "Plan and billing" (SET-01).
  await expect(page.locator('#plan')).toBeEmpty()
  await expect(page.locator('.app-main')).not.toContainText('Plan and billing')
  await expect(page.locator('#people')).not.toContainText('changes the plan')
  await page.locator('#close').getByRole('button', { name: /Delete business…|Ask to close/ }).click()
  await expect(page.locator('#close [data-impact]')).toContainText('1 person loses access')
  await expect(page.locator('#close')).not.toContainText('cancel your plan')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('settings: named time zones, a ZIP list is never saved unseen, and service fields show their whole value @mobile', async ({ page, context }) => {
  // The visit business: saving its unchanged details touches nothing another spec reads differently.
  await useSession(context, fixtures.E2E_HOME_SESSION_TOKEN)
  const before = await zips(page)
  await page.goto('/dashboard/settings')
  const biz = page.locator('#business')
  // ONB-13: named US zones first, fewer than 20 entries, the stored value unchanged.
  const tz = biz.locator('[data-time-zone]')
  await expect(tz).toBeVisible()
  const options = await tz.locator('option').allInnerTexts()
  expect(options.length).toBeLessThan(20)
  expect(options.slice(0, 3)).toEqual(['Eastern Time', 'Central Time', 'Mountain Time'])
  expect(options.at(-1)).toBe('Other time zone…')
  await expect(tz).toHaveValue(/^[A-Za-z_]+\/[A-Za-z_/]+$/)
  // SET-04: odd entries are named by the field and the save is held until the owner decides.
  const field = biz.getByLabel(/Service ZIP codes/)
  await field.fill(`${before.join(', ')}, 2946, ABCDE`)
  await expect(biz.locator('[data-zip-warning]')).toContainText('2946, ABCDE')
  await biz.getByRole('button', { name: 'Save business' }).click()
  await expect(biz.getByRole('alert')).toContainText('don’t look like 5-digit ZIP codes')
  await expect(biz.getByRole('button', { name: 'Save anyway' })).toBeVisible()
  await expect(biz.getByRole('button', { name: 'Save business' })).toBeEnabled()
  expect(await zips(page)).toEqual(before) // nothing was stored
  // Fixed: the warning goes and the save goes through, confirmed where the owner is looking (SET-02).
  await field.fill(before.join(', '))
  await expect(biz.locator('[data-zip-warning]')).toHaveCount(0)
  await biz.getByRole('button', { name: 'Save business' }).click()
  await expect(biz.getByRole('status')).toHaveText('Saved.')
  await expect(biz.getByRole('button', { name: 'Save business' })).toBeEnabled()
  expect(await zips(page)).toEqual(before)
  // ONB-12: a service name and a price are fully visible in their fields (typed, not saved).
  const svc = page.locator('#services')
  await svc.getByLabel('Service 1', { exact: true }).fill('Weekly pool cleaning')
  await svc.getByLabel('Price for service 1').fill('$95 diagnostic')
  for (const label of ['Service 1', 'Price for service 1']) expect(await svc.getByLabel(label, { exact: true }).evaluate((e) => e.scrollWidth <= e.clientWidth), `${label} shows its whole value`).toBe(true)
})

test('help opens in the page; the assistant answers its own suggestion from the records and names the place for a change it did not prepare @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_HOME_SESSION_TOKEN)
  const mail = []
  page.on('request', (r) => r.url().startsWith('mailto:') && mail.push(r.url()))
  await page.goto('/dashboard/settings')
  await expect(page.getByRole('link', { name: 'Help', exact: true })).toHaveCount(0) // no bare mailto link
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  const help = page.locator('[data-help-panel="help"]')
  await expect(help.locator('.help-email')).toHaveText('hello@getshowups.com')
  await expect(help.locator('[data-help-topic]').first()).toBeVisible()
  expect(mail).toEqual([])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Assistant' }).click()
  const panel = page.locator('.help-panel')
  await panel.getByRole('button', { name: 'What are my hours?' }).click()
  const last = panel.locator('.ask-entry').last()
  await expect(last).toContainText('Your booking hours: ')
  await expect(last).toContainText('Eastern Time')
  await expect(last.locator('[data-ai-out]')).toHaveCount(0)
  // A change the (stand-in) model answers with something unrelated: the exact place, a link, and no claim.
  await panel.getByRole('textbox').fill('Stop taking bookings on Fridays')
  await page.keyboard.press('Enter')
  await expect(last).toContainText('Booking hours are in Settings')
  await expect(last).toContainText('Nothing was changed.')
  await expect(panel).not.toContainText('Start by checking')
  await expect(last.locator('[data-proposal]')).toHaveCount(0)
  await panel.locator('[data-ask-go="settings#booking-hours"]').last().click()
  await expect(page.locator('#booking-hours h2')).toBeInViewport()
})
