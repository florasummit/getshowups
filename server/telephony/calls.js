// What happens on a business line (docs/TELEPHONE.md). Twilio posts each step to /api/phone/twilio/<step>; the route checks
// the signature, which also tells us WHICH business's subaccount sent it (tenant isolation: a number, call or destination is
// only ever acted on for that business). Steps:
//   voice   a call arrives → record it (CallSid = idempotency key) → plan → ring the team, or go to the fallback
//   screen  the team member's phone answered → "press 1 to take the call" (their voicemail never counts as answered)
//   dial    the team leg ended → answered, or the fallback
//   ai      the AI receptionist leg ended
//   status  the whole call ended → duration; a call nobody took becomes a callback task
//   verify  a verification call to a destination → the owner types the code shown on screen
// Fallbacks: 'ai' = the SAME receptionist engine as chat and browser voice (Retell custom telephony: register the call, dial
// sip:<call_id>@sip.retellai.com; the call id routes the LLM socket to this business, server/receptionist/voice.js);
// 'callback' = a short spoken message and, when the number isn't withheld, a receptionist_requests row (Needs attention +
// the owner notice, server/notify.js). Nothing is recorded or transcribed by Twilio. No promise of a call time is ever spoken.
import { customerFromRow } from '../auth.js'
import { getCustomer } from '../customers.js'
import { randomToken } from '../google-oauth.js'
import { toE164 } from '../sms.js'
import { withinHours } from '../receptionist/routing.js'
import { getSettings as receptionistSettings, startConversation } from '../receptionist/engine.js'
import { voiceConfigured, voiceAllowedFor } from '../receptionist/voice.js'
import { hit } from '../ratelimit.js'
import { aiOff, retellRoom } from '../ai-budget.js'
import { recordEvent } from '../auditlog.js'
import { checkVerification, getSettings, limits, phoneEnabled, verifiedNumbers } from './lines.js'
import { dialNumbers, dialSip, gather, hangup, say, twiml } from './twiml.js'

const MIN = 60_000
const SID_RE = /^CA[0-9a-f]{32}$/
// Twilio's stand-ins for a hidden caller (anonymous, restricted, unavailable, unknown) and anything that isn't E.164.
const WITHHELD = new Set(['+266696687', '+7378742833', '+8656696', '+86282452253', 'anonymous', 'restricted', 'unavailable', 'unknown', 'private'])
export function callerOf(from) {
  const raw = String(from || '').trim()
  if (!raw || WITHHELD.has(raw.toLowerCase())) return { caller: null, state: 'withheld' }
  const n = toE164(raw)
  return n && /^\+[1-9]\d{7,14}$/.test(n) && n === raw ? { caller: n, state: 'known' } : { caller: null, state: 'unknown' }
}

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
export const RETELL_SIP_HOST = 'sip.retellai.com'

// Decide the route. Pure: same inputs, same plan (a repeated webhook gets the same answer).
// → { route: 'team' | 'fallback' | 'limited', fallback: 'ai' | 'callback', ring: [numbers], ringSeconds }
export function planCall({ settings, line, verified, open, aiOk, limited }) {
  const fallback = settings.fallback === 'ai' && aiOk ? 'ai' : 'callback'
  if (limited) return { route: 'limited', fallback: 'callback', ring: [], ringSeconds: 0 }
  const skipTeam =
    settings.answer === 'fallback' ||
    !verified.length ||
    // Calls the owner already missed on their own phone (conditional forwarding): ringing them again would only delay.
    line.forward_mode === 'no_answer' ||
    (!open && settings.afterHours === 'fallback')
  if (skipTeam) return { route: 'fallback', fallback, ring: [], ringSeconds: 0 }
  return { route: 'team', fallback, ring: verified.map((d) => d.number), ringSeconds: settings.ringSeconds }
}

// The AI receptionist can take phone calls for this business right now (same gates as browser voice, plus the shared
// spending guard: AI off for everyone or this business, or the platform's Retell minutes would be passed → the caller gets
// the callback path instead; server/ai-budget.js).
async function aiAvailable(env, customer, now = Date.now()) {
  if (env.RECEPTIONIST_ENABLED === 'false' || !voiceConfigured(env) || !voiceAllowedFor(env, customer.id)) return false
  if (await aiOff(env, customer.id, now)) return false
  if (!(await retellRoom(env, now)).ok) return false
  const s = await receptionistSettings(env.ONBOARDING_DB, customer.id).catch(() => null)
  return Boolean(s?.enabled)
}

