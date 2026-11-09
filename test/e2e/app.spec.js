// The complete customer journey against the real Pages Functions on local workerd, with Google
// replaced by test/e2e/mock-google.mjs (loopback only). Sign-in and calendar connection run the real
// OAuth handlers: tests stop the browser at Google's URL and return with a mock authorization code.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'

const site = `http://127.0.0.1:${fixtures.E2E_PORT}`
const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`

async function fillLead(page, { name, email, need = 'Weekly pool cleaning' }) {
  await page.getByLabel('What do you need?').fill(need)
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Phone').fill('(555) 010-0123')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Choose a time' }).click()
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
}

// Serial (shared state) and generous timeouts: each step makes several real Function → mock-Google calls.
test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('new owner: Google sign-in → business → connect calendar → hours → dashboard', async ({ page }) => {
  const email = fixtures.E2E_NEW_USER_EMAIL
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${email}`)

  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Let’s set up your booking page' })).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toContainText('Business')

  await page.getByLabel('Business name').fill('Fresh Water Pools')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()

  // Reloading resumes at the same step (progress is stored server-side).
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()

  await page.getByRole('button', { name: 'Connect Google Calendar' }).click()
  await expect(page.getByRole('heading', { name: 'Google Calendar connected' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'When can customers book?' })).toBeVisible()
  await page.getByRole('button', { name: 'Sat' }).click()
  await page.getByRole('button', { name: 'Finish setup' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Fresh Water Pools' })).toBeVisible()
  await expect(page.locator('.booking-url')).toHaveText('127.0.0.1:8788/book/fresh-water-pools')
  await expect(page.getByText('No upcoming appointments.')).toBeVisible()
  expect((await page.request.get('/api/book/fresh-water-pools')).status()).toBe(200)
})

test('lead books a real appointment; owner sees it', async ({ page, context }) => {
  await page.goto(`/book/${fixtures.E2E_CUSTOMER}`)
  await expect(page.getByText(fixtures.E2E_CUSTOMER_NAME)).toBeVisible()
  await fillLead(page, { name: 'Jordan Lead', email: 'jordan@example.net' })
  await page.locator('.slot').first().click()
  await page.getByRole('button', { name: /^Book / }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await expect(page.getByText('A calendar invitation is on its way to jordan@example.net.')).toBeVisible()

  const events = await (await page.request.get(`${mock}/__events`)).json()
  const event = events.find((e) => e.attendees?.[0]?.email === 'jordan@example.net')
  expect(event.summary).toBe('Jordan Lead: Weekly pool cleaning')
  expect(event.description).toContain('Phone: (555) 010-0123')

  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  const upcoming = page.locator('.card', { has: page.getByRole('heading', { name: 'Upcoming' }) })
  await expect(upcoming.getByText('Jordan Lead')).toBeVisible()
})

test('the same slot cannot be booked twice', async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
  const [pa, pb] = await Promise.all([a.newPage(), b.newPage()])
  for (const [p, n] of [[pa, 'Ari'], [pb, 'Bea']]) {
    await p.goto(`${site}/book/${fixtures.E2E_CUSTOMER}`)
    await fillLead(p, { name: `${n} Racer`, email: `${n.toLowerCase()}@example.net` })
  }
  const slotA = pa.locator('.slot').first()
  const label = await slotA.textContent()
  const date = await pa.locator('.fine:not(.booking-foot)').textContent()
  await slotA.click()
  await expect(pb.locator('.fine:not(.booking-foot)')).toHaveText(date)
  await pb.locator('.slot', { hasText: label }).first().click()

  await pa.getByRole('button', { name: /^Book / }).click()
  await expect(pa.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await pb.getByRole('button', { name: /^Book / }).click()
  await expect(pb.getByRole('alert')).toHaveText('That time was just taken. Please pick another.')
  // The taken slot is no longer offered on that date. If it was the date's last slot, the date itself is
  // gone and the page shows another date; it never shows the same time on a different date as if unchanged.
  if ((await pb.locator('.fine:not(.booking-foot)').textContent()) === date) {
    await expect(pb.locator('.slot', { hasText: label })).toHaveCount(0)
  } else {
    await expect(pb.getByText(date, { exact: true })).toHaveCount(0)
  }
  await Promise.all([a.close(), b.close()])
})

test('owner records show-up results', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  const pending = page.locator('.card', { has: page.getByRole('heading', { name: 'Did they show up?' }) })
  await expect(pending.getByText('Pat Past')).toBeVisible()
  await pending.getByRole('button', { name: 'Showed' }).click()
  await expect(page.getByRole('heading', { name: 'Did they show up?' })).toHaveCount(0)
  const results = page.locator('.card', { has: page.getByRole('heading', { name: 'Recent results' }) })
  await expect(results.getByText('Pat Past')).toBeVisible()
  await expect(results.locator('.tag--ok')).toHaveText('Showed')
  await expect(page.locator('.stat', { hasText: 'Show rate' }).locator('.stat-value')).toHaveText('100%')
})

