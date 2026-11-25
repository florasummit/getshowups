// Published config → what a conversation engine needs, provider-neutral:
//   rulesInstructions(): a SHORT block for the cached system prompt (the owner's workflow in plain rules; no business
//     facts — those already come from the records — and never any owner free text beyond validated short phrases).
//   turnNote(): one line per turn from decide(): what is known, the one thing to ask next, what is not allowed yet.
//   exampleReply(): the deterministic example reply "Test your AI" shows (labelled as an example, not the live wording).
// Small on purpose: every extra prompt token is paid on every turn and adds latency.
import { INTAKE, AFTER_HOURS } from './schema.js'

const q = (s) => `"${String(s).replace(/"/g, "'")}"`

export function rulesInstructions(config, records = {}) {
  const order = config.intake.filter((i) => i.required && !(INTAKE[i.id].visitOnly && !records.visit)).map((i) => INTAKE[i.id].ask)
  const lines = [`# How this business wants conversations handled (owner-published rules)`]
  lines.push(`- Information to gather, in this order of priority: ${order.join('; ')}. Customers often give several of these at once: use everything they already said and ask only for what is still missing, one thing at a time. The turn note says what is known and what to ask next; follow it.`)
  const before = config.intake.filter((i) => i.beforeTimes && i.required && i.id !== 'location').map((i) => INTAKE[i.id].ask)
  if (before.length) lines.push(`- Before looking up or offering appointment times, you must know: ${before.join('; ')}.`)
  const optional = config.intake.filter((i) => !i.required).map((i) => INTAKE[i.id].ask)
  if (optional.length) lines.push(`- Do not ask about these unless the customer brings them up: ${optional.join('; ')}.`)
  if (config.services.excluded.length) lines.push(`- The business does NOT offer: ${config.services.excluded.map(q).join(', ')}. Say so plainly and offer what it does; never book these.`)
  if (config.coverage.cityWide.length) lines.push(`- These towns are fully served (no ZIP code needed to confirm the area; check_service_area with the town as place answers served): ${config.coverage.cityWide.map(q).join(', ')}. A ZIP code is still recorded with the booking details, asked once, only when they book.`)
  if (config.emergency.triggers.length) {
    const act = { urgent_callback: 'record an urgent callback request', book_soonest: 'offer the soonest open time', callback_and_book: 'record an urgent callback request and offer the soonest open time' }[config.emergency.action]
    lines.push(`- Treat these as urgent: ${config.emergency.triggers.map(q).join(', ')}. When one comes up: ${act}.`)
  }
  for (const e of config.escalation) {
    const when = e.when === 'phrase' ? `the customer mentions ${q(e.phrase)}` : { person: 'they ask for a person', installation: 'they ask about a new installation or replacement', commercial: 'it is a commercial property', complaint: 'they complain about past work', complex: 'the job sounds large or complex' }[e.when]
    lines.push(`- When ${when}: ${e.action === 'message' ? 'offer to take a message (leave_message)' : 'offer to record a callback request (request_callback)'}; there is no live transfer.`)
  }
  if (config.afterHours !== 'book_normally') lines.push(`- Outside booking hours: ${AFTER_HOURS[config.afterHours].toLowerCase()}.`)
  if (config.pricing === 'no_prices') lines.push('- Never state any price, even listed ones: say the team confirms pricing.')
  if (config.pricing === 'visit_first') lines.push('- Explain that the final price is confirmed after the visit; only listed prices may be mentioned.')
  lines.push(`- Tone: ${{ warm: 'warm and friendly', brief: 'brief and to the point', formal: 'polite and formal' }[config.style]}.`)
  lines.push('- If a rule here ever conflicts with the platform rules above (safety, area check, confirmed bookings, no invented prices), the platform rules win.')
  return lines.join('\n')
}