// Match a caller to ONE person already recorded by this business (exact number). Shared numbers → ambiguous, not linked.
export async function matchCaller(db, customerId, caller) {
  if (!caller) return { match: 'none', leadId: null }
  const { results } = await db.prepare('SELECT id, name, phone, created_at FROM leads WHERE customer = ?1 ORDER BY created_at DESC LIMIT 500').bind(customerId).all()
  const hits = results.filter((l) => toE164(l.phone) === caller)
  if (!hits.length) return { match: 'none', leadId: null }
  const names = new Set(hits.map((l) => String(l.name || '').trim().toLowerCase()))
  return names.size === 1 ? { match: 'single', leadId: hits[0].id } : { match: 'ambiguous', leadId: null }
}

const bizName = (c) => String(c.name || 'the business').replace(/\b(LLC|Inc\.?|Corp\.?|Ltd\.?)\s*$/i, '').trim()
async function loadCall(db, sid, accountCustomer) {
  if (!SID_RE.test(sid || '')) return null
  const call = await db.prepare('SELECT * FROM phone_calls WHERE call_sid = ?1').bind(sid).first()
  return call && call.customer === accountCustomer ? call : null
}
// Outcomes only move forward: a later, weaker report never replaces a decided one.
async function setOutcome(db, sid, outcome, extra = {}, now = Date.now()) {
  const cols = Object.keys(extra)
  const sets = cols.map((k, i) => `${k} = ?${i + 4}`).join(', ')
  await db.prepare(`UPDATE phone_calls SET outcome = ?2, updated_at = ?3${sets ? `, ${sets}` : ''} WHERE call_sid = ?1 AND outcome IS NULL`).bind(sid, outcome, now, ...cols.map((k) => extra[k])).run()
}

// ---------- step: a call arrives ----------
export async function incomingCall(env, p, { accountCustomer, origin }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const sid = p.get('CallSid')
  const to = toE164(p.get('To'))
  if (!SID_RE.test(sid || '') || !to) return twiml(hangup())
  // The number must belong to the business whose subaccount signed this request.
  const line = await db.prepare("SELECT * FROM phone_lines WHERE number = ?1 AND status = 'active'").bind(to).first()
  if (!line || line.customer !== accountCustomer) {
    await recordEvent(db, { type: 'phone.call_unrouted', actor: 'system:twilio', capability: 'phone.calls', resource: { type: 'webhook', id: 'voice' }, outcome: 'failure', details: { reason: line ? 'wrong_account' : 'unknown_number' } })
    return twiml(say('Sorry, this number is not in service.'), hangup())
  }
  const customer = customerFromRow(await getCustomer(db, line.customer))
  const { caller, state } = callerOf(p.get('From'))
  // Our own legs coming back (a team phone or one of our lines forwarding to us) are refused: that leg fails, never loops.
  const fwd = toE164(p.get('ForwardedFrom'))
  const ownLines = (await db.prepare("SELECT number FROM phone_lines WHERE status = 'active'").all()).results.map((r) => r.number)
  const verified = await verifiedNumbers(db, line.customer)
  if ((caller && ownLines.includes(caller)) || (fwd && (ownLines.includes(fwd) || verified.some((d) => d.number === fwd)))) {
    await recordEvent(db, { type: 'phone.loop_refused', actor: 'system:twilio', customer: line.customer, capability: 'phone.calls', resource: { type: 'phone_line', id: line.id }, outcome: 'info' })
    return twiml('<Reject reason="busy"/>')
  }
  const existing = await db.prepare('SELECT * FROM phone_calls WHERE call_sid = ?1').bind(sid).first()
  if (existing && existing.customer !== line.customer) return twiml(hangup())
  if (!phoneEnabled(env) || customer.status !== 'active') {
    if (!existing) await db.prepare("INSERT OR IGNORE INTO phone_calls (call_sid, customer, line_id, caller, caller_state, source, route, outcome, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'off', 'off', ?7, ?7)").bind(sid, line.customer, line.id, caller, state, line.source, now).run()
    return twiml(say(`Sorry, ${bizName(customer)} can't take calls on this line right now. Please try again later or book on their website.`), hangup())
  }
  // Limits: calls per line per hour (flood / loop guard), calls at once, minutes per day.
  const lim = limits(env)
  const flood = existing ? { limited: false } : await hit(env, 'phoneCallsPerLine', line.id, now)
  const open = Number((await db.prepare('SELECT count(*) AS n FROM phone_calls WHERE customer = ?1 AND ended_at IS NULL AND started_at > ?2 AND call_sid <> ?3').bind(line.customer, now - 15 * MIN, sid).first())?.n || 0)
  const secs = Number((await db.prepare('SELECT coalesce(sum(duration_seconds), 0) AS s FROM phone_calls WHERE customer = ?1 AND started_at > ?2').bind(line.customer, now - 1440 * MIN).first())?.s || 0)
  const limited = flood.limited || open >= lim.concurrent || secs >= lim.dailyMinutes * 60
  const plan = planCall({ settings: await getSettings(db, line.customer), line, verified, open: withinHours(customer, now), aiOk: await aiAvailable(env, customer), limited })
  if (!existing) {
    const m = await matchCaller(db, line.customer, caller)
    await db
      .prepare('INSERT OR IGNORE INTO phone_calls (call_sid, customer, line_id, caller, caller_state, forwarded, source, route, lead_id, match, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)')
      .bind(sid, line.customer, line.id, caller, state, fwd ? 1 : 0, line.source, plan.route, m.leadId, m.match, now)
      .run()
    if (limited) await recordEvent(db, { type: 'phone.call_limited', actor: 'system:twilio', customer: line.customer, capability: 'phone.calls', resource: { type: 'phone_line', id: line.id }, outcome: 'info', details: { reason: flood.limited ? 'per_line' : open >= lim.concurrent ? 'concurrent' : 'daily_minutes' } })
  }
  if (plan.route === 'team') {
    const q = `c=${sid}`
    const screen = (await getSettings(db, line.customer)).screen
    // A hidden caller can't be passed on as caller ID: the team phone shows the business line instead.
    return twiml(dialNumbers({ numbers: plan.ring, timeout: plan.ringSeconds, action: `${origin}/api/phone/twilio/dial?${q}`, screenUrl: screen ? `${origin}/api/phone/twilio/screen?${q}` : undefined, callerId: caller ? undefined : line.number }))
  }
  return fallbackTwiml(env, customer, line, { sid, caller }, plan.fallback, { origin }, now)
}

