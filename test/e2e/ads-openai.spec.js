// ChatGPT Ads in the browser against the real Functions on local workerd and the OpenAI Ads stand-in
// (mock-google.mjs): connect with the owner's key (a wrong key is refused and never stored), draft from the business's
// details, choose a metro area (the ZIP limitation is shown), approve and create PAUSED (verification business, no live
// switch), read back, and Start stays unavailable. Nothing reaches OpenAI; nothing can run or spend.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 60_000, retries: 0 })

test('ChatGPT ads: connect with the owner’s key, draft, choose a metro area, approve and create paused; Start stays off (mock API)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_OPENAI_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()

  const row = page.locator('[data-platform-row="openai"]')
  await expect(row.locator('[data-openai-status]')).toHaveAttribute('data-openai-status', 'none')
  const keyField = row.getByLabel('ChatGPT Ads API key')
  await expect(keyField).toHaveAttribute('type', 'password')
  await keyField.fill('e2e-wrong-key-0000000000000000000000')
  await row.getByRole('button', { name: 'Connect' }).click()
  await expect(row.getByRole('alert')).toContainText('ChatGPT Ads didn’t accept that key')
  await expect(row.locator('[data-openai-status]')).toHaveAttribute('data-openai-status', 'none')
  await keyField.fill(fixtures.E2E_OPENAI_ADS_KEY)
  await row.getByRole('button', { name: 'Connect' }).click()
  await expect(row.locator('[data-openai-status]')).toHaveAttribute('data-openai-status', 'connected')
  await expect(row.locator('[data-openai-status]')).toContainText('E2E ChatGPT Ads · key …6789')
  // The key itself never comes back to the browser.
  expect(JSON.stringify(await (await page.request.get('/api/dashboard/ads')).json())).not.toContain(fixtures.E2E_OPENAI_ADS_KEY)

  await page.getByRole('button', { name: 'Draft a ChatGPT ad' }).click()
  const card = page.locator('[data-campaign-platform="openai"]')
  await expect(card.getByRole('heading', { name: 'ChatGPT ads' })).toBeVisible()
  await expect(card.locator('[data-openai-preview]')).toContainText('E2E ChatGPT Pools')
  await expect(card.locator('[data-openai-geo]')).toContainText('not your ZIP codes')
  await expect(page.getByRole('button', { name: 'Draft a ChatGPT ad' })).toHaveCount(0) // one open draft

  await card.getByLabel('City or state').fill('Charleston')
  await card.getByRole('button', { name: 'Find area' }).click()
  await card.getByRole('list', { name: 'Areas found' }).getByRole('listitem').filter({ hasText: 'Charleston, SC' }).getByRole('button', { name: 'Add' }).click()
  await expect(card.locator('[data-openai-locations]')).toContainText('Charleston, SC (metro area)')
  await card.getByRole('button', { name: 'Save changes' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()

  await card.getByRole('button', { name: 'Check (no spend)' }).click()
  await expect(card.getByText('Check passed. Nothing was created and nothing was spent.')).toBeVisible()
  await expect(card.locator('[data-openai-verify]')).toBeVisible()
  await card.getByRole('button', { name: 'Approve and create (paused)' }).click()
  await expect(card.getByText('ChatGPT Ads has no test account')).toBeVisible()
  await card.getByRole('button', { name: 'Confirm: approve and create (paused)' }).click()
  await expect(card.getByText('Created on ChatGPT Ads, paused. Nothing runs until you press Start.')).toBeVisible()
  await expect(card.locator('.chip')).toHaveText('Paused')
  await expect(card.getByRole('button', { name: 'Start ads' })).toBeDisabled()

  const events = await (await page.request.get(`http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}/__events`)).json()
  const created = events.filter((e) => e.type === 'openai.create')
  expect(created.map((e) => [e.kind, e.status])).toEqual([
    ['campaigns', 'paused'],
    ['ad_groups', 'paused'],
    ['ads', 'paused'],
  ])
  const ads = await (await page.request.get('/api/dashboard/ads')).json()
  const c = ads.campaigns.find((x) => x.platform === 'openai')
  expect(c.status).toBe('paused')
  expect(c.launched).toBe(true)
})
