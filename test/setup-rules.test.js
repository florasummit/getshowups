// Guided setup rules (src/dashboard/setup-rules.js): where appointments happen by default (ONB-06), Back / Continue /
// progress-bar navigation (ONB-08), and the decisions offered on the finished screen (ONB-04), checked against the same
// server functions the dashboard's setup check and Settings use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDUSTRIES, SELF_SERVE_STEPS, acceptDecision, setupDecisions, stepPosition, visitsCustomers } from '../src/dashboard/setup-rules.js'
import { validateBookingRules } from '../server/booking-rules.js'
import { holidays } from '../server/dates.js'
import { isStale } from '../server/stale.js'

test('a trade that goes to the customer preselects "At the customer’s home or site"; others leave "At my location"', () => {
  for (const i of INDUSTRIES) assert.equal(visitsCustomers(i), true, i)
  for (const i of ['pool service & repair', 'Air conditioning repair', 'roofing contractor', 'Lawn & garden care', 'maid service']) assert.equal(visitsCustomers(i), true, i)
  for (const i of ['', '   ', 'Day spa', 'Hair salon', 'Dental office', 'Tax preparation', 'Law firm', 'Yoga studio', 'Bakery']) assert.equal(visitsCustomers(i), false, i)
  // A spa is wellness (customers come in) even though "spa" is also pool vocabulary.
  assert.equal(visitsCustomers('Med spa'), false)
  assert.equal(visitsCustomers('Hot tub and spa service'), true)
})

const steps = (doneCount) => SELF_SERVE_STEPS.map((id, i) => ({ id, done: i < doneCount }))

test('Back from step N and Continue walks forward through the same steps, never skipping to the first unfinished one', () => {
  const s = steps(5) // business … calendar done; hours (index 5) is next
  let p = stepPosition(s, null)
  assert.deepEqual([p.current, p.index, p.frontier, p.next], ['hours', 5, 5, null])
  // Two Backs: hours → calendar → services.
  let editing = p.back
  assert.equal(editing, 'calendar')
  p = stepPosition(s, editing)
  editing = p.back
  assert.equal(editing, 'services')
  p = stepPosition(s, editing)
  assert.equal(p.current, 'services')
  // Continue twice returns through calendar to hours (null = the first unfinished step).
  editing = p.next
  assert.equal(editing, 'calendar')
  editing = stepPosition(s, editing).next
  assert.equal(editing, null)
  assert.equal(stepPosition(s, editing).current, 'hours')
})

test('every step from 2 on has Back; step 1 has none; only reached steps can be opened from the progress bar', () => {
  for (let done = 1; done <= SELF_SERVE_STEPS.length - 1; done++) {
    const p = stepPosition(steps(done), null)
    assert.equal(p.back, SELF_SERVE_STEPS[done - 1], `step ${done + 1} goes back to step ${done}`)
  }
  assert.equal(stepPosition(steps(0), null).back, undefined)
  assert.equal(stepPosition(steps(3), 'business').back, undefined)
  const p = stepPosition(steps(4), 'details')
  assert.deepEqual(SELF_SERVE_STEPS.map((_, i) => p.canOpen(i)), [true, true, false, true, true, false, false, false, false, false], 'done steps and the first unfinished one; not the one on screen; nothing ahead')
  assert.equal(p.target(4), null, 'the first unfinished step is "no step being revisited"')
  assert.equal(p.target(1), 'payment')
  // A step id that is ahead of the owner (or unknown) is ignored.
  assert.equal(stepPosition(steps(4), 'publish').current, 'calendar')
  assert.equal(stepPosition(steps(4), 'nope').current, 'calendar')
  // Everything done: the finished screen; Back and the bar still reach every earlier step.
  const end = stepPosition(steps(10), null)
  assert.deepEqual([end.current, end.back], ['launch', 'publish'])
})

test('the finished screen offers what the setup check would raise, and accepting one changes only that', () => {
  const today = '2026-11-20'
  const suggested = holidays(today, 90) // what GET /api/dashboard/availability returns for a business open every day
  assert.ok(suggested.some((h) => h.date === '2026-11-26') && suggested.some((h) => h.date === '2026-12-25'))
  const availability = { ready: true, today, minNoticeMinutes: 0, closures: [{ date: '2026-12-01', label: 'Family day' }], suggested }
  const d = setupDecisions(availability)
  assert.deepEqual(d.map((x) => x.id), ['holiday:2026-11-26', 'notice'], 'the same 21 days as server/setup-check.js: Thanksgiving yes, Christmas not yet')
  assert.deepEqual(holidays(today, 21).map((h) => `holiday:${h.date}`), d.filter((x) => x.kind === 'holiday').map((x) => x.id))
  // Close the holiday: the existing closed date and the notice stay as they are.
  const close = acceptDecision(availability, d[0])
  assert.deepEqual(close.closures, [{ date: '2026-11-26', label: d[0].label }, { date: '2026-12-01', label: 'Family day' }])
  assert.equal(close.minNoticeMinutes, 0)
  assert.equal(validateBookingRules(close, today)[0], null, 'accepted by the server validation Settings uses')
  assert.equal(isStale(close, { minNoticeMinutes: 0, closures: availability.closures }), false, 'sent with the version it was based on')
  assert.equal(isStale(close, { minNoticeMinutes: 60, closures: availability.closures }), true, 'changed elsewhere meanwhile → refused, never overwritten')
  // Require notice: 2 hours, closed dates untouched.
  const notice = acceptDecision(availability, d[1])
  assert.deepEqual([notice.minNoticeMinutes, notice.closures], [120, availability.closures])
  assert.equal(validateBookingRules(notice, today)[0], null)
  // Nothing to decide: notice already set, no holiday soon, or the feature not ready.
  assert.deepEqual(setupDecisions({ ...availability, minNoticeMinutes: 120, suggested: suggested.filter((h) => h.date > '2026-12-20') }), [])
  assert.deepEqual(setupDecisions({ ...availability, ready: false }), [])
  assert.deepEqual(setupDecisions(null), [])
})
