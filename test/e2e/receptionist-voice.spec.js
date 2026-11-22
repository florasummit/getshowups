// Receptionist voice (Dashboard → Receptionist → "Receptionist voice") in a real browser against the real Functions on
// local workerd, Retell faked at the network edge (catalog + previews + web calls). Owner: current voice, the catalog
// with filters and search, one-at-a-time previews (clearly labelled samples), personality and pace, Save/Cancel,
// persistence across a reload, a stale save is reported. Admin (a platform admin who is a member): the provider
// control with honest statuses, a test-only provider blocked from activation. Owners never see the control nor a
// provider name. Desktop and phone for the owner (own business per project, no cross-project writes); admin on desktop.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const mobile = (info) => info.project.name === 'mobile'
const biz = (info) => (mobile(info) ? { id: fixtures.E2E_VOICE_M_CUSTOMER, token: fixtures.E2E_VOICE_M_SESSION_TOKEN } : { id: fixtures.E2E_VOICE_CUSTOMER, token: fixtures.E2E_VOICE_SESSION_TOKEN })
const noSideScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width))).toBeLessThanOrEqual(0)

test('owner: browses, previews (one at a time), picks a voice, personality and pace, saves; the choice persists; a stale save is reported; no provider name, no admin control @mobile', async ({ page, context }, info) => {
  const b = biz(info)
  await useSession(context, b.token)
  await page.goto('/dashboard/receptionist')
  const section = page.locator('#receptionist-voice')
  await expect(section.getByRole('heading', { name: 'Receptionist voice' })).toBeVisible()
  await expect(section.locator('[data-current-voice]')).toContainText('Standard voice')
  await expect(page.locator('[data-provider-control]')).toHaveCount(0, 'owners never see the provider control')
  const html = await section.innerHTML()
  expect(html).not.toMatch(/Retell|OpenAI|ElevenLabs/)
  // The catalog (from the faked provider, through our server; the API never names the provider to an owner).
  const cat = await (await page.request.get('/api/dashboard/receptionist/voices?provider=elevenlabs')).json()
  expect(cat.provider).toBeUndefined()
  expect(cat.voices.map((v) => v.name)).toEqual(['Cimo', 'Adrian', 'Myra', 'Cleo'])
  expect(cat.voices.every((v) => v.preview && v.preview.includes('/retell-preview/'))).toBe(true)
  await section.getByRole('button', { name: 'Change voice' }).click()
  const list = section.getByRole('group', { name: 'Available voices' })
  await expect(list.getByRole('radio')).toHaveCount(5) // standard + 4
  await expect(list).toContainText('Previews are samples from the voice library, not your receptionist.')
  // Filters only where the provider states the trait; search by name.
  await list.getByRole('button', { name: 'Feminine' }).click()
  await expect(list.getByRole('radio')).toHaveCount(3)
  await list.getByRole('button', { name: 'Any' }).click()
  await list.getByRole('searchbox', { name: 'Search voices by name' }).fill('adr')
  await expect(list.getByRole('radio')).toHaveCount(2)
  await list.getByRole('searchbox', { name: 'Search voices by name' }).fill('')
  // Previews: one plays at a time; the second press stops the first.
  const adrian = list.getByRole('button', { name: 'Preview Adrian' })
  await adrian.click()
  await expect(list.getByRole('button', { name: 'Stop Adrian' })).toHaveAttribute('aria-pressed', 'true')
  await list.getByRole('button', { name: 'Preview Myra' }).click()
  await expect(list.getByRole('button', { name: 'Stop Myra' })).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByRole('button', { name: 'Preview Adrian' })).toHaveAttribute('aria-pressed', 'false')
  await list.getByRole('button', { name: 'Stop Myra' }).click()
  await expect(list.getByRole('button', { name: 'Preview Myra' })).toHaveAttribute('aria-pressed', 'false')
  // Choose Adrian, a personality and a pace; Cancel reverts; Save persists.
  await list.getByRole('radio', { name: /Adrian/ }).check()
  await section.getByRole('radio', { name: /Calm & Reassuring/ }).check()
  await section.getByRole('radio', { name: 'A little slower' }).click()
  await expect(section.getByRole('status')).toContainText('Unsaved changes')
  await section.getByRole('button', { name: 'Cancel' }).click()
  await expect(section.locator('[data-current-voice]')).toContainText('Standard voice')
  await section.getByRole('button', { name: 'Change voice' }).click()
  await section.getByRole('group', { name: 'Available voices' }).getByRole('radio', { name: /Adrian/ }).check()
  await section.getByRole('radio', { name: /Calm & Reassuring/ }).check()
  await section.getByRole('radio', { name: 'A little slower' }).click()
  await section.getByRole('button', { name: 'Save voice' }).click()
  await expect(section.getByRole('status')).toContainText('Saved.')
  await expect(section.locator('[data-current-voice]')).toContainText('Adrian')
  await expect(section.locator('[data-current-voice]')).toContainText('Masculine · American · Young')
  await noSideScroll(page)
  await page.reload()
  const after = page.locator('#receptionist-voice')
  await expect(after.locator('[data-current-voice]')).toContainText('Adrian')
  await expect(after.getByRole('radio', { name: /Calm & Reassuring/ })).toBeChecked()
  await expect(after.getByRole('radio', { name: 'A little slower' })).toHaveAttribute('aria-checked', 'true')
  // Stored server-side with the version; a save carrying an old version is refused (409), nothing overwritten.
  const me = await (await page.request.get('/api/dashboard/receptionist')).json()
  expect([me.voice.voiceId, me.voice.voiceName, me.voice.personality, me.voice.pace, me.voice.version]).toEqual(['11labs-Adrian', 'Adrian', 'calm', 'slower', 2]) // the seed's rollout pin is version 1
  const origin = new URL(page.url()).origin
  const stale = await page.request.post('/api/dashboard/receptionist', { data: { action: 'voice', personality: 'upbeat', version: 0 }, headers: { Origin: origin } })
  expect(stale.status()).toBe(409)
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).voice.personality).toBe('calm')
  // A voice that is not in the catalog, or another provider's, is refused by the server.
  const bad = await page.request.post('/api/dashboard/receptionist', { data: { action: 'voice', voiceId: 'cjVigY5qzO86Huf0OWal', version: me.voice.version }, headers: { Origin: origin } })
  expect([bad.status(), (await bad.json()).error]).toEqual([400, 'voice_unknown'])
  // Provider actions are refused for owners, server-side.
  const sw = await page.request.post('/api/dashboard/receptionist', { data: { action: 'provider_switch', provider: 'elevenlabs', confirm: true, version: 1 }, headers: { Origin: origin } })
  expect(sw.status()).toBe(403)
})

