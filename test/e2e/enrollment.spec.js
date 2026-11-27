// Assisted enrollment on the real Pages Functions (local workerd), Stripe in test mode through the local stand-in that
// sends Stripe-signed webhooks: the founder creates a prospect → workspace → payment link → the owner pays on the
// Stripe-hosted page → paid (webhook only) → staff set up the business in configure mode → readiness → ownership
// invitation → the owner claims it with the invited email → lands on their configured setup. Plus: a representative sees
// only assigned enrollments, a revoked representative loses access at once, a revoked invitation no longer works.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 120_000 })
const ORIGIN = `http://127.0.0.1:${fixtures.E2E_PORT}`
const write = (page, url, data, headers = {}) => page.request.post(url, { data, headers: { Origin: ORIGIN, ...headers } })
const asStaff = (id) => ({ 'X-GSU-Enrollment': id })

// The required setup, through the ordinary dashboard routes in configure mode (the same requests the setup screens send).
async function configure(page, id) {
  const p = await write(page, '/api/dashboard/profile', { phone: '843-555-0199', industry: 'Pool service', services: [{ name: 'Weekly pool care', price: '$160 per month' }], cities: ['Charleston'] }, asStaff(id))
  expect(p.status()).toBe(200)
  const h = await write(page, '/api/dashboard/hours', { workdays: [1, 2, 3, 4, 5], dayStart: '08:00', dayEnd: '17:00', slotMinutes: 60 }, asStaff(id))
  expect(h.status()).toBe(200)
}
async function pay(page, url) {
  await page.goto(url)
  await page.getByLabel('Card number').fill('4242424242424242')
  await page.getByRole('button', { name: 'Subscribe' }).click()
  await expect(page).toHaveURL(/\/claim\?paid=1$/)
}
const paidSoon = (page, id) => expect.poll(async () => (await (await page.request.get(`/api/sales/enrollments?id=${id}`)).json()).payment?.paid, { timeout: 30_000 }).toBe(true)

test('founder-assisted: prospect → workspace → Stripe-hosted payment → configure → invitation → owner claims → configured dashboard', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/sales')
  await expect(page.getByRole('heading', { name: 'Enrollments', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'New prospect' }).click()
  const form = page.locator('[data-prospect-form]')
  await form.getByLabel('Business name').fill('E2E Assisted Pools')
  await form.getByLabel('Owner’s name').fill('Pat Assisted')
  await form.getByLabel('Owner’s email').fill(fixtures.E2E_SALES_OWNER_EMAIL)
  await form.getByLabel('Phone').fill('843 555 0199')
  // Card details are refused, never stored.
  await form.getByLabel('Notes from the call').fill('card 4242 4242 4242 4242 exp 12/29')
  await form.getByRole('button', { name: 'Save prospect' }).click()
  await expect(form.getByRole('alert')).toContainText('looks like a card number')
  await form.getByLabel('Notes from the call').fill('Weekly service, two pools')
  await form.getByRole('button', { name: 'Save prospect' }).click()
  const detail = page.locator('[data-enrollment]')
  await expect(detail.getByRole('heading', { name: 'E2E Assisted Pools' })).toBeVisible()
  const id = await detail.getAttribute('data-enrollment')
  await expect(detail).toHaveAttribute('data-stage', 'prospect')

  await detail.locator('[data-create-workspace]').click()
  await expect(detail.getByText(/isn’t public, can’t take bookings and uses no paid services/)).toBeVisible()
  // Staff can't mark it paid: the invitation waits for Stripe.
  expect((await (await write(page, '/api/sales/enrollments', { action: 'invite', id })).json()).error).toBe('payment_required')

  await detail.locator('[data-payment-link]').click()
  const payUrl = await detail.locator('[data-pay-url] input').inputValue()
  expect(payUrl).toContain(`127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}/__stripe/checkout/`)
  await expect(detail).toHaveAttribute('data-stage', 'payment_sent')

  // The owner pays on the Stripe-hosted page (test card) and lands on the claim page (no account yet).
  const owner = await context.newPage()
  await pay(owner, payUrl)
  await expect(owner.getByRole('heading', { name: /payment is being confirmed/ })).toBeVisible()
  await owner.close()
  await paidSoon(page, id)
  await page.reload()
  await expect(page.locator('[data-enrollment]')).toHaveAttribute('data-stage', 'paid')

  // Configure mode: the owner's own setup screens, acting for this business, never as its owner.
  await page.goto(`/dashboard?enrollment=${id}`)
  await expect(page.locator('[data-staff-bar]')).toContainText('E2E Assisted Pools')
  await expect(page.getByRole('list', { name: 'Setup progress' })).not.toContainText('Plan')
  await expect(page).toHaveURL(/\/dashboard$/) // the id doesn't stay in the address
  await configure(page, id)
  // Staff access is limited to setup: billing is refused even in configure mode.
  expect((await page.request.get('/api/dashboard/billing', { headers: asStaff(id) })).status()).toBe(403)

  // Readiness (the same setup definitions as self-service) → ownership invitation.
  await page.goto(`/admin/sales#${id}`)
  const d = page.locator('[data-enrollment]')
  await expect(d.locator('[data-check="details"]')).toHaveAttribute('data-state', 'ok')
  await expect(d.locator('[data-check="hours"]')).toHaveAttribute('data-state', 'ok')
  // Phone setup comes from the phone-lines module (server/telephony/lines.js phoneSetup; PHONE_ENABLED in e2e): a new
  // workspace has no line yet, so it is an optional "to do" that never blocks readiness.
  await expect(d.locator('[data-check="phone"]')).toContainText('Phone line')
  await expect(d.locator('[data-check="phone"]')).toHaveAttribute('data-state', 'action')
  await expect(d).toHaveAttribute('data-stage', 'ready')
  await d.locator('[data-send-invite]').click()
  const claimUrl = await d.locator('[data-claim-url] input').inputValue()
  expect(new URL(claimUrl).pathname).toBe('/claim')
  await expect(d).toHaveAttribute('data-stage', 'invited')

  // Someone else signed in: told who they are and who it's for; nothing claimed.
  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_OWNER2_SESSION_TOKEN)
  await page.goto(claimUrl)
  await expect(page.locator('[data-claim="wrong-account"]')).toContainText(`You’re signed in as ${fixtures.E2E_SALES_OWNER2_EMAIL}`)
  await expect(page).toHaveURL(/\/claim$/) // the token never stays in the address

  // The invited owner: terms, then the claim, then their configured setup (only what isn't done yet).
  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_OWNER_SESSION_TOKEN)
  await page.goto(claimUrl)
  const ready = page.locator('[data-claim="ready"]')
  await expect(ready.getByRole('heading', { name: 'Claim E2E Assisted Pools' })).toBeVisible()
  const button = ready.getByRole('button', { name: 'Claim E2E Assisted Pools' })
  await expect(button).toBeDisabled()
  await ready.getByLabel('I agree to these terms').check()
  await button.click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  const bar = page.getByRole('list', { name: 'Setup progress' })
  for (const done of ['Plan', 'Details', 'Services']) await expect(bar.locator('li', { hasText: done })).toHaveClass(/is-done/)
  await expect(page.locator('[data-staff-bar]')).toHaveCount(0)
  // Used once.
  await page.goto(claimUrl)
  await expect(page.locator('[data-claim="invalid"]')).toBeVisible()

  // Staff access ended with the handoff.
  await context.clearCookies()
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  expect((await page.request.get('/api/dashboard/me', { headers: asStaff(id) })).status()).toBe(403)
  await page.goto(`/admin/sales#${id}`)
  await expect(page.locator('[data-enrollment]')).toHaveAttribute('data-stage', 'claimed')
})

