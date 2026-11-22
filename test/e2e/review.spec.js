// Business Review (/admin/review) in the browser: navigation, Platform view (journey, statuses, incidents, approvals,
// releases), Business view (search → one business, counts only), phones without horizontal scroll, and proof that a
// capability the UI has never seen renders from data alone (no UI change). Local workerd, mocked integrations.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const SHOTS = process.env.REVIEW_SHOTS_DIR // optional: save screenshots for visual review

test('founder opens Business Review: platform map, statuses with evidence, incidents, approvals, releases; then one business', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Business Review' }).click()
  await expect(page).toHaveURL(/\/admin\/review$/)
  await expect(page.getByRole('heading', { name: 'Business Review', level: 1 })).toBeVisible()
  // Every status in the legend, with counts that add up to the capabilities shown.
  const counts = await page.locator('[data-count]').allTextContents()
  const shown = await page.locator('[data-capability]').count()
  expect(counts.map(Number).reduce((a, b) => a + b, 0)).toBe(shown)
  expect(shown).toBeGreaterThan(20)
  // Real statuses from configuration + evidence (local e2e: Stripe test mode, Ads sandbox, deletion on locally).
  await expect(page.locator('[data-capability="billing.stripe"] [data-status]')).toHaveText('Sandbox only')
  await expect(page.locator('[data-capability="ads.google"] [data-status]')).toHaveText('Sandbox only')
  await expect(page.locator('[data-capability="lead.qualify"] [data-status]')).toHaveText('Not built')
  await expect(page.locator('[data-capability="conversations.claude"] [data-status]')).toHaveText('Not built')
  // Plain-language map: tiers with their blockers, groups with next steps, setup links into existing screens.
  const plain = page.locator('[data-plain-map]')
  await expect(plain.getByRole('heading', { name: 'What this means for operating' })).toBeVisible()
  await expect(plain.locator('[data-tier-ready]')).toBeVisible()
  await plain.locator('[data-tier-tab="all"]').click()
  expect(await plain.locator('[data-plain-cap]').count()).toBe(shown)
  await expect(plain.locator('[data-plain-group="works"] [data-plain-cap="platform.database"]')).toBeVisible()
  await expect(plain.locator('[data-plain-group="testable"] [data-plain-cap="billing.stripe"]')).toContainText('Test it with a test business')
  await expect(plain.locator('[data-plain-group="not_built"] [data-plain-cap="lead.qualify"]')).toBeVisible()
  await expect(plain.locator('[data-plain-action="calendar.google"]')).toHaveAttribute('href', '/dashboard/settings')
  await plain.locator('[data-tier-tab="advertising"]').click()
  await expect(plain.locator('[data-plain-cap="ads.google"]')).toBeVisible()
  await expect(plain.locator('[data-plain-cap="platform.database"]')).toHaveCount(0)
  await plain.locator('[data-tier-tab="operate"]').click()
  await page.locator('[data-capability="ads.google"] summary').click()
  await expect(page.locator('[data-capability="ads.google"]')).toContainText('Test access level')
  await expect(page.getByRole('heading', { name: 'Waiting on a decision' })).toBeVisible()
  await expect(page.locator('[data-migrations]')).toContainText('Migrations:')
  await expect(page.locator('[data-journey="signup"]')).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/review-platform-desktop.png`, fullPage: true })

  // Business view: search, open, counts only.
  await page.getByRole('tab', { name: 'Business' }).click()
  await page.getByLabel('Find a business').fill('E2E Ads')
  await page.getByRole('button', { name: 'E2E Ads Pools' }).click()
  await expect(page).toHaveURL(/business=e2e-ads/)
  const b = page.locator('[data-business="e2e-ads"]')
  await expect(b.locator('[data-funnel]')).toContainText('Show-up rate')
  await expect(b.locator('[data-business-capability="ads.google"]')).toBeVisible()
  await expect(b.locator('[data-business-capability="billing.stripe"]')).toContainText('active')
  expect(await b.textContent()).not.toMatch(/@example\.net|555-01/)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/review-business-desktop.png`, fullPage: true })

  // Phones: nothing wider than the screen.
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 })
    for (const tab of ['Business', 'Platform']) {
      await page.getByRole('tab', { name: tab }).click()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).slice(-4).map((e) => `${e.tagName}.${e.className}(${e.scrollWidth}>${e.clientWidth}): ${e.textContent.slice(0, 50)}`))
      expect(overflow, `${tab} overflow at ${width}px: ${wide.join(' | ')}`).toBeLessThanOrEqual(0)
    }
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/review-platform-mobile.png`, fullPage: true })
})

test('a capability the UI has never seen (e.g. a future AI responder) renders from data alone', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.route('**/api/platform/review', async (route) => {
    const res = await route.fetch()
    const r = await res.json()
    const future = {
      id: 'future.ai_responder',
      name: 'AI responder (future feature)',
      journey: 'lead',
      description: 'Answers new leads by text.',
      external: 'Some AI provider',
      dependsOn: ['conversations.control', 'messaging.sms'],
      status: 'built_tested',
      mode: 'live',
      note: 'Registered by a new module',
      approval: null,
      blockers: [],
      verification: { ok: false, at: null, evidence: 'No reply sent yet' },
      events: { lastSuccess: null, lastFailure: Date.now(), failures7: 2, total: 2 },
      openFailures: [{ at: Date.now(), action: 'ai.reply', details: { error: 'provider_timeout' } }],
      usedBy: [],
      blockedBy: ['messaging.sms'],
    }
    r.capabilities.push(future)
    r.journey.find((j) => j.id === 'lead').capabilities.push(future.id)
    r.counts.built_tested += 1
    await route.fulfill({ response: res, json: r })
  })
  await page.goto('/admin/review')
  const card = page.locator('[data-capability="future.ai_responder"]')
  await expect(card).toContainText('AI responder (future feature)')
  await expect(card).toContainText('1 problem') // open problems: expanded by default
  await expect(card.locator('[data-status]')).toHaveText('Built + tested')
  await expect(card).toContainText('No reply sent yet')
  await expect(card).toContainText('2 failures in 7 days')
  await expect(card).toContainText('1 unresolved failure')
  await expect(card.locator('.dep--blocked')).toContainText('Text messages')
})
