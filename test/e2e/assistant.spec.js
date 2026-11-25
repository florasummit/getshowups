// The dashboard assistant and proactive suggestions: everywhere, one conversation, reviewed changes, no uninvited model calls.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

const panelOf = (page) => page.locator('.help-panel')
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

test('assistant: opens from every section, keeps the conversation, sends nothing by itself @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const asked = []
  await page.route('**/api/dashboard/assist', (r) => {
    asked.push(r.request().postDataJSON())
    return r.fulfill({ json: /LLC/.test(asked.at(-1).question) ? { kind: 'general', answer: 'No. Use accurate records.', note: 'General information, not legal, tax or financial advice.', days: 30 } : { kind: 'business', answer: 'Two people are waiting.', days: 30 } })
  })
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')
  for (const name of ['Overview', 'Appointments', 'Follow-ups', 'Receptionist', 'Teach Your AI', 'Website', 'Ads', 'Settings']) {
    await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name, exact: true }).click()
    await page.getByRole('button', { name: 'Assistant' }).click()
    await expect(panelOf(page)).toBeFocused()
    await expect(panelOf(page).locator('[data-ask-idea]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Assistant' })).toBeFocused()
  }
  expect(asked).toEqual([])
  expect(await wide(page)).toBeLessThanOrEqual(0)
  await page.getByRole('button', { name: 'Assistant' }).click()
  await panelOf(page).getByRole('textbox').fill('Can I lie about my LLC?')
  await page.keyboard.press('Enter')
  await expect(panelOf(page)).toContainText('General information, not legal')
  // Another page: the conversation is still there and the next question carries the new page and the earlier turn.
  await page.getByRole('link', { name: 'Appointments', exact: true }).click()
  await expect(panelOf(page)).toContainText('Use accurate records')
  await panelOf(page).getByRole('textbox').fill('Who is waiting?')
  await page.keyboard.press('Enter')
  await expect(panelOf(page)).toContainText('Two people are waiting')
  expect(asked.map((a) => [a.view, a.history.length])).toEqual([['settings', 0], ['appointments', 1]])
  await page.waitForTimeout(500)
  await page.screenshot({ path: `test-results/assistant-${page.viewportSize().width}.png` })
})

test('a metric’s conversation survives leaving its page', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  await page.route('**/api/dashboard/assist', (r) => r.fulfill({ json: { kind: 'business', answer: 'Three asked.', days: 30 } }))
  await page.goto('/dashboard')
  await page.getByRole('button', { name: /New inquiries/ }).click()
  await panelOf(page).locator('[data-ask-idea]').first().click()
  await expect(panelOf(page)).toContainText('Three asked.')
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(panelOf(page)).toContainText('Three asked.')
  await expect(panelOf(page)).toHaveAttribute('data-help-panel', 'assistant')
})

test('one suggestion, where it is useful; it explains itself, can be asked about, and stays dismissed @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  let list = [
    { id: 'calendar', priority: 1, home: 'settings', level: 1, title: 'Your calendar needs attention', evidence: ['Our last checks failed.'], action: ['Check the calendar', 'settings'], ask: 'What happens while my calendar isn’t connected?', topic: 'calendar' },
    { id: 'outside_area', priority: 3, home: 'appointments', level: 4, title: '4 recent inquiries came from outside your service area', evidence: ['Last 90 days: 29464 (3).'], action: ['Review my ZIP codes', 'assist'], ask: 'Help me improve my service area', topic: null },
  ]
  const posts = []
  const models = []
  page.on('request', (r) => r.url().includes('/assist') && models.push(r.url()))
  await page.route('**/api/dashboard/insights', (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { insights: list } })
    posts.push(r.request().postDataJSON())
    list = list.filter((x) => x.id !== posts.at(-1).id)
    return r.fulfill({ json: { ok: true } })
  })
  await page.goto('/dashboard')
  const it = page.locator('[data-insight]')
  await expect(it).toHaveCount(1)
  await expect(it).toHaveAttribute('data-insight', 'calendar')
  await it.getByText('Why am I seeing this?').click()
  await expect(it).toContainText('Our last checks failed.')
  expect(models).toEqual([])
  await page.screenshot({ path: `test-results/insight-${page.viewportSize().width}.png` })
  // Not repeated on its own page after Overview showed it.
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(it).toHaveCount(0)
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await it.getByRole('button', { name: 'Dismiss' }).click()
  expect(posts).toEqual([{ id: 'calendar', kind: 'dismiss' }])
  await expect(page.locator('[data-insight="calendar"]')).toHaveCount(0)
  await page.reload()
  await expect(it).toHaveAttribute('data-insight', 'outside_area')
  await it.getByRole('button', { name: 'Review my ZIP codes' }).click()
  await expect(panelOf(page)).toContainText('Help me improve my service area')
  expect(models).toHaveLength(1)
  expect(await wide(page)).toBeLessThanOrEqual(0)
})

