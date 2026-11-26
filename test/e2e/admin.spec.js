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
  // No revenue figure: the value is a dash and the status word says why (the same wording as Growth: ADM-02).
  const mrr = page.locator('.stat[data-figure="mrr"]')
  await expect(mrr.locator('.stat-value')).toHaveText('—')
  await expect(mrr.locator('.stat-label')).toContainText(/MRR\s*(Unavailable|Test mode)/)
  // ADM-01: the headline numbers and "Needs attention" come first on a desktop; the setup forms are closed, below.
  if (test.info().project.name !== 'mobile') {
    await page.setViewportSize({ width: 1440, height: 900 })
    const bottom = async (loc) => {
      const box = await loc.boundingBox()
      return box.y + box.height + (await page.evaluate(() => window.scrollY))
    }
    expect(await bottom(page.getByRole('region', { name: 'Metrics' }).locator('.stats')), 'metrics on the first screen').toBeLessThanOrEqual(900)
    const attention = page.getByRole('heading', { name: 'Needs attention' })
    if (await attention.count()) expect(await bottom(attention), '"Needs attention" within the first 900 px').toBeLessThanOrEqual(900)
    await expect(page.locator('details[data-sales-setup]')).not.toHaveAttribute('open', '')
    await expect(page.locator('details[data-create-business]')).not.toHaveAttribute('open', '')
  }
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
  expect(o.metrics.customers.total).toBe(o.customers.filter((x) => !x.testBusiness && !x.deleted).length)

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
    return [o.metrics.customers.total, o.customers.filter((c) => !c.testBusiness && !c.deleted).length, o.customers.find((c) => c.name === 'E2E Spare Co').testBusiness]
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
  await expect(page.getByRole('button', { name: 'Confirm: pause booking page and ads' })).toBeDisabled() // a reason is required
  await page.getByLabel(/^Reason/).fill('browser test')
  await page.getByRole('button', { name: 'Confirm: pause booking page and ads' }).click()
  await expect(page.getByRole('button', { name: 'Reactivate account' })).toBeVisible()
  await expect(page.locator('[data-ads-paused]')).toHaveText('Ads: 0 campaigns paused.')
  expect((await book()).status()).toBe(404)
  await expect(page.locator('.card', { hasText: 'Audit trail' }).getByText('customer.suspend')).toBeVisible()
  await page.getByRole('button', { name: 'Reactivate account' }).click()
  await page.getByLabel(/^Reason/).fill('browser test over')
  await page.getByRole('button', { name: 'Confirm: reactivate' }).click()
  await expect(page.getByRole('button', { name: 'Suspend account' })).toBeVisible()
  expect((await book()).status()).toBe(200)
  // The permanent audit log on the console home: chain verified, newest entries, export link.
  await page.goto('/admin')
  const log = page.locator('.card', { has: page.getByRole('heading', { name: 'Audit log' }) })
  await expect(log.locator('[data-audit-chain="ok"]')).toContainText('Intact: all')
  await expect(log.getByText('customer.reactivate').first()).toBeVisible()
  const exp = await page.request.get('/api/platform/audit?format=export')
  expect(exp.headers()['content-disposition']).toMatch(/^attachment;/)
  expect((await exp.json()).chain.ok).toBe(true)
  // Billing reconciliation (Stripe stand-in, read-only): run on demand; the result is shown and recorded.
  const rec = page.locator('.card', { has: page.getByRole('heading', { name: 'Billing reconciliation' }) })
  await rec.getByRole('button', { name: 'Run now' }).click()
  await expect(rec.locator('[data-reconcile="clean"], [data-reconcile="issues"], [data-reconcile="leftovers"]')).toBeVisible()
  const last = (await (await page.request.get('/api/platform/reconcile')).json()).last
  expect(last.checked.records).toBeGreaterThan(0)
  // Every difference is classified; differences for test businesses or unknown ids are shown as leftovers, not alarms.
  expect(last.list.every((i) => ['real', 'test_business', 'unknown_record'].includes(i.scope))).toBe(true)
  if (last.issues && last.real === 0) await expect(rec.locator('[data-reconcile="leftovers"]')).toContainText('No differences for real businesses')
  expect(Object.keys(last.byType).every((t) => !['billing_after_deletion', 'stripe_only'].includes(t))).toBe(true)
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
  await expect(page.getByRole('heading', { name: 'Plan and billing' })).toHaveCount(0)
})

