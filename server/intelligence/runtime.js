// The receptionist's view of the owner's PUBLISHED rules (layer A → the conversation engine). Returns null — and the
// receptionist behaves exactly as before — unless the business is in AI_RULES_LIVE_BUSINESSES, migration 0033 is
// applied and a version is published. Drafts never reach customers.
import { rulesLiveFor, recordsFor } from './access.js'
import { liveRules, rulesReady } from './store.js'
import { validateConfig, INTAKE } from './schema.js'
import { understand, mergeFacts, saidByCustomer } from './understand.js'
import { decide } from './decide.js'
import { contextFor, withZipCheck } from './simulate.js'
import { checkZip } from '../zipcode.js'

export async function activeRules(env, customer, now = Date.now()) {
  if (!rulesLiveFor(env, customer.id)) return null
  const db = env.ONBOARDING_DB
  if (!(await rulesReady(db))) return null
  const live = await liveRules(db, customer.id)
  if (!live) return null
  const records = await recordsFor(env, customer, now)
  // Re-validated against today's records: e.g. a fully served town later removed in Settings is simply dropped.
  const { config } = validateConfig(live.config, records)
  return { version: live.version, config, records, ctx: contextFor(config, records) }
}

const customerText = (conv) =>
  conv.transcript
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content)
    .join(' ')

// What is known for decisions: facts from the customer's own words, plus details saved through save_customer_details
// (name / phone / ZIP / street are already checked against what the customer said; a town the model saved counts only
// if the customer actually said it).
export function knownFor(conv) {
  const s = conv.state
  const f = s.facts || {}
  const c = s.customer || {}
  const known = { ...f, answers: f.answers || {} }
  if (c.name) known.name = c.name
  if (c.phone) known.phone = c.phone
  if (c.zip && c.zip !== known.zip) {
    known.zip = c.zip
    known.zipKnown = checkZip(c.zip).check !== 'unknown'
  }
  if (c.street) known.street = c.street
  if (c.need && !known.need) known.need = c.need
  if (c.city && saidByCustomer(c.city, customerText(conv))) known.city = c.city
  return known
}

// One customer message: fold what it says into conv.state.facts. → event flags (codes only) for the improvement loop.
export function observe(rules, conv, text) {
  const facts = withZipCheck(understand(text, rules.ctx))
  const before = knownFor(conv)
  const { known } = mergeFacts(conv.state.facts || {}, facts)
  conv.state.facts = { ...known, answers: conv.state.facts?.answers || {} }
  const recognized = ['need', 'city', 'zip', 'street', 'urgency', 'equipment', 'day', 'existing'].filter((k) => facts[k] !== undefined)
  const flags = []
  if (recognized.length >= 2) flags.push('multi')
  if (facts.city && !before.city && !before.zip) flags.push('city_first')
  if (facts.correction) flags.push('correction')
  if (facts.safety) flags.push('safety')
  return flags
}

export const decisionFor = (rules, conv) => decide(rules.config, rules.records, knownFor(conv))

// The model records an answer to one of the owner's intake questions that fixed patterns didn't recognize (e.g. "it's
// a Carrier unit" for equipment). Accepted only if the customer actually said it.
export const NOTE_ANSWER_TOOL = {
  name: 'note_answer',
  description: "Record the customer's answer to one of the business's intake questions (urgency, equipment, existing_customer, preferred_time) when they answer it in words the turn note didn't already list. Use their own words.",
  input_schema: {
    type: 'object',
    properties: { item: { type: 'string', enum: ['urgency', 'equipment', 'existing_customer', 'preferred_time'] }, answer: { type: 'string', description: "The customer's answer in their own words" } },
    required: ['item', 'answer'],
    additionalProperties: false,
  },
  strict: true,
}
export function noteAnswer(conv, input) {
  const item = String(input?.item || '')
  if (!INTAKE[item] || INTAKE[item].platform) return { ok: false, error: 'unknown_item', note: 'Only urgency, equipment, existing_customer or preferred_time can be recorded here; use save_customer_details for contact details, ZIP, address and need.' }
  const answer = String(input?.answer || '').trim().slice(0, 80)
  if (!answer || !saidByCustomer(answer, customerText(conv))) return { ok: false, error: 'not_said', note: 'Use the customer’s own words for the answer; if they haven’t answered, ask them.' }
  conv.state.facts = { ...(conv.state.facts || {}), answers: { ...(conv.state.facts?.answers || {}), [item]: answer } }
  if (item === 'urgency' && !conv.state.facts.urgency) conv.state.facts.urgency = /\b(not|no rush|whenever|can wait)\b/i.test(answer) ? 'not_urgent' : 'urgent'
  return { ok: true, recorded: item }
}

// Owner rules that hold a tool back. Platform minimums (need, contact, address, ZIP, area) keep their existing,
// more specific guards in the engine; this adds only what the owner configured.
const PLATFORM_ITEMS = new Set(['need', 'contact', 'address', 'zip', 'location'])
export function ruleBlock(d, tool) {
  const list = (tool === 'find_available_times' ? d.timesBlockers : d.bookBlockers).filter((b) => !PLATFORM_ITEMS.has(b))
  if (!list.length) return null
  const what = list.map((b) => (INTAKE[b] ? INTAKE[b].ask : b === 'excluded' ? `that the business doesn't offer ${d.escalate?.reason || 'this'}` : b === 'after_hours' ? 'that it is outside booking hours (offer a callback request instead)' : b === 'safety' || b === 'emergency' ? 'the urgent situation (record an urgent callback request first)' : b))
  return { ok: false, error: 'rules_not_ready', missing: list, note: `The business's rules don't allow ${tool === 'find_available_times' ? 'offering times' : 'booking'} yet. Still needed or to handle first: ${what.join('; ')}. Ask only for that.` }
}
