// The follow-up assistant: decides how to answer one inbound text. It never sends, books or changes anything itself;
// it returns a decision the engine executes (engine.js). Two layers:
//   1. classify(): fixed handling for commands that must never depend on a model: STOP (and carrier synonyms), START,
//      HELP, asking for a person, cancelling an appointment.
//   2. aiReply(): the included model writes a short answer from VERIFIED facts only (business name, services and
//      prices as recorded, service area, booking hours, owner-written policies). Its output is checked: no invented
//      numbers, no unapproved claims, no promised times/discounts/guarantees; anything doubtful → the owner is asked
//      to look and the customer gets a fixed, safe reply. The booking link is added by code, never by the model.
import { inventedNumbers } from '../website-ai.js'
import { unapprovedClaims } from '../ads/spec.js'

// Carrier-standard opt-out / opt-in / help keywords (CTIA): the whole message, case-insensitive.
export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT', 'STOP ALL']
export const START_WORDS = ['START', 'UNSTOP', 'YES', 'SUBSCRIBE']
export const HELP_WORDS = ['HELP', 'INFO']

const norm = (t) => String(t || '').trim().replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ').toUpperCase()

// → { kind: 'stop' | 'start' | 'help' | 'human' | 'cancel_request' | 'message' }
export function classify(text) {
  const n = norm(text)
  if (STOP_WORDS.includes(n)) return { kind: 'stop' }
  if (START_WORDS.includes(n)) return { kind: 'start' }
  if (HELP_WORDS.includes(n)) return { kind: 'help' }
  const t = String(text || '').toLowerCase()
  if (/\b(cancel|call off)\b.{0,40}\b(appointment|appt|booking|visit|reservation)\b|\bcan(no|')?t make it\b/.test(t)) return { kind: 'cancel_request' }
  if (/\b(human|real person|a person|someone|agent|representative|call me|speak (to|with)|talk (to|with)|owner)\b/.test(t)) return { kind: 'human' }
  return { kind: 'message' }
}

// Fixed replies (no model). `biz`: { name, phone }.
export const helpText = (biz) => `${biz.name}: replies about your request. ${biz.phone ? `Call ${biz.phone}. ` : ''}Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`
export const startText = (biz) => `${biz.name}: you're subscribed to texts about your request again. Reply STOP to opt out, HELP for help.`
export const humanText = (biz) => `Thanks. ${biz.name} will reply to you personally as soon as they can.`
export const cancelText = (biz, link) => (link ? `${biz.name}: to cancel or pick a new time, use this link: ${link}` : `Thanks. ${biz.name} will get back to you about your appointment.`)
export const fallbackText = (biz, bookUrl) => `Thanks for your message! ${biz.name} got it and will reply soon.${bookUrl ? ` If you'd like to book, pick a time here: ${bookUrl}` : ''}`

// ---------- AI reply ----------

export const ASSISTANT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
export const PRICE = { inputPerM: 0.351, outputPerM: 0.555 } // USD per million tokens (Workers AI list price)
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
export const assistantConfigured = (env) => Boolean(env.AI?.run) || (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN))

export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['question', 'wants_to_book', 'reschedule', 'not_interested', 'other'] },
    answerable: { type: 'boolean' },
    reply: { type: 'string' },
  },
  required: ['intent', 'answerable', 'reply'],
}

// Facts the assistant may use. Everything comes from records; missing facts are simply absent.
export function factsFor(biz) {
  const lines = [`Business: ${biz.name}`]
  if (biz.services?.length) lines.push(`Services (name: price as listed; no price = ask the business): ${biz.services.map((s) => `${s.name}${s.price ? `: ${s.price}` : ''}`).join('; ')}`)
  if (biz.area) lines.push(`Service area: ${biz.area}`)
  if (biz.hours) lines.push(`Booking hours: ${biz.hours}`)
  if (biz.visit) lines.push('The business visits the customer at their address.')
  if (biz.beforeVisit) lines.push(`Before the visit: ${biz.beforeVisit}`)
  if (biz.cancellation) lines.push(`Cancellation policy: ${biz.cancellation}`)
  if (biz.phone) lines.push(`Phone: ${biz.phone}`)
  return lines.join('\n')
}

