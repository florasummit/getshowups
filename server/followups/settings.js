// Follow-ups: readiness, per-business preferences, and the one rule for whether a business may text.
//
// Release switches (off unless exactly 'true'; turning one on in production requires approval):
//   SMS_LIVE           texts may reach real customers. Off: texts only to MESSAGE_TEST_RECIPIENTS (like MESSAGES_LIVE).
//   FOLLOWUP_AI        the assistant (included model) writes replies to texts. Off: fixed, safe replies only.
//   MESSAGING_KILL_SWITCH === 'true': emergency stop, no automatic email or text is sent by anything (skipped, never
//                      sent later in a burst). Owner-typed replies are stopped too.
//
// A business may text only when ALL hold: the switch is not pulled, the provider is configured (TWILIO_*), the business
// has its own Twilio subaccount (sms_accounts, migration 0025) and its own sender (sms_registrations.messaging_service / sender_phone, set by a platform admin after provisioning),
// and its US texting registration was APPROVED by the provider. Nothing here infers approval.
import { smsConfigured } from '../sms.js'
import { CUSTOMER_RE } from '../invites.js'
import { accountsReady } from './twilio.js'

export const FOLLOWUP_TABLES = ['lead_threads', 'thread_messages', 'followup_settings', 'sms_registrations']
export const killSwitch = (env) => env?.MESSAGING_KILL_SWITCH === 'true'
export const smsLive = (env) => env?.SMS_LIVE === 'true'
export const followupAiOn = (env) => env?.FOLLOWUP_AI === 'true'

const ready = new WeakSet()
// Migration 0024 applied? Until then the follow-up engine does nothing (existing messages keep working unchanged).
export async function followupsReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const r = await db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${FOLLOWUP_TABLES.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...FOLLOWUP_TABLES)
      .first()
    const ok = Number(r?.n) === FOLLOWUP_TABLES.length
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}

export const DEFAULTS = { acknowledge: true, aiReplies: true, nudges: 2, afterVisit: false, quietStart: 21, quietEnd: 8 }

export async function getSettings(db, customer) {
  const r = await db.prepare('SELECT * FROM followup_settings WHERE customer = ?1').bind(customer).first()
  if (!r) return { ...DEFAULTS }
  return { acknowledge: Boolean(r.acknowledge), aiReplies: Boolean(r.ai_replies), nudges: r.nudges, afterVisit: Boolean(r.after_visit), quietStart: r.quiet_start, quietEnd: r.quiet_end }
}

// Validates the owner's preferences; returns [error, value].
export function validateSettings(input) {
  const b = (v, d) => (v === undefined ? d : v === true || v === false ? v : null)
  const h = (v, d) => (v === undefined ? d : Number.isInteger(v) && v >= 0 && v <= 23 ? v : null)
  const s = {
    acknowledge: b(input?.acknowledge, DEFAULTS.acknowledge),
    aiReplies: b(input?.aiReplies, DEFAULTS.aiReplies),
    nudges: input?.nudges === undefined ? DEFAULTS.nudges : [0, 1, 2].includes(input.nudges) ? input.nudges : null,
    afterVisit: b(input?.afterVisit, DEFAULTS.afterVisit),
    quietStart: h(input?.quietStart, DEFAULTS.quietStart),
    quietEnd: h(input?.quietEnd, DEFAULTS.quietEnd),
  }
  const bad = Object.entries(s).filter(([, v]) => v === null).map(([k]) => k)
  if (bad.length) return ['invalid_settings', null]
  // Quiet hours must cover the night (at least 8 hours, carriers' and customers' expectations).
  const span = (s.quietEnd - s.quietStart + 24) % 24
  if (span < 8) return ['quiet_hours_too_short', null]
  return [null, s]
}

