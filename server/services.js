// The business's services: ONE catalog (business_profiles.services JSON) read by the booking page, the AI receptionist,
// the owner assistant, setup checks and the first website draft. Each service:
//   { id, name, price, description, slots, hidden, booking, question }
//   id        stable (sv_ + random), kept across edits and renames so requests and reports never point at the wrong one
//   price     free text the owner writes ("$300 per month", "From $150 per visit"); never invented, never computed
//   slots     appointment length in booking-hours slots (1-4): 2 = twice the business's slot length
//   hidden    temporarily off everywhere (booking page and receptionist) without deleting it
//   booking   'book' (pick a time) | 'request' (quote / consultation request, no time) | 'off' (not on the booking page;
//             the receptionist can still answer about it, e.g. GetShowUps' price plans)
//   question  null | { label, required }: one extra question asked only for this service
// Older rows are { name, price } only: they read as bookable, visible, one slot, no question.
import { unapprovedClaims } from './ads/spec.js'

export const MAX_SERVICES = 16
export const LIMITS = { name: 60, price: 40, description: 160, question: 80, answer: 300, other: 500 }
export const BOOKING_FLOWS = ['book', 'request', 'off']
const ID_RE = /^sv_[a-z0-9]{6,16}$/
const clean = (s) => String(s ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
const newId = () => `sv_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10)}`

// One stored/submitted service → its normalized shape (no id yet). Unknown fields are dropped.
export function normalizeService(s) {
  const q = s?.question && typeof s.question === 'object' ? { label: clean(s.question.label), required: s.question.required === true } : null
  const slots = Number.isInteger(s?.slots) ? s.slots : 1
  return {
    id: typeof s?.id === 'string' && ID_RE.test(s.id) ? s.id : null,
    name: clean(s?.name),
    price: clean(s?.price),
    description: clean(s?.description),
    slots,
    hidden: s?.hidden === true,
    booking: BOOKING_FLOWS.includes(s?.booking) ? s.booking : 'book',
    question: q && q.label ? q : null,
  }
}

// Returns [errors[], services]. ids: an id the previous list had is kept; a duplicate or unknown one is replaced; a
// service without an id inherits the previous id of the same name (so a re-typed list keeps its history), else a new id.
// A form that sends only some fields (e.g. the setup step's { name, price }) keeps the rest of the matching stored
// service: only fields present in the input replace stored ones.
export function validateServices(input, previous = []) {
  const errors = []
  const stored = Array.isArray(previous) ? previous : []
  const match = (s) => stored.find((p) => (s?.id && p?.id === s.id) || clean(p?.name).toLowerCase() === clean(s?.name).toLowerCase())
  const list = (Array.isArray(input) ? input : [])
    .map((s) => {
      const p = s && typeof s === 'object' ? match(s) : null
      return normalizeService(p ? { ...p, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) } : s)
    })
    .filter((s) => s.name)
  if (list.length > MAX_SERVICES) errors.push('services')
  for (const s of list) {
    if (s.name.length > LIMITS.name || s.price.length > LIMITS.price || s.description.length > LIMITS.description) errors.push('services')
    if (s.slots < 1 || s.slots > 4) errors.push('services')
    if (s.question && s.question.label.length > LIMITS.question) errors.push('services')
    if ([s.name, s.price, s.description, s.question?.label].some((t) => t && unapprovedClaims(t).length)) errors.push('services:unapproved_claim')
  }
  const prev = stored.map(normalizeService)
  const byName = new Map(prev.filter((p) => p.id).map((p) => [p.name.toLowerCase(), p.id]))
  const known = new Set(prev.map((p) => p.id).filter(Boolean))
  const taken = new Set()
  const out = list.map((s) => {
    let id = s.id && (known.has(s.id) || !prev.length) && !taken.has(s.id) ? s.id : null
    if (!id) {
      const same = byName.get(s.name.toLowerCase())
      id = same && !taken.has(same) ? same : null
    }
    while (!id || taken.has(id)) id = newId()
    taken.add(id)
    return { ...s, id }
  })
  return [[...new Set(errors)], out]
}

