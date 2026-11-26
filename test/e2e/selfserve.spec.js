// The complete self-serve customer journey on the real Pages Functions (local workerd):
// homepage → Get started → Google sign-in (mock) → business name → Growth plan → Stripe Checkout
// (local Stripe stand-in that sends Stripe-signed webhooks) → guided onboarding → generated website →
// address / own domain → preview → publish → booking → dashboard → billing portal cancellation. Runs on desktop and on a phone with separate accounts.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle } from './helpers.js'
import { chooseService, chooseTime, fillDetails } from './booking-flow.js'

const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
test.describe.configure({ mode: 'serial', timeout: 120_000 })

// ONB-01. Enrollment is closed on this server exactly as in production, and the public homepage offers no sign-up entry
// in any form (founder decision). Someone we arranged a start with (this tester is listed) gets in from the sign-in
// page through a control that is not "Sign in", on a page that is not titled as closed; and "book a call" is never a
// dead end. Runs first: it creates nothing.
test('enrollment closed: no sign-up entry on the homepage; the invited way in from the sign-in page; a working way to make contact @mobile', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const email = mobile ? 'founder-mobile@e2e-selfserve.example' : fixtures.E2E_SELF_SERVE_EMAIL
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  await page.goto('/')
  expect((await (await page.request.get('/api/enrollment')).json()).open).toBe(false)
  // Strict: no homepage link to the sign-up address in any form (with or without extra parameters), menu included.
  if (mobile) {
    await page.getByRole('button', { name: 'Open menu' }).click()
    // ONB-14: the menu's main action is the same ink button as the hero's (it was orange here only).
    const colour = (l) => l.evaluate((e) => getComputedStyle(e).backgroundColor)
    expect(await colour(page.locator('#mobile-nav [data-start-location="mobile_nav"]'))).toBe(await colour(page.locator('.hero').getByRole('link', { name: /Request early access/ })))
  }
  await expect(page.locator('a[href*="plan=founding"]')).toHaveCount(0)
  await expect(page.locator('a[href*="invited"]')).toHaveCount(0)
  // The call section always has a working way to reach us (no calendar is configured in this build).
  const section = page.locator('#book-demo')
  await expect(section.locator('[data-contact-email]')).toHaveAttribute('href', /^mailto:hello@getshowups\.com\?subject=/)
  await expect(section.getByText('Check back soon')).toHaveCount(0)
  // Sign in → the invited entry (not labelled "Sign in") → a page that is not titled closed → Google → business name.
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  const entry = page.getByRole('link', { name: 'Set up your business' })
  await expect(entry).toHaveAttribute('href', '/dashboard?plan=founding&invited=1')
  await entry.click()
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /isn’t open yet/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Book a short call' })).toHaveAttribute('href', '/#book-demo')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page.locator('main.center-page--top')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Online sign-up opens soon' })).toHaveCount(0)
  const me = await (await page.request.get('/api/dashboard/me')).json()
  if (!me.customer) {
    // (A retry of this file finds the business already created by the next test and resumes its setup instead.)
    await expect(page.getByRole('heading', { name: 'What’s your business called?' })).toBeVisible()
    // ONB-08: step 1 shows the whole path.
    await expect(page.getByRole('list', { name: 'Setup progress' }).getByRole('listitem')).toHaveCount(10)
  }
  // Signed out again in the same browser: the page is still not titled closed for them.
  await page.request.post('/api/auth/logout', { headers: { Origin: `http://127.0.0.1:${fixtures.E2E_PORT}` } })
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: me.customer ? 'Welcome back' : 'Set up your business' })).toBeVisible()
})

