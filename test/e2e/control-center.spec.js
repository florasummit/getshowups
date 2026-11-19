// Control Center demonstration (local workerd, mocked Google; own TEST business e2e-cc):
// journey works → reversible fault injected in the Google mock → booking-page lookups fail → cron detects it →
// one structured incident on the test account (cause confirmed, sanitized evidence) → repeated failures and runs stay
// ONE incident → account diagnosis → fault removed → journey works again → incident resolved on evidence in the UI.
// Plus: account-level diagnosis of a failed availability lookup (freeBusy error). No production data involved.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const C = fixtures.E2E_CC_CUSTOMER
const MOCK = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`

test('demo: injected availability failure → detected incident on the test account → deduplicated → fixed → recovery shown', async ({ page, context, request }) => {
  test.setTimeout(90_000)
  const fault = (f) => request.post(`${MOCK}/__faults`, { data: { customer: C, fault: f } })
  const cron = async () => {
    const r = await request.post('/api/cron/run', { headers: { Authorization: `Bearer ${fixtures.E2E_CRON_SECRET}` } })
    expect(r.status()).toBe(200)
    return (await r.json()).incidents
  }
  const lookup = async () => (await request.get(`/api/book/${C}`)).json()
  const openIncidents = async () => (await (await page.request.get(`/api/platform/incidents?business=${C}&status=open`)).json()).incidents
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await fault('clear')

  // 1. The automated customer journey works: the booking page offers times.
  expect((await lookup()).slots.length).toBeGreaterThan(0)
  await page.goto(`/book/${C}`)
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible()
  await expect(page.getByText('Control Demo Pools')).toBeVisible()

  // 2–5. Deterministic, reversible failure: Google rejects the stored grant. The page shows no times; the failure is
  // recorded (async, waitUntil) and the cron opens ONE incident for this test account.
  await fault('invalid_grant')
  const failedLookup = await lookup()
  expect(failedLookup.slots).toEqual([])
  // The journey check's real outcome is recorded as an automated run (mocked providers, local source).
  const report = (status, error) =>
    request.post('/api/qa/runs', {
      headers: { Authorization: `Bearer ${fixtures.E2E_QA_INGEST_TOKEN}` },
      data: { source: 'local', provider: 'mocked', revision: 'e2e0000', results: [{ file: 'test/e2e/control-center.spec.js', title: 'demo: injected availability failure', status, durationMs: 1, error }] },
    })
  const run1 = await report('failed', `booking page offered ${failedLookup.slots.length} times (calendar lookup failing) for owner@${C}.example`)
  expect(run1.status()).toBe(201)
  await expect(async () => {
    await cron()
    expect((await openIncidents()).length).toBe(1)
  }).toPass({ timeout: 15_000 })
  const [inc] = await openIncidents()
  expect(inc).toMatchObject({ customer: C, kind: 'calendar', feature: 'calendar.google', journey: 'booking', step: 'availability', code: 'reconnect_required', severity: 'critical', cause: 'confirmed', status: 'open', test: true })
  expect(inc.evidence).toMatchObject({ error: 'reconnect_required', source: 'lookup' })
  expect(JSON.stringify(inc)).not.toMatch(/cal@e2e-pool|mock-refresh|Bearer/)

  // 7. Deduplication: more failing lookups and cron runs → still one incident.
  for (let k = 0; k < 3; k++) await lookup()
  await cron()
  await cron()
  expect((await openIncidents()).map((i) => i.id)).toEqual([inc.id])

  // Admin dashboard: the incident is listed (tagged Test, not counted as customer impact) with cause + next step.
  await page.goto('/admin/control')
  const row = page.locator(`[data-incident="${inc.id}"]`)
  await expect(row).toContainText('Control Demo Pools')
  await expect(row).toContainText('Test')
  await expect(row).toContainText('Cause confirmed: Google reported the grant is no longer valid')
  await expect(row).toContainText('Next: Ask the owner to reconnect Google Calendar')
  await row.getByText('Evidence').click()
  await expect(row.locator('.cc-evidence')).toContainText('reconnect_required')

  // Account Inspector: journey shows the failed step; diagnosis confirms the cause without credentials.
  await row.getByRole('button', { name: 'Open account' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/control\\?business=${C}$`))
  const acct = page.locator(`[data-account="${C}"]`)
  await expect(acct.locator('[data-step="booking_live"]')).toHaveAttribute('data-state', 'failed')
  await acct.getByRole('button', { name: 'Diagnose calendar (read-only)' }).click()
  await expect(acct.locator('[data-diagnosis]')).toHaveAttribute('data-diagnosis', 'reconnect_required')

  // 6. The failed automated run: failed-step evidence (sanitized), mocked providers, and the related open incident.
  const run1Id = (await run1.json()).id
  await page.goto('/admin/control?view=qa')
  await page.locator(`[data-qa-auto="${run1Id}"]`).getByRole('button', { name: 'Open run' }).click()
  const detail = page.locator(`[data-run="${run1Id}"]`)
  await expect(detail).toContainText('Mocked providers')
  const failedRow = detail.locator('[data-test^="calendar-recovery:control-center:demo"]')
  await expect(failedRow).toHaveAttribute('data-result', 'fail')
  await expect(failedRow).toContainText('calendar lookup failing) for [email]')
  await expect(detail.getByRole('heading', { name: 'Related open incidents' })).toBeVisible()
  await expect(detail).toContainText('reconnect_required')
  await page.goto(`/admin/control?business=${C}`)

  // 8–10. Fix the injected failure; the journey works again; the next cron resolves the incident on evidence.
  await fault('clear')
  await expect(async () => {
    expect((await lookup()).slots.length).toBeGreaterThan(0)
    expect((await cron()).resolved).toBeGreaterThanOrEqual(0)
    expect(await openIncidents()).toEqual([])
  }).toPass({ timeout: 15_000 })
  await page.goto('/admin/control')
  const resolved = page.locator(`[data-incident="${inc.id}"][data-status="resolved"]`)
  await expect(resolved).toContainText('Recovered (success seen)')

  // 9. The rerun passes; retest history shows fail → pass for the same stable test id.
  const run2 = await report('passed', null)
  expect(run2.status()).toBe(201)
  const run2Id = (await run2.json()).id
  await page.goto('/admin/control?view=qa')
  await page.locator(`[data-qa-auto="${run2Id}"]`).getByRole('button', { name: 'Open run' }).click()
  const passedRow = page.locator(`[data-run="${run2Id}"] [data-test^="calendar-recovery:control-center:demo"]`)
  await expect(passedRow).toHaveAttribute('data-result', 'pass')
  await passedRow.getByRole('button', { name: 'Retest history' }).click()
  await expect(passedRow.getByRole('list', { name: 'Retest history' }).locator('li')).toHaveText([/^Pass/, /^Fail/])

  // 11. The same journey in guided human QA: action, expected result, observation, Pass, finish.
  await page.goto('/admin/control?view=qa&journey=calendar-recovery')
  await page.getByLabel('Test business used (optional)').fill(C)
  await page.getByRole('button', { name: 'Start guided QA: Calendar connection recovery' }).click()
  const step = page.locator('[data-qa-step="reconnect"]')
  await expect(step).toContainText('Expected: Connected; booking page shows times again.')
  await step.getByLabel('What happened').fill('Reconnected in the test account; times came back.')
  await step.getByLabel(/How much effort/).fill('2: one click')
  await step.getByRole('button', { name: 'Pass' }).click()
  await expect(step).toHaveAttribute('data-recorded', 'pass')
  await page.getByRole('button', { name: 'Finish run' }).click()
  await expect(page.locator('[data-run-result]')).toHaveAttribute('data-run-result', 'blocked') // other steps not tested

  // Account-level diagnosis of a failed availability lookup (Google freeBusy error), then restore.
  await fault('freebusy_error')
  await page.goto(`/admin/control?business=${C}`)
  await acct.getByRole('button', { name: 'Diagnose calendar (read-only)' }).click()
  await expect(acct.locator('[data-diagnosis]')).toHaveAttribute('data-diagnosis', 'calendar_error')
  await expect(acct.locator('[data-diagnosis]')).toContainText('Calendar lookup failed: calendar_error')
  await fault('clear')
})

test('Control Center: phone width has no sideways scroll; customers and signed-out visitors are refused @mobile', async ({ page, context, browser }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control')
  await expect(page.getByRole('heading', { name: 'Control Center', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recommended next actions' })).toBeVisible()
  // No real-person activation run exists: the dashboard says so (never derived from automated tests).
  await expect(page.locator('[data-overview-activation]')).toHaveAttribute('data-overview-activation', 'not-measured')
  await expect(page.locator('[data-overview-activation]')).toContainText('not measured yet')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.getByRole('button', { name: 'Open Control Demo Pools' }).click()
  await expect(page.getByRole('heading', { name: /Journey:/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  const owner = await browser.newContext()
  await useSession(owner, fixtures.E2E_SESSION_TOKEN)
  const r = await (await owner.newPage()).request.get('/api/platform/control')
  expect(r.status()).toBe(403)
  await owner.close()
  const anon = await browser.newContext()
  expect((await (await anon.newPage()).request.get(`/api/platform/inspector?business=${C}`)).status()).toBe(401)
  await anon.close()
})
