// Owner notices: tells a business's members (customer_users) about a new booking, and about a qualified lead that
// hasn't booked within LEAD_GRACE_MS (so they can call while it's fresh). Run by the cron (/api/cron/run) as a scan,
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
export const OWNER_TEMPLATES = ['owner_booking', 'owner_lead']

const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)
// Still owed to at least one member (one held by the launch gate, or added since, is not skipped).
const notQueued = (kind, col, customerCol) =>
  `(SELECT count(*) FROM email_outbox o WHERE o.id >= '${kind}:' || ${col} || ':' AND o.id < '${kind}:' || ${col} || ';') < (SELECT count(*) FROM customer_users u WHERE u.customer = ${customerCol})`

const BOOKINGS_SQL = `
  SELECT a.id AS item, a.customer, a.created_at, a.start_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN customers c ON c.id = a.customer
  WHERE a.created_at > ?1 AND a.status = 'booked' AND c.status = 'active' AND ${notQueued('owner_booking', 'a.id', 'a.customer')}
  ORDER BY a.created_at LIMIT ${LIMIT}`
const LEADS_SQL = `
  SELECT l.id AS item, l.customer, l.created_at, l.name, l.phone, l.email, l.need, c.name AS biz, c.timezone
  FROM leads l JOIN customers c ON c.id = l.customer
  WHERE l.created_at > ?1 AND l.created_at <= ?2 AND l.status = 'new' AND c.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status <> 'cancelled')
    AND ${notQueued('owner_lead', 'l.id', 'l.customer')}
  ORDER BY l.created_at LIMIT ${LIMIT}`

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
  return {
    subject: clean(`New lead: ${name} hasn't picked a time yet`, 150),
    body: `${name} asked ${clean(r.biz, 80)} about: ${clean(shortNeed(r.need), 80)}\n\n${contact}\n\nThey haven't booked a time yet. Your dashboard: ${origin}/dashboard\n\n— GetShowUps`,
  }
}

export async function queueOwnerNotices(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const out = { queued: 0, held: 0 }
  const [bookings, leads] = await Promise.all([
    db.prepare(BOOKINGS_SQL).bind(now - WINDOW_MS).all(),
    db.prepare(LEADS_SQL).bind(now - WINDOW_MS, now - LEAD_GRACE_MS).all(),
  ])
  const items = [...bookings.results.map((r) => ['owner_booking', r]), ...leads.results.map((r) => ['owner_lead', r])]
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
    for (const m of members.filter((x) => x.customer === r.customer)) {
      if (!recipientAllowed(env, m.email, { testOnly })) {
        out.held++
        continue
      }
      const id = `${kind}:${r.item}:${(await sha256Hex(`owner:${m.email}`)).slice(0, 16)}`
      if (await enqueue(env, { id, to: m.email, customer: r.customer, template: kind, ...ownerNotice(kind, r, origin) }, now)) out.queued++
    }
  }
  return out
}
