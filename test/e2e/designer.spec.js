// The AI website designer in the browser (Claude mocked on the local stand-in): connect the business's own key, describe
// the website, see the AI's design in the preview, ask for a change, see it change, undo. Nothing goes live.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('owner designs the website in conversation: first design, revision, undo @mobile', async ({ page, context }, info) => {
  // Each browser project designs its own business (the desktop and phone runs happen at the same time).
  await useSession(context, info.project.name === 'mobile' ? fixtures.E2E_DESIGN_M_SESSION_TOKEN : fixtures.E2E_DESIGN_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'AI designer' }) })
  // Without a key the designer explains itself and asks for one (a previous viewport's run may have connected it).
  await expect(card.getByLabel('API key').or(card.getByLabel(/Describe your website|Ask for a change/)).first()).toBeVisible()
  if (await card.getByLabel('API key').isVisible()) {
    await card.getByLabel('API key').fill('sk-ant-api03-' + 'A'.repeat(40) + 'WXYZ')
    await card.getByRole('button', { name: 'Connect key' }).click()
  }
  // The model list comes from the connected account (discovered, not a fixed list). Auto needs a TESTED model, so the
  // owner picks one here.
  const keyPanel = card.locator('details.designer-key')
  await keyPanel.locator('summary').click()
  const model = keyPanel.getByLabel('Model')
  await expect(model.locator('option', { hasText: 'claude-haiku-5-5' })).toHaveCount(1)
  await expect(model.locator('option', { hasText: /^Auto/ })).toHaveCount(1)
  await model.selectOption('claude-opus-5-5')
  await expect(keyPanel.locator('summary')).toContainText('claude-opus-5-5')
  await card.getByLabel(/Describe your website|Ask for a change/).fill('Modern and premium, booking front and centre')
  await card.getByRole('button', { name: /Design my website|Send/ }).click()
  await expect(card.getByText('A fresh coastal design with booking up front.').or(card.getByText('Darker and more premium, with a serif headline.')).first()).toBeVisible({ timeout: 30_000 })
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(/Clear water, every week\.|Quietly perfect pools\./)
  // An AI-designed draft: the older template tools (which would replace it) are gone, the preview follows the designer,
  // and the editor keeps only what the design uses (no style/colour/logo/Google controls that would change nothing).
  await expect(page.locator('section[aria-label="Create with AI"]')).toHaveCount(0)
  await expect(page.getByText('Your own AI key (optional)')).toHaveCount(0)
  // The Website Studio editor takes over (one editor per draft): the older text-and-photos form is gone.
  await expect(page.locator('section[aria-label="Website Studio editor"]')).toBeVisible()
  await expect(page.locator('section[aria-label="Edit website"]')).toHaveCount(0)
  await expect(card.locator('.chip').first()).toHaveCSS('text-transform', 'none')
  // Internal pilot (WEBSITE_STUDIO_PUBLISH unset): the AI design can be previewed but not published.
  const status = page.locator('section[aria-label="Website status"]')
  await expect(status.getByText('AI-designed websites stay private during the pilot')).toBeVisible()
  await expect(status.getByRole('button', { name: /^Publish/ })).toHaveCount(0)
  // Revision in conversation.
  await card.getByLabel('Ask for a change').fill('Make it darker and more premium')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(card.getByText('Darker and more premium, with a serif headline.').last()).toBeVisible({ timeout: 30_000 })
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Quietly perfect pools.')
  await expect(card.getByText('Design idea:')).toBeVisible()
  // A genuinely different direction: a typographic composition as the first screen, the Book button still in view.
  await card.getByRole('button', { name: 'Show me a different direction' }).click()
  await expect(card.getByText('A bold typographic direction.').last()).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('Bold typographic poster: the headline is the hero')).toBeVisible()
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Pool care, booked in a minute.')
  await expect(frame.locator('section.comp')).toHaveCount(1)
  await expect(frame.getByRole('link', { name: 'Book a visit' }).first()).toBeVisible()
  // Undo the last change → the previous design is back.
  await card.getByRole('button', { name: 'Undo this change' }).click()
  await expect(card.getByText('Undone: the previous design is back.').last()).toBeVisible()
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Quietly perfect pools.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
