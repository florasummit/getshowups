// Website tab: an existing business edits its generated website (autosaved), previews it privately,
// publishes with explicit consent, and visitors book through it with ad parameters kept. Earlier
// versions can be restored. Runs on desktop and phone (phone uses the Edit / Preview switch).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'
import { deflateSync } from 'node:zlib'

// A real 64×48 PNG (solid teal), built here so no binary fixture is committed.
function png(w = 64, h = 48) {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([15, 118, 110]))])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test('owner edits, previews and publishes the website; visitors book through it @mobile', async ({ page, context }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  // Its own visitor address: the public-page allowance is per address, and every spec otherwise shares 127.0.0.1.
  await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': mobile ? '198.51.100.234' : '198.51.100.233' })
  const id = mobile ? fixtures.E2E_HOME_CUSTOMER : fixtures.E2E_CUSTOMER
  await useSession(context, mobile ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

  // Not public before publishing.
  await page.goto(`/p/${id}`)
  await expect(page.getByRole('heading', { name: 'This website isn’t available' })).toBeVisible()

  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Finish my website' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible()
  await expect(page.getByText('Not published yet')).toBeVisible()
  await page.getByRole('button', { name: 'Create my website' }).click()
  await expect(page.locator('.design-card')).toHaveCount(3)
  await page.getByRole('button', { name: 'Use this design' }).first().click()
  await expect(page.getByRole('heading', { name: 'Edit text and photos' })).toBeVisible()
  // Natural-language revision: shown first, applied only when kept.
  await page.getByRole('button', { name: 'Make it more modern' }).click()
  await expect(page.getByText('Here’s the new version. Keep it?')).toBeVisible()
  await expect(page.frameLocator('iframe[title="Website preview"]').getByRole('heading', { level: 1 })).toHaveText(/^Modern /)
  await page.getByRole('button', { name: 'Keep this' }).click()
  await expect(page.getByLabel('Describe a change')).toBeVisible()
  // Regression: an unkept revision is labelled as unsaved, blocks publishing, and never stays in the preview after
  // "Start over" — the preview then shows the design that was applied (the saved draft).
  const caption = page.locator('.site-preview figcaption')
  const previewH1 = page.frameLocator('iframe[title="Website preview"]').getByRole('heading', { level: 1 })
  // Today's AI allowance is shown and counts down; revisions have their own allowance.
  await expect(page.locator('[data-allowance="revision"]')).toHaveText(/^\d+ of \d+ AI changes left today · resets at /)
  // …and it says whose limit it is: no own key here, so it's the included writer's daily limit, not a provider credit.
  await expect(page.locator('[data-allowance-note="revision"]')).toHaveText(/daily limit of the AI writer included with GetShowUps \(no API key needed\)\. Editing by hand is never limited\./)
  await page.getByRole('button', { name: 'Make it more modern' }).click()
  await expect(caption).toHaveText('New version · not saved yet')
  await expect(page.getByRole('button', { name: /^Publish/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start over with three new designs' }).click()
  const allowance = page.locator('[data-allowance="generation"]')
  await expect(allowance).toHaveText(/^\d+ of \d+ new designs left today · resets at /)
  const left = Number((await allowance.textContent()).split(' ')[0])
  await page.getByRole('button', { name: 'Design it again' }).click()
  await expect(page.locator('.design-card')).toHaveCount(3)
  const chosen = await page.locator('.design-card strong').first().textContent()
  await page.getByRole('button', { name: 'Use this design' }).first().click()
  // Wait until the chosen design is saved (the design cards close), not just for the caption.
  await expect(page.locator('.design-card')).toHaveCount(0)
  await expect(caption).toHaveText('Draft preview · only you can see this')
  const site = async () => (await page.request.get('/api/dashboard/website')).json()
  await expect.poll(async () => (await site()).website.draft.design.name).toBe(chosen)
  const draft = await site()
  expect(draft.aiUsage.generation.remaining).toBe(left - 1)
  await expect(previewH1).toHaveText(draft.website.draft.headline)
  await expect(page.frameLocator('iframe[title="Website preview"]').locator('meta[name="theme-color"]')).toHaveAttribute('content', /^#/)
  await page.getByLabel('Headline').fill('Pool care in Charleston')
  await page.getByRole('radio', { name: 'Sand' }).click()
  await expect(page.getByText('All changes saved')).toBeVisible()
  // Upload a main photo (resized in the browser, stored by the server, private until published).
  await page.getByText('Logo and photos').click()
  await page.locator('.image-pick', { hasText: 'Main photo' }).locator('input[type=file]').setInputFiles({ name: 'pool.png', mimeType: 'image/png', buffer: png() })
  const thumb = page.locator('.image-pick', { hasText: 'Main photo' }).locator('img')
  await expect(thumb).toBeVisible()
  const photo = await thumb.getAttribute('src')
  await expect.poll(() => thumb.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByText('All changes saved')).toBeVisible()
  expect((await page.context().request.get(photo, { headers: { Cookie: '' } })).status(), 'private before publishing').toBe(404)
  const frame = page.frameLocator('iframe[title="Website preview"]')
  await expect(frame.getByRole('heading', { level: 1, name: 'Pool care in Charleston' })).toBeVisible()
  await noOverflow()

  // Publish requires the consent checkbox.
  await page.getByRole('button', { name: 'Publish website' }).first().click()
  const publish = page.getByRole('button', { name: 'Publish website' }).last()
  await expect(publish).toBeDisabled()
  await page.getByRole('checkbox', { name: /details are accurate/ }).check()
  await publish.click()
  await expect(page.locator('.site-status').getByText('Live', { exact: true })).toBeVisible()

  // Visitors: server-rendered site, ad parameters carried to booking.
  await page.goto(`/p/${id}?utm_source=google&utm_campaign=camp12345678`)
  await expect(page.getByRole('heading', { name: 'Pool care in Charleston', level: 1 })).toBeVisible()
  // The owner's uploaded main photo is used (not a stock photo), and it loads publicly once published.
  const hero = page.locator(`.hero img[src="${photo}"], .ab-split img[src="${photo}"]`).first()
  await expect.poll(() => hero.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { level: 2, name: mobile ? 'Ready when you are.' : 'Book your time today.' })).toBeVisible()
  await noOverflow()
  await page.getByRole('link', { name: mobile ? 'Book a visit' : 'Book a time' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/book/${id}\\?utm_source=google&utm_campaign=camp12345678$`))
  // The booking page opens on the business's own services (its list has one).
  await expect(page.getByRole('heading', { level: 1, name: /^(What can we help with\?|Weekly pool care|Pick a time|Pick a visit time)$/ })).toBeVisible()
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

  await page.getByText('Earlier versions and more').click()
  page.once('dialog', (d) => d.accept()) // restoring replaces the live site: the owner confirms
  await page.getByRole('button', { name: 'Restore' }).first().click()
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
