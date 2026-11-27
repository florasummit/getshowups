// Business phone lines: configuration (docs/TELEPHONE.md). A line is a Twilio number in the business's OWN subaccount
// (server/followups/twilio.js, one per business), configured by API (no provider console work per customer). Calls arrive
// at /api/phone/twilio/<step> (server/telephony/calls.js), which rings the business's VERIFIED numbers and then the fallback.
//
// Switches (off unless exactly 'true'; approval):
//   PHONE_ENABLED          the Phone card, the call webhooks and destination verification. Needs the privacy policy to name
//                          call records (caller number, time, length, outcome) first.
//   PHONE_NUMBER_PURCHASE  buying a number (a monthly charge on our Twilio account).
// Limits: PHONE_DAILY_MINUTES (per business, default 120), PHONE_CONCURRENT (calls at once per business, default 3).
// Test businesses never place a real call or buy a real number (only against the loopback Twilio mock).
import { CUSTOMER_RE } from '../invites.js'
import { randomToken, sha256Hex } from '../google-oauth.js'
import { toE164 } from '../sms.js'
import { testStatus } from '../testbusiness.js'
import { ensureSubaccount, subaccountAuth, twilioRequest, parentConfigured } from '../followups/twilio.js'
import { hit, unhit } from '../ratelimit.js'
import { recordEvent } from '../auditlog.js'

export const PHONE_TABLES = ['phone_lines', 'phone_settings', 'phone_destinations', 'phone_calls']
export const phoneEnabled = (env) => env.PHONE_ENABLED === 'true'
export const purchaseEnabled = (env) => env.PHONE_NUMBER_PURCHASE === 'true'
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const mocked = (env) => typeof env.TWILIO_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.TWILIO_API_MOCK_ORIGIN)
const posInt = (v, d) => (/^\d{1,5}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : d)
export const limits = (env) => ({ dailyMinutes: posInt(env.PHONE_DAILY_MINUTES, 120), concurrent: posInt(env.PHONE_CONCURRENT, 3) })

// Published US prices (Twilio voice pricing, Retell pricing; read 2026-11-26). ESTIMATES, labelled as such wherever shown;
// a verified charge is only ever the provider's own record (phone_calls.price_micros).
export const COST_ESTIMATES = {
  numberMonthly: 1.15, // Twilio local number, per month
  inboundPerMin: 0.0085, // Twilio, the caller's leg
  forwardPerMin: 0.014, // Twilio, each answered leg to a team phone
  sipPerMin: 0.004, // Twilio, the leg to the AI receptionist
  aiPerMin: 0.07, // Retell voice infrastructure + voice ($0.055 + $0.015), plus our model's own cost
  verifyCall: 0.014, // one short verification call
}

