// Settings as an owner uses them (desktop and phone): services, closed dates, people, invitations, data export, services
// connected, closing request. A fresh person signs in and creates their own business, so nothing else is touched.
import { test, expect } from './test.js'
import { returnFromGoogle, useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('settings: every section works, fits a phone, and consequential actions ask for a recent sign-in @mobile', async ({ page, context }, info) => {
  // Its own visitor address: sign-ins are limited per address and the other specs share one.
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': info.project.name === 'mobile' ? '198.51.100.222' : '198.51.100.221' })
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const c = info.project.name === 'mobile' ? ['owner@e2e-acct-m.example', 'E2E Account Mobile'] : ['owner@e2e-acct.example', 'E2E Account Pools']
  await returnFromGoogle(page, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${c[0]}`)
  await page.goto('/api/auth/google/start?next=/dashboard/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

  // Setup check says what's missing and why.
  const check = page.locator('[data-setup-check]')
  await expect(check.locator('[data-check="no_services"]')).toContainText('The receptionist and assistant can’t say what you do')

  // Services: added here, unit problem explained, then fixed.
  const services = page.locator('#services')
  await services.getByLabel('Service 1', { exact: true }).fill('Weekly Pool Care')
  await services.getByLabel('Price for service 1').fill('$300+')
  await services.getByRole('button', { name: 'Save services' }).click()
  await expect(services.getByRole('status')).toContainText('Saved')
  await expect(check.locator('[data-check="no_services"]')).toHaveCount(0)
  await expect(check.locator('[data-check="price_unit"]')).toContainText('per visit, week or month?')
  await services.getByLabel('Price for service 1').fill('$300+ per month')
  await services.getByRole('button', { name: 'Save services' }).click()
  await expect(check.locator('[data-check="price_unit"]')).toHaveCount(0)
  // The other form on the same record still saves (no false "changed elsewhere").
  const details = page.locator('#details')
  await details.getByLabel(/Business phone/).fill('(843) 555-0142')
  await details.getByRole('button', { name: 'Save details' }).click()
  await expect(details.getByRole('status')).toContainText('Saved')

  // Closed dates and notice.
  const closed = page.locator('#closed-dates')
  await closed.getByLabel('Minimum notice before a visit').selectOption('1440')
  await closed.getByLabel('Another date').fill('2099-12-25')
  await closed.getByLabel(/^Note/).fill('Christmas')
  await closed.getByRole('button', { name: 'Save closed dates and notice' }).click()
  await expect(closed.locator('[data-closures-list]')).toContainText('December 25, 2099')
  await expect(check.locator('[data-check="no_notice"]')).toHaveCount(0)

  // People and invitations.
  const people = page.locator('#people')
  await people.getByLabel(/Invite someone/).fill('teammate@example.org')
  await people.getByRole('button', { name: 'Create invitation' }).click()
  await expect(people.locator('[data-invite-link] input')).toHaveValue(/invite=/)
  await people.getByRole('button', { name: 'Cancel invitation' }).click()
  await expect(people.getByText('teammate@example.org')).toHaveCount(0)

  // Notifications and connected services.
  const notices = page.locator('#notifications')
  await notices.getByLabel('New booking').uncheck()
  await expect(notices.getByLabel('New booking')).not.toBeChecked()
  await expect(page.locator('[data-service="texting"]')).toContainText('Not available yet')

  // Data export: a real file.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#data').getByRole('button', { name: 'Download my data' }).click()])
  expect(dl.suggestedFilename()).toMatch(/-export\.zip$/)

  // Closing: an accurate preview; nothing happens without the typed name.
  const close = page.locator('#close')
  await close.getByRole('button', { name: 'Delete business…' }).click()
  await expect(close.locator('[data-impact]')).toContainText('There’s no plan to end.')
  await expect(close.getByRole('button', { name: 'Permanently delete business' })).toBeDisabled()
  await expect(page.locator('.card', { has: page.getByRole('heading', { name: 'Your own account' }) })).toContainText('You’re the only person in this business')

  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

  // An old session: refused, with the way to sign in again.
  await useSession(context, fixtures.E2E_ACCT_OLD_SESSION_TOKEN)
  await page.reload()
  await page.locator('#data').getByRole('button', { name: 'Download my data' }).click()
  await expect(page.locator('#data [data-reauth]')).toContainText('sign in again')
  expect(errs).toEqual([])
})

test('platform console: closing list, sessions and restrictions ask for a reason', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.locator('[data-closures]')).toContainText('Closing and deletion')
  await page.locator('.row--link', { hasText: 'E2E Other' }).first().click()
  const box = page.locator('[data-business-controls]')
  await box.getByRole('button', { name: 'Switch off Teach Your AI' }).click()
  await expect(box.getByRole('button', { name: 'Switch off', exact: true })).toBeDisabled()
  await box.getByLabel(/^Reason/).fill('browser test')
  await box.getByRole('button', { name: 'Switch off', exact: true }).click()
  await expect(box.locator('[data-feature="teach_ai"]')).toContainText('Off for this business')
  await box.getByRole('button', { name: 'Allow Teach Your AI' }).click()
  await box.getByLabel(/^Reason/).fill('browser test over')
  await box.getByRole('button', { name: 'Allow again' }).click()
  await expect(box.locator('[data-feature="teach_ai"]')).toContainText('Normal')
})
