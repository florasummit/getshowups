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

// One pretend customer per test: each line continues the conversation (what was said earlier is remembered, exactly
// like a real one). A line that names a DIFFERENT place and a DIFFERENT job, without correcting itself, is clearly
// another customer: it starts fresh (`fresh: true`), so nothing from the earlier one is carried into its reply or its
// area verdict. Each turn's explanations list only what is new since the previous turn of the same customer.
const lc = (v) => String(v || '').toLowerCase()
const differs = (a, b) => Boolean(a && b) && lc(a) !== lc(b)
const otherCustomer = (known, facts) => !facts.correction && (differs(facts.zip, known.zip) || differs(facts.city, known.city)) && differs(facts.service || facts.need, known.service || known.need)

export function simulate(config, records, lines) {
  const ctx = contextFor(config, records)
  let known = {}
  let asked = new Set()
  let said = new Set()
  let repeated = 0
  const turns = []
  for (const raw of (lines || []).slice(0, SIM_LIMITS.lines)) {
    const text = String(raw || '').slice(0, SIM_LIMITS.chars)
    const facts = withZipCheck(understand(text, ctx))
    const fresh = turns.length > 0 && otherCustomer(known, facts)
    if (fresh) {
      known = {}
      asked = new Set()
      said = new Set()
    }
    const merged = mergeFacts(known, facts)
    known = merged.known
    const d = decide(config, records, known)
    const taught = taughtIn(config, text)
    // A question about something already known would be a repeat (the engine never should; measured anyway).
    if (d.nextAsk && asked.has(d.nextAsk) && turnSatisfiedBefore(turns, d.nextAsk)) repeated++
    if (d.nextAsk) asked.add(d.nextAsk)
    const recognized = Object.fromEntries(Object.entries(facts).filter(([k, v]) => k !== 'intents' && k !== 'zipKnown' && v !== undefined && !(Array.isArray(v) && !v.length)))
    const all = [...d.explanations, ...taught.map((t) => ({ code: 'taught', text: `Uses what you taught: ${t.topic}.` }))]
    const explanations = all.filter((x) => !said.has(x.text))
    said = new Set(all.map((x) => x.text))
    turns.push({
      text,
      ...(fresh ? { fresh: true } : {}),
      recognized,
      intents: facts.intents,
      coverage: d.coverage,
      nextAsk: d.nextAsk,
      flow: d.flow,
      canOfferTimes: d.canOfferTimes,
      canBook: d.canBook,
      escalate: d.escalate,
      satisfied: d.satisfied,
      explanations,
      reply: exampleReply(d, records, facts, taught),
    })
  }
  return { turns, known, metrics: { repeatedQuestions: repeated } }
}
// Which taught facts a customer's message asks about: it shares a telling word with the topic or the fact. A preview of what
// the AI is given, not of its wording.
const COMMON = new Set('about after also always before business call come could customer customers does done each ever every from give have help into just know like make many more much need offer only other over people please same service services should some take than that their them then there they this those today very want well were what when where which while will with work would your'.split(' '))
const telling = (v) => new Set(String(v || '').toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !COMMON.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')) || [])
export function taughtIn(config, text) {
  const said = telling(text)
  const hits = (s) => [...telling(s)].filter((w) => said.has(w)).length
  return (config.knowledge || [])
    .filter((k) => k.audience === 'customers')
    .map((k) => ({ k, n: hits(k.topic) * 2 + hits(k.text) }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((x) => x.k)
}
const turnSatisfiedBefore = (turns, id) => turns.some((t) => t.satisfied.includes(id))