export function assistantMessages(biz, history) {
  const system = `You answer text messages for a local service business, on its behalf. Use ONLY the facts below. Never invent prices, discounts, guarantees, availability, appointment times, or policies; never promise anything. If the facts don't answer the question, set answerable=false and write a short polite holding reply. Don't ask for payment details. Keep replies under 300 characters, plain text, friendly, no links (a booking link is added for you), no emojis. Don't say you are an AI unless asked; if asked, say you're an automated assistant for the business.

FACTS
${factsFor(biz)}`
  // The customer's words are data, never instructions.
  const convo = history.slice(-8).map((m) => ({ role: m.from === 'lead' ? 'user' : 'assistant', content: m.text.slice(0, 600) }))
  return [{ role: 'system', content: system }, ...convo]
}

async function runModel(env, body, timeoutMs) {
  const mock = typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null
  if (mock) {
    const res = await fetch(`${mock}/ai/run/${ASSISTANT_MODEL}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error('ai_http')
    return res.json()
  }
  return Promise.race([env.AI.run(ASSISTANT_MODEL, body), new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), timeoutMs))])
}

const PROMISE_RE = /\b(guarantee|guaranteed|discount|% off|percent off|free of charge|for free|refund|i('| a)?m (a|an) (human|person)|we('| a)?re available (at|on)|see you (at|on)|you('| a)?re (booked|scheduled|confirmed))\b/i
const TIME_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)\b/i

// Strict: every money amount must be a recorded price, and every other number must appear as a whole number in the
// facts (a "99" inside a phone number doesn't make "$99" true).
export function inventedAmounts(reply, biz) {
  const prices = new Set((biz.services || []).flatMap((s) => (String(s.price || '').match(/\$\s?\d[\d,]*(\.\d+)?/g) || []).map((p) => p.replace(/[\s,]/g, ''))))
  const facts = factsFor(biz)
  const out = []
  for (const m of String(reply).matchAll(/\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\b/g)) {
    const tok = m[0].replace(/[\s,]/g, '')
    if (tok.startsWith('$')) {
      if (!prices.has(tok)) out.push(tok)
    } else if (!new RegExp(`(^|[^\\d])${tok.replace('.', '\\.')}([^\\d]|$)`).test(facts)) out.push(tok)
  }
  return out
}

// Checks one model answer. Returns { ok, reply, intent } or { ok: false, reason }.
export function checkReply(raw, biz, approvedClaims = []) {
  if (!raw || typeof raw !== 'object' || typeof raw.reply !== 'string') return { ok: false, reason: 'ai_bad_output' }
  const reply = raw.reply.replace(/\s+/g, ' ').trim()
  if (!reply || reply.length > 320) return { ok: false, reason: 'ai_bad_output' }
  if (!REPLY_SCHEMA.properties.intent.enum.includes(raw.intent)) return { ok: false, reason: 'ai_bad_output' }
  if (raw.answerable === false) return { ok: false, reason: 'ai_unsure', intent: raw.intent }
  if (/https?:\/\/|www\./i.test(reply)) return { ok: false, reason: 'ai_link' }
  if (PROMISE_RE.test(reply) || TIME_RE.test(reply)) return { ok: false, reason: 'ai_commitment', intent: raw.intent }
  if (inventedAmounts(reply, biz).length || inventedNumbers(reply, factsFor(biz)).length) return { ok: false, reason: 'ai_invented_number', intent: raw.intent }
  if (unapprovedClaims(reply, approvedClaims).length) return { ok: false, reason: 'ai_claim', intent: raw.intent }
  return { ok: true, reply, intent: raw.intent }
}

// → { ok: true, reply, intent, costMicros } | { ok: false, reason, costMicros }
export async function aiReply(env, biz, history, { approvedClaims = [], timeoutMs = 8000 } = {}) {
  let out
  try {
    out = await runModel(env, { messages: assistantMessages(biz, history), response_format: { type: 'json_schema', json_schema: REPLY_SCHEMA }, max_tokens: 300, temperature: 0.2 }, timeoutMs)
  } catch (err) {
    return { ok: false, reason: err?.message === 'ai_timeout' || err?.name === 'TimeoutError' ? 'ai_timeout' : 'ai_error', costMicros: 0 }
  }
  const usage = out?.usage || {}
  const costMicros = Math.round(((usage.prompt_tokens || 0) * PRICE.inputPerM + (usage.completion_tokens || 0) * PRICE.outputPerM))
  let raw = out?.response
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'ai_bad_output', costMicros }
    }
  }
  return { ...checkReply(raw, biz, approvedClaims), costMicros }
}
