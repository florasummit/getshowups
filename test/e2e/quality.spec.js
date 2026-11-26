// Product quality standards (docs/DESIGN_SYSTEM.md), checked on the real screens of a fictional business with history
// (the tour business, seed-tour.mjs) and on the admin console. READ-ONLY: nothing here clicks a control that changes
// data; it only navigates and measures.
//   1. One page frame: the logo and the tab row sit at the same x on every dashboard tab and every admin section, and
//      every top-level page title has one size (findings DASH-07, ADM-03).
//   2. The browser tab names the page after a load AND after an in-app click (ADM-03).
//   3. On a phone the current tab is on screen, a row that has more shows it, and the page never scrolls sideways
//      (TEACH-08, GROW-11).
//   4. On a phone every control is at least 44 px tall (CHAT-03-style findings; the rule in src/app.css).
//   5. No internal switch names and no ISO dates in what an owner or admin reads (DASH-08, GROW-09).
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 90_000 })

const OWNER = fixtures.E2E_TOUR_SESSION_TOKEN
const ADMIN = fixtures.E2E_ADMIN_SESSION_TOKEN
const SHELLS = [
  ['dashboard', OWNER, '/dashboard', 'Dashboard'],
  ['admin', ADMIN, '/admin', 'Admin'],
]

// The shell's tabs as the page offers them (a business only has the tabs its plan gives it): [[label, path]].
async function tabsOf(page, navLabel) {
  const nav = page.getByRole('navigation', { name: navLabel, exact: true })
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1)
  return nav.locator('a').evaluateAll((links) => links.map((a) => [a.textContent.trim(), new URL(a.href).pathname]))
}

