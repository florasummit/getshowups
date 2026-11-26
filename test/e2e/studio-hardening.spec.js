// Website Studio hardening (2026-11-19): full screen + browser Back/Forward, Escape from inside the preview, editor
// state that survives a dashboard tab switch and a reload, the preview keeping its scroll after an edit, and photo
// usage / replace / delete. Each browser project uses its own seeded business (e2e-studio-h / e2e-studio-h-m,
// test/e2e/serve.sh "studio-hardening seeds"), never another spec's website. No AI, no outside calls.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'
import { readdirSync } from 'node:fs'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const tokenFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_STUDIO_H_M_SESSION_TOKEN : fixtures.E2E_STUDIO_H_SESSION_TOKEN)
const studioOf = (page) => page.locator('section[aria-label="Website Studio editor"]')
const frameOf = (page) => page.frameLocator('iframe[title="Editable website preview"]')
const STOCK = readdirSync('public/site-stock').filter((f) => f.endsWith('.jpg') && !f.includes('-sm'))

async function openWebsiteTab(page) {
  await page.goto('/dashboard')
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Website' }).click()
  await expect(frameOf(page).getByRole('heading', { level: 1 })).toBeVisible()
  await expect(studioOf(page).locator('[data-save]').first()).toBeAttached()
}

test('full screen, panels and menus: Back closes the top layer first, Forward never re-opens it, Escape works from inside the preview @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await openWebsiteTab(page)
  const studio = studioOf(page)
  const frame = frameOf(page)

  // Full screen → Back: full screen closes, the owner is still in Studio. Forward: it stays closed.
  await studio.getByRole('button', { name: 'Full screen' }).click()
  await expect(studio).toHaveClass(/studio--full/)
  await expect(page).toHaveURL(/[?&]full=1/)
  // The website fills the width in full screen, on phones too (it used to be squeezed to a few pixels there).
  const vw = page.viewportSize().width
  expect((await page.locator('iframe[title="Editable website preview"]').boundingBox()).width).toBeGreaterThan(Math.min(vw * 0.8, 390 * 0.8))
  await page.goBack()
  await expect(studio).not.toHaveClass(/studio--full/)
  await expect(page).toHaveURL(/\/dashboard\/website$/)
  await expect(studio).toBeVisible()
  await page.goForward()
  await expect(studio).not.toHaveClass(/studio--full/)
  await expect(page).not.toHaveURL(/full=1/)

  // Escape pressed while focus is inside the preview frame leaves full screen; focus returns to the Full screen button.
  // (Keyboards: desktop. A phone tap doesn't move keyboard focus into the frame.)
  if (info.project.name !== 'mobile') {
    await studio.getByRole('button', { name: 'Full screen' }).click()
    await expect(studio).toHaveClass(/studio--full/)
    await expect(async () => {
      await frame.locator('#services').click({ position: { x: 12, y: 12 } })
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME') // focus is inside the preview
    }).toPass({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    await expect(studio).not.toHaveClass(/studio--full/)
    await expect(studio.getByRole('button', { name: 'Full screen' })).toBeFocused()
  }
  // The visible control: in full screen the Exit button is on screen and works.
  await studio.getByRole('button', { name: 'Full screen' }).click()
  await expect(studio.getByRole('button', { name: 'Exit full screen' })).toBeInViewport()
  await studio.getByRole('button', { name: 'Exit full screen' }).click()
  await expect(studio).not.toHaveClass(/studio--full/)
  await expect(page).not.toHaveURL(/full=1/)

  // The button panel: Back closes it (no navigation away); Forward doesn't bring it back.
  const pop = studio.getByRole('dialog', { name: 'Edit' })
  await expect(async () => {
    await frame.getByRole('link', { name: 'Book a visit' }).first().click()
    await expect(pop).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 15_000 })
  await page.goBack()
  await expect(pop).toHaveCount(0)
  await expect(studio).toBeVisible()
  await page.goForward()
  await expect(pop).toHaveCount(0)

  // A section's ⋯ menu: Back closes it; Escape closes it and puts focus back on its button.
  await studio.getByRole('tab', { name: 'Sections' }).click()
  const more = studio.locator('.studio-sections li').nth(1).getByRole('button', { name: /^More for / })
  await more.click()
  await expect(studio.getByRole('menu')).toBeVisible()
  await page.goBack()
  await expect(studio.getByRole('menu')).toHaveCount(0)
  await expect(studio).toBeVisible()
  await more.click()
  await page.keyboard.press('Escape')
  await expect(studio.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()

  // With nothing open, Back leaves Studio for the previous dashboard page; Forward returns to the editor, closed.
  await page.goBack()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(studio).toHaveCount(0)
  await page.goForward()
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(studio).not.toHaveClass(/studio--full/)
  await expect(pop).toHaveCount(0)
})

test('editor state: an unsaved edit, the page, panel tab and mode survive a dashboard tab switch and a reload; an older local copy goes through the conflict choice @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await openWebsiteTab(page)
  const studio = studioOf(page)
  const frame = frameOf(page)
  const pageSelect = studio.getByRole('combobox', { name: 'Page', exact: true })

  await pageSelect.selectOption('about')
  await studio.getByRole('tab', { name: 'Style' }).click()
  const footer = studio.getByRole('textbox', { name: /^Footer line/ })
  // Typed, then straight to another dashboard tab before the autosave runs.
  await footer.fill('Kept across tabs')
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Overview' }).click()
  await expect(studio).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Website' }).click()
  await expect(studio.getByText(/brought back the changes|All changes saved/)).toBeVisible()
  await expect(pageSelect).toHaveValue('about')
  await expect(studio.getByRole('tab', { name: 'Style' })).toHaveAttribute('aria-selected', 'true')
  await expect(studio.getByRole('textbox', { name: /^Footer line/ })).toHaveValue('Kept across tabs')
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  await expect(frame.getByText('Kept across tabs')).toBeVisible()

  // Reload: the server copy has the edit; the page and panel tab come back (this browser tab only).
  await page.reload()
  await expect(pageSelect).toHaveValue('about')
  await expect(studio.getByRole('tab', { name: 'Style' })).toHaveAttribute('aria-selected', 'true')
  await expect(studio.getByRole('textbox', { name: /^Footer line/ })).toHaveValue('Kept across tabs')
  await studio.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' }).click()
  await page.reload()
  await expect(studio.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  await studio.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Edit' }).click()

  // A local copy made from an OLDER server copy is never applied silently: the owner is asked, and keeping it goes
  // through the conflict check (409) with its two choices.
  const key = await page.evaluate(() => Object.keys(sessionStorage).find((k) => k.startsWith('gsu-studio-ui:')).slice('gsu-studio-ui:'.length))
  await page.evaluate(async (k) => {
    const w = (await (await fetch('/api/dashboard/website')).json()).website
    const draft = structuredClone(w.draft)
    draft.site.footer.text = 'From an older copy'
    localStorage.setItem(`gsu-studio-unsaved:${k}`, JSON.stringify({ base: w.updatedAt - 1000, content: draft }))
  }, key)
  await page.reload()
  await expect(studio.getByText(/saved somewhere else since/)).toBeVisible()
  await studio.getByRole('button', { name: 'Restore them' }).click()
  await expect(studio.locator('[data-save="conflict"]')).toBeVisible({ timeout: 15_000 })
  await studio.getByRole('button', { name: 'Load the latest version' }).click()
  await expect(studio.getByRole('textbox', { name: /^Footer line/ })).toHaveValue('Kept across tabs')
})

test('the preview keeps its scroll position when it re-renders after an edit', async ({ page, context }, info) => {
  test.skip(info.project.name === 'mobile', 'one run is enough')
  await useSession(context, tokenFor(info))
  await openWebsiteTab(page)
  const studio = studioOf(page)
  const frame = frameOf(page)
  await studio.getByRole('combobox', { name: 'Page', exact: true }).selectOption('')
  // A longer page: two more sections.
  await studio.getByRole('tab', { name: 'Sections' }).click()
  for (const t of ['faq', 'steps']) {
    await studio.getByLabel('Add a section').selectOption(t)
    await studio.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  const el = page.locator('iframe[title="Editable website preview"]')
  await expect.poll(async () => el.evaluate((f) => f.contentDocument.documentElement.scrollHeight - f.contentWindow.innerHeight)).toBeGreaterThan(200)
  await el.evaluate((f) => f.contentWindow.scrollTo(0, f.contentDocument.documentElement.scrollHeight))
  const y = await el.evaluate((f) => f.contentWindow.scrollY)
  expect(y).toBeGreaterThan(200)
  await studio.getByRole('tab', { name: 'Style' }).click()
  await studio.getByRole('textbox', { name: /^Footer line/ }).fill('Scroll stays put')
  await expect(frame.getByText('Scroll stays put')).toBeVisible()
  await expect.poll(async () => el.evaluate((f) => f.contentWindow.scrollY)).toBeGreaterThan(y - 40)
})

test('photos: "Used on" shows every place; replace everywhere in the draft; delete only what nothing uses (with a confirmation) @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await openWebsiteTab(page)
  const studio = studioOf(page)
  const frame = frameOf(page)
  await studio.getByRole('combobox', { name: 'Page', exact: true }).selectOption('')
  await studio.getByRole('tab', { name: 'Photos' }).click()
  await studio.locator('input[type="file"]').setInputFiles([`public/site-stock/${STOCK[0]}`, `public/site-stock/${STOCK[1]}`])
  await expect(studio.getByText('Phone version ready')).toHaveCount(2, { timeout: 30_000 })
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  const rows = studio.locator('.studio-photo-list').first().locator('.studio-photo-row')
  await expect(rows).toHaveCount(2)
  const idOf = async (row) => (await row.locator('img').getAttribute('src')).split('/').pop()
  const first = await idOf(rows.nth(0))
  const second = await idOf(rows.nth(1))

  // Put the first photo in the opening.
  const pop = studio.getByRole('dialog', { name: 'Edit' })
  await expect(async () => {
    await frame.locator('.hero-media').click()
    await expect(pop).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 15_000 })
  await pop.locator(`.studio-thumb img[src="/site-assets/${first}"]`).click()
  await expect(frame.locator('.hero-media img')).toHaveAttribute('src', `/site-assets/${first}`)
  await page.keyboard.press('Escape')
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })

  await studio.getByRole('tab', { name: 'Photos' }).click()
  const rowOf = (id) => studio.locator('.studio-photo-row', { has: page.locator(`img[src="/site-assets/${id}"]`) }).first()
  await expect(rowOf(first).getByTestId('photo-usage')).toHaveText('Used on: Home · Top of page')
  await expect(rowOf(first).getByRole('button', { name: /^Delete/ })).toHaveCount(0)
  await expect(rowOf(second).getByTestId('photo-usage')).toHaveText('Not used anywhere')

  // Replace the first photo everywhere in the draft with the second (asks first; undoable; draft only).
  await rowOf(first).getByRole('button', { name: /^Replace photo/ }).click()
  await rowOf(first).getByRole('button', { name: /^Use photo \d+ instead/ }).click()
  await expect(studio.locator('[data-confirm]')).toContainText(/live website changes only when you publish/)
  await studio.locator('[data-confirm]').getByRole('button', { name: 'Replace photo' }).click()
  await expect(frame.locator('.hero-media img')).toHaveAttribute('src', `/site-assets/${second}`)
  await expect(studio.getByText(/Replaced in your draft \(1 place\)/)).toBeVisible()
  await expect(studio.locator('[data-save="saved"]')).toBeVisible({ timeout: 15_000 })
  await expect(rowOf(second).getByTestId('photo-usage')).toHaveText('Used on: Home · Top of page')
  await expect(rowOf(first).getByTestId('photo-usage')).toHaveText('Not used anywhere')

  // Delete the now-unused one (asks first); its phone copy goes with it. Nothing went live.
  await rowOf(first).getByRole('button', { name: /^Delete photo/ }).click()
  await expect(studio.locator('[data-confirm]')).toContainText(/Delete this photo for good/)
  await studio.locator('[data-confirm]').getByRole('button', { name: 'Delete photo' }).click()
  await expect(rowOf(first)).toHaveCount(0)
  await expect(studio.getByText('Photo deleted.')).toBeVisible()
  expect((await page.request.get(`/p/${info.project.name === 'mobile' ? fixtures.E2E_STUDIO_H_M_CUSTOMER : fixtures.E2E_STUDIO_H_CUSTOMER}`)).status()).toBe(404)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

// UX audit screenshots (docs/STUDIO_UX_HARDENING.md): only when STUDIO_SHOTS names a folder, e.g.
//   STUDIO_SHOTS=test-results/studio-ux npx playwright test studio-hardening --project=desktop -g "audit"
test('audit screenshots at 1440 and 390 wide', async ({ browser }) => {
  test.skip(!process.env.STUDIO_SHOTS, 'screenshots only on request')
  for (const [name, viewport, isMobile] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile })
    await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort('blockedbyclient'))
    await useSession(context, fixtures.E2E_STUDIO_H_SESSION_TOKEN)
    const page = await context.newPage()
    const shot = (n, fullPage = false) => page.screenshot({ path: `${process.env.STUDIO_SHOTS}/${name}-${n}.png`, fullPage })
    await openWebsiteTab(page)
    const studio = studioOf(page)
    await shot('1-editor')
    await shot('1b-editor-full-page', true)
    await studio.getByRole('button', { name: 'Full screen' }).click()
    await shot('2-full-screen')
    await studio.getByRole('button', { name: 'Exit full screen' }).click()
    const pop = studio.getByRole('dialog', { name: 'Edit' })
    await expect(async () => {
      await frameOf(page).getByRole('link', { name: 'Book a visit' }).first().click()
      await expect(pop).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15_000 })
    await shot('3-button-panel')
    await page.keyboard.press('Escape')
    await studio.getByRole('tab', { name: 'Photos' }).click()
    await studio.getByRole('tab', { name: 'Photos' }).scrollIntoViewIfNeeded()
    await shot('4-photos')
    await studio.getByRole('tab', { name: 'Sections' }).click()
    await shot('5-sections')
    await context.close()
  }
})

