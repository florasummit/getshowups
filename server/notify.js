// Owner notices: tells a business's members (customer_users) about a new booking, a customer's cancellation, and a
// qualified lead that hasn't booked within LEAD_GRACE_MS (so they can call while it's fresh). Run by the cron (/api/cron/run) as a scan,
// so booking paths are untouched and a missed run is caught up by the next one.
//   - Exactly once per item and member: outbox id owner_<kind>:<item>:<member hash> (INSERT OR IGNORE).
//   - Only recent items (WINDOW_MS): never a burst of stale notices (e.g. when messaging goes live).
//   - Launch gate: queued only if recipientAllowed() would deliver it now (test businesses → test recipients only),
//     so nothing waits in the outbox to be sent late.
//   - The lead's details are the owner's own data; the outbox body is cleared once sent (server/email.js).
import { enqueue, recipientAllowed } from './email.js'
import { sha256Hex } from './google-oauth.js'
import { longWhen, shortNeed } from './messages.js'
import { sandboxed, statusIn, testStatuses } from './testbusiness.js'
import { siteOrigin } from './auth.js'

const MIN = 60 * 1000
export const LEAD_GRACE_MS = 10 * MIN
export const WINDOW_MS = 2 * 60 * MIN
const LIMIT = 200
export const OWNER_TEMPLATES = ['owner_booking', 'owner_lead', 'owner_cancel', 'owner_bounce', 'owner_callback', 'owner_coverage']

const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)
// Still owed to at least one member (one held by the launch gate, or added since, is not skipped).
const notQueued = (kind, col, customerCol) =>
  `(SELECT count(*) FROM email_outbox o WHERE o.id >= '${kind}:' || ${col} || ':' AND o.id < '${kind}:' || ${col} || ';') < (SELECT count(*) FROM customer_users u WHERE u.customer = ${customerCol})`

const BOOKINGS_SQL = `
  SELECT a.id AS item, a.customer, a.created_at, a.start_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN customers c ON c.id = a.customer
  WHERE a.created_at > ?1 AND (?2 IS NULL OR a.id = ?2) AND a.status = 'booked' AND c.status = 'active' AND ${notQueued('owner_booking', 'a.id', 'a.customer')}
  ORDER BY a.created_at LIMIT ${LIMIT}`
const LEADS_SQL = `
  SELECT l.id AS item, l.customer, l.created_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM leads l JOIN customers c ON c.id = l.customer
  WHERE l.created_at > ?1 AND l.created_at <= ?2 AND l.status = 'new' AND c.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status <> 'cancelled')
    AND ${notQueued('owner_lead', 'l.id', 'l.customer')}
  ORDER BY l.created_at LIMIT ${LIMIT}`
// Customer cancellations (from the link in their messages); owner cancellations need no notice.
const CANCELS_SQL = `
  SELECT a.id AS item, a.customer, ch.changed_at AS created_at, a.start_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM appointment_changes ch JOIN appointments a ON a.id = ch.appointment_id JOIN leads l ON l.id = a.lead_id JOIN customers c ON c.id = a.customer
  WHERE ch.changed_at > ?1 AND ch.to_status = 'cancelled' AND ch.changed_by = 'customer' AND c.status = 'active'
    AND ${notQueued('owner_cancel', 'a.id', 'a.customer')}
  ORDER BY ch.changed_at LIMIT ${LIMIT}`
// A customer's address stopped accepting our email (server/email-feedback.js, migration 0020): permanent bounce or spam
// complaint. Driven by the suppression record, so both are covered; the owner should reach them another way.
const BOUNCES_SQL = `
  SELECT m.id AS item, m.customer, s.created_at, s.reason, m.kind AS message_kind, a.start_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM email_suppressions s JOIN messages m ON m.id = s.message_id AND m.customer = s.customer
  JOIN leads l ON l.id = m.lead_id AND l.customer = m.customer JOIN customers c ON c.id = m.customer
  LEFT JOIN appointments a ON a.id = m.appointment_id
  WHERE s.created_at > ?1 AND c.status = 'active'
    AND ${notQueued('owner_bounce', 'm.id', 'm.customer')}
  ORDER BY s.created_at LIMIT ${LIMIT}`