test('Twilio setup per business: steps in its own subaccount, submitting off, a step that can’t run says why (nothing sent to Twilio)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const card = page.locator('section[aria-labelledby="messaging-title"]')
  await expect(card.getByRole('heading', { name: 'Texting registrations' })).toBeVisible()
  const row = card.locator('li.row', { hasText: fixtures.E2E_TEXTS_CUSTOMER }).first()
  await row.getByRole('button', { name: 'Twilio setup…' }).click()
  const setup = row.locator(`[data-twilio-setup="${fixtures.E2E_TEXTS_CUSTOMER}"]`)
  await expect(setup).toContainText('subaccount: active')
  await expect(setup).toContainText('submitting off')
  await expect(setup.getByRole('listitem').first()).toContainText('✓')
  // The seeded business has no structured registration details: the step refuses before calling Twilio.
  page.once('dialog', (d) => d.accept())
  await setup.getByRole('button', { name: /^Run: Prepare the business profile/ }).click()
  await expect(setup.getByRole('status')).toContainText('re-save their details')
  // Owners can't reach these actions.
  await useSession(context, fixtures.E2E_TEXTS_SESSION_TOKEN)
  expect((await page.request.get(`/api/platform/messaging?customer=${fixtures.E2E_TEXTS_CUSTOMER}`)).status()).toBe(403)
})

