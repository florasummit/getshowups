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
  await expect(tile(page, 'Browser voice')).not.toContainText('In testing')
  await expect(tile(page, 'Browser voice')).not.toContainText('RECEPTIONIST_VOICE_BUSINESSES')
  await expect(tile(page, 'Phone calls')).toContainText('Not available yet')
  await expect(tile(page, 'Phone calls')).toContainText('No phone line can be connected yet')
  await expect(tile(page, 'Team notifications')).toContainText('Test mode')
  await expect(tile(page, 'Team notifications')).toContainText('test recipients')
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
  await expect(tile(page, 'Website chat')).toContainText('Active')
  const info = await (await page.request.get(`/api/receptionist/${fixtures.E2E_VOICE_M_CUSTOMER}`)).json()
  expect([info.voice, info.voiceStatus]).toEqual([true, 'available'])
  const text = await page.locator('main.app-main').innerText()
  expect(text).not.toMatch(/Retell|ElevenLabs|OpenAI/)
})

test('owner chooses how the chat opens on the website: the panel switch saves on its own, says what it does, and turns back off', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_VOICE_M_SESSION_TOKEN)
  await page.goto('/dashboard/receptionist')
  const panel = page.getByRole('switch', { name: /Open the chat in a panel on my website/ })
  await expect(panel).not.toBeChecked()
  await expect(page.getByText('Off: your website shows a “Chat or talk with us” button')).toBeVisible()
  await panel.check()
  await expect(page.getByText('Saved. Your website now opens the chat in a panel.')).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).websitePanel).toEqual({ on: true })
  await page.reload()
  await expect(panel).toBeChecked()
  await panel.uncheck()
  await expect(page.getByText('Saved. Your website shows the chat link.')).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).websitePanel).toEqual({ on: false })
})
