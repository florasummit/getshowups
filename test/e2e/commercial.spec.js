// Admin → Growth → Partners and Pipeline (src/admin/Commercial.jsx) against the real Functions on local workerd: a platform
// admin adds a referral partner with explicitly typed terms (no defaults) and takes it through onboarding (agreement
// version, recorded acceptance, activation, a scheduled terms version, pause, end); payout details refuse account
// numbers; payouts are not recordable in test billing (server-side payout rules: test/commercial.test.js); the link keeps
// the code in the visitor's browser as a first-touch candidate; the pipeline shows totals by channel with revenue
// "Unavailable" in test billing, and never scrolls the page sideways. The referral program is off in this environment
// (REFERRALS_ENABLED unset), so the page says no commission accrues. Each project uses its own partner name.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 60_000 })

test('Growth → Partners: add a partner with typed terms (no defaults), its link keeps the first touch; payout details refuse account numbers @mobile', async ({ page, context }, testInfo) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const name = `E2E Partner ${testInfo.project.name} ${Date.now() % 100000}`
  await page.goto('/admin/growth#partners')
  await expect(page.locator('[data-growth-mode="partners"]')).toHaveAttribute('aria-selected', 'true')
  const view = page.locator('[data-com-partners]')
  await expect(view.locator('[data-referrals="off"]')).toContainText('no commission accrues')
  await expect(view).toContainText('Partners have no sign-in and see nothing')
  // No terms are filled in for the admin.
  for (const f of ['value', 'windowDays', 'type', 'recurring']) await expect(view.locator(`[data-com-new] [data-terms="${f}"]`)).toHaveValue('')
  // A half-typed term is refused next to its field, and the typed values stay.
  await view.locator('[data-partner-name]').fill(name)
  await view.locator('[data-com-new] [data-terms="type"]').selectOption('percent')
  await view.locator('[data-com-new] [data-terms="value"]').fill('15')
  await view.locator('[data-partner-create]').click()
  await expect(view.locator('[data-com-new] .field-error')).toContainText('how long the commission runs')
  await expect(view.locator('[data-partner-name]')).toHaveValue(name)
  await view.locator('[data-com-new] [data-terms="recurring"]').selectOption('months')
  await view.locator('[data-com-new] [data-terms="months"]').fill('12')
  await view.locator('[data-com-new] [data-terms="windowDays"]').fill('60')
  await view.locator('[data-partner-create]').click()
  await expect(view.locator('[data-com-new]').getByRole('status')).toContainText(`Added ${name} as invited`)
  const row = view.locator('[data-partner]', { hasText: name })
  await expect(row).toHaveAttribute('data-status', 'invited')
  await expect(row.locator('[data-partner-owed]')).toContainText('unavailable while billing is in test mode')
  const code = (await row.locator('code').textContent()).trim()
  expect(code).toMatch(/^[a-z0-9]{10}$/)
  await row.locator('[data-partner-open]').click()
  await expect(row.locator('[data-partner-terms]')).toContainText('Version 1 in effect: 15% of each collected payment (tax excluded), payments in the first 12 months')
  await expect(row.locator('[data-terms-history] [data-terms-version="1"]')).toContainText('In effect')
  // Onboarding checklist: activation is blocked until the agreement is accepted (and says why).
  await expect(row.locator('[data-check="terms"]')).toHaveAttribute('data-done', 'yes')
  await expect(row.locator('[data-check="agreement"]')).toHaveAttribute('data-done', 'no')
  await expect(row.locator('[data-activate-blocked]')).toContainText('To activate:')
  await expect(row.locator('[data-move="active"]')).toBeDisabled()
  // Payout details: words only; an account number is refused and the typed text stays.
  const payout = row.locator('[data-details="payoutReference"]')
  await payout.fill('Bank account 0123456789')
  await row.locator('[data-details-save]').click()
  await expect(row.locator('[data-partner-details]').getByRole('alert')).toContainText('Bank and card numbers are never stored here')
  await expect(payout).toHaveValue('Bank account 0123456789')
  await payout.fill('PayPal business account, on file with finance')
  await row.locator('[data-details-save]').click()
  await expect(row.locator('[data-partner-details]').getByRole('status')).toContainText('Details saved')
  await expect(row.locator('[data-check="payoutDetails"]')).toHaveAttribute('data-done', 'yes')
  await expect(row.locator('[data-partner-payouts]')).toContainText('Test-mode commissions are never payable')
  const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(width, 'no sideways page scroll').toBeLessThanOrEqual(0)

  // The referral link: the code is kept in the visitor's browser (first touch), the page is the normal homepage.
  const visitor = await context.browser().newContext()
  const v = await visitor.newPage()
  await v.goto(`/r/${code.toUpperCase()}`)
  await expect(v).toHaveURL(new RegExp(`/\\?partner=${code}$`))
  expect(JSON.parse(await v.evaluate(() => localStorage.getItem('gsu_partner'))).map((c) => c.code)).toEqual([code])
  await visitor.close()
})

