// AI receptionist engine: ONE shared, multi-tenant conversation engine for website chat and voice (one conversation can
// move between them: a caller can type their phone number into the chat mid-call).
//
// - Model: Claude (Anthropic API, GetShowUps-paid key RECEPTIONIST_ANTHROPIC_API_KEY — its own secret so receptionist
//   spend is separate and setting it switches nothing else on; RECEPTIONIST_MODEL overrides the model id). Real
//   inference only; when the model is unavailable the customer gets a fixed message with the booking link and phone.
// - Knowledge: the business's verified records only (knowledge.js), in a cached per-business system prompt; customer
//   text never goes there.
// - Customer details: collected ONLY through save_customer_details, validated deterministically (phone digits and ZIP
//   must be in what the customer said — spoken digits normalized; email format), kept in conversation state and given
//   back to the model every turn, so nothing already known is asked again.
// - Tools run on the SERVER, bound to the conversation's business: service area, real Google Calendar availability
//   (openSlots), booking through bookAppointment (double-booking guard, Google event, confirmations/reminders), a
//   callback request or a message (durable receptionist_requests rows; staff notification tracked separately). There
//   is NO live transfer: the receptionist says so and offers a callback or a message.
// - Guards: only times this conversation was shown can be booked; the customer's own confirming words must be in their
//   latest message; one booking per conversation; a $ amount not in the records (or a price said in words) is never
//   shown or spoken; cost and turn limits; a turn the caller interrupted is dropped unless it already acted.
// - History is kept as the model produced it (append-only). What the customer actually saw or heard is logged
//   separately (state.log) and is what the customer page and the owner see.
import Anthropic from '@anthropic-ai/sdk'
import { randomToken } from '../google-oauth.js'
import { linkToken, verifyLinkToken } from '../links.js'
import { createLead, bookAppointment, dispatchBooked, openSlots, recordAvailability, validateLead } from '../booking.js'
import { providerMock } from '../ai-credentials.js'
import { toE164 } from '../sms.js'
import { syncLead, syncStage, syncNote } from '../ghl.js'
import { keepableAttribution, recordAttribution } from '../ads/attribution.js'
import { areaFor, checkZip } from '../zipcode.js'
import { knowledgeFor, systemPrompt, factText } from './knowledge.js'
import { spokenToDigits } from './digits.js'
import { activeRules, decisionFor, noteAnswer, observe, ruleBlock, NOTE_ANSWER_TOOL } from '../intelligence/runtime.js'
import { rulesInstructions, turnNote } from '../intelligence/compile.js'

export const RECEPTIONIST_TABLES = ['receptionist_settings', 'receptionist_conversations', 'receptionist_events', 'receptionist_calls']
export const DEFAULT_MODEL = 'claude-opus-5-5'
// $ per million tokens (Claude Opus 5.5): input 4, output 20, cache read 0.20, cache write 5 (1.25×).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
export const LIMITS = {
  turnsPerConversation: 60,
  conversationMicros: 1_000_000, // $1.00 per conversation
  businessDailyMicros: 5_000_000, // $5.00 per business per UTC day (RECEPTIONIST_DAILY_MICROS overrides)
  modelCallsPerTurn: 6,
  textChars: 1500,
  offeredSlots: 4,
  log: 200,
}
const MODEL_TIMEOUT_MS = 25_000
export const VOICE_MODEL_TIMEOUT_MS = 10_000

const ready = new WeakSet()
export async function receptionistReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const r = await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${RECEPTIONIST_TABLES.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...RECEPTIONIST_TABLES).first()
    const ok = Number(r?.n) === RECEPTIONIST_TABLES.length
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}
// Callback/message requests (migration 0027). Before it, the receptionist can't take callbacks and says so.
const requestsReady = new WeakSet()
export async function receptionistRequestsReady(db) {
  if (!db) return false
  if (requestsReady.has(db)) return true
  try {
    const r = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'receptionist_requests'").first()
    if (r) requestsReady.add(db)
    return Boolean(r)
  } catch {
    return false
  }
}
export const modelConfigured = (env) => Boolean(env.RECEPTIONIST_ANTHROPIC_API_KEY) && env.RECEPTIONIST_ENABLED !== 'false'
const MODEL_RE = /^claude-[a-z0-9-]{3,60}$/
const modelId = (env, channel) => (channel === 'voice' && MODEL_RE.test(env.RECEPTIONIST_VOICE_MODEL || '') ? env.RECEPTIONIST_VOICE_MODEL : MODEL_RE.test(env.RECEPTIONIST_MODEL || '') ? env.RECEPTIONIST_MODEL : DEFAULT_MODEL)
const dailyCap = (env) => (Number.isInteger(Number(env.RECEPTIONIST_DAILY_MICROS)) && Number(env.RECEPTIONIST_DAILY_MICROS) > 0 ? Number(env.RECEPTIONIST_DAILY_MICROS) : LIMITS.businessDailyMicros)

export async function getSettings(db, customerId) {
  const r = await db.prepare('SELECT * FROM receptionist_settings WHERE customer = ?1').bind(customerId).first()
  return { enabled: Boolean(r?.enabled), mode: r?.mode || 'ai_first', greeting: r?.greeting || '', knowledge: r?.knowledge || '', transferPhone: r?.transfer_phone || '' }
}

// Is the receptionist offered for this (already bookable) business right now?
export async function receptionistOn(env, customer) {
  if (!modelConfigured(env) || !(await receptionistReady(env.ONBOARDING_DB))) return false
  return (await getSettings(env.ONBOARDING_DB, customer.id).catch(() => ({ enabled: false }))).enabled
}

// ---------- conversations ----------

