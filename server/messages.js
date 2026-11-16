// Automatic messages to a business's leads: follow-ups for leads who haven't booked, booking
// confirmation, reminders, and a rebooking message after a no-show.
//
// Messages are scheduled as rows in `messages` and sent by processDueMessages(), which the scheduler
// Worker calls every few minutes through POST /api/cron/run. Content is rendered at send time from the
// current records, and every message re-checks that it is still relevant, so a booking, a cancelled
// appointment, or a corrected outcome silently retires messages that no longer apply.
//
// Honesty rules: a message is 'sent' only when the provider accepted it. Without a configured
// provider a due message is marked skipped/no_provider (never sent later in a burst); before launch
// (MESSAGES_LIVE unset) messages to non-test recipients are skipped as test_mode.
import { policiesOrEmpty } from './policies.js'
import { isSuppressed } from './email-feedback.js'
import { emailConfigured, messagesLive, recipientAllowed, sendEmail } from './email.js'
import { FOLLOW_UP_KINDS, isOptedOut, recordOptOut, unsubscribeUrl } from './optouts.js'
import { sandboxed, statusIn, testStatuses } from './testbusiness.js'
import { smsConfigured } from './sms.js'
import { sendTwilio } from './followups/transport.js'
import { recordAutomatic } from './followups/engine.js'
import { followupsReady, getSettings, DEFAULTS, killSwitch, smsLive, smsReadyFor, inQuietHours, quietEndsAt } from './followups/settings.js'
import { smsHandledByGhl } from './ghl.js'
import { confirmUrl, resumeUrl } from './links.js'
import { track } from './events.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN

// When each kind is due and how late it may still go out.
export const TIMING = {
  lead_followup_1: { after: 15 * MIN, maxLate: 6 * HOUR },
  lead_followup_2: { after: 24 * HOUR, maxLate: 12 * HOUR },
  confirmation: { after: 0, maxLate: 2 * HOUR },
  reminder_24h: { before: 24 * HOUR, maxLate: 6 * HOUR, minLead: 2 * HOUR },
  reminder_2h: { before: 2 * HOUR, maxLate: 1 * HOUR, minLead: 30 * MIN },
  no_show_rebook: { after: 30 * MIN, maxLate: 24 * HOUR }, // delay lets the owner fix a mis-click
  lead_ack: { after: 0, maxLate: 2 * HOUR }, //               website-form leads: an answer right away
  interested_followup: { after: 24 * HOUR, maxLate: 12 * HOUR }, // replied but didn't book: one nudge a day later
  after_visit: { after: 3 * HOUR, maxLate: 24 * HOUR }, //      optional thank-you after a completed visit
}
const MAX_ATTEMPTS = 3
const STUCK_SENDING_MS = 10 * MIN

const channelsFor = (smsConsent) => ['email', ...(smsConsent ? ['sms'] : [])]

