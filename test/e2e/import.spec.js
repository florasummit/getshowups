// Website import in the browser: the owner brings their existing website (a fake Squarespace-style site served by the
// local mock), reviews what was found, and puts it into the private draft. Nothing goes live.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 90_000 })

test('owner imports their current website into the draft (text, prices, photos); the live site is unchanged @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Bring your current website' }) })
  // A previous run (other viewport) may already have imported: the form is then under "Import a different website".
  await expect(card.getByLabel('Your current website').or(card.getByText('Import a different website')).first()).toBeVisible()
  if (await card.getByText('Import a different website').isVisible()) await card.getByText('Import a different website').click()
  const go = card.getByRole('button', { name: /^Import (my website|again)$/ })
  await card.getByLabel('Your current website').fill('www.harborpools.example')
  await expect(go).toBeDisabled()
  await card.getByLabel('This is my business’s website and I can use its content.').check()
  await go.click()
  await expect(card.getByText('Found 3 pages on www.harborpools.example.')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('Clear Pools in Charleston')).toBeVisible()
  const services = card.locator('.import-services li')
  await expect(services).toHaveCount(2)
  await expect(services.first()).toContainText('Weekly Pool Care · $180+')
  await expect(card.getByText('Photos (1 selected, up to 6)')).toBeVisible()
  await card.getByRole('button', { name: 'Use this in my draft' }).click()
  await expect(card.getByRole('status')).toContainText('Added to your draft with 1 photo. Your live website hasn’t changed.')
  // The editor now holds the imported text.
  await page.getByText('Edit text and photos').click().catch(() => {})
  await expect(page.locator('input[value="Clear Pools in Charleston"], textarea:has-text("Clear Pools in Charleston")').first()).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('owner connects their own Claude key (checked, stored encrypted, shown by last 4 only) and can remove it', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const card = page.locator('.card', { has: page.getByText('Your own AI key (optional)') })
  await card.getByText('Your own AI key (optional)').click()
  await expect(card.getByText('A Claude Pro or ChatGPT Plus subscription doesn’t include API access.')).toBeVisible()
  await card.getByLabel('API key').fill('sk-ant-api03-BAD' + 'x'.repeat(30))
  await card.getByRole('button', { name: 'Connect key' }).click()
  await expect(card.getByRole('alert')).toHaveText('The provider didn’t accept that key. Check it and try again.')
  await card.getByLabel('API key').fill('sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ')
  await card.getByRole('button', { name: 'Connect key' }).click()
  await expect(card.getByText('Claude (Anthropic) key ending WXYZ · in use for your website')).toBeVisible()
  expect(await page.content()).not.toContain('A'.repeat(40))
  await card.getByRole('button', { name: 'Remove key' }).click()
  await expect(card.getByLabel('API key')).toBeVisible()
})