// The page has rendered its content: one page heading, nothing still loading.
async function settled(page, navLabel, label) {
  await expect(page.getByRole('navigation', { name: navLabel, exact: true }).getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('main.app-main h1').first()).toBeVisible({ timeout: 15_000 })
  // Owner pages mark what is still loading (tour.spec.js relies on the same); admin pages are ready with their heading.
  if (navLabel === 'Dashboard') await expect(page.locator('main.app-main [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
}

const frame = (page) =>
  page.evaluate(() => {
    const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left * 2) / 2
    const h1 = document.querySelector('main.app-main h1')
    return { logo: x('.app-header .logo'), tabs: x('.tabs a'), header: x('.app-header'), row: x('.tabs-wrap'), title: h1 ? getComputedStyle(h1).fontSize : null }
  })

for (const [shell, token, home, navLabel] of SHELLS) {
  test(`one page frame: ${shell} logo, tab row and title size stay put on every tab`, async ({ page, context }) => {
    await useSession(context, token)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(home)
    const tabs = await tabsOf(page, navLabel)
    expect(tabs.length).toBeGreaterThanOrEqual(5)
    await settled(page, navLabel, tabs[0][0])
    const first = await frame(page)
    expect(Math.abs(first.logo - first.tabs), `the first tab starts under the logo (logo ${first.logo}, tab ${first.tabs})`).toBeLessThanOrEqual(1)
    // In-app clicks, in order and back again: the frame must not move in either direction.
    for (const [label] of [...tabs.slice(1), ...tabs.slice().reverse()]) {
      await page.getByRole('navigation', { name: navLabel, exact: true }).getByRole('link', { name: label, exact: true }).click()
      await settled(page, navLabel, label)
      const now = await frame(page)
      expect({ logo: now.logo, tabs: now.tabs, header: now.header, row: now.row }, `${label}: the top bar and tab row are where they were`).toEqual({ logo: first.logo, tabs: first.tabs, header: first.header, row: first.row })
      expect(now.title, `${label}: one page-title size`).toBe(first.title)
    }
    // Direct links land in the same frame.
    for (const [label, path] of tabs) {
      await page.goto(path)
      await settled(page, navLabel, label)
      const now = await frame(page)
      expect([now.logo, now.tabs], `${label} (direct link)`).toEqual([first.logo, first.tabs])
    }
  })
}

test('the browser tab names the page after a load and after an in-app click', async ({ page, context }) => {
  await useSession(context, ADMIN)
  await page.goto('/admin')
  const sections = await tabsOf(page, 'Admin')
  for (const [label] of [...sections.slice(1), sections[0]]) {
    await page.getByRole('navigation', { name: 'Admin', exact: true }).getByRole('link', { name: label, exact: true }).click()
    await expect(page, `${label} after a click`).toHaveTitle(`${label} · Admin · GetShowUps`)
  }
  for (const [label, path] of sections) {
    await page.goto(path)
    await expect(page, `${label} after a load`).toHaveTitle(`${label} · Admin · GetShowUps`)
  }
  await context.clearCookies()
  await useSession(context, OWNER)
  await page.goto('/dashboard')
  const tabs = await tabsOf(page, 'Dashboard')
  await expect(page).toHaveTitle(`${tabs[0][0]} · GetShowUps`)
  await page.getByRole('navigation', { name: 'Dashboard', exact: true }).getByRole('link', { name: tabs[1][0], exact: true }).click()
  await expect(page).toHaveTitle(`${tabs[1][0]} · GetShowUps`)
  await page.goBack()
  await expect(page).toHaveTitle(`${tabs[0][0]} · GetShowUps`)
})

for (const [shell, token, home, navLabel] of SHELLS) {
  test(`phone: the current ${shell} tab is on screen, a longer row shows it, and the page never scrolls sideways @mobile`, async ({ page, context }, info) => {
    await useSession(context, token)
    if (info.project.name !== 'mobile') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(home)
    const tabs = await tabsOf(page, navLabel)
    for (const [label, path] of tabs) {
      await page.goto(path)
      await settled(page, navLabel, label)
      const m = await page.evaluate(() => {
        const wrap = document.querySelector('.tabs-wrap')
        const row = wrap.querySelector('.tabs')
        const box = row.querySelector('[aria-current="page"]').getBoundingClientRect()
        return {
          left: box.left,
          right: box.right,
          width: document.documentElement.clientWidth,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rowScrolls: row.scrollWidth > row.clientWidth + 4,
          cue: wrap.hasAttribute('data-more-start') || wrap.hasAttribute('data-more-end'),
          arrows: [...wrap.querySelectorAll('.tabs-more')].filter((b) => getComputedStyle(b).display !== 'none').length,
        }
      })
      expect(m.left, `${label}: the current tab starts on screen`).toBeGreaterThanOrEqual(0)
      expect(m.right, `${label}: the current tab ends on screen`).toBeLessThanOrEqual(m.width)
      expect(m.overflow, `${label}: no sideways scrolling of the page`).toBeLessThanOrEqual(1)
      if (m.rowScrolls) {
        expect(m.cue, `${label}: a row with more tabs says so`).toBe(true)
        expect(m.arrows, `${label}: the cut-off side shows its arrow`).toBeGreaterThanOrEqual(1)
      }
    }
  })
}

test('phone: one page-title size on every dashboard tab and every admin section @mobile', async ({ page, context }, info) => {
  if (info.project.name !== 'mobile') await page.setViewportSize({ width: 390, height: 844 })
  const sizes = {}
  for (const [, token, home, navLabel] of SHELLS) {
    await context.clearCookies()
    await useSession(context, token)
    await page.goto(home)
    for (const [label, path] of await tabsOf(page, navLabel)) {
      await page.goto(path)
      await settled(page, navLabel, label)
      sizes[`${navLabel} → ${label}`] = await page.locator('main.app-main h1').first().evaluate((h) => getComputedStyle(h).fontSize)
    }
  }
  const first = Object.values(sizes)[0]
  expect(Object.entries(sizes).filter(([, v]) => v !== first), `every page title is ${first} on a phone`).toEqual([])
})

// The smallest phone (320 px): the top bar, the tab row and the shared controls must still fit the page.
test('320 px: no sideways scrolling on Overview, Settings, Ads and the admin console', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  for (const [token, paths] of [
    [OWNER, ['/dashboard', '/dashboard/settings', '/dashboard/ads']],
    [ADMIN, ['/admin', '/admin/growth']],
  ]) {
    await context.clearCookies()
    await useSession(context, token)
    for (const path of paths) {
      await page.goto(path)
      await expect(page.locator('main.app-main h1').first()).toBeVisible({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${path}: no sideways scrolling at 320 px`).toBeLessThanOrEqual(0)
    }
  }
})

// ---- touch targets and copy: Overview, Appointments, Settings (owner) and Growth (admin) ----
const PAGES = [
  ['Overview', OWNER, '/dashboard', 'Dashboard'],
  ['Appointments', OWNER, '/dashboard/appointments', 'Dashboard'],
  ['Receptionist', OWNER, '/dashboard/receptionist', 'Dashboard'],
  ['Teach Your AI', OWNER, '/dashboard/teach', 'Dashboard'],
  ['Website', OWNER, '/dashboard/website', 'Dashboard'],
  ['Settings', OWNER, '/dashboard/settings', 'Dashboard'],
  ['Growth', ADMIN, '/admin/growth', 'Admin'],
]

// Controls that stay visually small on purpose. Keep this list short; every entry says why.
const SMALL_ON_PURPOSE = [
  '.help-tip', // the "?" help mark: a 24 px circle whose tap area is extended to 44 px by ::after (src/app.css)
  ':is(p, span, label) > .link-btn', // a text link inside a sentence (WCAG 2.5.8 inline exception)
  ':is(p, span, label) > a', // same, for plain links
]
// Narrower than 44 px on purpose (height is still 44): seven weekday buttons must fit one row on a 320 px phone.
const NARROW_ON_PURPOSE = ['.day-toggle']

for (const [label, token, path, navLabel] of PAGES) {
  test(`phone: every control on ${label} is at least 44 px tall @mobile`, async ({ page, context }, info) => {
    test.skip(info.project.name !== 'mobile', 'measured on the phone project (touch screen)')
    await useSession(context, token)
    await page.goto(path)
    await settled(page, navLabel, label)
    await page.waitForLoadState('networkidle')
    const small = await page.evaluate(([allowed, narrow]) => {
      const out = []
      const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`
      // Buttons, button-like links, the header logo link, selects, disclosures, and every row that wraps a checkbox or radio.
      for (const el of document.querySelectorAll('.app :is(button, a.btn, a.chip, a.booking-url, .app-header .logo, select, summary, [role="button"], [role="tab"], label:has(> input[type="checkbox"]), label:has(> input[type="radio"]))')) {
        if (allowed.some((sel) => el.matches(sel))) continue
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
        const box = el.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) continue // visually hidden (screen-reader only)
        if (box.height < 43.5) out.push(`${name(el)} ${Math.round(box.height)}px tall`)
        else if (el.matches('button, a.btn, a.chip, .link-btn') && box.width < 43.5 && !narrow.some((sel) => el.matches(sel))) out.push(`${name(el)} ${Math.round(box.width)}px wide`)
      }
      return [...new Set(out)]
    }, [SMALL_ON_PURPOSE, NARROW_ON_PURPOSE])
    expect(small, `${label}: controls under 44 px on a phone (fix the control, or add it to SMALL_ON_PURPOSE with the reason)`).toEqual([])
  })
}

