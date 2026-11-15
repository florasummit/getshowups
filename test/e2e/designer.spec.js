// The AI website designer in the browser (Claude mocked on the local stand-in): connect the business's own key, describe
// the website, see the AI's design in the preview, ask for a change, see it change, undo. Nothing goes live.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('owner designs the website in conversation: first design, revision, undo @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_DESIGN_SESSION_TOKEN)
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
  const frame = page.frameLocator('iframe[title="Website preview"]')
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(/Clear water, every week\.|Quietly perfect pools\./)
  // Revision in conversation.
  await card.getByLabel('Ask for a change').fill('Make it darker and more premium')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(card.getByText('Darker and more premium, with a serif headline.').last()).toBeVisible({ timeout: 30_000 })
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText('Quietly perfect pools.')
  // Undo the last change.
  await card.getByRole('button', { name: 'Undo this change' }).click()
  await expect(card.getByText('Undone: the previous design is back.').last()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