let readyCache = null
export async function phoneReady(db) {
  if (readyCache === true) return true
  try {
    const n = Number((await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${PHONE_TABLES.map((t) => `'${t}'`).join(',')})`).first())?.n)
    if (n === PHONE_TABLES.length) readyCache = true
    return n === PHONE_TABLES.length
  } catch {
    return false
  }
}
export const resetReadyCache = () => (readyCache = null)

// Real calls / numbers are allowed for this business (never for a test business, except against the loopback mock).
export async function liveOps(env, customerId) {
  if (mocked(env)) return true
  const t = await testStatus(env, customerId).catch(() => ({ test: true }))
  return !t.test
}

// ---------- validation ----------
// US numbers only, never premium-rate / directory / special N11 or 555-01xx test ranges as destinations (toll fraud).
const PREMIUM = /^\+1(900|976|500|533|544|566|577|588|700)/
export function destinationNumber(raw) {
  const n = toE164(raw)
  if (!n || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(n)) return null
  if (PREMIUM.test(n) || /^\+1\d{3}[2-9]11\d{4}$/.test(n)) return null
  return n
}
export const SOURCES = ['general', 'website', 'google_ads', 'print', 'vehicle', 'other']
const SETTINGS_DEFAULT = { answer: 'team', ringSeconds: 20, fallback: 'callback', afterHours: 'same', screen: true, version: 0 }
export function validateSettings(b) {
  const out = {
    answer: b?.answer === 'fallback' ? 'fallback' : b?.answer === 'team' ? 'team' : null,
    ringSeconds: Number.isInteger(b?.ringSeconds) && b.ringSeconds >= 10 && b.ringSeconds <= 45 ? b.ringSeconds : null,
    fallback: b?.fallback === 'ai' || b?.fallback === 'callback' ? b.fallback : null,
    afterHours: b?.afterHours === 'same' || b?.afterHours === 'fallback' ? b.afterHours : null,
    screen: typeof b?.screen === 'boolean' ? b.screen : null,
  }
  const bad = Object.entries(out).filter(([, v]) => v === null).map(([k]) => k)
  return bad.length ? [{ error: 'invalid_settings', fields: bad }] : [null, out]
}

// ---------- reads ----------
export async function getSettings(db, customer) {
  const r = await db.prepare('SELECT * FROM phone_settings WHERE customer = ?1').bind(customer).first()
  return r ? { answer: r.answer, ringSeconds: r.ring_seconds, fallback: r.fallback, afterHours: r.after_hours, screen: r.screen === 1, version: r.version } : { ...SETTINGS_DEFAULT }
}
export const activeLines = async (db, customer) => (await db.prepare("SELECT * FROM phone_lines WHERE customer = ?1 AND status = 'active' ORDER BY created_at").bind(customer).all()).results
export const destinations = async (db, customer) => (await db.prepare('SELECT id, number, label, verified_at, code_expires, created_at FROM phone_destinations WHERE customer = ?1 AND removed_at IS NULL ORDER BY created_at').bind(customer).all()).results
export const verifiedNumbers = async (db, customer) => (await db.prepare('SELECT id, number FROM phone_destinations WHERE customer = ?1 AND removed_at IS NULL AND verified_at IS NOT NULL ORDER BY created_at LIMIT 5').bind(customer).all()).results

// Month-to-date usage from our own call records (minutes = Twilio's reported durations) and the estimate from published prices.
export async function usage(db, customer, now = Date.now()) {
  const d = new Date(now)
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const r = await db
    .prepare(
      `SELECT count(*) AS calls, coalesce(sum(duration_seconds), 0) AS secs,
              coalesce(sum(CASE WHEN outcome = 'answered' THEN duration_seconds END), 0) AS team_secs,
              coalesce(sum(CASE WHEN outcome = 'ai' THEN duration_seconds END), 0) AS ai_secs,
              sum(CASE WHEN outcome IN ('missed', 'callback') THEN 1 ELSE 0 END) AS missed,
              sum(price_micros) AS verified_micros, sum(CASE WHEN price_micros IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM phone_calls WHERE customer = ?1 AND started_at >= ?2`,
    )
    .bind(customer, from)
    .first()
  const lines = Number((await db.prepare("SELECT count(*) AS n FROM phone_lines WHERE customer = ?1 AND status = 'active'").bind(customer).first())?.n || 0)
  const min = (s) => Math.ceil(Number(s || 0) / 60)
  const e = COST_ESTIMATES
  const estimate = lines * e.numberMonthly + min(r.secs) * e.inboundPerMin + min(r.team_secs) * e.forwardPerMin + min(r.ai_secs) * (e.sipPerMin + e.aiPerMin)
  return {
    period: d.toISOString().slice(0, 7),
    calls: Number(r.calls || 0),
    missed: Number(r.missed || 0),
    minutes: min(r.secs),
    aiMinutes: min(r.ai_secs),
    estimatedUsd: Math.round(estimate * 100) / 100,
    // Only when every call this month has the provider's own price: never a mix of verified and estimated.
    verifiedUsd: Number(r.calls) > 0 && Number(r.unpriced) === 0 ? Math.round(Number(r.verified_micros) / 1e4) / 100 : null,
  }
}

// The one answer to "is the phone set up?" (assisted enrollment checklist, Setup check, Receptionist tile).
// → { state: 'unavailable' | 'not_started' | 'needs_owner' | 'ready' | 'live', next, href }
export async function phoneSetup(env, customerId) {
  const href = '/dashboard/settings#phone'
  if (!phoneEnabled(env) || !CUSTOMER_RE.test(customerId || '') || !(await phoneReady(env.ONBOARDING_DB))) return { state: 'unavailable', next: 'Phone lines aren’t available yet.', href }
  const db = env.ONBOARDING_DB
  const [lines, dest, s] = await Promise.all([activeLines(db, customerId), verifiedNumbers(db, customerId), getSettings(db, customerId)])
  if (!lines.length) return { state: 'not_started', next: 'Get a phone number for your business.', href }
  if (s.answer === 'team' && !dest.length) return { state: 'needs_owner', next: 'Add and verify a phone that should ring.', href }
  const calls = Number((await db.prepare('SELECT count(*) AS n FROM phone_calls WHERE customer = ?1').bind(customerId).first())?.n || 0)
  return calls ? { state: 'live', next: 'Calls are arriving.', href } : { state: 'ready', next: 'Show your number on your website and call it once to test.', href }
}

// ---------- writes (owner actions; the route checks session, same origin and rate limits) ----------
export async function saveSettings(env, customer, body, now = Date.now()) {
  const [err, s] = validateSettings(body)
  if (err) return { ok: false, status: 400, ...err }
  const db = env.ONBOARDING_DB
  const version = Number.isInteger(body?.version) ? body.version : -1
  const r = await db
    .prepare(
      `INSERT INTO phone_settings (customer, answer, ring_seconds, fallback, after_hours, screen, version, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7 WHERE ?8 = 0
         AND NOT EXISTS (SELECT 1 FROM phone_settings WHERE customer = ?1)
       ON CONFLICT(customer) DO NOTHING`,
    )
    .bind(customer.id, s.answer, s.ringSeconds, s.fallback, s.afterHours, s.screen ? 1 : 0, now, version)
    .run()
  let changed = r.meta.changes
  if (!changed) changed = (await db.prepare('UPDATE phone_settings SET answer = ?2, ring_seconds = ?3, fallback = ?4, after_hours = ?5, screen = ?6, version = version + 1, updated_at = ?7 WHERE customer = ?1 AND version = ?8').bind(customer.id, s.answer, s.ringSeconds, s.fallback, s.afterHours, s.screen ? 1 : 0, now, version).run()).meta.changes
  if (!changed) return { ok: false, status: 409, error: 'stale' }
  return { ok: true, settings: await getSettings(db, customer.id) }
}

export async function addDestination(env, customer, { number, label }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const n = destinationNumber(number)
  if (!n) return { ok: false, status: 400, error: 'invalid_phone' }
  // Never one of our own lines, or the owner's number that forwards to a line: dialling it would loop.
  const loop = await db.prepare("SELECT 1 FROM phone_lines WHERE status = 'active' AND (number = ?1 OR (customer = ?2 AND forwarded_from = ?1))").bind(n, customer.id).first()
  if (loop) return { ok: false, status: 400, error: 'forwarding_loop' }
  const count = Number((await db.prepare('SELECT count(*) AS n FROM phone_destinations WHERE customer = ?1 AND removed_at IS NULL').bind(customer.id).first())?.n || 0)
  if (count >= 5) return { ok: false, status: 400, error: 'too_many' }
  const id = `pd_${randomToken(9)}`
  const r = await db.prepare('INSERT OR IGNORE INTO phone_destinations (id, customer, number, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, customer.id, n, String(label || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 40), now).run()
  if (!r.meta.changes) return { ok: false, status: 409, error: 'already_added' }
  return { ok: true, id }
}

export async function removeDestination(env, customer, id, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('UPDATE phone_destinations SET removed_at = ?3, code_hash = NULL WHERE id = ?1 AND customer = ?2 AND removed_at IS NULL').bind(String(id), customer.id, now).run()
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: 'not_found' }
}

// Verification: a call from the business's line to the destination; the person types the 4-digit code shown on screen.
// The code is returned to the signed-in owner only and stored as a hash. One call per request, rate-limited (paid).
export async function startVerification(env, customer, id, { origin }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!phoneEnabled(env)) return { ok: false, status: 404, error: 'not_found' }
  const d = await db.prepare('SELECT * FROM phone_destinations WHERE id = ?1 AND customer = ?2 AND removed_at IS NULL').bind(String(id), customer.id).first()
  if (!d) return { ok: false, status: 404, error: 'not_found' }
  if (d.verified_at) return { ok: true, already: true }
  const [line] = await activeLines(db, customer.id)
  if (!line) return { ok: false, status: 409, error: 'no_line' }
  if (!(await liveOps(env, customer.id))) return { ok: false, status: 403, error: 'test_business' }
  const auth = await subaccountAuth(env, customer.id)
  if (!auth) return { ok: false, status: 503, error: 'provider_not_configured' }
  const rl = await hit(env, 'phoneVerifyCall', customer.id, now)
  if (rl.limited) return { ok: false, status: 429, error: 'rate_limited' }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0')
  await db.prepare('UPDATE phone_destinations SET code_hash = ?3, code_expires = ?4, attempts = 0 WHERE id = ?1 AND customer = ?2').bind(d.id, customer.id, await sha256Hex(`${d.id}:${code}`), now + 10 * 60_000).run()
  const url = `${origin}/api/phone/twilio/verify?d=${encodeURIComponent(d.id)}`
  const r = await twilioRequest(env, { path: `/2010-04-01/Accounts/${auth.sid}/Calls.json`, params: [['To', d.number], ['From', line.number], ['Url', url], ['Method', 'POST'], ['Timeout', 25]], auth })
  if (!r.ok) {
    if (!r.unknown) await unhit(env, 'phoneVerifyCall', customer.id, now)
    return { ok: false, status: 502, error: r.unknown ? 'unknown_outcome' : 'provider_refused' }
  }
  return { ok: true, code, expiresAt: now + 10 * 60_000 }
}

// Twilio's verification call posts the digits here (calls.js). → TwiML text decision.
export async function checkVerification(db, { destinationId, digits, accountCustomer }, now = Date.now()) {
  const d = await db.prepare('SELECT * FROM phone_destinations WHERE id = ?1 AND removed_at IS NULL').bind(String(destinationId)).first()
  // The call must come from the destination's own business's subaccount (signature checked by the route).
  if (!d || d.customer !== accountCustomer || !d.code_hash || !d.code_expires || d.code_expires < now || d.attempts >= 3) return { ok: false, retry: false }
  if (!/^\d{4}$/.test(digits || '')) return { ok: false, retry: d.attempts < 2 }
  if ((await sha256Hex(`${d.id}:${digits}`)) !== d.code_hash) {
    await db.prepare('UPDATE phone_destinations SET attempts = attempts + 1 WHERE id = ?1').bind(d.id).run()
    return { ok: false, retry: d.attempts + 1 < 3 }
  }
  await db.prepare('UPDATE phone_destinations SET verified_at = ?2, code_hash = NULL, code_expires = NULL WHERE id = ?1').bind(d.id, now).run()
  return { ok: true }
}

// Numbers Twilio has for an area code (read-only search inside the business's subaccount).
export async function searchNumbers(env, customer, areaCode) {
  if (!/^[2-9]\d{2}$/.test(String(areaCode || ''))) return { ok: false, status: 400, error: 'invalid_area_code' }
  if (!purchaseEnabled(env)) return { ok: false, status: 403, error: 'purchase_off' }
  if (!(await liveOps(env, customer.id))) return { ok: false, status: 403, error: 'test_business' }
  if (!parentConfigured(env)) return { ok: false, status: 503, error: 'provider_not_configured' }
  const acct = await ensureSubaccount(env, customer.id)
  if (!acct.ok) return { ok: false, status: 503, error: acct.error }
  const auth = await subaccountAuth(env, customer.id)
  const r = await twilioRequest(env, { method: 'GET', path: `/2010-04-01/Accounts/${auth.sid}/AvailablePhoneNumbers/US/Local.json`, params: [['AreaCode', areaCode], ['VoiceEnabled', 'true'], ['PageSize', 6]], auth })
  if (!r.ok) return { ok: false, status: 502, error: 'provider_refused' }
  const numbers = (r.body?.available_phone_numbers || []).map((n) => ({ number: n.phone_number, place: [n.locality, n.region].filter(Boolean).join(', ') })).filter((n) => /^\+1\d{10}$/.test(n.number))
  return { ok: true, numbers }
}

// Buy a number into the business's subaccount with our webhooks set (no console step). Paid: approval switch + confirm.
export async function buyNumber(env, customer, { number, source }, { origin, actor }, now = Date.now()) {
  if (!purchaseEnabled(env)) return { ok: false, status: 403, error: 'purchase_off' }
  if (!/^\+1[2-9]\d{9}$/.test(String(number || ''))) return { ok: false, status: 400, error: 'invalid_phone' }
  if (!(await liveOps(env, customer.id))) return { ok: false, status: 403, error: 'test_business' }
  const db = env.ONBOARDING_DB
  if ((await activeLines(db, customer.id)).length >= 3) return { ok: false, status: 400, error: 'too_many' }
  const acct = await ensureSubaccount(env, customer.id)
  if (!acct.ok) return { ok: false, status: 503, error: acct.error }
  const auth = await subaccountAuth(env, customer.id)
  const r = await twilioRequest(env, {
    path: `/2010-04-01/Accounts/${auth.sid}/IncomingPhoneNumbers.json`,
    params: [['PhoneNumber', number], ['FriendlyName', `GetShowUps ${customer.id}`], ['VoiceUrl', `${origin}/api/phone/twilio/voice`], ['VoiceMethod', 'POST'], ['StatusCallback', `${origin}/api/phone/twilio/status`], ['StatusCallbackMethod', 'POST']],
    auth,
  })
  // Unknown outcome: never bought twice blindly; the owner is told to check before trying again.
  if (!r.ok) return { ok: false, status: 502, error: r.unknown ? 'unknown_outcome' : 'provider_refused' }
  if (!/^PN[0-9a-f]{32}$/.test(r.body?.sid || '') || r.body?.phone_number !== number) return { ok: false, status: 502, error: 'provider_bad_response' }
  const id = `pl_${randomToken(9)}`
  await db
    .prepare("INSERT INTO phone_lines (id, customer, number, provider, provider_sid, account_sid, source, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'twilio', ?4, ?5, ?6, 'active', ?7, ?7)")
    .bind(id, customer.id, number, r.body.sid, auth.sid, SOURCES.includes(source) ? source : 'general', now)
    .run()
  await recordEvent(db, { type: 'phone.number_bought', actor, customer: customer.id, capability: 'phone.lines', resource: { type: 'phone_line', id }, outcome: 'success' }).catch(() => {})
  return { ok: true, id, number }
}

export async function updateLine(env, customer, { id, source, forwardedFrom, forwardMode }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const line = await db.prepare("SELECT * FROM phone_lines WHERE id = ?1 AND customer = ?2 AND status = 'active'").bind(String(id), customer.id).first()
  if (!line) return { ok: false, status: 404, error: 'not_found' }
  const mode = ['none', 'all', 'no_answer'].includes(forwardMode) ? forwardMode : null
  const from = forwardedFrom ? toE164(forwardedFrom) : null
  if (!mode || (forwardedFrom && !from) || (mode !== 'none' && !from) || from === line.number) return { ok: false, status: 400, error: 'invalid_forwarding' }
  // The forwarding number must never also be a number we ring (that rings it, it forwards back: a loop).
  if (from && (await db.prepare('SELECT 1 FROM phone_destinations WHERE customer = ?1 AND number = ?2 AND removed_at IS NULL').bind(customer.id, from).first())) return { ok: false, status: 400, error: 'forwarding_loop' }
  await db.prepare('UPDATE phone_lines SET source = ?3, forwarded_from = ?4, forward_mode = ?5, updated_at = ?6 WHERE id = ?1 AND customer = ?2').bind(line.id, customer.id, SOURCES.includes(source) ? source : line.source, mode === 'none' ? null : from, mode, now).run()
  return { ok: true }
}

// Give a number back to Twilio (confirmed owner action). Twilio stops charging; the call history stays.
export async function releaseLine(env, customer, id, { actor }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const line = await db.prepare("SELECT * FROM phone_lines WHERE id = ?1 AND customer = ?2 AND status = 'active'").bind(String(id), customer.id).first()
  if (!line) return { ok: false, status: 404, error: 'not_found' }
  const auth = await subaccountAuth(env, customer.id)
  if (line.provider_sid && auth) {
    const r = await twilioRequest(env, { method: 'DELETE', path: `/2010-04-01/Accounts/${auth.sid}/IncomingPhoneNumbers/${line.provider_sid}.json`, auth })
    if (!r.ok && r.status !== 404) return { ok: false, status: 502, error: r.unknown ? 'unknown_outcome' : 'provider_refused' }
  } else if (line.provider_sid) return { ok: false, status: 503, error: 'provider_not_configured' }
  await db.prepare("UPDATE phone_lines SET status = 'released', released_at = ?3, updated_at = ?3 WHERE id = ?1 AND customer = ?2").bind(line.id, customer.id, now).run()
  await recordEvent(db, { type: 'phone.number_released', actor, customer: customer.id, capability: 'phone.lines', resource: { type: 'phone_line', id: line.id }, outcome: 'success' }).catch(() => {})
  return { ok: true }
}
