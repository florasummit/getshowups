// Control Center (local workerd, mocked Google; own TEST business e2e-cc). Real interactions, real outcomes:
// 1. Demo: journey works → reversible fault injected in the Google mock → booking-page lookups fail → cron detects it →
//    one structured incident on the test account (cause confirmed, sanitized evidence) → repeated failures and runs stay
//    ONE incident → investigation page → account diagnosis → fault removed → journey works again → resolved on evidence.
// 2. Navigation, Back, keyboard, search, integrations, platform-wide incident, permission-denied.
// 3. Guided QA end to end: start → record → pause → resume → complete → review (persisted on the server).
// 4. Phone width. No production data involved.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'
import { useSession } from './helpers.js'

const C = fixtures.E2E_CC_CUSTOMER
const MOCK = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
// Measured against the device screen: mobile Chrome widens its layout viewport to fit overflowing content, so
// scrollWidth - innerWidth alone would hide an overflow.
const noSideScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - Math.min(window.innerWidth, screen.width))).toBeLessThanOrEqual(0)

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
  await expect(page.getByRole('heading', { level: 1, name: /^(What can we help with\?|Pick a time|Pick a visit time)$/ })).toBeVisible()
  await expect(page.getByText('Control Demo Pools')).toBeVisible()

  // 2–5. Deterministic, reversible failure: Google rejects the stored grant. The page shows no times; the cron opens ONE
  // incident for this test account.
  await fault('invalid_grant')
  const failedLookup = await lookup()
  expect(failedLookup.slots).toEqual([])
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
  expect(inc).toMatchObject({ customer: C, kind: 'calendar', feature: 'calendar.google', journey: 'booking', step: 'availability', code: 'reconnect_required', severity: 'critical', cause: 'confirmed', status: 'open', test: true, scope: 'account', title: 'Google Calendar connection broken' })
  expect(inc.evidence).toMatchObject({ error: 'reconnect_required', source: 'lookup' })
  expect(JSON.stringify(inc)).not.toMatch(/cal@e2e-pool|mock-refresh|Bearer/)

  // 7. Deduplication: more failing lookups and cron runs → still one incident.
  for (let k = 0; k < 3; k++) await lookup()
  await cron()
  await cron()
  expect((await openIncidents()).map((i) => i.id)).toEqual([inc.id])

  // Overview: the incident is in Needs attention (test account → Monitor, with the reason), and clicking it opens the
  // investigation page.
  await page.goto('/admin/control')
  const item = page.locator(`[data-attention="incident"][data-incident="${inc.id}"]`)
  await expect(item).toContainText('Google Calendar connection broken')
  await expect(item).toContainText('Test account')
  await expect(item).toHaveAttribute('data-triage', 'monitor')
  await expect(item).toContainText('Watching: Test account')
  await item.click()
  await expect(page).toHaveURL(new RegExp(`/admin/control\\?incident=${inc.id}$`))
  const detail = page.locator(`[data-incident-detail="${inc.id}"]`)
  await expect(detail.getByRole('heading', { level: 1 })).toHaveText('Google Calendar connection broken')
  await expect(detail.locator('[data-phase]')).toHaveText('Active failure')
  await expect(detail).toContainText('Critical')
  await expect(detail).toContainText('Confirmed cause')
  await expect(detail).toContainText('Google reported the grant is no longer valid')
  await expect(detail.locator('[data-triage]')).toContainText('Ask the owner to reconnect Google Calendar')
  // Evidence: readable events first; the raw record only on request.
  await expect(detail.getByText('Raw evidence record')).toBeVisible()
  await expect(detail.locator('pre')).toBeHidden()
  await detail.getByText('Raw evidence record').click()
  await expect(detail.locator('pre')).toContainText('reconnect_required')

  // Account Inspector from the incident: the journey shows the failed step; diagnosis confirms the cause.
  await detail.getByRole('link', { name: 'Open account' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/control\\?business=${C}$`))
  const acct = page.locator(`[data-account="${C}"]`)
  await expect(acct.locator('[data-step="booking_live"]')).toHaveAttribute('data-state', 'failed')
  await expect(acct.locator('[data-readiness="calendar"]')).toHaveAttribute('data-state', 'failed')
  await acct.getByRole('button', { name: 'Diagnose calendar (read-only)' }).click()
  await expect(acct.locator('[data-diagnosis]')).toHaveAttribute('data-diagnosis', 'reconnect_required')
  await expect(acct.locator('[data-diagnosis]')).toContainText('The owner needs to reconnect Google Calendar.')
  // Back returns to the incident (every screen is a URL).
  await page.goBack()
  await expect(page.locator(`[data-incident-detail="${inc.id}"]`)).toBeVisible()

  // 6. The failed automated run: sanitized failure, mocked providers, and the related open incident.
  const run1Id = (await run1.json()).id
  // (Earlier CI runs moved from the Testing tab to QA → Runs.)
  await page.goto('/admin/control?view=qa&tab=runs')
  await page.locator(`[data-qa-auto="${run1Id}"]`).click()
  const run = page.locator(`[data-run="${run1Id}"]`)
  await expect(run).toContainText('Mocked providers')
  const failedRow = run.locator('[data-test^="calendar-recovery:control-center:demo"]')
  await expect(failedRow).toHaveAttribute('data-result', 'fail')
  await expect(failedRow).toContainText('calendar lookup failing) for [email]')
  await expect(run.getByRole('heading', { name: 'Related open incidents' })).toBeVisible()
  await expect(run).toContainText('reconnect_required')

  // 8–10. Fix the injected failure; the journey works again; the next cron resolves the incident on evidence.
  await fault('clear')
  await expect(async () => {
    expect((await lookup()).slots.length).toBeGreaterThan(0)
    expect((await cron()).resolved).toBeGreaterThanOrEqual(0)
    expect(await openIncidents()).toEqual([])
  }).toPass({ timeout: 15_000 })
  await page.goto('/admin/control?view=incidents&filter=resolved')
  const resolved = page.locator(`[data-incident="${inc.id}"][data-status="resolved"]`)
  await expect(resolved).toContainText('Recovered · success confirmed')
  await resolved.click()
  await expect(page.locator('[data-incident-detail]')).toContainText('a later success was recorded')

  // 9. The rerun passes; retest history shows pass then fail for the same stable test id.
  const run2 = await report('passed', null)
  expect(run2.status()).toBe(201)
  const run2Id = (await run2.json()).id
  await page.goto('/admin/control?view=qa&tab=runs')
  await page.locator(`[data-qa-auto="${run2Id}"]`).click()
  const passedRow = page.locator(`[data-run="${run2Id}"] [data-test^="calendar-recovery:control-center:demo"]`)
  await expect(passedRow).toHaveAttribute('data-result', 'pass')
  await passedRow.getByRole('button', { name: 'Retest history' }).click()
  await expect(passedRow.getByRole('list', { name: 'Retest history' }).locator('li')).toHaveText([/Pass/, /Fail/])

  // Account-level diagnosis of a failed availability lookup (Google freeBusy error), then restore.
  await fault('freebusy_error')
  await page.goto(`/admin/control?business=${C}`)
  await acct.getByRole('button', { name: 'Diagnose calendar (read-only)' }).click()
  await expect(acct.locator('[data-diagnosis]')).toHaveAttribute('data-diagnosis', 'calendar_error')
  await expect(acct.locator('[data-diagnosis]')).toContainText('Calendar lookup failed: calendar_error')
  await fault('clear')
})

test('guided QA end to end: start with a test account → record results + usability → pause → resume where it stopped → finish → review in history', async ({ page, context }) => {
  test.setTimeout(60_000)
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  // Started from the account: the test account is preselected.
  await page.goto(`/admin/control?business=${C}`)
  await page.getByRole('link', { name: 'Start guided QA with this account' }).click()
  await expect(page).toHaveURL(/view=qa&for=e2e-cc/)
  const card = page.locator('[data-qa-journey="calendar-recovery"]')
  await expect(card).toContainText('When a calendar connection breaks')
  await card.getByRole('button', { name: 'Start guided QA: Calendar connection recovery' }).click()
  await card.getByLabel('Test account used (optional)').selectOption(C)
  await card.getByRole('button', { name: 'Begin' }).click()
  await expect(page.locator('[data-session]')).toBeVisible()
  const sessionUrl = page.url()
  expect(sessionUrl).toMatch(/session=qh_/)

  // Step 1: what to do + expected result, observation, result, usability (separate), save and continue.
  const s1 = page.locator('[data-qa-step="notice"]')
  await expect(s1).toContainText('Step 1 of 3')
  await expect(s1).toContainText('Expected result')
  await expect(s1).toContainText('"Needs reconnecting" with one clear action.')
  await s1.getByRole('button', { name: 'Save and continue →' }).click()
  await expect(s1.locator('[data-step-msg]')).toContainText('Choose a result first')
  await s1.getByLabel('What actually happened').fill('Dashboard showed "Needs reconnecting" with one button.')
  await s1.getByRole('radio', { name: 'Pass', exact: true }).check()
  await s1.getByRole('radio', { name: 'Simplify', exact: true }).check()
  await s1.getByLabel('Usability note (optional)').fill('The notice repeats itself.')
  await s1.getByRole('button', { name: 'Save and continue →' }).click()

  // Step 2: a failure, plus a defect.
  const s2 = page.locator('[data-qa-step="reconnect"]')
  await expect(s2).toContainText('Step 2 of 3')
  await s2.getByLabel('What actually happened').fill('Reconnect worked but times took a minute to come back.')
  await s2.getByRole('radio', { name: 'Fail', exact: true }).check()
  await s2.getByText('Report a defect or improvement').click()
  await s2.getByLabel('Describe it (no customer details)').fill('Times lag after reconnect.')
  await s2.getByRole('button', { name: 'Save finding' }).click()
  await expect(s2.locator('[data-step-msg]')).toContainText('Defect saved.')
  await s2.getByRole('button', { name: 'Save and continue →' }).click()
  await expect(page.locator('[data-qa-step="resolved"]')).toBeVisible()

  // Pause: back to QA → Manual (the guided journeys); the session is listed as in progress (server state, survives a reload).
  await page.getByRole('button', { name: 'Pause session' }).click()
  await expect(page.locator('[data-testing]')).toBeVisible()
  await page.reload()
  // (other tests may have sessions in progress too: pick this journey's)
  const running = page.locator('[data-qa-running]').filter({ hasText: 'Calendar connection recovery' }).first()
  await expect(running).toContainText('Calendar connection recovery')
  await expect(running).toContainText('In progress')
  // Resume: opens at the first unrecorded step; earlier answers are kept.
  await running.click()
  await expect(page.locator('[data-qa-step="resolved"]')).toBeVisible()
  await page.locator('[data-nav-step="notice"]').click()
  await expect(page.locator('[data-qa-step="notice"]').getByLabel('What actually happened')).toHaveValue('Dashboard showed "Needs reconnecting" with one button.')
  await expect(page.locator('[data-qa-step="notice"]').getByRole('radio', { name: 'Simplify', exact: true })).toBeChecked()
  await page.locator('[data-nav-step="resolved"]').click()
  const s3 = page.locator('[data-qa-step="resolved"]')
  await s3.getByRole('radio', { name: 'Blocked', exact: true }).check()
  await s3.getByLabel('What actually happened').fill('No incident to resolve in this environment.')
  await s3.getByRole('button', { name: 'Save and review →' }).click()

  // Review + finish (confirmed), then the saved results in history.
  const review = page.locator('[data-qa-review]')
  await expect(review).toContainText('All steps recorded')
  await review.getByRole('button', { name: 'Finish session…' }).click()
  await review.getByRole('button', { name: 'Finish session', exact: true }).click()
  const done = page.locator('[data-run]')
  await expect(done).toContainText('Failed')
  await expect(done.locator('[data-test="calendar-recovery.notice"]')).toHaveAttribute('data-result', 'pass')
  await expect(done.locator('[data-test="calendar-recovery.notice"] [data-usability="simplify"]')).toContainText('Simplify · The notice repeats itself.')
  await expect(done.locator('[data-test="calendar-recovery.reconnect"]')).toHaveAttribute('data-result', 'fail')
  await expect(done.locator('[data-test="calendar-recovery.resolved"]')).toHaveAttribute('data-result', 'blocked')
  await expect(done.locator('[data-finding="defect"]')).toContainText('Times lag after reconnect.')
  // A finished session can't be reopened for editing: its old URL shows the review.
  await page.goto(sessionUrl)
  await expect(page.locator('[data-run]')).toBeVisible()
  await page.goto('/admin/control?view=qa&tab=manual')
  await expect(page.locator('[data-qa-human]').first()).toContainText('Calendar connection recovery')
})

test('navigation: side nav, metrics, Back, keyboard, account search, integrations, platform-wide incident, refusals', async ({ page, context, request, browser }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  // A platform-wide failure (a signed-but-invalid Twilio webhook): no business, platform next step.
  await request.post('/api/sms/twilio/inbound', { headers: { 'X-Twilio-Signature': 'bad', 'Content-Type': 'application/x-www-form-urlencoded' }, data: 'From=%2B15550100&Body=hi&MessageSid=SMnav1' })
  await request.post('/api/cron/run', { headers: { Authorization: `Bearer ${fixtures.E2E_CRON_SECRET}` } })
  await page.goto('/admin/control')
  await expect(page.getByRole('heading', { name: 'Control Center', level: 1 })).toBeVisible()
  await expect(page.locator('[data-overview-status]')).toBeVisible()
  // Never "nothing needs attention" while an incident is open.
  await expect(page.locator('[data-attention-empty]')).toHaveCount(0)
  // Metric → filtered list.
  await page.locator('[data-metric="Open incidents"]').click()
  await expect(page).toHaveURL(/view=incidents$/)
  await expect(page.getByRole('heading', { name: 'Incidents', level: 1 })).toBeVisible()
  const platform = page.locator('[data-incident][data-kind="failure"]').filter({ hasText: 'Text-message webhook refused a request' }).first()
  await expect(platform).toContainText('Platform-wide')
  await platform.click()
  const d = page.locator('[data-incident-detail]')
  await expect(d).toContainText('Platform-wide (no single business)')
  await expect(d.locator('[data-triage]')).toContainText('Twilio Console')
  await expect(d).not.toContainText('this business')
  await expect(d.getByRole('link', { name: 'Open account' })).toHaveCount(0)
  // Back twice → Overview.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Incidents', level: 1 })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Control Center', level: 1 })).toBeVisible()

  // Keyboard: focus the side nav, Enter opens Accounts; search finds a business by name; Enter opens it.
  await page.locator('[data-nav="accounts"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible()
  await expect(page.locator('[data-nav="accounts"]')).toHaveAttribute('aria-current', 'page')
  await page.getByLabel('Search accounts').fill('control demo')
  await expect(page.locator('[data-account-row]')).toHaveCount(1)
  await page.locator(`[data-account-row="${C}"]`).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(`[data-account="${C}"]`)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Control Demo Pools', level: 1 })).toBeFocused()
  // Breadcrumb back to the list; the "Test accounts" filter keeps only test businesses.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Accounts' }).click()
  await page.getByRole('button', { name: 'Test accounts' }).click()
  await expect(page.locator('[data-account-row]').first()).toContainText('Test account')

  // Integrations: every row opens a detail page with an evidence-based state.
  await page.locator('[data-nav="integrations"]').click()
  const row = page.locator('[data-capability="calendar.google"]')
  const state = await row.getAttribute('data-state')
  expect(['healthy', 'degraded', 'failed', 'disabled', 'setup_required', 'testing', 'unknown']).toContain(state)
  await row.click()
  const integ = page.locator('[data-integration="calendar.google"]')
  await expect(integ).toHaveAttribute('data-state', state)
  await expect(integ).toContainText('Last success')
  await expect(integ).toContainText('Diagnose calendar (read-only)')

  // Founder alerts are off (as in production): status shown, no test button.
  await page.locator('[data-nav="overview"]').click()
  const alerts = page.locator('[data-alerts]')
  await expect(alerts).toHaveAttribute('data-alerts', 'off')
  await expect(alerts).toContainText(/Off\s*\d+ of \d+ admins? would receive alerts now/)
  await expect(alerts.getByRole('button', { name: 'Send test alert' })).toHaveCount(0)

  // Refusals: an owner gets 403, a signed-out visitor 401 (API) and the sign-in gate (page).
  const owner = await browser.newContext()
  await useSession(owner, fixtures.E2E_SESSION_TOKEN)
  const op = await owner.newPage()
  expect((await op.request.get('/api/platform/control')).status()).toBe(403)
  expect((await op.request.get('/api/platform/incidents?id=inc_abcdefghijkl')).status()).toBe(403)
  await op.goto('/admin/control')
  await expect(op.getByRole('heading', { name: 'No platform access' })).toBeVisible()
  await owner.close()
  const anon = await browser.newContext()
  const ap = await anon.newPage()
  expect((await ap.request.get(`/api/platform/inspector?business=${C}`)).status()).toBe(401)
  await ap.goto('/admin/control')
  await expect(ap.getByRole('heading', { name: 'Platform sign-in' })).toBeVisible()
  await anon.close()
})

test('Control Center at phone width: no sideways scroll; nav, incident, account and QA usable @mobile', async ({ page, context }) => {
  await useSession(context, fixtures.E2E_ADMIN_SESSION_TOKEN)
  await page.goto('/admin/control')
  await expect(page.getByRole('heading', { name: 'Control Center', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  // No real-person activation run exists: the dashboard says so (never derived from automated tests).
  await expect(page.locator('[data-overview-activation]')).toHaveAttribute('data-overview-activation', 'not-measured')
  await expect(page.locator('[data-overview-activation]')).toContainText('Not measured yet')
  await expect(page.locator('[data-alerts]')).toHaveAttribute('data-alerts', 'off')
  await noSideScroll(page)
  await page.locator('[data-nav="accounts"]').click()
  await page.getByLabel('Search accounts').fill('Control Demo')
  await page.getByRole('link', { name: 'Open Control Demo Pools' }).click()
  await expect(page.getByRole('heading', { name: /Journey:/ })).toBeVisible()
  await noSideScroll(page)
  await page.locator('[data-nav="incidents"]').click()
  await expect(page.getByRole('heading', { name: 'Incidents', level: 1 })).toBeVisible()
  await noSideScroll(page)
  await page.locator('[data-nav="qa"]').click()
  await page.locator('[data-qa-subnav="manual"]').click()
  await expect(page.locator('[data-qa-journey="booking"]')).toBeVisible()
  await page.locator('[data-qa-journey="booking"]').getByRole('button', { name: /Start guided QA/ }).click()
  await page.locator('[data-start="booking"]').getByRole('button', { name: 'Begin' }).click()
  const step = page.locator('[data-qa-step="page"]')
  await expect(step).toBeVisible()
  await noSideScroll(page)
  await step.getByRole('radio', { name: 'Not tested', exact: true }).check()
  await step.getByRole('button', { name: 'Save and continue →' }).click()
  await expect(page.locator('[data-qa-step="details"]')).toBeVisible()
  await page.getByRole('button', { name: 'Pause session' }).click()
  await expect(page.locator('[data-qa-running]').first()).toBeVisible()
  await noSideScroll(page)
})
