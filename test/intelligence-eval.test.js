// Business Intelligence Engine evaluation (scripts/intelligence-eval.mjs): 40+ curated scenarios across a pool service,
// two HVAC companies with different rules, and an electrician — location, workflow, conversation and security.
// Engineering targets (docs/INTELLIGENCE_STUDIO.md): ≥95% on curated location scenarios, zero repeated questions, zero
// unauthorized bookings, zero cross-tenant exposure. These are curated test results, not real-world performance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runIntelligenceEval } from '../scripts/intelligence-eval.mjs'
import { SCENARIOS } from './fixtures/intelligence-scenarios.js'

test('intelligence evaluation: ≥40 scenarios; location ≥95%; no repeated questions, unauthorized bookings or cross-tenant exposure', () => {
  assert.ok(SCENARIOS.length >= 40, `${SCENARIOS.length} scenarios`)
  assert.deepEqual([...new Set(SCENARIOS.map((s) => s.category))].sort(), ['conversation', 'location', 'security', 'workflow'])
  assert.deepEqual([...new Set(SCENARIOS.map((s) => s.business))].sort(), ['electrical', 'hvacA', 'hvacB', 'pool'])
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'unique ids')
  const { summary, results } = runIntelligenceEval()
  assert.ok(summary.locationAccuracyPct >= 95, `location ${summary.locationAccuracyPct}%`)
  assert.equal(summary.repeatedQuestions, 0)
  assert.equal(summary.unauthorizedBookings, 0)
  assert.equal(summary.crossTenantExposure, 0)
  assert.equal(summary.escalationAccuracyPct, 100)
  assert.deepEqual(results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.fails.join(' ')}`), [])
})
