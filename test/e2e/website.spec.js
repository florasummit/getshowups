// Website tab. A business with no website: one start decision → three designs → the full editor → publish with explicit
// consent → visitors book through it with ad parameters kept → take it offline. A business with an existing single-page
// website: edits (autosaved), publish, restore an earlier version, stale-page protection, the included AI change, and
// the move to the full editor on request.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('no website yet: one start decision → three designs → the full editor → publish → visitors book → take offline @mobile', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  // Its own visitor address: the public-page allowance is per address, and every spec otherwise shares 127.0.0.1.
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': mobile ? '198.51.100.234' : '198.51.100.233' })
  const id = mobile ? fixtures.E2E_HOME_CUSTOMER : fixtures.E2E_CUSTOMER
  await useSession(context, mobile ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  const site = async () => (await page.request.get('/api/dashboard/website')).json()

  // Not public before publishing.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { name: 'This website isn’t available' })).toBeVisible()

  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Finish my website' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible()
  // WEB-05: one decision with two answers; nothing about addresses, hosting or AI accounts before a draft exists.
  const start = page.getByRole('region', { name: 'How would you like to start?' })
  await expect(start.getByRole('button')).toHaveCount(2)
  await expect(page.locator('.app input:visible, .app select:visible, .app textarea:visible')).toHaveCount(0)
  for (const name of ['Website address', 'Where your website lives', 'AI designer', 'Your website, step by step']) await expect(page.getByRole('region', { name })).toHaveCount(0)
  await noOverflow()

  const before = (await site()).aiUsage.generation.remaining
  await start.getByRole('button', { name: /Create my website/ }).click()
  await expect(page.locator('.design-card')).toHaveCount(3)
  // ONB-07: the first "Use this design" is on screen without scrolling past the preview.
  await expect(page.getByRole('button', { name: /Use this design/ }).first()).toBeInViewport()
  // WEB-10: the designs already counted against today's allowance, so a reload still offers them (and counts nothing more).
  const afterGenerating = (await site()).aiUsage.generation.remaining
  expect(afterGenerating).toBeLessThanOrEqual(before)
  await page.reload()
  await expect(page.locator('.design-card')).toHaveCount(3)
  expect((await site()).aiUsage.generation.remaining).toBe(afterGenerating)
  const chosen = await page.locator('.design-card strong').first().textContent()
  await page.getByRole('button', { name: /Use this design/ }).first().click()

  // WEB-01: the chosen design opens in the full editor, with the same controls as every other way to start.
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  await expect(studio).toBeVisible({ timeout: 20_000 })
  for (const tab of ['Sections', 'Style', 'Photos', 'History']) await expect(studio.getByRole('tab', { name: tab })).toBeVisible()
  await expect(studio.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(studio.getByRole('combobox').first().locator('option[value="__add"]')).toHaveText('+ Add a page…')
  await expect(page.getByRole('heading', { name: 'Edit text and photos' })).toHaveCount(0)
  await expect(page.getByLabel('Describe a change')).toHaveCount(0)
  const draft = (await site()).website.draft
  expect(draft.site.name).toBe(chosen)
  expect(draft.site.pages.map((p) => p.slug)).toEqual(['', 'contact', 'privacy'])
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(draft.headline)
  // WEB-09: inside the editor the "Preview. Only you can see this." strip is not shown.
  await expect(frame.getByText('Only you can see this')).toHaveCount(0)
  await noOverflow()

  // WEB-06: what is still missing is derived from the records on every load (it survives a reload) and links to the
  // place where it is added.
  const missing = page.getByRole('region', { name: 'Details to add' })
  await expect(missing.locator('[data-missing]').first()).toBeVisible()
  const first = await missing.locator('[data-missing]').first().getAttribute('data-missing')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Details to add' }).locator(`[data-missing="${first}"]`).getByRole('link')).toHaveAttribute('href', /^(\/dashboard\/settings#[a-z-]+|#site-edit)$/)

  // Publish requires the consent checkbox (and the review of the starter privacy page).
  const status = page.locator('section[aria-label="Website status"]')
  await expect(status.getByText('Not published yet')).toBeVisible()
  await status.getByRole('button', { name: 'Publish website' }).click()
  const publish = page.getByRole('button', { name: 'Publish website' }).last()
  await expect(publish).toBeDisabled()
  if ((await site()).missing.some((k) => k.startsWith('services'))) await expect(status.locator('[data-publish-note="services"]')).toContainText('doesn’t show your services')
  await page.getByRole('checkbox', { name: /details are accurate/ }).check()
  await page.getByRole('checkbox', { name: /I’ve read my privacy policy page/ }).check()
  await publish.click()
  await expect(status.getByText('Live', { exact: true })).toBeVisible()

  // Visitors: server-rendered site, ad parameters carried to booking.
  await page.goto(`/p/${id}?utm_source=google&utm_campaign=camp12345678`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(draft.headline)
  await expect(page.getByRole('heading', { level: 2, name: 'Ready when you are.' })).toBeVisible()
  await noOverflow()
  // WEB-02: every page of the header menu is reachable on a phone too.
  await expect(page.locator('header.nav ul').getByRole('link', { name: 'Contact' })).toBeVisible()
  await page.getByRole('link', { name: 'Book online' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/book/${id}\\?utm_source=google&utm_campaign=camp12345678$`))
  await expect(page.getByRole('heading', { level: 1, name: /^(What can we help with\?|Weekly pool care|Pick a time|Pick a visit time)$/ })).toBeVisible()

  // WEB-04: taking the website offline is one click from the Live bar; the question says what visitors will see and the
  // result is shown right there.
  await page.goto('/dashboard/website')
  await status.getByRole('button', { name: 'Take website offline' }).click()
  const confirm = status.locator('[data-confirm]')
  await expect(confirm).toContainText('will see “This website isn’t available” until you publish again')
  await confirm.getByRole('button', { name: 'Take website offline' }).click()
  await expect(status.locator('[data-site-note]')).toContainText('Your website is offline.')
  await expect(status.locator('[data-site-note]')).toBeInViewport()
  await expect(status.getByText('Not published', { exact: true })).toBeVisible()
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { name: 'This website isn’t available' })).toBeVisible()
})

test('changes stay private until published again; an earlier version can be restored', async ({ page, context }) => {
  // Its own business with an already-published site: never shares state with the edit-and-publish test above.
  await useSession(context, fixtures.E2E_PUBLISH_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  // Website Studio is available to every eligible business (no allowlist, and no Studio variable set, as in production):
  // the import, the AI designer and the Claude/OpenAI key choice are offered; manual editing works without any key.
  await expect(page.getByLabel('Headline')).toBeVisible()
  await expect(page.locator('section[aria-label="AI designer"], section[aria-label="Bring your current website"]')).toHaveCount(2)
  await expect(page.getByRole('radio', { name: 'Claude' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'OpenAI' })).toBeVisible()
  expect((await page.request.get('/api/dashboard/website/designer')).status()).toBe(200)
  await page.getByLabel('Headline').fill('A brand new headline')
  await expect(page.getByText('All changes saved')).toBeVisible()
  await expect(page.getByText('you have changes that aren’t published yet')).toBeVisible()
  expect(await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()).not.toContain('A brand new headline')
  await page.getByRole('button', { name: 'Publish changes' }).first().click()
  await page.getByRole('checkbox', { name: /details are accurate/ }).check()
  // Wait for the publish itself: the site was already Live before, so the Live badge alone doesn't mean it finished.
  const published = page.waitForResponse((r) => r.url().endsWith('/api/dashboard/website') && r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'publish')
  await page.getByRole('button', { name: 'Publish changes' }).last().click()
  expect((await published).status()).toBe(200)
  await expect(page.locator('.site-status').getByText('Live', { exact: true })).toBeVisible()
  expect(await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()).toContain('A brand new headline')

  await page.getByText('Published versions and download').click()
  await page.getByRole('button', { name: 'Restore' }).first().click()
  // Restoring replaces the live site: the owner confirms it in the page, and is told what it replaces.
  const confirm = page.locator('[data-confirm]')
  await expect(confirm).toContainText('your draft becomes that version too')
  await confirm.getByRole('button', { name: 'Restore this version' }).click()
  await expect.poll(async () => (await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()).includes('Pool care in Charleston')).toBe(true)
})

test('a page showing an older draft never saves or publishes over newer work (another tab, device or a deploy)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_PUBLISH_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  await page.getByLabel('Headline').fill('Edited on this page')
  await expect(page.getByText('All changes saved')).toBeVisible()
  // Meanwhile the draft changes elsewhere (another tab or device): saved straight through the API.
  const latest = await (await page.request.get('/api/dashboard/website')).json()
  const other = await page.request.post('/api/dashboard/website', {
    data: { action: 'save', content: { ...latest.website.draft, headline: 'Saved on another device' }, baseUpdatedAt: latest.website.updatedAt },
    headers: { Origin: new URL(page.url()).origin },
  })
  expect(other.status()).toBe(200)
  // Publishing from this page (which still shows the older draft) is refused and says why; nothing goes live.
  const liveBefore = await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()
  await page.getByRole('button', { name: 'Publish changes' }).first().click()
  await page.getByRole('checkbox', { name: /details are accurate/ }).check()
  await page.getByRole('button', { name: 'Publish changes' }).last().click()
  await expect(page.getByText(/changed somewhere else .* nothing was published/)).toBeVisible()
  expect(await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()).toBe(liveBefore)
  // Editing on this page doesn't overwrite the newer draft either.
  await page.keyboard.press('Escape')
  await page.getByLabel('Headline').fill('Typed on the older page')
  await expect(page.getByText(/changed somewhere else .* wasn’t saved/)).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/website')).json()).website.draft.headline).toBe('Saved on another device')
})

test('a change typed just before leaving the page is saved, not dropped (another tab, a reload after a deploy)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_PUBLISH_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  await page.getByLabel('Headline').fill('Typed right before leaving')
  // Leave at once, before the autosave delay: the waiting change goes out as the editor closes.
  await page.locator('.tabs').getByRole('link', { name: 'Overview' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/dashboard/website')).json()).website.draft.headline).toBe('Typed right before leaving')
})

test('an existing single-page website keeps its editor: AI change is shown before it is kept, survives a reload, and never reads as saved', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_PUBLISH_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  await expect(page.getByRole('heading', { name: 'Edit text and photos' })).toBeVisible()
  const caption = page.locator('.site-preview figcaption')
  const previewH1 = page.frameLocator('iframe[title="Website preview"]').getByRole('heading', { level: 1 })
  // Today's AI allowance is shown; it says whose limit it is in plain words (no "API key" for the included writer).
  await expect(page.locator('[data-allowance="revision"]')).toHaveText(/^\d+ of \d+ AI changes left today · resets at /)
  await expect(page.locator('[data-allowance-note="revision"]')).toHaveText('Included with GetShowUps at no extra cost. Editing by hand is never limited.')
  const left = (await (await page.request.get('/api/dashboard/website')).json()).aiUsage.revision.remaining
  await page.getByRole('button', { name: 'Make it more modern' }).click()
  await expect(page.getByText('Here’s the new version. Keep it?')).toBeVisible()
  await expect(previewH1).toHaveText(/^Modern /)
  await expect(caption).toHaveText('New version · not saved yet')
  // ONB-09: while a version waits for an answer nothing says "All changes saved", and publishing waits.
  await expect(page.getByText('All changes saved')).toHaveCount(0)
  await expect(page.locator('.save-status')).toContainText('isn’t saved yet')
  await expect(page.getByRole('button', { name: /^Publish/ })).toHaveCount(0)
  // WEB-10: the version already counted against today's allowance, so a reload still offers it.
  await page.reload()
  await expect(page.getByText('Here’s the new version. Keep it?')).toBeVisible()
  await expect(caption).toHaveText('New version · not saved yet')
  expect((await (await page.request.get('/api/dashboard/website')).json()).aiUsage.revision.remaining).toBe(left - 1)
  await page.getByRole('button', { name: 'Keep this' }).click()
  await expect(page.getByLabel('Describe a change')).toBeVisible()
  await expect(caption).toHaveText('Draft preview · only you can see this')
  await expect(page.getByText('All changes saved')).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/website')).json()).website.draft.headline).toMatch(/^Modern /)

  // "Start over" offers three designs; the one chosen stays a single-page website in this editor (nothing is converted).
  await page.getByRole('button', { name: 'Start over with three new designs' }).click()
  await expect(page.locator('[data-allowance="generation"]')).toHaveText(/^\d+ of \d+ new designs left today · resets at /)
  await page.getByRole('button', { name: 'Design it again' }).click()
  await expect(page.locator('.design-card')).toHaveCount(3)
  const chosen = await page.locator('.design-card strong').first().textContent()
  await page.getByRole('button', { name: /Use this design/ }).first().click()
  await expect(page.locator('.design-card')).toHaveCount(0)
  const draft = (await (await page.request.get('/api/dashboard/website')).json()).website.draft
  expect([draft.design.name, Boolean(draft.site)]).toEqual([chosen, false])
  await expect(page.getByRole('heading', { name: 'Edit text and photos' })).toBeVisible()
})

test('an existing single-page website can be opened in the full editor on request; the live website and the old draft are kept', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_PUBLISH_SESSION_TOKEN)
  await page.goto('/dashboard/website')
  const liveBefore = await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()
  const headline = (await (await page.request.get('/api/dashboard/website')).json()).website.draft.headline
  const offer = page.getByRole('region', { name: 'Full editor' })
  await offer.getByRole('button', { name: 'Open in the full editor' }).click()
  await expect(offer.locator('[data-confirm]')).toContainText('Your live website doesn’t change until you publish')
  await offer.locator('[data-confirm]').getByRole('button', { name: 'Open in the full editor' }).click()
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  await expect(studio).toBeVisible({ timeout: 20_000 })
  await expect(page.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 })).toHaveText(headline)
  await expect(page.getByRole('heading', { name: 'Edit text and photos' })).toHaveCount(0)
  // The live website is exactly what it was; the draft from before is the first entry in History.
  expect(await (await page.request.get(`/p/${fixtures.E2E_PUBLISH_CUSTOMER}`)).text()).toBe(liveBefore)
  await studio.getByRole('tab', { name: 'History' }).click()
  await expect(studio.getByRole('list', { name: 'Earlier drafts' }).locator('li', { hasText: 'Before opening the full editor' })).toHaveCount(1)
  await expect(studio.getByRole('list', { name: 'Published versions' }).locator('li').first()).toBeVisible()
})
