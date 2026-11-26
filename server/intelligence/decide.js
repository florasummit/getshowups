// Business Intelligence Engine: the decision. Pure function of (owner config, business records, what is known) →
// what is satisfied, what to ask next (one thing), whether times may be offered or a booking made, coverage, and
// escalations — with short owner-facing explanations. The SAME function drives the live conversation (turn notes +
// server-side tool guards) and "Test your AI", so what the owner tests is what customers get.
//
// Platform rules are applied here regardless of the config: area checked before times, need + contact (+ address for
// visits) before a booking, safety first, ZIP list checked at booking (booking integrity: areaFor in booking.js).
import { INTAKE, intakeLabel } from './schema.js'

const lc = (s) => String(s || '').toLowerCase().trim()
const sameTown = (a, b) => lc(a) === lc(b)

// Coverage, in five explicit states (spec: recognized → normalized → verified / uncertain / rejected):
//   not_limited  — the business has no ZIP list: everywhere is served
//   verified     — ZIP on the list
//   verified_city— the caller named a town the owner marked as fully served
//   rejected     — a real ZIP not on the list (a service-area request, never a dead end, never a booking)
//   uncertain    — town not fully served / unknown town / ZIP we can't find / conflicting locations → ask
//   unknown      — nothing said yet
export function coverageOf(config, records, known) {
  const zips = records.zips || []
  const cityWide = config?.coverage?.cityWide || []
  if (known.conflicts?.includes('zip') || known.conflicts?.includes('city')) return { status: 'uncertain', basis: 'conflict', ask: 'confirm_location' }
  if (!zips.length) return { status: 'not_limited', basis: 'no_zip_list', ask: null }
  if (known.zip) {
    if (zips.includes(known.zip)) return { status: 'verified', basis: 'zip', ask: null }
    // A fully served town whose ZIP isn't on the list: the area was promised by town, but booking checks ZIPs.
    if (known.city && cityWide.some((t) => sameTown(t, known.city))) return { status: 'uncertain', basis: 'zip_not_listed_in_served_town', ask: null }
    return known.zipKnown === false ? { status: 'uncertain', basis: 'zip_not_found', ask: 'confirm_zip' } : { status: 'rejected', basis: 'zip_outside', ask: null }
  }
  if (known.city) {
    if (cityWide.some((t) => sameTown(t, known.city))) return { status: 'verified_city', basis: 'city_wide', ask: null }
    const listed = (records.towns || []).some((t) => sameTown(t, known.city))
    return { status: 'uncertain', basis: listed ? 'town_partly_served' : 'town_not_listed', ask: 'zip' }
  }
  return { status: 'unknown', basis: 'nothing_yet', ask: 'zip' }
}
const COVERAGE_DECIDED = new Set(['not_limited', 'verified', 'verified_city', 'rejected'])
const COVERAGE_OK = new Set(['not_limited', 'verified', 'verified_city'])

function satisfied(id, known, records, coverage) {
  switch (id) {
    case 'need':
      return Boolean(known.need || known.service)
    case 'urgency':
      return Boolean(known.urgency) || Boolean(known.answers?.urgency)
    case 'location':
      return COVERAGE_DECIDED.has(coverage.status)
    case 'equipment':
      return Boolean(known.equipment || known.answers?.equipment)
    case 'existing_customer':
      return known.existing === true || known.existing === false || Boolean(known.answers?.existing_customer)
    case 'preferred_time':
      return Boolean(known.day || known.part || known.answers?.preferred_time)
    case 'contact':
      return Boolean(known.name && known.phone)
    case 'address':
      return !records.visit || Boolean(known.street && known.city && known.zip)
    default:
      return false
  }
}
const applies = (id, records) => !(INTAKE[id]?.visitOnly && !records.visit)