// AI receptionist callback requests / messages (migration 0027). The request itself is the durable record; this is the
// staff notification, tracked through email_outbox (owner_callback:<request>:<member>).
const CALLBACKS_SQL = `
  SELECT r.id AS item, r.customer, r.created_at, r.kind, r.name, r.phone, r.email, r.note, r.urgent, c.name AS biz, c.timezone
  FROM receptionist_requests r JOIN customers c ON c.id = r.customer
  WHERE r.created_at > ?1 AND r.status = 'open' AND r.held = 0 AND c.status = 'active' AND r.phone IS NOT NULL
    AND ${notQueued('owner_callback', 'r.id', 'r.customer')}
  ORDER BY r.created_at LIMIT ${LIMIT}`
// Service-area requests (migration 0029): a lead outside the listed ZIPs (or with a ZIP we couldn't verify) is kept and
// waits for the owner's decision. Told right away (no grace period: they can't book until the owner answers).
const COVERAGE_SQL = `
  SELECT l.id AS item, l.customer, r.created_at, r.zip, r.zip_check, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM coverage_requests r JOIN leads l ON l.id = r.lead_id AND l.customer = r.customer JOIN customers c ON c.id = r.customer
  WHERE r.created_at > ?1 AND r.status = 'pending' AND c.status = 'active'
    AND ${notQueued('owner_coverage', 'l.id', 'l.customer')}
  ORDER BY r.created_at LIMIT ${LIMIT}`
const WHAT = { confirmation: 'booking confirmation', reminder_24h: 'reminder', reminder_2h: 'reminder', lead_followup_1: 'follow-up', lead_followup_2: 'follow-up', no_show_rebook: 'rebooking email' }

export function ownerNotice(kind, r, origin) {
  const name = clean(r.name, 80)
  const contact = `Phone: ${clean(r.phone, 40)}\nEmail: ${clean(r.email, 120)}`
  if (kind === 'owner_booking') {
    const when = longWhen(r.start_at, r.timezone)
    return {
      subject: clean(`New booking: ${name}, ${when}`, 150),
      body: `${name} booked ${clean(r.biz, 80)} for ${when}.\n\nService: ${clean(shortNeed(r.need), 80)}\n${contact}\n\nIt's on your Google Calendar. All appointments: ${origin}/dashboard/appointments\n\n— GetShowUps`,
    }
  }
  if (kind === 'owner_bounce') {
    const appt = r.start_at ? ` (appointment ${longWhen(r.start_at, r.timezone)})` : ''
    return {
      subject: clean(r.reason === 'complained' ? `${name} asked not to get our emails: please call them` : `Email to ${name} bounced: please call them`, 150),
      body: `${
        r.reason === 'complained'
          ? `${name}${appt} marked the ${WHAT[r.message_kind] || 'email'} as spam, so they won't get any more emails or reminders from ${clean(r.biz, 80)}.`
          : `The ${WHAT[r.message_kind] || 'email'} to ${name}${appt} couldn't be delivered: ${clean(r.email, 120)} doesn't accept email. We won't email that address again.`
      }\n\nIf you need to reach them: ${clean(r.phone, 40)}\n\nAll appointments: ${origin}/dashboard/appointments\n\n— GetShowUps`,
    }
  }
  if (kind === 'owner_callback') {
    const what = r.kind === 'message' ? 'left a message' : 'asked for a call back'
    return {
      subject: clean(`${r.urgent ? 'URGENT: ' : ''}${name || 'A customer'} ${what}`, 150),
      body: `${name || 'A customer'} ${what} through the ${clean(r.biz, 80)} AI receptionist.\n\n${clean(r.note, 400)}\n\nPhone: ${clean(r.phone, 40)}${r.email ? `\nEmail: ${clean(r.email, 120)}` : ''}\n\nMark it done when you've called: ${origin}/dashboard/receptionist\n\n— GetShowUps`,
    }
  }
  if (kind === 'owner_coverage') {
    const where = r.zip_check === 'outside' ? `ZIP ${clean(r.zip, 10)}, which isn't on your service list` : r.zip ? `ZIP ${clean(r.zip, 10)}, which we couldn't verify` : 'no valid ZIP'
    return {
      subject: clean(`Can you serve ${name}? (${r.zip ? `ZIP ${clean(r.zip, 10)}` : 'ZIP unknown'})`, 150),
      body: `${name} asked ${clean(r.biz, 80)} about: ${clean(shortNeed(r.need), 80)}\n\nThey're in ${where}. We kept their request and told them you'll confirm availability. They can't book until you answer.\n\n${contact}\n\nAnswer "We serve this area" or "We can't serve this area": ${origin}/dashboard/appointments\n\n— GetShowUps`,
    }
  }
  if (kind === 'owner_cancel') {
    const when = longWhen(r.start_at, r.timezone)
    return {
      subject: clean(`Cancelled: ${name}, ${when}`, 150),
      body: `${name} cancelled their ${clean(r.biz, 80)} appointment for ${when}. It's been removed from your Google Calendar and the time is open again. They were offered a new time.\n\nService: ${clean(shortNeed(r.need), 80)}\n${contact}\n\nAll appointments: ${origin}/dashboard/appointments\n\n— GetShowUps`,
    }
  }
  return {
    subject: clean(`New lead: ${name} hasn't picked a time yet`, 150),
    body: `${name} asked ${clean(r.biz, 80)} about: ${clean(shortNeed(r.need), 80)}\n\n${contact}\n\nThey haven't booked a time yet. Your dashboard: ${origin}/dashboard\n\n— GetShowUps`,
  }
}

