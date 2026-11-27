// A realistic FICTIONAL platform for the admin assistant: unit tests (test/admin-assistant.test.js) and the real-model
// evaluation (scripts/admin-assistant-eval.mjs, dumped to SQL for a local server) seed exactly this. Every name, address
// and number is made up; nothing comes from production. Billing is Stripe TEST mode throughout (subscription_modes 0).
//   blue-lagoon-pools    live, active (test mode), busy, referred by partner Pool Pros Network
//   sunny-side-spa       live, payment failed (test mode) 3 days ago
//   coastal-electric     hours set but Google Calendar DISCONNECTED, active (test mode), open high incident
//   maple-street-hvac    owner signed in 5 days ago, calendar never connected (setup stalled), referred by the partner
//   pine-ridge-plumbing  live, cancellation scheduled, no booking for 20 days
//   riverbend-landscaping owner invitation sent 6.5 days ago, expires in 12 hours
//   harbor-pool-care     assisted enrollment, ownership invitation EXPIRED 2 days ago
//   oak-tree-cleaning    assisted enrollment, payment link sent 18 days ago, never paid (stuck)
//   lakeside-movers      assisted enrollment, paid 10 days ago, still configuring (not handed over)
//   sandbox-test-co      admin-marked TEST business with its own problems (must never be counted)
// Plus: a medium platform incident, a reconciliation with 1 real mismatch, an outreach follow-up due, AI costs yesterday.
import { appendAudit } from '../../server/auditlog.js'
import { storeResults } from '../../server/ops/qa-results.js'
import { changeStatus, createItem } from '../../server/ops/qa-items.js'

export const DAY = 86_400_000
export const CALENDARS = ['blue-lagoon-pools', 'sunny-side-spa', 'pine-ridge-plumbing', 'lakeside-movers', 'sandbox-test-co']
export const ADMIN = 'founder@getshowups.example'
export const NAMES = {
  'blue-lagoon-pools': 'Blue Lagoon Pools', 'sunny-side-spa': 'Sunnyside Day Spa', 'coastal-electric': 'Coastal Electric', 'maple-street-hvac': 'Maple Street HVAC',
  'pine-ridge-plumbing': 'Pine Ridge Plumbing', 'riverbend-landscaping': 'Riverbend Landscaping', 'harbor-pool-care': 'Harbor Pool Care', 'oak-tree-cleaning': 'Oak Tree Cleaning',
  'lakeside-movers': 'Lakeside Movers', 'sandbox-test-co': 'Sandbox Test Co',
}
export const ENROLLMENTS = { harbor: 'enr_HarborPoolCare01', oak: 'enr_OakTreeCleaning1', lakeside: 'enr_LakesideMovers01', northside: 'enr_NorthsideTutors1' }
export const PARTNERS = { pros: 'prt_poolprosnetwork', trade: 'prt_tradealliance' }

