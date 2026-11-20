// Teach Your AI (src/dashboard/TeachAI.jsx, /api/dashboard/ai-rules): the owner's whole journey on a PoolThru-like
// business (visits the customer, Mount Pleasant + Charleston, ZIP list): records shown → mark a town fully served →
// teach a change in plain words → review and add it → test a conversation (no repeated questions) → publish → change
// again → go back to version 1. Each browser project has its own business (e2e-teach / e2e-teach-m). Published rules
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
  await proposal.getByRole('button', { name: 'Add to my draft' }).click()
  await expect(page.getByText(/Change added to your draft/)).toBeVisible()
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

  // 5. Publish v1 (explicit confirmation), then change and publish v2, then go back to v1 (published as v3).
  const pub = section(page, 'Publish')
  await expect(pub.getByText('First version.')).toBeVisible()
  await expect(pub.getByRole('button', { name: 'Publish' })).toBeDisabled()
  await pub.getByLabel('I’ve tested these rules and want customers to get them.').check()
  await pub.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText(/Published\. Customers aren’t affected yet/)).toBeVisible()
  await expect(page.getByText('Version 1 published').first()).toBeVisible()
  await expect(pub.getByText('Your draft matches what’s published.')).toBeVisible()

  await section(page, 'About your business').getByLabel('All of Mount Pleasant').uncheck()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(pub.getByText('Fully served towns: removed Mount Pleasant.')).toBeVisible()
  await pub.getByLabel('I’ve tested these rules and want customers to get them.').check()
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
  await expect(proposal.getByRole('button', { name: 'Add to my draft' })).toBeDisabled()
})

test('businesses not released for Teach Your AI don’t see it (tab, address and API)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  await expect(page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Receptionist' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Teach Your AI' })).toHaveCount(0)
  await page.goto('/dashboard/teach')
  await expect(page.getByRole('heading', { level: 1, name: 'Teach Your AI' })).toHaveCount(0)
  expect((await page.request.get('/api/dashboard/ai-rules')).status()).toBe(404)
})