test('Growth → Activities: the acquisition plan by tracking code; the founder records status and cost; nothing is sent @mobile', async ({ page, context }, testInfo) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const outside = []
  page.on('request', (r) => /stripe|checkout|resend|twilio/i.test(r.url()) && outside.push(r.url()))
  await page.goto('/admin/growth')
  // GROW-06: Growth opens on Activities.
  await expect(page.locator('[data-growth-mode="activities"]')).toHaveAttribute('aria-selected', 'true')
  const view = page.locator('[data-growth-activities]')
  await expect(view.locator('[data-acq-activity]')).toHaveCount(10)
  await expect(view).toContainText('Recording here never sends a message')
  // GROW-03: every catalog code is a closed single-line row, in order; the 18 of them fit in 1,800 px on a desktop.
  await expect(view.locator('[data-acq-activity="email-regional"] [data-acq-code]').first()).toHaveAttribute('data-acq-code', 'out-38')
  await expect(view.locator('[data-acq-code][data-open]')).toHaveCount(0)
  if (testInfo.project.name !== 'mobile') {
    await page.setViewportSize({ width: 1440, height: 900 })
    const rows = await view.locator('[data-acq-code]').count()
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    expect(height, `Activities page height with ${rows} closed codes`).toBeLessThanOrEqual(1800 + 45 * Math.max(0, rows - 18))
  }
  // GROW-02: in this fixture the GetShowUps sales business does not exist, so every copy control carries a warning.
  await expect(view.locator('[data-acq-links-warning]')).toContainText('will not open yet')
  const counter = view.locator('[data-acq-code="counter-01"]')
  await counter.locator('.acq-row').click()
  await expect(counter.getByRole('button', { name: 'Copy booking link' })).toBeVisible()
  await expect(counter.locator('[data-link-warning]')).toContainText('will not open yet')
  // GROW-08: a printed card is Prepared → Approved → Live (never "Replied" or "Said no"); the status is explained.
  await expect(counter.getByLabel('Status of counter-01').locator('option')).toHaveText(['Prepared', 'Approved', 'Live'])
  await expect(counter.locator('[data-acq-status-means]')).toContainText(/^(Prepared|Approved|Live): /)
  await expect(view.locator('[data-acq-legend]')).toContainText('Approved = you approved the draft')
  await counter.locator('.acq-row').click()
  await expect(counter.getByLabel('Status of counter-01')).toHaveCount(0)

  // A code of its own so the test never collides with another project's run.
  const code = `e2e-${testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)}-${Date.now() % 100000}`
  const card = view.locator('[data-acq-activity="referral"]')
  await card.getByRole('button', { name: 'Add a code to Referral asks' }).click()
  const field = card.getByLabel('New tracking code for Referral asks')
  const add = card.getByRole('button', { name: 'Add a tracking code' })
  const refused = card.locator('[data-acq-add] [role="alert"]')
  // GROW-12: an empty submit says so; a refused code stays in the field.
  await add.click()
  await expect(refused).toContainText('Type a code first')
  await field.fill('Not A Code!')
  await add.click()
  await expect(refused).toContainText('lowercase letters')
  await expect(field).toHaveValue('Not A Code!')
  // GROW-01: a code that already exists is refused and nothing about it changes.
  await field.fill('ref-01')
  await add.click()
  await expect(refused).toContainText('already a tracking code')
  await expect(field).toHaveValue('ref-01')
  await field.fill(code)
  await add.click()
  const row = view.locator(`[data-acq-code="${code}"]`)
  await expect(row).toHaveAttribute('data-status', 'prepared')
  await expect(field).toHaveValue('')
  // The new row is open: marking it sent is one control (two clicks) away, and is confirmed where it happened.
  await row.getByLabel(`Status of ${code}`).selectOption('sent')
  await expect(row).toHaveAttribute('data-status', 'sent')
  await expect(row.getByRole('status')).toContainText('Saved')
  await expect(row.getByLabel(`Status of ${code}`).locator('option')).toHaveText(['Prepared', 'Approved', 'Sent', 'Followed up', 'Replied', 'Said no'])
  // GROW-01 in the browser: adding the same code again is refused by the server too, and it stays Sent.
  const again = await page.request.post('/api/platform/acquisition', { data: { code, activity: 'referral', create: true, status: 'prepared' }, headers: { Origin: new URL(page.url()).origin } })
  expect([again.status(), (await again.json()).error]).toEqual([409, 'code_exists'])
  await field.fill(code)
  await add.click()
  await expect(refused).toContainText('already a tracking code')
  await expect(row).toHaveAttribute('data-status', 'sent')
  // GROW-07: name and cost save on Enter, say "Saved", keep the row open, and the cost shows on the row.
  const label = row.getByLabel(`Label of ${code}`)
  await label.fill('pat@example.com')
  await label.press('Enter')
  await expect(row.getByRole('alert')).toContainText('without an email address')
  await expect(label).toHaveValue('pat@example.com')
  await label.fill('Harbor Pools')
  await label.press('Enter')
  await expect(row.getByRole('status')).toContainText('Saved')
  await expect(row.locator('.acq-row-label')).toHaveText('Harbor Pools')
  const cost = row.getByLabel(`Cost of ${code}`)
  await cost.fill('42')
  await cost.press('Enter')
  await expect(row.locator('[data-acq-cost]')).toHaveText('Cost $42')
  await expect(row).toHaveAttribute('data-open', '')
  await expect(view.locator('[data-acq-total="cost"]')).toContainText('Recorded by you: $')
  // GROW-03: one typed field reaches the code; the filter narrows by what was recorded.
  await view.getByLabel('Find a tracking code').fill(code)
  await expect(view.locator('[data-acq-code]')).toHaveCount(1)
  await view.getByLabel('Find a tracking code').fill('')
  await view.locator('[data-acq-filter="sent"]').click()
  await expect(row).toBeVisible()
  await expect(view.locator('[data-acq-code="counter-01"]')).toHaveCount(0)
  // The filter and the open row survive a visit to another Growth tab and Back (GROW-06).
  await page.locator('[data-growth-mode="decide"]').click()
  await expect(page).toHaveURL(/\/admin\/growth#decide$/)
  await page.goBack()
  await expect(view.locator('[data-acq-filter="sent"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toHaveAttribute('data-open', '')
  // Saved: a reload shows the same status, name and cost.
  await page.reload()
  const after = page.locator(`[data-acq-code="${code}"]`)
  await expect(after).toHaveAttribute('data-status', 'sent')
  await expect(after.locator('.acq-row-label')).toHaveText('Harbor Pools')
  await expect(after.locator('[data-acq-cost]')).toHaveText('Cost $42')
  expect(outside).toEqual([])
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 })
    await after.locator('.acq-row').click()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `activities overflow at ${width}px`).toBeLessThanOrEqual(0)
    await after.locator('.acq-row').click()
  }
})

