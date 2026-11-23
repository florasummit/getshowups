// Pricing (Growth + Enterprise) and the Contact sales form. The e2e server has no `getshowups` record (other specs rely
// on that), so the stored path runs the REAL handlers over the real migrations in this process; the 503 path is workerd.
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test, expect } from './test.js'
import * as api from '../../functions/api/enterprise/inquiry.js'

function backend() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').sort()) sql.exec(readFileSync(`migrations/${f}`, 'utf8'))
  sql.exec("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('getshowups', 'GetShowUps', 'America/New_York', 1, 1)")
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }) })
  const env = { TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) } }
  return { sql, env }
}
const open = async (page) => {
  await page.locator('[data-enterprise-cta]').click()
  await expect(page.locator('[data-enterprise-form]')).toBeVisible()
}
const fill = async (page) => {
  await page.getByLabel('Organization name').fill('Harbor Franchise Group')
  await page.getByLabel('Type of organization').selectOption('franchise')
  await page.getByLabel('Your name').fill('Dana Lee')
  await page.getByLabel('Work email').fill('dana@harbor.example')
  await page.getByLabel('Approximate number of businesses or locations').fill('25')
  await page.getByLabel('What do you want to accomplish?').fill('Bookings for every location')
}

test('two plans: Growth $499/month starts as before, Enterprise starts at $10,000/month with Contact sales only @mobile', async ({ page }) => {
  await page.route('**/api/enrollment', (r) => r.fulfill({ json: { open: true } }))
  await page.goto('/')
  const cards = page.locator('#pricing [data-plan]')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0).locator('.price-amount')).toHaveText('$499/month')
  await expect(cards.nth(0).locator('a[href="/dashboard?plan=founding"]')).toBeVisible()
  await expect(cards.nth(1)).toContainText('Starting at$10,000/month')
  await expect(cards.nth(1).locator('a')).toHaveCount(0)
  await expect(cards.nth(1).getByRole('button', { name: 'Contact sales' })).toBeVisible()
  await expect(cards.nth(1)).toContainText('not live yet')
  await open(page)
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no sideways scroll at ${width}`).toBeLessThanOrEqual(0)
  }
})

test('contact sales: validation, a send right away, the lead stored in the sales business @mobile', async ({ page }) => {
  const { sql, env } = backend()
  await page.route('**/api/enterprise/inquiry', async (route) => {
    const r = route.request()
    const request = new Request('https://getshowups.com/api/enterprise/inquiry', { method: r.method(), body: r.postData() ?? undefined })
    const res = r.method() === 'POST' ? await api.onRequestPost({ request, env }) : await api.onRequestGet({ request, env })
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() })
  })
  await page.goto('/')
  await open(page)
  await page.locator('[data-enterprise-send]').click() // faster than 3 s: the form waits, then shows what to fix
  await expect(page.getByRole('alert')).toHaveText('Please enter your organization’s name.')
  await expect(page.getByLabel('Organization name')).toBeFocused()
  await fill(page)
  await page.locator('[data-enterprise-send]').click()
  await expect(page.getByText('Thanks. Your inquiry is recorded')).toBeVisible()
  expect(sql.prepare('SELECT customer, email FROM leads').all().map((r) => ({ ...r }))).toEqual([{ customer: 'getshowups', email: 'dana@harbor.example' }])
  await page.locator('[data-enterprise-close]').click()
  await expect(page.locator('[data-enterprise-form]')).toHaveCount(0)
})

test('contact sales on the real server without a sales record: an honest failure, the typed text is kept', async ({ page }) => {
  await page.goto('/')
  await open(page)
  await fill(page)
  await page.locator('[data-enterprise-send]').click()
  await expect(page.getByRole('alert')).toContainText('couldn’t record your request')
  await expect(page.getByLabel('Organization name')).toHaveValue('Harbor Franchise Group')
})