const ASK_LINE = { location_zip: 'their ZIP code', confirm_location: 'which location is right (they mentioned two)', confirm_zip: 'to double-check their ZIP code' }
export function turnNote(d, version) {
  const k = d.known
  const parts = []
  const facts = []
  if (k.need || k.service) facts.push(`need=${k.service || k.need}`)
  if (k.city) facts.push(`town=${k.city}`)
  if (k.zip) facts.push(`zip=${k.zip}`)
  if (k.street) facts.push('street=given')
  if (k.urgency) facts.push(`urgent=${k.urgency === 'urgent' ? 'yes' : 'no'}`)
  if (k.equipment) facts.push(`equipment=${k.equipment}`)
  if (k.day || k.part) facts.push(`when=${[k.day, k.part].filter(Boolean).join(' ')}`)
  if (k.existing !== undefined) facts.push(`existing_customer=${k.existing ? 'yes' : 'no'}`)
  for (const [id, v] of Object.entries(k.answers || {})) facts.push(`${id}=${v}`)
  parts.push(`Rules check (v${version}): known ${facts.length ? facts.join(', ') : 'nothing yet'} — never ask for these again.`)
  if (k.corrected?.length) parts.push(`They corrected: ${k.corrected.join(', ')}; use the newest value.`)
  const uncertain = { town_partly_served: `area not confirmed yet: only part of ${k.city} is served; never say ${k.city} is covered`, town_not_listed: `area not confirmed yet: ${k.city} is not on the business's list; never say it is covered`, zip_not_listed_in_served_town: `${k.city} is fully served but ZIP ${k.zip} is not on the ZIP list: no times; offer a service-area request` }
  const cov = { verified: 'area verified by ZIP', verified_city: `area verified: ${k.city} is fully served (say so plainly; do not ask for a ZIP to confirm the area)`, not_limited: 'area not limited', rejected: 'ZIP outside the list: no times; offer a service-area request', uncertain: uncertain[d.coverage.basis] || 'area not confirmed yet', unknown: 'area not known yet' }[d.coverage.status]
  parts.push(`Coverage: ${cov}.`)
  if (d.escalate) {
    const e = d.escalate
    if (e.kind === 'safety') parts.push(`SAFETY FIRST: tell them to get to safety${e.reason === 'call_911' ? ' and call 911 (or the gas company) now' : ', stay away from it, and call 911 if there is fire or smoke'}; then ${e.action === 'urgent_callback' ? 'record an urgent callback request' : 'offer the soonest time and record an urgent callback request'}.`)
    else if (e.kind === 'excluded') parts.push(`The business does not offer ${q(e.reason)}: say so${e.action === 'decline' ? ' and offer what it does' : `, then offer to ${e.action === 'message' ? 'take a message' : 'record a callback request'}`}. Do not book it.`)
    else if (e.kind === 'after_hours') parts.push('Outside booking hours: do not book; offer a callback request.')
    else if (e.kind === 'after_hours_urgent') parts.push('Urgent and outside booking hours: record an urgent callback request; booking is still allowed.')
    else parts.push(`Owner rule (${e.kind}): offer to ${e.action === 'message' ? 'take a message' : e.action === 'book_soonest' ? 'book the soonest open time' : 'record a callback request'}${e.urgent ? ' (urgent)' : ''}.`)
  }
  const locationAsk = d.coverage.ask === 'zip' && d.coverage.basis === 'town_partly_served' ? `which part of ${k.city} (one short question: "What part of ${k.city}?"; a neighbourhood or a ZIP code answers it)` : ASK_LINE[d.coverage.ask === 'zip' ? 'location_zip' : d.coverage.ask] || INTAKE.location.ask
  if (d.nextAsk) parts.push(`Ask next (only this): ${d.coverage.ask && d.nextAsk === 'location' ? locationAsk : INTAKE[d.nextAsk].ask}.`)
  else if (d.flow === 'offer_times') parts.push('You may look up and offer open times now.')
  else if (d.flow === 'confirm_booking') parts.push('Everything needed is known: read back the time and book only after a clear yes.')
  if (!d.canOfferTimes && !d.escalate) parts.push(`Do NOT look up or offer times yet (still needed: ${d.timesBlockers.join(', ')}).`)
  return parts.join(' ')
}

// The example reply for "Test your AI" (deterministic; the live AI words it naturally).
// fresh = what THIS message said (only that is acknowledged; earlier facts were acknowledged when they were said).
// taught: what the owner taught that this message asks about (simulate.js).
export function exampleReply(d, records = {}, fresh = d.known, taught = []) {
  const k = d.known
  const f = fresh || {}
  const bits = []
  const ack = []
  if (f.service || f.need) ack.push(String(f.service || f.need).replace(/^\w/, (c) => c.toLowerCase()))
  if (f.city) ack.push(`in ${f.city}`)
  if (f.day) ack.push(`on ${f.day}`)
  if (f.name && !ack.length) ack.push(`thanks, ${f.name}`)
  if (d.escalate?.kind === 'safety') {
    bits.push(d.escalate.reason === 'call_911' ? 'Please get everyone to safety and call 911 or your gas company right away.' : 'Please stay away from it, and call 911 if there’s any fire or smoke.')
    bits.push(d.escalate.action === 'urgent_callback' ? 'I’ll record an urgent callback request for the team. What’s your name and the best number to reach you?' : 'Once you’re safe, I can find the soonest visit.')
    return bits.join(' ')
  }
  if (d.escalate?.kind === 'excluded') return `Sorry, we don’t do ${String(d.escalate.reason).toLowerCase()}.${(records.services || []).length ? ` We can help with ${records.services.slice(0, 3).map((s) => s.name).join(', ')}.` : ''}${d.escalate.action !== 'decline' ? ' I can record a callback request if you’d like to talk it over with the team.' : ''}`
  for (const t of taught) bits.push(/[.!?]$/.test(t.text) ? t.text : `${t.text}.`)
  if (ack.length) bits.push(ack[0].startsWith('thanks') ? `${ack[0].replace(/^t/, 'T')}.` : `Got it: ${ack.join(' ')}.`)
  if (d.coverage.status === 'verified_city' && f.city) bits.push(`${k.city} is in our service area.`)
  if (d.coverage.status === 'verified' && f.zip) bits.push('You’re in our service area.')
  if (d.coverage.status === 'rejected' || d.coverage.basis === 'zip_not_listed_in_served_town') bits.push('We may be able to help in your area. Leave your details and we’ll confirm availability.')
  if (d.escalate && !['safety', 'excluded'].includes(d.escalate.kind)) bits.push(d.escalate.action === 'message' ? 'I can take a message for the team.' : 'I can record a callback request for the team.')
  const ask = {
    need: 'What can we help you with?',
    urgency: 'Is this urgent, or something that can wait a few days?',
    location: d.coverage.ask === 'confirm_location' ? 'Which location is the job at?' : d.coverage.ask === 'confirm_zip' ? 'Could you double-check that ZIP code for me?' : d.coverage.basis === 'town_partly_served' || d.coverage.basis === 'town_not_listed' ? 'What’s the ZIP code there?' : 'What’s the ZIP code where you need the service?',
    equipment: 'What kind of equipment or system is it?',
    existing_customer: 'Have you used us before?',
    preferred_time: 'What day works best for you?',
    contact: 'What’s your name and the best phone number to reach you?',
    address: 'What’s the address for the visit?',
  }
  if (d.nextAsk) bits.push(ask[d.nextAsk])
  else if (d.flow === 'offer_times') bits.push('Let me check the calendar for open times.')
  else if (d.flow === 'confirm_booking') bits.push('I’ll read the time back to you and book it once you say yes.')
  return bits.join(' ') || 'How can I help you today?'
}
