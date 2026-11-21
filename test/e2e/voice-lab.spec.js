// Voice Lab (/admin/voice-lab) on local workerd with VOICE_LAB_ENABLED=true and NO provider configured (as in
// production today): the page says so honestly, nothing can be started, non-admins get neither the tab nor the API,
// and the layout fits a phone. No provider, no microphone, no session is created.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const noSideScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width))).toBeLessThanOrEqual(0)

test('admin: provider statuses are honest (none configured), start is disabled with the reason, test businesses only, dry-run warning, sessions empty @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await page.getByRole('link', { name: 'Voice Lab' }).click()
  await expect(page).toHaveURL(/\/admin\/voice-lab$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Voice Lab' })).toBeVisible()
  const root = page.locator('[data-voice-lab]')
  await expect(root).toHaveAttribute('data-voice-lab', 'idle')
  // Every provider: not configured, with the reason in words, straight from /api/platform/voice-lab/status.
  const status = await (await page.request.get('/api/platform/voice-lab/status')).json()
  for (const id of ['retell', 'openai', 'elevenlabs']) {
    expect(status.providers[id].configured).toBe(false)
    const card = page.locator(`[data-provider="${id}"]`)
    await expect(card).toHaveAttribute('data-configured', 'false')
    await expect(card).toContainText('Not configured')
    await expect(card).toContainText('Unavailable: not configured')
  }
  expect(JSON.stringify(status)).not.toMatch(/sk-|whsec|Bearer/)
  // Start is disabled for an unconfigured provider, whichever is selected, and says why.
  for (const id of ['openai', 'elevenlabs', 'retell']) {
    await page.locator(`[data-provider="${id}"]`).click()
    await expect(page.locator('[data-lab-start]')).toBeDisabled()
    await expect(page.locator('[data-lab-blocker]')).toContainText('Unavailable: not configured')
  }
  // Only admin-marked test businesses are offered (the server's list), never a real customer.
  const overview = await (await page.request.get('/api/platform/overview')).json()
  const offered = await page.locator('[data-lab-business] option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean))
  expect(offered.length).toBeGreaterThan(0)
  expect(offered).toEqual(status.businesses.map((b) => b.id))
  for (const id of offered) expect(overview.customers.find((c) => c.id === id)?.testBusiness).toBe(true)
  expect(offered).not.toContain(fixtures.E2E_CUSTOMER)
  // Budget line from the server's limits; dry run on by default; turning it off warns about a real appointment.
  await expect(page.locator('[data-budget]')).toContainText(`${status.limits.usedMinutesToday} of ${status.limits.dailyMinutes} minutes used today`)
  await expect(page.locator('[data-dry-run]')).toHaveAttribute('data-dry-run', 'on')
  await expect(page.locator('[data-dry-run-warning]')).toHaveCount(0)
  await page.locator('[data-dry-run] input').uncheck()
  await expect(page.locator('[data-dry-run-warning]')).toContainText('REAL appointment')
  await page.locator('[data-dry-run] input').check()
  await expect(page.locator('[data-dry-run-warning]')).toHaveCount(0)
  await expect(page.locator('[data-lab-sessions]')).toContainText('No Lab session yet.')
  await noSideScroll(page)
  // Deep link works too.
  await page.goto('/admin/voice-lab')
  await expect(page.getByRole('heading', { level: 1, name: 'Voice Lab' })).toBeVisible()
  await noSideScroll(page)
})

test('non-admins: no console (so no tab) and the Lab API refuses; signed-out gets 401; starting a session as an owner is refused', async ({ browser }) => {
  const owner = await browser.newContext()
  await useSession(owner, fixtures.E2E_SESSION_TOKEN)
  const op = await owner.newPage()
  await op.goto('/admin/voice-lab')
  await expect(op.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  await expect(op.getByRole('link', { name: 'Voice Lab' })).toHaveCount(0)
  expect((await op.request.get('/api/platform/voice-lab/status')).status()).toBe(403)
  const origin = new URL(op.url()).origin
  expect((await op.request.post('/api/platform/voice-lab/session', { data: { action: 'start', provider: 'openai', customer: fixtures.E2E_ADS_CUSTOMER }, headers: { Origin: origin } })).status()).toBe(403)
  expect((await op.request.post('/api/platform/voice-lab/tool', { data: { customer: fixtures.E2E_ADS_CUSTOMER, name: 'check_service_area', input: { zip: '29403' } }, headers: { Origin: origin } })).status()).toBe(403)
  await owner.close()
  const anon = await browser.newContext()
  const ap = await anon.newPage()
  expect((await ap.request.get('/api/platform/voice-lab/status')).status()).toBe(401)
  await ap.goto('/admin/voice-lab')
  await expect(ap.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await anon.close()
})

test('admin: an unconfigured provider cannot start a session server-side either (409 with the code), and nothing is recorded', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/voice-lab')
  const origin = new URL(page.url()).origin
  const r = await page.request.post('/api/platform/voice-lab/session', { data: { action: 'start', provider: 'openai', customer: fixtures.E2E_CC_CUSTOMER, dryRun: true }, headers: { Origin: origin } })
  expect(r.status()).toBe(409)
  expect((await r.json()).error).toBe('openai_not_configured')
  const real = await page.request.post('/api/platform/voice-lab/session', { data: { action: 'start', provider: 'openai', customer: fixtures.E2E_CUSTOMER, dryRun: true }, headers: { Origin: origin } })
  expect([403, 409]).toContain(real.status())
  expect((await (await page.request.get('/api/platform/voice-lab/status')).json()).sessions).toEqual([])
})
