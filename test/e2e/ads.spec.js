// Ads flow in the browser against the real Functions on local workerd: business details → starter
// plan (no AI key in e2e) → editable preview → budget approval → owner approval → non-spending check.
// Live launch stays disabled (ADS_LIVE_LAUNCH unset), so nothing can be created or spent.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle, useSession } from './helpers.js'

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
  await expect(adsRow.locator('.stat', { hasText: 'Cost per show-up' }).locator('.stat-value')).toHaveText('—')
  await expect(adsRow.getByText('no ad spend recorded')).toBeVisible()
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
  await expect(accounts.getByRole('link', { name: 'Connect', exact: true })).toHaveClass(/btn-primary/)
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
  await c.getByRole('button', { name: 'Approve' }).click()
  await expect(c.locator('.chip')).toHaveText('Approved')
  // Create asks for confirmation first (it starts paused; test account: never shows, nothing charged).
  await c.getByRole('button', { name: 'Create on Google (paused) · test account' }).click()
  await expect(c.getByRole('group', { name: 'Confirm create' })).toContainText('nothing is charged')
  await c.getByRole('button', { name: 'Confirm: create on Google (paused)' }).click()
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

test('per-business flag: a business not listed in ADS_BUSINESSES has no Ads tab and no Ads routes', async ({ page, context, browser }) => {
  await useSession(context, fixtures.E2E_OTHER_SESSION_TOKEN)
  expect((await (await page.request.get('/api/dashboard/me')).json()).features.ads).toBe(false)
  expect((await page.request.get('/api/dashboard/ads')).status()).toBe(404)
  expect((await page.request.get('/api/ads/google/campaigns')).status()).toBe(404)
  await page.goto('/dashboard')
  await expect(page.getByRole('link', { name: 'Ads', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-ads-results]')).toHaveCount(0)
  // Back from a refused ad sign-in (/dashboard/ads?ads_error=…): their normal dashboard, never a broken Ads page.
  await page.goto('/dashboard/ads?ads_error=not_configured')
  await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ads', level: 1 })).toHaveCount(0)
  await expect(page.getByText('Couldn’t load ads.')).toHaveCount(0)

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
