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
import { emailConfigured, messagesLive, recipientAllowed, sendEmail } from './email.js'
import { sandboxed, statusIn, testStatuses } from './testbusiness.js'
import { sendSms, smsConfigured } from './sms.js'
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

// New qualified lead: two "pick a time" follow-ups, skipped automatically once they book.
export function scheduleLeadMessages(env, customer, lead, now = Date.now()) {
  if (!customer.automations || !lead.qualified) return 0
  return safely('schedule lead', () =>
    insert(
      env,
      ['lead_followup_1', 'lead_followup_2'].flatMap((kind) =>
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
    case 'lead_followup_1':
    case 'lead_followup_2':
      return m.lead_status === 'new' ? null : 'not_needed'
    case 'confirmation':
    case 'reminder_24h':
    case 'reminder_2h':
      return m.appt_status === 'booked' && m.start_at > now ? null : 'not_needed'
    case 'no_show_rebook':
      return m.appt_status === 'no_show' && m.lead_status === 'new' ? null : 'not_needed'
    default:
      return 'unknown_kind'
  }
}

const firstName = (name) => String(name).trim().split(/\s+/)[0]
const whenText = (ts, timeZone, opts) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(ts))
const longWhen = (ts, tz) => whenText(ts, tz, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const timeOnly = (ts, tz) => whenText(ts, tz, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const shortNeed = (need) => (need.length > 60 ? `${need.slice(0, 57)}…` : need)

// Returns { subject, text, sms } for one message row (joined with its business, lead, appointment).
// 'at_customer' businesses visit the lead, so their messages talk about a visit to the service
// address and ask the lead to confirm access, not to "be there".
export async function render(env, m) {
  const biz = m.biz
  const hi = `Hi ${firstName(m.lead_name)},`
  const footer = `\n\n— ${biz}\n\nSent by GetShowUps for ${biz} because you requested an appointment on their booking page. Reply to this email to reach ${biz}.`
  const confirmed = Boolean(m.confirmed_at)
  const visit = m.appointment_mode === 'at_customer'
  const place = m.street ? ` at ${m.street}` : ''
  switch (m.kind) {
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
          text: `${hi}\n\n${biz} is scheduled to visit${place} on ${when}.\n\nPlease confirm the time works and that ${biz} can access the property:\n${url}\n\nNeed to change the time? Reply to this email.${footer}`,
          sms: `${biz}: visit booked${place} for ${when}. Confirm access: ${url} Reply STOP to opt out.`,
        }
      }
      return {
        subject: `You're booked with ${biz}: ${whenText(m.start_at, m.timezone, { weekday: 'short', month: 'short', day: 'numeric' })}`,
        text: `${hi}\n\nYou're booked with ${biz} on ${when}.\n\nPlease confirm you'll be there:\n${url}\n\nNeed to change the time? Reply to this email.${footer}`,
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
          text: `${hi}\n\nA reminder that ${biz} is scheduled to visit${place} ${when}.\n\n${access}\n\nNeed to change the time? Reply to this email.${footer}`,
          sms: `${biz}: reminder of your visit${place} ${when}.${confirmed ? '' : ` Confirm access: ${url}`} Reply STOP to opt out.`,
        }
      }
      const ask = confirmed ? 'See you then!' : `Please confirm you'll be there:\n${url}`
      return {
        subject: `Reminder: ${biz} ${soon ? 'today' : 'tomorrow'} at ${timeOnly(m.start_at, m.timezone)}`,
        text: `${hi}\n\nA reminder of your appointment with ${biz} ${when}.\n\n${ask}\n\nNeed to change the time? Reply to this email.${footer}`,
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

const DUE_SQL = `
  SELECT m.*, c.name AS biz, c.timezone, c.status AS cstatus,
         (SELECT ss.appointment_mode FROM service_settings ss WHERE ss.customer = m.customer) AS appointment_mode,
         (SELECT la.street FROM lead_addresses la WHERE la.lead_id = m.lead_id AND la.customer = m.customer) AS street,
         coalesce((SELECT cs.automations FROM customer_settings cs WHERE cs.customer = m.customer), 1) AS automations,
         l.name AS lead_name, l.email AS lead_email, l.phone AS lead_phone, l.need, l.status AS lead_status,
         (SELECT 1 FROM sms_consents sc WHERE sc.lead_id = m.lead_id AND sc.customer = m.customer) AS sms_consent,
         a.start_at, a.status AS appt_status,
         (SELECT ac.confirmed_at FROM appointment_confirmations ac WHERE ac.appointment_id = m.appointment_id) AS confirmed_at,
         (SELECT min(u.email) FROM customer_users u WHERE u.customer = m.customer) AS owner
    FROM messages m
    JOIN customers c ON c.id = m.customer
    JOIN leads l ON l.id = m.lead_id AND l.customer = m.customer
    LEFT JOIN appointments a ON a.id = m.appointment_id AND a.customer = m.customer
   WHERE m.status = 'scheduled' AND m.send_at <= ?1
   ORDER BY m.send_at LIMIT ?2`

// Sends due messages. Safe to run concurrently (each row is claimed atomically before sending).
export async function processDueMessages(env, now = Date.now(), limit = 20) {
  const db = env.ONBOARDING_DB
  const out = { sent: 0, failed: 0, skipped: 0, retry: 0 }
  // A run that died mid-send: the outcome is unknown, so never resend (avoids duplicate texts).
  await db
    .prepare("UPDATE messages SET status = 'failed', error = 'interrupted', updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2")
    .bind(now, now - STUCK_SENDING_MS)
    .run()
  const { results } = await db.prepare(DUE_SQL).bind(now, limit).all()
  const configured = { email: emailConfigured(env), sms: smsConfigured(env) }
  const ghlSms = new Map() // one owner per channel: a business texting through GoHighLevel gets no texts from us
  const textsViaGhl = async (customer) => {
    if (!ghlSms.has(customer)) ghlSms.set(customer, await smsHandledByGhl(env, customer).catch(() => false))
    return ghlSms.get(customer)
  }
  const tests = results.length ? await testStatuses(env) : new Map()
  for (const m of results) {
    // A test business (or a message scheduled while it was one) only ever reaches test recipients.
    const testOnly = sandboxed(statusIn(tests, m.customer), m.created_at)
    const reason =
      skipReason(m, now) ??
      (m.channel === 'sms' && (await textsViaGhl(m.customer)) ? 'ghl_sms' : null) ??
      (configured[m.channel] ? null : 'no_provider') ??
      (recipientAllowed(env, m.channel === 'email' ? m.lead_email : m.lead_phone, { testOnly }) ? null : 'test_mode')
    if (reason) {
      await db.prepare("UPDATE messages SET status = 'skipped', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'scheduled'").bind(m.id, reason, now).run()
      out.skipped++
      continue
    }
    const claimed = await db
      .prepare("UPDATE messages SET status = 'sending', updated_at = ?2 WHERE id = ?1 AND status = 'scheduled' RETURNING id")
      .bind(m.id, now)
      .first()
    if (!claimed) continue

    let result
    try {
      const content = await render(env, m)
      result =
        m.channel === 'email'
          ? await sendEmail(env, { id: `msg:${m.id}`, to: m.lead_email, subject: content.subject, text: content.text, fromName: `${m.biz} via GetShowUps`, replyTo: m.owner, testOnly })
          : await sendSms(env, { to: m.lead_phone, text: content.sms, testOnly })
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
      out.sent++
    } else if (result.permanent || attempts >= MAX_ATTEMPTS) {
      console.error('messages: send failed:', m.kind, m.channel, result.error)
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
