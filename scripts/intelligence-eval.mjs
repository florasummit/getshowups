// Business Intelligence Engine evaluation: runs every scenario in test/fixtures/intelligence-scenarios.js through the
// same code the receptionist and "Test your AI" use (understand → decide → example reply) and reports the metrics from
// docs/INTELLIGENCE_STUDIO.md. Deterministic, free, offline: no model, calendar or voice provider is involved.
//   node scripts/intelligence-eval.mjs            → summary + failures
//   node scripts/intelligence-eval.mjs --verbose  → every scenario
// This measures the RULES. It does not measure model wording, speech recognition, voice timing or interruptions.
import { defaultConfig, validateConfig } from '../server/intelligence/schema.js'
import { simulate } from '../server/intelligence/simulate.js'
import { BUSINESSES, SCENARIOS } from '../test/fixtures/intelligence-scenarios.js'

function business(key, open = true) {
  const b = BUSINESSES[key]
  const records = { ...b.records, open }
  const d = defaultConfig(records)
  const over = typeof b.config === 'function' ? b.config(d) : b.config
  const { config, errors } = validateConfig({ ...d, ...over }, records)
  if (errors.length) throw new Error(`${key}: invalid config ${errors.map((e) => e.code).join(',')}`)
  return { config, records }
}

export function runIntelligenceEval() {
  const results = []
  for (const s of SCENARIOS) {
    const { config, records } = business(s.business, s.open !== false)
    const sim = simulate(config, records, s.lines)
    const t = sim.turns.at(-1)
    const e = s.expect || {}
    const fails = []
    const check = (name, ok) => !ok && fails.push(name)
    if (e.coverage !== undefined) check(`coverage=${t.coverage.status}≠${e.coverage}`, t.coverage.status === e.coverage)
    if (e.basis !== undefined) check(`basis=${t.coverage.basis}≠${e.basis}`, t.coverage.basis === e.basis)
    if (e.nextAsk !== undefined) check(`nextAsk=${t.nextAsk}≠${e.nextAsk}`, t.nextAsk === e.nextAsk)
    for (const id of e.notAsk || []) check(`asked_known:${id}`, t.nextAsk !== id)
    if (e.times !== undefined) check(`times=${t.canOfferTimes}≠${e.times}`, t.canOfferTimes === e.times)
    if (e.book !== undefined) check(`book=${t.canBook}≠${e.book}`, t.canBook === e.book)
    if (e.flow !== undefined) check(`flow=${t.flow}≠${e.flow}`, t.flow === e.flow)
    if (e.escalate !== undefined) check(`escalate=${t.escalate?.kind ?? null}≠${e.escalate}`, (t.escalate?.kind ?? null) === e.escalate)
    if (e.action !== undefined) check(`action=${t.escalate?.action}≠${e.action}`, t.escalate?.action === e.action)
    for (const [k, v] of Object.entries(e.recognized || {})) check(`recognized.${k}=${sim.known[k]}≠${v}`, sim.known[k] === v)
    if (e.explain !== undefined) check(`explain:${e.explain}`, t.explanations.some((x) => x.code === e.explain))
    const replies = sim.turns.map((x) => x.reply).join(' ')
    for (const word of s.replyExcludes || []) check(`cross_tenant:${word}`, !replies.includes(word))
    results.push({
      id: s.id,
      category: s.category,
      business: s.business,
      pass: fails.length === 0,
      fails,
      repeated: sim.metrics.repeatedQuestions,
      unauthorizedBooking: e.book === false && t.canBook === true,
      crossTenant: fails.some((f) => f.startsWith('cross_tenant')),
      escalationChecked: e.escalate !== undefined,
      escalationOk: e.escalate === undefined || (t.escalate?.kind ?? null) === e.escalate,
      locationChecked: s.category === 'location',
      reply: t.reply,
    })
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)
  const loc = results.filter((r) => r.locationChecked)
  const esc = results.filter((r) => r.escalationChecked)
  const summary = {
    scenarios: results.length,
    passed: results.filter((r) => r.pass).length,
    byCategory: Object.fromEntries([...new Set(results.map((r) => r.category))].map((c) => [c, `${results.filter((r) => r.category === c && r.pass).length}/${results.filter((r) => r.category === c).length}`])),
    locationAccuracyPct: pct(loc.filter((r) => r.pass).length, loc.length),
    repeatedQuestions: results.reduce((s, r) => s + r.repeated, 0),
    unauthorizedBookings: results.filter((r) => r.unauthorizedBooking).length,
    escalationAccuracyPct: pct(esc.filter((r) => r.escalationOk).length, esc.length),
    crossTenantExposure: results.filter((r) => r.crossTenant).length,
  }
  return { summary, results }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { summary, results } = runIntelligenceEval()
  console.log(JSON.stringify(summary, null, 2))
  for (const r of results) if (!r.pass || process.argv.includes('--verbose')) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.id} ${r.fails.join(' ')}${process.argv.includes('--verbose') ? `\n     → ${r.reply}` : ''}`)
}
