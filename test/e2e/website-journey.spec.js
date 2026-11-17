// Website migration journey on a business in PoolThru's real situation (seed-tour.mjs): an AI-designed site already
// published, no import yet, its own domain verified + attached but DNS still pointing at Squarespace. Read-only here:
// nothing is published, checked or changed. The import, publish and domain flows themselves are covered by
// import.spec.js, website.spec.js, studio-editor.spec.js and selfserve.spec.js.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`

test('website journey: where you are, what is next, and exactly which DNS record to change at Squarespace @mobile', async ({ page, context }) => {
  // Public DNS (mocked): www still points at Squarespace.
  await page.request.post(`${mock}/__dns`, { data: { type: 'CNAME', name: 'www.harborpool.example', values: ['ext-cust.squarespace.com'] } })
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const j = page.getByRole('region', { name: 'Your website, step by step' })
  await expect(j.getByText('3 of 5 done')).toBeVisible()
  const step = (name) => j.getByRole('listitem').filter({ has: page.locator('.wj-title', { hasText: new RegExp(`^${name}`) }) })
  await expect(step('Bring your content')).toContainText('Ready')
  await expect(step('Bring your content')).toContainText('Recommended before switching')
  await expect(step('Publish')).toContainText('Live')
  await expect(step('Connect your domain')).toContainText('Needs your DNS change')
  await expect(step('Connect your domain')).toHaveAttribute('aria-current', 'step')
  await expect(step('Check it’s live')).toContainText('After the switch')
  await expect(step('Review, edit and preview').getByRole('link', { name: 'Preview' })).toHaveAttribute('href', '/api/dashboard/website/preview')

  // Current step → domain settings: honest status, the platform it points at today, the one record to change.
  await step('Connect your domain').getByRole('button', { name: 'Open domain settings' }).click()
  const domain = page.getByRole('region', { name: 'Website address' })
  await expect(domain).toBeInViewport()
  await expect(domain.locator('.domain-status')).toHaveText(/www\.harborpool\.example\s*Waiting for your DNS change/)
  await expect(domain.getByRole('note')).toContainText('Right now www.harborpool.example points to Squarespace (ext-cust.squarespace.com)')
  await expect(domain.getByRole('note')).toContainText('Don’t add a second www record')
  const before = domain.getByRole('list', { name: 'Before you switch' })
  await expect(before).toContainText('Your new website is published.')
  await expect(before).toContainText('Recommended: import your current site first')
  await expect(domain.locator('dl.record')).toContainText('CNAME')
  await expect(domain.locator('dl.record code').first()).toHaveText('www')

  // "Import my current website" opens the import tools (collapsed under the editor for an AI-designed site).
  await step('Bring your content').getByRole('button', { name: 'Import my current website' }).click()
  const imp = page.getByRole('region', { name: 'Bring your current website' })
  await expect(imp).toBeVisible()
  // Importing the old (Squarespace-style, mocked) site into a business that already has a website: only the old page
  // addresses are pre-ticked, no photos, so the current text is never replaced by accident. Not applied here.
  if (await imp.getByText('Import a different website').isVisible()) await imp.getByText('Import a different website').click()
  await imp.getByLabel('Your current website').fill('www.harborpools.example')
  await imp.getByLabel('This is my business’s website and I can use its content.').check()
  await imp.getByRole('button', { name: /^Import (my website|again)$/ }).click()
  await expect(imp.getByText('Found 3 pages on www.harborpools.example.')).toBeVisible({ timeout: 30_000 })
  await expect(imp.getByText('Your current website text stays as it is unless you tick it here.')).toBeVisible()
  await expect(imp.locator('.import-field', { hasText: 'Old page addresses' }).getByRole('checkbox')).toBeChecked()
  for (const label of ['Headline', 'Services and prices']) await expect(imp.locator('.import-field', { hasText: label }).first().getByRole('checkbox')).not.toBeChecked()
  await expect(imp.getByText(/Photos \(0 selected/)).toBeVisible()
  // Every old address with its destination: /about is kept (the new site has an About page); /services has no page
  // yet, so it says which page would keep it.
  const addresses = imp.getByRole('list', { name: 'Old page addresses' })
  await expect(addresses.locator('[data-from="/about"]')).toContainText('kept as it is')
  await expect(addresses.locator('[data-from="/services"]')).toContainText('home page')
  await expect(addresses.locator('[data-from="/services"]')).toContainText('Add a “Services” page in the editor to keep this address.')

  // Nothing changed: still live, domain still waiting.
  const site = await (await page.request.get('/api/dashboard/website')).json()
  expect([site.website.published, site.domain.status]).toEqual([true, 'securing'])
})
