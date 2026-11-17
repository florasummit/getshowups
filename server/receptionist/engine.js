// AI receptionist engine: ONE shared, multi-tenant conversation engine for website chat and voice.
//
// - Model: Claude (Anthropic API, GetShowUps-paid key RECEPTIONIST_ANTHROPIC_API_KEY — its own secret so receptionist
//   spend is separate and setting it switches nothing else on; RECEPTIONIST_MODEL overrides the model id).
//   Real inference only; when the model is unavailable the customer gets a fixed message with the booking link and
//   phone, never a scripted pretend-conversation.
// - Knowledge: the business's verified records only (knowledge.js). The system prompt is per business and cached;
//   customer text is never placed in it.
// - Tools run on the SERVER, bound to the conversation's business (the model never names a business): service area,
//   real Google Calendar availability (openSlots), booking through the existing bookAppointment (double-booking guard,
//   Google event, confirmations/reminders), and hand-off to a person. Every action, refusal and failure is recorded.
// - Guards the model can't talk its way past: only times this conversation was shown can be booked; booking needs the
//   customer's own confirming words in their latest message; one booking per conversation; a $ amount not in the
//   records is never shown to the customer; per-conversation and per-business daily cost caps; turn limits.
// - Conversation history is kept exactly as the model produced it (append-only), so later turns replay it unchanged.
import Anthropic from '@anthropic-ai/sdk'
import { randomToken } from '../google-oauth.js'
import { linkToken, verifyLinkToken } from '../links.js'
import { createLead, bookAppointment, openSlots, validateLead } from '../booking.js'
import { providerMock } from '../ai-credentials.js'
import { syncLead, syncStage, syncNote } from '../ghl.js'
import { knowledgeFor, systemPrompt, factText } from './knowledge.js'

export const RECEPTIONIST_TABLES = ['receptionist_settings', 'receptionist_conversations', 'receptionist_events', 'receptionist_calls']
export const DEFAULT_MODEL = 'claude-opus-5-5'
// $ per million tokens (Claude Opus 5.5): input 4, output 20, cache read 0.20, cache write 5 (1.25×).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
export const LIMITS = {
  turnsPerConversation: 60,
  conversationMicros: 1_000_000, // $1.00 per conversation
  businessDailyMicros: 5_000_000, // $5.00 per business per UTC day (RECEPTIONIST_DAILY_MICROS overrides)
  modelCallsPerTurn: 5,
  textChars: 1500,
  offeredSlots: 6,
}
const MODEL_TIMEOUT_MS = 25_000

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
export const modelConfigured = (env) => Boolean(env.RECEPTIONIST_ANTHROPIC_API_KEY) && env.RECEPTIONIST_ENABLED !== 'false'
const modelId = (env) => (/^claude-[a-z0-9-]{3,60}$/.test(env.RECEPTIONIST_MODEL || '') ? env.RECEPTIONIST_MODEL : DEFAULT_MODEL)
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
export async function startConversation(env, customer, channel, now = Date.now()) {
  const id = randomToken(12)
  await env.ONBOARDING_DB.prepare("INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES (?1, ?2, ?3, '{}', '[]', ?4, ?4)")
    .bind(id, customer.id, channel, now)
    .run()
  return { id, token: await conversationToken(env, id) }
}
// The conversation for (business, id, token) — never another business's.
export async function loadConversation(env, customer, id, token) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) return null
  if (token !== undefined && !(await verifyLinkToken(env, 'receptionist', id, String(token || '')))) return null
  const r = await env.ONBOARDING_DB.prepare('SELECT * FROM receptionist_conversations WHERE id = ?1 AND customer = ?2').bind(id, customer.id).first()
  if (!r) return null
  return { ...r, state: JSON.parse(r.state || '{}'), transcript: JSON.parse(r.transcript || '[]') }
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

// ---------- tools (server-side, bound to the conversation's business) ----------