test('owner updates booking hours in settings', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Settings' }).click()
  const hours = page.locator('.card', { has: page.getByRole('heading', { name: 'Booking hours' }) })
  await hours.getByLabel('Appointment length').selectOption('30')
  await hours.getByRole('button', { name: 'Save hours' }).click()
  await expect(hours.getByRole('button', { name: 'Saved ✓' })).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/me')).json()).customer.slotMinutes).toBe(30)
  await expect(page.locator('[data-status="healthy"]')).toContainText('Connected')
})

test('partly set-up business resumes at the calendar step and sees only its own data', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_OTHER_SESSION_TOKEN)
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toContainText('Calendar')
  const overview = await (await page.request.get(`/api/dashboard/overview?customer=${fixtures.E2E_CUSTOMER}`)).json()
  expect(overview.stats.leads).toBe(0)
  expect(JSON.stringify(overview)).not.toContain('Jordan Lead')
  expect((await page.request.get(`/api/book/${fixtures.E2E_OTHER_CUSTOMER}`)).status()).toBe(404)
})

test('sign out ends the session server-side', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_LOGOUT_SESSION_TOKEN)
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible()
  const replay = await page.request.get('/api/dashboard/me', { headers: { Cookie: `__Host-gsu_session=${fixtures.E2E_LOGOUT_SESSION_TOKEN}` } })
  expect(replay.status()).toBe(401)
})

test('cross-site requests are refused', async ({ request }) => {
  const headers = { Cookie: `__Host-gsu_session=${fixtures.E2E_SESSION_TOKEN}`, Origin: 'https://evil.example' }
  for (const path of ['/api/dashboard/connect-link', '/api/dashboard/hours', '/api/dashboard/business', '/api/dashboard/outcome', '/api/auth/logout', `/api/book/${fixtures.E2E_CUSTOMER}/lead`]) {
    expect((await request.post(path, { headers, data: {} })).status(), path).toBe(403)
  }
})

test.describe('read-only pages @mobile', () => {
  test('sign-in page and error message', async ({ page }) => {
    await page.goto('/dashboard?login_error=expired')
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText('That sign-in expired. Please try again.')
    await page.goto('/dashboard?login_error=<script>')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect((await page.request.get('/api/dashboard/me')).status()).toBe(401)
  })

  test('booking page layout and unknown pages', async ({ page }) => {
    await page.goto(`/book/${fixtures.E2E_CUSTOMER}`)
    await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await page.goto('/book/does-not-exist')
    await expect(page.getByRole('heading', { name: 'This booking page isn’t available' })).toBeVisible()
  })

  test('privacy policy page (required for Google app publishing)', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Privacy' }).click()
    await expect(page).toHaveURL(/\/privacy$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible()
    await expect(page.getByText('including the Limited Use requirements')).toBeVisible()
    const contacts = page.locator('main a[href^="mailto:"]')
    await expect(contacts).toHaveCount(2)
    for (const href of await contacts.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
      expect(href).toBe('mailto:brandon@getshowups.com')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })

  test('dashboard home layout', async ({ page, context }) => {
    await useSession(context, fixtures.E2E_SESSION_TOKEN)
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: fixtures.E2E_CUSTOMER_NAME })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})