const conversationToken = (env, id) => linkToken(env, 'receptionist', id)
// attribution: the ad parameters the chat page was opened with (website link from an ad) — kept as campaign parameters
// only (keepableAttribution: never a click id), and recorded on the lead if the conversation books.
export async function startConversation(env, customer, channel, now = Date.now(), { attribution = null } = {}) {
  const id = randomToken(12)
  const kept = keepableAttribution(attribution)
  await env.ONBOARDING_DB.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?1, ?2, ?3, ?5, '[]', ?4, ?4)")
    .bind(id, customer.id, channel, now, JSON.stringify(kept ? { attribution: kept } : {}))
    .run()
  return { id, token: await conversationToken(env, id) }
}
export { conversationToken }
// The conversation for (business, id, token) — never another business's.
export async function loadConversation(env, customer, id, token) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) return null
  if (token !== undefined && !(await verifyLinkToken(env, 'receptionist', id, String(token || '')))) return null
  const r = await env.ONBOARDING_DB.prepare('SELECT * FROM receptionist_conversations WHERE id = ?1 AND customer = ?2').bind(id, customer.id).first()
  if (!r) return null
  return { ...r, state: JSON.parse(r.state || '{}'), transcript: JSON.parse(r.transcript || '[]') }
}

// The customer closes the conversation: no more turns; a new one starts clean.
export async function endConversation(env, customer, conv, now = Date.now()) {
  if (conv.state.endedAt) return { ok: true, already: true }
  conv.state.endedAt = now
  await env.ONBOARDING_DB.prepare("UPDATE receptionist_conversations SET state = ?3, status = CASE WHEN status = 'open' THEN 'closed' ELSE status END, updated_at = ?4 WHERE id = ?1 AND customer = ?2")
    .bind(conv.id, customer.id, JSON.stringify(conv.state), now)
    .run()
  await event(env, conv, 'ended', true, null, now)
  return { ok: true }
}

async function event(env, conv, kind, ok, detail = null, now = Date.now()) {
  await env.ONBOARDING_DB.prepare('INSERT INTO receptionist_events (customer, conversation_id, kind, ok, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(conv.customer, conv.id, String(kind).slice(0, 40), ok ? 1 : 0, detail == null ? null : String(detail).slice(0, 80), now)
    .run()
    .catch(() => {})
}

async function spentToday(db, customerId, now) {
  const day = now - (now % 86_400_000)
  const r = await db.prepare('SELECT coalesce(sum(cost_micros), 0) AS c FROM receptionist_conversations WHERE customer = ?1 AND updated_at >= ?2').bind(customerId, day).first()
  return Number(r?.c) || 0
}

// ---------- deterministic customer-detail checks ----------

// "two nine four zero three" / "double five" → digits (server/receptionist/digits.js; re-exported for existing callers).
export { spokenToDigits }
// All digits the customer has said or typed, in order (separators between digit groups removed).
const customerWords = (conv) => conv.transcript.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content)
const digitsSaid = (conv) => customerWords(conv).map((t) => spokenToDigits(t).replace(/[^\d]/g, '')).join('|')

export function checkDetails(input, conv, channel) {
  const out = {}
  const problems = {}
  const said = digitsSaid(conv)
  if (input.name) {
    const n = String(input.name).trim().replace(/\s+/g, ' ').slice(0, 80)
    if (n.length >= 2) out.name = n
    else problems.name = 'too_short'
  }
  if (input.phone) {
    let d = spokenToDigits(input.phone).replace(/\D/g, '')
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
    if (d.length !== 10) problems.phone = 'phone_incomplete'
    else if (!said.includes(d) && !said.includes(`1${d}`)) problems.phone = 'phone_not_heard'
    else out.phone = toE164(d)
  }
  if (input.email) {
    const e = String(input.email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) problems.email = 'email_invalid'
    else if (channel === 'chat' && !customerWords(conv).join(' ').toLowerCase().includes(e)) problems.email = 'email_not_typed'
    else out.email = e
  }
  if (input.zip) {
    const z = spokenToDigits(input.zip).replace(/\D/g, '')
    if (z.length !== 5) problems.zip = 'zip_invalid'
    else if (!said.includes(z)) problems.zip = 'zip_not_heard'
    else out.zip = z
  }
  for (const k of ['street', 'city', 'state', 'need']) if (input[k]) out[k] = String(input[k]).trim().slice(0, k === 'need' ? 300 : 120)
  if (out.state) out.state = out.state.toUpperCase().slice(0, 2)
  return { values: out, problems }
}

const PROBLEM_NOTE = {
  phone_incomplete: 'The phone number you passed is not 10 digits. Read back the digits you heard and ask them to repeat just the phone number.',
  phone_not_heard: 'Those digits are not what the customer said or typed. Ask them to repeat just the phone number (they can also type it in the chat).',
  email_invalid: 'That is not a valid email address. Ask them to spell it.',
  email_not_typed: 'Use the email exactly as the customer typed it.',
  zip_invalid: 'A ZIP code has 5 digits. Ask for it again.',
  zip_not_heard: 'That ZIP is not what the customer said. Ask them to repeat it.',
  name_too_short: 'Ask for their name.',
}

export function missingForBooking(c, customer) {
  const need = []
  if (!c.name) need.push('name')
  if (!c.phone) need.push('phone')
  if (customer.serviceZips.length && !c.zip) need.push('zip')
  if (customer.appointmentMode === 'at_customer' && !(c.street && c.city && c.state && c.zip)) need.push('service address (street, city, state, ZIP)')
  if (!c.need) need.push('what they need')
  return need
}

function knownLine(s, customer) {
  const c = s.customer || {}
  const parts = []
  if (c.name) parts.push(`name: ${c.name}`)
  if (c.phone) parts.push(`phone: ${c.phone}`)
  if (c.email) parts.push(`email: ${c.email}`)
  if (c.zip) parts.push(`ZIP: ${c.zip}${s.inArea === false ? ' (OUTSIDE the service area)' : s.inArea ? ' (served)' : ''}`)
  if (c.street) parts.push(`address: ${[c.street, c.city, c.state].filter(Boolean).join(', ')}`)
  if (c.need) parts.push(`needs: ${c.need}`)
  if (s.booked) parts.push(`BOOKED: ${slotLabel(s.booked.start, customer.timezone)}`)
  if (s.requests?.callback) parts.push('callback request: recorded')
  if (s.requests?.message) parts.push('message: recorded')
  if (!parts.length) return null
  const missing = s.booked ? [] : missingForBooking(c, customer)
  return `Verified customer details so far (do NOT ask for these again): ${parts.join('; ')}.${missing.length && !s.booked ? ` Still needed only if they want to book: ${missing.join(', ')}.` : ''}`
}

