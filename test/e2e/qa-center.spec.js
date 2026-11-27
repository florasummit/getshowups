// QA Command Center (Control Center → QA), local workerd, fake credentials, nothing external. Covers the founder's
// acceptance criteria 1–10 at the UI level:
//  1 readiness on open · 2 one action to run all safe tests (plan first; refused with the exact setup steps while CI
//  dispatch isn't configured) · 3 an individual journey / test · 4 several flows without the whole platform ·
//  5 close the browser and come back to the same run · 6 a guided manual check without separate notes ·
//  7 a defect with evidence · 8 a retest that keeps the history · 9 when and against which release a test was
//  verified · 10 stale, missing and failed coverage. Plus the backlog ("Note an idea" never starts work) and phone width.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const noSideScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width))).toBeLessThanOrEqual(0)
// 1×1 transparent PNG (evidence upload).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const unique = (s) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// The first human check in the derived inventory (so the test follows the repo, not a hand-kept id).
async function firstHumanTest(page) {
  const r = await page.request.get('/api/platform/qa/inventory?class=human&detail=tests')
  expect(r.status()).toBe(200)
  const inv = await r.json()
  for (const a of inv.areas || []) for (const j of a.journeys || []) for (const f of j.features || []) for (const t of f.tests || []) if (t.class === 'human') return t
  throw new Error('no human test in the inventory')
}

test('overview: release readiness from records, counts with their totals, presets open a plan, setup steps listed (AC 1, 2, 10)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control')
  await page.locator('[data-nav="qa"]').click()
  await expect(page).toHaveURL(/view=qa/)
  const ov = page.locator('[data-qa-overview]')
  await expect(ov.getByRole('heading', { level: 1, name: 'QA' })).toBeVisible()
  await expect(page.locator('[data-qa-readiness]')).toContainText('Verified on the current release:')
  // Never a bare percentage: every count shows "n of total".
  const counts = page.locator('[data-count]')
  await expect(counts.first()).toBeVisible()
  for (const c of await counts.all()) await expect(c).toContainText(/ of \d+ \(\d+%\)|none recorded/)
  await expect(page.locator('[data-count="untested"]')).toBeVisible()
  await expect(page.locator('[data-count="failed"]')).toBeVisible()
  await expect(page.locator('[data-count="stale"]')).toBeVisible()
  await expect(ov.getByText('Production version')).toBeVisible()
  await expect(page.locator('[data-qa-spend]')).toContainText('Monthly QA budget')

  // 2. One action: "Run all safe tests" opens the plan (scope, where, time, cost, prerequisites) and never starts by itself.
  await page.locator('[data-preset="all_safe"]').click()
  const plan = page.locator('[data-plan]')
  await expect(plan.getByRole('heading', { name: /Before you run: Run all safe tests/ })).toBeVisible()
  await expect(plan.locator('[data-plan-facts]')).toContainText('Estimated duration')
  await expect(plan.locator('[data-plan-facts]')).toContainText('Estimated cost')
  await expect(plan.locator('[data-plan-scope]')).toHaveText(/\d+ tests?/)
  const runnable = await plan.getAttribute('data-plan-runnable')
  if (runnable === 'false') {
    // CI dispatch isn't configured here: the refusal says why, Start is disabled with a visible reason, and the
    // overview lists the exact missing steps from the API.
    await expect(plan.locator('[data-plan-start]')).toBeDisabled()
    await expect(plan.locator('[data-plan-refused], [data-plan-duplicate]')).toBeVisible()
    await expect(page.locator('[data-qa-setup-steps] li').first()).toBeVisible()
  }
  await plan.getByRole('button', { name: 'Cancel' }).click()
  await expect(plan).toHaveCount(0)
})