export const TOOLS = [
  {
    name: 'check_service_area',
    description: "Check whether the business serves a US ZIP code. Use it as soon as the customer gives their ZIP, before offering to book.",
    input_schema: { type: 'object', properties: { zip: { type: 'string', description: '5-digit ZIP code' } }, required: ['zip'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'find_available_times',
    description: "Look up real open appointment times on the business's calendar (next 14 days). Returns up to 6 options with slot ids. Only these times may be offered or booked.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "Preferred day as YYYY-MM-DD in the business's time zone, or empty for the soonest days" },
        part_of_day: { type: 'string', enum: ['any', 'morning', 'afternoon', 'evening'] },
      },
      required: ['date', 'part_of_day'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'book_appointment',
    description:
      'Book one of the times returned by find_available_times. Call ONLY after reading back the time and details and the customer clearly confirmed in their latest message. confirmation_quote must be their exact confirming words from that message.',
    input_schema: {
      type: 'object',
      properties: {
        slot_id: { type: 'string' },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        zip: { type: 'string' },
        service_needed: { type: 'string', description: 'Short description of what they need' },
        street: { type: 'string', description: 'Service address street (empty if the customer comes to the business)' },
        city: { type: 'string' },
        state: { type: 'string', description: 'Two-letter state' },
        confirmation_quote: { type: 'string' },
      },
      required: ['slot_id', 'customer_name', 'phone', 'email', 'zip', 'service_needed', 'street', 'city', 'state', 'confirmation_quote'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'request_human',
    description: 'Hand the conversation to a person at the business (customer asked, complaint, emergency, or something you cannot do).',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['customer_asked', 'emergency', 'complaint', 'cannot_help', 'other'] },
        urgent: { type: 'boolean' },
        note_for_staff: { type: 'string', description: 'One or two sentences for the staff member: what the customer needs and how to reach them' },
      },
      required: ['reason', 'urgent', 'note_for_staff'],
      additionalProperties: false,
    },
    strict: true,
  },
]

const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|correct|book (it|that)|sounds (good|great)|perfect|please do|do it|go ahead|that works|works for me|let'?s do)\b/i
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const localParts = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
export const slotLabel = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms))

