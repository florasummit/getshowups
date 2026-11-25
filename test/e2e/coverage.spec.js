// Service-area journey (desktop + mobile): a visitor outside the listed ZIPs is never turned away. ZIP typos are asked
// again without clearing the form; an unknown ZIP can be confirmed; a real ZIP outside the list becomes a coverage
// request ("We may be able to help in your area"); the owner approves it; the SAME visitor books from their link
// without typing anything again. Real Functions on local workerd; Google Calendar mocked (loopback).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 90_000 })
const shots = process.env.COVERAGE_SHOTS
// Each simulated visitor gets its own address (documentation range) so this file doesn't use up the shared local
// per-IP booking allowance other specs rely on. In production Cloudflare sets CF-Connecting-IP itself.
let visitor = 10
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': `198.51.100.${visitor++}` })
})

test('outside the service area: kept, owner approves, the same visitor books without starting over @mobile', async ({ page, browser }, testInfo) => {
  const who = `Casey ${testInfo.project.name === 'mobile' ? 'Mobile' : 'Desktop'} ${Date.now().toString(36)}`
  const shot = async (p, name) => {
    if (!shots) return
    await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))) // entrance fades done
    await p.screenshot({ path: `${shots}/${testInfo.project.name}-${name}.png`, fullPage: true })
  }
  await page.goto(`/book/${fixtures.E2E_AREA_CUSTOMER}?utm_source=google&utm_medium=cpc&utm_campaign=e2e-campaign`)
  // The ZIP comes before any time: a business with a service area never shows times to a ZIP it must approve first.
  await page.getByLabel('What do you need?').fill('Green pool cleanup')
  const zip = page.getByLabel(/Your ZIP code/)
  const next = page.getByRole('button', { name: 'See open times' })
  // A typo: asked again, nothing cleared.
  await zip.fill('2940')
  await next.click()
  await expect(page.getByRole('alert')).toHaveText('Please check your ZIP code: it should be 5 digits.')
  await expect(page.getByLabel('What do you need?')).toHaveValue('Green pool cleanup')
  // Not a ZIP we know: check it, or keep it as typed.
  await zip.fill('00000')
  await next.click()
  await expect(page.getByText('We couldn’t find ZIP 00000. Please check it, or continue with it as typed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with 00000' })).toBeVisible()
  await shot(page, 'zip-check')
  // The real ZIP: next to the served one, but not on the list → details for the owner to decide, never times.
  await zip.fill('29407')
  await expect(page.getByRole('button', { name: 'Continue with 00000' })).toHaveCount(0)
  await next.click()
  await expect(page.getByRole('heading', { name: 'We may be able to help in your area' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Pick a/ })).toHaveCount(0)
  await page.getByLabel('Name').fill(who)
  await page.getByLabel('Phone').fill('(555) 010-0177')
  await page.getByLabel('Email').fill('casey@example.net')
  await page.getByRole('button', { name: 'Send request' }).click()
  await expect(page.getByRole('heading', { name: `Thanks, Casey` })).toBeVisible()
  await expect(page.getByText('We may be able to help in your area.')).toBeVisible()
  await expect(page.getByText(/has your details for ZIP 29407 and will confirm availability with you\. You won’t need to fill this in again\./)).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Pick a/ })).toHaveCount(0)
  await expect(page.getByText(/don’t serve/)).toHaveCount(0)
  await shot(page, 'visitor-outside')

  // The owner answers in Appointments.
  const ownerCtx = await browser.newContext({ ...(testInfo.project.use || {}) })
  await useSession(ownerCtx, fixtures.E2E_AREA_SESSION_TOKEN)
  const owner = await ownerCtx.newPage()
  await owner.goto('/dashboard/appointments')
  const row = owner.locator('.row', { hasText: who })
  await expect(row.getByText('Coverage review needed')).toBeVisible()
  await expect(row.getByRole('group', { name: 'Service area request' })).toContainText('ZIP 29407 isn’t on your service list. Can you serve them?')
  await shot(owner, 'owner-review')
  await row.getByRole('button', { name: 'We serve this area' }).click()
  await expect(row.getByText('Area approved')).toBeVisible()
  const link = await row.getByLabel('Their booking link').inputValue()
  expect(link).toMatch(new RegExp(`/book/${fixtures.E2E_AREA_CUSTOMER}\\?lead=[A-Za-z0-9_-]+&k=`))
  await shot(owner, 'owner-approved')
  // After a reload the link is still one click away (approving again changes nothing and sends nothing new).
  await owner.reload()
  await row.getByRole('button', { name: 'Show their booking link' }).click()
  await expect(row.getByLabel('Their booking link')).toHaveValue(link)
  for (const width of [320, 390, 1280]) {
    await owner.setViewportSize({ width, height: 900 })
    expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `overflow at ${width}px`).toBeLessThanOrEqual(0)
  }
  await ownerCtx.close()

  // The same visitor opens their link (e.g. from the email) and books: no form again.
  await page.goto(new URL(link).pathname + new URL(link).search)
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveCount(0)
  // Desktop and mobile run at the same time against one calendar: if a time was just taken (double booking is
  // refused), pick the next one, as a visitor would.
  const booked = page.getByRole('heading', { name: 'You’re booked' })
  for (let i = 0; i < 6 && !(await booked.isVisible()); i++) {
    await page.locator('.bk-slot').first().click()
    await page.getByRole('button', { name: /^Book / }).click()
    await expect(booked.or(page.getByText('That time was just taken. Please pick another.'))).toBeVisible()
  }
  await expect(booked).toBeVisible()
  await shot(page, 'visitor-booked')
})

test('in the service area: books straight away (no coverage step)', async ({ page }) => {
  await page.goto(`/book/${fixtures.E2E_AREA_CUSTOMER}`)
  await page.getByLabel('What do you need?').fill('Weekly pool cleaning')
  await page.getByLabel(/Your ZIP code/).fill('29403')
  await page.getByRole('button', { name: 'See open times' }).click()
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
})
