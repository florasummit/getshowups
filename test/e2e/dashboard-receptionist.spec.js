// Dashboard → Receptionist: every channel status comes from the server's capability facts and says why. Browser voice
// is 'Active' only for a business whose active provider really answers customers (here: on the Retell release list),
// 'Not turned on yet' with the reason otherwise; phone calls are 'Not available yet' (no line exists); team
// notifications say test mode and why. Owners never see a provider name or provider controls. Plus the layout
// regression: every dashboard tab reached by a click (no reload), both directions, direct links and a tablet width.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 90_000 })
const TABS = ['Appointments', 'Follow-ups', 'Receptionist', 'Website', 'Settings', 'Overview']

async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main.app-main')
    const widest = Math.max(0, ...Array.from(main?.children || [], (el) => el.getBoundingClientRect().width))
    return { main: main?.getBoundingClientRect().width || 0, content: widest, overflow: document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width) }
  })
}
async function expectFullWidth(page, label) {
  await expect(page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await measure(page)).content, { message: `${label}: content rendered` }).toBeGreaterThan(0)
  const m = await measure(page)
  expect(m.content, `${label}: content width ${m.content} of ${m.main}`).toBeGreaterThanOrEqual(m.main * 0.9)
  expect(m.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0)
}
const tile = (page, label) => page.getByRole('list', { name: 'Channels' }).locator(`[data-channel="${label}"]`)

test('owner (voice not released for this business): chat Active, browser voice "Not turned on yet" with the reason, phone "Not available yet", notifications in test mode with the reason; no provider name or control; every tab fills the content column by click, both ways, by direct link and at tablet width @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_VOICE_SESSION_TOKEN)
  await page.goto('/dashboard')
  await expectFullWidth(page, 'Overview')
  const nav = page.getByRole('navigation', { name: 'Dashboard' })
  await nav.getByRole('link', { name: 'Receptionist', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/receptionist$/)
  await expect(page.getByRole('heading', { name: 'AI receptionist', level: 1 })).toBeVisible()
  await expectFullWidth(page, 'Receptionist')
  // The on/off switch, greeting and notes come before the voice refinements.
  const settingsY = (await page.getByRole('heading', { name: 'Settings', exact: true }).boundingBox()).y
  const voiceY = (await page.getByRole('heading', { name: 'Receptionist voice' }).boundingBox()).y
  expect(settingsY).toBeLessThan(voiceY)
  // The statuses, traced to the API's capability facts.
  const me = await (await page.request.get('/api/dashboard/receptionist')).json()
  expect(me.capabilities).toMatchObject({ chat: true, voice: false, voiceStatus: 'testing', staffEmail: 'test_mode', phoneLine: false })
  expect(me.admin).toBeUndefined()
  await expect(page.locator('.ui-page-head')).toContainText('Answering on website chat')
  await expect(page.locator('.ui-page-head')).not.toContainText('Working')
  await expect(tile(page, 'Website chat')).toContainText('Active')
  await expect(tile(page, 'Website chat')).toContainText(`/chat/${fixtures.E2E_VOICE_CUSTOMER}`)
  await expect(tile(page, 'Browser voice')).toContainText('Not turned on yet')
  await expect(tile(page, 'Browser voice')).toContainText('business by business')
  // REC-03: the tile names the next step (no date promised), and the voice card says no customer hears the voice yet.
  await expect(tile(page, 'Browser voice')).toContainText('to ask for yours, email hello@getshowups.com')
  await expect(page.locator('#receptionist-voice [data-voice-unheard]')).toContainText('No customer hears this voice yet: browser voice isn’t on for your business')
  await expect(tile(page, 'Browser voice')).not.toContainText('In testing')
  await expect(tile(page, 'Browser voice')).not.toContainText('RECEPTIONIST_VOICE_BUSINESSES')
  await expect(tile(page, 'Phone calls')).toContainText('Not available yet')
  await expect(tile(page, 'Phone calls')).toContainText('No phone line can be connected yet')
  // REC-05: one plain sentence on whether the owner gets an email right now; no internal terms.
  await expect(tile(page, 'Team notifications')).toContainText('Email off')
  await expect(tile(page, 'Team notifications')).toContainText('You won’t get an email about a callback request or message right now')
  await expect(tile(page, 'Team notifications')).not.toContainText(/test recipients|messaging launch|Test mode/)
  // TEACH-04: each overlapping setting names its counterpart on the other page and how they combine.
  await expect(page.locator('[data-also="teach-excluded"]')).toContainText('Teach Your AI → Services you don’t offer')
  await expect(page.locator('[data-also="teach-handoffs"]')).toContainText('Teach Your AI → Hand-offs to your team')
  await expect(page.locator('[data-also="teach-tone"]')).toContainText('Teach Your AI → Tone')
  const text = await page.locator('main.app-main').innerText()
  expect(text).not.toMatch(/Retell|ElevenLabs|OpenAI/)
  await expect(page.locator('[data-provider-control]')).toHaveCount(0)
  // The customer page says the same thing in customer words.
  const info = await (await page.request.get(`/api/receptionist/${fixtures.E2E_VOICE_CUSTOMER}`)).json()
  expect([info.voice, info.voiceStatus]).toEqual([false, 'testing'])
  // Every tab by click, both directions, then direct links and a tablet width.
  for (const label of [...TABS, ...TABS.slice().reverse()]) {
    await nav.getByRole('link', { name: label, exact: true }).click()
    await expectFullWidth(page, label)
  }
  for (const [label, path] of [['Receptionist', '/dashboard/receptionist'], ['Website', '/dashboard/website'], ['Settings', '/dashboard/settings']]) {
    await page.goto(path)
    await expectFullWidth(page, label)
  }
  await page.goBack()
  await expectFullWidth(page, 'Website')
  await page.setViewportSize({ width: 834, height: 1112 })
  await page.goto('/dashboard')
  await nav.getByRole('link', { name: 'Receptionist', exact: true }).click()
  await expectFullWidth(page, 'Receptionist')
  await expect(tile(page, 'Browser voice')).toBeVisible()
})