test('a representative sees only assigned enrollments; a revoked representative loses access at once', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const mk = async (name, rep) => (await (await write(page, '/api/sales/enrollments', { action: 'create', businessName: name, ownerEmail: 'someone@e2e-sales.example', planId: 'founding', assignedRepEmail: rep })).json()).id
  const mine = await mk('E2E Rep One Pools', fixtures.E2E_SALES_REP_EMAIL)
  await mk('E2E Rep Three Pools', fixtures.E2E_SALES_REVOKED_EMAIL)

  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_REP_SESSION_TOKEN)
  await page.goto('/admin/sales')
  await expect(page.locator('[data-sales-console]')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0) // no other admin section
  const list = page.locator('[data-enrollment-list]')
  await expect(list).toContainText('E2E Rep One Pools')
  await expect(list).not.toContainText('E2E Rep Three Pools')
  await expect(list).not.toContainText('E2E Assisted Pools')
  await expect(page.getByRole('region', { name: 'Sales team access' })).toHaveCount(0)
  expect((await page.request.get('/api/platform/overview')).status()).toBe(403)

  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_REP2_SESSION_TOKEN)
  await page.goto('/admin/sales')
  await expect(page.getByText('No prospects yet')).toBeVisible()
  expect((await page.request.get(`/api/sales/enrollments?id=${mine}`)).status()).toBe(404)

  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_REVOKED_SESSION_TOKEN)
  await page.goto('/admin/sales')
  await expect(page.locator('[data-enrollment-list]')).toContainText('E2E Rep Three Pools')

  // The founder removes that representative's access in Sales team access.
  await context.clearCookies()
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/sales')
  const row = page.locator(`[data-role-row="${fixtures.E2E_SALES_REVOKED_EMAIL}:sales_rep"]`)
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0)

  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_REVOKED_SESSION_TOKEN)
  await page.goto('/admin/sales')
  await expect(page.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  expect((await page.request.get('/api/sales/enrollments')).status()).toBe(403)
})

test('a revoked ownership invitation no longer works; the owner is told plainly', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  const id = (await (await write(page, '/api/sales/enrollments', { action: 'create', businessName: 'E2E Revoked Pools', ownerEmail: fixtures.E2E_SALES_OWNER2_EMAIL, planId: 'founding' })).json()).id
  expect((await write(page, '/api/sales/enrollments', { action: 'workspace', id })).status()).toBe(200)
  const link = await (await write(page, '/api/sales/enrollments', { action: 'payment', id })).json()
  const payer = await context.newPage()
  await pay(payer, link.url)
  await payer.close()
  await paidSoon(page, id)
  await configure(page, id)
  const inv = await (await write(page, '/api/sales/enrollments', { action: 'invite', id })).json()
  await page.goto(`/admin/sales#${id}`)
  await page.locator('[data-revoke-invite]').click()
  await expect(page.locator('[data-enrollment]')).toContainText('The invitation was revoked.')

  await context.clearCookies()
  await useSession(context, fixtures.E2E_SALES_OWNER2_SESSION_TOKEN)
  await page.goto(inv.url)
  await expect(page.locator('[data-claim="invalid"]')).toContainText('expired or was already used')
  expect((await write(page, '/api/claim', { token: new URL(inv.url).searchParams.get('token'), acceptTerms: true, termsVersion: 'assisted-claim-2026-11-26' })).status()).toBe(404)
})
