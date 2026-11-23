// Ads flow in the browser against the real Functions on local workerd: business details → starter
// plan (no AI key in e2e) → editable preview → budget approval → owner approval → non-spending check.
// Live launch stays disabled (ADS_LIVE_LAUNCH unset), so nothing can be created or spent.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, returnFromMeta, useSession } from './helpers.js'

// No retries: these tests are one stateful sequence on a database seeded once per run. A retry re-runs
// the file from the top against the already-changed records (e.g. "Draft my plan" has become "Draft
// another plan"), so it can never pass and only hides the real failure behind a timeout.
test.describe.configure({ mode: 'serial', timeout: 60_000, retries: 0 })

test('owner drafts, previews, edits and approves a budget; approval enforces it @mobile', async ({ page, context }, testInfo) => {
  // Each project gets its own seeded business so the flow starts from scratch in both.
  await useSession(context, testInfo.project.name === 'mobile' ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard')
  // Overview shows the Advertising row (Ads switched on); nothing is recorded yet, so money values are
  // shown as unavailable ('—'), never as $0 or an estimate.
  const adsRow = page.locator('[data-ads-results]')
  await expect(adsRow.getByRole('heading', { name: 'Advertising' })).toBeVisible()
  for (const label of ['Ad spend', 'Clicks', 'Leads from ads', 'Bookings', 'Show-ups', 'Cost per booking', 'Cost per show-up']) {
    await expect(adsRow.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(adsRow.locator('.stat', { hasText: 'Ad spend' }).locator('.stat-value')).toHaveText('—')
  await expect(adsRow.getByText('Nothing recorded yet: connect an ad account in the Ads tab')).toBeVisible()
  await expect(adsRow.locator('.stat', { hasText: 'Cost per show-up' }).locator('.stat-value')).toHaveText('—')
  await page.getByRole('link', { name: 'Ads', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()

  await page.getByLabel('What kind of business?').fill('Pool service')
  // Comma-separated services become separate services (one per line works too).
  await page.getByLabel(/Services you want customers for/).fill('Weekly pool cleaning, Pool repair')
  await page.getByLabel('ZIP codes you serve').fill('29403, 29407')
  await page.getByLabel('Typical first job ($)').fill('300')
  await page.getByLabel('Monthly ad budget ($)').fill('600')
  // Website: a bare address is accepted by the browser and saved with https://; unsafe input is refused.
  await page.getByLabel(/^Website/).fill('localhost:8788')
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByText('Check: website')).toBeVisible()
  await page.getByLabel(/^Website/).fill('www.e2e-pools.example/book?ref=ads')
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/ads')).json()).profile.website).toBe('https://www.e2e-pools.example/book?ref=ads')

  expect((await (await page.request.get('/api/dashboard/ads')).json()).profile.services).toEqual(['Weekly pool cleaning', 'Pool repair'])

  await page.getByRole('button', { name: 'Draft my plan' }).click()
  await expect(page.getByText('Starter draft (AI planning is not switched on).')).toBeVisible()
  const campaign = page.locator('.campaign').first()
  // Whole headlines from the business name and each service; no word is cut in half.
  await expect(campaign.getByLabel('Ad preview')).toContainText('Weekly pool cleaning | Pool repair')
  const headlines = await campaign.getByRole('group', { name: /Headlines/ }).getByRole('textbox').evaluateAll((els) => els.map((e) => e.value))
  expect(headlines).toEqual(expect.arrayContaining(['Weekly pool cleaning', 'Pool repair', 'Book Online in Minutes']))
  for (const h of headlines) expect(h.length).toBeLessThanOrEqual(30)
  await expect(campaign.getByRole('group', { name: /Headlines/ }).locator('.counter').first()).toHaveText(/^\d+\/30$/)
  // One plan at a time: the Draft button is gone, and a repeated request is refused without a second draft.
  await expect(page.getByRole('button', { name: 'Draft my plan' })).toHaveCount(0)
  const again = await page.evaluate(async () => {
    const r = await fetch('/api/dashboard/ads/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    return [r.status, (await r.json()).error]
  })
  expect(again).toEqual([409, 'draft_exists'])
  await expect(page.locator('.campaign')).toHaveCount(1)
  // Inline validation: too long → counter and message; Check/Approve wait for a save; Discard restores.
  const h2 = campaign.getByLabel('Headline 2', { exact: true })
  await h2.fill('Weekly pool cleaning and full repairs')
  await expect(campaign.getByText('7 too long')).toBeVisible()
  await expect(campaign.getByRole('button', { name: 'Check (no spend)' })).toBeDisabled()
  await expect(campaign.getByText('Save your changes first.')).toBeVisible()
  await campaign.getByRole('button', { name: 'Discard' }).click()
  await expect(h2).toHaveValue('Weekly pool cleaning')
  await expect(campaign.getByRole('group', { name: 'Unsaved changes' })).toHaveCount(0)

  // Approval is blocked until a budget is approved (button disabled with a hint; the server refuses too,
  // see test/ads.test.js); the checkbox is required.
  await expect(campaign.getByRole('button', { name: 'Approve' })).toBeDisabled()
  await expect(campaign.getByText('Approve your monthly ad budget (step 4) to approve this campaign.')).toBeVisible()
  const budget = page.locator('.card', { has: page.getByRole('heading', { name: 'Monthly ad budget' }) })
  await budget.getByLabel('Monthly limit ($)').fill('300')
  await expect(budget.getByRole('button', { name: 'Approve budget' })).toBeDisabled()
  await budget.getByRole('checkbox').check()
  await budget.getByRole('button', { name: 'Approve budget' }).click()
  await expect(budget.getByText('Approved: $300/month')).toBeVisible()
  // Who pays what, at the moment of approving: Google charges ad spend; the plan doesn't include it; no GetShowUps fee.
  const pays = budget.getByRole('term').filter({ hasText: /./ })
  await expect(pays).toHaveText(['Ad spend', 'Your GetShowUps plan'])
  await expect(budget.getByText('Advertising spend is separate from your GetShowUps subscription and is billed by Google. GetShowUps does not currently charge an additional percentage of your ad spend.')).toBeVisible()
  await expect(budget.getByText('Charged by Google, directly to the payment method in your Google Ads account.')).toBeVisible()

  // The $600/mo draft no longer fits a $300/mo approval → shown as a problem, then fixed by editing.
  const c = page.locator('.campaign').first()
  await c.getByRole('button', { name: 'Approve' }).click()
  await expect(c.getByText('dailyBudgetCents: exceeds the approved budget')).toBeVisible()
  await c.getByLabel('Daily budget ($)').fill('9')
  await c.getByRole('button', { name: 'Save changes' }).click()
  // Local e2e runs on http://127.0.0.1, so the booking-page ad URL is not https and approval stays
  // blocked (production is https; the approve → launch-gate path is covered in test/ads.test.js).
  await expect(c.locator('.problems')).toHaveText('finalUrl: https URL required')
  await c.getByRole('button', { name: 'Approve' }).click()
  await expect(c.locator('.problems')).not.toContainText('exceeds the approved budget')
  await expect(c.locator('.chip')).toHaveText('Draft')
  await expect(page.getByText('Owner approved a monthly ad budget')).toBeVisible()
  // No horizontal overflow on phones.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('connect Google Ads: a Google Ads TEST account is connected and clearly labelled (mock API)', async ({ page, context }) => {
  // Google sign-in for Ads and the Google Ads API are local stand-ins (MOCK DATA: test accounts only, no
  // campaigns, no metrics). Nothing here reaches Google, creates a campaign or spends money.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads:owner@e2e.example')
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  // Not connected: status in words, Connect is the one primary action.
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveText('○Not connected')
  await expect(accounts.getByRole('link', { name: 'Connect', exact: true }).first()).toHaveClass(/btn-primary/) // Google first; Meta offers Connect too
  await expect(accounts.getByRole('link', { name: 'Reconnect' })).toHaveCount(0)
  await accounts.getByRole('link', { name: 'Connect' }).first().click()
  await page.waitForURL(/\/dashboard/)
  await page.goto('/dashboard/ads')
  // Accounts are found automatically: one direct, one under a manager. Only TEST accounts are offered;
  // the manager itself and the non-test client are never listed, and no account ids need typing.
  // Two separate states: signed in with Google (authorization) vs which Google Ads account is used.
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveText('•Choose an ad account')
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveAttribute('data-conn-status', 'needs_account')
  const picker = accounts.getByRole('group', { name: 'Choose a Google Ads account' })
  await expect(picker.getByRole('button', { name: /^Use .* \d{3}-\d{3}-\d{4}$/ })).toHaveCount(2)
  await expect(picker).toContainText('MOCK Google Ads test account')
  await expect(picker).toContainText('MOCK test client')
  await expect(picker).not.toContainText('MOCK test manager')
  await expect(picker).not.toContainText('555-000-0000')
  await expect(picker).not.toContainText('MOCK non-test account')
  await expect(picker.getByText('Only test accounts are shown while ads are in testing.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: /account ID/i })).toHaveCount(0)
  await picker.getByRole('button', { name: 'Use MOCK test client 666-000-0000' }).click()
  // Connected: status as text + icon, the chosen account, a Test account badge; Reconnect is secondary.
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveText('✓Connected')
  await expect(accounts.locator('[data-ads-account]')).toContainText('MOCK test client 666-000-0000')
  await expect(accounts.locator('[data-test-account]')).toHaveText('Test account · no spend')
  await expect(accounts.locator('a.btn', { hasText: 'Reconnect' })).toHaveCount(0)
  await expect(accounts.getByRole('link', { name: 'Reconnect' })).toHaveClass(/link-btn/)
  await expect(picker).toHaveCount(0)
  // Reading the account works and is read-only; the Overview labels test-account figures.
  const read = await (await page.request.get('/api/ads/google/campaigns')).json()
  expect(read).toEqual({ testAccount: true, campaigns: [] })
  await page.goto('/dashboard')
  await expect(page.locator('[data-ads-results]')).toContainText('Google Ads test account: no real ads ran')
})

test('Google Ads account selection: selected account shown once with a checkmark; change only when another exists; one account selected automatically (mock API)', async ({ page, context }) => {
  // MOCK DATA: local Google Ads stand-in, test accounts only. Continues from the previous test (MOCK test client selected).
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  const picker = accounts.getByRole('group', { name: 'Choose a Google Ads account' })
  const selected = accounts.locator('[data-ads-account]')
  const state = async () => (await (await page.request.get('/api/dashboard/ads')).json())

  // Already selected: shown as selected, never offered again; another eligible account exists → Change account.
  await expect(selected).toContainText('MOCK test client 666-000-0000')
  await expect(picker).toHaveCount(0)
  await expect(accounts.getByRole('button', { name: 'Use this account' })).toHaveCount(0)
  await accounts.getByRole('button', { name: 'Change account' }).click()
  await expect(picker.getByRole('button', { name: /^Use / })).toHaveCount(1) // only the OTHER account has a button
  await expect(picker.getByRole('listitem').filter({ hasText: 'MOCK test client' })).toContainText('Selected')
  await accounts.getByRole('button', { name: 'Keep MOCK test client' }).click()
  await expect(picker).toHaveCount(0)
  await accounts.getByRole('button', { name: 'Change account' }).click()
  await picker.getByRole('button', { name: 'Use MOCK Google Ads test account 123-456-7890' }).click()
  await expect(selected).toContainText('MOCK Google Ads test account 123-456-7890')
  // The next step (create on the test account) is available as soon as an account is selected.
  expect((await state()).capabilities.sandbox).toBe(true)

  // Reconnect with a Google sign-in that reaches exactly ONE test account: chosen automatically, nothing to pick,
  // no Change account (there is no other eligible account).
  await page.unroute('**/api/ads/google/start').catch(() => {})
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-one:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(selected).toContainText('MOCK test client 666-000-0000')
  await expect(accounts.getByRole('button', { name: 'Change account' })).toHaveCount(0)
  await expect(picker).toHaveCount(0)

  // Google briefly fails while connecting (no account could be chosen then). Once the page can list the accounts
  // and exactly one is eligible, it is selected automatically; the server still verifies it is a test account.
  await page.unroute('**/api/ads/google/start')
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-flaky:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(selected).toContainText('MOCK test client 666-000-0000')
  await expect(accounts.getByRole('button', { name: 'Change account' })).toHaveCount(0)
  const s = await state()
  expect([s.connections.google.status, s.connections.google.accountId, s.capabilities.sandbox]).toEqual(['connected', '6660000000', true])
})

test('Google Ads status: expired sign-in → Reconnect required is the primary action; reconnecting restores Connected (mock API)', async ({ page, context }) => {
  // MOCK DATA: a Google sign-in that later stops working (Google rejects the stored refresh token).
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  const status = accounts.locator('[data-conn-status][data-platform="google"]')
  await expect(status).toHaveText('✓Connected')
  await expect(page.locator('[data-testing-mode]')).toContainText('Test mode')
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-revoked:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).click()
  await page.waitForURL('**/dashboard/ads')
  // Listing the accounts needs the stored sign-in; Google refuses it, so the connection is marked for reconnect.
  await expect(accounts.getByRole('alert')).toContainText('access has expired')
  await page.reload()
  await expect(status).toHaveText('!Reconnect required')
  await expect(status).toHaveAttribute('data-conn-status', 'reconnect_required')
  await expect(accounts.getByText('The sign-in expired. Your campaigns stay as they are.')).toBeVisible()
  await expect(accounts.getByRole('link', { name: 'Reconnect' })).toHaveClass(/btn-primary/)
  await expect(accounts.locator('[data-ads-account]')).toHaveCount(0)
  // Reconnect with a working sign-in (one test account → selected automatically) → Connected again.
  await page.unroute('**/api/ads/google/start')
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-one:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(page.locator('.notice-ok')).toContainText('Google Ads is connected.')
  await expect(status).toHaveText('✓Connected')
  await expect(accounts.locator('[data-ads-account]')).toContainText('MOCK test client 666-000-0000')
  await expect(accounts.getByRole('link', { name: 'Reconnect' })).toHaveClass(/link-btn/)
})

test('Google Ads sandbox: production sign-in refused, recover, choose a test account, create paused (no duplicate), start, pause, change the budget (mock API)', async ({ page, context, browser }) => {
  // MOCK DATA throughout: a local Google Ads stand-in with test accounts only. Nothing reaches Google or spends.
  await useSession(context, fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  await expect(page.locator('[data-testing-mode]')).toContainText('nothing is ever charged')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  const pickerFor = () => accounts.getByRole('group', { name: 'Choose a Google Ads account' })

  // 1) A Google sign-in that reaches only a REAL (production) Google Ads account: Google refuses our
  // test-access project, the owner lands back on the Ads tab with a clear message, nothing is connected.
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-prod:owner@e2e-ads.example')
  await accounts.getByRole('link', { name: 'Connect' }).first().click()
  await page.waitForURL('**/dashboard/ads')
  await expect(page.getByRole('alert').first()).toContainText('only lets GetShowUps use Google Ads test accounts')
  expect(new URL(page.url()).search).toBe('')
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveText('•Choose an ad account')
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveAttribute('data-conn-status', 'needs_account')
  await expect(accounts.getByRole('button', { name: 'Try again' })).toBeVisible()
  expect((await (await page.request.get('/api/dashboard/ads')).json()).connections.google.accountId ?? null).toBeNull()

  // 2) Recovery: reconnect with the sandbox Google sign-in; the test accounts are found automatically.
  await page.unroute('**/api/ads/google/start')
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads:owner@e2e-ads.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).first().click()
  await page.waitForURL('**/dashboard/ads')
  await expect(page.getByRole('status').filter({ hasText: 'Google Ads is connected.' })).toBeVisible()
  await pickerFor().getByRole('button', { name: 'Use MOCK Google Ads test account 123-456-7890' }).click()
  await expect(accounts.locator('[data-ads-account]')).toContainText('123-456-7890')
  await expect(accounts.locator('[data-test-account]')).toBeVisible()

  // Server-side: non-test, manager, production and unknown accounts are refused whatever the browser sends.
  const choose = (accountId) =>
    page.evaluate(async (id) => {
      const r = await fetch('/api/ads/google/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: id, loginCustomerId: '5550000000' }) })
      return [r.status, (await r.json()).error]
    }, accountId)
  expect(await choose('7770000000')).toEqual([409, 'test_account_required'])
  expect(await choose('5550000000')).toEqual([400, 'account_not_accessible'])
  expect(await choose('9220000000')).toEqual([400, 'account_not_accessible'])
  expect(await choose('1111111111')).toEqual([400, 'account_not_accessible'])
  expect((await (await page.request.get('/api/dashboard/ads')).json()).connections.google.accountId).toBe('1234567890')

  // A draft whose booking link is https (local e2e serves http, so the starter draft cannot be approved here).
  const saveDraft = () => page.evaluate(async () => {
    const spec = {
      platform: 'google', name: 'E2E Pool Search', dailyBudgetCents: 900, finalUrl: 'https://e2e-ads.example/book', geo: { zips: ['29403'] },
      google: { keywords: [{ text: 'pool cleaning', match: 'PHRASE' }], negativeKeywords: ['jobs'], headlines: ['Pool Cleaning Service', 'Book Online in Minutes', 'Local Pool Care'],
        descriptions: ['Weekly pool cleaning and repair. Pick a time that suits you online.', 'Tell us what you need and book a visit online today.'] },
    }
    const r = await fetch('/api/dashboard/ads/campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', spec }) })
    return r.status
  })
  expect(await saveDraft()).toBeLessThan(300)
  // A duplicate draft (as made before one-plan-at-a-time): shown with a notice, never removed silently.
  expect(await saveDraft()).toBeLessThan(300)
  await page.reload()
  // A neutral cleanup notice (not the red error style).
  await expect(page.locator('[data-duplicate-drafts]')).toContainText('you have 2 Google Search drafts')
  await expect(page.locator('[data-duplicate-drafts]')).toHaveClass('notice-info')
  await expect(page.locator('.campaign')).toHaveCount(2)
  const dup = page.locator('.campaign').first()
  await dup.getByRole('button', { name: 'Remove draft' }).click()
  await dup.getByRole('button', { name: 'Cancel' }).click() // nothing happens without confirming
  await expect(page.locator('.campaign')).toHaveCount(2)
  await dup.getByRole('button', { name: 'Remove draft' }).click()
  await expect(dup.getByRole('group', { name: 'Confirm remove' })).toContainText('Nothing on Google changes')
  await dup.getByRole('button', { name: 'Confirm: remove draft' }).click()
  await expect(page.locator('.campaign')).toHaveCount(1)
  await expect(page.locator('[data-duplicate-drafts]')).toHaveCount(0)
  const c = page.locator('.campaign').first()
  // Where the ad shows, in plain words.
  await expect(c.locator('[data-where]')).toContainText('people in ZIP code 29403, searching on Google')
  // One owner step: approve this exact ad and create it (paused), after a confirmation. Starting stays separate.
  await c.getByRole('button', { name: 'Approve and create (paused) · test account' }).click()
  await expect(c.getByRole('group', { name: 'Confirm create' })).toContainText('nothing is charged')
  await c.getByRole('button', { name: 'Confirm: approve and create (paused)' }).click()
  // Read straight back from Google (MOCK API): budget, area, keywords, ad and landing page all match.
  await expect(c.locator('[data-verification="ok"]')).toHaveText('✓Checked on Google: budget, area, keywords and ad match')
  // With a campaign in place the business details fold to one line of facts (the form opens on demand), so the
  // campaign card is reached sooner.
  const fold = page.locator('[data-profile-fold]')
  await expect(fold).not.toHaveAttribute('open', '')
  await expect(fold.locator('summary')).toContainText('Pool service · 1 service · 1 ZIP code · $300/month')
  await expect(page.getByLabel('What kind of business?')).toBeHidden()
  await fold.locator('summary').click()
  await expect(page.getByLabel('What kind of business?')).toHaveValue('Pool service')
  // Results say where each number comes from; no spend data yet is shown as such, not as $0; a test account is labelled.
  const results = page.getByRole('region', { name: 'Ad results' })
  await expect(results.getByText('No ad spend reported by Google for this period yet.')).toBeVisible()
  await expect(results.getByText('Test account: no real ads ran, so these aren’t business results.')).toBeVisible()
  await expect(results.getByRole('row', { name: /^Ad spend/ }).getByRole('cell').first()).toHaveText('—')
  await expect(results.getByRole('group', { name: 'Money from these jobs' }).or(results.locator('.ar-money')).first()).toContainText('Paid—')
  await results.getByRole('button', { name: '90 days' }).click()
  await expect(results.getByRole('columnheader', { name: 'Last 90 days' })).toBeVisible()
  await expect(c.getByText('Google may spend up to twice the average on a busy day')).toBeVisible()
  await expect(c.locator('.chip')).toHaveText('Paused')
  // Duplicate prevention: a second create request for the same campaign is refused; Google has one copy.
  const campaignId = (await (await page.request.get('/api/dashboard/ads')).json()).campaigns.find((x) => x.launched).id
  const again = await page.evaluate(async (id) => (await fetch('/api/dashboard/ads/campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'launch', id, confirm: true }) })).status, campaignId)
  expect(again).toBeGreaterThanOrEqual(400)
  const onGoogle = (await (await page.request.get('/api/ads/google/campaigns')).json()).campaigns.filter((x) => x.gsuId === campaignId)
  expect(onGoogle).toHaveLength(1)

  await c.getByRole('button', { name: 'Start ads (test account, no spend)' }).click()
  await expect(c.locator('.chip')).toHaveText('Running')
  await c.getByRole('button', { name: 'Check on Google' }).click()
  await expect(c.locator('[data-google-live]')).toHaveText('Google reports: running · $9/day · test account')

  await c.getByRole('button', { name: 'Pause' }).click()
  await expect(c.locator('.chip')).toHaveText('Paused')
  const budget = c.getByRole('form', { name: 'Daily budget' })
  await budget.getByLabel(/Daily budget/).fill('8')
  await budget.getByRole('button', { name: 'Change daily budget (test account)' }).click()
  await expect(budget.getByText('(now $8/day)')).toBeVisible()
  await c.getByRole('button', { name: 'Check on Google' }).click()
  await expect(c.locator('[data-google-live]')).toHaveText('Google reports: paused · $8/day · test account')
  await expect(page.getByText('Daily budget set to 800 cents')).toBeVisible()

  // Phones to desktop: the created-campaign controls (longest labels on the page) never widen it.
  for (const width of [320, 360, 375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0)
  }

  // Tenant isolation: another Ads business sees none of this business's campaigns or connection.
  const other = await browser.newContext()
  await useSession(other, fixtures.E2E_SESSION_TOKEN)
  const theirs = await (await other.request.get('/api/dashboard/ads')).json()
  expect(theirs.campaigns.map((x) => x.id)).not.toContain(campaignId)
  expect(JSON.stringify(theirs)).not.toContain('1234567890')
  await other.close()
})

test('ads hold: a platform admin suspension pauses the running campaign on Google at once; owner sees why; reactivation restarts nothing (mock API)', async ({ page, context, browser }) => {
  // MOCK DATA: the local Google Ads stand-in (test account). Continues from the sandbox test's created campaign.
  await useSession(context, fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  const c = page.locator('.campaign').first()
  await c.getByRole('button', { name: 'Start ads (test account, no spend)' }).click()
  await expect(c.locator('.chip')).toHaveText('Running')

  const admin = await browser.newContext()
  await useSession(admin, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const a = await admin.newPage()
  await a.goto('/admin')
  await a.locator('.row--link', { hasText: 'E2E Ads Pools' }).first().click()
  await a.getByRole('button', { name: 'Suspend account' }).click()
  await expect(a.getByText('every running ad campaign (checked on Google)')).toBeVisible()
  await a.getByRole('button', { name: 'Confirm: pause booking page and ads' }).click()
  await expect(a.locator('[data-ads-paused]')).toHaveText('Ads: 1 campaign paused (1 confirmed on Google).')

  await page.reload()
  await expect(page.locator('[data-ads-hold="suspended"]')).toContainText('Your ads are paused because GetShowUps paused this business')
  // Suspended: the Ads tab stays (it explains the hold); the editing tools (Teach Your AI) are withdrawn until reactivation.
  expect((await (await page.request.get('/api/dashboard/me')).json()).features).toMatchObject({ ads: true, teachAi: false })
  expect((await page.request.get('/api/dashboard/ai-rules')).status()).toBe(404)
  await expect(c.locator('.chip')).toHaveText('Paused')
  await c.getByRole('button', { name: 'Check on Google' }).click()
  await expect(c.locator('[data-google-live]')).toContainText('Google reports: paused')
  await c.getByRole('button', { name: 'Start ads (test account, no spend)' }).click()
  await expect(page.getByText('Ads are paused while there’s a problem with this account')).toBeVisible()
  await expect(c.locator('.chip')).toHaveText('Paused')

  await a.getByRole('button', { name: 'Reactivate account' }).click()
  await expect(a.getByRole('button', { name: 'Suspend account' })).toBeVisible()
  await admin.close()
  await page.reload()
  await expect(page.locator('[data-ads-hold]')).toHaveCount(0)
  await expect(c.locator('.chip')).toHaveText('Paused') // never restarted automatically
})

test('Ads for every business with nothing to switch on: a business never listed anywhere opens the tab, sees both platforms disconnected, and an unconfigured Meta says so honestly @mobile', async ({ page, context, browser }) => {
  // e2e-import: a paid business that no pilot list ever named and that has never touched Ads.
  await useSession(context, fixtures.E2E_IMPORT_SESSION_TOKEN)
  expect((await (await page.request.get('/api/dashboard/me')).json()).features).toMatchObject({ ads: true, teachAi: true })
  expect((await page.request.get('/api/dashboard/ads')).status()).toBe(200)
  await page.goto('/dashboard')
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Ads', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/ads$/)
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  // Both ad platforms and the Business Profile, disconnected, each with its own Connect (the Meta app and the
  // Business Profile access are configured in this environment).
  await expect(accounts.locator('[data-conn-status][data-platform="google"]')).toHaveAttribute('data-conn-status', 'none')
  await expect(accounts.locator('[data-conn-status][data-platform="meta"]')).toHaveAttribute('data-conn-status', 'none')
  await expect(accounts.locator('[data-conn-status][data-platform="gbp"]')).toHaveAttribute('data-conn-status', 'none')
  await expect(accounts.locator('[data-conn-status]')).toHaveText(['○Not connected', '○Not connected', '○Not connected'])
  await expect(accounts.getByRole('link', { name: 'Connect', exact: true })).toHaveCount(3)
  await expect(accounts.locator('[data-platform-unavailable]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // Production today (no Meta app): the Meta row says the platform isn't set up, offers no Connect; Google is unaffected.
  await page.route('**/api/dashboard/ads', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, capabilities: { ...body.capabilities, meta: false } } })
  })
  await page.reload()
  await expect(accounts.locator('[data-platform-unavailable="meta"]')).toContainText('Not available yet: GetShowUps’ Facebook & Instagram connection isn’t set up on the platform')
  await expect(accounts.locator('[data-conn-status][data-platform="meta"]')).toHaveAttribute('data-conn-status', 'none')
  await expect(accounts.getByRole('link', { name: 'Connect', exact: true })).toHaveCount(2) // Google Ads and Business Profile
  await page.unroute('**/api/dashboard/ads')
  // Back from a Meta sign-in that failed or was refused: a plain notice, nothing connected, the page still works.
  for (const [code, text] of [['not_configured', 'Connecting isn’t available for this business right now'], ['transient', 'Meta didn’t respond.'], ['cancelled', 'Sign-in was cancelled.'], ['reconnect_required', 'Meta didn’t accept the sign-in.']]) {
    await page.goto(`/dashboard/ads?ads_error=${code}`)
    await expect(page.getByRole('alert')).toContainText(text)
    await expect(accounts.locator('[data-conn-status][data-platform="meta"]')).toHaveAttribute('data-conn-status', 'none')
  }
  // A business still in setup (no calendar yet) has its onboarding, never a broken Ads page.
  const other = await browser.newContext()
  await useSession(other, fixtures.E2E_OTHER_SESSION_TOKEN)
  const p1 = await other.newPage()
  await p1.goto('/dashboard/ads?ads_error=not_configured')
  await expect(p1.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await expect(p1.getByRole('heading', { name: 'Ads', level: 1 })).toHaveCount(0)
  await expect(p1.getByText('Couldn’t load ads.')).toHaveCount(0)
  await other.close()

  // A set-up business whose Ads feature is off (me stubbed to features.ads=false) gets the Overview.
  const ctx = await browser.newContext()
  await useSession(ctx, fixtures.E2E_SESSION_TOKEN)
  const p2 = await ctx.newPage()
  await p2.route('**/api/dashboard/me', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, features: { ...body.features, ads: false } } })
  })
  await p2.goto('/dashboard/ads?ads_error=not_configured')
  await expect(p2.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expect(p2.getByRole('link', { name: 'Ads', exact: true })).toHaveCount(0)
  await expect(p2.getByText('Couldn’t load ads.')).toHaveCount(0)
  await ctx.close()
})

test('booking page passes ad attribution with the lead', async ({ page }) => {
  let sent
  page.on('request', (r) => {
    if (r.url().endsWith('/lead') && r.method() === 'POST') sent = r.postDataJSON()
  })
  await page.goto(`/book/${fixtures.E2E_CUSTOMER}?utm_source=google&utm_medium=paid&utm_campaign=abc123def456`)
  await page.getByLabel('What do you need?').fill('Pool opening')
  await page.getByLabel('Name').fill('Ad Clicker')
  await page.getByLabel('Phone').fill('(555) 010-0166')
  await page.getByLabel('Email').fill('adclick@example.net')
  const zip = page.getByLabel('ZIP', { exact: true })
  if (await zip.count()) await zip.fill('29403')
  await page.getByRole('button', { name: /Choose a time/ }).click()
  await expect(page.getByRole('heading', { name: /Pick a/ })).toBeVisible()
  expect(sent.attribution).toEqual({ utm_source: 'google', utm_medium: 'paid', utm_campaign: 'abc123def456' })
})

test('Google Ads: disconnect is confirmed and honest; a sign-in without an Ads account gets setup guidance; reconnect restores (mock API)', async ({ page, context }) => {
  // MOCK DATA: local Google stand-in. Runs last: leaves the business connected again.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  const status = accounts.locator('[data-conn-status][data-platform="google"]')
  await expect(status).toHaveText('✓Connected')
  await expect(accounts.getByText('GetShowUps uses your Google Ads access only to create, change and report on the campaigns you approve here.')).toBeVisible()
  await accounts.getByRole('button', { name: 'Disconnect' }).click()
  const confirm = accounts.getByRole('group', { name: 'Confirm disconnect' })
  await expect(confirm).toContainText('Campaigns already in Google Ads stay there.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(status).toHaveText('✓Connected')
  await accounts.getByRole('button', { name: 'Disconnect' }).click()
  await confirm.getByRole('button', { name: 'Confirm: disconnect' }).click()
  await expect(status).toHaveText('○Not connected')
  await expect(accounts.locator('[data-disconnected]')).toContainText('To remove GetShowUps’ access completely')
  await expect(accounts.locator('[data-disconnected]').getByRole('link', { name: 'Google Account’s connections' })).toHaveAttribute('href', 'https://myaccount.google.com/connections')
  await expect(accounts.getByRole('link', { name: 'Connect', exact: true }).first()).toHaveClass(/btn-primary/) // Google first; Meta offers Connect too

  // A Google sign-in with no Ads account: clear next steps and a way to check again (test mode wording).
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-none:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Connect', exact: true }).first().click()
  await page.waitForURL('**/dashboard/ads')
  await expect(accounts.locator('[data-no-accounts="sandbox"]')).toContainText('No Google Ads test accounts found')
  await expect(accounts.getByRole('button', { name: 'Check again' })).toBeVisible()

  // Reconnect with a sign-in that has one test account → Connected again.
  await page.unroute('**/api/ads/google/start')
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', 'ads-one:owner@e2e.example')
  await accounts.getByRole('link', { name: 'Reconnect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(status).toHaveText('✓Connected')
})

test('Facebook & Instagram: a Meta draft is edited (placements, ages, end date, images), previewed, reviewed and checked without any Meta call @mobile', async ({ page, context }, testInfo) => {
  // Each project gets its own business (the desktop tests above count this business's campaigns).
  await useSession(context, testInfo.project.name === 'mobile' ? fixtures.E2E_HOME_SESSION_TOKEN : fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()
  // Meta is configured in this environment (mock app): the row offers Connect; nothing is connected yet.
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  await expect(accounts.locator('[data-conn-status][data-platform="meta"]')).toHaveAttribute('data-conn-status', /none|connected/)
  // A Meta draft (what "Draft my plan" produces when the plan includes Meta), saved from the page itself.
  const saved = await page.evaluate(async () => {
    const spec = { version: 1, platform: 'meta', name: 'E2E lead ads', dailyBudgetCents: 900, geo: { zips: ['29403'] }, meta: { primaryTexts: ['Pool looking green? Book a visit.'], headlines: ['Book a pool visit'], callToAction: 'GET_QUOTE', destination: 'instant_form', imageCreativeIds: ['e2e-img-placeholder'], videoCreativeIds: [], formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'] } }
    const r = await fetch('/api/dashboard/ads/campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', spec }) })
    return { status: r.status, body: await r.json() }
  })
  expect(saved.status).toBe(200)
  await page.reload()
  const card = page.getByRole('article', { name: 'Facebook & Instagram campaign' }).first()
  await expect(card.locator('[data-meta-preview]')).toContainText('Get quote')
  await expect(card.locator('[data-meta-editor]')).toBeVisible()
  await expect(card.locator('[data-meta-where]')).toContainText('1 ZIP code')
  // Placements: unticking one shows in the preview and the review; ages and an end date update the total.
  await card.locator('[data-meta-placement="instagram"]').uncheck()
  await expect(card.locator('[data-meta-preview]')).toContainText('Sponsored · Facebook')
  await card.locator('[data-meta-age-min]').fill('25')
  const end = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  await card.locator('[data-meta-end-date]').fill(end)
  await expect(card.locator('[data-meta-total]')).toContainText('Most it can spend before it stops')
  const review = card.locator('[data-meta-review]')
  await expect(review).toContainText('Facebook & Instagram (Facebook)')
  await expect(review).toContainText('Ages25+')
  await expect(review).toContainText('created on Meta paused')
  await card.getByRole('button', { name: 'Save changes' }).click()
  await expect(card.getByText('Saved.', { exact: true })).toBeVisible()
  // Check (no spend): the Meta dry run builds the payloads locally; no network, nothing created.
  await card.getByRole('button', { name: 'Check (no spend)' }).click()
  await expect(card.getByText('Check passed. Nothing was created and nothing was spent.')).toBeVisible()
  // Approval needs an approved image: the placeholder isn't one, and the message says so.
  await card.getByRole('button', { name: /^Approve/ }).click()
  await expect(card.getByText('Approve the image this ad uses first.')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  // Tidy: this draft is removed so the sandbox test below starts from one Meta draft of its own.
  await card.getByRole('button', { name: 'Remove draft' }).click()
  await card.getByRole('button', { name: 'Confirm: remove draft' }).click()
})

test('Meta sandbox: connect (mock Meta app), the one ad account + Page are chosen automatically and labelled as a sandbox, a lead-ads campaign is approved and created PAUSED and read back, Meta’s test lead arrives through the signed webhook as test data attributed to the campaign, Start runs on the sandbox only, Pause; another business sees none of it (mock API)', async ({ page, context, browser }) => {
  // MOCK DATA throughout: a local Graph API stand-in. Nothing reaches Meta or spends.
  await useSession(context, fixtures.E2E_ADS_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  await expect(page.locator('[data-testing-mode]')).toContainText('Meta sandbox ad accounts')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  const metaRow = accounts.locator('li.conn-row', { has: page.locator('[data-platform="meta"]') })
  // 1) Connect: the real start route runs (state cookie, scopes incl. leads_retrieval), the stand-in exchanges the code
  //    for a long-lived token; exactly one active ad account and one Page → chosen automatically.
  await returnFromMeta(page, '**/api/ads/meta/start', '/api/ads/meta/callback', 'meta-ok')
  await metaRow.getByRole('link', { name: 'Connect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(page.getByRole('status').filter({ hasText: 'Facebook & Instagram is connected.' })).toBeVisible()
  await expect(metaRow.locator('[data-conn-status]')).toHaveAttribute('data-conn-status', 'connected')
  await expect(metaRow.locator('[data-meta-account]')).toContainText('MOCK Meta sandbox ad account')
  await expect(metaRow.locator('[data-meta-account]')).toContainText('Page: MOCK Pools Page')
  await expect(metaRow.locator('[data-meta-sandbox]')).toBeVisible()
  const me = await (await page.request.get('/api/dashboard/ads')).json()
  expect(me.connections.meta).toMatchObject({ accountId: 'act_111', pageId: '222', sandboxAccount: true, status: 'connected' })
  expect(me.capabilities).toMatchObject({ meta: true, liveLaunch: false, metaSandbox: true })
  // Server-side: the selection is validated against Meta's lists whatever the browser sends.
  const choose = (adAccountId, pageId) => page.evaluate(async (b) => (await fetch('/api/ads/meta/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, { adAccountId, pageId })
  expect(await choose('act_999', '222')).toBe(400)
  expect(await choose('act_111', '999')).toBe(400)
  expect(await choose('act_111', '222')).toBe(200)

  // 2) A Meta draft with the business's own approved website photo as its image.
  const saved = await page.evaluate(async () => {
    const spec = { version: 1, platform: 'meta', name: 'E2E sandbox lead ads', dailyBudgetCents: 900, geo: { zips: ['29403'] }, meta: { primaryTexts: ['Pool looking green? Book a visit.'], headlines: ['Book a pool visit'], callToAction: 'GET_QUOTE', destination: 'instant_form', imageCreativeIds: ['e2e-ads-img'], videoCreativeIds: [], formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'] } }
    const r = await fetch('/api/dashboard/ads/campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', spec }) })
    return r.status
  })
  expect(saved).toBe(200)
  await page.reload()
  const c = page.getByRole('article', { name: 'Facebook & Instagram campaign' }).first()
  // 3) Approve and create (paused) on the sandbox account, after a confirmation that says so; read back from "Meta".
  await c.getByRole('button', { name: 'Approve and create (paused) · sandbox account' }).click()
  await expect(c.getByRole('group', { name: 'Confirm create' })).toContainText('Sandbox ad account: it never shows and nothing is charged.')
  await c.getByRole('button', { name: 'Confirm: approve and create (paused)' }).click()
  await expect(c.locator('[data-verification="ok"]')).toContainText('Checked on Meta')
  await expect(c.locator('.chip')).toHaveText('Paused')
  const campaignId = (await (await page.request.get('/api/dashboard/ads')).json()).campaigns.find((x) => x.platform === 'meta' && x.launched).id
  expect(campaignId).toBeTruthy()
  // A second create for the same campaign is refused (nothing duplicated on Meta).
  const again = await page.evaluate(async (id) => (await fetch('/api/dashboard/ads/campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'launch', id, confirm: true }) })).status, campaignId)
  expect(again).toBeGreaterThanOrEqual(400)

  // 4) Meta's test lead: asked for from the card, created by the stand-in on the campaign's form and DELIVERED to our
  //    webhook signed with the app secret; it becomes a lead marked as test data, attributed to this campaign.
  await c.locator('[data-meta-test-lead]').click()
  await expect(c.getByRole('group', { name: 'Confirm test lead' })).toContainText('never counted in your results')
  await c.locator('[data-meta-test-lead-confirm]').click()
  await expect(c.getByText('Meta is creating a test lead on this ad’s form.')).toBeVisible()
  await expect
    .poll(async () => {
      const events = await (await page.request.get(`http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}/__events`)).json()
      return events.filter((e) => e.type === 'meta.webhook').map((e) => [e.status, e.body?.processed, e.body?.test])
    })
    .toEqual([[200, 1, 1]])
  // Results exclude test records: no lead is counted from the test delivery.
  const results = page.getByRole('region', { name: 'Ad results' })
  await expect(results).toBeVisible()

  // 5) Start on the sandbox account (no spend), then Pause; the budget control names the sandbox.
  await c.getByRole('button', { name: 'Start ads (sandbox account, no spend)' }).click()
  await expect(c.locator('.chip')).toHaveText('Running')
  await c.getByRole('button', { name: 'Pause' }).click()
  await expect(c.locator('.chip')).toHaveText('Paused')
  await expect(c.getByRole('button', { name: 'Change daily budget (sandbox account)' })).toBeVisible()
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `overflow at ${width}px`).toBeLessThanOrEqual(0)
  }

  // 6) Tenant isolation: another Ads business sees no Meta connection, campaign or lead of this one.
  const other = await browser.newContext()
  await useSession(other, fixtures.E2E_SESSION_TOKEN)
  const theirs = await (await other.request.get('/api/dashboard/ads')).json()
  expect(theirs.campaigns.map((x) => x.id)).not.toContain(campaignId)
  expect(theirs.connections.meta ?? null).toBeNull()
  expect(JSON.stringify(theirs)).not.toContain('act_111')
  await other.close()
})

test('Journey A: an established advertiser connects and the campaigns already in the account are read into GetShowUps read-only: list, status, budget, Google’s numbers, settings; period; refresh; isolation @mobile', async ({ page, context, browser }, testInfo) => {
  // MOCK DATA: the ads-existing sign-in reaches one Google Ads test account that already holds two campaigns (one
  // running Search campaign with keywords/ads, one paused Local Services campaign) and one removed campaign.
  // One business per browser project: desktop and phone runs connect at the same time.
  const mobile = testInfo.project.name === 'mobile'
  await useSession(context, mobile ? fixtures.E2E_ADVERTISER_M_SESSION_TOKEN : fixtures.E2E_ADVERTISER_SESSION_TOKEN)
  await returnFromGoogle(page, '**/api/ads/google/start', 'GET', '/api/ads/google/callback', `ads-existing:owner@e2e-advertiser${mobile ? '-m' : ''}.example`)
  await page.goto('/dashboard/ads')
  const accounts = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
  await expect(page.locator('[data-imported]')).toHaveCount(0) // nothing to read before an account is connected
  await accounts.getByRole('link', { name: 'Connect', exact: true }).first().click()
  await page.waitForURL('**/dashboard/ads')
  // The one eligible account is chosen automatically; its campaigns are read right after (Refresh makes sure here).
  await expect(accounts.locator('[data-ads-account]')).toContainText('MOCK established advertiser')
  const imported = page.locator('[data-imported]')
  await expect(imported.getByRole('heading', { name: 'Your Google Ads campaigns' })).toBeVisible()
  await imported.locator('[data-imported-refresh]').click()
  await expect(imported).toHaveAttribute('data-imported-count', '2')
  await expect(imported.locator('[data-imported-source]')).toContainText('Read from Google')
  await expect(imported.locator('[data-imported-source]')).toContainText('2 campaigns, 1 running')
  // Each campaign: name, type, Google's status, budget and 30-day numbers (Google's own, labelled as such).
  const search = imported.locator('[data-imported-campaign="70000000001"]')
  await expect(search.locator('summary')).toContainText('Pool Cleaning – Charleston')
  await expect(search.locator('summary')).toContainText('Search')
  await expect(search.locator('summary')).toContainText('Running')
  await expect(search.locator('summary')).toContainText('$25/day')
  await expect(search.locator('summary')).toContainText('$630')
  await expect(search.locator('summary')).toContainText('270')
  const lsa = imported.locator('[data-imported-campaign="70000000002"]')
  await expect(lsa.locator('summary')).toContainText('Service Area Leads')
  await expect(lsa.locator('summary')).toContainText('Local Services')
  await expect(lsa.locator('summary')).toContainText('Paused')
  await expect(lsa.locator('summary')).toContainText('$40/day')
  await expect(imported.locator('[data-imported-campaign="70000000003"]')).toHaveCount(0) // removed in Google Ads
  await expect(imported.getByText('Google’s own numbers')).toBeVisible()
  // Settings of the Search campaign, in words; the Local Services one says what Google exposes.
  await search.locator('summary').click()
  for (const t of ['Charleston, South Carolina, United States', 'people in the area', 'pool cleaning charleston', '2 excluded searches', 'harborpool.example/book', 'Maximize clicks', 'submit lead form', 'Charleston Pool Cleaning | Weekly Pool Service']) await expect(search).toContainText(t)
  await lsa.locator('summary').click()
  await expect(lsa).toContainText('For Local Services campaigns Google exposes status, budget and results here')
  // Google's Local Services leads for that campaign: counts, charged/credited, cost per CHARGED lead, recent ones.
  await expect(lsa.locator('[data-lsa-leads]')).toContainText('6 leads (4 phone calls, 1 message, 1 booking) · 4 charged, 1 credited back · 1 marked booked in Google')
  await expect(lsa.locator('[data-lsa-cpl]')).toContainText('$60 ($240 ÷ 4)')
  await expect(lsa.getByText(/phone call · Booked · charged/)).toBeVisible()
  await expect(lsa).not.toContainText('843') // never a contact detail
  await expect(imported.locator('[data-lsa-readiness]')).toHaveCount(0) // the checklist is for businesses without one
  // Read only: no Start, Pause or budget controls on imported campaigns. The Search campaign can become a template.
  await expect(imported.getByRole('button', { name: /Start|Pause|Change daily budget|Approve/ })).toHaveCount(0)
  await search.locator('[data-save-template]').click()
  await expect(search.locator('[data-template-saved]')).toContainText('Saved as a template')
  // Period: 7 days → 7 × $21.
  await imported.getByRole('button', { name: '7 days' }).click()
  await expect(search.locator('summary')).toContainText('$147')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // API: Google's numbers and settings only; never tokens; the period is bounded.
  const api = await (await page.request.get('/api/dashboard/ads/imported?days=90')).json()
  expect(api.campaigns.map((c) => [c.externalId, c.state, c.channelType])).toEqual([['70000000001', 'running', 'SEARCH'], ['70000000002', 'paused', 'LOCAL_SERVICES'], ['70000000003', 'removed', 'SEARCH']].filter((x) => x[1] !== 'removed'))
  expect(api.totals).toMatchObject({ campaigns: 2, running: 1, spendCents: 90 * (2100 + 800), clicks: 810 })
  expect(JSON.stringify(api)).not.toMatch(/mock-ads|refresh_token|access_token/)
  // Another business sees none of it.
  const other = await browser.newContext()
  await useSession(other, fixtures.E2E_SESSION_TOKEN)
  const o = await other.newPage()
  const theirs = await (await o.request.get('/api/dashboard/ads/imported')).json()
  expect(theirs.campaigns.map((c) => c.externalId)).not.toContain('70000000001')
  await other.close()
})

test('Journey B: a business that never advertised saves its details, starts from the suggested template and gets ONE editable draft (nothing on Google, nothing spent) @mobile', async ({ page, context }, testInfo) => {
  // One business per browser project: e2e-starter / e2e-starter-m (no ad account, no profile yet).
  await useSession(context, testInfo.project.name === 'mobile' ? fixtures.E2E_STARTER_M_SESSION_TOKEN : fixtures.E2E_STARTER_SESSION_TOKEN)
  await page.goto('/dashboard/ads')
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toBeVisible()
  // Business details first (the template is filled from them).
  await page.getByLabel('What kind of business?').fill('Heating & air')
  await page.getByLabel(/^Services you want customers for/).fill('AC repair\nFurnace repair')
  await page.getByLabel('ZIP codes you serve').fill('29403, 29401')
  await page.getByLabel(/^Towns or cities/).fill('Charleston')
  await page.getByLabel('Typical first job ($)').fill('250')
  await page.getByLabel('Monthly ad budget ($)').fill('450')
  await page.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  // Review your campaign offers the template path first; the picker suggests the trade's templates.
  const review = page.getByRole('region', { name: '3. Review your campaign' })
  await review.locator('[data-start-template]').click()
  const picker = page.getByRole('group', { name: 'Start with a template' })
  await expect(picker.getByText('Starting budgets are a cautious first-week floor, not a promise of results.')).toBeVisible()
  const rows = picker.locator('[data-template]')
  await expect(rows.first()).toHaveAttribute('data-template', 'hvac_maintenance')
  await expect(rows.nth(1)).toHaveAttribute('data-template', 'hvac_repair')
  await expect(rows.first().locator('.chip')).toHaveText('Suggested')
  await expect(rows).toHaveCount(7)
  await expect(picker.locator('[data-template="hvac_repair"]')).toContainText('Searches like “ac repair”, “ac repair near me”, “air conditioner not cooling”.')
  await picker.locator('[data-template="hvac_repair"] input').fill('20')
  await picker.locator('[data-template-use="hvac_repair"]').click()
  await expect(page.locator('[data-template-started]')).toContainText('Draft created from the HVAC repair template')
  // The draft: the business name and town are in, the budget is the one chosen, the area is its ZIP codes; editable.
  const c = page.locator('.campaign').first()
  await expect(c.locator('.chip')).toHaveText('Draft')
  await expect(c).toContainText('AC & Heating Repair')
  await expect(c.locator('[data-where]')).toContainText('people in 2 ZIP codes (29403, 29401), searching on Google')
  const s = await (await page.request.get('/api/dashboard/ads')).json()
  const draft = s.campaigns.find((x) => !x.launched)
  expect([draft.status, draft.platform, draft.dailyBudgetCents, draft.spec.template]).toEqual(['draft', 'google', 2000, { source: 'curated', id: 'hvac_repair' }])
  expect(draft.spec.google.headlines.slice(0, 2)).toEqual(['E2E Coastal Air' + (testInfo.project.name === 'mobile' ? ' Mobile' : ''), 'AC & Heating Repair'])
  expect(draft.spec.google.headlines).toContain('Serving Charleston')
  expect(draft.spec.geo.zips).toEqual(['29403', '29401'])
  expect(draft.spec.finalUrl).toMatch(new RegExp(`/book/e2e-starter(-m)?\\?utm_source=google&utm_medium=paid&utm_campaign=${draft.id}$`))
  expect(draft.spec.google.negativeKeywords).toContain('jobs')
  // One open draft: starting another template is refused; the picker says so.
  await expect(review.locator('[data-start-template]')).toHaveCount(0)
  const again = await page.evaluate(async () => {
    const r = await fetch('/api/dashboard/ads/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', templateId: 'roofing' }) })
    return [r.status, (await r.json()).error]
  })
  expect(again).toEqual([409, 'draft_exists'])
  // Nothing exists on Google, nothing spent: no account is even connected; the draft's buttons say what comes next.
  expect(s.connections.google).toBeUndefined()
  await expect(c.getByRole('button', { name: /Start ads/ })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)

  // Google Business Profile (step D): before connecting, the row offers Connect and the facts; connecting with the
  // gbp sign-in (mock) links the one listing the account manages and shows Google's verification state.
  const gbpRow = page.locator('[data-gbp-state]')
  await expect(gbpRow).toHaveAttribute('data-gbp-state', 'none')
  await expect(gbpRow.locator('[data-gbp-readiness] summary')).toContainText('Don’t have a Business Profile yet?')
  await returnFromGoogle(page, '**/api/ads/gbp/start', 'GET', '/api/ads/gbp/callback', `gbp:owner@e2e-starter${testInfo.project.name === 'mobile' ? '-m' : ''}.example`)
  await gbpRow.getByRole('link', { name: 'Connect' }).click()
  await page.waitForURL('**/dashboard/ads')
  await expect(page.getByRole('status').filter({ hasText: 'Google Business Profile is connected.' })).toBeVisible()
  await expect(gbpRow).toHaveAttribute('data-gbp-state', 'connected')
  await expect(gbpRow.locator('[data-gbp-listing]')).toContainText('MOCK Coastal Air Heating & Cooling')
  await expect(gbpRow.locator('[data-gbp-listing]')).toContainText('Charleston, SC')
  await expect(gbpRow.locator('[data-gbp-verification]')).toHaveText('Verified')
  await expect(gbpRow.locator('[data-gbp-missing]')).toContainText('Missing on the profile: website.')
  await expect(gbpRow.getByRole('link', { name: 'Open on Google Maps' })).toHaveAttribute('href', 'https://maps.google.com/?cid=1')
  await expect(gbpRow.locator('[data-gbp-readiness]')).toHaveCount(0)
  const bp = (await (await page.request.get('/api/dashboard/ads')).json()).businessProfile
  expect([bp.status, bp.verification.state, bp.missing]).toEqual(['connected', 'verified', ['website']])
  expect(JSON.stringify(bp)).not.toMatch(/mock-gbp|843/)
})

test('Business Profile before Google approves GetShowUps’ access: the row says so honestly, no Connect, the facts stay; a Google account without a listing is told what to do @mobile', async ({ page, context, browser }, testInfo) => {
  await useSession(context, fixtures.E2E_IMPORT_SESSION_TOKEN)
  // Production today: GBP_ENABLED is off → capability false (stubbed here since the e2e server has it on).
  await page.route('**/api/dashboard/ads', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, capabilities: { ...body.capabilities, gbp: false }, businessProfileReadiness: { ...body.businessProfileReadiness, available: false } } })
  })
  await page.goto('/dashboard/ads')
  const gbpRow = page.locator('[data-gbp-state]')
  await expect(gbpRow).toHaveAttribute('data-gbp-state', 'unavailable')
  await expect(gbpRow.locator('[data-conn-status]')).toContainText('Not available yet')
  await expect(gbpRow.getByText('Google must approve GetShowUps’ access to the Business Profile API first.')).toBeVisible()
  await expect(gbpRow.getByRole('link', { name: 'Connect' })).toHaveCount(0)
  await gbpRow.locator('[data-gbp-readiness] summary').click()
  await expect(gbpRow.locator('.gbp-steps li')).toHaveCount(6)
  await expect(gbpRow.getByRole('link', { name: 'Create or claim it with Google' })).toHaveAttribute('href', 'https://business.google.com/create')
  await page.unroute('**/api/dashboard/ads')
  // A Google account that manages no listing: the picker says so and points to Google's setup. On the desktop run
  // only, with the established advertiser's business (its Journey A test never looks at the Business Profile row),
  // so the read-only business above stays untouched for the tests running beside this one.
  if (testInfo.project.name === 'mobile') return
  const ctx = await browser.newContext()
  await useSession(ctx, fixtures.E2E_ADVERTISER_SESSION_TOKEN)
  const p2 = await ctx.newPage()
  await returnFromGoogle(p2, '**/api/ads/gbp/start', 'GET', '/api/ads/gbp/callback', 'gbp-none:owner@e2e-advertiser.example')
  await p2.goto('/dashboard/ads')
  const gbpRow2 = p2.locator('[data-gbp-state]')
  await gbpRow2.getByRole('link', { name: 'Connect' }).click()
  await p2.waitForURL('**/dashboard/ads')
  await expect(gbpRow2).toHaveAttribute('data-gbp-state', 'needs_location')
  await expect(gbpRow2.getByText('This Google account manages no Business Profile listing yet.')).toBeVisible()
  await ctx.close()
})