// Product Excellence (WEB-09, WEB-11, WEB-13). Read-only: nothing is added, saved or published here.
test('editor layout and controls: in view after "Edit my website", page types where "Add a page" was chosen, no hover-only or undersized controls @mobile', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile'
  await useSession(context, tokenFor(info))
  if (!mobile) await page.setViewportSize({ width: 1440, height: 900 })
  await openWebsiteTab(page)
  const studio = studioOf(page)

  // WEB-09: the status bar is the only thing above the editor; "Edit my website" brings the whole editor into the
  // window: its bar, the preview and the edit panel, each scrolling inside itself.
  await page.getByRole('region', { name: 'Your website, step by step' }).getByRole('button', { name: 'Edit my website' }).click()
  if (!mobile) {
    await expect.poll(async () => { const y = Math.round((await studio.boundingBox()).y); return y >= 0 && y <= 100 }, { timeout: 10_000 }).toBe(true) // just below the dashboard's own header
    await page.waitForTimeout(600) // the smooth scroll has settled
    const vh = page.viewportSize().height
    const box = async (sel) => studio.locator(sel).first().boundingBox()
    const [bar, stage, panel] = [await box('.studio-bar'), await box('.studio-stage'), await box('.studio-panel')]
    expect(bar.y, 'the editor bar is on screen').toBeGreaterThanOrEqual(0)
    expect(stage.y + stage.height, 'the preview fits the window').toBeLessThanOrEqual(vh)
    expect(panel.y + panel.height, 'the edit panel fits the window').toBeLessThanOrEqual(vh)
    // Nothing in the panel is cut off: its last control can be scrolled into view inside the panel.
    await studio.getByRole('tab', { name: 'Sections' }).click()
    const last = studio.getByRole('button', { name: 'Add a page…' })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport({ ratio: 1 })
  }

  // WEB-11: "+ Add a page…" in the page menu shows the page types right under that menu (not at the end of a tab).
  const pageSelect = studio.getByRole('combobox').first()
  await pageSelect.scrollIntoViewIfNeeded()
  await pageSelect.selectOption('__add')
  const types = studio.getByRole('combobox', { name: 'Add a page', exact: true })
  await expect(types).toBeFocused()
  const [menu, form] = [await pageSelect.boundingBox(), await types.boundingBox()]
  expect(form.y - (menu.y + menu.height), 'directly below the page menu').toBeLessThan(mobile ? 320 : 120)
  await expect(studio.locator('.studio-addpage').getByRole('button', { name: 'Add page' })).toBeDisabled()
  await studio.locator('.studio-addpage').getByRole('button', { name: 'Cancel' }).click()
  await expect(types).toHaveCount(0)

  // WEB-13: section controls are visible without hovering…
  await studio.getByRole('tab', { name: 'Sections' }).click()
  const row = studio.locator('.studio-sections li').nth(1)
  await expect(row.locator('.studio-row-actions')).toHaveCSS('opacity', '1')
  await expect(row.getByRole('button', { name: /^More for / })).toBeVisible()
  // …and on a phone every control of the editor is at least 44 px tall (text links inside a sentence excepted).
  if (mobile) {
    for (const tab of ['Sections', 'Style', 'Photos', 'History']) {
      await studio.getByRole('tab', { name: tab }).click()
      const small = await studio.evaluate((root) => {
        const out = []
        for (const el of root.querySelectorAll('button, a.btn, a.link-btn, label.btn, select, summary, [role="tab"]')) {
          if (el.matches(':is(p, label) > .link-btn, :is(p, label) > a, p > span > .link-btn')) continue
          if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
          const r = el.getBoundingClientRect()
          if (r.width < 2 || r.height < 2) continue
          if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.height)}px`)
        }
        return [...new Set(out)]
      })
      expect(small, `${tab}: editor controls under 44 px on a phone`).toEqual([])
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