export async function seedAdminFixture(db, now = Date.now()) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run()
  const ago = (d) => now - d * DAY
  const biz = async (id, { created, hours = true, via = 'self_serve', status = 'active' }) => run("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_via, status, created_at, updated_at) VALUES (?1, ?2, 'America/New_York', ?3, ?4, ?5, ?6, ?6)", id, NAMES[id], hours ? ago(created - 1) : null, via, status, ago(created))
  await biz('blue-lagoon-pools', { created: 120 })
  await biz('sunny-side-spa', { created: 90 })
  await biz('coastal-electric', { created: 60 })
  await biz('maple-street-hvac', { created: 5, hours: false })
  await biz('pine-ridge-plumbing', { created: 150 })
  await biz('riverbend-landscaping', { created: 7, hours: false, via: 'admin_invite' })
  await biz('harbor-pool-care', { created: 21 })
  await biz('oak-tree-cleaning', { created: 18, hours: false })
  await biz('lakeside-movers', { created: 12, hours: false })
  await biz('sandbox-test-co', { created: 30 })
  for (const id of ['blue-lagoon-pools', 'sunny-side-spa', 'coastal-electric', 'maple-street-hvac', 'pine-ridge-plumbing', 'sandbox-test-co']) await run('INSERT INTO customer_users (email, customer, created_at) VALUES (?1, ?2, ?3)', `owner@${id}.example`, id, ago(5))
  await run("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('sandbox-test-co', 1, ?1, ?2)", ADMIN, ago(29))
  for (const id of ['oak-tree-cleaning', 'lakeside-movers', 'harbor-pool-care']) await run("INSERT INTO self_signups (customer, plan_id, created_at) VALUES (?1, 'founding', ?2)", id, ago(18))
  // Subscriptions: all Stripe TEST mode.
  const sub = async (id, status, { cancel = 0 } = {}) => {
    await run("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, cancel_at_period_end, last_event_at, updated_at) VALUES (?1, ?2, ?3, 'founding', ?4, 49900, 'usd', ?5, ?6, ?7, ?7)", id, `cus_test_${id}`, `sub_test_${id}`, status, now + 12 * DAY, cancel, ago(3))
    await run('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?1, 0, ?2)', id, ago(3))
  }
  await sub('blue-lagoon-pools', 'active')
  await sub('sunny-side-spa', 'past_due')
  await sub('coastal-electric', 'active')
  await sub('pine-ridge-plumbing', 'active', { cancel: 1 })
  await sub('lakeside-movers', 'active')
  await sub('harbor-pool-care', 'active')
  await sub('sandbox-test-co', 'active')
  await run("INSERT INTO events (id, type, customer, at, props) VALUES ('fx:pf1', 'payment_failed', 'sunny-side-spa', ?1, '{}')", ago(3))
  await run("INSERT INTO events (id, type, customer, at, props) VALUES ('fx:pf2', 'payment_failed', 'sandbox-test-co', ?1, '{}')", ago(2))
  for (const [i, id] of ['blue-lagoon-pools', 'coastal-electric', 'lakeside-movers'].entries()) await run("INSERT INTO events (id, type, customer, at, props) VALUES (?1, 'revenue', ?2, ?3, ?4)", `fx:rev${i}`, id, Math.max(now - (now % DAY) - (i + 1) * 3600_000, ago(1)), JSON.stringify({ amountCents: 49900, currency: 'usd', livemode: false }))
  for (const [i, id] of Object.keys(NAMES).entries()) await run("INSERT INTO events (id, type, customer, at, props) VALUES (?1, 'business_created', ?2, ?3, '{}')", `fx:bc${i}`, id, ago([120, 90, 60, 5, 150, 7, 21, 18, 12, 30][i]))
  // Receptionist on for two businesses.
  for (const [id, on] of [['blue-lagoon-pools', 1], ['sunny-side-spa', 1], ['coastal-electric', 0], ['pine-ridge-plumbing', 0]]) await run('INSERT INTO receptionist_settings (customer, enabled, updated_at) VALUES (?1, ?2, ?3)', id, on, ago(10))
  // Leads and bookings (fictional people; the assistant must never see these names or numbers).
  let n = 0
  const lead = async (c, d, booked, apptDaysAgo = null) => {
    const id = `fx-lead-${n++}`
    await run("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?1, ?2, 'Jordan Fictional', ?3, '8435550199', 'Weekly service', ?4, 'x', ?5, ?5)", id, c, `${id}@customer.example`, booked ? 'booked' : 'new', ago(d))
    if (booked) await run("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'booked', ?6, ?6)", `fx-appt-${n}`, c, id, ago(apptDaysAgo) + 3600_000, ago(apptDaysAgo) + 7200_000, ago(apptDaysAgo))
  }
  for (const d of [1, 2, 4, 6, 9, 15]) await lead('blue-lagoon-pools', d, d < 10, d)
  for (const d of [5, 8, 12]) await lead('coastal-electric', d, d < 10, d)
  for (const d of [9, 25]) await lead('sunny-side-spa', d, d === 9, d)
  await lead('pine-ridge-plumbing', 40, true, 20)
  await lead('sandbox-test-co', 2, true, 2)
  // Invitations: riverbend's open one expires in 12 hours; harbor's (assisted) expired 2 days ago.
  await run("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at, sent_count, kind) VALUES ('invRiverbend0001', 'fxhash1', 'owner@riverbend.example', 'riverbend-landscaping', ?1, ?2, ?3, 1, 'invite')", ADMIN, ago(6.5), now + 0.5 * DAY).catch(() => run("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at, sent_count) VALUES ('invRiverbend0001', 'fxhash1', 'owner@riverbend.example', 'riverbend-landscaping', ?1, ?2, ?3, 1)", ADMIN, ago(6.5), now + 0.5 * DAY))
  await run("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at, sent_count) VALUES ('invHarborClaim01', 'fxhash2', 'owner@harbor.example', 'harbor-pool-care', ?1, ?2, ?3, 1)", ADMIN, ago(9), ago(2))
  // Assisted enrollments.
  const enr = (id, customer, name, stage, f = {}) =>
    run(
      'INSERT INTO assisted_enrollments (id, customer, business_name, owner_name, owner_email, phone, notes, plan_id, stage, created_by, created_at, updated_at, workspace_at, payment_sent_at, payment_sends, paid_at, config_started_at, invite_id, invited_at, claimed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)',
      id, customer, name, 'Fictional Owner', `owner@${id}.example`, '8435550142', 'Prefers calls after 5pm', 'founding', stage, ADMIN, f.created, f.updated ?? f.created, f.workspace ?? null, f.paymentSent ?? null, f.sends ?? 0, f.paid ?? null, f.config ?? null, f.invite ?? null, f.invited ?? null, f.claimed ?? null,
    )
  await enr(ENROLLMENTS.harbor, 'harbor-pool-care', 'Harbor Pool Care', 'invited', { created: ago(21), updated: ago(9), workspace: ago(21), paymentSent: ago(20), sends: 1, paid: ago(19), config: ago(15), invite: 'invHarborClaim01', invited: ago(9) })
  await enr(ENROLLMENTS.oak, 'oak-tree-cleaning', 'Oak Tree Cleaning', 'payment_sent', { created: ago(18), updated: ago(17), workspace: ago(18), paymentSent: ago(17), sends: 2 })
  await enr(ENROLLMENTS.lakeside, 'lakeside-movers', 'Lakeside Movers', 'configuring', { created: ago(12), updated: ago(9), workspace: ago(12), paymentSent: ago(11), sends: 1, paid: ago(10), config: ago(9) })
  await enr(ENROLLMENTS.northside, null, 'Northside Tutors', 'prospect', { created: ago(3) })
  // Partners and commissions (test mode: never owed).
  await run("INSERT INTO referral_partners (id, name, contact_email, code, status, payout_reference, created_by, created_at, updated_at) VALUES (?1, 'Pool Pros Network', 'partner@poolpros.example', 'poolpros01', 'active', 'Bank ending 4242', ?2, ?3, ?3)", PARTNERS.pros, ADMIN, ago(130))
  await run("INSERT INTO partner_terms (partner_id, version, terms, effective_from, created_by, created_at) VALUES (?1, 1, ?2, ?3, ?4, ?3)", PARTNERS.pros, JSON.stringify({ type: 'percent', value: 20, recurring: 'months:12', windowDays: 90 }), ago(130), ADMIN)
  await run("INSERT INTO referral_partners (id, name, contact_email, code, status, created_by, created_at, updated_at) VALUES (?1, 'Trade Alliance', 'hello@tradealliance.example', 'tradeall01', 'paused', ?2, ?3, ?3)", PARTNERS.trade, ADMIN, ago(40))
  for (const id of ['blue-lagoon-pools', 'maple-street-hvac']) await run("INSERT INTO commercial_attribution (customer, channel, marketing_source, partner_id, created_at) VALUES (?1, 'partner', 'partner', ?2, ?3)", id, PARTNERS.pros, ago(100))
  for (const [i, at] of [ago(40), ago(10)].entries()) await run("INSERT INTO commission_ledger (partner_id, customer, kind, stripe_object_id, amount_cents, currency, basis_cents, paid_cents, livemode, rule, created_at) VALUES (?1, 'blue-lagoon-pools', 'accrual', ?2, 9980, 'usd', 49900, 49900, 0, ?3, ?4)", PARTNERS.pros, `in_test_${i}`, JSON.stringify({ type: 'percent', value: 20, recurring: 'months:12', windowDays: 90 }), at)
  // Incidents: coastal's calendar (high), a platform email failure (medium), and one on the test business.
  const inc = (id, customer, feature, kind, code, severity, first, isTest = 0, step = 'availability') => run("INSERT INTO ops_incidents (id, fingerprint, customer, feature, journey, step, kind, code, severity, cause, status, is_test, evidence, occurrences, first_seen, last_seen, detected_at) VALUES (?1, ?2, ?3, ?4, 'booking', ?11, ?5, ?6, ?7, 'unknown', 'open', ?8, '{}', 4, ?9, ?10, ?9)", id, `fx:${id}`, customer, feature, kind, code, severity, isTest, ago(first), ago(0.2), step)
  await inc('inc_coastal_cal', 'coastal-electric', 'calendar.google', 'availability', 'invalid_grant', 'high', 3)
  await inc('inc_email_plat', null, 'messaging.email', 'failure', 'provider_error', 'medium', 2, 0, 'confirmation')
  await inc('inc_sandbox', 'sandbox-test-co', 'calendar.google', 'availability', 'invalid_grant', 'critical', 1, 1)
  // Billing reconciliation yesterday: one real mismatch.
  await appendAudit(db, { actorType: 'system', actor: 'system:reconcile', action: 'billing.reconciliation', at: ago(1), details: { ok: true, at: ago(1), checked: { subscriptions: 6, records: 6, invoices: 3, windowDays: 35, live: false }, issues: 2, real: 1, byType: { status_mismatch: 1, missing_here: 1 }, byScope: { real: 1, test_business: 1 }, list: [], applied: [] } })
  // Acquisition: one outreach email sent 6 days ago (follow-up due), one replied, one approved.
  for (const [code, status, sent] of [['out-01', 'sent', 6], ['out-02', 'replied', 9], ['out-03', 'approved', null]]) await run("INSERT INTO acquisition_codes (code, activity, label, status, cost_cents, approved_at, sent_at, replied_at, updated_at) VALUES (?1, 'email-local', '', ?2, 0, ?3, ?4, ?5, ?3)", code, status, ago(10), sent ? ago(sent) : null, status === 'replied' ? ago(5) : null)
  // AI costs yesterday (UTC): owner assistant 6 questions, receptionist 3 conversations, website AI 1 generation.
  const y = now - (now % DAY) - DAY + 3600_000 // 01:00 UTC yesterday
  for (let i = 0; i < 6; i++) await run("INSERT INTO events (id, type, customer, at, props) VALUES (?1, 'ai_ask', 'blue-lagoon-pools', ?2, ?3)", `fx:ai${i}`, y + i * 60_000, JSON.stringify({ ok: true, costMicros: 2100, tools: ['list_leads'] }))
  for (let i = 0; i < 3; i++) await run("INSERT INTO receptionist_conversations (id, customer, channel, status, cost_micros, created_at, updated_at) VALUES (?1, 'blue-lagoon-pools', 'chat', 'closed', 4500, ?2, ?2)", `fx-conv-${i}`, y + i * 60_000)
  await run("INSERT INTO website_generations (id, customer, content, source, model, cost_micros, created_at) VALUES ('fx-gen-1', 'coastal-electric', '{}', 'ai', 'fixture', 12000, ?1)", y)
  await seedQaFixture(db, now).catch((err) => {
    if (!/no such table/.test(String(err?.message))) throw err // before 0051: no QA records
  })
  return { now }
}