test('verify production: plan → start → close the browser → reopen the same run with its progress (AC 5)', async ({ page, context, browser, request }) => {
  test.setTimeout(60_000)
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control?view=qa')
  await page.locator('[data-preset="production_verify"]').click()
  const plan = page.locator('[data-plan]')
  await expect(plan.locator('[data-plan-facts]')).toContainText('Production (read-only)')
  const dup = plan.locator('[data-plan-duplicate]')
  if (await dup.isVisible().catch(() => false)) await dup.getByLabel('Run them again anyway').check()
  await expect(plan.locator('[data-plan-start]')).toBeEnabled()
  await plan.locator('[data-plan-start]').click()
  await expect(page).toHaveURL(/exec=qx_/)
  const execUrl = page.url()
  const exec = page.locator('[data-qa-exec]')
  await expect(exec).toBeVisible()
  await expect(exec.locator('[data-exec-progress]')).toContainText(/of \d+ done/)
  // Closing the browser loses nothing: the work runs on the server (cron), and a new browser sees the same run.
  await page.close()
  const r = await request.post('/api/cron/run', { headers: { Authorization: `Bearer ${fixtures.E2E_CRON_SECRET}` } })
  expect(r.status()).toBe(200)
  const ctx2 = await browser.newContext()
  await useSession(ctx2, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const p2 = await ctx2.newPage()
  await p2.goto(execUrl)
  await expect(p2.locator('[data-qa-exec]')).toBeVisible()
  await expect(p2.locator('[data-exec-progress]')).toContainText(/[1-9]\d* of \d+ done|of \d+ done/)
  await expect(p2.locator('[data-exec-events] li').first()).toBeVisible()
  // The run is listed under Runs, filterable by environment.
  await p2.goto('/admin/control?view=qa&tab=runs&env=production')
  await expect(p2.locator(`[data-exec="${execUrl.match(/exec=([^&]+)/)[1]}"]`)).toBeVisible()
  await ctx2.close()
})

test('tests: hierarchy, filters, one test, one journey, several branches at once; stale / untested / gaps visible (AC 3, 4, 9, 10)', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control?view=qa&tab=tests')
  const tests = page.locator('[data-qa-tests]')
  await expect(tests.getByRole('heading', { level: 1, name: 'Tests' })).toBeVisible()
  const areas = page.locator('.qa-tree--root > [data-kind="area"]')
  await expect(areas.first()).toBeVisible()
  // 10. Missing coverage is listed, never hidden.
  await expect(page.locator('[data-qa-gaps]')).toBeVisible()

  // Open the first area: its journeys and features appear, and its tests load.
  const first = areas.first()
  await first.locator('.qa-branch-toggle').first().click()
  const journey = first.locator('[data-kind="journey"]').first()
  await expect(journey).toBeVisible()
  await journey.locator('.qa-branch-toggle').first().click()
  const feature = journey.locator('[data-kind="feature"]').first()
  await feature.locator('.qa-branch-toggle').first().click()
  const leaf = feature.locator('[data-test-id]').first()
  await expect(leaf).toBeVisible()
  // An automated test to open later (it has a Run button).
  const runnable = page.locator('[data-test-id]:has(button[aria-label^="Run "])').first()
  const oneId = (await runnable.count()) ? await runnable.getAttribute('data-test-id') : await leaf.getAttribute('data-test-id')

  // 4. Several branches at once (not the whole platform): two areas → one selection → one plan.
  await areas.nth(0).locator('.qa-tree-check').first().check()
  await areas.nth(1).locator('.qa-tree-check').first().check()
  const bar = page.locator('[data-qa-selection]')
  await expect(bar).toBeVisible()
  const n = Number(await bar.getAttribute('data-qa-selection'))
  expect(n).toBeGreaterThan(1)
  await bar.locator('[data-run-selected]').click()
  const plan = page.locator('[data-plan]')
  await expect(plan.getByRole('heading', { name: new RegExp(`Before you run: ${n} selected tests`) })).toBeVisible()
  await expect(plan.locator('[data-plan-scope]')).toBeVisible()
  await plan.getByRole('button', { name: 'Close' }).click()
  await bar.getByRole('button', { name: 'Clear selection' }).click()
  await expect(bar).toHaveCount(0)

  // 3. One journey: "Run flow" plans exactly that journey.
  const flow = page.getByRole('button', { name: /^Run the .+ journey$/ }).first()
  await flow.click()
  await expect(plan.getByRole('heading', { name: /Before you run: Journey:/ })).toBeVisible()
  await plan.getByRole('button', { name: 'Close' }).click()

  // Filters are server-side and in the URL (reload keeps them).
  await page.getByLabel('Status').selectOption('untested')
  await expect(page).toHaveURL(/status=untested/)
  await expect(page.locator('[data-qa-matching]')).toContainText('match')
  await page.reload()
  await expect(page.getByLabel('Status')).toHaveValue('untested')
  for (const s of await page.locator('[data-test-id]').evaluateAll((els) => els.slice(0, 20).map((e) => e.getAttribute('data-status')))) expect(s).toBe('untested')

  // 3 + 9. One test's page: what it is, its status against the current release, its full history.
  await page.goto(`/admin/control?view=qa&test=${encodeURIComponent(oneId)}`)
  const detail = page.locator('[data-qa-test]')
  await expect(detail.locator('[data-test-status]').first()).toBeVisible()
  await expect(detail.locator('[data-last-pass]')).toContainText(/Last passed .+ on [0-9a-f]{7}|It has never passed\./)
  await expect(detail.getByRole('heading', { name: 'History' })).toBeVisible()
  if (await detail.locator('[data-run-test]').count()) {
    await detail.locator('[data-run-test]').click()
    await expect(page.locator('[data-plan]').locator('[data-plan-scope]')).toHaveText('1 test')
  }
  await page.goBack()
  await expect(page.locator('[data-qa-tests]')).toBeVisible()
})

