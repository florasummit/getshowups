// Research Vault (/admin/research-vault): the founder sees programs, moves a model's sliders (evaluated on the server),
// runs the numeric checks and records a hypothesis; another admin and an owner get the same "Not found". Desktop + phone.
import { test, expect } from './test.js'
import { useSession } from './helpers.js'
import { fixtures } from '../../playwright.config.js'

test('research vault: founder only; models evaluate on the server; checks run; a hypothesis is recorded with its falsifier @mobile', async ({ page, context }) => {
  // An owner (not an admin) is told nothing.
  await useSession(context, fixtures.E2E_SESSION_TOKEN)
  await page.goto('/admin/research-vault')
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()
  expect((await page.request.get('/api/research/vault?view=overview')).status()).toBe(404)
  // The founder (RESEARCH_FOUNDER_EMAIL = the e2e platform admin).
  await context.clearCookies()
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/research-vault')
  await expect(page.getByRole('heading', { name: 'Research', level: 1 })).toBeVisible()
  // Programs are records imported from the founder's own file (none ship in the code).
  const program = { kind: 'program', record: { program: 'GS-ECO-001', title: 'Customer acquisition economics', body: { question: 'Where does ad spend stop paying?', needs: ['spend', 'leads'] } } }
  await page.locator('[data-import] textarea').fill(JSON.stringify([program]))
  await page.locator('[data-import]').getByRole('button', { name: 'Import' }).click()
  await expect(page.locator('[data-import]').getByRole('status')).toContainText(/Created [01], skipped [01] already present, refused 0/)
  await expect(page.locator('[data-programs]')).toContainText('GS-ECO-001')
  await expect(page.locator('[data-programs]')).toContainText('Dormant')
  // Models: the server evaluates; moving a slider changes the optimum it reports.
  await page.getByRole('navigation', { name: 'Research sections' }).getByRole('link', { name: 'Models' }).click()
  const models = page.locator('[data-models]')
  await expect(models.locator('[data-expression]')).toContainText('N(x) = a·√x')
  await expect(models.getByText('Formal proof: not verified')).toBeVisible()
  const results = models.locator('[data-results]')
  await expect(results).toContainText('xStar')
  const before = await results.innerText()
  await models.getByLabel('v ($ contribution per customer)').fill('300')
  await expect(results).not.toHaveText(before)
  await models.getByRole('button', { name: 'Run the checks at these values' }).click()
  await expect(models.locator('[data-checks]')).toContainText('passes')
  await expect(models.locator('[data-checks]')).not.toContainText('fails')
  // Records: a hypothesis without a falsifier is refused; with one it is saved and listed.
  await page.getByRole('navigation', { name: 'Research sections' }).getByRole('link', { name: 'Records' }).click()
  const form = page.locator('[data-new-record]')
  await form.getByLabel('Title *').fill('Two offered times raise bookings')
  await form.getByLabel('statement *').fill('Offering two concrete times raises the booking rate')
  await form.getByLabel(/^assumptions \*/).fill('Lead quality unchanged')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form.getByRole('status')).toContainText('falsifiedBy')
  await form.getByLabel('falsifiedBy *').fill('No rise after 40 qualified leads')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form.getByRole('status')).toHaveText('Saved.')
  await expect(page.locator('[data-records]')).toContainText('Two offered times raise bookings')
  // Phone width: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})