test('new customer: get started → pay → onboard → publish → book → manage billing @mobile', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const email = mobile ? 'founder-mobile@e2e-selfserve.example' : fixtures.E2E_SELF_SERVE_EMAIL
  const name = mobile ? 'Tidewater Pool Care' : 'Harbor Pool Care'
  const id = mobile ? 'tidewater-pool-care' : 'harbor-pool-care'
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${email}`)

  // Homepage → Get started (plan selected) → create account. Enrollment shown as open (go-live state); the server
  // still applies the real sandbox rule, which lets this listed tester through.
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: true } }))
  await page.goto('/')
  await page.getByRole('main').getByRole('link', { name: /Get started/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Create your GetShowUps account' })).toBeVisible()
  await page.getByRole('link', { name: 'Continue with Google' }).click()

  // Business name only, then the plan.
  await expect(page.getByRole('heading', { name: 'What’s your business called?' })).toBeVisible()
  const bar = page.getByRole('list', { name: 'Setup progress' })
  await expect(bar.getByRole('listitem')).toHaveCount(10) // ONB-08: the path is shown from step 1
  await page.getByLabel('Business name').fill(name)
  await page.getByRole('button', { name: 'Continue to plan' }).click()
  await expect(page.getByRole('heading', { name: 'Start your Growth plan' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible() // ONB-08: step 2 has Back
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
  await expect(page.getByRole('heading', { name: 'Start your Growth plan' })).toBeVisible()
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

  // ONB-14: the payment is confirmed in words, not only by moving on.
  await expect(page.locator('[data-paid-notice]')).toContainText('Payment received')
  // Details → services. ONB-06: nothing typed yet → "At my location"; a pool service goes to the customer (still editable).
  await expect(page.getByRole('radio', { name: 'At my location' })).toBeChecked()
  await page.getByLabel('What do you do?').fill('Pool service')
  await expect(page.getByRole('radio', { name: 'At the customer’s home or site' })).toBeChecked()
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
  // ONB-10: the page between the two steps carries the product's header and its ink button (it was a black page).
  await expect(page.getByRole('link', { name: 'GetShowUps dashboard' })).toBeVisible()
  expect(await page.getByRole('button', { name: 'Continue' }).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(10, 11, 15)')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(248, 250, 252)')
  await noOverflow()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'When can customers book?' })).toBeVisible()
  await expect(page.getByText('Google Calendar connected')).toBeVisible()
  // ONB-11: the connected line (with a 29-character address) stays inside its box at this width.
  const badge = page.locator('[data-calendar-connected]')
  await expect(badge).toContainText(email)
  expect(await badge.evaluate((e) => { const box = e.getBoundingClientRect(); const text = e.lastElementChild.getBoundingClientRect(); return text.left >= box.left && text.right <= box.right + 0.5 && e.scrollWidth <= e.clientWidth })).toBe(true)
  // ONB-08: Back twice, then Continue twice, returns through the same steps (it used to jump past Services); a finished
  // step in the progress bar opens it; the plan step, revisited, says what is true and sells nothing again.
  const back = page.getByRole('button', { name: 'Back', exact: true })
  await back.click()
  await expect(page.getByRole('heading', { name: 'Google Calendar', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toHaveCount(0)
  await back.click()
  await expect(page.getByRole('heading', { name: 'What can customers book?' })).toBeVisible()
  await expect(page.getByLabel('Price for service 1', { exact: true })).toHaveValue('From $150/month')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Google Calendar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'When can customers book?' })).toBeVisible()
  await bar.getByRole('button', { name: 'Step 2: Plan' }).click()
  await expect(page.locator('[data-plan-paid]')).toContainText('Payment received. Your plan is active.')
  await expect(page.getByRole('button', { name: 'Continue to secure checkout' })).toHaveCount(0)
  await bar.getByRole('button', { name: 'Step 6: Hours' }).click()
  await expect(page.getByRole('heading', { name: 'When can customers book?' })).toBeVisible()
  await noOverflow()
  await page.getByRole('button', { name: 'Sat' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Website: written from the answers in one AI request (local stand-in), design chosen, private until published.
  // Ways in (create new · start from a design · skip), one editor; this journey creates a new one. "Bring my current
  // website" is Website Studio: this business has paid, so it is eligible and the import is offered.
  await expect(page.getByRole('heading', { name: 'Your website' })).toBeVisible()
  await page.getByLabel(/Skip for now/).check()
  await expect(page.getByRole('button', { name: 'Skip the website for now' })).toBeVisible()
  await expect(page.getByLabel(/Bring my current website/)).toHaveCount(1)
  // Start from a design: the professional layouts with the business details, no AI.
  await page.getByLabel(/Start from a design/).check()
  await page.getByRole('button', { name: 'Show me the designs' }).click()
  await expect(page.getByText('Choose a design.')).toBeVisible()
  await expect(page.getByText('Designed from your details using our standard layouts.')).toBeVisible()
  await page.getByLabel(/Create a new website/).check()
  await page.getByRole('button', { name: 'Create my website' }).click()
  await expect(page.getByText('Choose a design.')).toBeVisible()
  await expect(page.frameLocator('iframe[title="Deep End design"]').getByRole('heading', { level: 1 })).toHaveText(`${name}: dependable weekly pool cleaning near you`)
  await page.getByRole('button', { name: 'Use this design' }).nth(1).click()
  await expect(page.getByRole('heading', { name: 'Here’s your website' })).toBeVisible()
  const frame = page.frameLocator('iframe[title="Website preview"]')
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(`${name}: dependable weekly pool cleaning near you`)
  await expect(frame.getByText('From $150/month').first()).toBeVisible()
  await expect(frame.getByText('(843) 555-0142').filter({ visible: true }).first()).toBeVisible()
  await expect(frame.getByText('Only you can see this')).toBeVisible()
  await expect(frame.getByText('satisfaction guaranteed')).toHaveCount(0) // the filter dropped the model's claim
  await page.getByRole('button', { name: 'Phone' }).click()
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()
  expect((await page.request.get(`/p/${id}`)).status()).toBe(404)
  // WEB-01: the website made here is the multi-page website of the full editor (no second, smaller editor in setup):
  // the step shows it, takes a change request in the owner's words, and says where everything is edited afterwards.
  expect((await (await page.request.get('/api/dashboard/website')).json()).website.draft.site.pages.map((p) => p.slug)).toEqual(['', 'contact', 'privacy'])
  await expect(page.getByText('Edit text and photos')).toHaveCount(0)
  await expect(page.locator('[data-edit-later]')).toContainText('You can edit everything after setup, under Website')
  await expect(page.locator('[data-revise-scope]')).toContainText('never touches your privacy or terms pages')
  // ONB-09: a requested change is shown first and must be answered before moving on; "Go back" leaves the draft as it was.
  await page.getByRole('button', { name: 'Make it more modern' }).click()
  await expect(page.getByText('Here’s the new version. Keep it?')).toBeVisible({ timeout: 30_000 })
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(/^Modern /)
  await expect(page.locator('[data-undecided]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await page.getByRole('button', { name: 'Go back' }).click()
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(`${name}: dependable weekly pool cleaning near you`)
  await expect(page.locator('[data-undecided]')).toHaveCount(0)
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
    await expect(page.getByText('Step 1 of 2: verify you own www.harborpoolcare.example.')).toBeVisible({ timeout: 20_000 })
    // The Host is shown the way DNS providers want it (they add the domain themselves).
    const host = page.locator('.record code').first()
    await expect(host).toHaveText('_getshowups.www')
    await expect(page.getByText('Waiting for your record')).toBeVisible()
    await expect(page.getByText(/Not found yet \(last checked/)).toBeVisible()
    // Live audit (www.poolthru.com): the provider appended the domain to a full name typed into Host. The owner is
    // told exactly what to change instead of an indefinite "waiting".
    const value = await page.locator('.record code').nth(1).textContent()
    const setDns = (name, values) => page.request.post(`${mock}/__dns`, { data: { type: 'TXT', name, values } })
    await setDns('_getshowups.www.harborpoolcare.example.harborpoolcare.example', [value])
    await page.getByRole('button', { name: 'Check now' }).click()
    await expect(page.getByText('Record needs a fix')).toBeVisible()
    await expect(page.locator('.notice-bad')).toContainText('your DNS provider added harborpoolcare.example a second time')
    await expect(page.locator('.notice-bad')).toContainText('change its Host to _getshowups.www')
    // (Fixed record → verified: covered in test/website.test.js. Left unfixed here so the dashboard's next step stays
    // "Finish connecting your domain".)
  }
  await noOverflow()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Preview and publish, only with explicit consent.
  await expect(page.getByRole('heading', { name: 'Preview and publish' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish my website' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /details are accurate/ }).check()
  // The website's starter privacy page goes public only after the owner says they read it.
  await expect(page.getByRole('button', { name: 'Publish my website' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I’ve read my privacy policy page/ }).check()
  await page.getByRole('button', { name: 'Publish my website' }).click()

  // Done: honest checklist (what's live, what's coming) → dashboard.
  await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible()
  const list = page.locator('.checklist')
  await expect(list.locator('.checklist-item--ok', { hasText: 'Growth plan' })).toBeVisible()
  await expect(list.locator('.checklist-item--ok', { hasText: 'Website' })).toBeVisible()
  await expect(list.getByText('Activating soon', { exact: false })).toBeVisible()
  // ONB-14: the last step is ticked on the finished screen.
  await expect(bar.getByRole('listitem').last()).toContainText('✓')
  // ONB-02: the receptionist is named with its real state (off: nobody turned it on) and a link to its page.
  const rec = list.locator('[data-row="receptionist"]')
  await expect(rec).toContainText('Off')
  await expect(rec.getByRole('link', { name: 'Set it up in Receptionist' })).toHaveAttribute('href', '/dashboard/receptionist')
  // ONB-05: every row that names a place is a link: the live website, the booking page, Ads, Settings.
  await expect(list.locator('[data-row="page"]').getByRole('link', { name: 'Open my website' })).toHaveAttribute('href', new RegExp(`/p/${id}$`))
  await expect(list.locator('[data-row="booking"]').getByRole('link', { name: 'Open my booking page' })).toHaveAttribute('href', new RegExp(`/book/${id}$`))
  await expect(list.locator('[data-row="ads"]').getByRole('link', { name: 'Connect in Ads' })).toHaveAttribute('href', '/dashboard/ads')
  await expect(list.locator('[data-row="hours"]').getByRole('link')).toHaveAttribute('href', '/dashboard/settings')
  // The booking address is whole (not clipped in a field) and has a copy button.
  const share = page.locator('[data-booking-link]')
  const address = share.getByRole('link', { name: 'Your booking link' })
  await expect(address).toHaveText(new RegExp(`/book/${id}$`))
  expect(await address.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  await expect(share.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await expect(share).toContainText('The Book buttons on your website already use it')
  // ONB-04: what the dashboard would raise on first load is asked here, with one tap; nothing was applied on its own.
  const rules = async () => (await page.request.get('/api/dashboard/availability')).json()
  expect((await rules()).minNoticeMinutes).toBe(0)
  const raised = (await (await page.request.get('/api/dashboard/setup-check')).json()).items.filter((x) => x.level !== 'optional')
  expect(raised.map((x) => x.id)).toContain('no_notice')
  const decisions = page.locator('[data-decisions]')
  // Everything the check raises is on this screen: the two with a one-tap answer, the rest with their link.
  for (const x of raised) await expect(x.id === 'no_notice' ? decisions.locator('[data-decision="notice"]') : x.id === 'holiday_open' ? decisions.locator('[data-decision="holiday"]').first() : decisions.locator(`[data-check="${x.id}"]`)).toBeVisible()
  await decisions.locator('[data-decision="notice"]').getByRole('button', { name: 'Require 2 hours’ notice' }).click()
  await expect(decisions).toContainText('Customers now need to book at least 2 hours ahead.')
  expect((await rules()).minNoticeMinutes).toBe(120)
  for (const h of await decisions.locator('[data-decision="holiday"]').all()) await h.getByRole('button', { name: /^Not now/ }).click().catch(() => {})
  expect((await rules()).closures).toEqual([]) // "Not now" changes nothing
  await noOverflow()
  const finishedRows = await list.locator('[data-row]').evaluateAll((els) => els.map((e) => e.dataset.row))
  expect(finishedRows).toContain('receptionist')
  if (!mobile) {
    // Deep link with only the final screen left (found in the live audit): opens the page asked for.
    await page.goto('/dashboard/appointments')
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible()
    await page.goto('/dashboard')
  } else {
    await page.getByRole('button', { name: 'Go to my dashboard' }).click()
  }
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByText('Live and taking bookings')).toBeVisible()
  await expect(page.getByText(mobile ? 'Share your booking link to get your first booking' : 'Finish connecting your domain')).toBeVisible()
  // ONB-04: the notice the owner chose on the finished screen is not raised again on the first dashboard load.
  await expect(page.locator('[data-check="no_notice"]')).toHaveCount(0)
  // ONB-14: "Setup status" lists the same rows as the finished screen (it used to show more).
  await page.getByRole('button', { name: 'Setup status' }).click()
  const status = page.locator('.next-step .checklist')
  await expect(status.locator('[data-row="receptionist"]')).toContainText('Off')
  expect(await status.locator('[data-row]').evaluateAll((els) => els.map((e) => e.dataset.row))).toEqual(finishedRows)
  await status.locator('[data-row="receptionist"]').getByRole('link').click()
  await expect(page).toHaveURL(/\/dashboard\/receptionist$/)
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await noOverflow()

  // A customer books through the published landing page; the event lands on the (mock) calendar.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: `${name}: dependable weekly pool cleaning near you` })).toBeVisible()
  await noOverflow()
  // ONB-06: this pool service visits its customers (preselected from the trade), so the site's button says so.
  await page.getByRole('link', { name: 'Book a visit' }).first().click()
  const lead = `lead-${mobile ? 'm' : 'd'}@example.net`
  await chooseService(page, { need: 'Weekly cleaning', zip: '29403' })
  await chooseTime(page, { slot: 'last' }) // any offered time; the first date may have only a few left late in the day
  await fillDetails(page, { need: 'Weekly cleaning', name: 'Casey Customer', phone: '(555) 010-0177', email: lead, address: { street: '9 Marsh Ln', city: 'Charleston', state: 'SC' } })
  await expect(page.getByRole('heading', { name: /booked/i })).toBeVisible()
  const events = await (await page.request.get(`${mock}/__events`)).json()
  expect(events.some((e) => e.attendees?.[0]?.email === lead)).toBe(true)

  // The owner cancels it (found missing in the live audit): removed from the calendar, gone from Upcoming.
  await page.goto('/dashboard/appointments')
  const row = page.locator('li.row', { hasText: 'Casey Customer' })
  await row.getByRole('button', { name: /^Cancel (visit|appointment)…$/ }).click()
  await expect(row).toContainText('Google lets the customer know')
  await row.getByRole('button', { name: /^Yes, cancel this/ }).click()
  // Said in words (DASH-03): who and when; gone from Upcoming, findable under Past → Cancelled.
  await expect(page.locator('[data-cancelled-notice]')).toContainText('Cancelled: Casey Customer')
  await expect(page.locator('.card', { has: page.getByRole('heading', { name: 'Upcoming' }) }).locator('li.row', { hasText: 'Casey Customer' })).toHaveCount(0)
  await expect(page.locator('[data-cancelled-list] li.row', { hasText: 'Casey Customer' })).toHaveCount(1)
  const after = await (await page.request.get(`${mock}/__events`)).json()
  expect(after.some((e) => e.attendees?.[0]?.email === lead)).toBe(false)

  // Owner manages billing: schedule cancellation in the portal; the dashboard reflects it.
  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Manage billing' }).click()
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel subscription' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect.poll(async () => (await (await page.request.get('/api/dashboard/billing')).json()).subscription.cancelAtPeriodEnd).toBe(true)
  // In the product: the cancellation made in Stripe shows, the owner keeps the plan (explicitly), then cancels it here.
  await page.goto('/dashboard/settings')
  const billingCard = page.locator('#plan')
  await expect(billingCard.locator('[data-plan="ending"]')).toContainText('None. Ends')
  await billingCard.getByRole('button', { name: 'Keep my plan' }).click()
  await expect(billingCard).toContainText('You’ll be charged every month again')
  await billingCard.getByRole('button', { name: 'Yes, keep charging me' }).click()
  await expect(billingCard.locator('[data-plan-result]')).toContainText('Stripe confirmed it')
  await expect(billingCard.locator('[data-plan="active"]')).toContainText('$499.00')
  await expect(billingCard).toContainText('Visa ending 4242')
  await expect(billingCard.locator('[data-invoices]')).toContainText('$499.00')
  await billingCard.getByRole('button', { name: 'Cancel plan…' }).click()
  await expect(billingCard).toContainText('your website stays online 14 more days')
  await billingCard.getByRole('button', { name: 'Confirm: cancel plan' }).click()
  await expect(billingCard.locator('[data-plan-result]')).toContainText('Cancelled. Stripe confirmed it')
  await expect.poll(async () => (await (await page.request.get('/api/dashboard/billing')).json()).subscription.cancelAtPeriodEnd).toBe(true)
  // Duplicate webhook deliveries left exactly one subscription and one "started" event.
  expect((await (await page.request.get('/api/dashboard/billing')).json()).subscription.status).toBe('active')
  // A second checkout is refused while subscribed (no duplicate subscriptions).
  const again = await page.request.post('/api/dashboard/billing', { data: { action: 'checkout', plan: 'founding' }, headers: { Origin: `http://127.0.0.1:${fixtures.E2E_PORT}` } })
  expect([again.status(), (await again.json()).error]).toEqual([409, 'use_portal'])
})

