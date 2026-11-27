// Admin → Growth → Partners and Pipeline (src/admin/Commercial.jsx) against the real Functions on local workerd: a platform
// admin adds a referral partner with explicitly typed terms (no defaults), copies its link, pauses it; the link keeps
// the code in the visitor's browser as a first-touch candidate; the pipeline shows totals by channel with revenue
// "Unavailable" in test billing, and never scrolls the page sideways. The referral program is off in this environment
// (REFERRALS_ENABLED unset), so the page says no commission accrues. Each project uses its own partner name.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 60_000 })

test('Growth → Partners: add a partner with typed terms, copy its link, pause it; nothing accrues while the program is off @mobile', async ({ page, context }, testInfo) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const name = `E2E Partner ${testInfo.project.name} ${Date.now() % 100000}`
  await page.goto('/admin/growth#partners')
  await expect(page.locator('[data-growth-mode="partners"]')).toHaveAttribute('aria-selected', 'true')
  const view = page.locator('[data-com-partners]')
  await expect(view.locator('[data-referrals="off"]')).toContainText('no commission accrues')
  await expect(view).toContainText('Partners have no sign-in and see nothing')
  // No terms are filled in for the admin.
  for (const f of ['value', 'windowDays']) await expect(view.locator(`[data-com-new] [data-terms="${f}"]`)).toHaveValue('')
  for (const f of ['type', 'recurring']) await expect(view.locator(`[data-com-new] [data-terms="${f}"]`)).toHaveValue('')
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
  await expect(view.locator('[data-com-new]').getByRole('status')).toContainText(`Added ${name}`)
  const row = view.locator('[data-partner]', { hasText: name })
  await expect(row).toContainText('Active')
  await expect(row.locator('[data-partner-terms]')).toContainText('15% of each collected payment (tax excluded), payments in the first 12 months')
  await expect(row.locator('[data-partner-owed]')).toContainText('unavailable while billing is in test mode')
  const code = (await row.locator('code').textContent()).trim()
  expect(code).toMatch(/^[a-z0-9]{10}$/)
  await row.locator('[data-partner-toggle]').click()
  await expect(row).toContainText('Paused')
  await expect(row.getByRole('status')).toContainText('new referrals and commissions stop')
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
