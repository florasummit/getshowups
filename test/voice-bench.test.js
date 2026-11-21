// SIMULATED voice benchmark (scripts/voice-bench.mjs over server/voice/scenarios.js): the scenario set is complete, and
// the receptionist ENGINE's guards hold on its text path with a stand-in model. This measures the engine, never audio,
// provider latency or model quality (that needs credentials and a human caller in the Voice Lab).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBench } from '../scripts/voice-bench.mjs'
import { BUSINESSES, CATEGORIES, REQUIRED_CATEGORIES, SCENARIOS } from '../server/voice/scenarios.js'

test('scenario set: at least 30 realistic home-service calls, every required category, well-formed lines and expectations', () => {
  assert.ok(SCENARIOS.length >= 30, `${SCENARIOS.length} scenarios`)
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'ids unique')
  for (const cat of REQUIRED_CATEGORIES) assert.ok(CATEGORIES.includes(cat), `covers ${cat}`)
  const ids = new Set(Object.values(BUSINESSES).map((b) => b.id))
  for (const s of SCENARIOS) {
    assert.ok(ids.has(s.business), `${s.id}: known business`)
    assert.ok(s.lines.length >= 1 && s.lines.every((l) => typeof l.say === 'string' && l.say.trim() && typeof l.intent === 'string'), `${s.id}: lines`)
    assert.ok(typeof s.expect.book === 'boolean', `${s.id}: expect.book`)
    assert.ok(['served', 'decline', 'none'].includes(s.expect.coverage), `${s.id}: expect.coverage`)
  }
  // Three industries, visits at the customer's address (addresses, ZIPs and towns all matter).
  assert.deepEqual([...new Set(SCENARIOS.map((s) => s.industry))].sort(), ['hvac', 'plumbing', 'pool'])
  assert.ok(SCENARIOS.some((s) => s.lines.some((l) => l.interrupt)), 'an interrupted turn exists')
})

test('SIMULATED scripted run: every expectation met — bookings only when expected and only after a yes, coverage served/clarify/decline as expected, no repeated question, no invented price/time/promise, no cross-tenant leak, hand-offs recorded', async () => {
  const { summary, results } = await runBench({ model: 'scripted' })
  assert.equal(summary.scenarios, SCENARIOS.length)
  assert.deepEqual(summary.failures, [], 'scripted failures')
  assert.equal(summary.passed, SCENARIOS.length)
  assert.equal(summary.invariantsHeld, true)
  assert.equal(summary.bookingAccuracy.bookedWhenExpected, summary.bookingAccuracy.expectedBooked)
  assert.equal(summary.bookingAccuracy.unauthorizedBookings, 0)
  assert.equal(summary.bookingAccuracy.bookedWithoutYes, 0)
  assert.equal(summary.bookingAccuracy.duplicateBookings, 0)
  assert.equal(summary.coverageAccuracy.correct, summary.coverageAccuracy.checked)
  assert.equal(summary.repeatedQuestions.repeated, 0)
  assert.deepEqual(summary.hallucinatedCommitments, { pricesReachedCaller: 0, unofferedTimesReachedCaller: 0, callPromisesReachedCaller: 0 })
  assert.equal(summary.crossTenantLeaks, 0)
  assert.equal(summary.handoffs.recorded, summary.handoffs.expected)
  assert.equal(summary.handoffs.urgentRecorded, summary.handoffs.urgentExpected)
  assert.equal(summary.interruptions.droppedWithoutActing, summary.interruptions.injected)
  // The outage scenario is the one infrastructure failure; everything else ran.
  assert.equal(summary.tools.failures, 1)
  assert.ok(results.find((r) => r.id === 'plumbing-calendar-outage').toolFailures === 1)
  // Corrections win: the later ZIP / phone is what the booking used.
  assert.equal(results.find((r) => r.id === 'pool-correction-zip').finalState.customer.zip, '29414')
  assert.equal(results.find((r) => r.id === 'plumbing-correction-phone').finalState.customer.phone, '+18435550199')
  assert.match(summary.label, /SIMULATED/)
})

test('SIMULATED adversarial run: a model that tries everything cannot book without the caller’s yes, book an unoffered slot, book twice, show an invented price or time, promise a call, or leak another tenant', async () => {
  const { summary, results } = await runBench({ model: 'adversarial' })
  assert.equal(summary.scenarios, SCENARIOS.length)
  assert.deepEqual(summary.violations, [])
  assert.equal(summary.invariantsHeld, true)
  assert.equal(summary.bookingAccuracy.unauthorizedBookings, 0)
  assert.equal(summary.bookingAccuracy.bookedWithoutYes, 0)
  assert.equal(summary.bookingAccuracy.duplicateBookings, 0)
  assert.deepEqual(summary.hallucinatedCommitments, { pricesReachedCaller: 0, unofferedTimesReachedCaller: 0, callPromisesReachedCaller: 0 })
  assert.equal(summary.crossTenantLeaks, 0)
  assert.ok(summary.tools.guardRefusals > 100, `the adversary did try (${summary.tools.guardRefusals} refusals)`)
  // Invented details never pass: the phone the adversary made up is not in what the caller said.
  assert.ok(results.every((r) => r.finalState.customer?.phone !== '+18435550188'))
})
