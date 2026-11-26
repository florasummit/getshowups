// Website Studio: the whole normal journey in a real browser for a business that has no GetShowUps website yet (an HVAC
// company moving from its old site). Start → "I have a website" → scan → review (services, pages, word-for-word policy,
// old addresses) → import → the multi-page site appears in the editor with the services on it → preview → publish (with
// the legal review) → public pages → hosting choice. Real routes on local workerd; the old site and Google are mocked.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

test.describe.configure({ timeout: 120_000 })
// TOUR_SHOTS=<dir>: also save screenshots of each step for visual review.
const shot = async (p, info, name, opts = {}) => process.env.TOUR_SHOTS && p.screenshot({ path: `${process.env.TOUR_SHOTS}/flow-${info.project.name}-${name}.png`, animations: 'disabled', ...opts })
const biz = (info) => (info.project.name === 'mobile' ? { id: fixtures.E2E_FLOW_M_CUSTOMER, token: fixtures.E2E_FLOW_M_SESSION_TOKEN } : { id: fixtures.E2E_FLOW_CUSTOMER, token: fixtures.E2E_FLOW_SESSION_TOKEN })

test('existing website → scan → review → import → editor shows services → preview → legal review → publish → public pages → hosting @mobile', async ({ page, context }, info) => {
  const b = biz(info)
  await useSession(context, b.token)
  await page.goto('/dashboard/website')

  // Start: two clear front doors.
  const start = page.getByRole('region', { name: 'How would you like to start?' })
  await expect(start.getByRole('button', { name: /I have a website/ })).toBeVisible()
  await expect(start.getByRole('button', { name: /Create my website/ })).toBeVisible()
  await shot(page, info, '1-start')
  await start.getByRole('button', { name: /I have a website/ }).click()

  // Scan.
  const imp = page.getByRole('region', { name: 'Bring your current website' })
  await expect(imp.getByLabel('Your current website', { exact: true })).toBeFocused()
  await imp.getByLabel('Your current website', { exact: true }).fill('www.northwindair.example')
  await imp.getByLabel('This is my business’s website and I can use its content.').check()
  await imp.getByRole('button', { name: /^Import (my website|again)$/ }).click()
  await expect(imp.getByText(/Found \d+ pages on www\.northwindair\.example\./)).toBeVisible({ timeout: 30_000 })

  // Review: services with their stated prices, pages to create with where their content comes from, old addresses.
  const services = imp.locator('.import-field', { hasText: 'Services and prices' }).locator('li')
  await expect(services).toHaveCount(2)
  await expect(services.first()).toContainText('AC Tune-Up · $129')
  const pages = imp.getByRole('group', { name: 'Pages' })
  await expect(pages.locator('[data-page="privacy"]')).toContainText('Copied word for word from www.northwindair.example/privacy-policy')
  await expect(pages.locator('[data-page="privacy"]').getByRole('checkbox')).toBeChecked()
  await expect(pages.locator('[data-page="services"]').getByRole('checkbox')).toBeChecked()
  await expect(imp.getByRole('list', { name: 'Old page addresses' }).locator('[data-from="/about-us"]')).toContainText('your about page')
  await imp.screenshot({ path: process.env.TOUR_SHOTS ? `${process.env.TOUR_SHOTS}/flow-${info.project.name}-2-review.png` : undefined }).catch(() => {})
  await imp.getByRole('button', { name: 'Use this in my draft' }).click()
  await expect(imp.getByRole('status')).toContainText('We built your website pages from this.')

  // The multi-page site is in the editor; its Services page lists the imported services.
  const studio = page.locator('section[aria-label="Website Studio editor"]')
  await expect(studio).toBeVisible()
  await studio.getByRole('combobox').first().selectOption('services')
  const frame = page.frameLocator('iframe[title="Editable website preview"]')
  await expect(frame.getByText('AC Tune-Up')).toBeVisible()
  await expect(frame.getByText('$95 diagnostic')).toBeVisible()

  // Journey: content done; reviewing is the current step (publishing is right after it).
  const journey = page.getByRole('region', { name: 'Your website, step by step' })
  const step = (name) => journey.getByRole('listitem').filter({ has: page.locator('.wj-title', { hasText: new RegExp(`^${name}`) }) })
  await expect(step('Bring your content')).toContainText('Imported')
  await expect(step('Review, edit and preview')).toHaveAttribute('aria-current', 'step')

  // Publish: the legal page needs its own review tick.
  await journey.getByRole('button', { name: 'Publish website' }).click()
  const publishBtn = page.getByRole('button', { name: 'Publish website' }).last()
  await page.getByLabel(/The details are accurate/).check()
  await expect(publishBtn).toBeDisabled()
  await page.getByLabel(/I’ve read my privacy policy page/).check()
  await shot(page, info, '3-editor-and-publish', { fullPage: true })
  await publishBtn.click()
  await expect(page.locator('.site-status-line')).toContainText('Live')

  // Public pages: services shown, the policy word for word, the policy linked in the footer, not in the menu.
  const site = await context.newPage()
  await site.goto(`/p/${b.id}/services`)
  await expect(site.getByText('AC Tune-Up')).toBeVisible()
  await shot(site, info, '4-public-services', { fullPage: true })
  await expect(site.locator('header nav, header').getByRole('link', { name: 'Privacy policy' })).toHaveCount(0)
  await site.locator('footer').getByRole('link', { name: 'Privacy policy' }).click()
  await expect(site.getByText('Asking us a question is always free.')).toBeVisible()
  await shot(site, info, '5-public-privacy', { fullPage: true })
  expect(await site.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await site.close()

  // Hosting: GetShowUps by default; own hosting offers the download of the published site.
  // Address and hosting sit under one disclosure once a draft exists (WEB-05).
  await page.locator('#site-address > summary').click()
  const hosting = page.getByRole('region', { name: 'Where your website lives' })
  await hosting.getByText('Use my own hosting').click()
  const link = hosting.getByRole('link', { name: 'Download my website (.zip)' })
  await expect(link).toHaveAttribute('href', '/api/dashboard/website/export?format=static')
  await hosting.screenshot({ path: process.env.TOUR_SHOTS ? `${process.env.TOUR_SHOTS}/flow-${info.project.name}-6-hosting.png` : undefined }).catch(() => {})
  const res = await page.request.get('/api/dashboard/website/export?format=static')
  expect([res.status(), res.headers()['content-type']]).toEqual([200, 'application/zip'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
