// Follow-ups in the browser (real local server and routes; Twilio and the assistant are local stand-ins; production
// test mode: only the seeded lead's number is a test recipient). A signed inbound text gets an assistant answer with
// the booking link; the owner sees it, takes over, replies, hands back; STOP suppresses texting; preferences persist;
// another business's conversation is not reachable. Each browser project has its own business.
import { createHmac } from 'node:crypto'
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const mobile = (info) => info.project.name === 'mobile'
const biz = (info) => (mobile(info) ? { id: fixtures.E2E_TEXTS_M_CUSTOMER, token: fixtures.E2E_TEXTS_M_SESSION_TOKEN, sender: fixtures.E2E_TEXTS_M_SENDER, other: fixtures.E2E_TEXTS_CUSTOMER } : { id: fixtures.E2E_TEXTS_CUSTOMER, token: fixtures.E2E_TEXTS_SESSION_TOKEN, sender: fixtures.E2E_TEXTS_SENDER, other: fixtures.E2E_TEXTS_M_CUSTOMER })
const mock = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
const site = `http://127.0.0.1:${fixtures.E2E_PORT}`

// Sends a text "from" the lead to the business, signed the way Twilio signs webhooks.
async function textFromLead(request, b, body) {
  const url = `${site}/api/sms/twilio/inbound`
  const params = new URLSearchParams({ From: fixtures.E2E_TEXTS_LEAD_PHONE, To: b.sender, Body: body, MessageSid: `SMlead${Date.now()}${Math.random().toString(36).slice(2, 8)}` })
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join('')
  const sig = createHmac('sha1', fixtures.E2E_TWILIO_AUTH_TOKEN).update(data).digest('base64')
  return request.post(url, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, data: params.toString() })
}
const textsTo = async (request, b) => (await (await request.get(`${mock}/__events`)).json()).filter((e) => e.type === 'twilio.message' && e.from === b.sender)

test('owner follows a lead from first text to takeover: assistant answer with booking link, reply, hand back, STOP, preferences @mobile', async ({ page, context }, info) => {
  const b = biz(info)
  await useSession(context, b.token)
  await page.goto('/dashboard/followups')
  await expect(page.getByRole('heading', { name: 'Follow-ups', level: 1 })).toBeVisible()
  await expect(page.getByText('Automatic follow-ups on')).toBeVisible()
  await expect(page.getByText('Test mode: messages go only to GetShowUps test recipients')).toBeVisible()
  const texting = page.locator('section[aria-label="Texting setup"]')
  await expect(texting.getByText('Approved', { exact: true })).toBeVisible()
  await expect(texting).toContainText('Texts go only to test recipients')

  // A wrongly signed webhook is refused.
  expect((await page.request.post(`${site}/api/sms/twilio/inbound`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'forged' }, data: 'From=%2B1&To=%2B1&Body=x&MessageSid=SMx' })).status()).toBe(403)

  // The lead texts a question → the assistant answers (verified facts only) with the booking link.
  expect((await textFromLead(page.request, b, 'Do you clean green pools?')).status()).toBe(200)
  await expect.poll(async () => (await textsTo(page.request, b)).length).toBe(1)
  const [answer] = await textsTo(page.request, b)
  expect(answer.to).toBe(fixtures.E2E_TEXTS_LEAD_PHONE)
  expect(answer.body).toMatch(/^Yes, we can help with that in Charleston\. Pick a time: http:\/\/127\.0\.0\.1:\d+\/book\//)

  // The owner sees it in the inbox and opens the conversation.
  await page.reload()
  const list = page.locator('section[aria-label="Conversations"]')
  const row = list.getByRole('button', { name: /Morgan Lane/ })
  await expect(row).toContainText('Replied')
  await row.click()
  const convo = page.locator('section[aria-label="Conversation"]')
  await expect(convo.getByRole('heading', { name: 'Morgan Lane' })).toBeVisible()
  await expect(convo.getByText('Do you clean green pools?')).toBeVisible()
  await expect(convo.locator('.fu-msg--out', { hasText: 'Yes, we can help' })).toContainText('Assistant · Text')

  // Take over, reply personally (a text), hand back.
  await convo.getByRole('button', { name: 'Take over' }).click()
  await expect(convo.getByText('You’re handling this conversation')).toBeVisible()
  await convo.getByRole('textbox', { name: 'Your reply' }).fill('Hi Morgan, I can come by Thursday morning.')
  await convo.getByRole('button', { name: 'Send' }).click()
  await expect.poll(async () => (await textsTo(page.request, b)).map((t) => t.body)).toContain('Hi Morgan, I can come by Thursday morning.')
  await expect(convo.locator('.fu-msg--out', { hasText: 'Thursday morning' })).toContainText('You · Text')
  // While taken over, a new question gets no automatic answer.
  await textFromLead(page.request, b, 'Great, what time?')
  await page.waitForTimeout(800)
  expect((await textsTo(page.request, b)).length).toBe(2)
  await convo.getByRole('button', { name: 'Hand back to automatic replies' }).click()
  await expect(convo.getByRole('button', { name: 'Take over' })).toBeVisible()

  // STOP: suppressed at once; the owner sees it; nothing more is texted.
  await textFromLead(page.request, b, 'STOP')
  await page.reload()
  await page.locator('section[aria-label="Conversations"]').getByRole('button', { name: /Morgan Lane/ }).click()
  await expect(convo.getByText('Opted out of texts')).toBeVisible()
  await textFromLead(page.request, b, 'Hello?')
  await page.waitForTimeout(800)
  expect((await textsTo(page.request, b)).length).toBe(2)
  await expect(convo.getByText('Sends by email.')).toBeVisible()

  // Another business's conversation isn't reachable.
  expect((await page.request.get(`/api/dashboard/followups/thread?id=lead-${b.other}`)).status()).toBe(404)

  // Preferences persist.
  if (mobile(info)) await convo.getByRole('button', { name: '← All conversations' }).click()
  const prefs = page.locator('section[aria-label="Follow-up preferences"]')
  await prefs.getByText('Preferences').click()
  await prefs.getByLabel('Send a thank-you after a completed visit').check()
  await expect(prefs.getByText('Saved')).toBeVisible()
  await page.reload()
  await page.locator('section[aria-label="Follow-up preferences"]').getByText('Preferences').click()
  await expect(page.locator('section[aria-label="Follow-up preferences"]').getByLabel('Send a thank-you after a completed visit')).toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