// Desktop only: the agreement versions are shared by every partner, so one project owns adding them (the mobile run above
// never activates, so a new version can't race it).
test('Growth → Partners: agreement version, acceptance recorded by the admin, activation, a new terms version, pause, end', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const stamp = Date.now() % 1000000
  const name = `E2E Onboarded ${stamp}`
  await page.goto('/admin/growth#partners')
  const view = page.locator('[data-com-partners]')
  const agreements = view.locator('[data-agreements]')
  if (await agreements.locator('[data-agreement-new]').isVisible()) await agreements.locator('[data-agreement-new]').click()
  await agreements.locator('[data-agreement="title"]').fill('GetShowUps partner agreement')
  await agreements.locator('[data-agreement="versionLabel"]').fill(`e2e-${stamp}`)
  await agreements.locator('[data-agreement-save]').click()
  await expect(agreements.locator('.field-error')).toContainText('Paste the agreement text or give a link')
  await agreements.locator('[data-agreement="url"]').fill('https://getshowups.com/partners/agreement')
  await agreements.locator('[data-agreement-save]').click()
  await expect(agreements.getByRole('status')).toContainText(`Added agreement version e2e-${stamp}`)
  await expect(agreements.locator('[data-agreement-current]')).toContainText(`version e2e-${stamp}`)

  await view.locator('[data-partner-name]').fill(name)
  await view.locator('[data-com-new] [data-terms="type"]').selectOption('fixed')
  await view.locator('[data-com-new] [data-terms="value"]').fill('100')
  await view.locator('[data-com-new] [data-terms="currency"]').fill('usd')
  await view.locator('[data-com-new] [data-terms="recurring"]').selectOption('once')
  await view.locator('[data-com-new] [data-terms="windowDays"]').fill('30')
  await view.locator('[data-partner-create]').click()
  const row = view.locator('[data-partner]', { hasText: name })
  await row.locator('[data-partner-open]').click()
  await expect(agreements.locator('[data-not-accepted]')).toContainText(name)
  // Record the acceptance of the current version (the admin records it: partners have no sign-in).
  await expect(row.locator('[data-accept="agreementId"] option').first()).toContainText(`e2e-${stamp} (current)`)
  await row.locator('[data-accept="evidence"]').fill('Signed copy in the shared drive')
  await row.locator('[data-accept-save]').click()
  await expect(row.locator('[data-acceptances]')).toContainText(`Accepted version e2e-${stamp}`)
  await expect(row.locator('[data-check="agreement"]')).toHaveAttribute('data-done', 'yes')
  await row.locator('[data-move="active"]').click()
  await expect(row).toHaveAttribute('data-status', 'active')
  // A new terms version, scheduled: the history keeps both, version 1 stays in effect until then.
  await row.locator('[data-partner-edit]').click()
  const terms = row.locator('[data-partner-terms-section]')
  await terms.locator('[data-terms="type"]').selectOption('percent')
  await terms.locator('[data-terms="value"]').fill('10')
  await terms.locator('[data-terms="recurring"]').selectOption('lifetime')
  await terms.locator('[data-terms="windowDays"]').fill('45')
  await terms.locator('[data-terms="effectiveFrom"]').fill(`${new Date().getUTCFullYear() + 1}-01-01`)
  await terms.locator('[data-terms-save]').click()
  await expect(terms.getByRole('status')).toContainText('Saved terms version 2')
  await expect(row.locator('[data-terms-history] [data-terms-version="2"]')).toContainText('Scheduled')
  await expect(row.locator('[data-partner-terms]')).toContainText('Version 1 in effect')
  await row.locator('[data-move="paused"]').click()
  await expect(row).toHaveAttribute('data-status', 'paused')
  await row.locator('[data-move="ended"]').click()
  await row.getByRole('button', { name: 'End partnership' }).last().click()
  await expect(row).toHaveAttribute('data-status', 'ended')
  await expect(row.locator('[data-partner-edit]')).toHaveCount(0)
})

test('Growth → Pipeline: totals by channel and the businesses, with revenue unavailable in test billing; admin only @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/growth#pipeline')
  const view = page.locator('[data-com-pipeline]')
  await expect(view).toContainText('Billing is in test mode')
  const totals = view.locator('[data-com-totals="channel"]')
  for (const k of ['self_serve', 'founder', 'sales_rep', 'partner']) await expect(totals.locator(`[data-com-group="${k}"]`)).toHaveCount(1)
  await expect(totals.locator('[data-com-group="self_serve"] td').nth(7)).toHaveText('Unavailable')
  await expect(view.locator('[data-com-rows] [data-com-row]').first()).toBeVisible()
  await view.locator('[data-com-filter="partner"]').click()
  await expect(view.locator('[data-com-filter="partner"]')).toHaveAttribute('aria-pressed', 'true')
  const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(width, 'no sideways page scroll').toBeLessThanOrEqual(0)
  // Owners never reach it.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  expect((await page.request.get('/api/platform/commercial')).status()).toBe(403)
})