async function runTool(ctx, name, input) {
  const { env, customer, conv, now } = ctx
  const s = conv.state
  if (name === 'check_service_area') {
    const zip = String(input.zip || '').trim().slice(0, 5)
    if (!/^\d{5}$/.test(zip)) return { ok: false, error: 'invalid_zip' }
    const served = customer.serviceZips.length === 0 || customer.serviceZips.includes(zip)
    s.zip = zip
    s.inArea = served
    if (!served) conv.outcome = conv.outcome || 'out_of_area'
    return { ok: true, zip, served }
  }
  if (name === 'find_available_times') {
    const r = await openSlots(env, customer, now)
    if (!r.ok) return { ok: false, error: 'calendar_unavailable' }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : ''
    const part = input.part_of_day || 'any'
    const inPart = (h) => part === 'any' || (part === 'morning' ? h < 12 : part === 'afternoon' ? h >= 12 && h < 17 : h >= 17)
    let picks = r.slots.filter((x) => {
      const p = localParts(x.start, customer.timezone)
      return (!date || `${p.year}-${p.month}-${p.day}` === date) && inPart(Number(p.hour))
    })
    // Spread the options across the matching days instead of six back-to-back times.
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
    return { ok: true, timezone: customer.timezone, options, note: options.length ? undefined : 'No open times match; offer other days.' }
  }
  if (name === 'book_appointment') {
    if (s.booked) return { ok: true, already_booked: true, time: slotLabel(s.booked.start, customer.timezone), note: 'This conversation already has a booking; do not book again.' }
    const start = s.offered?.[input.slot_id]
    if (!Number.isInteger(start)) return { ok: false, error: 'slot_not_offered', note: 'Only times from find_available_times in this conversation can be booked.' }
    const quote = norm(input.confirmation_quote)
    if (!quote || !norm(ctx.userText).includes(quote) || !AFFIRM.test(input.confirmation_quote)) {
      return { ok: false, error: 'confirmation_required', note: "The customer's latest message must clearly confirm this exact time. Read it back and ask them to confirm." }
    }
    const zip = String(input.zip || '').trim().slice(0, 5)
    if (customer.serviceZips.length && !customer.serviceZips.includes(zip)) return { ok: false, error: 'out_of_area' }
    // Details must come from the customer, not the model: ZIP and phone must appear in what they said (and, in chat,
    // the email). An out-of-area ZIP they gave can't be swapped for an in-area one.
    const said = conv.transcript.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join(' \n ')
    const phoneDigits = String(input.phone || '').replace(/\D/g, '').slice(-10)
    if (!new RegExp(`\\b${zip}\\b`).test(said) || (s.zip && s.inArea === false && zip !== s.zip)) return { ok: false, error: 'zip_not_from_customer', note: 'Use the ZIP code the customer gave; if it is outside the area, do not book.' }
    if (phoneDigits.length < 10 || !said.replace(/\D/g, '').includes(phoneDigits)) return { ok: false, error: 'phone_not_from_customer', note: 'Ask the customer for their phone number.' }
    if (conv.channel === 'chat' && !said.toLowerCase().includes(String(input.email || '').trim().toLowerCase())) return { ok: false, error: 'email_not_from_customer', note: 'Ask the customer for their email address.' }
    const body = { name: input.customer_name, email: input.email, phone: input.phone, need: input.service_needed, zip }
    if (customer.appointmentMode === 'at_customer') body.address = { street: input.street, unit: '', city: input.city, state: input.state, zip }
    const [error, lead] = validateLead(body, customer.appointmentMode)
    if (error) return { ok: false, error, note: 'Ask the customer to correct this detail.' }
    let leadId = s.leadId
    if (!leadId) {
      const created = await createLead(env, customer, { ...lead, source: conv.channel === 'voice' ? 'call' : 'chat' }, now)
      if (!created.qualified) return { ok: false, error: 'out_of_area' }
      leadId = s.leadId = created.id
      conv.lead_id = leadId
      ctx.after.push(() => syncLead(env, customer.id, leadId, now))
    }
    const r = await bookAppointment(env, customer, { leadId, leadToken: await linkToken(env, 'lead', leadId), start }, now)
    if (!r.ok) {
      if (r.error === 'slot_unavailable') delete s.offered[input.slot_id]
      return { ok: false, error: r.error, note: r.error === 'slot_unavailable' ? 'That time was just taken; look up times again.' : 'Booking failed; offer to try again or hand off.' }
    }
    s.booked = { appointmentId: r.appointment.id, start }
    conv.appointment_id = r.appointment.id
    conv.status = 'booked'
    conv.outcome = 'booked'
    ctx.after.push(() => syncStage(env, customer.id, leadId, 'booked', null, now))
    ctx.after.push(() => syncNote(env, customer.id, leadId, `booked:${conv.id}`, `Booked by the GetShowUps receptionist (${conv.channel}) for ${slotLabel(start, customer.timezone)}. Need: ${lead.need}`, now))
    return { ok: true, booked: true, time: slotLabel(start, customer.timezone), confirmation_email: lead.email }
  }
  if (name === 'request_human') {
    const reason = ['customer_asked', 'emergency', 'complaint', 'cannot_help', 'other'].includes(input.reason) ? input.reason : 'other'
    s.handoff = { reason, urgent: Boolean(input.urgent), note: String(input.note_for_staff || '').slice(0, 400), at: now }
    if (conv.status !== 'booked') conv.status = 'handoff'
    conv.outcome = input.urgent ? 'handoff_urgent' : conv.outcome === 'booked' ? 'booked' : 'handoff'
    if (s.leadId) ctx.after.push(() => syncNote(env, customer.id, s.leadId, `handoff:${conv.id}`, `GetShowUps receptionist hand-off (${reason}${input.urgent ? ', URGENT' : ''}): ${s.handoff.note}`, now))
    const phone = ctx.knowledge.phone
    return { ok: true, handed_off: true, tell_customer: phone ? `A team member will follow up. For anything urgent they can call ${phone}.` : 'A team member will follow up as soon as possible.' }
  }
  return { ok: false, error: 'unknown_tool' }
}