test('admin member: the provider control shows truthful states (Retell active; OpenAI and ElevenLabs not configured here); an unverified switch is blocked by the checklist; nothing changes for the owner', async ({ page, context }) => {
  // The voice admin is a member of the desktop voice business (one business per member email); desktop only.
  await useSession(context, fixtures.E2E_VOICE_ADMIN_SESSION_TOKEN)
  await page.goto('/dashboard/receptionist')
  const control = page.locator('[data-provider-control]')
  const me = await (await page.request.get('/api/dashboard/receptionist')).json()
  expect(me.admin).toBe(true)
  expect(me.providers.current).toBe('retell')
  expect(me.providers.providers.map((p) => [p.id, p.state, p.configured, p.customerPath, p.phone])).toEqual([
    ['retell', 'active', true, true, false],
    ['openai', 'not_configured', false, true, false],
    ['elevenlabs', 'not_configured', false, true, false],
  ])
  await expect(control).toHaveCount(1)
  await control.locator('summary').click()
  await expect(control).toContainText('Retell')
  await expect(control.getByRole('row', { name: /Retell/ })).toContainText('Active for customers')
  await expect(control.getByRole('row', { name: /ElevenLabs/ })).toContainText('Not configured')
  await expect(control.getByRole('row', { name: /OpenAI/ })).toContainText('Not supported')
  await control.getByRole('combobox', { name: 'Provider to switch to' }).selectOption('elevenlabs')
  await control.getByRole('checkbox').check()
  await expect(control.locator('[data-test-now]')).toHaveCount(0, 'not a test business: no Test now link')
  await control.getByRole('button', { name: 'Review checklist' }).click()
  const check = control.getByLabel('Switching checklist')
  await expect(check).toContainText('Blocked')
  await expect(check).toContainText('is not configured')
  await expect(check).toContainText('Not verified for this business yet')
  await expect(check).toContainText('No phone line is connected')
  await expect(control.getByRole('button', { name: 'Activate…' })).toBeDisabled()
  await noSideScroll(page)
  // Server-side the switch is refused as blocked and audited; the business stays on Retell.
  const origin = new URL(page.url()).origin
  const sw = await page.request.post('/api/dashboard/receptionist', { data: { action: 'provider_switch', provider: 'elevenlabs', useDefaultVoice: true, confirm: true, version: me.providers.version }, headers: { Origin: origin } })
  expect([sw.status(), (await sw.json()).error]).toEqual([409, 'blocked'])
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).providers.current).toBe('retell')
})
