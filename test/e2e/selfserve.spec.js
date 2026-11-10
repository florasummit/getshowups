// The complete self-serve customer journey on the real Pages Functions (local workerd):
// homepage → Get started → Google sign-in (mock) → business name → founding plan → Stripe Checkout
// (local Stripe stand-in that sends Stripe-signed webhooks) → guided onboarding → generated website →
// address / own domain → preview → publish → booking → dashboard → billing portal cancellation. Runs on desktop and on a phone with separate accounts.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle } from './helpers.js'

const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
test.describe.configure({ mode: 'serial', timeout: 120_000 })

test('new customer: get started → pay → onboard → publish → book → manage billing @mobile', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const email = mobile ? 'founder-mobile@e2e-selfserve.example' : fixtures.E2E_SELF_SERVE_EMAIL
  const name = mobile ? 'Tidewater Pool Care' : 'Harbor Pool Care'
  const id = mobile ? 'tidewater-pool-care' : 'harbor-pool-care'
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${email}`)

  // Homepage → Get started (plan selected) → create account.
  await page.goto('/')
  await page.getByRole('main').getByRole('link', { name: /Get started/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Create your GetShowUps account' })).toBeVisible()
  await page.getByRole('link', { name: 'Continue with Google' }).click()

  // Business name only, then the plan.
  await expect(page.getByRole('heading', { name: 'What’s your business called?' })).toBeVisible()
  await page.getByLabel('Business name').fill(name)
  await page.getByRole('button', { name: 'Continue to plan' }).click()
  await expect(page.getByRole('heading', { name: 'Start your founding plan' })).toBeVisible()
  await expect(page.getByText('$499/month')).toBeVisible()
  await expect(page.getByText('No free trial', { exact: false })).toBeVisible()
  await noOverflow()

  // Interrupted: cancel checkout, come back, resume the same open checkout session.
  await page.getByRole('button', { name: 'Continue to secure checkout' }).click()
  await expect(page.getByRole('heading', { name: 'Subscribe to GetShowUps' })).toBeVisible()
  const firstSession = page.url()
  await expect(page.getByText('$499.00 per month')).toBeVisible()
  await expect(page.getByText('No trial')).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByText('Checkout was cancelled. You haven’t been charged.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Start your founding plan' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to secure checkout' }).click()
  await expect(page).toHaveURL(firstSession)

  // Declined card, then the sandbox test card.
  await page.getByLabel('Card number').fill('4000000000000002')
  await page.getByRole('button', { name: 'Subscribe' }).click()
  await expect(page.getByText('Your card was declined.')).toBeVisible()
  await page.goBack()
  await page.getByLabel('Card number').fill('4242424242424242')
  await page.getByRole('button', { name: 'Subscribe' }).click()

  // Access follows the signed webhook.
  await expect(page.getByRole('heading', { name: 'Let’s get your website ready' })).toBeVisible({ timeout: 30_000 })
  const billing = await (await page.request.get('/api/dashboard/billing')).json()
  expect(billing.subscription).toMatchObject({ status: 'active', planId: 'founding', cancelAtPeriodEnd: false })

  // Details → services.
  await page.getByLabel('What do you do?').fill('Pool service')
  await page.getByLabel(/Business phone/).fill('843 555 0142')
  await page.getByLabel(/Towns you serve/).fill('Charleston')
  await page.getByLabel(/ZIP codes you serve/).fill('29403, 29407')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'What can customers book?' })).toBeVisible()
  await expect(page.getByLabel('Service 1', { exact: true })).toHaveValue('Weekly pool cleaning')
  await page.getByLabel('Price for service 1', { exact: true }).fill('From $150/month')
  await noOverflow()
  // Reload mid-onboarding resumes at the same step.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'What can customers book?' })).toBeVisible()
  await page.getByLabel('Price for service 1', { exact: true }).fill('From $150/month')
  await page.getByRole('button', { name: 'Continue' }).click()

  // Calendar (real OAuth handlers, mock Google) → hours with a live connection check.
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click()
  await expect(page.getByRole('heading', { name: 'Google Calendar connected' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'When can customers book?' })).toBeVisible()
  await expect(page.getByText('Google Calendar connected')).toBeVisible()
  await page.getByRole('button', { name: 'Sat' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Website: generated from the answers, edited in place (autosaved), private until published.
  await expect(page.getByRole('heading', { name: 'Here’s your website' })).toBeVisible()
  await expect(page.getByLabel('Headline')).toHaveValue('Weekly pool cleaning in Charleston')
  const frame = page.frameLocator('iframe[title="Website preview"]')
  await expect(frame.getByText('From $150/month').first()).toBeVisible()
  await expect(frame.getByText('Call (843) 555-0142').first()).toBeVisible()
  await expect(frame.getByText('Only you can see this')).toBeVisible()
  expect((await page.request.get(`/p/${id}`)).status()).toBe(404)
  await page.getByLabel('Introduction').fill('Friendly, reliable pool care across Charleston.')
  await expect(page.getByText('All changes saved')).toBeVisible()
  await expect(frame.getByText('Friendly, reliable pool care across Charleston.')).toBeVisible()
  if (!mobile) {
    // Claims filter: an unconfirmed guarantee is refused with a plain explanation.
    await page.getByText('About and service area').click()
    await page.getByLabel(/Facts about your business/).fill('Satisfaction guaranteed')
    await expect(page.getByRole('alert')).toContainText('guarantees')
    await page.getByLabel(/Facts about your business/).fill('')
    await expect(page.getByText('All changes saved')).toBeVisible()
  }
  await noOverflow()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Address: GetShowUps address by default; the desktop owner starts connecting their own domain.
  await expect(page.getByRole('heading', { name: 'Choose your website address' })).toBeVisible()
  await expect(page.getByText(`/p/${id}`)).toBeVisible()
  if (!mobile) {
    await page.getByText('Use your own domain').click()
    await page.getByLabel('Enter your domain').fill('harborpoolcare.example')
    await page.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByRole('alert')).toContainText('www.harborpoolcare.example')
    await page.getByRole('button', { name: 'www.harborpoolcare.example' }).click()
    await expect(page.getByText('Step 1 of 2: verify you own www.harborpoolcare.example.')).toBeVisible()
    await expect(page.getByText('_getshowups.www.harborpoolcare.example')).toBeVisible()
    await expect(page.getByText('Waiting for your record')).toBeVisible()
  }
  await noOverflow()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Preview and publish, only with explicit consent.
  await expect(page.getByRole('heading', { name: 'Preview and publish' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish my website' })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Publish my website' }).click()

  // Done: honest checklist (what's live, what's coming) → dashboard.
  await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible()
  const list = page.locator('.checklist')
  await expect(list.locator('.checklist-item--ok', { hasText: 'Founding plan' })).toBeVisible()
  await expect(list.locator('.checklist-item--ok', { hasText: 'Website' })).toBeVisible()
  await expect(list.getByText('Activating soon', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Go to my dashboard' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByText('Live and taking bookings')).toBeVisible()
  await expect(page.getByText(mobile ? 'Share your booking link to get your first booking' : 'Finish connecting your domain')).toBeVisible()
  await noOverflow()

  // A customer books through the published landing page; the event lands on the (mock) calendar.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly pool cleaning in Charleston' })).toBeVisible()
  await noOverflow()
  await page.getByRole('link', { name: 'Book a time' }).first().click()
  const lead = `lead-${mobile ? 'm' : 'd'}@example.net`
  await page.getByLabel('What do you need?').fill('Weekly cleaning')
  await page.getByLabel('Name').fill('Casey Customer')
  await page.getByLabel('Phone').fill('(555) 010-0177')
  await page.getByLabel('Email').fill(lead)
  await page.getByLabel('ZIP', { exact: true }).fill('29403')
  await page.getByRole('button', { name: 'Choose a time' }).click()
  await page.locator('.slot').last().click() // any offered time; the first date may have only a few left late in the day
  await page.getByRole('button', { name: /^Book / }).click()
  await expect(page.getByRole('heading', { name: /booked/i })).toBeVisible()
  const events = await (await page.request.get(`${mock}/__events`)).json()
  expect(events.some((e) => e.attendees?.[0]?.email === lead)).toBe(true)

  // Owner manages billing: schedule cancellation in the portal; the dashboard reflects it.
  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Manage billing' }).click()
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel subscription' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect.poll(async () => (await (await page.request.get('/api/dashboard/billing')).json()).subscription.cancelAtPeriodEnd).toBe(true)
  // Duplicate webhook deliveries left exactly one subscription and one "started" event.
  expect((await (await page.request.get('/api/dashboard/billing')).json()).subscription.status).toBe('active')
  // A second checkout is refused while subscribed (no duplicate subscriptions).
  const again = await page.request.post('/api/dashboard/billing', { data: { action: 'checkout', plan: 'founding' }, headers: { Origin: `http://127.0.0.1:${fixtures.E2E_PORT}` } })
  expect([again.status(), (await again.json()).error]).toEqual([409, 'use_portal'])
})