// ---------- reply checks ----------

// $ amounts the reply states that the records don't contain.
export function inventedPrices(text, facts) {
  const known = new Set((String(facts).match(/\$\s?\d[\d,]*(\.\d{2})?/g) || []).map((x) => x.replace(/[\s,]/g, '').replace(/\.00$/, '')))
  return (String(text).match(/\$\s?\d[\d,]*(\.\d{2})?/g) || []).map((x) => x.replace(/[\s,]/g, '').replace(/\.00$/, '')).filter((x) => !known.has(x))
}

const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
function fallbackText(k) {
  return `Sorry, I can't answer right now. You can pick a time at https://getshowups.com/book/${k.id}${k.phone ? ` or call ${k.phone}` : ''}.`
}

function costMicros(u) {
  if (!u) return 0
  return Math.round((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite)
}

function client(env) {
  const mock = providerMock(env)
  return new Anthropic({ apiKey: env.RECEPTIONIST_ANTHROPIC_API_KEY, maxRetries: 1, timeout: MODEL_TIMEOUT_MS, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
}

// One customer turn → { ok, reply, status, outcome, booked?, handoff? }. channel: 'chat' | 'voice'.
export async function respond(env, customer, conv, userText, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const text = String(userText || '').trim().slice(0, LIMITS.textChars)
  const settings = await getSettings(db, customer.id)
  const k = await knowledgeFor(env, customer, settings)
  if (!text) return { ok: false, error: 'empty_message' }
  if (conv.turns >= LIMITS.turnsPerConversation) {
    await event(env, conv, 'limit', false, 'turns', now)
    return { ok: true, reply: `We've covered a lot. To keep going, pick a time at https://getshowups.com/book/${customer.id}${k.phone ? ` or call ${k.phone}` : ''}.`, status: conv.status, limited: true }
  }
  if (conv.cost_micros >= LIMITS.conversationMicros || (await spentToday(db, customer.id, now)) >= dailyCap(env)) {
    await event(env, conv, 'limit', false, 'cost', now)
    return { ok: true, reply: fallbackText(k), status: conv.status, limited: true }
  }

  const ctx = { env, customer, conv, now, userText: text, knowledge: k, after: [] }
  const transcript = conv.transcript
  transcript.push({ role: 'user', content: text })
  // A correction from the previous turn (e.g. a blocked price) reaches the model as an operator note, not as history edits.
  if (conv.state.note) {
    transcript.push({ role: 'system', content: conv.state.note })
    delete conv.state.note
  }
  const system = [{ type: 'text', text: systemPrompt(k, conv.channel), cache_control: { type: 'ephemeral' } }]
  let spent = 0
  let reply = ''
  let failed = null
  const anthropic = client(env)
  for (let i = 0; i < LIMITS.modelCallsPerTurn; i++) {
    let res
    try {
      res = await anthropic.messages.create({ model: modelId(env), max_tokens: 4096, output_config: { effort: 'low' }, system, tools: TOOLS, messages: transcript })
    } catch (err) {
      failed = err instanceof Anthropic.RateLimitError ? 'model_rate_limited' : err instanceof Anthropic.APIConnectionError ? 'model_unreachable' : err instanceof Anthropic.APIError ? `model_http_${err.status || 'error'}` : 'model_error'
      break
    }
    spent += costMicros(res.usage)
    transcript.push({ role: 'assistant', content: res.content })
    if (res.stop_reason === 'refusal') {
      failed = 'model_refusal'
      break
    }
    const uses = res.content.filter((b) => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      reply = textOf(res.content)
      break
    }
    const results = []
    for (const u of uses) {
      let out
      try {
        out = await runTool(ctx, u.name, u.input || {})
      } catch (err) {
        console.error('receptionist: tool failed:', u.name, err?.name)
        out = { ok: false, error: 'tool_failed' }
      }
      await event(env, conv, u.name, out.ok, out.ok ? (out.booked ? 'booked' : out.already_booked ? 'already_booked' : out.handed_off ? (ctx.conv.state.handoff?.reason || 'handoff') : null) : out.error, now)
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out.ok ? {} : { is_error: true }) })
    }
    transcript.push({ role: 'user', content: results })
  }
  if (!reply && !failed) failed = 'no_reply'
  if (failed) {
    await event(env, conv, 'model', false, failed, now)
    reply = fallbackText(k)
    if (!conv.outcome) conv.outcome = 'error'
  }
  // Never show a price the records don't contain; the model is told next turn what the customer saw instead.
  const invented = inventedPrices(reply, factText(k))
  if (invented.length) {
    await event(env, conv, 'blocked_price', false, invented.slice(0, 3).join(','), now)
    reply = `I don't want to quote the wrong price, so ${k.name}'s team will confirm it. Would you like me to find a time for a visit, or have someone call you?`
    conv.state.note = `Your previous reply stated a price that is not in the verified facts (${invented.slice(0, 3).join(', ')}), so the customer was shown this instead: "${reply}". Never state prices that are not listed.`
  }
  if (!conv.outcome && !failed) conv.outcome = 'info'
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
    // Another turn of this conversation finished first (e.g. a voice interruption); its record wins, ours is dropped.
    await event(env, conv, 'concurrent_turn', false, null, now)
    if (!conv.state.booked) return { ok: false, error: 'busy' }
    // A booking made in the dropped turn is real: record it on the conversation regardless.
    await db
      .prepare("UPDATE receptionist_conversations SET status = 'booked', outcome = 'booked', lead_id = ?3, appointment_id = ?4, updated_at = ?5 WHERE id = ?1 AND customer = ?2")
      .bind(conv.id, customer.id, conv.lead_id || null, conv.appointment_id || null, now)
      .run()
  }
  conv.turns = next
  conv.cost_micros += spent
  for (const fn of ctx.after) await fn().catch(() => {})
  return { ok: true, reply, status: conv.status, outcome: conv.outcome, booked: conv.state.booked ? { time: slotLabel(conv.state.booked.start, customer.timezone) } : null, handoff: Boolean(conv.state.handoff), costMicros: spent }
}

