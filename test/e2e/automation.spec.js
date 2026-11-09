// Automated follow-ups as the customer and the owner see them. No email/SMS provider is configured in
// e2e, so the dashboard must say messages are not being sent, and no texting consent is offered.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'
import { linkToken } from '../../server/links.js'

const env = { TOKEN_ENCRYPTION_KEY: fixtures.E2E_TOKEN_ENCRYPTION_KEY }
const APPT = '0123456789abcdef0123456789abcdef'

test.describe.configure({ timeout: 60_000 })

test('dashboard: automatic follow-ups card is honest about delivery and can be switched off and on', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  const card = page.getByRole('region', { name: 'Automatic follow-ups' })
  await expect(card.locator('[data-automation="no_provider"]')).toHaveText('On, but not sending yet')
  await expect(card.getByText('not being sent')).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Messages sent' }).locator('.stat-value')).toHaveText('0')
  await expect(page.locator('.stat', { hasText: 'Booking rate' })).toBeVisible()
  await card.getByRole('button', { name: 'Turn off' }).click()
  await expect(card.locator('[data-automation="off"]')).toHaveText('Off')
  await card.getByRole('button', { name: 'Turn on' }).click()
  await expect(card.locator('[data-automation="no_provider"]')).toBeVisible()
})

test('booking page does not offer text messages when no SMS provider is configured', async ({ page }) => {
  await page.goto(`/book/${fixtures.E2E_AUTO_CUSTOMER}`)
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('confirm link: shows the appointment, changes nothing until tapped, then confirms', async ({ page, request }) => {
  const k = await linkToken(env, 'confirm', APPT)
  await page.goto(`/api/appointment/confirm?a=${APPT}&k=${k}`)
  await expect(page.getByRole('heading', { name: 'Confirm your appointment' })).toBeVisible()
  await expect(page.getByText('E2E Auto Co')).toBeVisible()
  await expect(page.getByText('Casey')).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm I’ll be there' }).click()
  await expect(page.getByRole('heading', { name: 'You’re confirmed' })).toBeVisible()
  const again = await request.get(`/api/appointment/confirm?a=${APPT}&k=${k}`)
  expect(await again.text()).toContain('You’re confirmed')
  expect((await request.get(`/api/appointment/confirm?a=${APPT}&k=${'x'.repeat(43)}`)).status()).toBe(404)
})

test('pick-a-time link from a follow-up books for the existing lead without re-entering details', async ({ page }) => {
  const k = await linkToken(env, 'lead', 'seed-lead-resume')
  await page.goto(`/book/${fixtures.E2E_AUTO_CUSTOMER}?lead=seed-lead-resume&k=${k}`)
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
  await page.locator('.slot').first().click()
  await page.getByRole('button', { name: /^Book / }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await expect(page.getByText('on its way to your email')).toBeVisible()
})
