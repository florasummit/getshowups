// Website Studio editor in the browser (real local server, real routes): edit an AI-designed website directly, without
// AI. Each browser project edits its own seeded business (e2e-editor / e2e-editor-m, test/e2e/editor-draft.json), so the
// desktop and phone runs never touch the same website.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const tokenFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_EDITOR_M_SESSION_TOKEN : fixtures.E2E_EDITOR_SESSION_TOKEN)
const customerFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_EDITOR_M_CUSTOMER : fixtures.E2E_EDITOR_CUSTOMER)

test('owner edits the website on the website itself: text in place, button panel, section controls, colours, pages, preview mode; autosave survives a reload; publish, republish, restore @mobile', async ({ page, context }, info) => {
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

  // Click the headline ON the website and type: it changes in place (no form), autosaves, and undo/redo work.
  await h1.click()
  await expect(h1).toHaveAttribute('contenteditable', /true|plaintext-only/)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Pools, handled with care')
  await page.keyboard.press('Enter')
  await expect(h1).toHaveText('Pools, handled with care')
  await expect(h1).not.toHaveAttribute('contenteditable', /.+/)
  await expect(saved).toBeVisible()
  await studio.getByRole('button', { name: 'Undo' }).click()
  await expect(h1).toHaveText('Clear water, every week.')
  await studio.getByRole('button', { name: 'Redo' }).click()
  await expect(h1).toHaveText('Pools, handled with care')

  // A button: click it on the website → a small panel with its text and where it goes.
  // (After an edit the preview refreshes; a click that lands during that refresh is retried, as a person would.)
  const pop = studio.getByRole('dialog', { name: 'Edit' })
  await expect(saved).toBeVisible()
  await expect(async () => {
    await frame.getByRole('link', { name: 'Book a visit' }).first().click()
    await expect(pop).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await pop.getByRole('textbox', { name: /^Text/ }).fill('Book a pool visit')
  await pop.getByLabel('Goes to').selectOption({ label: 'Section: Services' })
  await expect(frame.getByRole('link', { name: 'Book a pool visit' })).toHaveAttribute('href', '#services')
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)

  // A service price and description, typed directly on the website.
  const price = frame.getByText('$280+')
  await expect(saved).toBeVisible()
  await expect(async () => {
    await price.click()
    await expect(price).toHaveAttribute('contenteditable', /true|plaintext-only/, { timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('$300+')
  await page.keyboard.press('Enter')
  await expect(frame.getByText('$300+')).toBeVisible()

  // Sections: compact controls on the selected section (name · ↑ ↓ · ⋯); add, hide/show, duplicate, move.
  await studio.getByRole('tab', { name: 'Sections' }).click()
  await studio.getByLabel('Add a section').selectOption('faq')
  await studio.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(frame.getByRole('heading', { name: 'Questions', exact: true })).toBeVisible()
  const faqRow = studio.locator('.studio-sections li', { hasText: 'FAQ' })
  await faqRow.getByRole('button', { name: 'More for FAQ' }).click()
  await studio.getByRole('menuitem', { name: 'Hide from website' }).click()
  await expect(frame.locator('.ge-hidden')).toHaveCount(1)
  await expect(faqRow.getByText('Hidden')).toBeVisible()
  await faqRow.getByRole('button', { name: 'More for FAQ' }).click()
  await studio.getByRole('menuitem', { name: 'Show on website' }).click()
  await expect(frame.locator('.ge-hidden')).toHaveCount(0)
  await faqRow.getByRole('button', { name: 'More for FAQ' }).click()
  await studio.getByRole('menuitem', { name: 'Hide from website' }).click()
  // On the website itself: select the booking section → its bar → duplicate, then move the copy up.
  const bar = studio.getByRole('toolbar', { name: 'Booking section' })
  await expect(async () => {
    await frame.locator('#book-home').click({ position: { x: 30, y: 30 } })
    await expect(bar).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await bar.getByRole('button', { name: 'More for Booking' }).click()
  await studio.getByRole('menuitem', { name: 'Duplicate' }).click()
  await studio.getByRole('tab', { name: 'Sections' }).click()
  await expect(studio.locator('.studio-sections li', { hasText: 'Booking' })).toHaveCount(2)
  const order = async () => (await studio.locator('.studio-sections li .studio-section-name > span:first-child').allTextContents()).join(',')
  const copyUp = studio.locator('.studio-sections li').nth(4).getByRole('button', { name: 'Move Booking up' })
  await copyUp.click()
  await studio.locator('.studio-sections li').nth(3).getByRole('button', { name: 'Move Booking up' }).click()
  await expect.poll(order).toBe('Hero,Services,Booking,FAQ,Booking')

  // Colours: the brand colour changes the website.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await studio.getByLabel('Brand colour').fill('#7c3aed')
  await expect.poll(async () => (await frame.locator('style').allTextContents()).join('').includes('#7c3aed')).toBe(true)

  // Pages: "+ Add a page…" in the page menu → add a Contact page with a contact form; set its Google title.
  await pageSelect.selectOption('__add')
  await studio.getByRole('combobox', { name: 'Add a page', exact: true }).selectOption('contact')
  await studio.getByRole('button', { name: 'Add page' }).click()
  await expect(pageSelect).toHaveValue('contact')
  await expect(frame.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(frame.getByLabel('Your name')).toBeVisible()
  await studio.getByRole('textbox', { name: /^Title in Google/ }).fill('Contact Editor Pools')

  // Look: approved fonts and button style; phone preview; Preview mode shows the website without editing outlines.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await studio.getByLabel('Fonts').selectOption('fraunces|manrope')
  await studio.getByLabel('Buttons').selectOption('pill')
  await studio.getByRole('button', { name: 'Phone' }).click()
  await expect(studio.locator('.studio-preview--phone iframe')).toBeVisible()
  await studio.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(studio.getByRole('tab', { name: 'Style' })).toHaveCount(0)
  await expect(frame.locator('#ge-style')).toHaveCount(0)
  const anyHeading = frame.locator('[data-edit]').first()
  await anyHeading.click()
  await expect(anyHeading).not.toHaveAttribute('contenteditable', /.+/)
  await studio.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(saved).toBeVisible()

  // Reload: everything came back from the server (not only shown). The editor reopens on the page the owner was on
  // (Contact; remembered for this browser tab since 2026-11-19), then the home page is checked.
  await page.reload()
  await expect(pageSelect).toHaveValue('contact')
  await pageSelect.selectOption('')
  await expect(h1).toHaveText('Pools, handled with care')
  await expect(frame.getByText('$300+')).toBeVisible()
  await expect(frame.getByRole('link', { name: 'Book a pool visit' })).toBeVisible()
  await expect(pageSelect.locator('option', { hasText: 'Contact' })).toHaveCount(1)
  await studio.getByRole('tab', { name: 'Style' }).click()
  await expect(studio.getByLabel('Fonts')).toHaveValue('fraunces|manrope')
  await expect(studio.getByLabel('Buttons')).toHaveValue('pill')
  await pageSelect.selectOption('contact')
  await studio.getByRole('tab', { name: 'Sections' }).click()
  await expect(studio.getByRole('textbox', { name: /^Title in Google/ })).toHaveValue('Contact Editor Pools')
  await pageSelect.selectOption('')
  await expect(frame.locator('.ge-hidden')).toHaveCount(1)

  // Nothing went live by editing; no AI was called for any of this.
  expect((await page.request.get(`/p/${customerFor(info)}`)).status()).toBe(404)
  expect(aiCalls, 'editing never calls AI').toEqual([])

  // Publish (explicit confirmation) → public on the GetShowUps address; edit and republish; restore the first version.
  const status = page.locator('section[aria-label="Website status"]')
  const publishNow = async () => {
    await expect(saved).toBeVisible()
    await status.getByRole('button', { name: /^Publish/ }).first().click()
    await page.getByRole('checkbox', { name: /details are accurate/ }).check()
    await page.getByRole('button', { name: /^Publish/ }).last().click()
    await expect(status.getByText('Live', { exact: true })).toBeVisible({ timeout: 15_000 })
  }
  await publishNow()
  const site = `/p/${customerFor(info)}`
  await expect.poll(async () => (await (await page.request.get(site)).text()).includes('Pools, handled with care')).toBe(true)
  expect((await page.request.get(`${site}/contact`)).status()).toBe(200)
  const home = await (await page.request.get(site)).text()
  expect(home).toMatch(/<link rel="canonical"/)
  expect(home).toMatch(/href="[^"]*\/book\//)
  await h1.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Pools, published twice')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1300)
  await publishNow()
  await expect.poll(async () => (await (await page.request.get(site)).text()).includes('Pools, published twice')).toBe(true)
  page.once('dialog', (d) => d.accept())
  await page.getByText('Earlier versions and more').click()
  await page.getByRole('button', { name: 'Restore' }).last().click()
  await expect.poll(async () => (await (await page.request.get(site)).text()).includes('Pools, handled with care')).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('keyboard: every editing action is reachable without the preview (section list, labelled fields)', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  await studio.getByRole('tab', { name: 'Sections' }).focus()
  await page.keyboard.press('Enter')
  const first = studio.locator('.studio-sections li').first().getByRole('button').first()
  await first.focus()
  await page.keyboard.press('Enter')
  await expect(studio.getByRole('textbox', { name: /^Heading/ }).first()).toBeVisible()
  // Section actions by keyboard: the ⋯ menu opens with Enter, closes with Escape; arrows move sections.
  await studio.getByRole('tab', { name: 'Sections' }).click()
  const more = studio.locator('.studio-sections li').nth(1).getByRole('button', { name: /^More for / })
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(studio.getByRole('menuitem', { name: 'Hide from website' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(studio.getByRole('menu')).toHaveCount(0)
})

test('two tabs: a save from an older tab is refused with a clear choice, never silently overwriting the newer edit', async ({ browser }, info) => {
  test.skip(info.project.name === 'mobile', 'one run is enough')
  const context = await browser.newContext()
  await useSession(context, tokenFor(info))
  const a = await context.newPage()
  const b = await context.newPage()
  for (const p of [a, b]) await p.goto('/dashboard/website')
  // Both tabs must have loaded the site BEFORE tab A saves; otherwise tab B may load A's save and isn't "older".
  for (const p of [a, b]) await expect(p.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 })).toBeVisible()
  for (const p of [a, b]) await expect(p.locator('section[aria-label="Website Studio editor"] [data-save]').first()).toBeAttached()
  const edit = async (p, text) => {
    const studio = p.locator('section[aria-label="Website Studio editor"]')
    const h1 = p.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 })
    // A click that lands before the preview is wired for editing is ignored (CI flake 2026-11-18: typing went nowhere,
    // nothing saved, no conflict): click until the heading is actually editable, then type.
    await expect(async () => {
      await h1.click()
      await expect(h1).toHaveAttribute('contenteditable', /.+/, { timeout: 1000 })
    }).toPass({ timeout: 10_000 })
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.type(text)
    await p.keyboard.press('Enter')
    return studio
  }
  const sa = await edit(a, 'Saved first in tab A')
  await expect(sa.locator('[data-save="saved"]')).toBeVisible()
  const sb = await edit(b, 'Typed later in tab B')
  await expect(sb.locator('[data-save="conflict"]')).toBeVisible()
  await expect(sb.getByText('This website was changed in another window')).toBeVisible()
  await sb.getByRole('button', { name: 'Load the latest version' }).click()
  await expect(b.frameLocator('iframe[title="Editable website preview"]').getByRole('heading', { level: 1 })).toHaveText('Saved first in tab A')
  await context.close()
})

test('photos: upload makes a phone version; frame a photo (shape + focus); draft history restores; unused photos can be cleaned up @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  page.on('dialog', (d) => d.accept())
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  const saved = async () => {
    await page.waitForTimeout(1300)
    await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  }
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()

  // Upload: the browser resizes it and stores a phone-sized copy next to it.
  await studio.getByRole('tab', { name: 'Photos' }).click()
  await studio.locator('input[type="file"]').setInputFiles('public/site-stock/' + (await import('node:fs')).readdirSync('public/site-stock').find((f) => f.endsWith('.jpg') && !f.includes('-sm')))
  await expect(studio.getByText('Phone version ready')).toBeVisible({ timeout: 20_000 })
  await saved()

  // Use it in the opening and frame it: square crop, focus point by keyboard.
  await frame.locator('.hero-media').click()
  const photoGroup = studio.getByRole('dialog', { name: 'Edit' })
  await photoGroup.locator('.studio-thumb').last().click()
  await photoGroup.getByLabel('Shape').selectOption('1x1')
  await expect(frame.locator('.hero-media img')).toHaveAttribute('style', /aspect-ratio:1\/1/)
  await expect(frame.locator('.hero-media img')).toHaveAttribute('srcset', /800w/)
  await photoGroup.getByRole('button', { name: /Point to keep in view/ }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(frame.locator('.hero-media img')).toHaveAttribute('style', /object-position:45% 50%/)
  await saved()

  // History: earlier server copies of the draft; restoring one changes only the draft and can itself be undone.
  await studio.getByRole('tab', { name: 'History' }).click()
  const versions = studio.locator('.studio-history-panel li')
  await expect(versions.first()).toBeVisible()
  await versions.last().getByRole('button', { name: 'Restore' }).click()
  await expect(studio.locator('[data-save="saved"]')).toBeVisible()
  await expect(studio.locator('.studio-history-panel li', { hasText: 'Before a restore' })).toHaveCount(1)
  await studio.locator('.studio-history-panel li', { hasText: 'Before a restore' }).getByRole('button', { name: 'Restore' }).click()
  await expect(frame.locator('.hero-media img')).toHaveAttribute('style', /aspect-ratio:1\/1/)

  // Cleanup keeps everything in use (the photo is in the draft and in history).
  await studio.getByRole('tab', { name: 'Photos' }).click()
  await studio.getByRole('button', { name: 'Remove unused photos' }).click()
  await expect(studio.getByText(/Every photo is in use|Removed \d+ unused file/)).toBeVisible()
  await expect(studio.getByText('Phone version ready')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('full screen + tablet view; "No photo" really removes an unwanted picture and it stays removed after saving and reloading (PoolThru) @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()

  // Full screen: the same editor fills the window (and is a URL of its own); Esc returns.
  await studio.getByRole('button', { name: 'Full screen' }).click()
  await expect(studio).toHaveClass(/studio--full/)
  await expect(page).toHaveURL(/[?&]full=1/)
  if (process.env.STUDIO_SHOTS) await page.screenshot({ path: `${process.env.STUDIO_SHOTS}/${info.project.name}-studio-full.png` })
  const box = await studio.boundingBox()
  const vp = page.viewportSize()
  expect(box.width).toBeGreaterThanOrEqual(vp.width - 1)
  expect((await page.locator('iframe[title="Editable website preview"]').boundingBox()).height).toBeGreaterThan(vp.height * 0.6)
  await page.keyboard.press('Escape')
  await expect(studio).not.toHaveClass(/studio--full/)
  await expect(page).not.toHaveURL(/full=1/)
  await page.goto('/dashboard/website?full=1')
  await expect(page.locator('section.studio--full')).toBeVisible()
  await page.locator('section.studio--full').getByRole('button', { name: 'Exit full screen' }).click()

  // Tablet view (desktop browser): an 820px-wide preview.
  if (info.project.name !== 'mobile') {
    await studio.getByRole('group', { name: 'Preview size' }).getByRole('button', { name: 'Tablet' }).click()
    expect(Math.round((await page.locator('iframe[title="Editable website preview"]').boundingBox()).width)).toBe(820)
    await studio.getByRole('group', { name: 'Preview size' }).getByRole('button', { name: 'Desktop' }).click()
  }

  // The opening's picture: "No photo" used to be ignored, so an unwanted picture could only be swapped.
  await expect(frame.locator('.hero-media img')).toBeVisible()
  const photo = studio.getByRole('dialog', { name: 'Edit' })
  // Leaving full screen re-renders the preview; a click that lands while it is being re-wired is ignored (CI flake,
  // 2026-11-18), so click until the photo panel opens. The assertion itself is unchanged.
  await expect(async () => {
    await frame.locator('.hero-media').click()
    await expect(photo.locator('.studio-thumb[aria-pressed="true"]')).toHaveCount(1, { timeout: 1500 }) // the owner sees which picture is in use
  }).toPass({ timeout: 10_000 })
  await photo.getByRole('button', { name: 'No photo' }).click()
  await expect(frame.locator('.hero-media')).toHaveCount(0)
  await page.waitForTimeout(1300)
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(frame.locator('.hero-media')).toHaveCount(0)
  await studio.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' }).click()
  await expect(frame.locator('.hero-media')).toHaveCount(0)
  // Undo brings it back (removal is reversible until the owner publishes).
  await studio.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Edit' }).click()
})

test('logo: upload → replace → remove from website (stays removed after a reload and when published; letter-mark icon) → an old version brings it back → remove again → delete the file for good only once nothing live or in the draft shows it; the deleted file never comes back @mobile', async ({ page, context }, info) => {
  test.setTimeout(240_000)
  await useSession(context, tokenFor(info))
  const dialogs = []
  page.on('dialog', (d) => (dialogs.push(d.message()), d.accept()))
  await page.goto('/dashboard/website')
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  const status = page.locator('section[aria-label="Website status"]')
  const site = `/p/${customerFor(info)}`
  const saved = async () => {
    await page.waitForTimeout(1300)
    await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  }
  const stock = (await import('node:fs')).readdirSync('public/site-stock').filter((f) => f.endsWith('.jpg') && !f.includes('-sm'))
  const logoPanel = studio.getByTestId('logo-panel')
  const icon = frame.locator('link[rel="icon"]')
  const draft = async () => (await (await page.request.get('/api/dashboard/website')).json()).website
  const publishNow = async () => {
    await saved()
    await status.getByRole('button', { name: /^Publish/ }).first().click()
    await page.getByRole('checkbox', { name: /details are accurate/ }).check()
    await page.getByRole('button', { name: /^Publish/ }).last().click()
    await expect(status.getByText('Live', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(status.getByText('aren’t published yet')).toHaveCount(0, { timeout: 15_000 })
    return (await draft()).liveVersion
  }
  // "Earlier versions and more" lists versions newest first, the live one without a Restore button.
  const restoreVersion = async (v) => {
    const live = (await draft()).liveVersion
    const details = page.locator('details', { has: page.locator('summary', { hasText: 'Earlier versions and more' }) })
    if (!(await details.evaluate((d) => d.open))) await details.locator('summary').click()
    await page.getByRole('button', { name: 'Restore' }).nth(live - v - 1).click()
    await expect.poll(async () => (await draft()).liveVersion, { timeout: 15_000 }).toBe(v)
  }
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()

  // Upload a logo (plain button, no AI): it becomes the site icon in the preview and is saved.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await expect(logoPanel.getByText('No logo')).toBeVisible()
  await logoPanel.getByTestId('logo-file').setInputFiles(`public/site-stock/${stock[0]}`)
  await expect(logoPanel.getByRole('img', { name: 'Current logo' })).toBeVisible({ timeout: 20_000 })
  const first = (await logoPanel.getByRole('img', { name: 'Current logo' }).getAttribute('src')).split('/').pop()
  await expect(icon).toHaveAttribute('href', `/site-assets/${first}`)
  await saved()
  expect((await draft()).draft.logo).toBe(first)

  // Replace: only the pointer changes (a second file; the first stays in the library, marked Logo).
  await logoPanel.getByTestId('logo-file').setInputFiles(`public/site-stock/${stock[1]}`)
  await expect(logoPanel.getByRole('img', { name: 'Current logo' })).not.toHaveAttribute('src', `/site-assets/${first}`, { timeout: 20_000 })
  const second = (await logoPanel.getByRole('img', { name: 'Current logo' }).getAttribute('src')).split('/').pop()
  await expect(icon).toHaveAttribute('href', `/site-assets/${second}`)
  await saved()
  expect((await draft()).draft.logo).toBe(second)
  await expect(logoPanel.getByRole('button', { name: 'Replace logo' })).toBeVisible()

  // Publish with the logo (version with it), so an earlier version can bring it back later.
  const logoVersion = await publishNow()
  expect(await (await page.request.get(site)).text()).toContain(`<link rel="icon" href="/site-assets/${second}">`)

  // Remove from website: explicit "no logo", saved, still gone after a reload; the files are still listed under Photos.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await logoPanel.getByRole('button', { name: 'Remove from website' }).click()
  await expect(logoPanel.getByText('No logo')).toBeVisible()
  await expect(icon).toHaveAttribute('href', /^\/site-icon\//)
  await saved()
  expect((await draft()).draft.logo).toBeNull()
  await page.reload()
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()
  await studio.getByRole('tab', { name: 'Style' }).click()
  await expect(logoPanel.getByText('No logo')).toBeVisible()
  await expect(icon).toHaveAttribute('href', /^\/site-icon\//)
  await studio.getByRole('tab', { name: 'Photos' }).click()
  const rowOf = (id) => studio.locator('.studio-photo-list').first().locator('.studio-photo-row', { has: page.locator(`img[src="/site-assets/${id}"]`) }).first()
  await expect(rowOf(first).getByText(/^Logo ·/)).toBeVisible()
  await expect(rowOf(second).getByText(/^Logo ·/)).toBeVisible()
  // The current logo is on the live website: no delete offered for it. The first file (replaced before publishing) is
  // only in the library: it can be deleted, but we keep it to choose it again later.
  await expect(rowOf(second).getByRole('button', { name: /for good$/ })).toHaveCount(0)
  await expect(rowOf(first).getByRole('button', { name: /for good$/ })).toBeVisible({ timeout: 15_000 })

  // Publish without the logo: the live site's icon is the letter mark; no image of the logo anywhere on it.
  await publishNow()
  const live = await (await page.request.get(site)).text()
  expect(live).toMatch(/<link rel="icon" href="\/site-icon\//)
  expect(live).not.toContain(`/site-assets/${second}`)
  // The published logo file is now only in a saved version: the live site and the draft don't show it → deletable.
  await studio.getByRole('tab', { name: 'Photos' }).click()
  await expect(rowOf(second).getByRole('button', { name: /for good$/ })).toBeVisible({ timeout: 15_000 })

  // An OLD version is an explicit owner action: restoring it brings its logo back (the file still exists).
  await restoreVersion(logoVersion)
  expect(await (await page.request.get(site)).text()).toContain(`/site-assets/${second}`)
  expect((await draft()).draft.logo).toBe(second)
  await expect(icon).toHaveAttribute('href', `/site-assets/${second}`, { timeout: 15_000 })

  // Remove again and publish: back to no logo for good on the live site.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await logoPanel.getByRole('button', { name: 'Remove from website' }).click()
  await expect(icon).toHaveAttribute('href', /^\/site-icon\//)
  await publishNow()
  expect(await (await page.request.get(site)).text()).not.toContain(`/site-assets/${second}`)

  // Delete the published logo file for good (confirmed): it leaves the library and every saved version, so restoring
  // the version that showed it can no longer bring it back; the other file is untouched.
  await studio.getByRole('tab', { name: 'Photos' }).click()
  await rowOf(second).getByRole('button', { name: /for good$/ }).click()
  expect(dialogs.at(-1)).toMatch(/Delete this photo for good\?.*saved version/)
  await expect(rowOf(second)).toHaveCount(0)
  await expect(studio.getByText(/^Photo deleted\./)).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/website')).json()).assets.map((a) => a.id)).not.toContain(second)
  expect((await page.request.get(`/site-assets/${second}`)).status()).toBe(404)
  await restoreVersion(logoVersion)
  expect(await (await page.request.get(site)).text()).not.toContain(`/site-assets/${second}`)
  expect((await draft()).draft.logo).toBeNull()
  // The first file is still there and can be chosen again as the logo; then removed, leaving the draft without one.
  await studio.getByRole('tab', { name: 'Style' }).click()
  await logoPanel.getByRole('button', { name: 'Choose an uploaded file' }).click()
  await logoPanel.locator('.studio-thumb', { has: page.locator(`img[src="/site-assets/${first}"]`) }).click()
  await expect(icon).toHaveAttribute('href', `/site-assets/${first}`)
  await logoPanel.getByRole('button', { name: 'Remove from website' }).click()
  await saved()
  expect((await draft()).draft.logo).toBeNull()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
