// Permanent account deletion in the browser (local workerd, ACCOUNT_DELETION_ENABLED on locally only, Stripe and
// Google mocked): owner confirms by typing the business name → everything stops at once, billing ends, data erased;
// the founder sees the deletion record. MOCK DATA throughout; nothing external is touched.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', retries: 0 })

test('owner permanently deletes the account: typed confirmation; site, booking and access end at once; admin sees the record', async ({ page, context, browser }) => {
  const id = fixtures.E2E_DELETE_CUSTOMER
  expect((await page.request.get(`/api/book/${id}`)).status()).toBe(200)
  await useSession(context, fixtures.E2E_DELETE_SESSION_TOKEN)
  await page.goto('/dashboard/settings')
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Delete account' }) })
  await expect(card).toContainText('There is no undo')
  await expect(card).toContainText('cancel your plan in Billing instead')
  await card.getByRole('button', { name: 'Delete account…' }).click()
  const confirm = card.getByRole('button', { name: 'Permanently delete account' })
  await card.getByLabel(/Type the business name/).fill('E2E Delete')
  await expect(confirm).toBeDisabled()
  await card.getByLabel(/Type the business name/).fill('e2e delete pools')
  await expect(confirm).toBeEnabled()
  // The assistant's conversations in this browser go with the account.
  await page.evaluate(() => localStorage.setItem('gsu:assistant:v1:e2e-delete:o', '[]'))
  await confirm.click()
  await expect(page.locator('[data-account-deleted]')).toContainText('Your account is being deleted')

  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gsu:assistant')))).toEqual([])
  // At once: no access to the business, booking page and public API gone.
  expect((await page.request.get('/api/dashboard/me')).status()).toBe(401) // signed out everywhere
  expect((await page.request.get(`/api/book/${id}`)).status()).toBe(404)

  // The founder sees it under Deleted accounts with the completed record; billing ended (Stripe stand-in).
  const admin = await browser.newContext()
  await useSession(admin, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const a = await admin.newPage()
  const errs = []
  a.on('pageerror', (e) => errs.push(e.message))
  await a.goto('/admin')
  const first = await (await a.request.get(`/api/platform/customer?id=${id}`)).json()
  expect({ status: first.deletion.status, step: first.deletion.step, lastError: first.deletion.lastError ?? null, report: first.deletion.report }).toMatchObject({ status: 'completed', step: 'done', lastError: null })
  const deleted = a.getByRole('region', { name: 'Deleted accounts' })
  await deleted.locator('.row--link').first().click()
  await expect(a.locator('[data-deletion="completed"]')).toContainText('Retained only: billing records, audit entries and this record')
  expect(errs).toEqual([])
  await expect(a.locator('[data-stage="deleted"]')).toContainText('Deleted')
  await expect(a.locator('[data-ads-hold="account_deleted"]')).toContainText('on hold: account deleted')
  const o = await (await a.request.get('/api/platform/overview')).json()
  expect(o.customers.find((c) => c.id === id).deleted).toBe(true)
  expect(o.metrics.customers.total).toBe(o.customers.filter((c) => !c.testBusiness && !c.deleted).length)
  const detail = await (await a.request.get(`/api/platform/customer?id=${id}`)).json()
  expect(detail.deletion.report.billing).toEqual({ canceled: 1, customerDeleted: true })
  expect(detail.deletion.report.verify.clean).toBe(true)
  expect(detail.totals.leads).toBe(0)
  const log = await (await a.request.get(`/api/platform/audit?customer=${id}`)).json()
  expect(log.chain.ok).toBe(true)
  expect(log.entries.map((e) => e.action)).toContain('account.deletion_completed')
  expect(JSON.stringify(log)).not.toContain('e2e-delete.example')
  await admin.close()
})
