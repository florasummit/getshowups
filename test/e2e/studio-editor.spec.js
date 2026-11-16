// Website Studio editor in the browser (real local server, real routes): edit an AI-designed website directly, without
// AI. Each browser project edits its own seeded business (e2e-editor / e2e-editor-m, test/e2e/editor-draft.json), so the
// desktop and phone runs never touch the same website.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const tokenFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_EDITOR_M_SESSION_TOKEN : fixtures.E2E_EDITOR_SESSION_TOKEN)
const customerFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_EDITOR_M_CUSTOMER : fixtures.E2E_EDITOR_CUSTOMER)

test('owner edits the AI-designed website without AI: click to edit, undo/redo, services, sections, pages, look; autosave survives a reload @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  const aiCalls = []
  page.on('request', (r) => /\/api\/dashboard\/website\/designer|\/api\/dashboard\/website$/.test(new URL(r.url()).pathname) && r.method() === 'POST' && /"action":"(generate|revise|message|different)"/.test(r.postData() || '') && aiCalls.push(r.url()))
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  const h1 = frame.getByRole('heading', { level: 1 })
  const saved = studio.locator('[data-save="saved"]')
  const pageSelect = studio.getByRole('combobox', { name: 'Page', exact: true })
  await expect(h1).toHaveText('Clear water, every week.')

  // Click the headline in the preview → its field opens focused; typing updates the preview and autosaves.
  await h1.click()
  const heading = studio.getByRole('textbox', { name: /^Heading/ }).first()
  await expect(heading).toBeFocused()
  await heading.fill('Pools, handled with care')
  await expect(h1).toHaveText('Pools, handled with care')
  await expect(saved).toBeVisible()
  await studio.getByRole('button', { name: 'Undo' }).click()
  await expect(h1).toHaveText('Clear water, every week.')
  await studio.getByRole('button', { name: 'Redo' }).click()
  await expect(h1).toHaveText('Pools, handled with care')

  // A service price and its description on the page.
  await frame.getByRole('heading', { name: 'Services', exact: true }).click()
  await studio.getByRole('textbox', { name: /^Price/ }).first().fill('$300+')
  await studio.getByRole('textbox', { name: /^Description on this page/ }).first().fill('Every week: skim, brush, balance.')
  await expect(frame.getByText('$300+')).toBeVisible()
  await expect(frame.getByText('Every week: skim, brush, balance.')).toBeVisible()

  // Sections: add questions, hide them (faded in the editor only), move, duplicate.
  await studio.getByRole('tab', { name: 'Page' }).click()
  await studio.getByLabel('Add a section').selectOption('faq')
  await studio.getByRole('button', { name: 'Add section' }).click()
  await expect(frame.getByRole('heading', { name: 'Questions', exact: true })).toBeVisible()
  const faqRow = studio.locator('.studio-sections li', { hasText: 'Questions: Questions' })
  await faqRow.getByRole('button', { name: 'Hide' }).click()
  await expect(frame.locator('.ge-hidden')).toHaveCount(1)
  await expect(frame.getByText('Hidden · not on your website')).toBeVisible()
  await studio.locator('.studio-sections li', { hasText: 'Booking banner' }).first().getByRole('button', { name: 'Duplicate' }).click()
  await expect(studio.locator('.studio-sections li', { hasText: 'Booking banner' })).toHaveCount(2)
  await studio.locator('.studio-sections li', { hasText: 'Booking banner' }).last().getByRole('button', { name: /Move Booking banner up/ }).click()

  // Pages: add a Contact page with a contact form; set its Google title.
  await studio.getByLabel('Add a page').selectOption('contact')
  await studio.getByRole('button', { name: 'Add page' }).click()
  await expect(pageSelect).toHaveValue('contact')
  await expect(frame.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(frame.getByLabel('Your name')).toBeVisible()
  await studio.getByRole('textbox', { name: /^Title in Google/ }).fill('Contact Editor Pools')

  // Look: approved fonts and button style; desktop / phone preview.
  await studio.getByRole('tab', { name: 'Look' }).click()
  await studio.getByLabel('Fonts').selectOption('fraunces|manrope')
  await studio.getByLabel('Buttons').selectOption('pill')
  await studio.getByRole('button', { name: 'Phone' }).click()
  await expect(studio.locator('.studio-preview--phone iframe')).toBeVisible()
  await expect(saved).toBeVisible()

  // Reload: everything came back from the server (not only shown).
  await page.reload()
  await expect(h1).toHaveText('Pools, handled with care')
  await expect(frame.getByText('$300+')).toBeVisible()
  await expect(pageSelect.locator('option', { hasText: 'Contact' })).toHaveCount(1)
  await studio.getByRole('tab', { name: 'Look' }).click()
  await expect(studio.getByLabel('Fonts')).toHaveValue('fraunces|manrope')
  await expect(studio.getByLabel('Buttons')).toHaveValue('pill')
  await pageSelect.selectOption('contact')
  await studio.getByRole('tab', { name: 'Page' }).click()
  await expect(studio.getByRole('textbox', { name: /^Title in Google/ })).toHaveValue('Contact Editor Pools')
  await pageSelect.selectOption('')
  await expect(frame.locator('.ge-hidden')).toHaveCount(1)

  // Nothing went live: AI-designed websites can't be published yet, and no AI was called for any of this.
  await expect(page.getByText('AI-designed websites stay private')).toBeVisible()
  expect((await page.request.get(`/p/${customerFor(info)}`)).status()).toBe(404)
  expect(aiCalls, 'editing never calls AI').toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('keyboard: every editing action is reachable without the preview (section list, labelled fields)', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  await studio.getByRole('tab', { name: 'Page' }).focus()
  await page.keyboard.press('Enter')
  const first = studio.locator('.studio-sections li').first().getByRole('button').first()
  await first.focus()
  await page.keyboard.press('Enter')
  await expect(studio.getByRole('textbox', { name: /^Heading/ }).first()).toBeVisible()
})

test('two tabs: a save from an older tab is refused with a clear choice, never silently overwriting the newer edit', async ({ browser }, info) => {
  test.skip(info.project.name === 'mobile', 'one run is enough')
  const context = await browser.newContext()
  await useSession(context, tokenFor(info))
  const a = await context.newPage()
  const b = await context.newPage()
  for (const p of [a, b]) await p.goto('/dashboard/website')
  const edit = async (p, text) => {
    const studio = p.locator('section[aria-label="Website Studio editor"]')
    await p.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 }).click()
    await studio.getByRole('textbox', { name: /^Heading/ }).first().fill(text)
    return studio
  }
  const sa = await edit(a, 'Saved first in tab A')
  await expect(sa.locator('[data-save="saved"]')).toBeVisible()
  const sb = await edit(b, 'Typed later in tab B')
  await expect(sb.locator('[data-save="conflict"]')).toBeVisible()
  await expect(sb.getByText('This website was changed somewhere else')).toBeVisible()
  await sb.getByRole('button', { name: 'Load the latest version' }).click()
  await expect(b.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 })).toHaveText('Saved first in tab A')
  await context.close()
})
