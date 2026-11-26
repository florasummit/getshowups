// Teach Your AI (src/dashboard/TeachAI.jsx, /api/dashboard/ai-rules): the owner's whole journey on a PoolThru-like
// business (visits the customer, Mount Pleasant + Charleston, ZIP list): the plain-words box first on the page →
// records shown → mark a town fully served → teach a change in plain words (every part accounted for) → review and
// add it → test a conversation (no repeated questions) → publish (told truthfully who gets the rules) → change again
// → go back to version 1. Each browser project has its own business (e2e-teach / e2e-teach-m). Published rules
// never reach conversations here (AI_RULES_LIVE_BUSINESSES is unset), and nothing calls a model or the calendar.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ mode: 'serial', timeout: 90_000 })
const tokenFor = (info) => (info.project.name === 'mobile' ? fixtures.E2E_TEACH_M_SESSION_TOKEN : fixtures.E2E_TEACH_SESSION_TOKEN)

async function open(page) {
  await page.goto('/dashboard')
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Teach Your AI' }).click()
  await expect(page).toHaveURL(/\/dashboard\/teach$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Teach Your AI' })).toBeVisible()
}
const section = (page, name) => page.getByRole('region', { name })

test('owner teaches, tests, publishes and rolls back their AI rules; no sideways scrolling @mobile', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  const modelCalls = []
  page.on('request', (r) => /anthropic|retell/i.test(r.url()) && modelCalls.push(r.url()))
  await open(page)
  await expect(page.getByText('Not published yet').first()).toBeVisible()

  // TEACH-05: the plain-words box is the first thing on the page, inside the first screen (phone 390 × 844 too).
  const box = section(page, 'Teach a change').getByLabel('Describe the change in your own words')
  const at = await box.boundingBox()
  expect(at.y + at.height, 'the plain-words box is on the first screen').toBeLessThanOrEqual(page.viewportSize().height)
  // TEACH-07: one numbering: the four cards are the four numbered sections; wording follows the trade (a pool business).
  await expect(page.getByRole('navigation', { name: 'Teach Your AI steps' }).getByRole('link')).toHaveCount(4)
  for (const h of ['1. About your business', '2. How your AI works', '3. Test your AI', '4. Publish']) await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: /^5\./ })).toHaveCount(0)
  await expect(section(page, 'How your AI works').getByText('Pool type or equipment')).toBeVisible()
  await expect(section(page, 'How your AI works').getByPlaceholder('e.g. a child or pet in danger')).toBeVisible()
  expect(await page.locator('main.app-main').innerText()).not.toMatch(/system type|no heat|Retell|\(approval\)|pilot/i)
  // TEACH-01 / TEACH-03: a rule that can't be made is never a bare "Nothing would change.": the reason, where it
  // lives, wording that works, and no "Add to my draft". The page's own example works when clicked.
  const early = section(page, 'Teach a change')
  await box.fill("Don't book green pool cleanups on Fridays. Book people outside my service area.")
  await early.getByRole('button', { name: 'Suggest the change' }).click()
  const why = page.getByRole('region', { name: 'Suggested change' })
  await expect(why.getByText(/Not changed: Which days and times can be booked comes from your booking hours/)).toBeVisible()
  await expect(why.getByRole('link', { name: 'Open Settings → Booking' })).toHaveAttribute('href', '/dashboard/settings#booking-hours')
  await expect(why.getByText(/Not changed: People outside your service area are never booked automatically/)).toBeVisible()
  await expect(why.locator('[data-outcome="not_changed"]')).toHaveCount(2)
  await expect(why.getByText('Nothing would change.')).toHaveCount(0)
  await expect(why.getByRole('button', { name: 'Add to my draft' })).toHaveCount(0)
  await why.getByRole('button', { name: /We don’t do commercial pools/ }).click() // "wording that works" fills the box
  await expect(box).toHaveValue('We don’t do commercial pools.')
  await early.locator('[data-teach-examples]').getByRole('button', { name: /usually worth \$450/ }).click()
  await early.getByRole('button', { name: 'Suggest the change' }).click()
  await expect(why.getByText('For planning: Green pool cleanup: typical job $450')).toBeVisible()
  await expect(why.getByRole('button', { name: 'Add to my draft' })).toBeVisible()
  await why.getByRole('button', { name: 'Discard' }).click()

  // 1. About your business: records come from Settings; mark Mount Pleasant as fully served.
  const about = section(page, 'About your business')
  await expect(about.getByText('Weekly pool care ($160/month)')).toBeVisible()
  await expect(about.getByText(/You visit the customer/)).toBeVisible()
  await about.getByLabel('All of Mount Pleasant').check()
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText(/Draft saved\. Customers still get your published rules/)).toBeVisible()

  // 3. Teach a change: a proposal first, nothing saved until the owner adds it.
  const teach = section(page, 'Teach a change')
  await teach.getByLabel('Describe the change in your own words').fill("Ask what the customer needs before asking where they live. We don't do commercial pools. Skip checking the ZIP code.")
  await teach.getByRole('button', { name: 'Suggest the change' }).click()
  const proposal = page.getByRole('region', { name: 'Suggested change' })
  await expect(proposal.getByText('Services you don’t offer: added Commercial Pools.')).toBeVisible()
  await expect(proposal.getByText(/Not changed: The service area and the calendar are always checked/)).toBeVisible()
  await expect(proposal.getByText(/already asked before where the job is/)).toBeVisible()
  await expect(proposal.locator('[data-outcome]')).toHaveCount(3) // every sentence typed is accounted for
  await proposal.getByRole('button', { name: 'Add to my draft' }).click()
  await expect(page.getByText(/Change added to your draft/)).toBeVisible()
  await expect(page.locator('[data-teach-done]')).toBeInViewport() // TEACH-05: the confirmation is where the owner is looking
  await expect(section(page, 'About your business').getByRole('list', { name: 'Services you don’t offer' })).toContainText('Commercial Pools')

  // 4. Test your AI: city + problem + day in one message → recognized, area confirmed by town, the next question is
  // contact (never the town, ZIP or need again); then the address question.
  const testAi = section(page, 'Test your AI')
  await testAi.getByPlaceholder('What the customer says…').fill('My pool is green. I’m in Mount Pleasant and need someone Friday.')
  await testAi.getByRole('button', { name: 'Send' }).click()
  await expect(testAi.getByText(/Mount Pleasant is in our service area\. What’s your name and the best phone number/)).toBeVisible()
  await expect(testAi.getByText('Mount Pleasant is fully served: no ZIP code needed to confirm the area.')).toBeVisible()
  await expect(testAi.getByText('Town: Mount Pleasant')).toBeVisible()
  await testAi.getByPlaceholder('What the customer says next…').fill('I’m Jamie, 843-555-0142')
  await testAi.getByRole('button', { name: 'Send' }).click()
  await expect(testAi.getByText('Thanks, Jamie. What’s the address for the visit?')).toBeVisible()
  await expect(testAi.getByText(/ZIP code\?/)).toHaveCount(0)
  // TEACH-06: the page says the test continues the same pretend customer (Start over beside it), a turn doesn't repeat
  // the previous turn's verdicts, and a different place and job starts a new customer.
  await expect(testAi.locator('[data-continues]')).toContainText('Same pretend customer')
  await expect(testAi.locator('[data-continues]').getByRole('button', { name: 'Start over' })).toBeVisible()
  await expect(testAi.getByText('Mount Pleasant is fully served: no ZIP code needed to confirm the area.')).toHaveCount(1)
  await testAi.getByPlaceholder('What the customer says next…').fill('Do you do weekly pool care in Charleston?')
  await testAi.getByRole('button', { name: 'Send' }).click()
  await expect(testAi.locator('[data-fresh]')).toContainText('treated as a new customer')
  const last = testAi.locator('.ta-turn').last()
  await expect(last.getByText(/you serve parts of Charleston/)).toBeVisible()
  await expect(last).not.toContainText(/Jamie|Mount Pleasant|Friday/)

  // 5. Publish v1 (explicit confirmation), then change and publish v2, then go back to v1 (published as v3).
  const pub = section(page, 'Publish')
  // TEACH-07: a first version lists what it contains. TEACH-02: before publishing, one plain sentence says whether
  // customers get published rules now (here: not yet) and the next step; the checkbox doesn't promise otherwise.
  await expect(pub.locator('[data-first-version]')).toContainText('First version. It would contain:')
  await expect(pub.locator('[data-first-version]')).toContainText('Asks for: what they need')
  await expect(pub.locator('[data-publish-effect="not_yet"]')).toContainText('customers don’t get published rules yet')
  await expect(pub.locator('[data-publish-effect="not_yet"]')).toContainText('Your next step: publish, then email hello@getshowups.com')
  await expect(pub.getByLabel('I’ve tested these rules and want customers to get them.')).toHaveCount(0)
  await expect(pub.getByRole('button', { name: 'Publish' })).toBeDisabled()
  await pub.getByLabel('I’ve tested these rules and want to publish them.').check()
  await pub.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText(/Published\. Customers aren’t affected yet/)).toBeVisible()
  await expect(pub.locator('[data-publish-said]')).toBeInViewport()
  await expect(page.getByText('Version 1 published').first()).toBeVisible()
  await expect(pub.getByText('Your draft matches what’s published.')).toBeVisible()

  await section(page, 'About your business').getByLabel('All of Mount Pleasant').uncheck()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(pub.getByText('Fully served towns: removed Mount Pleasant.')).toBeVisible()
  await pub.getByLabel('I’ve tested these rules and want to publish them.').check()
  await pub.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Version 2 published').first()).toBeVisible()
  const history = pub.getByRole('list').filter({ hasText: 'Version 1' }).last()
  await history.getByRole('listitem').filter({ hasText: 'Version 1' }).getByRole('button', { name: 'Go back to this version' }).click()
  await pub.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByText('Version 1 is published again.')).toBeVisible()
  await expect(page.getByText('Version 3 published').first()).toBeVisible()
  await expect(pub.getByText('Went back to version 1.')).toBeVisible()

  // Simulation and teaching used fixed rules only: nothing went to a model or the voice provider.
  expect(modelCalls).toEqual([])
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a page showing older rules can’t save over newer ones; refused requests explain why', async ({ page, context }, info) => {
  await useSession(context, tokenFor(info))
  await open(page)
  const other = await context.newPage()
  await open(other)
  // The other tab saves first.
  await section(other, 'How your AI works').getByLabel('Tone').selectOption('brief')
  await other.getByRole('button', { name: 'Save draft' }).click()
  await expect(other.getByText(/Draft saved\. Customers still get/)).toBeVisible()
  // This tab still shows the older draft: its save is refused, nothing lost, the latest is shown.
  await section(page, 'How your AI works').getByLabel('Prices').selectOption('no_prices')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText(/changed somewhere else/)).toBeVisible()
  await expect(section(page, 'How your AI works').getByLabel('Tone')).toHaveValue('brief')
  // A request that would switch off a platform rule is refused with the reason; there's nothing to add.
  const teach = section(page, 'Teach a change')
  await teach.getByLabel('Describe the change in your own words').fill("Book them even if they're outside our area.")
  await teach.getByRole('button', { name: 'Suggest the change' }).click()
  const proposal = page.getByRole('region', { name: 'Suggested change' })
  await expect(proposal.getByText(/Not changed: A booking always needs a real open time/)).toBeVisible()
  await expect(proposal.getByRole('button', { name: 'Add to my draft' })).toHaveCount(0) // nothing to add: not offered (was: a greyed button)
})

