// The AI website designer in the browser (Claude mocked on the local stand-in): connect the business's own key, describe
// the website, see the AI's design in the preview, ask for a change, see it change, undo. Nothing goes live.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('owner designs the website in conversation: first design, revision, undo @mobile', async ({ page, context }, info) => {
  // Each browser project designs its own business (the desktop and phone runs happen at the same time).
  await useSession(context, info.project.name === 'mobile' ? fixtures.E2E_DESIGN_M_SESSION_TOKEN : fixtures.E2E_DESIGN_SESSION_TOKEN)
  // The AI designer is offered once a draft exists (WEB-05: nothing about AI accounts before that), under its
  // disclosure below the editor. This business starts with the website built from its records.
  const origin = new URL(page.url() === 'about:blank' ? (await page.goto('/dashboard/website'), page.url()) : page.url()).origin
  if (!(await (await page.request.get('/api/dashboard/website')).json()).website.draft.site) expect((await page.request.post('/api/dashboard/website', { data: { action: 'starter' }, headers: { Origin: origin } })).status()).toBe(200)
  await page.goto('/dashboard/website')
  await page.locator('details.site-more > summary').click()
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
  // Publishing is standard: the AI design can be published by the owner (explicit confirmation; not done here).
  const status = page.locator('section[aria-label="Website status"]')
  await expect(status.getByRole('button', { name: /^Publish/ })).toBeVisible()
  await expect(status.getByText('Publishing AI-designed websites is paused')).toHaveCount(0)
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

test('precise change: "Remove my logo" removes only the logo (no model), shows the applied result, and the logo stays removed through a later design turn @mobile', async ({ page, context }, info) => {
  await useSession(context, info.project.name === 'mobile' ? fixtures.E2E_DESIGN_M_SESSION_TOKEN : fixtures.E2E_DESIGN_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const origin = new URL(page.url()).origin
  const draft = async () => (await (await page.request.get('/api/dashboard/website')).json()).website
  // A logo on the draft (uploaded as the editor would: the owner's own file, then the pointer saved).
  const stock = (await import('node:fs')).readdirSync('public/site-stock').find((f) => f.endsWith('.jpg') && !f.includes('-sm'))
  const up = await page.request.post('/api/dashboard/website/assets', { data: (await import('node:fs')).readFileSync(`public/site-stock/${stock}`), headers: { 'Content-Type': 'image/jpeg', Origin: origin } })
  expect(up.status()).toBe(201)
  const logo = (await up.json()).asset.id
  const before = await draft()
  expect((await page.request.post('/api/dashboard/website', { data: { action: 'save', content: { ...before.draft, logo }, baseUpdatedAt: before.updatedAt }, headers: { Origin: origin } })).status()).toBe(200)
  expect((await draft()).draft.logo).toBe(logo)
  await page.reload()
  // With an AI-designed draft the designer sits under a collapsed row above the editor.
  await page.getByText('Import your current website · AI designer').click()
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'AI designer' }) })
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  await expect(frame.locator('link[rel="icon"]')).toHaveAttribute('href', `/site-assets/${logo}`)
  const h1 = await frame.getByRole('heading', { level: 1 }).textContent()
  // Through the conversation: applied at once, nothing else touched, reported from the saved state.
  await card.getByLabel('Ask for a change').fill('Remove my logo')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(card.getByText('Done: the logo is removed from your draft. Nothing else changed.')).toBeVisible({ timeout: 15_000 })
  const result = card.getByRole('status', { name: 'Result of your request' })
  await expect(result).toContainText('Applied: Logo removed')
  await expect(frame.locator('link[rel="icon"]')).toHaveAttribute('href', /^\/site-icon\//, { timeout: 15_000 })
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(h1)
  const after = await draft()
  expect(after.draft.logo).toBeNull()
  expect({ ...after.draft, logo: null }).toEqual({ ...before.draft, logo: null })
  // Honest when there is nothing to do.
  await card.getByLabel('Ask for a change').fill('take the logo off')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(result).toContainText('Not applied: Remove logo · There is no logo on the draft', { timeout: 15_000 })
  // A real design turn afterwards (the mocked model): the design changes, the logo stays removed.
  await card.getByLabel('Ask for a change').fill('Make it darker and more premium')
  await card.getByRole('button', { name: 'Send' }).click()
  await expect(card.getByText('Darker and more premium, with a serif headline.').last()).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await draft()).draft.logo).toBeNull()
  await expect(frame.locator('link[rel="icon"]')).toHaveAttribute('href', /^\/site-icon\//)
  // Undo the logo removal from the conversation is not offered any more (a later turn exists); the editor history keeps
  // the copy. Nothing was published by any of this.
  expect((await draft()).published).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
