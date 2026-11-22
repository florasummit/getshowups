// Admin Console layout across client-side navigation (regression: /admin/voice-providers rendered as a ~220px column
// after navigating to it from another tab, because its single-column grid rule lived in another page's stylesheet
// and was present only when that page's chunk had loaded). Every section must use the available content width
// whether it is reached by a tab click (no reload) or by a direct link, on desktop and on a phone.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 90_000 })
const TABS = ['Control Center', 'Business Review', 'Voice Lab', 'Voice providers', 'Growth', 'Overview']
const ROOTS = { 'Voice providers': '[data-voice-providers]', 'Voice Lab': '[data-voice-lab]' }

// The width the section's content actually occupies versus the width the main column offers it, plus overflow.
async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main.app-main')
    // The Control-Center-style pages put their content in .cc-main (the column that collapsed); other pages are
    // measured by their widest top-level block.
    const column = main?.querySelector('.cc-main')
    const nav = main?.querySelector('.cc-nav') // a real side navigation (Control Center) takes its own column
    const widest = Math.max(0, ...Array.from(main?.children || [], (el) => el.getBoundingClientRect().width))
    const beside = nav && column && nav.getBoundingClientRect().right <= column.getBoundingClientRect().left // side by side, not stacked
    const navWidth = beside ? column.getBoundingClientRect().left - main.getBoundingClientRect().left : 0
    return { main: (main?.getBoundingClientRect().width || 0) - navWidth, content: column ? column.getBoundingClientRect().width : widest, overflow: document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width) }
  })
}
async function expectFullWidth(page, label) {
  await expect(page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await measure(page)).content, { message: `${label}: content rendered` }).toBeGreaterThan(0)
  const m = await measure(page)
  expect(m.content, `${label}: content width ${m.content} of ${m.main}`).toBeGreaterThanOrEqual(m.main * 0.9)
  expect(m.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0)
}

test('every admin section fills the content column when reached by tab clicks without a reload, in both directions, and by direct link @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin')
  await expectFullWidth(page, 'Overview')
  const nav = page.getByRole('navigation', { name: 'Admin' })
  // Straight to Voice providers from the overview (the reported case), then every tab in order and in reverse.
  await nav.getByRole('link', { name: 'Voice providers' }).click()
  await expect(page).toHaveURL(/\/admin\/voice-providers$/)
  await expect(page.locator(ROOTS['Voice providers'])).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Voice providers' })).toBeVisible()
  await expectFullWidth(page, 'Voice providers')
  for (const label of [...TABS, ...TABS.slice().reverse()]) {
    await nav.getByRole('link', { name: label, exact: true }).click()
    if (ROOTS[label]) await expect(page.locator(ROOTS[label])).toBeVisible()
    await expectFullWidth(page, label)
  }
  // Direct links.
  for (const [label, path] of [['Voice providers', '/admin/voice-providers'], ['Voice Lab', '/admin/voice-lab'], ['Control Center', '/admin/control']]) {
    await page.goto(path)
    if (ROOTS[label]) await expect(page.locator(ROOTS[label])).toBeVisible()
    await expectFullWidth(page, label)
  }
  // Back/forward keep the layout too.
  await page.goBack()
  await expectFullWidth(page, 'Voice Lab')
  await page.goForward()
  await expectFullWidth(page, 'Control Center')
})
