// "Test your AI": a text simulation of the owner's rules (draft or live). Each customer line → what was recognized,
// the decision (coverage, what is asked next, whether times / a booking are allowed, hand-offs) and an EXAMPLE reply.
// No model call, no calendar lookup, nothing stored, nothing sent: it shows the rules, not the voice or the wording.
import { understand, mergeFacts } from './understand.js'
import { decide } from './decide.js'
import { exampleReply } from './compile.js'
import { checkZip } from '../zipcode.js'

export const SIM_LIMITS = { lines: 12, chars: 500 }

export const contextFor = (config, records) => ({
  industry: config.industry,
  towns: [...new Set([...(records.towns || []), ...(config.coverage?.cityWide || [])])],
  services: (records.services || []).map((s) => s.name),
  excluded: config.services?.excluded || [],
  triggers: config.emergency?.triggers || [],
  phrases: (config.escalation || []).filter((e) => e.when === 'phrase').map((e) => e.phrase),
})

// A recognized ZIP that is not a real ZIP code (Census list) is flagged so coverage asks to double-check it.
export const withZipCheck = (facts) => (facts.zip ? { ...facts, zipKnown: checkZip(facts.zip).check !== 'unknown' } : facts)

export function simulate(config, records, lines) {
  const ctx = contextFor(config, records)
  let known = {}
  const asked = new Set()
  let repeated = 0
  const turns = []
  for (const raw of (lines || []).slice(0, SIM_LIMITS.lines)) {
    const text = String(raw || '').slice(0, SIM_LIMITS.chars)
    const facts = withZipCheck(understand(text, ctx))
    const merged = mergeFacts(known, facts)
    known = merged.known
    const d = decide(config, records, known)
    // A question about something already known would be a repeat (the engine never should; measured anyway).
    if (d.nextAsk && asked.has(d.nextAsk) && turnSatisfiedBefore(turns, d.nextAsk)) repeated++
    if (d.nextAsk) asked.add(d.nextAsk)
    const recognized = Object.fromEntries(Object.entries(facts).filter(([k, v]) => k !== 'intents' && k !== 'zipKnown' && v !== undefined && !(Array.isArray(v) && !v.length)))
    turns.push({
      text,
      recognized,
      intents: facts.intents,
      coverage: d.coverage,
      nextAsk: d.nextAsk,
      flow: d.flow,
      canOfferTimes: d.canOfferTimes,
      canBook: d.canBook,
      escalate: d.escalate,
      satisfied: d.satisfied,
      explanations: d.explanations,
      reply: exampleReply(d, records, facts),
    })
  }
  return { turns, known, metrics: { repeatedQuestions: repeated } }
}
const turnSatisfiedBefore = (turns, id) => turns.some((t) => t.satisfied.includes(id))