test('operator: misspelled request → real records → prepared change; only the button saves; cancel leaves it @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_AREA_SESSION_TOKEN)
  const zips = async () => (await (await page.request.get('/api/dashboard/me')).json()).customer.serviceZips
  const before = await zips()
  const add = ['29464', '29412', '29405', '29406'].find((z) => !before.includes(z))
  await page.goto('/dashboard/settings')
  await page.getByRole('button', { name: 'Assistant' }).click()
  const box = panelOf(page).getByRole('textbox', { name: 'Your question' })
  await box.fill('app oinmntes')
  await page.keyboard.press('Enter')
  await expect(panelOf(page).locator('.ask-entry').last()).toContainText(/coming up/)
  await box.fill(`Add ${add} to my zip codes`)
  await page.keyboard.press('Enter')
  const card = panelOf(page).locator('[data-proposal]').last()
  await expect(card).toContainText(`+ ${add}`)
  expect(await zips()).toEqual(before)
  await card.getByRole('button', { name: 'Don’t change' }).click()
  await expect(panelOf(page)).toContainText('Not changed.')
  expect(await zips()).toEqual(before)
  expect(await wide(page)).toBeLessThanOrEqual(0)
})

test('operator: approving saves once and the settings form shows it', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const zips = async () => (await (await page.request.get('/api/dashboard/me')).json()).customer.serviceZips
  const before = await zips()
  test.skip(!before.length, 'needs a limited area')
  const add = ['29464', '29412', '29405'].find((z) => !before.includes(z))
  await page.goto('/dashboard/settings')
  await page.getByRole('button', { name: 'Assistant' }).click()
  await panelOf(page).getByRole('textbox', { name: 'Your question' }).fill(`Add ${add} to my zip codes`)
  await page.keyboard.press('Enter')
  const card = panelOf(page).locator('[data-proposal]').last()
  await card.getByRole('button', { name: 'Save these ZIP codes' }).click()
  await expect(card).toContainText('Saved.')
  expect(await zips()).toEqual([...before, add])
  await expect(page.getByLabel(/ZIP/i).first()).toHaveValue([...before, add].join(', '))
  await page.request.post('/api/dashboard/proposal', { headers: { Origin: new URL(page.url()).origin }, data: { type: 'service_zips', before: [...before, add], after: before, confirm: true } })
  expect(await zips()).toEqual(before)
})

test('follow-up writing: a checked suggestion lands in the editable reply box; nothing is sent', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TEXTS_SESSION_TOKEN)
  const sent = []
  page.on('request', (r) => r.method() === 'POST' && r.url().includes('/followups/') && sent.push(r.url()))
  await page.goto('/dashboard/followups')
  await page.locator('.app-main').getByRole('button').filter({ hasText: /@|Pool|pool|ago/ }).first().click()
  const box = page.getByLabel('Your reply')
  await page.locator('[data-ai-write="reply"]').getByRole('button', { name: 'Draft for me' }).click()
  await page.getByRole('button', { name: 'Use this' }).click()
  await expect(box).toHaveValue('Pool care you can book online.')
  await box.fill('Edited by me.')
  await expect(box).toHaveValue('Edited by me.')
  expect(sent).toEqual([])
})

test('assistant: when the AI allowance is used up it says so, when it returns, and offers what still works @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const resumesAt = Date.parse('2026-11-25T00:00:00Z')
  const asked = []
  await page.route('**/api/dashboard/assist', (r) => {
    const q = r.request().postDataJSON().question
    asked.push(r.request().postDataJSON())
    if (q === 'What is going on with appointments?') return r.fulfill({ json: { kind: 'records', answer: 'Here’s what’s recorded:', aiOut: 'quota', resumesAt, days: 30 } })
    // The refused question is stubbed; everything else is the real handler.
    return q === 'Write me a poem' ? r.fulfill({ status: 503, json: { error: 'quota', resumesAt, try: ['What is this page for?'], days: 30 } }) : r.continue()
  })
  await page.goto('/dashboard/teach')
  await page.getByRole('button', { name: 'Assistant' }).click()
  const panel = panelOf(page)
  await panel.getByRole('textbox').fill('Write me a poem')
  await page.keyboard.press('Enter')
  await expect(panel).toContainText('today’s shared AI allowance is used up')
  await expect(panel).toContainText('They’re back')
  await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'What is this page for?' }).first().click()
  await expect(panel).toContainText('This is Teach Your AI')
  // A bare list says it is not analysis, and neither it nor a refused question is replayed as the AI's own answer.
  await panel.getByRole('textbox').fill('What is going on with appointments?')
  await page.keyboard.press('Enter')
  await expect(panel.locator('[data-ai-out]')).toContainText('without analysis or advice')
  await panel.getByRole('textbox').fill('Where is my help button?')
  await page.keyboard.press('Enter')
  await expect(panel).toContainText('top of every dashboard page')
  const sent = asked.at(-1).history.map((h) => h.a)
  expect(sent[0]).toContain('not answered')
  expect(sent.at(-1)).toContain('only listed')
  expect(await wide(page)).toBeLessThanOrEqual(0)
})