test('owner (voice released for this business): browser voice is Active with what that means; the headline names both channels; the customer page offers voice', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_VOICE_M_SESSION_TOKEN)
  await page.goto('/dashboard/receptionist')
  const me = await (await page.request.get('/api/dashboard/receptionist')).json()
  expect(me.capabilities).toMatchObject({ chat: true, voice: true, voiceStatus: 'available' })
  await expect(page.locator('.ui-page-head')).toContainText('Answering on chat and browser voice')
  await expect(tile(page, 'Browser voice')).toContainText('Active')
  await expect(tile(page, 'Browser voice')).toContainText('by microphone')
  await expect(page.locator('#receptionist-voice')).toBeVisible()
  await expect(page.locator('[data-voice-unheard]')).toHaveCount(0) // customers can hear it: no "nobody hears this" note
  await expect(tile(page, 'Website chat')).toContainText('Active')
  const info = await (await page.request.get(`/api/receptionist/${fixtures.E2E_VOICE_M_CUSTOMER}`)).json()
  expect([info.voice, info.voiceStatus]).toEqual([true, 'available'])
  const text = await page.locator('main.app-main').innerText()
  expect(text).not.toMatch(/Retell|ElevenLabs|OpenAI/)
})

test('website chat panel: the owner turns it on; the published site opens the same chat in a panel (nothing loads before, no script, new-tab links); off again = the plain link @mobile', async ({ page, context, browser }, info) => {
  const mobile = info.project.name === 'mobile'
  const id = mobile ? fixtures.E2E_VOICE_M_CUSTOMER : fixtures.E2E_VOICE_CUSTOMER
  await useSession(context, mobile ? fixtures.E2E_VOICE_M_SESSION_TOKEN : fixtures.E2E_VOICE_SESSION_TOKEN)
  await page.goto('/dashboard/receptionist')
  const panel = page.getByRole('switch', { name: /Open the chat in a panel on my website/ })
  await expect(panel).not.toBeChecked()
  await expect(page.getByText('Off: your website shows a “Chat or talk with us” button')).toBeVisible()
  // Saved the moment it changes, with the shared confirmation beside it (the same as the on/off switch, REC-02).
  await panel.click()
  await expect(page.getByText('Saved. Your website now opens the chat in a panel.')).toBeVisible()
  await expect(panel).toBeChecked()
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).websitePanel).toEqual({ on: true })
  await expect(page.getByRole('list', { name: 'Channels' }).getByRole('listitem').filter({ hasText: 'Website chat' })).toContainText('in a panel on your website')

  // A visitor (no session, own address) on the published site.
  const visitor = await browser.newContext({ viewport: page.viewportSize(), extraHTTPHeaders: { 'CF-Connecting-IP': mobile ? '198.51.100.236' : '198.51.100.235' } })
  const site = await visitor.newPage()
  const chatRequests = []
  site.on('request', (r) => /\/chat\/|\/api\/receptionist\//.test(r.url()) && chatRequests.push(r.url()))
  const res = await site.goto(`/p/${id}`)
  expect(res.headers()['content-security-policy']).toMatch(/frame-src http:\/\/[^ ;]+$/)
  expect(await site.locator('script:not([type="application/ld+json"])').count()).toBe(0)
  const box = site.locator('details[data-gsu-chat-panel]')
  await expect(box.locator('summary')).toContainText('Chat or talk with us')
  expect(chatRequests).toEqual([]) // nothing of the chat loads until the visitor opens it
  await box.locator('summary').click()
  const frame = site.frameLocator('details[data-gsu-chat-panel] iframe')
  await expect(frame.getByText('Hi! Thanks for calling Voice Pools.')).toBeVisible()
  await expect(frame.getByLabel('Your message')).toBeVisible()
  await expect(frame.getByRole('link', { name: 'Book online' })).toHaveAttribute('target', '_blank')
  await expect(box.locator('summary')).toContainText('Close chat')
  expect(await site.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expect(site.getByRole('link', { name: 'Open the chat in a new tab' })).toHaveAttribute('href', new RegExp(`/chat/${id}$`))
  await box.locator('summary').click()
  await expect(box).not.toHaveAttribute('open', '')

  // Off again: the plain link, no panel, no frame permission.
  await panel.click()
  await expect(page.getByText('Saved. Your website shows the chat link.')).toBeVisible()
  await expect(panel).not.toBeChecked()
  // Sites are cached for a minute (the owner is told): a fresh address stands in for the minute passing.
  const off = await site.goto(`/p/${id}?fresh=1`)
  expect(off.headers()['content-security-policy']).not.toContain('frame-src')
  await expect(site.locator('a[data-gsu-chat]')).toContainText('Chat or talk with us')
  await expect(site.locator('details[data-gsu-chat-panel]')).toHaveCount(0)
  await visitor.close()
})