// bookingId (optional): only the new-booking notice for that appointment, queued right after the booking request (the
// cron scan still catches anything this misses; the outbox id makes it exactly once either way).
export async function queueOwnerNotices(env, now = Date.now(), { bookingId = null } = {}) {
  const db = env.ONBOARDING_DB
  const out = { queued: 0, held: 0 }
  const only = typeof bookingId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(bookingId) ? bookingId : null
  const none = Promise.resolve({ results: [] })
  const [bookings, leads, cancels, bounces, callbacks, coverage] = only
    ? await Promise.all([db.prepare(BOOKINGS_SQL).bind(now - WINDOW_MS, only).all(), none, none, none, none, none])
    : await Promise.all([
    db.prepare(BOOKINGS_SQL).bind(now - WINDOW_MS, null).all(),
    db.prepare(LEADS_SQL).bind(now - WINDOW_MS, now - LEAD_GRACE_MS).all(),
    db.prepare(CANCELS_SQL).bind(now - WINDOW_MS).all(),
    // Before migration 0020 there are no suppressions: the other notices must still go out.
    db.prepare(BOUNCES_SQL).bind(now - WINDOW_MS).all().catch(() => ({ results: [] })),
    // Before migration 0027 there are no receptionist requests.
    db.prepare(CALLBACKS_SQL).bind(now - WINDOW_MS).all().catch(() => ({ results: [] })),
    // Before migration 0029 there are no coverage requests.
    db.prepare(COVERAGE_SQL).bind(now - WINDOW_MS).all().catch(() => ({ results: [] })),
      ])
  const items = [
    ...bookings.results.map((r) => ['owner_booking', r]),
    ...leads.results.map((r) => ['owner_lead', r]),
    ...cancels.results.map((r) => ['owner_cancel', r]),
    ...bounces.results.map((r) => ['owner_bounce', r]),
    ...callbacks.results.map((r) => ['owner_callback', r]),
    ...coverage.results.map((r) => ['owner_coverage', r]),
  ]
  if (!items.length) return out
  const customers = [...new Set(items.map(([, r]) => r.customer))]
  const { results: members } = await db
    .prepare(`SELECT customer, email FROM customer_users WHERE customer IN (${customers.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...customers)
    .all()
  const tests = await testStatuses(env)
  const origin = siteOrigin(env)
  for (const [kind, r] of items) {
    const testOnly = sandboxed(statusIn(tests, r.customer), r.created_at)
    let sendable = 0
    for (const m of members.filter((x) => x.customer === r.customer)) {
      if (!recipientAllowed(env, m.email, { testOnly })) {
        out.held++
        continue
      }
      sendable++
      const id = `${kind}:${r.item}:${(await sha256Hex(`owner:${m.email}`)).slice(0, 16)}`
      if (await enqueue(env, { id, to: m.email, customer: r.customer, template: kind, ...ownerNotice(kind, r, origin) }, now)) out.queued++
    }
    // A callback nobody could be notified about is marked, so the owner's screen never implies staff were told.
    if (kind === 'owner_callback' && !sendable) await db.prepare('UPDATE receptionist_requests SET held = 1, updated_at = ?2 WHERE id = ?1').bind(r.item, now).run()
  }
  return out
}
