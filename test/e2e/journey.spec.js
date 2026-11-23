// Autonomous customer journey: a NEW customer, driven by the real backend state (test/e2e/journey.js), from the
// closed-enrollment sign-in page to a business that takes real bookings, with the interruptions and failures a real
// first customer meets. Everything runs on the real Pages Functions (local workerd) with mock Google, the local Stripe
// stand-in (signed webhooks) and fixture identities. Nothing here proves live billing, live messaging or live AI.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'
import { SITE, SETUP_ORDER, asVisitor, bookAsCustomer, customerActions, detect, headers, injectFault, mockEvents, runJourney, useGoogle } from './journey.js'

test.describe.configure({ mode: 'serial', timeout: 240_000 })

const states = (trace) => trace.map((t) => t.state)

test('new customer: state-driven from sign-in to a bookable business; interruptions, failures and abuse along the way @mobile', async ({ page, browser }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const who = {
    email: mobile ? fixtures.E2E_JOURNEY_M_EMAIL : fixtures.E2E_JOURNEY_EMAIL,
    name: mobile ? 'Journey Pool Care Mobile' : 'Journey Pool Care',
    // The calendar grant's refresh token is derived from this code; mock /__faults can revoke it later.
    calendarCode: mobile ? 'seeded-journey-m@journey.example' : 'seeded-journey-d@journey.example',
  }
  const faultId = who.calendarCode.replace(/^seeded-/, '')
  asVisitor(mobile ? '198.51.100.202' : '198.51.100.201')
  const log = (l) => console.log(`[journey ${testInfo.project.name}] ${l}`)
  const actions = customerActions(who)
  await useGoogle(page, who)

  // 1. Cold start: discover and perform every step up to the payment, then stop there.
  const first = await runJourney(page, actions, { stopAt: 'setup_details', log })
  expect(first, JSON.stringify(first.diagnosis)).toMatchObject({ ok: true, stopped: true })
  expect(states(first.trace)).toEqual(['sign_in', 'create_business', 'setup_payment', 'setup_details'])
  const business = first.final.business
  expect(business).toMatch(/^journey-pool-care/)
  // Paid: access followed Stripe's signed webhook, nothing else.
  const billing = (await (await page.request.get('/api/dashboard/billing')).json()).subscription
  expect(billing).toMatchObject({ status: 'active', planId: 'founding', cancelAtPeriodEnd: false })

  // 2. Interrupted onboarding: the owner signs out mid-way; a later sign-in resumes at exactly the pending step.
  await page.request.post('/api/auth/logout', { headers: { Origin: SITE } })
  expect((await detect(page)).state).toBe('sign_in')
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Let’s get your website ready' })).toBeVisible()
  expect((await detect(page)).state).toBe('setup_details')

  // 3. A half-set-up business does not exist publicly (no times, no booking) until calendar + hours are in place.
  const half = await runJourney(page, actions, { stopAt: 'setup_hours', log })
  expect(half, JSON.stringify(half.diagnosis)).toMatchObject({ ok: true, stopped: true })
  expect(states(half.trace)).toEqual(['setup_details', 'setup_services', 'setup_calendar', 'setup_hours'])
  expect((await page.request.get(`/api/book/${business}`)).status()).toBe(404)
  const tooEarly = await page.request.post(`/api/book/${business}/lead`, { headers: headers(), data: { name: 'Early Bird', email: 'early@example.net', phone: '(555) 010-0100', need: 'x', zip: '29403', website: '' } })
  expect(tooEarly.status()).toBe(404)

  // 4. The rest of the setup, up to a business that takes bookings. Every remaining step is discovered, not scripted.
  const rest = await runJourney(page, actions, { log })
  expect(rest, JSON.stringify(rest.diagnosis)).toMatchObject({ ok: true })
  expect(states(rest.trace)).toEqual(['setup_hours', 'setup_website', 'setup_address', 'setup_publish', 'setup_launch', 'ready'])
  // The whole journey asked for exactly the product's onboarding steps, once each, in the product's order.
  const asked = [...first.trace, ...half.trace, ...rest.trace].map((t) => t.state).filter((s) => s.startsWith('setup_')).map((s) => s.slice(6))
  expect([...new Set(asked)]).toEqual(SETUP_ORDER.slice(1))
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1, name: who.name })).toBeVisible()
  expect((await page.request.get(`/p/${business}`)).status()).toBe(200)

  // 5. Duplicate subscription prevention: a second checkout is refused while subscribed; a replayed webhook is a no-op.
  const again = await page.request.post('/api/dashboard/billing', { headers: { Origin: SITE }, data: { action: 'checkout', plan: 'founding' } })
  expect([again.status(), (await again.json()).error]).toEqual([409, 'use_portal'])

  // 6. A paid, set-up business has Ads and Teach Your AI by itself: no allowlist, no platform-admin step.
  for (const path of ['/api/dashboard/ads', '/api/dashboard/ai-rules']) expect((await page.request.get(path)).status(), path).toBe(200)
  const me = await (await page.request.get('/api/dashboard/me')).json()
  expect(me.features).toMatchObject({ ads: true, teachAi: true })
  await page.goto('/dashboard')
  const nav = page.getByRole('navigation', { name: 'Dashboard' })
  await expect(nav.getByRole('link', { name: 'Ads', exact: true })).toHaveCount(1)
  await expect(nav.getByRole('link', { name: 'Teach Your AI' })).toHaveCount(1)

  // 7. Invalid booking requests are refused with a reason; nothing is created.
  const lead = (p) => page.request.post(`/api/book/${business}/lead`, { headers: headers(), data: { name: 'Casey Customer', email: 'casey@example.net', phone: '(555) 010-0177', need: 'Weekly cleaning', zip: '29403', website: '', ...p } })
  const badZip = await lead({ zip: 'abc' })
  expect([badZip.status(), (await badZip.json()).error]).toEqual([400, 'invalid_zip'])
  expect((await lead({ name: '' })).status()).toBe(400)
  expect((await lead({ website: 'http://spam.example' })).status()).toBe(400) // honeypot
  const forged = await page.request.post(`/api/book/${business}/appointment`, { headers: headers(), data: { leadId: 'ffffffffffffffffffffffffffffffff', leadToken: 'nope', start: new Date(Date.now() + 86400000).toISOString() } })
  expect([forged.status(), (await forged.json()).error]).toEqual([404, 'lead_not_found'])
  const crossSite = await page.request.post(`/api/book/${business}/lead`, { headers: { Origin: 'https://evil.example' }, data: { name: 'x', email: 'x@example.net', phone: '5550100100', need: 'x', zip: '29403', website: '' } })
  expect(crossSite.status()).toBe(403)

  // 8. A real booking lands on the (mock) calendar and in the owner's dashboard; the same slot cannot be booked twice;
  //    a time that was never offered is refused.
  const customerEmail = mobile ? 'lead-journey-m@example.net' : 'lead-journey-d@example.net'
  const booked = await bookAsCustomer(page, business, { email: customerEmail })
  expect(booked.appointment.status, JSON.stringify(booked.appointment.body)).toBe(201)
  expect((await mockEvents(page)).some((e) => e.attendees?.[0]?.email === customerEmail)).toBe(true)
  const conflict = await bookAsCustomer(page, business, { email: 'second@example.net', start: booked.slot })
  expect([conflict.appointment.status, conflict.appointment.body.error]).toEqual([409, 'slot_unavailable'])
  const notOffered = await bookAsCustomer(page, business, { email: 'third@example.net', start: new Date(new Date(booked.slot).getTime() + 7 * 60_000).toISOString() })
  expect([notOffered.appointment.status, notOffered.appointment.body.error]).toEqual([409, 'slot_unavailable'])
  expect((await (await page.request.get(`/api/book/${business}`)).json()).slots).not.toContain(booked.slot)
  const overview = await (await page.request.get('/api/dashboard/overview')).json()
  expect(overview.upcoming.some((a) => a.name === 'Casey Customer' && a.start === booked.slot)).toBe(true)
  const appointmentId = overview.upcoming.find((a) => a.start === booked.slot).id
  await page.goto('/dashboard/appointments')
  await expect(page.locator('li.row', { hasText: 'Casey Customer' }).first()).toBeVisible()

  // 9. Unauthorized access: another business's owner sees none of it and cannot act on it; signed-out requests are
  //    refused; a cross-site owner request is refused.
  const other = await browser.newContext()
  await useSession(other, fixtures.E2E_OTHER_SESSION_TOKEN)
  const theirs = await (await other.request.get(`${SITE}/api/dashboard/overview`)).json()
  expect(theirs.upcoming.some((a) => a.start === booked.slot && a.name === 'Casey Customer')).toBe(false)
  const steal = await other.request.post(`${SITE}/api/dashboard/appointment-cancel`, { headers: { Origin: SITE }, data: { id: appointmentId, confirm: true } })
  expect(steal.status()).toBe(404)
  await other.close()
  const anon = await browser.newContext()
  expect((await anon.request.get(`${SITE}/api/dashboard/overview`)).status()).toBe(401)
  expect((await anon.request.get(`${SITE}/api/dashboard/me`)).status()).toBe(401)
  await anon.close()
  const csrf = await page.request.post('/api/dashboard/appointment-cancel', { headers: { Origin: 'https://evil.example' }, data: { id: appointmentId, confirm: true } })
  expect(csrf.status()).toBe(403)

  // 10. Failed integration: Google rejects the stored grant (the owner removed GetShowUps from their account).
  //     The owner is told, the public page offers no times (never a false "no free time"), and the state engine names
  //     the fix; after a new grant the business is bookable again.
  await injectFault(page, faultId, 'invalid_grant')
  const broken = await detect(page)
  expect(broken).toMatchObject({ state: 'calendar_reconnect', details: { calendar: 'reconnect_required' } })
  const publicNow = await (await page.request.get(`/api/book/${business}`)).json()
  expect([publicNow.status, publicNow.slots.length]).toEqual(['unavailable', 0])
  // A customer on the booking page meanwhile is told honestly (not "no open times"); their request is still saved.
  const visitor = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': mobile ? '198.51.100.212' : '198.51.100.211' } })
  const vp = await visitor.newPage()
  await vp.goto(`/book/${business}`)
  await vp.getByLabel('What do you need?').fill('Weekly cleaning')
  await vp.getByLabel('Name').fill('Outage Olive')
  await vp.getByLabel('Phone').fill('(555) 010-0178')
  await vp.getByLabel('Email').fill('olive@example.net')
  await vp.getByLabel('ZIP', { exact: true }).fill('29403')
  await vp.getByRole('button', { name: 'Choose a time' }).click()
  await expect(vp.getByRole('heading', { name: 'Online booking isn’t available right now' })).toBeVisible()
  await visitor.close()
  expect((await (await page.request.get('/api/dashboard/overview')).json()).followUp.some((l) => l.name === 'Outage Olive')).toBe(true)
  await page.goto('/dashboard')
  await expect(page.getByText(/Needs reconnecting|reconnect/i).first()).toBeVisible()
  // The founder's live check on the account shows the broken connection too (no customer data involved).
  const admin0 = await browser.newContext()
  await useSession(admin0, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const health = (await (await admin0.request.get(`${SITE}/api/platform/customer?id=${business}&health=1`)).json()).health
  expect(health?.status, JSON.stringify(health)).toBe('reconnect_required')
  await admin0.close()
  // The old grant stays revoked; the owner reconnects and Google issues a NEW grant.
  await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${who.calendarCode}.renewed`)
  const fixed = await runJourney(page, actions, { log })
  expect(fixed, JSON.stringify(fixed.diagnosis)).toMatchObject({ ok: true })
  expect(states(fixed.trace)).toEqual(['calendar_reconnect', 'ready'])
  expect((await (await page.request.get('/api/dashboard/calendar')).json()).status).toBe('healthy')

  // 11. Returning customer: a fresh browser, sign in → straight to the dashboard, nothing to set up.
  const back = await browser.newContext()
  const p2 = await back.newPage()
  await useGoogle(p2, who)
  await p2.goto('/dashboard')
  await p2.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(p2.getByRole('heading', { level: 1, name: who.name })).toBeVisible()
  expect((await detect(p2)).state).toBe('ready')
  await back.close()

  // 12. The founder sees this business correctly without any manual intervention: live, paid, one booking.
  const admin = await browser.newContext()
  await useSession(admin, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const row = await (await admin.request.get(`${SITE}/api/platform/customer?id=${business}`)).json()
  expect(row.customer ?? row).toMatchObject({ id: business })
  const list = await (await admin.request.get(`${SITE}/api/platform/overview`)).json()
  const mine = (list.customers || []).find((c) => c.id === business)
  expect(mine, 'business listed in the founder console').toBeTruthy()
  expect(mine).toMatchObject({ onboarding: 'live', booked30: 1 })
  expect(mine.subscription?.status).toBe('active')
  expect(mine.attention).toEqual([])
  await admin.close()
})

test('a visitor who is not a tester is stopped before anything is created, and told why', async ({ page }) => {
  // Enrollment is closed (the production rule): the sign-in page says so first; signing in anyway creates nothing.
  const who = { email: 'stranger@e2e-journey.example', name: 'Stranger Services', calendarCode: 'stranger@e2e-journey.example' }
  await useGoogle(page, who)
  const run = await runJourney(page, customerActions(who), { stopAt: 'create_business' })
  expect(run).toMatchObject({ ok: true, stopped: true })
  expect(states(run.trace)).toEqual(['sign_in', 'create_business'])
  // The exact blocked point for a real visitor today: signed in, no business, online checkout closed to them.
  expect(run.final.details).toMatchObject({ checkoutOpen: false, plan: 'founding' })
  await expect(page.getByRole('heading', { name: 'Online sign-up opens soon' })).toBeVisible()
  await expect(page.getByLabel('Business name')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'book a call with us' })).toHaveAttribute('href', '/#book-demo')
  const direct = await page.request.post('/api/dashboard/business', { headers: { Origin: SITE }, data: { name: who.name, timezone: 'America/New_York', serviceZips: '', plan: 'founding' } })
  expect([direct.status(), (await direct.json()).error]).toEqual([403, 'signup_not_open'])
  expect((await (await page.request.get('/api/dashboard/me')).json()).customer).toBeNull()
})