// The KV the calendar check lists (server/metrics.js connectedCalendars).
export const fakeTokens = (ids = CALENDARS) => ({
  get: async (k) => (ids.includes(k.replace(/^google:/, '')) ? '{}' : null),
  list: async ({ prefix }) => ({ keys: ids.map((id) => ({ name: `${prefix}${id}` })), list_complete: true }),
  put: async () => {},
  delete: async () => {},
})

// ---------- QA Command Center (fictional): the deployed release, results before and after it, defects and backlog ----------
// Release f00dfee yesterday (previous c0ffee0). After it: 4 unit tests and 2 production checks passed; the settings browser
// test and the homepage production check FAILED; a booking unit test needs a retest (stale); a guided step was verified.
// Before it: two booking browser tests passed on the previous commit (impact unknown now). A paid admin evaluation cost
// $0.012 this month; paid evaluations are off (no QA budget). Defects: one high (booking), one medium (settings). Backlog:
// two near-duplicate texting ideas, a performance, a cost and a deferred AI idea.
export const QA_RELEASE = { commit: 'f00dfeed1234567890abcdef1234567890abcdef', previous: 'c0ffee00abcdef1234567890abcdef1234567890' }
export const QA_TESTS = {
  verified: ['unit:acceptance:4b41f4a967', 'unit:acceptance:5a40390ff6', 'unit:acceptance:df700da301', 'unit:acceptance:48ccfdae52'],
  failedAfter: ['e2e:account:ebadee7e16', 'prod:homepage'],
  stale: 'unit:booking-excellence:0e6c201238',
}
export async function seedQaFixture(db, now = Date.now()) {
  const ago = (d) => now - d * DAY
  const cur = QA_RELEASE.commit.slice(0, 12)
  const prev = QA_RELEASE.previous.slice(0, 12)
  await db.prepare('SELECT 1 FROM qa_items LIMIT 1').first()
  await appendAudit(db, { actorType: 'system', actor: 'system:cron', action: 'platform.release', at: ago(1), details: { commit: QA_RELEASE.commit, previous: QA_RELEASE.previous, pendingMigrations: [] } })
  await storeResults(db, [{ testId: 'e2e:booking-excellence:55600b50c6', status: 'pass' }, { testId: 'e2e:booking-excellence:d8396ff257', status: 'pass' }, { testId: QA_TESTS.stale, status: 'pass' }], { environment: 'ci', revision: prev }, ago(3))
  await storeResults(db, QA_TESTS.verified.map((testId) => ({ testId, status: 'pass', ms: 900 })), { environment: 'ci', revision: cur }, ago(0.8))
  await storeResults(db, [{ testId: 'prod:build-commit', status: 'pass' }, { testId: 'prod:edge-headers', status: 'pass' }], { environment: 'production', revision: cur }, ago(0.7))
  await storeResults(db, [{ testId: QA_TESTS.stale, status: 'retest_required' }], { environment: 'ci', revision: cur }, ago(0.6))
  await storeResults(db, [{ testId: 'e2e:account:ebadee7e16', status: 'fail', expected: 'Save works after the recent sign-in prompt', actual: 'The Save button stayed disabled after the recent sign-in prompt' }], { environment: 'ci', revision: cur }, ago(0.5))
  await storeResults(db, [{ testId: 'prod:homepage', status: 'fail', expected: 'Status 200', actual: 'Status 503 from the edge' }], { environment: 'production', revision: cur }, ago(0.4))
  await storeResults(db, [{ testId: 'human:activation.offer', status: 'pass', reviewer: 'ref:fixture' }], { environment: 'manual', revision: cur }, ago(0.9))
  await storeResults(db, [{ testId: 'eval:admin:week', status: 'pass', costMicros: 12000, model: 'claude-haiku-5-5', provider: 'real' }], { environment: 'local', revision: cur }, ago(0.3))
  await db.prepare("INSERT INTO qa_executions (id, requested_by, requested_at, environment, preset, scope, estimate, status, revision, progress, started_at, finished_at, updated_at) VALUES ('qx_fixtureallsafe', 'ref:fixture', ?1, 'ci', 'all_safe', '{}', '{}', 'partial', ?2, ?3, ?1, ?4, ?4)").bind(ago(0.8), cur, JSON.stringify({ done: 7, total: 7, pass: 6, fail: 1 }), ago(0.5)).run()
  const add = async (b, status = null) => {
    const r = await createItem(db, b, 'ref:fixture', ago(2))
    if (r.error) throw new Error(`fixture item: ${r.error}`)
    if (status) await changeStatus(db, { id: r.item.id, status }, 'ref:fixture', ago(1.5))
    return r.item.id
  }
  const ids = {}
  ids.booking = await add({ kind: 'bug', title: 'Booking page shows no open times after a calendar reconnect', area: 'booking', severity: 'high', customerImpact: 'Customers can’t book until the owner reconnects a second time', steps: '1. Disconnect Google Calendar. 2. Reconnect. 3. Open the booking page.', testIds: ['e2e:booking-excellence:d8396ff257'] })
  ids.settings = await add({ kind: 'regression', title: 'Settings save stays disabled after the recent sign-in prompt', area: 'business_settings', severity: 'medium', testIds: ['e2e:account:ebadee7e16'] })
  ids.textBack = await add({ kind: 'feature', title: 'Let owners text back new inquiries from the dashboard', area: 'messaging' })
  ids.smsReply = await add({ kind: 'feature', title: 'Reply to inquiries by SMS from the dashboard', area: 'messaging' }, 'under_review')
  ids.fast = await add({ kind: 'performance', title: 'Make the Overview cards load faster on phones', area: 'layouts' }, 'planned')
  ids.cheap = await add({ kind: 'cost', title: 'Use a cheaper model for after-hours receptionist chats', area: 'receptionist' })
  ids.nextTwo = await add({ kind: 'ai', title: 'Receptionist should offer the next two open times, not one', area: 'receptionist', customerImpact: 'Fewer back-and-forth messages before booking' }, 'deferred')
  return ids
}