test('Growth: Measure labels every figure; Simulate changes outputs without touching billing; Decide names an experiment with evidence @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const billingCalls = []
  page.on('request', (r) => /stripe|billing|checkout/i.test(r.url()) && billingCalls.push(r.url()))
  await page.goto('/admin')
  // ADM-02: what the Overview says about MRR, Paying customers and Retention (value and status word)…
  await page.getByRole('button', { name: 'More metrics' }).click()
  const figures = async () => Object.fromEntries(await page.locator('[data-figure]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-figure'), `${el.getAttribute('data-figure-value')} · ${el.getAttribute('data-figure-status')}`])))
  const onOverview = await figures()
  expect(Object.keys(onOverview).sort()).toEqual(['mrr', 'payingCustomers', 'retention'])
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Growth' }).click()
  await expect(page).toHaveURL(/\/admin\/growth$/)
  await expect(page.getByRole('heading', { name: 'Growth', level: 1 })).toBeVisible()
  // GROW-06: the tab is part of the address; reload keeps it.
  await page.locator('[data-growth-mode="measure"]').click()
  await expect(page).toHaveURL(/\/admin\/growth#measure$/)
  await page.reload()
  // Measure: every row carries a kind; test-mode billing is never shown as revenue.
  const measure = page.locator('[data-growth-measure]')
  await expect(measure.locator('[data-measure="mrr"]')).toHaveAttribute('data-kind', 'unavailable')
  await expect(measure.locator('[data-measure="payingCustomers"]')).toHaveAttribute('data-kind', 'test')
  expect(await measure.locator('[data-measure][data-kind]').count()).toBeGreaterThan(8)
  await expect(measure).toContainText('test businesses and test leads excluded')
  // …is exactly what Growth says (ADM-02), and the status word is on the screen in both places.
  expect(await figures()).toEqual(onOverview)
  for (const [key, text] of Object.entries(onOverview)) await expect(measure.locator(`[data-figure="${key}"]`)).toContainText(text.split(' · ')[1])
  // GROW-09: two headings, customers' numbers apart from GetShowUps' own funnel.
  await expect(measure.locator('[data-measure-group]')).toHaveCount(2)
  await expect(measure.locator('[data-measure-group="customers"] [data-measure]')).toHaveCount(4)
  await expect(measure.getByRole('heading', { level: 2 })).toHaveText(['Your customers’ results', 'GetShowUps’ own sales funnel'])
  await expect(measure).not.toContainText(/\(s\)|\(es\)|Sample \d|tables are missing/)
  const prospectsKnown = (await measure.locator('[data-measure="salesLeads"]').getAttribute('data-kind')) !== 'unavailable'
  // Simulate: raising the close rate raises new customers; the price field is modeling only (no billing request).
  await page.locator('[data-growth-mode="simulate"]').click()
  await expect(page).toHaveURL(/\/admin\/growth#simulate$/)
  // GROW-04: no ad campaigns of GetShowUps' own here, so "Acquisition spend" is an assumption, whatever customers spend.
  await expect(page.locator('[data-sim-field="spendPerMonthCents"]')).toHaveAttribute('data-sim-source', 'assumption')
  await expect(page.locator('[data-sim-scenario="Cost per new customer"]')).toHaveText('—')
  await expect(page.locator('[data-sim-payback]')).toContainText('pay that cost back')
  const cell = page.locator('[data-sim-scenario="New customers"]')
  const before = await cell.textContent()
  await page.locator('[data-sim-field="closeRate"] input').fill('90')
  await expect(cell).not.toHaveText(before)
  await page.locator('[data-sim-field="priceMonthlyCents"] input').fill('999')
  await expect(page.locator('[data-sim-scenario="New MRR"]')).not.toHaveText('—')
  await expect(page.locator('[data-sim-limits]')).toContainText('Not a forecast')
  // GROW-10: 150% is refused where it was typed (the baseline stands in); a negative amount reads −$, never $-.
  const close = page.locator('[data-sim-field="closeRate"]')
  await close.locator('input').fill('150')
  await expect(close.getByRole('alert')).toContainText('Enter a percentage from 0 to 100')
  await expect(cell).toHaveText(before)
  await close.locator('input').fill('')
  await expect(close.getByRole('alert')).toContainText('Enter a percentage from 0 to 100')
  await page.locator('[data-sim-field="priceMonthlyCents"] input').fill('1')
  await expect(page.locator('[data-sim-delta]')).toContainText('−$')
  await expect(page.locator('[data-growth-simulate]')).not.toContainText('$-')
  // GROW-06: what was typed survives a visit to another tab, and Back returns to the previous tab.
  await close.locator('input').fill('55')
  await page.locator('[data-growth-mode="measure"]').click()
  await expect(measure).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/growth#simulate$/)
  await expect(close.locator('input')).toHaveValue('55')
  await page.locator('[data-sim-reset]').click()
  await expect(cell).toHaveText(before)
  expect(billingCalls).toEqual([])
  // Decide: a bottleneck (or "not enough data") with experiment, cost, effort and evidence; never spend.
  await page.locator('[data-growth-mode="decide"]').click()
  const decide = page.locator('[data-growth-decide]')
  await expect(decide).toContainText('Experiment')
  await expect(decide).toContainText('Evidence')
  await expect(decide).toContainText('Nothing runs by itself')
  // GROW-05: it names a prepared activity by its title, never a count Measure shows as unavailable, never an ad test.
  await expect(decide.locator('[data-decide-experiment]')).toContainText(/“(Emails to Charleston owners|Emails to owners outside Charleston|Referral asks|Supply-counter card|Founder post|Live demo for an owner you know|Association or chamber listing)”/)
  if (!prospectsKnown) await expect(decide).not.toContainText(/\d+ prospects?\b/)
  await expect(decide).not.toContainText(/Meta or Google|homepage entry is live/)
  await decide.getByRole('button', { name: 'Open Activities' }).click()
  await expect(page).toHaveURL(/\/admin\/growth#activities$/)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 })
    for (const mode of ['activities', 'measure', 'simulate', 'decide']) {
      await page.locator(`[data-growth-mode="${mode}"]`).click()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${mode} overflow at ${width}px`).toBeLessThanOrEqual(0)
    }
  }
})

test('account types: the console creates a sandbox business (test-marked, complimentary) and reclassifies it to internal live with an audited history; owners see a complimentary plan @mobile', async ({ page, context }, testInfo) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  page.on('dialog', (d) => d.accept())
  await page.goto('/admin')
  const name = `E2E Sandbox ${testInfo.project.name}`
  const create = page.locator('[data-create-business]')
  await create.locator('summary').first().click() // a setup form: closed until opened (ADM-01)
  await create.locator('[data-create-name]').fill(name)
  await create.locator('[data-create-type]').selectOption('sandbox')
  await create.locator('[data-create-submit]').click()
  const created = create.locator('[data-create-result]')
  await expect(created).toContainText('Created')
  const id = await created.getAttribute('data-create-result')
  // The new business is a test business and never a paying customer.
  const overview = await (await page.request.get('/api/platform/overview')).json()
  expect(overview.customers.find((c) => c.id === id)).toMatchObject({ testBusiness: true, account: { classification: 'sandbox', billing: 'complimentary', environment: 'sandbox', providerSpend: 'blocked' } })
  // Customer detail → Account type: classification, entitlement, environment, spend, subscription, costs, history.
  await page.goto(`/admin?customer=${id}`)
  const card = page.locator('[data-account-type]')
  if (!(await card.count())) {
    await page.goto('/admin')
    await page.locator('.row--link', { hasText: name }).first().click()
  }
  await expect(page.locator('[data-account-type]')).toHaveAttribute('data-account-type', 'sandbox')
  await expect(page.locator('[data-account-billing]')).toHaveAttribute('data-account-billing', 'complimentary')
  await expect(page.locator('[data-account-environment]')).toHaveAttribute('data-account-environment', 'sandbox')
  await expect(page.locator('[data-account-spend]')).toHaveAttribute('data-account-spend', 'blocked')
  await expect(page.locator('[data-account-costs]')).toContainText('estimates')
  await expect(page.locator('[data-account-history]')).toContainText('new → sandbox')
  // Reclassify to internal live: explicit action, confirmed; the test mark is removed and the history grows.
  await page.locator('[data-account-change] select').first().selectOption('internal_live')
  await page.locator('[data-account-change] input').fill('e2e: promote to internal live')
  await page.locator('[data-account-apply]').click()
  await expect(page.locator('[data-account-type]')).toHaveAttribute('data-account-type', 'internal_live')
  await expect(page.locator('[data-account-environment]')).toHaveAttribute('data-account-environment', 'production')
  await expect(page.locator('[data-account-history]')).toContainText('sandbox → internal_live')
  const after = await (await page.request.get('/api/platform/overview')).json()
  expect(after.customers.find((c) => c.id === id)).toMatchObject({ testBusiness: false, account: { classification: 'internal_live', billing: 'complimentary' } })
  // An owner can never change it: the route is admin-only.
  const asOwner = await page.request.post('/api/platform/account', { data: { action: 'classify', customer: id, classification: 'customer', confirm: true }, headers: { Cookie: `__Host-gsu_session=${fixtures.E2E_SESSION_TOKEN}`, Origin: 'http://127.0.0.1:' + new URL(page.url()).port } })
  expect([401, 403]).toContain(asOwner.status())
})
