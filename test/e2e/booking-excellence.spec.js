// Customer booking and chat on a phone (docs/quality/USABILITY_FINDINGS.md BOOK-01 … BOOK-10, CHAT-01 … CHAT-04).
// What a business's own customer sees, at 390 px. Most checks run the real page against a stand-in booking API
// (page.route: a fictional business with exactly the settings the check needs, so no seeded business is changed and no
// shared calendar is booked); BOOK-01 and the page metadata run against the real Functions on local workerd.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'

test.describe.configure({ timeout: 60_000 })
test.use({ viewport: { width: 390, height: 844 } })

const ID = 'e2e-standin'
const HOUR = 3600_000
// Open times on the next three days at 9:00, 13:00 and 15:00 Eastern (as ISO), never today.
function slots() {
  const out = []
  const day0 = Math.floor(Date.now() / (24 * HOUR)) + 1
  for (let d = 0; d < 3; d++) for (const h of [14, 18, 20]) out.push(new Date((day0 + d) * 24 * HOUR + h * HOUR).toISOString())
  return out
}
const SERVICES = [
  { id: 'sv_weekly01', name: 'Weekly pool care', price: '$280/month', description: '', minutes: 60, flow: 'book', question: null },
  { id: 'sv_filter01', name: 'Filter cleaning', price: '$95', description: '', minutes: 60, flow: 'book', question: null },
  { id: 'sv_green001', name: 'Green pool cleanup', price: '', description: '', minutes: 120, flow: 'book', question: null },
]
const BUSINESS = {
  name: 'Standin Pools',
  timezone: 'America/New_York',
  phone: '+18435550100',
  slotMinutes: 60,
  appointmentMode: 'at_business',
  askZip: false,
  areaCheck: false,
  services: SERVICES,
  allowOther: false,
  brand: { product: false, logo: null, accent: null },
  minutes: 60,
  offerSms: false,
  policies: { beforeVisit: 'Please unlock the side gate.', cancellation: 'Please cancel at least 24 hours ahead.' },
  status: 'ok',
}
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })

// The stand-in booking API. Returns what the page sent: { leads: [...bodies], appointments: [...bodies] }.
async function standIn(page, { business = {}, area = () => 'in', lead = () => [201, { leadId: 'lead1', leadToken: 'tok', qualified: true, coverage: null, flow: 'book' }], appointment } = {}) {
  const offered = slots()
  const sent = { leads: [], appointments: [], areas: [] }
  await page.route(`**/api/book/${ID}**`, (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(`/api/book/${ID}`, '')
    if (path === '/event') return route.fulfill({ status: 204 })
    if (path === '/area') {
      sent.areas.push(url.searchParams.get('zip'))
      return json(route, 200, { area: area(url.searchParams.get('zip')) })
    }
    if (path === '/lead') {
      sent.leads.push(route.request().postDataJSON())
      const [status, body, headers] = lead(route.request().postDataJSON())
      return json(route, status, body, headers)
    }
    if (path === '/appointment') {
      const body = route.request().postDataJSON()
      sent.appointments.push(body)
      if (appointment) return json(route, ...appointment(body))
      return json(route, 201, { start: body.start, end: new Date(Date.parse(body.start) + HOUR).toISOString(), timezone: 'America/New_York', name: 'Standin Pools', invited: true })
    }
    const svc = SERVICES.find((s) => s.id === url.searchParams.get('service'))
    return json(route, 200, { ...BUSINESS, ...business, minutes: svc ? svc.minutes : 60, slots: svc && svc.minutes !== 60 ? offered.slice(0, 4) : offered })
  })
  return { sent, offered }
}
const pressed = (page, sel) => page.locator(`${sel}[aria-pressed="true"]`)
const alerts = (page) => page.getByRole('alert').allTextContents()

