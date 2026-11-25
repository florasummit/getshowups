// Test sessions on real workerd: pair, approve in the console, use the test business's dashboard, be refused elsewhere, revoke.
import { createHash, randomBytes } from 'node:crypto'
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ retries: 0, timeout: 60_000 })
test('a paired runner reaches one test business only, and nothing after it is revoked', async ({ page, context, browser, baseURL }) => {
  const biz = fixtures.E2E_IMPORT_CUSTOMER
  const secret = randomBytes(32).toString('base64url')
  const head = { Origin: baseURL }
  const p = await page.request.post('/api/acceptance/pair', { headers: head, data: { secretHash: createHash('sha256').update(secret).digest('hex') } })
  expect(p.status()).toBe(200)
  const { code } = await p.json()
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const card = page.locator('[data-acceptance]')
  await card.getByLabel('Pairing code').fill(code)
  await card.getByLabel('Test business').selectOption(biz)
  const approve = card.getByRole('button', { name: 'Approve' })
  await expect(approve).toBeDisabled()
  await card.getByLabel('Type its id to confirm').fill(biz)
  await card.getByRole('checkbox').check()
  await approve.click()
  await expect(card.getByRole('status')).toContainText('Approved for 90 days')

  const runner = await browser.newContext({ baseURL })
  const s = await runner.request.post('/api/acceptance/session', { headers: { ...head, Authorization: `Bearer ${secret}` } })
  expect([s.status(), (await s.json()).customer]).toEqual([200, biz])
  const token = /__Host-gsu_acceptance=([^;]+)/.exec(s.headers()['set-cookie'])[1]
  await runner.addCookies([{ name: '__Host-gsu_acceptance', value: token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }])
  expect((await runner.request.post('/api/acceptance/fixture', { headers: head })).status()).toBe(200)
  const dash = await runner.newPage()
  await dash.goto('/dashboard')
  await expect(dash.locator('section[aria-label="Needs your attention"]')).toContainText('1 customer is waiting for a call back')
  for (const path of ['/api/platform/overview', '/api/platform/acceptance', '/api/dashboard/billing', '/api/dashboard/calendar', '/api/dashboard/ads', `/api/book/${fixtures.E2E_CUSTOMER}`]) expect((await runner.request.get(path)).status(), path).toBe(403)
  for (const path of ['/api/dashboard/hours', '/api/dashboard/automations', '/api/dashboard/account', '/api/platform/status', `/api/book/${fixtures.E2E_CUSTOMER}/lead`]) expect((await runner.request.post(path, { headers: head, data: {} })).status(), path).toBe(403)
  const me = await (await runner.request.get(`/api/dashboard/me?customer=${fixtures.E2E_CUSTOMER}`)).json()
  expect([me.customer.id, me.testBusiness]).toEqual([biz, true])

  page.once('dialog', (d) => d.accept())
  await card.getByRole('button', { name: 'Revoke' }).first().click()
  await expect(card.getByRole('status')).toContainText('Revoked')
  expect((await runner.request.get('/api/dashboard/me')).status()).toBe(403)
  expect((await runner.request.post('/api/acceptance/session', { headers: { ...head, Authorization: `Bearer ${secret}` } })).status()).toBe(401)
  // The owner's own sign-in is unaffected.
  await useSession(runner, fixtures.E2E_IMPORT_SESSION_TOKEN)
  expect((await runner.request.get('/api/dashboard/me')).status()).toBe(200)
  await runner.close()
})