// → { known, coverage, satisfied[], missingRequired[], nextAsk, canOfferTimes, timesBlockers[], canBook, bookBlockers[],
//     escalate: null | { kind, action, urgent, reason }, safety, flow, explanations: [{ code, text }] }
// records: { name, services[{name}], towns[], zips[], visit, open (within booking hours) }
export function decide(config, records, known = {}) {
  const coverage = coverageOf(config, records, known)
  const items = (config?.intake || []).filter((i) => applies(i.id, records))
  const done = items.filter((i) => satisfied(i.id, known, records, coverage)).map((i) => i.id)
  const missingRequired = items.filter((i) => i.required && !done.includes(i.id)).map((i) => i.id)
  const explanations = []
  const say = (code, text) => explanations.push({ code, text })
  // Owner-facing explanations use the trade's own words (schema.js intakeLabel).
  const label = (id) => intakeLabel(id, config?.industry).toLowerCase()

  // Hand-offs and refusals, strongest first. Safety is a platform rule; the owner chooses what follows it.
  let escalate = null
  const intents = new Set(known.intents || [])
  const open = records.open !== false
  if (known.safety) {
    const action = config?.emergency?.action || 'urgent_callback'
    escalate = { kind: 'safety', action, urgent: true, reason: known.safety }
    say('safety', known.safety === 'call_911' ? 'Danger described: the AI tells them to get safe and call 911 first.' : 'Electrical hazard described: the AI tells them to stay away from it and call 911 if there is fire or smoke.')
  }
  if (!escalate && known.excluded) {
    const rule = (config?.escalation || []).find((e) => e.when === 'installation' && /install|replac/i.test(known.excluded))
    escalate = { kind: 'excluded', action: rule ? rule.action : 'decline', urgent: false, reason: known.excluded }
    say('excluded', `You don’t offer “${known.excluded}”: the AI says so${rule ? ' and records a callback request' : ' and offers what you do'}.`)
  }
  if (!escalate) {
    for (const e of config?.escalation || []) {
      const hit = e.when === 'phrase' ? intents.has(`phrase:${e.phrase}`) : intents.has(e.when)
      if (hit) {
        escalate = { kind: e.when === 'phrase' ? `phrase:${e.phrase}` : e.when, action: e.action, urgent: false, reason: e.when }
        say('handoff', `${e.when === 'phrase' ? `They mentioned “${e.phrase}”` : { person: 'They asked for a person', installation: 'Installation or replacement', commercial: 'Commercial property', complaint: 'A complaint about past work', complex: 'A large or complex job' }[e.when]}: the AI offers to ${e.action === 'message' ? 'take a message' : 'record a callback request'} (no live transfer exists).`)
        break
      }
    }
  }
  // One of the owner's urgent situations (not just "asap"): the owner's emergency action.
  if (!escalate && known.trigger) {
    escalate = { kind: 'emergency', action: config.emergency.action, urgent: true, reason: known.trigger }
    say('emergency', `“${known.trigger}” is one of your urgent situations: ${config.emergency.action === 'book_soonest' ? 'the AI offers the soonest time' : config.emergency.action === 'callback_and_book' ? 'the AI records an urgent callback request and offers the soonest time' : 'the AI records an urgent callback request'}.`)
  }
  if (!open && config?.afterHours === 'callback_only' && !escalate) {
    escalate = { kind: 'after_hours', action: 'callback', urgent: false, reason: 'after_hours' }
    say('after_hours', 'Outside your booking hours: the AI takes a callback request instead of booking.')
  }
  if (!open && config?.afterHours === 'urgent_callback' && known.urgency === 'urgent' && !escalate) {
    escalate = { kind: 'after_hours_urgent', action: 'callback', urgent: true, reason: 'after_hours' }
    say('after_hours', 'Urgent and outside your booking hours: the AI records an urgent callback request (booking is still offered).')
  }
  const blocksBooking = escalate && (escalate.kind === 'excluded' || escalate.kind === 'after_hours' || ((escalate.kind === 'safety' || escalate.kind === 'emergency') && escalate.action === 'urgent_callback'))

  // What is already known (never asked again).
  const knownBits = []
  if (known.need || known.service) knownBits.push(`what they need (“${known.service || known.need}”)`)
  if (known.city) knownBits.push(`town (${known.city})`)
  if (known.zip) knownBits.push(`ZIP (${known.zip})`)
  if (known.street) knownBits.push('street address')
  if (known.urgency) knownBits.push(known.urgency === 'urgent' ? 'it’s urgent' : 'it isn’t urgent')
  if (known.equipment) knownBits.push(`equipment (${known.equipment})`)
  if (known.day || known.part) knownBits.push(`timing (${[known.day, known.part].filter(Boolean).join(' ')})`)
  if (known.existing === true) knownBits.push('they’re an existing customer')
  if (known.name) knownBits.push('name')
  if (known.phone) knownBits.push('phone')
  if (knownBits.length) say('known', `Already knows: ${knownBits.join(', ')}. It won’t ask for these again.`)
  if (known.corrected?.length) say('corrected', `The customer corrected their ${known.corrected.join(', ')}; the newest answer is used.`)

  // Coverage explanation.
  if (coverage.status === 'verified_city') say('coverage', `${known.city} is fully served: no ZIP code needed to confirm the area.`)
  else if (coverage.status === 'verified') say('coverage', `ZIP ${known.zip} is in your service area.`)
  else if (coverage.status === 'not_limited') say('coverage', 'You haven’t limited your area, so any location is served.')
  else if (coverage.status === 'rejected') say('coverage', `ZIP ${known.zip} isn’t on your list: no times are offered; the AI takes their details so you can approve or decline.`)
  else if (coverage.basis === 'zip_not_listed_in_served_town') say('coverage', `${known.city} is marked fully served, but ZIP ${known.zip} isn’t on your ZIP list, so this becomes a service-area request for you to approve.`)
  else if (coverage.basis === 'town_partly_served') say('coverage', `ZIP code needed: you serve parts of ${known.city}, not all of it.`)
  else if (coverage.basis === 'town_not_listed') say('coverage', `ZIP code needed: ${known.city} isn’t one of your towns.`)
  else if (coverage.basis === 'conflict') say('coverage', 'Two different locations were mentioned: the AI asks which one is right.')
  else if (coverage.basis === 'zip_not_found') say('coverage', `ZIP ${known.zip} isn’t a ZIP code we can find: the AI asks them to double-check it.`)

  // Times: area decided and OK, owner's before-times items known, nothing blocking.
  const timesBlockers = []
  if (!COVERAGE_OK.has(coverage.status)) timesBlockers.push('location')
  for (const i of items) if (i.beforeTimes && i.required && i.id !== 'location' && !done.includes(i.id)) timesBlockers.push(i.id)
  if (blocksBooking) timesBlockers.push(escalate.kind)
  const canOfferTimes = timesBlockers.length === 0

  // Booking: everything required, plus the platform minimum (need, contact, address for visits), area OK.
  const bookBlockers = [...new Set([...timesBlockers, ...missingRequired])]
  for (const id of ['need', 'contact', ...(records.visit ? ['address'] : [])]) if (!satisfied(id, known, records, coverage) && !bookBlockers.includes(id)) bookBlockers.push(id)
  if ((records.zips || []).length && !known.zip && !bookBlockers.includes('zip')) bookBlockers.push('zip')
  const canBook = bookBlockers.length === 0

  // Next question: the owner's order, first required item not yet known — but booking details (contact, address)
  // only once times can be offered, and nothing while a hand-off or refusal is being handled.
  let nextAsk = null
  let flow = 'intake'
  if (escalate && blocksBooking) flow = escalate.kind === 'excluded' ? 'decline' : 'handoff'
  else if (coverage.status === 'rejected' || coverage.basis === 'zip_not_listed_in_served_town') flow = 'coverage_request'
  else if (coverage.ask === 'confirm_location' || coverage.ask === 'confirm_zip') {
    flow = 'confirm'
    nextAsk = 'location'
  } else {
    for (const i of items) {
      if (!i.required || done.includes(i.id)) continue
      if ((i.id === 'contact' || i.id === 'address') && !canOfferTimes) continue
      nextAsk = i.id
      break
    }
    if (!nextAsk && !canOfferTimes) nextAsk = timesBlockers.find((b) => INTAKE[b]) || null
    if (!nextAsk && canOfferTimes && !canBook) {
      flow = 'offer_times'
      nextAsk = bookBlockers.find((b) => INTAKE[b] && b !== 'location') || (bookBlockers.includes('zip') ? 'location' : null)
    } else if (!nextAsk && canBook) flow = 'confirm_booking'
    else if (canOfferTimes) flow = 'offer_times'
  }
  if (flow === 'coverage_request') {
    const need = ['need', 'contact'].filter((id) => !satisfied(id, known, records, coverage))
    nextAsk = need[0] || null
  }
  if (flow === 'handoff' && escalate.action !== 'decline') nextAsk = !known.name || !known.phone ? 'contact' : null

  if (nextAsk && INTAKE[nextAsk]) say('next', `Asks next: ${nextAsk === 'location' && coverage.basis?.startsWith('town') ? 'their ZIP code' : label(nextAsk)}.`)
  if (!canOfferTimes && COVERAGE_OK.has(coverage.status) && !blocksBooking) say('times_wait', `Before offering times, it still needs: ${timesBlockers.map((b) => (INTAKE[b] ? label(b) : b)).join(', ')}.`)
  if (canOfferTimes && !blocksBooking) say('times', 'It can look up open times now. (Times are never guessed: the calendar is checked first.)')
  if (canOfferTimes && !canBook) say('book_wait', `To book, it still needs: ${bookBlockers.map((b) => (b === 'zip' ? 'their ZIP code' : INTAKE[b] ? label(b) : b)).join(', ')}.`)
  if (canBook) say('book_ready', 'Everything needed to book is known: the AI reads the time back and books only after a clear yes.')
  if (intents.has('price') && config?.pricing === 'no_prices') say('pricing', 'Asked about price: the AI doesn’t quote prices; your team confirms them.')
  else if (intents.has('price') && config?.pricing === 'visit_first') say('pricing', 'Asked about price: the AI explains prices are confirmed after the visit.')
  else if (intents.has('price')) say('pricing', 'Asked about price: only prices exactly as listed in your services are said.')
  if (intents.has('reschedule') || intents.has('cancel')) say('reschedule', 'Wants to change or cancel a booking: the AI can’t change existing bookings; it points them to the link in their confirmation email or records a callback request.')
  if (known.hesitant) say('hesitant', 'The customer sounded unsure: the AI gives them time and asks one simple question.')
  return { known, coverage, satisfied: done, missingRequired, nextAsk, canOfferTimes, timesBlockers, canBook, bookBlockers, escalate, flow, explanations, industry: config?.industry || 'general' }
}
