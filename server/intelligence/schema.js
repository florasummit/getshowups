// Business Intelligence Engine, layer A (docs/INTELLIGENCE_STUDIO.md): the owner's AI rules as structured, versioned
// data — never a free-text prompt. Provider-neutral: nothing here knows about Retell, Claude or any channel.
//
// What this config does NOT hold (one source of truth each, read at decision time):
//   services + prices, towns, phone, description → business_profiles (Settings)
//   service ZIPs, booking hours, time zone       → customers
//   appointment mode (business visits or not)    → service_settings
//   policies ("what customers should know")      → business_policies
// The config only says how the AI should work with those facts: intake order, what is required before times or a
// booking, exclusions, which listed towns are fully served, emergencies, escalation, after hours, pricing, tone.
//
// Platform rules (PLATFORM_RULES) are not part of the config and cannot be switched off by it: tenant isolation,
// server-side area check before times, booking only offered times with the customer's own yes, contact + need (+ the
// service address when the business visits) before a booking, safety advice for danger, no invented prices, privacy,
// cost caps. validateConfig refuses anything that tries.

export const SCHEMA_VERSION = 1

// The fixed intake catalog. `platform` items are always required before a booking, whatever the config says.
export const INTAKE = {
  need: { label: 'What they need', ask: 'what they need help with', platform: true },
  urgency: { label: 'Whether it’s urgent', ask: 'whether it is urgent (is anything unsafe, or is it something that can wait a few days?)' },
  location: { label: 'Where the job is (service-area check)', ask: 'where the job is (a ZIP code, or the town if it is one we fully serve)', platform: true },
  equipment: { label: 'Equipment or system type', ask: 'what equipment or system it is' },
  existing_customer: { label: 'Whether they’ve used you before', ask: 'whether they have used the business before' },
  preferred_time: { label: 'When they’d like the visit', ask: 'what day or time works for them' },
  contact: { label: 'Name and phone number', ask: 'their name and the best phone number', platform: true },
  address: { label: 'Service address', ask: 'the service address (street, city, ZIP)', platform: true, visitOnly: true },
}
export const INTAKE_IDS = Object.keys(INTAKE)

export const AFTER_HOURS = {
  book_normally: 'Book visits as usual',
  urgent_callback: 'Book as usual; urgent problems get an urgent callback request',
  callback_only: 'Don’t book after hours; take a callback request instead',
}
export const PRICING = {
  listed: 'Quote prices exactly as listed; anything else is confirmed by the team',
  no_prices: 'Never quote prices; the team confirms every price',
  visit_first: 'Explain that prices are confirmed after the visit (listed prices may be mentioned)',
}
export const EMERGENCY_ACTIONS = {
  urgent_callback: 'Record an urgent callback request (no live transfer exists)',
  book_soonest: 'Offer the soonest open time',
  callback_and_book: 'Record an urgent callback request and offer the soonest time',
}
export const ESCALATION_WHEN = {
  person: 'They ask for a person',
  installation: 'They ask about a new installation or replacement',
  commercial: 'It’s a commercial property',
  complaint: 'They have a complaint about past work',
  complex: 'The job sounds large or complex',
  phrase: 'They mention a phrase you choose',
}
export const ESCALATION_ACTIONS = { callback: 'Record a callback request', message: 'Take a message' }
export const STYLES = { warm: 'Warm and friendly', brief: 'Short and to the point', formal: 'Polite and formal' }

// What GetShowUps always does, shown to the owner as locked rules (and never configurable).
export const PLATFORM_RULES = [
  'Only your own business’s information is ever used or shared.',
  'The service area is checked on our server before times are offered.',
  'Only real open times from your calendar are offered, and a time is booked only after the customer clearly says yes.',
  'A booking always needs what they need, their name and phone number (and the service address when you visit them).',
  'Anyone describing danger (gas smell, fire, sparks, carbon monoxide, flooding near electricity) is told to get safe and call 911 first.',
  'Prices that aren’t in your records are never stated.',
  'Nobody is told a person will call at a set time, and calls are never transferred live (no phone line is connected).',
  'Daily spending limits and conversation limits always apply.',
]