async function insert(env, rows, now) {
  const db = env.ONBOARDING_DB
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, customer, lead_id, appointment_id, kind, channel, send_at, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'scheduled', ?8, ?8)`,
      )
      .bind(r.id, r.customer, r.leadId, r.appointmentId ?? null, r.kind, r.channel, r.sendAt, now),
  )
  if (stmts.length) await db.batch(stmts)
  return stmts.length
}

// Never lets a scheduling problem break the lead/booking that triggered it.
async function safely(label, fn) {
  try {
    return await fn()
  } catch (err) {
    console.error(`messages: ${label} failed:`, err?.message)
    return 0
  }
}

// Owner preferences (defaults until migration 0024 is applied or the owner changes them).
async function prefs(env, customer) {
  try {
    return (await followupsReady(env.ONBOARDING_DB)) ? await getSettings(env.ONBOARDING_DB, customer) : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

// New qualified lead. Website-form leads get an answer right away (acknowledge), booking-page leads (mid-booking) a
// first nudge after 15 minutes; then a second nudge a day later. All skipped automatically once they book.
export async function scheduleLeadMessages(env, customer, lead, now = Date.now()) {
  if (!customer.automations || !lead.qualified) return 0
  const p = await prefs(env, customer.id)
  // Before migration 0024 (no preferences, no conversations) every lead keeps the previous schedule.
  const form = lead.source === 'website_form' && (await followupsReady(env.ONBOARDING_DB))
  const kinds = [...(form ? (p.acknowledge ? ['lead_ack'] : []) : p.nudges >= 1 ? ['lead_followup_1'] : []), ...(p.nudges >= 2 || (form && p.nudges >= 1) ? ['lead_followup_2'] : [])]
  return safely('schedule lead', () =>
    insert(
      env,
      kinds.flatMap((kind) =>
        channelsFor(lead.smsConsent).map((channel) => ({
          id: `${kind}:${channel}:${lead.id}`,
          customer: customer.id,
          leadId: lead.id,
          kind,
          channel,
          sendAt: now + TIMING[kind].after,
        })),
      ),
      now,
    ),
  )
}

// Booked appointment: confirmation now, reminders 24 h and 2 h before (when there is time for them).
export function scheduleAppointmentMessages(env, customer, appt, now = Date.now()) {
  if (!customer.automations) return 0
  const rows = []
  for (const channel of channelsFor(appt.smsConsent)) {
    const base = { customer: customer.id, leadId: appt.leadId, appointmentId: appt.id, channel }
    rows.push({ ...base, id: `confirmation:${channel}:${appt.id}`, kind: 'confirmation', sendAt: now })
    for (const kind of ['reminder_24h', 'reminder_2h']) {
      const sendAt = appt.start - TIMING[kind].before
      if (sendAt - now >= TIMING[kind].minLead) rows.push({ ...base, id: `${kind}:${channel}:${appt.id}`, kind, sendAt })
    }
  }
  return safely('schedule appointment', () => insert(env, rows, now))
}

// Completed visit: an optional thank-you with the link to book again (owner preference, off by default).
export async function scheduleAfterVisitMessage(env, customer, appt, now = Date.now()) {
  if (!customer.automations || !(await prefs(env, customer.id)).afterVisit) return 0
  return safely('schedule after visit', () =>
    insert(env, channelsFor(appt.smsConsent).map((channel) => ({ id: `after_visit:${channel}:${appt.id}`, customer: customer.id, leadId: appt.leadId, appointmentId: appt.id, kind: 'after_visit', channel, sendAt: now + TIMING.after_visit.after })), now),
  )
}

// Marked as a no-show: invite them to pick a new time.
export function scheduleNoShowMessage(env, customer, appt, now = Date.now()) {
  if (!customer.automations) return 0
  return safely('schedule no-show', () =>
    insert(
      env,
      channelsFor(appt.smsConsent).map((channel) => ({
        id: `no_show_rebook:${channel}:${appt.id}`,
        customer: customer.id,
        leadId: appt.leadId,
        appointmentId: appt.id,
        kind: 'no_show_rebook',
        channel,
        sendAt: now + TIMING.no_show_rebook.after,
      })),
      now,
    ),
  )
}

// ---------- sending ----------

// Why a due message should not go out, or null to send it.
export function skipReason(m, now) {
  if (m.cstatus !== 'active' || !m.automations) return 'disabled'
  if (m.channel === 'sms' && !m.sms_consent) return 'no_consent'
  if (now - m.send_at > TIMING[m.kind].maxLate) return 'expired'
  switch (m.kind) {
    case 'lead_ack':
    case 'lead_followup_1':
    case 'lead_followup_2':
    case 'interested_followup':
      if (m.taken_over) return 'human_takeover'
      if (m.thread_stage === 'closed' || m.thread_stage === 'opted_out') return 'not_needed'
      return m.lead_status === 'new' ? null : 'not_needed'
    case 'after_visit':
      return m.appt_status === 'showed' ? null : 'not_needed'
    case 'confirmation':
    case 'reminder_24h':
    case 'reminder_2h':
      if (m.cancel_incomplete) return 'cancel_incomplete'
      return m.appt_status === 'booked' && m.start_at > now ? null : 'not_needed'
    case 'no_show_rebook':
      return m.appt_status === 'no_show' && m.lead_status === 'new' ? null : 'not_needed'
    default:
      return 'unknown_kind'
  }
}

const policyNotes = (p) =>
  `${p.beforeVisit ? `\n\nBefore your appointment: ${p.beforeVisit}` : ''}${p.cancellation ? `\n\nCancellations: ${p.cancellation}` : ''}`
const firstName = (name) => String(name).trim().split(/\s+/)[0]
const whenText = (ts, timeZone, opts) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(ts))
export const longWhen = (ts, tz) => whenText(ts, tz, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const timeOnly = (ts, tz) => whenText(ts, tz, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
export const shortNeed = (need) => (need.length > 60 ? `${need.slice(0, 57)}…` : need)

// Returns { subject, text, sms } for one message row (joined with its business, lead, appointment).
// 'at_customer' businesses visit the lead, so their messages talk about a visit to the service
// address and ask the lead to confirm access, not to "be there".
export async function render(env, m) {
  const biz = m.biz
  const hi = `Hi ${firstName(m.lead_name)},`
  // Follow-ups (not confirmations/reminders) carry a one-click unsubscribe link for this business.
  const unsub = FOLLOW_UP_KINDS.includes(m.kind) ? `\n\nNo more follow-up emails from ${biz}: ${await unsubscribeUrl(env, m.lead_id)}` : ''
  const footer = `\n\n— ${biz}\n\nSent by GetShowUps for ${biz} because you contacted ${biz}. Reply to this email to reach ${biz}.${unsub}`
  const confirmed = Boolean(m.confirmed_at)
  // What customers should know (owner-written): in the confirmation and the day-before reminder only.
  const notes = ['confirmation', 'reminder_24h'].includes(m.kind) ? policyNotes(await policiesOrEmpty(env.ONBOARDING_DB, m.customer)) : ''
  const visit = m.appointment_mode === 'at_customer'
  const place = m.street ? ` at ${m.street}` : ''
  switch (m.kind) {
    case 'lead_ack': {
      const url = await resumeUrl(env, m.customer, m.lead_id)
      return {
        subject: `${biz} got your message`,
        text: `${hi}\n\nThanks for contacting ${biz} about "${shortNeed(m.need)}". We'll be in touch soon. If you'd like to book now, pick a time that works for you:\n${url}${footer}`,
        sms: `${biz}: ${hi} thanks for your message about "${shortNeed(m.need)}". We'll be in touch soon, or pick a time: ${url} Reply STOP to opt out.`,
      }
    }
    case 'interested_followup': {
      const url = await resumeUrl(env, m.customer, m.lead_id)
      return {
        subject: `Ready to pick a time with ${biz}?`,
        text: `${hi}\n\nWhenever you're ready, you can pick a time with ${biz} here:\n${url}${footer}`,
        sms: `${biz}: whenever you're ready, pick a time here: ${url} Reply STOP to opt out.`,
      }
    }
    case 'after_visit': {
      const url = await resumeUrl(env, m.customer, m.lead_id)
      return {
        subject: `Thanks from ${biz}`,
        text: `${hi}\n\nThanks for choosing ${biz}. If you need us again, you can pick a time here:\n${url}${footer}`,
        sms: `${biz}: thanks for choosing us! Need us again? Pick a time: ${url} Reply STOP to opt out.`,
      }
    }
    case 'lead_followup_1':
    case 'lead_followup_2': {
      const url = await resumeUrl(env, m.customer, m.lead_id)
      const first = m.kind === 'lead_followup_1'
      return {
        subject: first ? `Pick a time with ${biz}` : `Still need help with ${shortNeed(m.need)}?`,
        text: `${hi}\n\n${first ? `Thanks for reaching out to ${biz} about "${shortNeed(m.need)}".` : `${biz} still has your request for "${shortNeed(m.need)}".`} Pick a time that works for you here:\n${url}${footer}`,
        sms: `${biz}: ${hi} ${first ? 'thanks for your request.' : 'still need help?'} Pick a time here: ${url} Reply STOP to opt out.`,
      }
    }
    case 'confirmation': {
      const url = await confirmUrl(env, m.appointment_id)
      const when = longWhen(m.start_at, m.timezone)
      if (visit) {
        return {
          subject: `${biz} visit booked: ${whenText(m.start_at, m.timezone, { weekday: 'short', month: 'short', day: 'numeric' })}`,
          text: `${hi}\n\n${biz} is scheduled to visit${place} on ${when}.\n\nPlease confirm the time works and that ${biz} can access the property:\n${url}\n\nCan’t make it? Cancel or pick a new time:\n${url}&do=cancel${notes}${footer}`,
          sms: `${biz}: visit booked${place} for ${when}. Confirm access: ${url} Reply STOP to opt out.`,
        }
      }
      return {
        subject: `You're booked with ${biz}: ${whenText(m.start_at, m.timezone, { weekday: 'short', month: 'short', day: 'numeric' })}`,
        text: `${hi}\n\nYou're booked with ${biz} on ${when}.\n\nPlease confirm you'll be there:\n${url}\n\nCan’t make it? Cancel or pick a new time:\n${url}&do=cancel${notes}${footer}`,
        sms: `${biz}: you're booked for ${when}. Confirm you'll be there: ${url} Reply STOP to opt out.`,
      }
    }
    case 'reminder_24h':
    case 'reminder_2h': {
      const url = await confirmUrl(env, m.appointment_id)
      const soon = m.kind === 'reminder_2h'
      const when = soon ? `today at ${timeOnly(m.start_at, m.timezone)}` : longWhen(m.start_at, m.timezone)
      if (visit) {
        const access = confirmed ? 'Thanks for confirming.' : `Please confirm ${biz} can access the property:\n${url}`
        return {
          subject: `Reminder: ${biz} visit ${soon ? 'today' : 'tomorrow'} at ${timeOnly(m.start_at, m.timezone)}`,
          text: `${hi}\n\nA reminder that ${biz} is scheduled to visit${place} ${when}.\n\n${access}\n\nCan’t make it? Cancel or pick a new time:\n${url}&do=cancel${notes}${footer}`,
          sms: `${biz}: reminder of your visit${place} ${when}.${confirmed ? '' : ` Confirm access: ${url}`} Reply STOP to opt out.`,
        }
      }
      const ask = confirmed ? 'See you then!' : `Please confirm you'll be there:\n${url}`
      return {
        subject: `Reminder: ${biz} ${soon ? 'today' : 'tomorrow'} at ${timeOnly(m.start_at, m.timezone)}`,
        text: `${hi}\n\nA reminder of your appointment with ${biz} ${when}.\n\n${ask}\n\nCan’t make it? Cancel or pick a new time:\n${url}&do=cancel${notes}${footer}`,
        sms: `${biz}: reminder of your appointment ${when}.${confirmed ? '' : ` Confirm: ${url}`} Reply STOP to opt out.`,
      }
    }
    case 'no_show_rebook': {
      const url = await resumeUrl(env, m.customer, m.lead_id)
      if (visit) {
        return {
          subject: `Your ${biz} visit didn't happen: pick a new time`,
          text: `${hi}\n\n${biz} wasn't able to complete your scheduled visit${place}. If you still need help, pick a new time here:\n${url}${footer}`,
          sms: `${biz}: we couldn't complete your scheduled visit. Pick a new time: ${url} Reply STOP to opt out.`,
        }
      }
      return {
        subject: `Sorry we missed you: pick a new time with ${biz}`,
        text: `${hi}\n\nIt looks like we missed each other for your appointment with ${biz}. If you still need help, pick a new time here:\n${url}${footer}`,
        sms: `${biz}: sorry we missed you. Pick a new time here: ${url} Reply STOP to opt out.`,
      }
    }
  }
  throw new Error('unknown kind')
}