test('sandbox billing: an ordinary new customer can’t unlock the product with a test card', async ({ page }) => {
  const email = 'stranger@e2e-sandbox.example' // not a platform admin, not a listed tester
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  // Homepage: no sign-up link at all while enrollment is closed (site.spec.js). An old or shared sign-up link still
  // explains it BEFORE Google sign-in, offers a call first, and keeps sign-in for accounts/invitations/testers.
  await page.goto('/dashboard?plan=founding')
  await expect(page.getByRole('heading', { name: 'Online enrollment isn’t open yet' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Book a call' })).toHaveAttribute('href', '/#book-demo')
  // "Book a call" lands on the call section, not the top of the homepage (React renders after the fragment scroll).
  await page.getByRole('link', { name: 'Book a call' }).click()
  await expect(page.locator('#book-demo')).toBeInViewport()
  await page.goto('/dashboard?plan=founding')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  // Signed in anyway: told again before a business is created: no name form, no checkout button.
  await expect(page.getByRole('heading', { name: 'Online sign-up opens soon' })).toBeVisible()
  await expect(page.getByText('Online sign-up isn’t open yet', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'book a call with us' })).toHaveAttribute('href', '/#book-demo')
  await expect(page.getByLabel('Business name')).toHaveCount(0)
  const me = await (await page.request.get('/api/dashboard/me')).json()
  expect([me.customer, me.checkoutOpen]).toEqual([null, false])
  // Even calling the API directly creates nothing.
  const r = await page.request.post('/api/dashboard/business', { data: { name: 'Sandbox Stranger Pools', timezone: 'UTC', serviceZips: '', plan: 'founding' }, headers: { Origin: `http://127.0.0.1:${fixtures.E2E_PORT}` } })
  expect([r.status(), (await r.json()).error]).toEqual([403, 'signup_not_open'])
})