test('manual check → defect with evidence → fixed → retest passes → verified, history kept (AC 6, 7, 8, 9)', async ({ page, context }) => {
  test.setTimeout(90_000)
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  const human = await firstHumanTest(page)
  // 6. Guided manual check: instructions, expected outcome, six result choices, observation.
  await page.goto(`/admin/control?view=qa&test=${encodeURIComponent(human.id)}`)
  const card = page.locator(`[data-manual="${human.id}"]`)
  await expect(card).toContainText('What to do')
  await expect(card).toContainText('Expected result')
  for (const s of ['Pass', 'Fail', 'Blocked', 'Skipped', 'Unverified', 'Retest required']) await expect(card.getByRole('radio', { name: s, exact: true })).toBeVisible()
  // A failure needs what happened (shown next to the form, nothing saved).
  await card.getByRole('radio', { name: 'Fail', exact: true }).check()
  await card.getByRole('button', { name: 'Save result' }).click()
  await expect(card.getByRole('alert')).toContainText('Say what happened')
  const observed = unique('Booked page showed no confirmation')
  await card.getByLabel(/What actually happened/).fill(observed)
  await card.getByRole('button', { name: 'Save result' }).click()
  const saved = card.locator('[data-manual-saved="fail"]')
  await expect(saved).toContainText('Earlier results are kept')
  // Evidence attaches to that result.
  await saved.getByLabel('File').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })
  await saved.getByRole('button', { name: 'Attach evidence' }).click()
  await expect(saved.getByRole('status')).toContainText('Evidence attached.')

  // 7. Record a defect from the failed result: linked to the test and the result.
  await saved.getByRole('link', { name: /Record a defect from this/ }).click()
  await expect(page).toHaveURL(/tab=defects.*from=/)
  const form = page.locator('[data-new-item="defects"]')
  await expect(form).toContainText('Linked to the test')
  const title = unique('Booking confirmation missing')
  await form.getByLabel('Title').fill(title)
  await form.getByLabel('Severity').selectOption('high')
  await form.getByLabel(/Steps to reproduce/).fill('1. Open the booking page\n2. Book a time')
  await form.getByRole('button', { name: 'Save defect' }).click()
  await expect(page).toHaveURL(/item=qi_/)
  const item = page.locator('[data-qa-item]')
  await expect(item.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(item).toHaveAttribute('data-item-status', 'open')
  await expect(item.locator('[data-evidence-list]')).toBeVisible()
  // A copyable Claude Code prompt built from the evidence.
  await item.locator('[data-show-prompt]').click()
  await expect(item.locator('[data-prompt-text]')).toHaveValue(/\S/)

  // Fixed (a PR is linked): still NOT verified; "verified" is not offered by hand.
  await item.getByLabel('Pull request').fill('204')
  await item.getByRole('button', { name: 'Save links' }).click()
  await expect(item.locator('[data-item-links]').getByRole('status')).toContainText('Links saved.')
  await expect(item.getByLabel('Status').locator('option[value="verified"]:not([disabled])')).toHaveCount(0)
  await item.getByLabel('Status').selectOption('fixed_pending_qa')
  await item.getByRole('button', { name: 'Save status' }).click()
  await expect(item.locator('[data-item-status-form]').getByRole('status')).toContainText('Status: Fixed, awaiting retest.')
  const itemUrl = page.url()

  // 8. Retest: a passing manual result after the fix verifies it; the earlier failure stays in the history.
  await page.goto(`/admin/control?view=qa&test=${encodeURIComponent(human.id)}`)
  const card2 = page.locator(`[data-manual="${human.id}"]`)
  await card2.getByRole('radio', { name: 'Pass', exact: true }).check()
  await card2.getByRole('button', { name: 'Save result' }).click()
  await expect(card2.locator('[data-manual-saved="pass"]')).toContainText('verified a defect')
  // 9. The test page says when and against which release it passed; both results are listed.
  await page.reload()
  await expect(page.locator('[data-last-pass]')).toContainText(/Last passed .+ on [0-9a-f]{7}/)
  const rows = page.locator('[data-qa-history-rows] [data-result]')
  await expect(rows.filter({ hasText: observed })).toHaveAttribute('data-result', 'fail')
  await expect(rows.first()).toHaveAttribute('data-result', 'pass')

  await page.goto(itemUrl)
  await expect(page.locator('[data-qa-item]')).toHaveAttribute('data-item-status', 'verified')
  await expect(page.locator('[data-item-history]')).toContainText('Recorded')
  await expect(page.locator('[data-retest-results]')).toBeVisible()
})