const INTERNAL_NAME = /\b[A-Z]{3,}_[A-Z_]{3,}\b/ // switch names such as STRIPE_LIVE_ENABLED
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/

async function copyProblems(page) {
  const text = await page.locator('.app').innerText()
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => INTERNAL_NAME.test(l) || ISO_DATE.test(l))
    .map((l) => l.slice(0, 120))
}

for (const [label, token, path, navLabel] of PAGES.filter(([l]) => l !== 'Growth')) {
  test(`copy: ${label} shows no internal switch names and no ISO dates @mobile`, async ({ page, context }) => {
    await useSession(context, token)
    await page.goto(path)
    await settled(page, navLabel, label)
    await page.waitForLoadState('networkidle')
    expect(await copyProblems(page), `${label}: say it in plain words; dates through humanDate() (src/lib/format.js)`).toEqual([])
  })
}

// GROW-09: Growth → Measure used to print "STRIPE_LIVE_ENABLED" (server/growth.js notes) and other internal terms.
test('copy: Growth shows no internal switch names and no ISO dates (GROW-09) @mobile', async ({ page, context }) => {
  await useSession(context, ADMIN)
  await page.goto('/admin/growth')
  await settled(page, 'Admin', 'Growth')
  await page.waitForLoadState('networkidle')
  for (const mode of ['measure', 'activities', 'simulate', 'decide']) {
    const tab = page.locator(`[data-growth-mode="${mode}"]`)
    if (!(await tab.count())) continue
    await tab.click() // switching the view changes nothing stored
    expect(await copyProblems(page), `Growth → ${mode}`).toEqual([])
  }
})
