// AI receptionist, in a real browser against the real Functions on local workerd (model + Google mocked at the
// network edge; the server-side tools, calendar code and storage are real). Desktop and phone.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const mobile = (info) => info.project.name === 'mobile'
const biz = (info) => (mobile(info) ? { id: fixtures.E2E_TEXTS_M_CUSTOMER, token: fixtures.E2E_TEXTS_M_SESSION_TOKEN } : { id: fixtures.E2E_TEXTS_CUSTOMER, token: fixtures.E2E_TEXTS_SESSION_TOKEN })

test('owner turns the receptionist on; a customer chats, gets real open times and asks for a person; the owner sees the outcome @mobile', async ({ page, context, browser }, info) => {
  const b = biz(info)
  // Off by default: the public page says so.
  await page.goto(`/chat/${b.id}`)
  await expect(page.getByText('Chat isn’t available right now.')).toBeVisible()

  // Owner: turn it on without technical settings.
  await useSession(context, b.token)
  await page.goto('/dashboard/receptionist')
  await expect(page.getByRole('heading', { name: 'AI receptionist', level: 1 })).toBeVisible()
  await page.getByRole('checkbox', { name: /Answer customers with the AI receptionist/ }).check()
  await page.getByLabel('Greeting').fill('Hi! Ask me about pool care or I can find you a time.')
  await page.getByLabel(/What the receptionist should know/).fill('We do not service hot tubs.')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toHaveText('Saved.')

  // Customer: a separate browser session, no sign-in.
  const customerCtx = await browser.newContext(info.project.use)
  const c = await customerCtx.newPage()
  await c.goto(`/chat/${b.id}`)
  await expect(c.getByText('Hi! Ask me about pool care or I can find you a time.')).toBeVisible()
  await expect(c.getByRole('link', { name: 'Book online' })).toBeVisible()
  await c.getByLabel('Your message').fill('What times do you have this week?')
  await c.getByRole('button', { name: 'Send' }).click()
  await expect(c.getByText('What times do you have this week?')).toBeVisible()
  await expect(c.getByText(/^I can do \w+day, \w+ \d+/)).toBeVisible()
  // Human hand-off is always one click away.
  await c.getByRole('button', { name: 'Talk to a person' }).click()
  await expect(c.getByText('I have let the team know. Someone will follow up shortly.')).toBeVisible()
  // Reload keeps the conversation (this tab).
  await c.reload()
  await expect(c.getByText('What times do you have this week?')).toBeVisible()
  await customerCtx.close()

  // Owner sees the conversation, what it did, and the outcome.
  await page.reload()
  const list = page.locator('section[aria-label="Receptionist conversations"]')
  await expect(list.getByText(/Chat · Needs you/).first()).toBeVisible()
  await list.getByRole('button', { name: /Chat · Needs you/ }).first().click()
  const d = page.locator('[aria-label="Conversation detail"]')
  await expect(d.getByText('What times do you have this week?')).toBeVisible()
  await expect(d.getByText(/Looked up open times/)).toBeVisible()
  await expect(d.getByText(/Handed off to you/)).toBeVisible()
  // Another business's conversation is not reachable.
  expect((await page.request.get('/api/dashboard/receptionist?id=notmine1234')).status()).toBe(404)
})