// ---------- tools (server-side, bound to the conversation's business) ----------

const str = (description) => ({ type: 'string', description })
export const TOOLS = [
  {
    name: 'save_customer_details',
    description:
      'Record details the customer just gave (name, phone, email, ZIP, service address, what they need). Call it as soon as they give any detail; pass empty strings for anything not given in this turn. Returns what is now known, what is still needed to book, and any detail that needs a targeted re-check.',
    input_schema: {
      type: 'object',
      properties: { name: str('Full name'), phone: str('Phone number as said or typed'), email: str('Email address'), zip: str('5-digit ZIP code as said'), street: str('Street address (only if the business comes to them)'), city: str('City'), state: str('Two-letter state'), need: str('Short description of the service they want') },
      required: ['name', 'phone', 'email', 'zip', 'street', 'city', 'state', 'need'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'check_service_area',
    description: 'Check whether the business serves a US ZIP code the customer gave. Use it before offering to book.',
    input_schema: { type: 'object', properties: { zip: str('5-digit ZIP code') }, required: ['zip'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'request_coverage',
    description:
      "Record a service-area request when the customer's ZIP is not on the service list (or couldn't be found and they confirmed it). Needs their ZIP, name, phone and what they need, saved first with save_customer_details. The team confirms availability; it does not book anything and guarantees nothing.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'find_available_times',
    description: "Look up real open appointment times on the business's calendar (next 14 days). Returns up to 4 options with slot ids. Only these may be offered or booked. Call it again when the customer wants a different day or time of day.",
    input_schema: {
      type: 'object',
      properties: { date: str("Preferred day as YYYY-MM-DD in the business's time zone, or empty for the soonest days"), part_of_day: { type: 'string', enum: ['any', 'morning', 'afternoon', 'evening'] } },
      required: ['date', 'part_of_day'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'book_appointment',
    description:
      'Book one time returned by find_available_times, using the details saved with save_customer_details. Call ONLY after reading back the service, day, time and time zone and the customer clearly confirmed in their latest message; confirmation_quote must be their exact confirming words from that message.',
    input_schema: { type: 'object', properties: { slot_id: str('slot_id from find_available_times'), confirmation_quote: str("The customer's exact confirming words") }, required: ['slot_id', 'confirmation_quote'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'request_callback',
    description:
      "Record that the customer wants the business to call them back. Needs their name and phone (save them first). Live transfer to a person is NOT possible here, so use this when they ask for a person and want a call. Records the request for the team; it does not guarantee when they will call.",
    input_schema: { type: 'object', properties: { reason: str('What they want to talk about, in a few words'), urgent: { type: 'boolean' } }, required: ['reason', 'urgent'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'leave_message',
    description: 'Record a message from the customer for the business (when they want to leave a message instead of a callback or booking). Needs their name and a phone or email (save them first).',
    input_schema: { type: 'object', properties: { message: str('The message in their words'), urgent: { type: 'boolean' } }, required: ['message', 'urgent'], additionalProperties: false },
    strict: true,
  },
]

const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|correct|book (it|that)|sounds (good|great)|perfect|please do|do it|go ahead|that works|works for me|let'?s do)\b/i
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const localParts = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
export const slotLabel = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms))

async function upsertRequest(ctx, kind, note, urgent) {
  const { env, customer, conv, now } = ctx
  const c = conv.state.customer || {}
  const db = env.ONBOARDING_DB
  if (!(await receptionistRequestsReady(db))) return { ok: false, error: 'requests_unavailable', note: 'Callback requests are not available yet; give the business phone number instead.' }
  if (!c.name) return { ok: false, error: 'name_needed', note: 'Ask for their name first, then save it.' }
  if (kind === 'callback' && !c.phone) return { ok: false, error: 'phone_needed', note: 'Ask for the best phone number to call, then save it.' }
  if (kind === 'message' && !c.phone && !c.email) return { ok: false, error: 'contact_needed', note: 'Ask for a phone number or email so the business can reply.' }
  const id = randomToken(12)
  await db
    .prepare(
      `INSERT INTO receptionist_requests (id, customer, conversation_id, kind, name, phone, email, note, urgent, status, held, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', 0, ?10, ?10)
       ON CONFLICT(conversation_id, kind) DO UPDATE SET name = ?5, phone = ?6, email = ?7, note = ?8, urgent = max(urgent, ?9), status = 'open', updated_at = ?10`,
    )
    .bind(id, customer.id, conv.id, kind, c.name, c.phone || null, c.email || null, String(note || '').slice(0, 400), urgent ? 1 : 0, now)
    .run()
  const row = await db.prepare('SELECT id FROM receptionist_requests WHERE conversation_id = ?1 AND kind = ?2 AND customer = ?3').bind(conv.id, kind, customer.id).first()
  conv.state.requests = { ...(conv.state.requests || {}), [kind]: row?.id || id }
  ctx.committed = true
  if (conv.status !== 'booked') conv.status = 'handoff'
  if (conv.outcome !== 'booked') conv.outcome = kind === 'callback' ? (urgent ? 'callback_urgent' : 'callback') : 'message'
  if (conv.state.leadId) ctx.after.push(() => syncNote(env, customer.id, conv.state.leadId, `${kind}:${conv.id}`, `GetShowUps receptionist ${kind === 'callback' ? 'callback request' : 'message'}${urgent ? ' (URGENT)' : ''}: ${note}`, now))
  return { ok: true, recorded: true, kind, tell_customer: kind === 'callback' ? `Say you've recorded their callback request for the ${customer.name} team with their number. Do not promise when they will call or that anyone has been told.` : `Say you've recorded their message for the ${customer.name} team. Do not promise when they will reply.` }
}

// The conversation's one lead (created on first need: a booking or a service-area request). Returns its id, or null
// while another turn of the same conversation is creating it.
async function leadFor(ctx, lead) {
  const { env, customer, conv, now } = ctx
  const s = conv.state
  if (s.leadId) return s.leadId
  // One lead per conversation even when two turns act at once (voice + chat, double send): claim the id on the
  // conversation row first; only the winner creates the lead, the other turn reuses it.
  const db = env.ONBOARDING_DB
  const mine = randomToken(12)
  let leadId
  const claim = await db.prepare('UPDATE receptionist_conversations SET lead_id = ?3 WHERE id = ?1 AND customer = ?2 AND lead_id IS NULL').bind(conv.id, customer.id, mine).run()
  if (claim?.meta?.changes > 0) {
    try {
      await createLead(env, customer, { ...lead, source: ctx.channel === 'voice' ? 'call' : 'chat' }, now, { id: mine })
    } catch (err) {
      await db.prepare('UPDATE receptionist_conversations SET lead_id = NULL WHERE id = ?1 AND customer = ?2 AND lead_id = ?3').bind(conv.id, customer.id, mine).run()
      throw err
    }
    leadId = mine
    // From an ad (the chat page was opened with its campaign parameters): tie the lead to that campaign.
    if (s.attribution) await recordAttribution(env, customer.id, mine, s.attribution, now).catch((e) => console.error('receptionist attribution failed:', e?.name))
    ctx.after.push(() => syncLead(env, customer.id, leadId, now))
  } else {
    const row = await db.prepare('SELECT l.id FROM receptionist_conversations c JOIN leads l ON l.id = c.lead_id AND l.customer = c.customer WHERE c.id = ?1 AND c.customer = ?2').bind(conv.id, customer.id).first()
    if (!row) return null
    leadId = row.id
  }
  s.leadId = leadId
  conv.lead_id = leadId
  return leadId
}

async function runTool(ctx, name, input) {
  const { env, customer, conv, now } = ctx
  const s = conv.state
  s.customer = s.customer || {}
  if (name === 'save_customer_details') {
    const { values, problems } = checkDetails(input, conv, ctx.channel)
    Object.assign(s.customer, values)
    if (values.zip) {
      s.inArea = areaFor(customer, values.zip) === 'in'
      if (!s.inArea) conv.outcome = conv.outcome || 'out_of_area'
    }
    const notes = Object.entries(problems).map(([k, p]) => `${k}: ${PROBLEM_NOTE[p] || PROBLEM_NOTE[`${k}_${p}`] || p}`)
    return { ok: Object.keys(problems).length === 0, saved: Object.keys(values), known: s.customer, in_service_area: s.inArea ?? null, still_needed_to_book: s.booked ? [] : missingForBooking(s.customer, customer), ...(notes.length ? { recheck: notes } : {}) }
  }
  if (name === 'check_service_area') {
    const zip = spokenToDigits(input.zip).replace(/\D/g, '').slice(0, 5)
    if (!/^\d{5}$/.test(zip)) return { ok: false, error: 'invalid_zip', note: 'A ZIP code has 5 digits. Ask for it again.' }
    const { check } = checkZip(zip)
    const area = areaFor(customer, zip, check)
    const served = area === 'in'
    if (digitsSaid(conv).includes(zip)) s.customer.zip = zip
    s.inArea = served
    if (!served) conv.outcome = conv.outcome || 'out_of_area'
    if (served) return { ok: true, zip, served }
    // Not on the business's list (or not a ZIP we know): never a dead end, never a booking.
    return {
      ok: true,
      zip,
      served: false,
      ...(check === 'unknown' ? { zip_known: false } : {}),
      note: `${check === 'unknown' ? "That ZIP isn't one we can find: ask them to double-check it once. If they confirm it, continue. " : ''}Say: "We may be able to help in your area. Leave your details and we'll confirm availability." Collect their name, phone and what they need (save_customer_details), then call request_coverage. Do not offer times or book.`,
    }
  }
  if (name === 'request_coverage') {
    const c = s.customer
    if (!c.zip) return { ok: false, error: 'zip_missing', note: 'Ask for their ZIP code first (save_customer_details).' }
    if (areaFor(customer, c.zip) === 'in') return { ok: false, error: 'in_area', note: 'They are in the service area: offer times instead.' }
    const missing = ['name', 'phone', 'need'].filter((k) => !c[k])
    if (missing.length) return { ok: false, error: 'details_missing', missing, note: `Ask only for: ${missing.join(', ')} (save them with save_customer_details).` }
    const [error, lead] = validateLead({ name: c.name, email: c.email || '', phone: c.phone, need: c.need, zip: c.zip, zipConfirmed: true }, 'at_business', { requireEmail: false })
    if (error) return { ok: false, error, note: 'Ask the customer to correct this detail.' }
    const leadId = await leadFor(ctx, lead)
    if (!leadId) return { ok: false, error: 'in_progress', note: 'Their request is being saved right now: do not repeat it.' }
    s.coverageRequested = true
    conv.outcome = 'coverage_request'
    ctx.committed = true
    ctx.after.push(() => syncNote(env, customer.id, leadId, `coverage:${conv.id}`, `Service-area request from the GetShowUps receptionist (${ctx.channel}): ZIP ${c.zip}. Need: ${c.need}`, now))
    return {
      ok: true,
      recorded: true,
      tell_customer: `Say ${customer.name} has their details and will confirm whether they can help at ZIP ${c.zip}. Do not promise service, a time or when they will hear back. Do not offer times.`,
    }
  }
  if (name === 'note_answer') {
    if (!ctx.rules) return { ok: false, error: 'unknown_tool' }
    return noteAnswer(conv, input)
  }
  if (name === 'find_available_times') {
    // Owner rules (e.g. "know whether it's urgent before offering times"), checked before the calendar is touched.
    const held = ctx.rules ? ruleBlock(decisionFor(ctx.rules, conv), 'find_available_times') : null
    if (held) return held
    const r = await openSlots(env, customer, now)
    await recordAvailability(env, customer.id, r, now)
    if (!r.ok) return { ok: false, error: 'calendar_unavailable', note: "The calendar can't be reached right now. Offer a callback request or the booking page instead; do not guess times." }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : ''
    const part = input.part_of_day || 'any'
    const inPart = (h) => part === 'any' || (part === 'morning' ? h < 12 : part === 'afternoon' ? h >= 12 && h < 17 : h >= 17)
    let picks = r.slots.filter((x) => {
      const p = localParts(x.start, customer.timezone)
      return (!date || `${p.year}-${p.month}-${p.day}` === date) && inPart(Number(p.hour))
    })
    // Spread the options across the matching days instead of back-to-back times.
    if (picks.length > LIMITS.offeredSlots) {
      const step = picks.length / LIMITS.offeredSlots
      picks = Array.from({ length: LIMITS.offeredSlots }, (_, i) => picks[Math.floor(i * step)])
    }
    s.offered = s.offered || {}
    const options = picks.map((x) => {
      const id = `s${x.start.toString(36)}`
      s.offered[id] = x.start
      return { slot_id: id, time: slotLabel(x.start, customer.timezone) }
    })
    return { ok: true, timezone: customer.timezone, options, note: options.length ? 'Offer two or three of these.' : 'Nothing open for that request: say so and offer another day or part of the day.' }
  }
  if (name === 'book_appointment') {
    if (s.booked) return { ok: true, already_booked: true, time: slotLabel(s.booked.start, customer.timezone), note: 'This conversation already has a booking; do not book again.' }
    const start = s.offered?.[input.slot_id]
    if (!Number.isInteger(start)) return { ok: false, error: 'slot_not_offered', note: 'Only times from find_available_times in this conversation can be booked.' }
    const quote = norm(input.confirmation_quote)
    if (!quote || !norm(ctx.userText).includes(quote) || !AFFIRM.test(input.confirmation_quote)) {
      return { ok: false, error: 'confirmation_required', note: "The customer's latest message must clearly confirm this exact time. Read it back and ask them to confirm." }
    }
    // Owner rules on top of the platform guards below (never instead of them): excluded services, required intake,
    // after-hours handling, urgent situations that must be handed off first.
    const held = ctx.rules ? ruleBlock(decisionFor(ctx.rules, conv), 'book_appointment') : null
    if (held) return held
    const c = s.customer
    const missing = missingForBooking(c, customer)
    if (missing.length) return { ok: false, error: 'details_missing', missing, note: `Ask only for: ${missing.join(', ')} (save them with save_customer_details).` }
    if (areaFor(customer, c.zip) !== 'in')
      return { ok: false, error: 'out_of_area', note: 'Not on the service list: do not book. Offer to record a service-area request (request_coverage) so the team can confirm availability.' }
    const body = { name: c.name, email: c.email || '', phone: c.phone, need: c.need, zip: c.zip || '' }
    if (customer.appointmentMode === 'at_customer') body.address = { street: c.street, unit: '', city: c.city, state: c.state, zip: c.zip }
    const [error, lead] = validateLead(body, customer.appointmentMode, { requireEmail: false })
    if (error) return { ok: false, error, note: 'Ask the customer to correct this detail.' }
    const leadId = await leadFor(ctx, lead)
    if (!leadId) return { ok: false, error: 'booking_in_progress', note: 'A booking for this customer is being made right now: say you are checking and do not book again.' }
    const r = await bookAppointment(env, customer, { leadId, leadToken: await linkToken(env, 'lead', leadId), start }, now)
    if (!r.ok) {
      if (r.error === 'slot_unavailable') delete s.offered[input.slot_id]
      const note = r.error === 'slot_unavailable' ? 'That time was just taken: say so and look up times again.' : r.error === 'already_booked' ? 'This customer already has a booking.' : "Booking didn't go through: say so honestly and offer to try another time or a callback request. Never say it is booked."
      return { ok: false, error: r.error, note }
    }
    s.booked = { appointmentId: r.appointment.id, start }
    conv.appointment_id = r.appointment.id
    conv.status = 'booked'
    conv.outcome = 'booked'
    ctx.committed = true
    ctx.bookedNow = r.appointment.id
    ctx.after.push(() => syncStage(env, customer.id, leadId, 'booked', null, now))
    ctx.after.push(() => syncNote(env, customer.id, leadId, `booked:${conv.id}`, `Booked by the GetShowUps receptionist (${ctx.channel}) for ${slotLabel(start, customer.timezone)}. Need: ${lead.need}`, now))
    return { ok: true, booked: true, time: slotLabel(start, customer.timezone), confirmation: lead.email ? `A confirmation email goes to ${lead.email}.` : 'It is on the calendar; no confirmation email (no email given).' }
  }
  if (name === 'request_callback') return upsertRequest(ctx, 'callback', input.reason, input.urgent)
  if (name === 'leave_message') return upsertRequest(ctx, 'message', input.message, input.urgent)
  return { ok: false, error: 'unknown_tool' }
}

// ---------- reply checks ----------

// $ amounts the reply states that the records don't contain.
export function inventedPrices(text, facts) {
  const known = new Set((String(facts).match(/\$\s?\d[\d,]*(\.\d{2})?/g) || []).map((x) => x.replace(/[\s,]/g, '').replace(/\.00$/, '')))
  return (String(text).match(/\$\s?\d[\d,]*(\.\d{2})?/g) || []).map((x) => x.replace(/[\s,]/g, '').replace(/\.00$/, '')).filter((x) => !known.has(x))
}
// A price said in words ("two hundred dollars") can't be checked against the records, so it is never let through.
export const wordPrice = (text) => /\b(dollars?|bucks)\b/i.test(text) && !/\$\s?\d/.test(text)
// Model narration that must never reach a customer.
const NARRATION = /\b(the rule|my instructions|system prompt|tool|function call|i should call|i('| wi)ll (call|use) (the )?\w+_\w+)\b/i
export function sentenceProblem(sentence, facts) {
  if (NARRATION.test(sentence)) return 'narration'
  if (inventedPrices(sentence, facts).length) return 'invented_price'
  if (wordPrice(sentence)) return 'word_price'
  return null
}

const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
function fallbackText(k, channel = 'chat') {
  // Spoken: a web address read aloud is useless, so the caller hears where to book and the phone number instead.
  if (channel === 'voice') return `Sorry, I'm having trouble on my side right now. You can book on the ${k.name} website${k.phone ? ` or call ${k.phone}` : ''}.`
  return `Sorry, I can't answer right now. You can pick a time at https://getshowups.com/book/${k.id}${k.phone ? ` or call ${k.phone}` : ''}.`
}
const safePrice = (k) => `I don't want to quote the wrong price, so the ${k.name} team will confirm it. Would you like me to find a time for a visit?`

function costMicros(u) {
  if (!u) return 0
  return Math.round((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite)
}

// Voice waits at most VOICE_MODEL_TIMEOUT_MS for the model to start answering (one retry): a caller hears silence
// meanwhile, and Retell's own reminder would talk over a slow answer. Chat keeps the longer budget.
function client(env, channel = 'chat') {
  const mock = providerMock(env)
  return new Anthropic({ apiKey: env.RECEPTIONIST_ANTHROPIC_API_KEY, maxRetries: 1, timeout: channel === 'voice' ? VOICE_MODEL_TIMEOUT_MS : MODEL_TIMEOUT_MS, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
}

// Streams one model call's text sentence by sentence through `emit`, checking each sentence first. Returns the
// final message, the text actually emitted, and the first problem found (after which nothing more is emitted).
// onToolStart(name): the model began a tool call (voice says its holding line now, not after the whole call).
// signal: aborts the request when the caller talked over this turn (Retell discards it), so the next turn starts
// at once instead of waiting for an answer nobody will hear.
async function streamCall(anthropic, params, { emit, facts, isStale, onToolStart, signal }) {
  const stream = anthropic.messages.stream(params, signal ? { signal } : undefined)
  let buf = ''
  let emitted = ''
  let problem = null
  const flush = (all) => {
    for (;;) {
      const m = buf.match(/^([\s\S]*?[.!?])(\s+|$)/)
      if (!m || (!all && !m[2] && buf.length === m[1].length)) break
      const sentence = m[1]
      buf = buf.slice(m[0].length)
      if (problem) continue
      problem = sentenceProblem(sentence, facts)
      if (!problem) {
        emitted += (emitted ? ' ' : '') + sentence.trim()
        emit(sentence.trim())
      }
    }
    if (all && buf.trim()) {
      const rest = buf.trim()
      buf = ''
      if (!problem) {
        problem = sentenceProblem(rest, facts)
        if (!problem) {
          emitted += (emitted ? ' ' : '') + rest
          emit(rest)
        }
      }
    }
  }
  stream.on('text', (delta) => {
    if (isStale?.()) return
    buf += delta
    flush(false)
  })
  if (onToolStart) {
    stream.on('streamEvent', (ev) => {
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && !isStale?.()) onToolStart(ev.content_block.name)
    })
  }
  const message = await stream.finalMessage()
  flush(true)
  return { message, emitted, problem }
}

// One customer turn → { ok, reply, status, outcome, booked?, request? }.
// opts: { channel: 'chat' | 'voice', onText(sentence) — voice: speak as it is generated, isStale() — voice: the caller
// spoke again (Retell discards this answer), so an answer that did nothing is dropped instead of saved }.
export async function respond(env, customer, conv, userText, opts = {}, now = Date.now()) {
  const channel = opts.channel === 'voice' ? 'voice' : 'chat'
  const db = env.ONBOARDING_DB
  const text = String(userText || '').trim().slice(0, LIMITS.textChars)
  if (!text) return { ok: false, error: 'empty_message' }
  if (conv.state.endedAt) return { ok: false, error: 'conversation_ended' }
  const settings = await getSettings(db, customer.id)
  const k0 = await knowledgeFor(env, customer, settings)
  // The owner's PUBLISHED AI rules (Teach Your AI), only for businesses released in AI_RULES_LIVE_BUSINESSES. Without
  // them everything below is exactly the pre-rules behaviour. A rules failure never stops the conversation.
  const rules = await activeRules(env, customer, now).catch((err) => {
    console.error('receptionist: rules unavailable:', err?.name)
    return null
  })
  // "Never quote prices": the model doesn't see them, and any $ amount is then caught by the price check.
  const k = rules?.config.pricing === 'no_prices' ? { ...k0, services: k0.services.map((s) => ({ ...s, price: '' })), knowledge: String(k0.knowledge || '').replace(/\$\s?\d[\d,]*(\.\d{2})?/g, '') } : k0
  const facts = factText(k)
  const log = (who, t) => {
    conv.state.log = [...(conv.state.log || []), { who, text: t, channel, at: now }].slice(-LIMITS.log)
  }
  if (conv.turns >= LIMITS.turnsPerConversation || conv.cost_micros >= LIMITS.conversationMicros || (await spentToday(db, customer.id, now)) >= dailyCap(env)) {
    await event(env, conv, 'limit', false, conv.turns >= LIMITS.turnsPerConversation ? 'turns' : 'cost', now)
    const reply = fallbackText(k, channel)
    opts.onText?.(reply)
    return { ok: true, reply, status: conv.status, limited: true }
  }

  const ctx = { env, customer, conv, now, userText: text, knowledge: k, channel, after: [], committed: false, rules }
  const transcript = conv.transcript
  transcript.push({ role: 'user', content: text })
  // Operator notes for this turn: what is already known (so it is never asked again) and any correction from the
  // previous turn (e.g. a blocked price). Mid-conversation system messages keep the cached history intact.
  const notes = [knownLine(conv.state, customer), conv.state.note].filter(Boolean)
  delete conv.state.note
  if (rules) {
    // Deterministic: what this message says (town, ZIP, address, need, urgency, equipment, day…) + the owner's
    // workflow → one note: known facts, the ONE thing to ask next, what isn't allowed yet. No extra model or tool call.
    const flags = observe(rules, conv, text)
    notes.push(turnNote(decisionFor(rules, conv), rules.version))
    await event(env, conv, 'rules', true, [`v${rules.version}`, ...flags].join(';'), now)
  }
  if (notes.length) transcript.push({ role: 'system', content: notes.join('\n') })
  const prompt = systemPrompt(k, channel, { requests: await receptionistRequestsReady(db) })
  const system = [{ type: 'text', text: rules ? `${prompt}\n\n${rulesInstructions(rules.config, rules.records)}` : prompt, cache_control: { type: 'ephemeral' } }]
  const tools = rules ? [...TOOLS, NOTE_ANSWER_TOOL] : TOOLS
  let spent = 0
  let reply = ''
  let failed = null
  let blocked = null
  let held = null // voice holding line spoken while a slow tool ran (not an answer: no_reply still applies without one)
  const anthropic = client(env, channel)
  const params = () => ({ model: modelId(env, channel), max_tokens: 4096, output_config: { effort: 'low' }, system, tools, messages: transcript })
  // Per-turn timings (numbers only; voice records them as a voice_turn event). opts.timing is filled in place so the
  // caller has them on every return path, including a dropped (talked-over) turn.
  const timing = opts.timing || {}
  Object.assign(timing, { modelMs: 0, toolMs: 0, modelCalls: 0, firstTextMs: null })
  const t0 = Date.now()
  const holdLine = (names) => (names.includes('find_available_times') ? 'One moment while I check the calendar.' : names.includes('book_appointment') ? 'One moment, please.' : null)
  let saidAny = false
  const speak = opts.onText
    ? (s) => {
        if (timing.firstTextMs === null) timing.firstTextMs = Date.now() - t0
        saidAny = true
        opts.onText(s)
      }
    : null
  // Voice: the holding line goes out the moment the model starts a slow tool call (calendar lookup / booking), not
  // after the whole model call finished, as long as nothing else has been said this turn.
  const onToolStart = (name) => {
    if (held || saidAny || opts.isStale?.()) return
    const line = holdLine([name])
    if (line) {
      speak(line)
      held = line
    }
  }
  for (let i = 0; i < LIMITS.modelCallsPerTurn; i++) {
    let res
    let emitted = ''
    // The caller talked over this turn and it hasn't acted: stop before another model call.
    if (opts.isStale?.() && !ctx.committed) {
      await event(env, conv, 'turn', false, 'talked_over', now)
      return { ok: false, error: 'stale' }
    }
    // Aborting is only allowed while the turn has done nothing; after a booking/request the answer is still produced.
    const signal = opts.signal && !ctx.committed ? opts.signal : undefined
    const tm = Date.now()
    try {
      if (speak) {
        const s = await streamCall(anthropic, params(), { emit: speak, facts, isStale: opts.isStale, onToolStart, signal })
        res = s.message
        emitted = s.emitted
        if (s.problem) blocked = blocked || s.problem
      } else res = await anthropic.messages.create(params())
    } catch (err) {
      timing.modelMs += Date.now() - tm
      timing.modelCalls++
      if ((err instanceof Anthropic.APIUserAbortError || signal?.aborted) && !ctx.committed) {
        await event(env, conv, 'turn', false, 'talked_over', now)
        return { ok: false, error: 'stale' }
      }
      failed = err instanceof Anthropic.RateLimitError ? 'model_rate_limited' : err instanceof Anthropic.APIConnectionTimeoutError ? 'model_timeout' : err instanceof Anthropic.APIConnectionError ? 'model_unreachable' : err instanceof Anthropic.APIError ? `model_http_${err.status || 'error'}` : 'model_error'
      break
    }
    timing.modelMs += Date.now() - tm
    timing.modelCalls++
    spent += costMicros(res.usage)
    transcript.push({ role: 'assistant', content: res.content })
    if (opts.onText && emitted) reply = reply ? `${reply} ${emitted}` : emitted
    if (res.stop_reason === 'refusal') {
      failed = 'model_refusal'
      break
    }
    const uses = res.content.filter((b) => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      if (!opts.onText) reply = textOf(res.content)
      break
    }
    // The caller already spoke again: stop before acting, unless something was done this turn.
    if (opts.isStale?.() && !ctx.committed) {
      await event(env, conv, 'turn', false, 'talked_over', now)
      return { ok: false, error: 'stale' }
    }
    // Voice: a calendar lookup or booking is two model calls plus Google, several seconds of silence. A caller who
    // hears nothing talks again and the turn is lost (talked_over), so say a fixed holding line first (never a claim).
    // (Normally already said at the tool call's start, see onToolStart; this covers a non-streamed start.)
    if (speak && !reply && !held && !saidAny) {
      const line = holdLine(uses.map((u) => u.name))
      if (line) {
        speak(line)
        held = line
      }
    }
    const results = []
    for (const u of uses) {
      let out
      const tt = Date.now()
      try {
        out = await runTool(ctx, u.name, u.input || {})
      } catch (err) {
        console.error('receptionist: tool failed:', u.name, err?.name)
        out = { ok: false, error: 'tool_failed', note: "Something went wrong on our side: say so honestly and offer a callback request or the booking page." }
      }
      timing.toolMs += Date.now() - tt
      const detail = out.ok ? (out.booked ? 'booked' : out.already_booked ? 'already_booked' : out.recorded ? out.kind : out.recheck ? 'recheck' : null) : out.error
      await event(env, conv, u.name, out.ok, detail, now)
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out.ok ? {} : { is_error: true }) })
    }
    transcript.push({ role: 'user', content: results })
  }
  // Voice: the caller spoke again before this turn answered. Retell discards the answer, so this is not a model
  // failure (never 'no_reply', no fallback generated); record it as talked over so slow answers are diagnosable.
  if (opts.isStale?.() && !ctx.committed && !failed) {
    await event(env, conv, 'turn', false, 'talked_over', now)
    return { ok: false, error: 'stale' }
  }
  if (!reply && !failed) failed = 'no_reply'
  if (failed) {
    await event(env, conv, 'model', false, failed, now)
    reply = fallbackText(k, channel)
    speak?.(reply)
    if (!conv.outcome) conv.outcome = 'error'
  }
  // Chat: check the whole reply before showing it. Voice was checked sentence by sentence while it streamed.
  if (!opts.onText) {
    const sentences = reply.match(/[^.!?]+[.!?]*/g) || []
    const bad = sentences.map((x) => sentenceProblem(x, facts)).find(Boolean)
    if (bad) {
      blocked = bad
      reply = bad === 'narration' ? sentences.filter((x) => !sentenceProblem(x, facts)).join('').trim() || 'Could you tell me a bit more about what you need?' : safePrice(k)
    }
  } else if (blocked && blocked !== 'narration') {
    const fix = safePrice(k)
    speak(fix)
    reply = `${reply} ${fix}`.trim()
  }
  if (blocked) {
    await event(env, conv, blocked === 'narration' ? 'blocked_narration' : 'blocked_price', false, blocked, now)
    if (blocked !== 'narration') conv.state.note = `Your previous reply stated a price that isn't in the verified facts (or said a price in words), so the customer was told instead: "${safePrice(k)}". Only state prices exactly as listed, in digits with $.`
  }
  if (opts.isStale?.() && !ctx.committed) return { ok: false, error: 'stale' }
  if (!conv.outcome && !failed) conv.outcome = 'info'
  if (held) reply = `${held} ${reply}`.trim()
  log('customer', text)
  log('receptionist', reply)
  conv.summary = summaryOf(conv, k)
  const next = conv.turns + 1
  const saved = await db
    .prepare(
      `UPDATE receptionist_conversations SET transcript = ?3, state = ?4, status = ?5, outcome = ?6, lead_id = ?7, appointment_id = ?8, summary = ?9, turns = ?10, cost_micros = cost_micros + ?11, updated_at = ?12
       WHERE id = ?1 AND customer = ?2 AND turns = ?13`,
    )
    .bind(conv.id, customer.id, JSON.stringify(transcript), JSON.stringify(conv.state), conv.status, conv.outcome, conv.lead_id || null, conv.appointment_id || null, conv.summary, next, spent, now, conv.turns)
    .run()
  if (!(saved?.meta?.changes > 0)) {
    // Another turn of this conversation finished first (e.g. typing during a call); its record wins, ours is dropped
    // unless this turn acted — then its result is recorded regardless.
    await event(env, conv, 'concurrent_turn', false, null, now)
    if (!ctx.committed) return { ok: false, error: 'busy' }
    await db
      .prepare('UPDATE receptionist_conversations SET status = ?3, outcome = ?4, lead_id = ?5, appointment_id = ?6, updated_at = ?7 WHERE id = ?1 AND customer = ?2')
      .bind(conv.id, customer.id, conv.status, conv.outcome, conv.lead_id || null, conv.appointment_id || null, now)
      .run()
  }
  conv.turns = next
  conv.cost_micros += spent
  for (const fn of ctx.after) await fn().catch(() => {})
  // A booking: confirmation + owner notice now (opts.defer = the request's waitUntil; the cron is the fallback).
  if (ctx.bookedNow && typeof opts.defer === 'function') opts.defer(dispatchBooked(env, ctx.bookedNow, now))
  return { ok: true, reply, ...publicState(conv, customer), costMicros: spent }
}

// What the customer page may know about its own conversation.
export function publicState(conv, customer) {
  const s = conv.state
  return {
    status: conv.status,
    outcome: conv.outcome,
    ended: Boolean(s.endedAt),
    // Only after bookAppointment persisted it (s.booked is set from its result). The customer's own details, returned
    // only with their conversation token.
    booked: s.booked
      ? {
          time: slotLabel(s.booked.start, customer.timezone),
          service: s.customer?.need || null,
          address: customer.appointmentMode === 'at_customer' && s.customer?.street ? `${s.customer.street}, ${s.customer.city}, ${String(s.customer.state || '').toUpperCase()} ${s.customer.zip || ''}`.trim() : null,
        }
      : null,
    request: s.requests?.callback ? 'callback' : s.requests?.message ? 'message' : null,
  }
}

// Owner-facing summary from recorded facts only.
function summaryOf(conv, k) {
  const s = conv.state
  const parts = []
  if (s.booked) parts.push(`Booked ${slotLabel(s.booked.start, k.timezone)}`)
  if (s.requests?.callback) parts.push('Callback requested')
  if (s.requests?.message) parts.push('Left a message')
  if (s.customer?.zip) parts.push(`ZIP ${s.customer.zip}${s.inArea === false ? ' (outside area)' : ''}`)
  if (!parts.length) parts.push('Questions answered')
  return parts.join(' · ').slice(0, 200)
}

// What the customer saw or heard (state.log), for the customer page and the owner. Older conversations without a log
// fall back to the final text of each model answer (never text that came with a tool call).
export function visibleTranscript(transcript, state = {}) {
  if (Array.isArray(state.log) && state.log.length) return state.log.map((l) => ({ who: l.who, text: l.text, channel: l.channel, at: l.at ?? null }))
  const lines = []
  for (const m of transcript) {
    if (m.role === 'user' && typeof m.content === 'string') lines.push({ who: 'customer', text: m.content })
    else if (m.role === 'assistant' && !(m.content || []).some((b) => b.type === 'tool_use')) {
      const t = textOf(m.content)
      if (t) lines.push({ who: 'receptionist', text: t })
    }
  }
  return lines
}

export const RETENTION_MS = 365 * 86_400_000
export async function purgeOldConversations(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await receptionistReady(db))) return 0
  const cutoff = now - RETENTION_MS
  const withRequests = await receptionistRequestsReady(db)
  const { results } = await db.prepare('SELECT id FROM receptionist_conversations WHERE updated_at < ?1 LIMIT 200').bind(cutoff).all()
  for (const r of results) {
    await db.batch([
      db.prepare('DELETE FROM receptionist_events WHERE conversation_id = ?1').bind(r.id),
      db.prepare('DELETE FROM receptionist_calls WHERE conversation_id = ?1').bind(r.id),
      ...(withRequests ? [db.prepare('DELETE FROM receptionist_requests WHERE conversation_id = ?1').bind(r.id)] : []),
      db.prepare('DELETE FROM receptionist_conversations WHERE id = ?1').bind(r.id),
    ])
  }
  return results.length
}
