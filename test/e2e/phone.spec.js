// Settings → Phone line (docs/TELEPHONE.md, migration 0049): the owner sees the number customers call, who it rings, the
// fallback, recent calls and the month's usage; saves who answers; a premium-rate number is refused; recording is Off.
// Own business: e2e-phone (seeded line, one verified phone, one missed call). Nothing calls Twilio.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('phone line: number, team phone, missed call and usage are shown; who answers saves; bad numbers are refused', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_PHONE_SESSION_TOKEN)
  await page.goto('/dashboard/settings#phone')
  const card = page.locator('#phone')
  await expect(card.getByRole('heading', { name: 'Phone line' })).toBeVisible()
  await expect(card.getByText('(843) 555-0160')).toBeVisible()
  await expect(card.locator('[data-destination="pd_e2e"]')).toContainText('(843) 555-0161')
  await expect(card.locator('[data-destination="pd_e2e"]')).toContainText('Verified')
  await expect(card.locator('[data-calls]')).toContainText('(843) 555-0162')
  await expect(card.locator('[data-calls]')).toContainText('Missed · call back')
  await expect(card.locator('[data-calls]')).toContainText('in Needs attention')
  await expect(card.locator('[data-usage]')).toContainText('1 call, 1 missed')
  await expect(card.locator('[data-usage]')).toContainText('not a bill')
  await expect(card.getByText('Call recording: Off.')).toBeVisible()
  // The AI option can't be chosen while the receptionist is off for this business, and says why.
  await expect(card.getByLabel(/The AI receptionist answers/)).toBeDisabled()
  await card.getByLabel('Ring for').selectOption('30')
  await card.getByLabel('Outside booking hours, don’t ring my team').check()
  await card.getByRole('button', { name: 'Save who answers' }).click()
  await expect(card.getByText('Saved.')).toBeVisible()
  const st = await (await page.request.get('/api/dashboard/phone')).json()
  expect(st.settings).toMatchObject({ ringSeconds: 30, afterHours: 'fallback', fallback: 'callback' })
  // Toll fraud: a premium-rate number is never added.
  await card.getByLabel('Phone number').fill('900-555-0100')
  await card.getByRole('button', { name: 'Add phone' }).click()
  await expect(card.getByRole('alert')).toContainText('Enter a 10-digit US phone number')
  // The missed call is also a call-back task in the dashboard's existing workflow (receptionist requests).
  expect(st.calls[0]).toMatchObject({ outcome: 'callback', callbackOpen: true })
})