// Industry starting points (owners change everything; these are only defaults for a new draft).
export const TEMPLATES = {
  pool: {
    intake: [['need', true], ['location', true], ['preferred_time', false], ['equipment', false], ['urgency', false], ['existing_customer', false], ['contact', true], ['address', true]],
    emergency: { triggers: [], action: 'urgent_callback' },
    escalation: [{ when: 'person', action: 'callback' }],
  },
  hvac: {
    intake: [['need', true], ['urgency', true, true], ['location', true], ['equipment', false], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]],
    emergency: { triggers: ['no heat', 'no cooling', 'water leaking'], action: 'callback_and_book' },
    escalation: [{ when: 'person', action: 'callback' }],
  },
  electrical: {
    intake: [['need', true], ['urgency', true, true], ['location', true], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]],
    emergency: { triggers: ['power out', 'breaker keeps tripping', 'hot outlet'], action: 'urgent_callback' },
    escalation: [{ when: 'person', action: 'callback' }, { when: 'complex', action: 'callback' }],
  },
  general: {
    intake: [['need', true], ['location', true], ['preferred_time', false], ['contact', true], ['address', true]],
    emergency: { triggers: [], action: 'urgent_callback' },
    escalation: [{ when: 'person', action: 'callback' }],
  },
}
export function industryKey(text) {
  const t = String(text || '')
  if (/pool|spa|hot tub/i.test(t)) return 'pool'
  if (/hvac|heating|cooling|air condition|furnace|heat pump|a\/c|\bac\b/i.test(t)) return 'hvac'
  if (/electric/i.test(t)) return 'electrical'
  return 'general'
}