// Stored list → normalized services with ids (older rows get a deterministic id from their position + name, so the
// booking page can reference them before the owner ever re-saves).
export function readServices(stored) {
  return (Array.isArray(stored) ? stored : []).map(normalizeService).filter((s) => s.name).map((s, i) => ({ ...s, id: s.id || legacyId(i, s.name) }))
}
function legacyId(i, name) {
  let h = 2166136261
  for (const c of `${i}:${name.toLowerCase()}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return `sv_l${h.toString(36)}`.slice(0, 19)
}

// What the receptionist and assistant may present as offered: everything not hidden (incl. 'off' = not bookable
// online, e.g. price plans). Same shape the receptionist always had, plus the description.
export const offeredServices = (stored) => readServices(stored).filter((s) => !s.hidden)

// What the booking page offers: visible services that can be booked or requested online.
export function bookingServices(stored, slotMinutes) {
  return offeredServices(stored)
    .filter((s) => s.booking !== 'off')
    .map((s) => ({ id: s.id, name: s.name, price: s.price, description: s.description, minutes: s.slots * slotMinutes, flow: s.booking, question: s.question }))
}

// ---- booking options (migration 0042; before it: "Other / Not sure" offered, as the page always asked openly) ----
export async function bookingOptions(db, customerId) {
  try {
    const r = await db.prepare('SELECT allow_other FROM booking_options WHERE customer = ?1').bind(customerId).first()
    return { ready: true, allowOther: r ? r.allow_other === 1 : true }
  } catch (err) {
    if (String(err?.message).includes('no such table')) return { ready: false, allowOther: true }
    throw err
  }
}
export async function saveBookingOptions(db, customerId, { allowOther }, now = Date.now()) {
  await db
    .prepare('INSERT INTO booking_options (customer, allow_other, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET allow_other = ?2, updated_at = ?3')
    .bind(customerId, allowOther ? 1 : 0, now)
    .run()
}

// The customer's choice on the booking page → [error, choice]. serviceId '' = Other / Not sure (only when allowed, or
// when the business lists no bookable services: then the page asks openly, as it always did).
export function resolveChoice(body, services, allowOther) {
  // A page from before services existed (still open across a deploy) sends no serviceId: its open question stands.
  if (body?.serviceId === undefined) return [null, { service: null, answer: '' }]
  const id = typeof body?.serviceId === 'string' ? body.serviceId : ''
  const answer = clean(body?.answer).slice(0, LIMITS.answer + 1)
  if (answer.length > LIMITS.answer) return ['invalid_answer']
  if (!id) {
    if (services.length && !allowOther) return ['invalid_service']
    return [null, { service: null, answer }]
  }
  const service = services.find((s) => s.id === id)
  if (!service) return ['service_unavailable']
  if (service.question?.required && !answer) return ['invalid_answer']
  return [null, { service, answer }]
}

// The free-text need stored on the lead (what owners already see everywhere): "Service: answer" or the open text.
export function needText(choice, typed) {
  const t = clean(typed)
  if (!choice.service) return t
  return [choice.service.name, choice.answer || t].filter(Boolean).join(': ').slice(0, LIMITS.other)
}

export async function recordLeadService(db, { leadId, customer, choice, minutes, now = Date.now() }) {
  try {
    await db
      .prepare('INSERT OR IGNORE INTO lead_services (lead_id, customer, service_id, service_name, minutes, flow, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(leadId, customer, choice.service?.id ?? null, choice.service?.name ?? 'Other / Not sure', minutes ?? null, choice.service?.flow === 'request' ? 'request' : 'book', now)
      .run()
    return true
  } catch (err) {
    if (String(err?.message).includes('no such table')) return false
    throw err
  }
}

// The appointment length a lead was asked with (NULL / missing table = the business's slot length).
export async function leadMinutes(db, leadId) {
  try {
    const r = await db.prepare('SELECT minutes FROM lead_services WHERE lead_id = ?1').bind(leadId).first()
    return r?.minutes ?? null
  } catch (err) {
    if (String(err?.message).includes('no such table')) return null
    throw err
  }
}