async function fallbackTwiml(env, customer, line, { sid, caller }, kind, { origin }, now) {
  const db = env.ONBOARDING_DB
  if (kind === 'ai') {
    const ai = await registerAiCall(env, customer, { from: caller || line.number, to: line.number, sid }, now)
    if (ai.ok) return twiml(dialSip({ uri: `sip:${ai.callId}@${RETELL_SIP_HOST}`, action: `${origin}/api/phone/twilio/ai?c=${sid}` }))
    await recordEvent(db, { type: 'phone.ai_unavailable', actor: 'system:retell', customer: customer.id, capability: 'phone.calls', resource: { type: 'phone_call', id: sid }, outcome: 'failure', details: { reason: ai.error } })
  }
  await callbackTask(db, customer, { sid, caller }, now)
  await setOutcome(db, sid, caller ? 'callback' : 'missed', {}, now)
  const name = bizName(customer)
  return twiml(
    caller
      ? say(`Sorry, nobody at ${name} could take your call right now. Your number has been saved so they can call you back. You can also book a time on their website.`)
      : say(`Sorry, nobody at ${name} could take your call right now, and your number was hidden. Please call again, or book a time on their website.`),
    hangup(),
  )
}

// A callback task: the existing receptionist request (Needs attention + owner notice). One per call (unique conversation id).
async function callbackTask(db, customer, { sid, caller }, now) {
  if (!caller) return null
  const id = `rq_${randomToken(9)}`
  await db
    .prepare("INSERT OR IGNORE INTO receptionist_requests (id, customer, conversation_id, kind, phone, note, created_at, updated_at) VALUES (?1, ?2, ?3, 'callback', ?4, 'Missed phone call', ?5, ?5)")
    .bind(id, customer.id, `call:${sid}`, caller, now)
    .run()
  const r = await db.prepare("SELECT id FROM receptionist_requests WHERE conversation_id = ?1 AND kind = 'callback'").bind(`call:${sid}`).first()
  if (r) await db.prepare('UPDATE phone_calls SET request_id = ?2 WHERE call_sid = ?1').bind(sid, r.id).run()
  return r?.id ?? null
}