test('overview: results in full open on demand and fit the screen @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const asked = []
  page.on('request', (r) => r.url().includes('/api/dashboard/results') && asked.push(r.url()))
  await page.goto('/dashboard')
  const card = page.locator('[data-scorecard]')
  await expect(card).toBeVisible()
  expect(asked.filter((u) => u.includes('scope=all'))).toEqual([])
  await card.locator('summary').click()
  await expect(card.getByRole('rowheader', { name: 'Time to first message or booking' })).toBeVisible()
  await expect(card).toContainText('too few to judge')
  await card.getByRole('button', { name: '90 days' }).click()
  await expect(card).toContainText('last 90 days')
  expect(await wide(page)).toBeLessThanOrEqual(0)
})

test('a conversation survives reload and closing, names are read again, can be started over and deleted, and sign-out clears it @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_TOUR_SESSION_TOKEN)
  const sent = []
  await page.route('**/api/dashboard/assist', async (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ json: { enabled: true } })
    const b = r.request().postDataJSON()
    if (b.restore) return r.fulfill({ json: { names: { R1: 'Rosa Vance' } } })
    sent.push(b)
    return r.fulfill({ json: { id: 'ai_ask:abcdef', kind: 'business', answer: 'Rosa Vance is waiting.', raw: '[R1] is waiting.', refs: { A: [], L: [], R: ['r1'] }, lookups: [], records: [], proposals: [], days: 30 } })
  })
  const ask = async (q) => {
    await panelOf(page).getByRole('textbox', { name: 'Your question' }).fill(q)
    await page.keyboard.press('Enter')
    await expect(panelOf(page).locator('.ask-entry').last()).toContainText('Rosa Vance is waiting.')
  }
  await page.goto('/dashboard')
  await page.getByRole('button', { name: 'Assistant' }).click()
  await ask('who is waiting')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('Rosa')
  await page.reload()
  await page.getByRole('button', { name: 'Assistant' }).click()
  await expect(panelOf(page).locator('.ask-entry')).toContainText('Rosa Vance is waiting.')
  await ask('and since when')
  expect(sent.at(-1).history[0]).toEqual({ q: 'who is waiting', a: '(said earlier) [R1] is waiting.' })
  expect(sent.at(-1).refs.R).toEqual(['r1'])
  await panelOf(page).getByRole('button', { name: 'New conversation' }).click()
  await expect(panelOf(page).locator('.ask-entry')).toHaveCount(0)
  await panelOf(page).getByText('Earlier conversations').click()
  await panelOf(page).getByRole('button', { name: 'who is waiting', exact: true }).click()
  await expect(panelOf(page).locator('.ask-entry')).toHaveCount(2)
  await panelOf(page).getByRole('button', { name: 'New conversation' }).click()
  await panelOf(page).getByText('Earlier conversations').click()
  await panelOf(page).getByRole('button', { name: /^Delete conversation/ }).click()
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gsu:assistant')).length)).toBe(0)
  await ask('once more')
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gsu:assistant')).length)).toBe(1)
  // Someone else signs in on this browser without a sign-out: nothing of it is shown or left behind.
  await useSession(context, fixtures.E2E_AREA_SESSION_TOKEN)
  await page.reload()
  await page.getByRole('button', { name: 'Assistant' }).click()
  await expect(panelOf(page).locator('.ask-entry')).toHaveCount(0)
  await expect(panelOf(page).getByText('Earlier conversations')).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gsu:assistant')).length)).toBe(0)
  await ask('their own question')
  await page.route('**/api/auth/logout', () => {}) // never answered
  expect(await wide(page)).toBeLessThanOrEqual(0)
  await panelOf(page).getByRole('button', { name: 'Close' }).click()
  // Cleared even if the server never answers the sign-out.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gsu:assistant')).length)).toBe(0)
})