const DUE_SQL = (threads) => `
  SELECT m.*, c.name AS biz,${threads ? `
         (SELECT 1 FROM conversation_control cc WHERE cc.customer = m.customer AND cc.conversation_id = m.lead_id AND cc.controller = 'human') AS taken_over,
         (SELECT lt.stage FROM lead_threads lt WHERE lt.lead_id = m.lead_id AND lt.customer = m.customer) AS thread_stage,` : ''} c.timezone, c.status AS cstatus,
         (SELECT ss.appointment_mode FROM service_settings ss WHERE ss.customer = m.customer) AS appointment_mode,
         (SELECT la.street FROM lead_addresses la WHERE la.lead_id = m.lead_id AND la.customer = m.customer) AS street,
         coalesce((SELECT cs.automations FROM customer_settings cs WHERE cs.customer = m.customer), 1) AS automations,
         l.name AS lead_name, l.email AS lead_email, l.phone AS lead_phone, l.need, l.status AS lead_status,
         (SELECT 1 FROM sms_consents sc WHERE sc.lead_id = m.lead_id AND sc.customer = m.customer) AS sms_consent,
         a.start_at, a.status AS appt_status,
         (SELECT ac.confirmed_at FROM appointment_confirmations ac WHERE ac.appointment_id = m.appointment_id) AS confirmed_at,
         (SELECT min(u.email) FROM customer_users u WHERE u.customer = m.customer) AS owner,
         -- A cancellation that removed the Google event but couldn't be saved (cancel_incomplete): the booking still
         -- reads 'booked', but the event is gone, so no confirmation/reminder may go out for it. A later successful
         -- cancel sets status 'cancelled', which retires these messages anyway.
         (SELECT 1 FROM audit_log al WHERE al.customer = m.customer AND al.action = 'booking.cancel' AND al.outcome = 'failure'
             AND al.resource_type = 'appointment' AND al.resource_id = m.appointment_id AND al.details LIKE '%"cancel_incomplete"%' LIMIT 1) AS cancel_incomplete
    FROM messages m
    JOIN customers c ON c.id = m.customer
    JOIN leads l ON l.id = m.lead_id AND l.customer = m.customer
    LEFT JOIN appointments a ON a.id = m.appointment_id AND a.customer = m.customer
   WHERE m.status = 'scheduled' AND m.send_at <= ?1
   ORDER BY m.send_at LIMIT ?2`