// Retell custom telephony: register, then Twilio dials sip:<call_id>@sip.retellai.com within 5 minutes.
export async function registerAiCall(env, customer, { from, to, sid }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const conv = await startConversation(env, customer, 'voice', now, { attribution: { source: 'phone' } })
  let res
  try {
    res = await fetch(`${retellBase(env)}/v2/register-phone-call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: env.RETELL_AGENT_ID, from_number: from, to_number: to, direction: 'inbound', metadata: { business: customer.id, conversation: conv.id, channel: 'phone' } }),
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return { ok: false, error: 'ai_unreachable' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !/^[A-Za-z0-9_-]{8,80}$/.test(body?.call_id || '')) return { ok: false, error: res.status === 402 ? 'ai_billing' : `ai_http_${res.status}` }
  await db.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?1, ?2, ?3, 'retell', ?4)").bind(body.call_id, customer.id, conv.id, now).run()
  await db.prepare('UPDATE phone_calls SET ai_call_id = ?2, conversation_id = ?3, updated_at = ?4 WHERE call_sid = ?1').bind(sid, body.call_id, conv.id, now).run()
  return { ok: true, callId: body.call_id, conversationId: conv.id }
}

// ---------- step: the team member's phone picked up ----------
export async function screenCall(env, p, url, { accountCustomer }) {
  const call = await loadCall(env.ONBOARDING_DB, url.searchParams.get('c'), accountCustomer)
  if (!call) return twiml(hangup())
  if (url.searchParams.get('r') === '1') return p.get('Digits') === '1' ? twiml() : twiml(hangup())
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, call.customer))
  const who = call.caller_state === 'known' ? '' : ' The caller hid their number.'
  return twiml(gather({ action: `${url.origin}/api/phone/twilio/screen?c=${call.call_sid}&r=1`, digits: 1, timeout: 6, prompt: `Customer call for ${bizName(customer)}.${who} Press 1 to answer.` }), hangup())
}

// ---------- step: the team leg ended ----------
export async function dialResult(env, p, url, { accountCustomer, origin }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const call = await loadCall(db, url.searchParams.get('c'), accountCustomer)
  if (!call) return twiml(hangup())
  const status = String(p.get('DialCallStatus') || '').slice(0, 20)
  const bridged = p.get('DialBridged') !== 'false'
  await db.prepare('UPDATE phone_calls SET dial_status = ?2, updated_at = ?3 WHERE call_sid = ?1').bind(call.call_sid, status, now).run()
  if (status === 'completed' && bridged) {
    await setOutcome(db, call.call_sid, 'answered', { answered_by: 'team' }, now)
    return twiml(hangup())
  }
  if (call.outcome) return twiml(hangup()) // already decided (a repeated request)
  const customer = customerFromRow(await getCustomer(db, call.customer))
  const line = await db.prepare('SELECT * FROM phone_lines WHERE id = ?1').bind(call.line_id).first()
  const s = await getSettings(db, call.customer)
  const kind = s.fallback === 'ai' && (await aiAvailable(env, customer)) ? 'ai' : 'callback'
  return fallbackTwiml(env, customer, line, { sid: call.call_sid, caller: call.caller }, kind, { origin }, now)
}

// ---------- step: the AI leg ended ----------
export async function aiResult(env, p, url, { accountCustomer, origin }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const call = await loadCall(db, url.searchParams.get('c'), accountCustomer)
  if (!call) return twiml(hangup())
  const status = String(p.get('DialCallStatus') || '')
  if (status === 'completed') {
    await setOutcome(db, call.call_sid, 'ai', { answered_by: 'ai' }, now)
    return twiml(hangup())
  }
  if (call.outcome) return twiml(hangup())
  // The AI leg never connected: the caller still gets the callback message.
  const customer = customerFromRow(await getCustomer(db, call.customer))
  const line = await db.prepare('SELECT * FROM phone_lines WHERE id = ?1').bind(call.line_id).first()
  return fallbackTwiml(env, customer, line, { sid: call.call_sid, caller: call.caller }, 'callback', { origin }, now)
}

// ---------- step: the whole call ended (number StatusCallback) ----------
export async function callStatus(env, p, { accountCustomer }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const call = await loadCall(db, p.get('CallSid'), accountCustomer)
  if (!call) return { ok: true, ignored: true }
  const st = String(p.get('CallStatus') || '')
  if (!['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st)) return { ok: true }
  const secs = Number.parseInt(p.get('CallDuration'), 10)
  await db.prepare('UPDATE phone_calls SET ended_at = coalesce(ended_at, ?2), duration_seconds = coalesce(?3, duration_seconds), updated_at = ?2 WHERE call_sid = ?1').bind(call.call_sid, now, Number.isFinite(secs) && secs >= 0 ? secs : null).run()
  if (!call.outcome) {
    // The caller hung up before anyone answered (or the call failed): a missed call, and a callback task when we have a number.
    const customer = customerFromRow(await getCustomer(db, call.customer))
    await callbackTask(db, customer, { sid: call.call_sid, caller: call.caller }, now)
    await setOutcome(db, call.call_sid, st === 'failed' ? 'failed' : 'missed', {}, now)
  }
  return { ok: true }
}

// ---------- step: verification call to a destination ----------
export async function verifyStep(env, p, url, { accountCustomer }, now = Date.now()) {
  const id = url.searchParams.get('d')
  const d = await env.ONBOARDING_DB.prepare('SELECT customer FROM phone_destinations WHERE id = ?1').bind(String(id)).first()
  if (!d || d.customer !== accountCustomer) return twiml(hangup())
  const action = `${url.origin}/api/phone/twilio/verify?d=${encodeURIComponent(id)}&r=1`
  if (url.searchParams.get('r') !== '1') return twiml(gather({ action, digits: 4, timeout: 10, prompt: 'This is GetShowUps checking this number before calls are forwarded to it. Enter the 4 digit code shown on your screen.' }), hangup())
  const r = await checkVerification(env.ONBOARDING_DB, { destinationId: id, digits: p.get('Digits'), accountCustomer }, now)
  if (r.ok) return twiml(say('Thank you. This number is verified and can now receive calls.'), hangup())
  return r.retry ? twiml(gather({ action, digits: 4, timeout: 10, prompt: 'That code did not match. Please try again.' }), hangup()) : twiml(say('That code did not match. Start again from your screen. Goodbye.'), hangup())
}

// ---------- owner views ----------
const OUTCOME_TEXT = { answered: 'Answered', ai: 'AI receptionist', callback: 'Missed · call back', missed: 'Missed', failed: 'Failed', limited: 'Over the limit', off: 'Line off' }
export async function listCalls(db, customerId, { days = 30, limit = 50, which = 'all' } = {}, now = Date.now()) {
  const missed = which === 'missed' ? "AND c.outcome IN ('missed', 'callback') AND (r.status IS NULL OR r.status = 'open')" : ''
  const { results } = await db
    .prepare(
      `SELECT c.call_sid, c.caller, c.caller_state, c.source, c.outcome, c.duration_seconds, c.started_at, c.lead_id, c.match, c.conversation_id, c.request_id,
              r.status AS request_status, coalesce(c.lead_id, v.lead_id) AS lead, l.name AS lead_name, v.appointment_id AS ai_booking,
              (SELECT count(*) FROM appointments a WHERE a.customer = c.customer AND a.lead_id = coalesce(c.lead_id, v.lead_id) AND a.created_at >= c.started_at) AS booked_after
         FROM phone_calls c LEFT JOIN receptionist_requests r ON r.id = c.request_id
         LEFT JOIN receptionist_conversations v ON v.id = c.conversation_id AND v.customer = c.customer
         LEFT JOIN leads l ON l.id = coalesce(c.lead_id, v.lead_id) AND l.customer = c.customer
        WHERE c.customer = ?1 AND c.started_at > ?2 ${missed} ORDER BY c.started_at DESC LIMIT ?3`,
    )
    .bind(customerId, now - days * 1440 * MIN, Math.min(200, limit))
    .all()
  return results.map((c) => ({
    id: c.call_sid,
    at: c.started_at,
    caller: c.caller,
    callerState: c.caller_state,
    source: c.source,
    outcome: c.outcome || 'in_progress',
    outcomeText: OUTCOME_TEXT[c.outcome] || 'In progress',
    seconds: c.duration_seconds,
    // A person only when the evidence says so: an exact single-number match, or the AI conversation's own lead.
    customer: c.lead && c.lead_name ? { leadId: c.lead, name: c.lead_name } : null,
    shared: c.match === 'ambiguous',
    callbackOpen: c.request_status === 'open',
    bookedByAi: Boolean(c.ai_booking),
    bookedAfter: Number(c.booked_after) > 0,
  }))
}

// Retention (docs/DATA_RETENTION.md): call records older than 365 days are removed, with their callback tasks; bounded per run.
export const CALL_RETENTION_MS = 365 * 1440 * MIN
export async function purgeOldCalls(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare('SELECT call_sid FROM phone_calls WHERE started_at < ?1 LIMIT 200').bind(now - CALL_RETENTION_MS).all()
  for (const r of results)
    await db.batch([db.prepare("DELETE FROM receptionist_requests WHERE conversation_id = ?1 AND kind = 'callback'").bind(`call:${r.call_sid}`), db.prepare('DELETE FROM phone_calls WHERE call_sid = ?1').bind(r.call_sid)])
  return results.length
}
