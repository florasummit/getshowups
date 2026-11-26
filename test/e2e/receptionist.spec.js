// AI receptionist, in a real browser against the real Functions on local workerd (model + Google mocked at the
// network edge; the server-side tools, calendar code and storage are real). Desktop and phone.
// Journey: owner turns it on → customer chats, gets real open times, asks for a person → told honestly there is no
// transfer → leaves name + phone → callback request recorded (banner) → reload keeps it → ends the conversation →
// starts a clean new one. Owner: honest statuses (no phone line), Needs attention with the request, Mark done.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const mobile = (info) => info.project.name === 'mobile'
const biz = (info) => (mobile(info) ? { id: fixtures.E2E_TEXTS_M_CUSTOMER, token: fixtures.E2E_TEXTS_M_SESSION_TOKEN } : { id: fixtures.E2E_TEXTS_CUSTOMER, token: fixtures.E2E_TEXTS_SESSION_TOKEN })

test('receptionist journey: real times, honest hand-off to a recorded callback, end + new conversation; owner sees Needs attention @mobile', async ({ page, context, browser }, info) => {
  const b = biz(info)
  await page.goto(`/chat/${b.id}`)
  await expect(page.getByText('Chat isn’t available right now.')).toBeVisible()

  // Owner: turn it on. Phone routing is shown as not connected, its choices disabled.
  await useSession(context, b.token)
  await page.goto('/dashboard/receptionist')
  await expect(page.getByRole('heading', { name: 'AI receptionist', level: 1 })).toBeVisible()
  const channels = page.getByRole('list', { name: 'Channels' })
  await expect(channels.getByRole('listitem').filter({ hasText: 'Phone calls' })).toContainText('Not available yet')
  await expect(channels.getByRole('listitem').filter({ hasText: 'Website chat' })).toContainText('Off')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled() // nothing changed yet
  // REC-01: while it is off, "Try it as a customer" is not a link to a closed page: the reason and a one-tap "Turn on"
  // (in the header and in the empty Conversations card).
  const head = page.locator('.ui-page-head')
  const power = page.getByRole('switch', { name: /Answer customers with the AI receptionist/ })
  await expect(page.getByRole('link', { name: 'Try it as a customer' })).toHaveCount(0)
  await expect(page.locator('[data-try-closed="off"]')).toHaveCount(2)
  await expect(head.locator('[data-try-closed="off"]')).toContainText('the chat page is closed while the receptionist is off')
  await expect(page.getByText('Try it yourself first.')).toHaveCount(0)
  await head.getByRole('button', { name: 'Turn on' }).click()
  await expect(head.getByRole('status')).toContainText('Saved. The receptionist is on.')
  await expect(head).toContainText('Answering on website chat')
  await expect(power).toBeChecked()
  await expect(page.getByRole('link', { name: 'Try it as a customer' })).toHaveCount(2)
  await expect(head.getByRole('link', { name: 'Try it as a customer' })).toHaveAttribute('href', `/chat/${b.id}`)
  await expect(page.getByText('Try it yourself first.')).toBeVisible()
  // REC-02: the on/off switch saves the moment it changes (like the website-panel switch), with its confirmation
  // beside it, and the header follows at once. The Save button is only for the greeting, notes and phone choices.
  await power.uncheck()
  await expect(page.getByText('Saved. The receptionist is off: customers can’t chat with it.')).toBeVisible()
  await expect(head).toContainText('Off')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).settings.enabled).toBe(false)
  await power.check()
  await expect(page.getByText('Saved. The receptionist is on.')).toBeVisible()
  await expect(head).toContainText('Answering on website chat')
  expect((await (await page.request.get('/api/dashboard/receptionist')).json()).settings.enabled).toBe(true)
  await page.getByLabel('Greeting').fill('Hi! Ask me about pool care or I can find you a time.')
  await page.getByLabel('Notes for the receptionist').fill('We do not service hot tubs.')
  await page.getByText('Phone calls (not available yet)').click()
  await expect(page.getByRole('radio', { name: 'AI answers' })).toBeDisabled()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Saved\.$/ })).toBeVisible()
  await expect(power).toBeChecked() // saving the greeting keeps the switch as it was saved
  await expect(channels.getByRole('listitem').filter({ hasText: 'Website chat' })).toContainText('Active')
  await expect(page.locator('section[aria-label="Needs attention"]').getByText('All caught up')).toBeVisible()

  // Customer: a separate browser session, no sign-in.
  const customerCtx = await browser.newContext(info.project.use)
  const c = await customerCtx.newPage()
  await c.goto(`/chat/${b.id}`)
  await expect(c.getByText('Hi! Ask me about pool care or I can find you a time.')).toBeVisible()
  await c.getByLabel('Your message').fill('What times do you have this week?')
  await c.getByRole('button', { name: 'Send' }).click()
  await expect(c.getByText('What times do you have this week?')).toBeVisible()
  await expect(c.getByText(/^I can do \w+day, \w+ \d+/)).toBeVisible()
  // Asking for a person: no transfer is claimed; a callback needs a name and number.
  await c.getByRole('button', { name: 'Ask for a person' }).click()
  await expect(c.getByText(/I can’t transfer you, but I can take a callback request/)).toBeVisible()
  await c.getByLabel('Your message').fill('Jamie Rivera, 843-555-0142')
  await c.getByLabel('Your message').press('Enter')
  await expect(c.getByText('I’ve recorded your callback request for the team with your number.')).toBeVisible()
  await expect(c.getByRole('status').filter({ hasText: 'Your callback request is recorded for the team.' })).toBeVisible()
  // Reload keeps the conversation and its outcome.
  await c.reload()
  await expect(c.getByText('What times do you have this week?')).toBeVisible()
  await expect(c.getByText('Your callback request is recorded for the team.')).toBeVisible()
  // End (with a confirmation step), then a clean new conversation.
  await c.getByRole('button', { name: 'End conversation' }).click()
  await c.getByRole('button', { name: 'End conversation' }).click()
  await expect(c.getByText('This conversation has ended.')).toBeVisible()
  await expect(c.getByLabel('Your message')).toHaveCount(0)
  await c.getByRole('button', { name: 'Start a new conversation' }).click()
  await expect(c.getByText('What times do you have this week?')).toHaveCount(0)
  await expect(c.getByLabel('Your message')).toBeFocused()
  await c.reload()
  await expect(c.getByText('What times do you have this week?')).toHaveCount(0)
  await customerCtx.close()

  // Owner: the request is in Needs attention (with how the team was or wasn't told) and the conversation is listed.
  await page.getByRole('button', { name: 'Refresh' }).click()
  const attn = page.locator('section[aria-label="Needs attention"]')
  await expect(attn.getByText(/Call back Jamie Rivera/)).toBeVisible()
  await expect(attn.locator('.ui-pill', { hasText: /^(Recorded|Not emailed)$/ })).toBeVisible()
  // REC-05: the card says in one plain sentence whether the owner was emailed (here: not, emails aren't switched on).
  await expect(attn.locator('[data-notify]')).toContainText(/You (haven’t been|weren’t) emailed about this\. Emails to your team aren’t switched on yet/)
  await expect(channels.getByRole('listitem').filter({ hasText: 'Team notifications' })).toContainText('You won’t get an email about a callback request or message right now')
  expect(await page.locator('main.app-main').innerText()).not.toMatch(/test recipients|messaging launch|test mode|Checking within 5 minutes/i)
  await expect(attn.getByRole('link', { name: '(843) 555-0142' })).toHaveAttribute('href', 'tel:+18435550142')
  // "View conversation" opens it: outcome, collected details, transcript, plain-language activity.
  await attn.getByRole('button', { name: 'View conversation' }).click()
  const d = page.locator('[aria-label="Conversation detail"]')
  await expect(d.getByText('Callback requested')).toBeVisible()
  await expect(d.getByText('What times do you have this week?')).toBeVisible()
  await d.getByText('What the receptionist did').click()
  await expect(d.getByText(/Looked up open times/)).toBeVisible()
  await expect(d.getByText(/^Recorded a callback request/)).toBeVisible()
  await expect(d.getByText(/Callback request not recorded yet \(needed their name first\)/)).toBeVisible()
  // The list filters by outcome.
  const list = page.locator('section[aria-label="Receptionist conversations"]')
  await list.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).toHaveCount(1)
  await list.getByRole('button', { name: /^Booked/ }).click()
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).toHaveCount(0)
  await expect(list.getByRole('button', { name: /^Needs attention/ })).toContainText('1')
  await attn.getByRole('button', { name: 'Mark done' }).click()
  await expect(attn.getByText('All caught up')).toBeVisible()
  await expect(attn.getByText(/Done \(1\)/)).toBeVisible()
  // REC-04: marked done = the conversation no longer needs attention either (count and pill), also after a reload;
  // a done request can be reopened.
  await expect(list.getByRole('button', { name: /^Needs attention/ })).toContainText('0')
  await list.getByRole('button', { name: /^All/ }).click()
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).toContainText('Completed')
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).not.toContainText('Needs attention')
  await page.reload()
  await expect(list.getByRole('button', { name: /^Needs attention/ })).toContainText('0')
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).toContainText('Completed')
  await attn.getByText(/Done \(1\)/).click()
  await attn.getByRole('button', { name: /^Reopen the callback request from Jamie Rivera/ }).click()
  await expect(attn.getByText(/Call back Jamie Rivera/)).toBeVisible()
  await expect(list.getByRole('button', { name: /^Needs attention/ })).toContainText('1')
  await expect(list.getByRole('button', { name: /Jamie Rivera/ })).toContainText('Needs attention')
  await attn.getByRole('button', { name: 'Mark done' }).click()
  await expect(attn.getByText('All caught up')).toBeVisible()
  // Another business's conversation is not reachable.
  expect((await page.request.get('/api/dashboard/receptionist?id=notmine1234')).status()).toBe(404)
})