// Owner-facing summary from recorded facts only (no model text except the hand-off note, labelled as such).
function summaryOf(conv, k) {
  const s = conv.state
  const parts = []
  if (s.booked) parts.push(`Booked ${slotLabel(s.booked.start, k.timezone)}`)
  if (s.zip) parts.push(`ZIP ${s.zip}${s.inArea === false ? ' (outside area)' : ''}`)
  if (s.handoff) parts.push(`Hand-off: ${s.handoff.reason}${s.handoff.urgent ? ' (urgent)' : ''}`)
  if (!parts.length) parts.push('Questions answered')
  return parts.join(' · ').slice(0, 200)
}

// What the owner sees for one conversation: the spoken/typed lines (no model internals), actions and outcome.
export function visibleTranscript(transcript) {
  const lines = []
  for (const m of transcript) {
    if (m.role === 'user' && typeof m.content === 'string') lines.push({ who: 'customer', text: m.content })
    else if (m.role === 'assistant') {
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
  const { results } = await db.prepare('SELECT id FROM receptionist_conversations WHERE updated_at < ?1 LIMIT 200').bind(cutoff).all()
  for (const r of results) {
    await db.batch([
      db.prepare('DELETE FROM receptionist_events WHERE conversation_id = ?1').bind(r.id),
      db.prepare('DELETE FROM receptionist_calls WHERE conversation_id = ?1').bind(r.id),
      db.prepare('DELETE FROM receptionist_conversations WHERE id = ?1').bind(r.id),
    ])
  }
  return results.length
}