test('every eligible business has Teach Your AI, even one that never set up its receptionist: a useful first screen, nothing published, no model call @mobile', async ({ page, context }) => {
  // e2e-pool: no pilot list ever named it and it has no receptionist settings at all.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  const modelCalls = []
  page.on('request', (r) => /anthropic|retell/i.test(r.url()) && modelCalls.push(r.url()))
  await page.goto('/dashboard')
  const nav = page.getByRole('navigation', { name: 'Dashboard' })
  await expect(nav.getByRole('link', { name: 'Receptionist' })).toBeVisible()
  await nav.getByRole('link', { name: 'Teach Your AI' }).click()
  await expect(page).toHaveURL(/\/dashboard\/teach$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Teach Your AI' })).toBeVisible()
  await expect(page.getByText('Not published yet').first()).toBeVisible()
  // Honest state: the receptionist is off, the rules can still be prepared and tested.
  await expect(page.locator('[data-receptionist-state="off"]')).toContainText('Your receptionist is off')
  await expect(page.getByRole('navigation', { name: 'Teach Your AI steps' }).getByRole('link')).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'About your business' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Test your AI' })).toBeVisible()
  const s = await (await page.request.get('/api/dashboard/ai-rules')).json()
  expect([s.saved, s.liveVersion ?? null, s.status.receptionistOn, s.status.rulesLive]).toEqual([false, null, false, false])
  expect(modelCalls).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
})
