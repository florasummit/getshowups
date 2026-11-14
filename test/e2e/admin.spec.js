// Platform admin console and admin-invitation onboarding, against the real Functions on local workerd.
// Email delivery is not configured in tests, so the console must say so instead of claiming it sent.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'

// No retries: one stateful sequence on a database seeded once per run; a retry would re-run it against
// already-changed records and only hide the real failure (same as ads.spec.js).
test.describe.configure({ mode: 'serial', timeout: 60_000, retries: 0 })

test('customers without platform access are refused', async ({ page, context }) => {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/google/start?next=/admin')
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  expect((await page.request.get('/api/platform/overview')).status()).toBe(403)
})

test('platform admin without a business: signing in from /dashboard lands on the console, never "create your business"', async ({ browser }) => {
  // A non-admin on the console's "No platform access" page signs out back to the console's own sign-in
  // (which asks Google to return to /admin), not to the dashboard.
  const otherCtx = await browser.newContext()
  const other = await otherCtx.newPage()
  await returnFromGoogle(other, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', 'login:someone.else@example.org')
  await other.goto('/dashboard')
  await other.getByRole('link', { name: 'Continue with Google' }).click()
  await other.goto('/admin')
  await expect(other.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  await other.getByRole('button', { name: 'Sign out' }).click()
  await expect(other).toHaveURL(/\/admin$/)
  await expect(other.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await otherCtx.close()

  // The admin (no business membership) starts sign-in from the dashboard and lands on the console.
  const adminCtx = await browser.newContext()
  const admin = await adminCtx.newPage()
  await returnFromGoogle(admin, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${fixtures.E2E_PLATFORM_ADMIN}`)
  await admin.goto('/dashboard')
  await admin.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(admin).toHaveURL(/\/admin$/)
  await expect(admin.getByRole('heading', { name: 'Platform' })).toBeVisible()
  await expect(admin.getByText('What’s your business called?')).toHaveCount(0)
  expect((await (await admin.request.get('/api/dashboard/me')).json()).customer).toBeNull()
  await adminCtx.close()
})

test('auth routing: /admin round trip, admin-only at /dashboard, customer at /admin, cancel returns to /admin, deep link kept', async ({ browser }) => {
  // MOCK Google (local stand-in issues the codes). Each case uses its own fresh browser context.
  const fresh = async () => {
    const ctx = await browser.newContext()
    return [ctx, await ctx.newPage()]
  }
  // 1) Admin starts at /admin, signs in, returns to the console (admin access needs no business).
  let [ctx, page] = await fresh()
  await returnFromGoogle(page, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${fixtures.E2E_PLATFORM_ADMIN}`)
  await page.goto('/admin')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
  // 2) The same admin-only account opening /dashboard: pointed to the console, not into onboarding.
  await page.goto('/dashboard')
  await expect(page.locator('[data-admin-account]')).toContainText('You’re signed in with an admin account')
  await expect(page.getByText('What’s your business called?')).toHaveCount(0)
  await page.getByRole('link', { name: 'Open the admin console' }).click()
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
  // ...but setting up a business stays possible.
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Set up a business with this account instead' }).click()
  await expect(page.getByText('What’s your business called?')).toBeVisible()
  await ctx.close()

  // 3) A customer at /admin: no platform access, with a way to their dashboard.
  ;[ctx, page] = await fresh()
  await useSession(ctx, fixtures.E2E_OTHER_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to your dashboard' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await ctx.close()

  // 4) Cancelling at Google from /admin returns to /admin with a clear message (URL cleaned).
  ;[ctx, page] = await fresh()
  await page.route('**/api/auth/google/start**', async (route) => {
    const res = await route.fetch({ maxRedirects: 0 })
    const state = new URL(res.headers()['location']).searchParams.get('state')
    await route.fulfill({ status: 302, headers: { location: `/api/auth/google/callback?error=access_denied&state=${state}`, 'set-cookie': res.headers()['set-cookie'] } })
  })
  await page.goto('/admin')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled.')
  await expect(page).toHaveURL(/\/admin$/)
  await ctx.close()

  // 5) A customer opening a dashboard deep link returns there after signing in.
  ;[ctx, page] = await fresh()
  await returnFromGoogle(page, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${fixtures.E2E_OTHER_USER_EMAIL}`)
  await page.goto('/dashboard/appointments')
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/google/start?next=%2Fdashboard%2Fappointments')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page).toHaveURL(/\/dashboard\/appointments$/)
  await ctx.close()
})

test('admin sees customers, metrics, and customer detail without lead contact data', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Customers' })).toBeVisible()
  // One snapshot: the test business is tagged and its $499 never counts; e2e runs Stripe in test mode, so no revenue
  // figure is shown at all (PR #18: test-mode billing is never revenue).
  const o = await (await page.request.get('/api/platform/overview')).json()
  expect(o.customers.find((c) => c.name === 'E2E Ads Pools')).toMatchObject({ testBusiness: true, subscription: { status: 'active', mrrCents: 49900 } })
  expect(o.metrics.billing?.mrrCents ?? null).toBe(null)
  await expect(page.locator('.stat', { hasText: 'MRR' }).locator('.stat-value')).toHaveText(/^(No billing yet|Test mode \(no revenue\))$/)
  await expect(page.locator('.row--link', { hasText: 'E2E Ads Pools' }).locator('[data-test-business]')).toHaveText('Test')
  await page.getByRole('button', { name: 'More metrics' }).click()
  await expect(page.locator('.kv').getByText('Needs cost data').first()).toBeVisible()

  await page.getByLabel('Search customers').fill(fixtures.E2E_CUSTOMER)
  await page.locator('.row--link', { hasText: fixtures.E2E_CUSTOMER_NAME }).click()
  await expect(page.getByRole('heading', { level: 1, name: fixtures.E2E_CUSTOMER_NAME })).toBeVisible()
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.locator('.kv').getByText('healthy')).toBeVisible()
  const detail = await (await page.request.get(`/api/platform/customer?id=${fixtures.E2E_CUSTOMER}`)).text()
  expect(detail).not.toContain('pat@example.net')
  expect(detail).not.toContain('555-010-0100')
})

test('customers and test businesses are listed in separate sections; each business appears exactly once', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const customers = page.getByRole('region', { name: 'Customers', exact: true })
  const tests = page.getByRole('region', { name: 'Test businesses', exact: true })
  await expect(customers.getByRole('heading', { name: 'Customers' })).toBeVisible()
  await expect(tests.getByRole('heading', { name: 'Test businesses' })).toBeVisible()
  // The seeded test business is only under Test businesses; the real ones only under Customers.
  await expect(tests.locator('.row--link', { hasText: 'E2E Ads Pools' })).toHaveCount(1)
  await expect(customers.locator('.row--link', { hasText: 'E2E Ads Pools' })).toHaveCount(0)
  await expect(customers.locator('.row--link', { hasText: fixtures.E2E_CUSTOMER_NAME })).toHaveCount(1)
  await expect(tests.locator('.row--link', { hasText: fixtures.E2E_CUSTOMER_NAME })).toHaveCount(0)
  await expect(customers.locator('[data-test-business]')).toHaveCount(0)

  // Every listed business is in exactly one section, matching the server's flag (one snapshot; other
  // spec files add businesses in parallel, so compare against the overview fetched after the page).
  const o = await (await page.request.get('/api/platform/overview')).json()
  const names = async (region) => (await region.locator('.row--link .row-title').allTextContents()).map((t) => t.trim())
  const [shownReal, shownTest] = [await names(customers), await names(tests)]
  for (const c of o.customers.filter((x) => x.testBusiness)) {
    expect(shownTest.some((t) => t.startsWith(c.name))).toBe(true)
    expect(shownReal.some((t) => t.startsWith(c.name))).toBe(false)
  }
  expect(shownTest.length).toBe(o.customers.filter((x) => x.testBusiness).length)
  // The Customers stat counts real businesses only (test businesses are excluded server-side).
  expect(o.metrics.customers.total).toBe(o.customers.filter((x) => !x.testBusiness).length)

  // Phones: both sections fit without sideways scrolling.
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(tests.locator('.row--link').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `overflow at ${width}`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // Search filters both sections; an existing detail page still opens from the test section.
  await page.getByLabel('Search customers').fill('ads pools')
  await expect(customers.getByText('No matches.')).toBeVisible()
  await expect(tests.locator('.row--link')).toHaveCount(1)
  await tests.locator('.row--link', { hasText: 'E2E Ads Pools' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Ads Pools' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Test business' })).toContainText('Marked as a test business')
})

test('admin marks and unmarks a test business (confirmed, audited); counts follow; PoolThru-like businesses unaffected', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  // Other spec files create businesses in parallel, so compare within one snapshot: the Customers
  // count equals the listed businesses minus the ones tagged Test.
  const counted = async () => {
    const o = await (await page.request.get('/api/platform/overview')).json()
    return [o.metrics.customers.total, o.customers.filter((c) => !c.testBusiness).length, o.customers.find((c) => c.name === 'E2E Spare Co').testBusiness]
  }
  const [t0, real0, spare0] = await counted()
  expect([t0, spare0]).toEqual([real0, false])
  await page.locator('.row--link', { hasText: 'E2E Spare Co' }).first().click()
  const card = page.getByRole('region', { name: 'Test business' })
  await expect(card).toContainText('A real business.')
  await card.getByRole('button', { name: 'Mark as test business' }).click()
  await card.getByRole('button', { name: 'Confirm: mark as test business' }).click()
  await expect(card).toContainText('Marked as a test business')
  await expect(page.locator('.card', { hasText: 'Audit trail' }).getByText('customer.test_mark')).toBeVisible()
  const [t1, real1, spare1] = await counted()
  expect([t1, spare1]).toEqual([real1, true])
  await page.goto('/admin')
  // Marked: it moves to the Test businesses section and leaves Customers.
  await expect(page.getByRole('region', { name: 'Test businesses', exact: true }).locator('.row--link', { hasText: 'E2E Spare Co' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Customers', exact: true }).locator('.row--link', { hasText: 'E2E Spare Co' })).toHaveCount(0)
  // The primary (PoolThru-like) business is never tagged.
  await expect(page.locator('.row--link', { hasText: fixtures.E2E_CUSTOMER_NAME }).first().locator('[data-test-business]')).toHaveCount(0)

  await page.locator('.row--link', { hasText: 'E2E Spare Co' }).first().click()
  await card.getByRole('button', { name: 'Remove test mark' }).click()
  await card.getByRole('button', { name: /Confirm: treat as a real business/ }).click()
  await expect(card).toContainText('A real business.')
  await expect(page.locator('.card', { hasText: 'Audit trail' }).getByText('customer.test_unmark')).toBeVisible()
  const [t2, real2, spare2] = await counted()
  expect([t2, spare2]).toEqual([real2, false])
  await page.goto('/admin')
  await expect(page.getByRole('region', { name: 'Customers', exact: true }).locator('.row--link', { hasText: 'E2E Spare Co' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Test businesses', exact: true }).locator('.row--link', { hasText: 'E2E Spare Co' })).toHaveCount(0)
  // Owners can't mark anything.
  const owner = await context.browser().newContext()
  await useSession(owner, fixtures.E2E_SESSION_TOKEN)
  const r = await owner.request.post('/api/platform/test-business', { data: { customer: fixtures.E2E_CUSTOMER, test: true, confirm: true }, headers: { Origin: new URL(page.url()).origin } })
  expect(r.status()).toBe(403)
  await owner.close()
})

test('admin suspends and reactivates an account (audited); booking page pauses meanwhile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const book = () => page.request.get(`/api/book/${fixtures.E2E_SPARE_CUSTOMER}`)
  expect((await book()).status()).toBe(200)
  await page.goto('/admin')
  await page.locator('.row--link', { hasText: 'E2E Spare Co' }).first().click()
  await page.getByRole('button', { name: 'Suspend account' }).click()
  await page.getByRole('button', { name: 'Confirm: pause booking page' }).click()
  await expect(page.getByRole('button', { name: 'Reactivate account' })).toBeVisible()
  expect((await book()).status()).toBe(404)
  await expect(page.locator('.card', { hasText: 'Audit trail' }).getByText('customer.suspend')).toBeVisible()
  await page.getByRole('button', { name: 'Reactivate account' }).click()
  await expect(page.getByRole('button', { name: 'Suspend account' })).toBeVisible()
  expect((await book()).status()).toBe(200)
})

test('admin-assisted setup: invite → owner signs in with Google → joins → connects own calendar step', async ({ page, context, browser }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Invite customer' }).click()
  await page.getByLabel('Owner’s Google email').fill('owner@bluewave.example')
  await page.getByLabel('Business name').fill('Blue Wave Pools')
  await page.getByRole('button', { name: 'Create invitation' }).click()
  await expect(page.getByText('Email delivery isn’t configured. Send this link yourself:')).toBeVisible()
  const link = await page.getByLabel('Invitation link').inputValue()
  expect(link).toMatch(/\/dashboard\?invite=[A-Za-z0-9_-]{43}$/)

  // Wrong Google account: refused with a clear explanation.
  const intruderCtx = await browser.newContext()
  const intruder = await intruderCtx.newPage()
  await returnFromGoogle(intruder, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', 'login:someone.else@example.org')
  await intruder.goto(link)
  await expect(intruder.getByRole('heading', { name: 'Join Blue Wave Pools' })).toBeVisible()
  await intruder.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(intruder.getByRole('heading', { name: 'Invitation not accepted' })).toBeVisible()
  await expect(intruder.getByText(/This invitation is for o•••@bluewave\.example/)).toBeVisible()
  await intruderCtx.close()

  // The invited owner joins and lands on the step to authorize their own Google Calendar.
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await returnFromGoogle(owner, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', 'login:owner@bluewave.example')
  await owner.goto(link)
  await owner.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(owner.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await expect(owner.locator('[aria-current="step"]')).toContainText('Calendar')
  const state = await (await owner.request.get('/api/dashboard/me')).json()
  expect(state.customer.name).toBe('Blue Wave Pools')
  await ownerCtx.close()

  await page.goto('/admin')
  await page.getByLabel('Search customers').fill('blue wave')
  await expect(page.locator('.row--link', { hasText: 'Blue Wave Pools' })).toContainText('Connect calendar')
})

test('existing pilot (non self-serve) business keeps its dashboard and is never asked to pay', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  const billing = await (await page.request.get('/api/dashboard/billing')).json()
  expect(billing).toMatchObject({ configured: true, billed: false, subscription: null })
  const checkout = await page.request.post('/api/dashboard/billing', { data: { action: 'checkout', plan: 'founding' }, headers: { Origin: new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url()).origin } })
  expect([403, 409]).toContain(checkout.status())
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1, name: fixtures.E2E_CUSTOMER_NAME })).toBeVisible()
  await expect(page.getByText('Fix your plan')).toHaveCount(0)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Booking hours' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Plan' })).toHaveCount(0)
})