test('backlog: "Note an idea" from any QA screen lands in the Inbox; status changes are explicit and recorded', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control?view=qa&tab=runs')
  const idea = page.locator('[data-idea]')
  await idea.getByRole('button', { name: 'Note an idea' }).click()
  await idea.getByRole('button', { name: 'Save idea' }).click()
  await expect(idea.locator('.field-error')).toContainText('Give it a short title.')
  const title = unique('Plan dialog could remember the last environment')
  await idea.getByLabel('Kind').selectOption('ux')
  await idea.getByLabel('Title').fill(title)
  await idea.getByRole('button', { name: 'Save idea' }).click()
  await expect(idea.getByRole('status')).toContainText('Nothing starts until you plan it.')

  await page.locator('[data-qa-subnav="backlog"]').click()
  const row = page.locator('[data-item]').filter({ hasText: title })
  await expect(row).toHaveAttribute('data-item-status', 'inbox')
  await row.click()
  const item = page.locator('[data-qa-item]')
  await expect(item).toContainText('Nothing starts automatically.')
  await item.getByLabel('Status').selectOption('planned')
  await item.getByRole('button', { name: 'Save status' }).click()
  await expect(item.locator('[data-item-status-form]').getByRole('status')).toContainText('Status: Planned.')
  await expect(page.locator('[data-item-history]')).toContainText('Planned')
})

test('QA at phone width: overview, tests, manual and a plan fit with no sideways scroll @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control?view=qa')
  await expect(page.locator('[data-qa-readiness]')).toBeVisible()
  await noSideScroll(page)
  await page.locator('[data-preset="smoke"]').click()
  await expect(page.locator('[data-plan-facts]')).toBeVisible()
  // The plan's footer is sticky: Start (or the reason it can't start) is on screen without hunting for it.
  await page.locator('#qa-plan-h').scrollIntoViewIfNeeded()
  await expect(page.locator('[data-plan-start]')).toBeInViewport()
  await noSideScroll(page)
  await page.locator('[data-qa-subnav="tests"]').click()
  await expect(page.locator('.qa-tree--root')).toBeVisible()
  await page.locator('.qa-tree--root > [data-kind="area"] .qa-branch-toggle').first().click()
  await noSideScroll(page)
  await page.locator('[data-qa-subnav="manual"]').click()
  await expect(page.locator('[data-qa-manual]')).toBeVisible()
  await expect(page.locator('[data-qa-guided] [data-qa-journey]').first()).toBeVisible()
  await noSideScroll(page)
  await page.locator('[data-qa-subnav="defects"]').click()
  await page.locator('[data-new-item-open]').click()
  await expect(page.locator('[data-new-item="defects"]')).toBeVisible()
  await noSideScroll(page)
})