// Controls a thumb has to hit: at least 44 px tall. Left out on purpose: the consent checkbox (its whole label is the
// target), links inside a sentence (WCAG 2.5.8 inline exception) and fields nobody can see (the spam trap).
async function smallControls(page) {
  return page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.pub :is(button, a, input, textarea, select, [role="radio"])')) {
      if (el.matches('input[type="checkbox"], .bk-hp, .pub-check a, .chat-legal:not(.chat-legal--foot) a')) continue
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      const box = el.getBoundingClientRect()
      if (box.width < 2 || box.height < 2) continue
      if (box.height < 43.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(box.height)}px`)
    }
    return [...new Set(out)]
  })
}

test('BOOK-02 + BOOK-09: a step never passes what a later step refuses; one submit marks every field, each by its field; a short US phone is refused @mobile', async ({ page }) => {
  const { sent } = await standIn(page, { business: { services: [], allowOther: true, appointmentMode: 'at_customer', areaCheck: true } })
  await page.goto(`/book/${ID}`)
  // Step 1, empty: both of ITS fields are marked, nothing moves on.
  await page.getByRole('button', { name: 'See open times' }).click()
  expect(await alerts(page)).toEqual(['Tell us briefly what you need.', 'Please check your ZIP code: it should be 5 digits.'])
  await expect(page.getByLabel('What do you need?')).toBeFocused()
  await expect(page.getByLabel('What do you need?')).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('What do you need?').fill('Green pool cleanup')
  await page.getByLabel(/Your ZIP code/).fill('29403')
  await page.getByRole('button', { name: 'See open times' }).click()
  await page.locator('.bk-slot').first().click()
  await page.getByRole('button', { name: /^Continue with / }).click()
  // Details, empty: one submit, every problem at once, each under its own field, focus on the first.
  await page.getByRole('button', { name: /^Confirm / }).click()
  expect(await alerts(page)).toEqual([
    'Please enter your name.',
    'Please enter your phone number with its area code (10 digits).',
    'Please enter a valid email so we can send your calendar invitation.',
    'Please enter the street address, including the number.',
    'Please enter the city.',
    'Please enter the two-letter state, like SC.',
  ])
  await expect(page.getByLabel('Name')).toBeFocused()
  const nameBox = await page.getByLabel('Name').boundingBox()
  const nameError = await page.getByText('Please enter your name.').boundingBox()
  expect(nameError.y - (nameBox.y + nameBox.height), 'the message sits right under its field').toBeLessThan(16)
  // No message names a field that is not on this screen.
  await expect(page.getByText('Tell us briefly what you need.')).toHaveCount(0)
  await page.getByLabel('Name').fill('Robin Homeowner')
  await page.getByLabel('Email').fill('robin@example.net')
  await page.getByLabel('Street address').fill('21 Tide Ln')
  await page.getByLabel('City').fill('Charleston')
  await page.getByLabel('State').fill('sc')
  await page.getByLabel('Phone').fill('5550 1422')
  await page.getByRole('button', { name: /^Confirm / }).click()
  expect(await alerts(page)).toEqual(['Please enter your phone number with its area code (10 digits).'])
  expect(sent.leads, 'nothing was sent while a field was wrong').toEqual([])
  await page.getByLabel('Phone').fill('(843) 555-0142')
  await page.getByRole('button', { name: /^Confirm / }).click()
  await expect(page.getByRole('heading', { name: 'Visit booked' })).toBeVisible()
  expect(sent.leads).toHaveLength(1)
})

test('BOOK-01: an address ZIP that is not the checked ZIP is named before anything is sent; the request screen shows no time @mobile', async ({ page }) => {
  // Real Functions (the at-customer business with the service list 29403); this visitor has its own address.
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '198.51.100.71' })
  const leads = []
  page.on('request', (r) => r.url().endsWith('/lead') && leads.push(r.url()))
  await page.goto(`/book/${fixtures.E2E_HOME_CUSTOMER}`)
  await page.getByLabel('What do you need?').fill('Green pool cleanup')
  await page.getByLabel(/Your ZIP code/).fill('29403')
  await page.getByRole('button', { name: 'See open times' }).click()
  await page.locator('.bk-slot').last().click()
  await page.getByRole('button', { name: /^Continue with / }).click()
  await page.getByLabel('Name').fill('Morgan Mismatch')
  await page.getByLabel('Phone').fill('(843) 555-0171')
  await page.getByLabel('Email').fill('morgan@example.net')
  await page.getByLabel('Street address').fill('8 Shell Rd')
  await page.getByLabel('City').fill('Mount Pleasant')
  await page.getByLabel('State').fill('SC')
  await page.getByLabel('ZIP', { exact: true }).fill('29464')
  await page.getByRole('button', { name: /^Confirm / }).click()
  const note = page.locator('.bk-mismatch')
  await expect(note).toContainText('The ZIP in your address (29464) is not the ZIP you checked (29403).')
  await expect(note).toContainText('would not be booked')
  expect(leads, 'nothing is sent before the customer chooses').toEqual([])
  // Either ZIP can be corrected: take the checked one back into the address…
  await note.getByRole('button', { name: 'Use 29403 in my address' }).click()
  await expect(page.getByLabel('ZIP', { exact: true })).toHaveValue('29403')
  await expect(note).toHaveCount(0)
  // …or keep the address ZIP and send the details as a request.
  await page.getByLabel('ZIP', { exact: true }).fill('29464')
  await page.getByRole('button', { name: /^Confirm / }).click()
  await page.locator('.bk-mismatch').getByRole('button', { name: 'Send my details for 29464 (no time booked)' }).click()
  await expect(page.getByRole('heading', { name: 'Thanks, Morgan' })).toBeVisible()
  await expect(page.getByText('No visit is booked yet.')).toBeVisible()
  await expect(page.getByText(/has your details for ZIP 29464 and will confirm availability with you/)).toBeVisible()
  await expect(page.locator('.bk-facts')).not.toContainText('Time')
  await expect(page.getByRole('heading', { name: 'Visit booked' })).toHaveCount(0)
})

test('BOOK-03 + BOOK-04 + BOOK-05 + BOOK-08: notes before Confirm, time zone in words, reload keeps the form and then the confirmation, a tappable way to reach the business @mobile', async ({ page }) => {
  const { sent } = await standIn(page)
  await page.goto(`/book/${ID}`)
  await page.getByRole('radio', { name: /Weekly pool care/ }).click()
  await page.getByRole('button', { name: 'See open times' }).click()
  await expect(page.getByText('Times are in Eastern Time.')).toBeVisible() // BOOK-08
  await page.locator('.bk-day').nth(1).click()
  await page.locator('.bk-slot').nth(1).click()
  const chosen = await pressed(page, '.bk-slot').textContent()
  await page.getByRole('button', { name: /^Continue with / }).click()
  await page.getByLabel('Name').fill('Jordan Lead')
  await page.getByLabel('Phone').fill('(843) 555-0142')
  await page.getByLabel('Email').fill('jordan@example.net')
  // BOOK-04: the owner's notes are on the phone screen before Confirm.
  const notes = page.getByRole('region', { name: 'Good to know' })
  await expect(notes).toBeVisible()
  await expect(notes).toContainText('Cancellations: Please cancel at least 24 hours ahead.')
  expect((await notes.boundingBox()).y).toBeLessThan((await page.getByRole('button', { name: /^Confirm / }).boundingBox()).y)
  // BOOK-05: footer links open beside the booking page, and a reload keeps the service, the time and what was typed.
  await expect(page.locator('.pub-foot').getByRole('link', { name: 'Privacy' })).toHaveAttribute('target', '_blank')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveValue('Jordan Lead')
  await expect(page.getByLabel('Phone')).toHaveValue('(843) 555-0142')
  await expect(page.getByLabel('Email')).toHaveValue('jordan@example.net')
  const facts = page.locator('.bk-facts')
  await expect(facts).toContainText(chosen)
  await expect(facts).toContainText('Eastern Time') // BOOK-08: the time zone beside every time
  await expect(page.locator('.bk-summary-title')).toHaveText('Weekly pool care')
  expect(JSON.stringify(await page.evaluate((k) => sessionStorage.getItem(k), `gsu_book_${ID}`))).not.toContain('tok')
  await page.getByRole('button', { name: /^Confirm / }).click()
  // BOOK-03 + BOOK-08: the confirmation repeats what was booked, names the zone, and offers the business's phone.
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  const done = page.locator('.bk-done')
  await expect(done.locator('.bk-done-when')).toContainText(`${chosen} Eastern Time`)
  await expect(done).toContainText('Weekly pool care · 1 hr · $280/month')
  await expect(done).toContainText('To change or cancel, call Standin Pools: (843) 555-0100.')
  await expect(done.getByRole('link', { name: 'Call (843) 555-0100' })).toHaveAttribute('href', 'tel:+18435550100')
  expect(sent.appointments).toHaveLength(1)
  // The confirmation survives a reload; this tab keeps no lead token and none of the typed contact details but the email shown.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await expect(page.locator('.bk-done-when')).toContainText(`${chosen} Eastern Time`)
  await expect(page.getByText('A calendar invitation is on its way to jordan@example.net.')).toBeVisible()
  const kept = await page.evaluate((k) => sessionStorage.getItem(k), `gsu_book_${ID}`)
  expect(kept).not.toContain('tok')
  expect(kept).not.toContain('555-0142')
  expect(sent.appointments, 'a reload books nothing again').toHaveLength(1)
  expect(await smallControls(page), 'CHAT-03 on the confirmation').toEqual([])
  // "Book another" starts clean.
  await page.getByRole('button', { name: 'Book another appointment' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'What can we help with?' })).toBeVisible()
  expect(await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) || '{}').result ?? null, `gsu_book_${ID}`)).toBeNull()
})

test('BOOK-06 + BOOK-07: changing the time opens on the chosen day and slot; a same-length service keeps a still-open time @mobile', async ({ page }) => {
  await standIn(page)
  await page.goto(`/book/${ID}`)
  await page.getByRole('radio', { name: /Weekly pool care/ }).click()
  await page.getByRole('button', { name: 'See open times' }).click()
  await page.locator('.bk-day').nth(2).click()
  const day = await pressed(page, '.bk-day').textContent()
  await page.locator('.bk-slot').nth(2).click()
  const time = await pressed(page, '.bk-slot').textContent()
  await page.getByRole('button', { name: /^Continue with / }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible()
  // BOOK-07: back to the times → the pressed day and the highlighted slot are the chosen ones.
  await page.getByRole('button', { name: 'Change time' }).click()
  await expect(pressed(page, '.bk-day')).toHaveText(day)
  await expect(pressed(page, '.bk-slot')).toHaveText(time)
  await page.getByRole('button', { name: /^Continue with / }).click()
  // BOOK-06: another service of the same length → the time stays, straight back to the details.
  await page.getByRole('button', { name: 'Change service' }).click()
  await page.getByRole('radio', { name: /Filter cleaning/ }).click()
  await page.getByRole('button', { name: 'See open times' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your details' })).toBeVisible()
  await expect(page.locator('.bk-summary-title')).toHaveText('Filter cleaning')
  await expect(page.locator('.bk-facts')).toContainText(time)
  await expect(page.getByRole('button', { name: /^Confirm / })).toBeVisible()
  // A longer service has other open times: the time is asked again (never silently kept).
  await page.getByRole('button', { name: 'Change service' }).click()
  await page.getByRole('radio', { name: /Green pool cleanup/ }).click()
  await page.getByRole('button', { name: 'See open times' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible()
  await expect(pressed(page, '.bk-slot')).toHaveCount(0)
  expect(await smallControls(page), 'CHAT-03 on the time step').toEqual([])
})

test('BOOK-10: the lockout says when to try again, keeps the form, and is gone after going back @mobile', async ({ page }) => {
  await standIn(page, { lead: () => [429, { error: 'rate_limited' }, { 'Retry-After': '420' }] })
  await page.goto(`/book/${ID}`)
  await page.getByRole('radio', { name: /Weekly pool care/ }).click()
  await page.getByRole('button', { name: 'See open times' }).click()
  await page.locator('.bk-slot').first().click()
  await page.getByRole('button', { name: /^Continue with / }).click()
  await page.getByLabel('Name').fill('Jordan Lead')
  await page.getByLabel('Phone').fill('(843) 555-0142')
  await page.getByLabel('Email').fill('jordan@example.net')
  await page.getByRole('button', { name: /^Confirm / }).click()
  await expect(page.getByRole('alert')).toHaveText(/^Too many attempts\. Please try again in about 7 minutes \(after \d{1,2}:\d{2}\s?[AP]M\)\. What you typed is kept\.$/)
  await expect(page.getByLabel('Name')).toHaveValue('Jordan Lead')
  expect(await smallControls(page), 'CHAT-03 on the details step').toEqual([])
  await page.getByRole('button', { name: 'Change time' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Pick a time' })).toBeVisible()
  await expect(page.getByText(/Too many attempts/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Change service' }).click()
  await expect(page.getByText(/Too many attempts/)).toHaveCount(0)
  expect(await smallControls(page), 'CHAT-03 on the first step').toEqual([])
})

// ---- chat ----
const CHAT = 'e2e-standin-chat'
async function chatStandIn(page, { chat } = {}) {
  await page.route(`**/api/receptionist/${CHAT}`, (route) =>
    json(route, 200, { enabled: true, name: 'Standin Pools', greeting: 'Hi! Ask me anything.', phone: '+18435550100', voice: true, voiceStatus: 'available', callbacks: true, website: 'http://127.0.0.1/p/standin', services: [{ name: 'Weekly pool care', flow: 'book' }], brand: { product: false, logo: null, accent: null } }),
  )
  await page.route(`**/api/receptionist/${CHAT}/chat`, (route) => (chat ? chat(route) : json(route, 200, { conversationId: 'c1', token: 't1', reply: 'Happy to help.' })))
}

test('CHAT-01: the message box grows to three lines and more; near the limit it counts, past it nothing is cut and it says so @mobile', async ({ page }) => {
  await chatStandIn(page)
  await page.goto(`/chat/${CHAT}`)
  const box = page.getByLabel('Your message')
  await expect(box).toBeVisible()
  const one = (await box.boundingBox()).height
  await box.fill('My pool has been green for two weeks.\nThe pump hums but will not start.\nCan someone come on Friday?')
  expect((await box.boundingBox()).height, 'three lines are all on screen').toBeGreaterThanOrEqual(one + 2 * 22)
  await expect(page.locator('#rc-count')).toHaveCount(0)
  await box.fill('a'.repeat(1400))
  await expect(page.locator('#rc-count')).toHaveText('1,400 of 1,500 characters')
  await box.fill(`${'word '.repeat(320)}end`) // 1,603 characters
  await expect(box).toHaveValue(`${'word '.repeat(320)}end`) // nothing was cut off
  await expect(page.getByRole('alert')).toHaveText('Your message is 103 characters too long. Shorten it to send (nothing is cut off).')
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
  await box.fill('What times are open this week?')
  await box.press('Enter')
  await expect(page.getByText('Happy to help.')).toBeVisible()
  await expect(box).toHaveValue('')
})

test('CHAT-04: a message that could not be sent stays on screen marked "Not sent" with Retry; a failed history load says so @mobile', async ({ page }) => {
  let online = false
  await chatStandIn(page, { chat: (route) => (online ? json(route, 200, { conversationId: 'c1', token: 't1', reply: 'Happy to help.' }) : route.abort('internetdisconnected')) })
  await page.goto(`/chat/${CHAT}`)
  await page.getByLabel('Your message').fill('Do you service hot tubs?')
  await page.getByRole('button', { name: 'Send' }).click()
  const unsent = page.locator('.chat-msg--failed')
  await expect(unsent).toContainText('Do you service hot tubs?')
  await expect(unsent).toContainText('Not sent')
  await expect(page.getByRole('alert')).toContainText('Connection problem. Check your internet and try again.')
  online = true
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Happy to help.')).toBeVisible()
  await expect(page.locator('.chat-msg--failed')).toHaveCount(0)
  await expect(page.getByText('Do you service hot tubs?')).toHaveCount(1)
  // After a reload the conversation so far cannot be fetched: the page says so and offers to try again.
  let history = 500
  await page.route(`**/api/receptionist/${CHAT}/conversation`, (route) => (history === 200 ? json(route, 200, { transcript: [{ who: 'customer', text: 'Do you service hot tubs?', channel: 'chat' }], booked: null, request: null, ended: false }) : json(route, 500, { error: 'storage_error' })))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('We couldn’t load this conversation so far.')
  history = 200
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Do you service hot tubs?')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('CHAT-02 + CHAT-03: the tab names the business, no GetShowUps marketing text or price in the page description, the booking page offers the phone, every control is 44 px @mobile', async ({ page }) => {
  await chatStandIn(page)
  await standIn(page)
  await page.goto(`/chat/${CHAT}`)
  await expect(page).toHaveTitle('Chat with Standin Pools')
  const description = () => page.locator('meta[name="description"]').getAttribute('content')
  expect(await description()).toBe('Ask Standin Pools a question or book an appointment.')
  await expect(page.getByLabel('Your message')).toBeVisible()
  expect(await smallControls(page), 'chat').toEqual([])
  await page.getByLabel('Your message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Happy to help.')).toBeVisible()
  await page.getByRole('button', { name: 'End conversation' }).click()
  expect(await smallControls(page), 'chat with a conversation and the end question').toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

  await page.goto(`/book/${ID}`)
  await expect(page).toHaveTitle('Book with Standin Pools')
  expect(await description()).toBe('Book online with Standin Pools: pick a time that works for you.')
  await expect(page.locator('.pub-top').getByRole('link', { name: 'Call (843) 555-0100' })).toHaveAttribute('href', 'tel:+18435550100')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // The document itself (before any script runs; what a link preview or a search engine reads) carries no GetShowUps
  // marketing title, description or price on a business's pages — the marketing page keeps its own.
  for (const path of [`/book/${fixtures.E2E_CUSTOMER}`, `/chat/${fixtures.E2E_CUSTOMER}`]) {
    const html = await (await page.request.get(path)).text()
    expect(html, path).not.toMatch(/\$\d|founding plan|Turn More Leads|og:title/)
    expect(html, path).toMatch(/<title>(Book online|Chat with us)<\/title>/)
  }
  expect(await (await page.request.get('/')).text()).toMatch(/<title>GetShowUps/)
})