// Sends due messages. Safe to run concurrently (each row is claimed atomically before sending).
// Fails closed: a follow-up whose opt-out status cannot be read is skipped, never sent unchecked.
const optOutReason = (state) => (state === false ? null : state === null ? 'optout_unknown' : 'opted_out')

export async function processDueMessages(env, now = Date.now(), limit = 20) {
  const db = env.ONBOARDING_DB
  const out = { sent: 0, failed: 0, skipped: 0, retry: 0 }
  // A run that died mid-send: the outcome is unknown, so never resend (avoids duplicate texts).
  await db
    .prepare("UPDATE messages SET status = 'failed', error = 'interrupted', updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2")
    .bind(now, now - STUCK_SENDING_MS)
    .run()
  const threads = await followupsReady(db)
  const { results } = await db.prepare(DUE_SQL(threads)).bind(now, limit).all()
  const configured = { email: emailConfigured(env), sms: smsConfigured(env) }
  // Texts only from a business whose own sender is set up and whose US texting registration was approved.
  const smsReady = new Map()
  const readyFor = async (customer) => {
    if (!smsReady.has(customer)) smsReady.set(customer, await smsReadyFor(env, customer))
    return smsReady.get(customer)
  }
  const quiet = async (m) => {
    if (!threads || !['lead_ack', 'lead_followup_1', 'lead_followup_2', 'interested_followup', 'no_show_rebook', 'after_visit', 'reminder_24h'].includes(m.kind)) return null
    const p = await getSettings(db, m.customer).catch(() => DEFAULTS)
    return inQuietHours(now, m.timezone, p) ? quietEndsAt(now, m.timezone, p) : null
  }
  const ghlSms = new Map() // one owner per channel: a business texting through GoHighLevel gets no texts from us
  const textsViaGhl = async (customer) => {
    if (!ghlSms.has(customer)) ghlSms.set(customer, await smsHandledByGhl(env, customer).catch(() => false))
    return ghlSms.get(customer)
  }
  const tests = results.length ? await testStatuses(env) : new Map()
  for (const m of results) {
    // A test business (or a message scheduled while it was one) only ever reaches test recipients.
    const testOnly = sandboxed(statusIn(tests, m.customer), m.created_at) || (m.channel === 'sms' && !smsLive(env))
    const reason =
      (killSwitch(env) ? 'paused_by_platform' : null) ??
      skipReason(m, now) ??
      (m.channel === 'sms' && (await textsViaGhl(m.customer)) ? 'ghl_sms' : null) ??
      (configured[m.channel] ? null : 'no_provider') ??
      (m.channel === 'sms' && !(await readyFor(m.customer)).ok ? 'sms_not_ready' : null) ??
      (recipientAllowed(env, m.channel === 'email' ? m.lead_email : m.lead_phone, { testOnly }) ? null : 'test_mode') ??
      (FOLLOW_UP_KINDS.includes(m.kind) ? optOutReason(await isOptedOut(env, m.customer, m.channel, m.channel === 'email' ? m.lead_email : m.lead_phone)) : null) ??
      // Known bad address (permanent bounce / spam complaint, from Resend's signed feedback): never sent again.
      (m.channel === 'email' && (await isSuppressed(env, m.customer, m.lead_email)) ? 'suppressed' : null)
    if (reason) {
      await db.prepare("UPDATE messages SET status = 'skipped', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'scheduled'").bind(m.id, reason, now).run()
      out.skipped++
      continue
    }
    // Quiet hours (texts): a text that would go out now waits until morning instead (relevance is re-checked then).
    // Checked last, so a text that can't be sent at all (GHL owns texting, not ready, opted out, …) is skipped, not
    // postponed night after night.
    if (m.channel === 'sms') {
      const until = await quiet(m)
      if (until) {
        await db.prepare("UPDATE messages SET send_at = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'scheduled'").bind(m.id, until, now).run()
        continue
      }
    }
    const claimed = await db
      .prepare("UPDATE messages SET status = 'sending', updated_at = ?2 WHERE id = ?1 AND status = 'scheduled' RETURNING id")
      .bind(m.id, now)
      .first()
    if (!claimed) continue

    let result
    let lastContent = null
    try {
      const content = await render(env, m)
      lastContent = content
      result =
        m.channel === 'email'
          ? await sendEmail(env, {
            id: `msg:${m.id}`, to: m.lead_email, subject: content.subject, text: content.text, fromName: `${m.biz} via GetShowUps`, replyTo: m.owner, testOnly,
            // Follow-ups: one-click unsubscribe headers (RFC 8058) with the same signed link as the footer.
            unsubscribeUrl: FOLLOW_UP_KINDS.includes(m.kind) ? await unsubscribeUrl(env, m.lead_id) : null,
          })
          : await sendTwilio(env, { to: m.lead_phone, text: content.sms, sender: (await readyFor(m.customer)).sender })
    } catch (err) {
      console.error('messages: render/send error:', m.kind, err?.name)
      result = { ok: false, error: 'internal_error' }
    }

    const attempts = m.attempts + 1
    if (result.ok) {
      await db
        .prepare("UPDATE messages SET status = 'sent', attempts = ?2, provider_id = ?3, error = NULL, updated_at = ?4 WHERE id = ?1")
        .bind(m.id, attempts, result.providerId ?? null, now)
        .run()
      await track(env, 'message_sent', { id: `message_sent:${m.id}`, customer: m.customer, props: { kind: m.kind, channel: m.channel }, at: now })
      // The same text appears in the owner's conversation view.
      if (threads) await recordAutomatic(env, { id: m.id, customer: m.customer, leadId: m.lead_id, channel: m.channel, body: m.channel === 'sms' ? lastContent.sms : `${lastContent.subject}\n\n${lastContent.text}`, providerId: result.providerId }, now)
      out.sent++
    } else if (result.permanent || attempts >= MAX_ATTEMPTS) {
      console.error('messages: send failed:', m.kind, m.channel, result.error)
      // The carrier reports this number replied STOP: record it so no further follow-up texts are attempted.
      if (m.channel === 'sms' && result.error === 'twilio_21610') await recordOptOut(env, m.customer, 'sms', m.lead_phone, 'carrier_stop', now).catch(() => {})
      await db.prepare("UPDATE messages SET status = 'failed', attempts = ?2, error = ?3, updated_at = ?4 WHERE id = ?1").bind(m.id, attempts, result.error, now).run()
      out.failed++
    } else {
      await db
        .prepare("UPDATE messages SET status = 'scheduled', attempts = ?2, error = ?3, send_at = ?4, updated_at = ?4 WHERE id = ?1")
        .bind(m.id, attempts, result.error, now + attempts * 5 * MIN)
        .run()
      out.retry++
    }
  }
  return out
}

// Dashboard summary for one business (last 30 days). Counts only, no message content.
export async function messageSummary(env, customer, now = Date.now()) {
  const row = await env.ONBOARDING_DB.prepare(
    `SELECT
       sum(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
       sum(CASE WHEN status IN ('scheduled', 'sending') THEN 1 ELSE 0 END) AS scheduled,
       sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       sum(CASE WHEN status = 'skipped' AND error IN ('no_provider', 'test_mode') THEN 1 ELSE 0 END) AS not_sent
     FROM messages WHERE customer = ?1 AND created_at >= ?2`,
  )
    .bind(customer.id, now - 30 * 24 * HOUR)
    .first()
  return {
    enabled: customer.automations,
    email: emailConfigured(env),
    sms: smsConfigured(env),
    testMode: !messagesLive(env),
    sent: row?.sent ?? 0,
    scheduled: row?.scheduled ?? 0,
    failed: row?.failed ?? 0,
    notSent: row?.not_sent ?? 0,
  }
}