// A new draft for a business: its industry's template, nothing else assumed.
export function defaultConfig(records) {
  const key = industryKey(`${records?.industry || ''} ${(records?.services || []).map((s) => s.name).join(' ')}`)
  const t = TEMPLATES[key]
  return {
    schema: SCHEMA_VERSION,
    industry: key,
    intake: t.intake.map(([id, required, beforeTimes = false]) => ({ id, required, beforeTimes })),
    services: { excluded: [] },
    coverage: { cityWide: [] },
    emergency: { triggers: [...t.emergency.triggers], action: t.emergency.action },
    escalation: t.escalation.map((e) => ({ ...e })),
    afterHours: 'book_normally',
    pricing: 'listed',
    style: 'warm',
  }
}

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u001f<>{}`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
const same = (a, b) => clean(a, 200).toLowerCase() === clean(b, 200).toLowerCase()
// Text that would turn a config field into instructions (prompt injection through the owner's own fields, or an
// attempt to switch off a platform rule) is refused, never stored.
const INSTRUCTION_RE = /\b(ignore|disregard|override|forget)\b.{0,40}\b(rules?|instructions?|prompt|above|previous)\b|\bsystem prompt\b|\byou are now\b|\bact as\b|\bjailbreak\b/i
export const LIMITS = { excluded: 20, triggers: 12, escalation: 10, phrase: 60, service: 80 }

// → { config (normalized), errors: [{ field, code, message }], warnings: [{ field, code, message }] }.
// `records`: the business's current facts ({ services, towns, zips, visit }) for cross-checks.
export function validateConfig(input, records = {}) {
  const errors = []
  const warnings = []
  const err = (field, code, message) => errors.push({ field, code, message })
  const warn = (field, code, message) => warnings.push({ field, code, message })
  const c = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  if (c.schema !== undefined && c.schema !== SCHEMA_VERSION) err('schema', 'unsupported_schema', 'This configuration was made by a newer version of GetShowUps.')
  const towns = (records.towns || []).map((t) => clean(t, 80)).filter(Boolean)
  const services = (records.services || []).map((s) => clean(s.name, LIMITS.service)).filter(Boolean)

  // Intake: every catalog item exactly once, in the owner's order. Platform items can be reordered, never made optional.
  const seen = new Set()
  const intake = []
  for (const it of Array.isArray(c.intake) ? c.intake : []) {
    const id = String(it?.id || '')
    if (!INTAKE[id]) {
      err('intake', 'unknown_item', `“${clean(id, 40)}” isn’t something the AI can ask about.`)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    let required = Boolean(it.required)
    if (INTAKE[id].platform && !required) {
      err('intake', 'platform_required', `${INTAKE[id].label} is always required before a booking (booking safety).`)
      required = true
    }
    intake.push({ id, required, beforeTimes: Boolean(it.beforeTimes) && id !== 'contact' && id !== 'address' })
  }
  for (const id of INTAKE_IDS) if (!seen.has(id)) intake.push({ id, required: Boolean(INTAKE[id].platform), beforeTimes: false })
  // The area is always checked before times (platform rule), so `beforeTimes` on location is implied.
  for (const it of intake) if (it.id === 'location') it.beforeTimes = true

  const list = (v, max, len, field) => {
    const arr = Array.isArray(v) ? v : []
    if (arr.length > max) err(field, 'too_many', `At most ${max}.`)
    const out = []
    for (const x of arr.slice(0, max)) {
      const s = clean(x, len)
      if (!s) continue
      if (INSTRUCTION_RE.test(s)) {
        err(field, 'instruction_text', 'Rules can’t contain instructions to the AI; describe the business instead.')
        continue
      }
      if (!out.some((o) => same(o, s))) out.push(s)
    }
    return out
  }

  const excluded = list(c.services?.excluded, LIMITS.excluded, LIMITS.service, 'services.excluded')
  for (const x of excluded) if (services.some((s) => same(s, x))) err('services.excluded', 'excludes_listed_service', `“${x}” is one of your listed services. Remove it from your services in Settings first, or don’t exclude it.`)

  const cityWide = []
  for (const x of list(c.coverage?.cityWide, 20, 80, 'coverage.cityWide')) {
    const town = towns.find((t) => same(t, x))
    if (!town) err('coverage.cityWide', 'unknown_town', `“${x}” isn’t one of the towns in your service area. Add it to your towns in Settings first.`)
    else cityWide.push(town)
  }
  if (cityWide.length && (records.zips || []).length)
    warn('coverage.cityWide', 'zip_list_still_checked', `Bookings still check your ZIP code list. If ${cityWide.join(', ')} has ZIP codes you don’t list, those callers get a service-area request instead of a booking.`)

  const action = (v, allowed, dflt) => (Object.hasOwn(allowed, v) ? v : dflt)
  const emergency = { triggers: list(c.emergency?.triggers, LIMITS.triggers, LIMITS.phrase, 'emergency.triggers'), action: action(c.emergency?.action, EMERGENCY_ACTIONS, 'urgent_callback') }
  if (c.emergency?.action !== undefined && !Object.hasOwn(EMERGENCY_ACTIONS, c.emergency.action)) err('emergency.action', 'unknown_choice', 'Choose one of the emergency options.')

  const escalation = []
  for (const e of (Array.isArray(c.escalation) ? c.escalation : []).slice(0, LIMITS.escalation)) {
    if (!Object.hasOwn(ESCALATION_WHEN, e?.when)) {
      err('escalation', 'unknown_choice', 'Choose when to hand off from the list.')
      continue
    }
    const phrase = e.when === 'phrase' ? clean(e.phrase, LIMITS.phrase) : undefined
    if (e.when === 'phrase' && !phrase) {
      err('escalation', 'phrase_missing', 'Type the phrase that should trigger a hand-off.')
      continue
    }
    if (phrase && INSTRUCTION_RE.test(phrase)) {
      err('escalation', 'instruction_text', 'Rules can’t contain instructions to the AI; describe the business instead.')
      continue
    }
    const out = { when: e.when, action: action(e.action, ESCALATION_ACTIONS, 'callback'), ...(phrase ? { phrase } : {}) }
    if (!escalation.some((x) => x.when === out.when && (x.phrase || '') === (out.phrase || ''))) escalation.push(out)
  }
  if ((Array.isArray(c.escalation) ? c.escalation : []).length > LIMITS.escalation) err('escalation', 'too_many', `At most ${LIMITS.escalation}.`)

  for (const [field, allowed] of [['afterHours', AFTER_HOURS], ['pricing', PRICING], ['style', STYLES]]) if (c[field] !== undefined && !Object.hasOwn(allowed, c[field])) err(field, 'unknown_choice', 'Choose one of the options.')

  const config = {
    schema: SCHEMA_VERSION,
    industry: Object.hasOwn(TEMPLATES, c.industry) ? c.industry : 'general',
    intake,
    services: { excluded },
    coverage: { cityWide },
    emergency,
    escalation,
    afterHours: action(c.afterHours, AFTER_HOURS, 'book_normally'),
    pricing: action(c.pricing, PRICING, 'listed'),
    style: action(c.style, STYLES, 'warm'),
  }
  // (The address item exists for every business; it is only asked when the business visits the customer.)
  if (config.afterHours === 'callback_only' && !records.hoursConfirmed) warn('afterHours', 'hours_unconfirmed', 'Your booking hours aren’t confirmed in Settings yet, so “after hours” can’t be told apart.')
  return { config, errors, warnings }
}

// Plain-language summary of a config, for the owner (Publish screen, version history, Teach a Change diff).
export function describeConfig(c, records = {}) {
  const lines = []
  const ask = c.intake.filter((i) => i.required && !(INTAKE[i.id].visitOnly && !records.visit)).map((i) => INTAKE[i.id].label.toLowerCase())
  lines.push(`Asks for: ${ask.join(', ')} — only what the customer hasn’t already said, in this order.`)
  const before = c.intake.filter((i) => i.beforeTimes && i.id !== 'location').map((i) => INTAKE[i.id].label.toLowerCase())
  if (before.length) lines.push(`Before offering times: ${before.join(', ')}.`)
  const optional = c.intake.filter((i) => !i.required).map((i) => INTAKE[i.id].label.toLowerCase())
  if (optional.length) lines.push(`Only if it comes up: ${optional.join(', ')}.`)
  if (c.services.excluded.length) lines.push(`Doesn’t offer: ${c.services.excluded.join(', ')}.`)
  if (c.coverage.cityWide.length) lines.push(`Fully serves: ${c.coverage.cityWide.join(', ')} (no ZIP code needed to confirm the area).`)
  if (c.emergency.triggers.length) lines.push(`Treats as urgent: ${c.emergency.triggers.join(', ')} → ${EMERGENCY_ACTIONS[c.emergency.action].toLowerCase()}.`)
  for (const e of c.escalation) lines.push(`${e.when === 'phrase' ? `When they mention “${e.phrase}”` : ESCALATION_WHEN[e.when]}: ${ESCALATION_ACTIONS[e.action].toLowerCase()}.`)
  lines.push(`After hours: ${AFTER_HOURS[c.afterHours].toLowerCase()}.`)
  lines.push(`Prices: ${PRICING[c.pricing].toLowerCase()}.`)
  lines.push(`Tone: ${STYLES[c.style].toLowerCase()}.`)
  return lines
}

// Field-level differences between two configs, in plain words (Teach a Change proposal, publish summary).
export function diffConfigs(a, b) {
  const out = []
  if (!a) return ['First version.']
  const order = (c) => c.intake.map((i) => i.id).join(',')
  if (order(a) !== order(b)) out.push(`Question order: ${b.intake.map((i) => INTAKE[i.id].label.toLowerCase()).join(' → ')}.`)
  for (const it of b.intake) {
    const was = a.intake.find((i) => i.id === it.id) || {}
    if (Boolean(was.required) !== it.required) out.push(`${INTAKE[it.id].label}: ${it.required ? 'now required' : 'now optional'}.`)
    if (Boolean(was.beforeTimes) !== it.beforeTimes && it.id !== 'location') out.push(`${INTAKE[it.id].label}: ${it.beforeTimes ? 'asked before offering times' : 'no longer needed before offering times'}.`)
  }
  const set = (label, x, y) => {
    const added = y.filter((v) => !x.some((w) => same(v, w)))
    const removed = x.filter((v) => !y.some((w) => same(v, w)))
    if (added.length) out.push(`${label}: added ${added.join(', ')}.`)
    if (removed.length) out.push(`${label}: removed ${removed.join(', ')}.`)
  }
  set('Services you don’t offer', a.services.excluded, b.services.excluded)
  set('Fully served towns', a.coverage.cityWide, b.coverage.cityWide)
  set('Urgent situations', a.emergency.triggers, b.emergency.triggers)
  if (a.emergency.action !== b.emergency.action) out.push(`Urgent situations: ${EMERGENCY_ACTIONS[b.emergency.action].toLowerCase()}.`)
  const esc = (c) => c.escalation.map((e) => `${e.when}:${e.phrase || ''}:${e.action}`)
  for (const e of b.escalation) if (!esc(a).includes(`${e.when}:${e.phrase || ''}:${e.action}`)) out.push(`Hand-off added: ${e.when === 'phrase' ? `“${e.phrase}”` : ESCALATION_WHEN[e.when].toLowerCase()} → ${ESCALATION_ACTIONS[e.action].toLowerCase()}.`)
  for (const e of a.escalation) if (!esc(b).includes(`${e.when}:${e.phrase || ''}:${e.action}`)) out.push(`Hand-off removed: ${e.when === 'phrase' ? `“${e.phrase}”` : ESCALATION_WHEN[e.when].toLowerCase()}.`)
  if (a.afterHours !== b.afterHours) out.push(`After hours: ${AFTER_HOURS[b.afterHours].toLowerCase()}.`)
  if (a.pricing !== b.pricing) out.push(`Prices: ${PRICING[b.pricing].toLowerCase()}.`)
  if (a.style !== b.style) out.push(`Tone: ${STYLES[b.style].toLowerCase()}.`)
  return out
}
