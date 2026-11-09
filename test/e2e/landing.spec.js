// Landing page: owner reviews the generated draft in Settings, publishes it, and the public page's
// "Book" button opens the existing booking engine with ad parameters kept for attribution.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('owner publishes the generated landing page; visitors book through it @mobile', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const id = mobile ? fixtures.E2E_HOME_CUSTOMER : fixtures.E2E_CUSTOMER
  await useSession(context, mobile ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)

  // Not public before publishing.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { name: 'This page isn’t available' })).toBeVisible()

  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Settings' }).click()
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Your landing page' }) })
  await expect(card.getByText('We drafted a page from your business details.')).toBeVisible()
  await card.getByLabel('Headline').fill('Pool care in Charleston')
  await card.getByLabel(/Facts about your business/).fill('Satisfaction guaranteed')
  await card.getByRole('button', { name: 'Publish page' }).click()
  await expect(card.getByRole('alert')).toContainText('remove reviews, guarantees')
  await card.getByLabel(/Facts about your business/).fill('')
  await card.getByRole('button', { name: 'Publish page' }).click()
  await expect(card.getByRole('status')).toHaveText('Published.')

  await page.goto(`/p/${id}?utm_source=google&utm_campaign=camp12345678`)
  await expect(page.getByRole('heading', { name: 'Pool care in Charleston', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.getByRole('link', { name: mobile ? 'Book a visit' : 'Book a time' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/book/${id}\\?utm_source=google&utm_campaign=camp12345678$`))
  await expect(page.getByLabel('What do you need?')).toBeVisible()
})
