// Website import in the browser: the owner brings their existing website (a fake Squarespace-style site served by the
// local mock), reviews what was found, and puts it into the private draft. Nothing goes live.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 }) // both tests use the same business (e2e-import, its own), in order

test('owner imports their current website into the draft (text, prices, photos); the live site is unchanged @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_IMPORT_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Bring your current website' }) })
  // A previous run (other viewport) may already have imported: the site is then AI-editable, the import sits in the
  // collapsed "Import your current website · AI designer" row, and its form is under "Import a different website".
  await expect(page.locator('details.site-more, details.site-tools').first()).toBeAttached()
  if (await page.locator('details.site-more:not([open])').count()) await page.locator('details.site-more > summary').click()
  await expect(card.getByLabel('Your current website', { exact: true }).or(card.getByText('Import a different website')).first()).toBeVisible()
  // repeat: the other viewport already imported, so this business now HAS a website (different safe defaults below).
  const repeat = await card.getByText('Import a different website').isVisible()
  if (repeat) await card.getByText('Import a different website').click()
  const go = card.getByRole('button', { name: /^Import (my website|again)$/ })
  await card.getByLabel('Your current website', { exact: true }).fill('www.harborpools.example')
  await expect(go).toBeDisabled()
  await card.getByLabel('This is my business’s website and I can use its content.').check()
  await go.click()
  await expect(card.getByText('Found 3 pages on www.harborpools.example.')).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('Clear Pools in Charleston')).toBeVisible()
  const services = card.locator('.import-field', { hasText: 'Services and prices' }).locator('li')
  await expect(services).toHaveCount(3)
  await expect(services.first()).toContainText('Weekly Pool Care · $180+')
  // The import builds (or the site already has) a Services page, so /services keeps its address.
  await expect(card.locator('.import-field', { hasText: 'Old page addresses' }).locator('[data-from="/services"]')).toContainText('kept as it is')
  const field = (label) => card.locator('.import-field', { hasText: label }).first().getByRole('checkbox')
  if (repeat) {
    // A business that already has a website: nothing replaces its text or photos unless the owner ticks it.
    await expect(card.getByText('Photos (0 selected, up to 6)')).toBeVisible()
    await expect(field('Old page addresses')).toBeChecked()
    await expect(field('Headline')).not.toBeChecked()
    await field('Headline').check()
    await field('Services and prices').check()
  } else await expect(card.getByText('Photos (1 selected, up to 6)')).toBeVisible()
  // Leftover template text is offered for removal, never rewritten.
  const fixes = card.locator('.import-fields', { has: page.getByText('Suggested fixes') })
  await expect(fixes.getByText('Leave out the description of “Spring Opening”')).toBeVisible()
  await expect(fixes.getByRole('checkbox')).toBeChecked()
  await card.getByRole('button', { name: 'Use this in my draft' }).click()
  await expect(card.getByRole('status')).toContainText(repeat ? 'Added to your draft. Your live website hasn’t changed.' : 'Added to your draft with 1 photo. Your live website hasn’t changed.')
  // The draft holds the imported text, as a multi-page website with the Services page (one content system).
  await expect(page.locator('section[aria-label="Website Studio editor"]')).toBeVisible()
  const draft = (await (await page.request.get('/api/dashboard/website')).json()).website.draft
  expect(draft.headline).toBe('Clear Pools in Charleston')
  expect(draft.site.pages.map((p) => p.slug)).toContain('services')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('owner connects their own Claude key (checked, stored encrypted, shown by last 4 only) and can remove it', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_IMPORT_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  // After the import above, the site is AI-editable: the import + designer tools sit in one labelled row.
  const tools = page.locator('details.site-more')
  await tools.locator(':scope > summary').click()
  // One place for the key: the AI designer card (the separate "Your own AI key" panel was a duplicate).
  const card = page.locator('section[aria-label="AI designer"]')
  await expect(card.getByText('A Claude Pro or ChatGPT Plus subscription doesn’t include API access.')).toBeVisible()
  await card.getByLabel('API key').fill('sk-ant-api03-BAD' + 'x'.repeat(30))
  await card.getByRole('button', { name: 'Connect key' }).click()
  await expect(card.getByRole('alert')).toHaveText('The provider didn’t accept that key. Check it and try again.')
  await card.getByLabel('API key').fill('sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ')
  await card.getByRole('button', { name: 'Connect key' }).click()
  // Connected: the designer opens; the key, model and limit sit under "AI model and monthly limit".
  await card.locator('details.designer-key summary').click()
  await expect(card.getByText('Claude (Anthropic) key ending WXYZ · in use for your website')).toBeVisible()
  expect(await page.content()).not.toContain('A'.repeat(40))
  // With the own key in use, the limit is explained as ours and the provider bills the owner directly.
  await page.reload()
  await tools.locator(':scope > summary').click()
  await card.locator('details.designer-key summary').click()
  await expect(card.getByText(/not their bill: .* your provider bills you directly/)).toBeVisible()
  await card.getByRole('button', { name: 'Remove key' }).click()
  await expect(card.getByLabel('API key')).toBeVisible()
})