export async function saveSettings(db, customer, s, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO followup_settings (customer, acknowledge, ai_replies, nudges, after_visit, quiet_start, quiet_end, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(customer) DO UPDATE SET acknowledge = ?2, ai_replies = ?3, nudges = ?4, after_visit = ?5, quiet_start = ?6, quiet_end = ?7, updated_at = ?8`,
    )
    .bind(customer, s.acknowledge ? 1 : 0, s.aiReplies ? 1 : 0, s.nudges, s.afterVisit ? 1 : 0, s.quietStart, s.quietEnd, now)
    .run()
}

// Hour of day in the business's time zone.
export function localHour(now, timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)))
  } catch {
    return new Date(now).getUTCHours()
  }
}
export const inQuietHours = (now, timeZone, s) => {
  const h = localHour(now, timeZone)
  return s.quietStart > s.quietEnd ? h >= s.quietStart || h < s.quietEnd : h >= s.quietStart && h < s.quietEnd
}
// Next moment automatic texts may go out again (the end of quiet hours), on the hour.
export function quietEndsAt(now, timeZone, s) {
  let t = now
  for (let i = 0; i < 24 && inQuietHours(t, timeZone, s); i++) t = (Math.floor(t / 3_600_000) + 1) * 3_600_000
  return t
}

// The registration row plus the business's own Twilio subaccount (account_sid / account_status; migration 0025).
export async function registrationOf(db, customer) {
  const r = (await accountsReady(db))
    ? await db
        .prepare('SELECT r.*, a.account_sid AS account_sid, a.status AS account_status FROM sms_registrations r LEFT JOIN sms_accounts a ON a.customer = r.customer WHERE r.customer = ?1')
        .bind(customer)
        .first()
    : await db.prepare('SELECT * FROM sms_registrations WHERE customer = ?1').bind(customer).first()
  return r || null
}

// Can this business text? { ok, reasons[], sender } — reasons are allowlisted codes the dashboard explains.
// `reg`: its sms_registrations row (or null).
export function smsReadiness(env, reg) {
  const reasons = []
  if (killSwitch(env)) reasons.push('paused_by_platform')
  if (!smsConfigured(env)) reasons.push('provider_not_configured')
  // Every business texts from its OWN Twilio subaccount (never the parent account or another business's).
  if (!reg?.account_sid || reg?.account_status !== 'active') reasons.push('no_account')
  if (!reg?.messaging_service && !reg?.sender_phone) reasons.push('no_sender')
  if (reg?.status !== 'approved') reasons.push(`registration_${reg?.status || 'not_configured'}`)
  return { ok: reasons.length === 0, reasons, sender: reg ? { messagingService: reg.messaging_service || null, from: reg.sender_phone || null, accountSid: reg.account_sid || null } : null }
}

// May the texting box be OFFERED (and consent recorded)? Carriers review the live opt-in BEFORE they approve a
// registration, so the box can't wait for approval. It opens once the owner has explicitly approved submission of the
// registration (details + attestation) and stays open while the provider reviews it and after approval. It closes for
// a rejected or suspended registration and with the kill switch. Collecting consent sends nothing: texts still need
// smsReadiness() above (provider approval + the business's own sender + SMS_LIVE for real recipients).
export const CONSENT_STATUSES = ['ready', 'pending', 'approved']
export function smsConsentOpen(env, reg) {
  return !killSwitch(env) && Boolean(reg?.approved_at) && CONSENT_STATUSES.includes(reg?.status)
}
export async function smsConsentOpenFor(env, customerId) {
  if (!CUSTOMER_RE.test(customerId || '') || !(await followupsReady(env.ONBOARDING_DB))) return false
  try {
    return smsConsentOpen(env, await registrationOf(env.ONBOARDING_DB, customerId))
  } catch {
    return false
  }
}

// The ONE rule for showing the texting box (booking page, website forms) and for accepting consent from them.
export async function offerSmsFor(env, customer) {
  return Boolean(customer?.automations) && (await smsConsentOpenFor(env, customer?.id))
}

export async function smsReadyFor(env, customerId) {
  if (!CUSTOMER_RE.test(customerId || '') || !(await followupsReady(env.ONBOARDING_DB))) return { ok: false, reasons: ['setup_pending'], sender: null }
  try {
    return smsReadiness(env, await registrationOf(env.ONBOARDING_DB, customerId))
  } catch {
    return { ok: false, reasons: ['storage_error'], sender: null }
  }
}
