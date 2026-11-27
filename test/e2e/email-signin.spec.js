// Email sign-in beside Google (server/email-auth.js, src/dashboard/SignIn.jsx): a new person by code (with a wrong code
// and Resend), a member by link (the same account their Google sign-in reaches), a link opened in another browser, an
// expired link, and an address that may not sign in (same screen, no email). Mail goes to the local stand-in
// (AUTH_EMAIL_MOCK_ORIGIN) and is read back from it. Email sign-in is not yet offered to everyone in this environment
// (AUTH_EMAIL_LIVE off, as in production today), so the screens are opened with ?email=1, the testers' entry.
import { test, expect } from './test.js'
import { returnFromGoogle } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

const MOCK = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
const mailFor = async (request, to) => (await request.get(`${MOCK}/__mail?to=${encodeURIComponent(to)}`)).json()
// The email leaves after the answer (waitUntil), so wait for the n-th message to arrive.
async function nthMail(request, to, n) {
  await expect.poll(async () => (await mailFor(request, to)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(n)
  const m = (await mailFor(request, to))[n - 1]
  return { ...m, code: m.text.match(/code: (\d{6})/)[1], token: m.text.match(/#t=([A-Za-z0-9_-]{43})/)[1] }
}
const ip = async (context, n) => context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `198.51.100.${n}` })
const me = async (page) => page.evaluate(() => fetch('/api/dashboard/me').then(async (r) => ({ status: r.status, ...(await r.json()) })))

async function askFor(page, email) {
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Continue with email' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.locator('[data-sent-to]')).toHaveText(email)
}

test('new person: Google first, then email; a wrong code, Resend after the countdown, then the newest code signs in @mobile', async ({ page, context, request }, info) => {
  const email = info.project.name === 'mobile' ? fixtures.E2E_EMAILAUTH_PHONE_M : fixtures.E2E_EMAILAUTH_PHONE
  await ip(context, info.project.name === 'mobile' ? 41 : 42)
  await page.clock.install()
  await page.goto('/dashboard?email=1')
  // Hierarchy: Google is the primary action, email the alternative under "or".
  const google = page.getByRole('link', { name: 'Continue with Google' })
  const emailButton = page.getByRole('button', { name: 'Continue with email' })
  await expect(google).toHaveClass(/btn-primary/)
  await expect(emailButton).toHaveClass(/btn-quiet/)
  expect((await google.boundingBox()).y).toBeLessThan((await emailButton.boundingBox()).y)
  // A malformed address is refused next to the field, and stays editable.
  await page.getByLabel('Email').fill('name@')
  await emailButton.click()
  await expect(page.getByRole('alert')).toContainText('Enter your full email address')
  await askFor(page, email)
  const first = await nthMail(request, email, 1)
  expect(first.subject).toBe('Sign in to GetShowUps')
  // Resend waits, visibly; then sends a new code and only the newest works.
  await expect(page.locator('[data-resend-wait]')).toContainText(/Resend in \d+ s/)
  await page.clock.fastForward(31_000)
  await page.getByRole('button', { name: 'Resend email' }).click()
  await expect(page.getByRole('status')).toContainText('We sent a new code')
  const second = await nthMail(request, email, 2)
  const code = page.getByLabel('6-digit code')
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(code).toHaveAttribute('inputmode', 'numeric')
  if (first.code !== second.code) {
    await code.fill(first.code)
    await expect(page.locator('[data-code-error]')).toContainText('That code didn’t work')
  }
  // Pasted with a space: still one code; six digits submit by themselves.
  await code.fill(`${second.code.slice(0, 3)} ${second.code.slice(3)}`)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.locator('[data-signin]')).toHaveCount(0)
  const who = await me(page)
  expect(who.status).toBe(200)
  expect(who.email).toBe(email)
  expect(who.customer).toBeNull() // a new person: next is setting up their business
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('member who uses Google: the email link (same browser) opens the same account; the link page asks for a click first', async ({ browser, request }) => {
  // Google sign-in for the fixture still works and reaches the business.
  const gCtx = await browser.newContext()
  await ip(gCtx, 43)
  const g = await gCtx.newPage()
  await returnFromGoogle(g, '**/api/auth/google/start**', 'GET', '/api/auth/google/callback', `login:${fixtures.E2E_EMAILAUTH_OWNER}`)
  await g.goto('/dashboard?email=1')
  await g.getByRole('link', { name: 'Continue with Google' }).click()
  await expect(g.locator('[data-signin]')).toHaveCount(0)
  const byGoogle = await me(g)
  expect(byGoogle.customer.id).toBe(fixtures.E2E_EMAILAUTH_CUSTOMER)
  await gCtx.close()

  const ctx = await browser.newContext()
  await ip(ctx, 44)
  const page = await ctx.newPage()
  await page.goto('/dashboard?email=1')
  await askFor(page, fixtures.E2E_EMAILAUTH_OWNER)
  const { token } = await nthMail(request, fixtures.E2E_EMAILAUTH_OWNER, 1)
  await page.goto(`/dashboard/email-sign-in#t=${token}`)
  await expect(page.getByRole('heading', { name: 'Sign in to GetShowUps' })).toBeVisible()
  expect(page.url()).not.toContain(token) // the token leaves the address bar at once
  expect((await me(page)).status).toBe(401) // opening the link signed nobody in
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  const byEmail = await me(page)
  expect(byEmail.email).toBe(fixtures.E2E_EMAILAUTH_OWNER)
  expect(byEmail.customer.id).toBe(byGoogle.customer.id) // same address = same person, whatever the method
  // The link works once.
  await page.goto(`/dashboard/email-sign-in#t=${token}`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'This link was already used' })).toBeVisible()
  await ctx.close()
})

test('link opened in another browser: explained, and the code from the same email signs in there', async ({ browser, request }) => {
  const asker = await browser.newContext()
  await ip(asker, 45)
  const a = await asker.newPage()
  await a.goto('/dashboard?email=1')
  await askFor(a, fixtures.E2E_EMAILAUTH_LINK)
  const { token, code } = await nthMail(request, fixtures.E2E_EMAILAUTH_LINK, 1)
  await asker.close()

  const other = await browser.newContext()
  await ip(other, 46)
  const b = await other.newPage()
  await b.goto(`/dashboard/email-sign-in#t=${token}`)
  await b.getByRole('button', { name: 'Sign in' }).click()
  await expect(b.getByRole('heading', { name: 'Use the code instead' })).toBeVisible()
  expect((await me(b)).status).toBe(401)
  await b.getByLabel('Email').fill(fixtures.E2E_EMAILAUTH_LINK)
  await b.getByLabel('6-digit code').fill(code)
  await expect(b).toHaveURL(/\/dashboard$/)
  expect((await me(b)).email).toBe(fixtures.E2E_EMAILAUTH_LINK)
  await other.close()
})

test('expired link: a plain explanation and a way to sign in again @mobile', async ({ page, context }, info) => {
  await ip(context, info.project.name === 'mobile' ? 47 : 48)
  await page.goto(`/dashboard/email-sign-in#t=${fixtures.E2E_EMAILAUTH_EXPIRED_LINK}`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
  await expect(page.getByText('Sign-in links work for 15 minutes.')).toBeVisible()
  await page.getByRole('link', { name: 'Sign in again' }).click()
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test('an address that may not sign in sees the same "Check your email" screen and gets no email', async ({ page, context, request }) => {
  await ip(context, 49)
  await page.goto('/dashboard?email=1')
  await askFor(page, fixtures.E2E_EMAILAUTH_STRANGER)
  await page.waitForTimeout(1500) // the send would have happened by now
  expect(await mailFor(request, fixtures.E2E_EMAILAUTH_STRANGER)).toEqual([])
  // "Use a different email" returns to the form.
  await page.getByRole('button', { name: 'Use a different email' }).click()
  await expect(page.getByLabel('Email')).toBeVisible()
})

test('admin console: the same sign-in, Google first; without ?email=1 and before release only Google is offered', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/auth/google/start?next=/admin')
  await expect(page.getByRole('button', { name: 'Continue with email' })).toHaveCount(0)
  await page.goto('/admin?email=1')
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeVisible()
})
