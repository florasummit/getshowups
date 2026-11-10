// Website tab: an existing business edits its generated website (autosaved), previews it privately,
// publishes with explicit consent, and visitors book through it with ad parameters kept. Earlier
// versions can be restored. Runs on desktop and phone (phone uses the Edit / Preview switch).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('owner edits, previews and publishes the website; visitors book through it @mobile', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const id = mobile ? fixtures.E2E_HOME_CUSTOMER : fixtures.E2E_CUSTOMER
  await useSession(context, mobile ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

  // Not public before publishing.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { name: 'This website isn’t available' })).toBeVisible()

  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Finish my website' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible()
  await expect(page.getByText('Not published yet')).toBeVisible()
  await page.getByLabel('Headline').fill('Pool care in Charleston')
  await page.getByText('Bold').click()
  await expect(page.getByText('All changes saved')).toBeVisible()
  if (mobile) await page.getByRole('tab', { name: 'Preview' }).click()
  const frame = page.frameLocator('iframe[title="Website preview"]')
  await expect(frame.getByRole('heading', { level: 1, name: 'Pool care in Charleston' })).toBeVisible()
  await noOverflow()
  if (mobile) await page.getByRole('tab', { name: 'Edit' }).click()

  // Publish requires the consent checkbox.
  await page.getByRole('button', { name: 'Publish website' }).first().click()
  const publish = page.getByRole('button', { name: 'Publish website' }).last()
  await expect(publish).toBeDisabled()
  await page.getByRole('checkbox').check()
  await publish.click()
  await expect(page.locator('.site-status').getByText('Live', { exact: true })).toBeVisible()

  // Visitors: server-rendered site, ad parameters carried to booking.
  await page.goto(`/p/${id}?utm_source=google&utm_campaign=camp12345678`)
  await expect(page.getByRole('heading', { name: 'Pool care in Charleston', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: mobile ? 'Book a visit' : 'Book an appointment' })).toBeVisible()
  await noOverflow()
  await page.getByRole('link', { name: mobile ? 'Book a visit' : 'Book a time' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/book/${id}\\?utm_source=google&utm_campaign=camp12345678$`))
  await expect(page.getByLabel('What do you need?')).toBeVisible()
})

test('changes stay private until published again; an earlier version can be restored', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  await page.getByLabel('Headline').fill('A brand new headline')
  await expect(page.getByText('All changes saved')).toBeVisible()
  await expect(page.getByText('you have changes that aren’t published yet')).toBeVisible()
  expect(await (await page.request.get(`/p/${fixtures.E2E_CUSTOMER}`)).text()).not.toContain('A brand new headline')
  await page.getByRole('button', { name: 'Publish changes' }).first().click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Publish changes' }).last().click()
  await expect(page.locator('.site-status').getByText('Live', { exact: true })).toBeVisible()
  expect(await (await page.request.get(`/p/${fixtures.E2E_CUSTOMER}`)).text()).toContain('A brand new headline')

  await page.getByText('Earlier versions and more').click()
  await page.getByRole('button', { name: 'Restore' }).first().click()
  await expect.poll(async () => (await (await page.request.get(`/p/${fixtures.E2E_CUSTOMER}`)).text()).includes('Pool care in Charleston')).toBe(true)
})
