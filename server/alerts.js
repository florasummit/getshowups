// Founder alerts (docs/FOUNDER_ALERTS_PROPOSAL.md): an email to the platform admins when something stops a paying
// business from getting bookings or messages:
//   calendar      the calendar connection is broken (lookups fail with a connection error, or hours are confirmed but
//                 no calendar is connected)
//   availability  the booking page shows no times because lookups keep failing (not "no free time")
//   comms         messages fail to deliver (one failed booking confirmation, or 3+ failures in an hour)
//   incident      any other critical/high open incident (payments, messaging, receptionist, domains, background work)
//   assistant     the dashboard assistant failed 3+ times in an hour (or once because the AI allowance or account refused) and never succeeded
// Not covered: the 5-minute job itself stopping (nothing would run to say so; check Business Review's last run).
// OFF unless FOUNDER_ALERTS_ENABLED is exactly 'true' (approval). Recipients: PLATFORM_ADMIN_EMAILS only, and only
// those the launch gate would deliver to NOW (recipientAllowed: while MESSAGES_LIVE is off, MESSAGE_TEST_RECIPIENTS),
// so nothing waits in the outbox to go out late. Reads existing records only (audit_log events, messages, outbox, KV
// keys); no migration. Deduplicated by outbox id (one email per incident or per business per day). At most
// MAX_ALERTS new alerts per run; the rest are counted in one digest. Content: business id + name, kind, error codes,
// counts and times; never lead/customer names, emails, phones, addresses or event details.
import { emailConfigured, enqueue, flushOutbox, recipientAllowed } from './email.js'
import { adminEmails } from './platform.js'
import { recordEvent } from './auditlog.js'
import { siteOrigin } from './auth.js'
import { sha256Hex } from './google-oauth.js'
import { statusIn, testStatuses } from './testbusiness.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
export const MAX_ALERTS = 10
export const alertsEnabled = (env) => env.FOUNDER_ALERTS_ENABLED === 'true'

// Lookup errors that mean the connection itself is broken (calendar.js connect() statuses).
const CONNECTION = new Set(['reconnect_required', 'token_refresh_failed', 'decrypt_failed', 'not_connected', 'record_invalid'])
const CONFIRM_MS = 10 * MIN // a possibly temporary connection error must stay open this long (invalid_grant is final)
const AVAILABILITY_WINDOW_MS = 30 * MIN
const AVAILABILITY_MIN = 3
const COMMS_WINDOW_MS = HOUR
const COMMS_MIN = 3

const utcDay = (t) => new Date(t).toISOString().slice(0, 10)
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z')
const LABEL = { calendar: 'Calendar connection broken', availability: 'Booking page shows no times (calendar lookups failing)', comms: 'Messages failing to deliver', incident: 'Service failure', assistant: 'Dashboard assistant not answering' }
export const PLATFORM = 'platform'

// Open availability failures (no later success) per business, newest 24 h.
async function availabilityIncidents(db, now) {
  const { results } = await db
    .prepare(
      `SELECT f.seq, f.at, f.customer, f.details FROM audit_log f
        WHERE f.capability = 'calendar.google' AND f.resource_type = 'availability' AND f.outcome = 'failure' AND f.at >= ?1
          AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.capability = 'calendar.google' AND s.resource_type = 'availability'
                          AND s.resource_id = f.resource_id AND s.outcome = 'success' AND s.seq > f.seq)
        ORDER BY f.seq LIMIT 500`,
    )
    .bind(now - DAY)
    .all()
  const by = new Map()
  for (const r of results) {
    const g = by.get(r.customer) || { customer: r.customer, opened: r.at, last: r.at, recent: 0, error: null }
    g.last = r.at
    if (r.at >= now - AVAILABILITY_WINDOW_MS) g.recent++
    try {
      g.error = String(JSON.parse(r.details)?.error || 'calendar_error').slice(0, 40)
    } catch {
      g.error = 'calendar_error'
    }
    by.set(r.customer, g)
  }
  const out = []
  for (const g of by.values()) {
    if (CONNECTION.has(g.error)) {
      if (g.error === 'reconnect_required' || g.opened <= now - CONFIRM_MS) out.push({ kind: 'calendar', customer: g.customer, key: String(g.opened), facts: { error: g.error, firstSeen: g.opened, lastSeen: g.last } })
    } else if (g.recent >= AVAILABILITY_MIN) {
      out.push({ kind: 'availability', customer: g.customer, key: String(g.opened), facts: { error: g.error, failedLookups30m: g.recent, firstSeen: g.opened, lastSeen: g.last } })
    }
  }
  return out
}

// Hours confirmed but no calendar stored (owner disconnected or the token was removed): checked once an hour (it lists
// KV keys), one alert per business per day.
export const kvCheckDue = (now) => Math.floor(now / (5 * MIN)) % 12 === 0
async function disconnectedCalendars(env, now) {
  if (!kvCheckDue(now) || !env.GOOGLE_TOKENS) return []
  const connected = new Set()
  let cursor
  for (let page = 0; page < 100; page++) {
    const r = await env.GOOGLE_TOKENS.list({ prefix: 'google:', cursor })
    for (const k of r.keys) connected.add(k.name.slice('google:'.length))
    if (r.list_complete || !r.cursor) break
    cursor = r.cursor
  }
  const { results } = await env.ONBOARDING_DB.prepare("SELECT id FROM customers WHERE hours_confirmed_at IS NOT NULL AND status = 'active' LIMIT 5000").all()
  return results.filter((r) => !connected.has(r.id)).map((r) => ({ kind: 'calendar', customer: r.id, key: `d${utcDay(now)}`, facts: { error: 'not_connected' } }))
}

// Delivery failures in the last hour per business: lead messages, follow-up texts/emails, account/owner mail.
async function commsIncidents(db, now) {
  const since = now - COMMS_WINDOW_MS
  const by = new Map()
  const add = (customer, n, confirmations = 0) => {
    const g = by.get(customer) || { failed: 0, confirmations: 0 }
    g.failed += n
    g.confirmations += confirmations
    by.set(customer, g)
  }
  const msgs = await db
    .prepare("SELECT customer, sum(CASE WHEN kind = 'confirmation' THEN 1 ELSE 0 END) AS conf, count(*) AS n FROM messages WHERE status = 'failed' AND updated_at >= ?1 GROUP BY customer")
    .bind(since)
    .all()
    .catch(() => ({ results: [] }))
  for (const r of msgs.results) add(r.customer, r.n, r.conf)
  const fu = await db
    .prepare("SELECT customer, count(*) AS n FROM audit_log WHERE outcome = 'failure' AND action IN ('followups.send_failed', 'followups.delivery_failed') AND at >= ?1 AND customer IS NOT NULL GROUP BY customer")
    .bind(since)
    .all()
    .catch(() => ({ results: [] }))
  for (const r of fu.results) add(r.customer, r.n)
  // The outbox records no failure time: its retries end ≤ 35 min after queueing, so mail queued in the last 2 h.
  const ob = await db
    .prepare("SELECT customer, count(*) AS n FROM email_outbox WHERE status = 'failed' AND error NOT IN ('test_mode') AND template != 'founder_alert' AND created_at >= ?1 AND customer IS NOT NULL GROUP BY customer")
    .bind(now - 2 * HOUR)
    .all()
    .catch(() => ({ results: [] }))
  for (const r of ob.results) add(r.customer, r.n)
  const out = []
  for (const [customer, g] of by) {
    if (g.confirmations >= 1 || g.failed >= COMMS_MIN) out.push({ kind: 'comms', customer, key: `d${utcDay(now)}`, facts: { failedLastHour: g.failed, failedConfirmations: g.confirmations } })
  }
  return out
}

// Anything else the incident register holds as critical or high for a real business or the platform (payments, messaging,
// receptionist, domains, failed background work), and the assistant failing repeatedly with no success in between.
const COVERED = ['calendar', 'availability', 'comms']
async function otherIncidents(db, now) {
  const out = []
  const inc = await db
    .prepare(`SELECT id, customer, feature, code, first_seen, last_seen FROM ops_incidents WHERE status = 'open' AND is_test = 0 AND severity IN ('critical','high') AND kind NOT IN (${COVERED.map((k) => `'${k}'`).join(',')}) AND last_seen >= ?1 ORDER BY first_seen LIMIT 50`)
    .bind(now - DAY)
    .all()
    .catch(() => ({ results: [] }))
  for (const r of inc.results) out.push({ kind: 'incident', customer: r.customer || PLATFORM, key: r.id, facts: { feature: r.feature, error: r.code, firstSeen: r.first_seen, lastSeen: r.last_seen } })
  const a = await db
    .prepare("SELECT coalesce(sum(json_extract(props, '$.ok') = 0 AND json_extract(props, '$.reason') IN ('unavailable','timeout','busy','quota','setup')), 0) AS bad, coalesce(sum(json_extract(props, '$.reason') IN ('quota','setup')), 0) AS down, max(CASE WHEN json_extract(props, '$.ok') = 0 THEN json_extract(props, '$.reason') END) AS reason, coalesce(sum(json_extract(props, '$.ok') = 1), 0) AS good FROM events WHERE type = 'ai_ask' AND at >= ?1 AND NOT EXISTS (SELECT 1 FROM test_businesses tb WHERE tb.customer = events.customer AND tb.is_test = 1)")
    .bind(now - HOUR)
    .first()
    .catch(() => null)
  if ((a?.bad >= 3 || a?.down) && !a.good) out.push({ kind: 'assistant', customer: PLATFORM, key: `d${utcDay(now)}`, facts: { failedLastHourAssistant: a.bad, ...(a.down ? { error: a.reason } : {}) } })
  return out
}

// Every open incident of the three kinds, from records only (test businesses NOT filtered here). Shared with the
// incident register (server/ops/incidents.js) so alerts and incidents use the same rules.
export async function detectIncidents(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  return [...(await availabilityIncidents(db, now)), ...(await disconnectedCalendars(env, now).catch(() => [])), ...(await commsIncidents(db, now))]
}

function render(env, a, name, now) {
  const f = a.facts
  const lines = [
    `${LABEL[a.kind]}`,
    '',
    `Business: ${name} (${a.customer})`,
    f.feature ? `Feature: ${f.feature}` : null,
    f.failedLastHourAssistant ? `Failed answers in the last hour, with none succeeding: ${f.failedLastHourAssistant}` : null,
    f.error ? `Error code: ${f.error}` : null,
    f.failedLookups30m != null ? `Failed booking-page lookups in the last 30 min: ${f.failedLookups30m}` : null,
    f.failedLastHour != null ? `Failed deliveries in the last hour: ${f.failedLastHour} (booking confirmations: ${f.failedConfirmations})` : null,
    f.firstSeen ? `First seen: ${iso(f.firstSeen)}` : null,
    f.lastSeen ? `Last seen: ${iso(f.lastSeen)}` : null,
    `Still open at: ${iso(now)}`,
    '',
    `Business Review (current state, incl. recovery): ${siteOrigin(env)}/admin/review`,
    '',
    'Sent by GetShowUps founder alerts (FOUNDER_ALERTS_ENABLED). One email per incident, at most one per business and',
    'kind every 6 hours; this email is not repeated and no "resolved" email is sent.',
  ]
  return { subject: `GetShowUps alert: ${LABEL[a.kind]} — ${name}`.slice(0, 180), body: lines.filter((l) => l !== null).join('\n') }
}

const recipientRef = async (email) => (await sha256Hex(`alert:${email}`)).slice(0, 12)
export const COOLDOWN_MS = 6 * HOUR
const recentlyAlerted = async (db, prefix, now) =>
  Boolean(await db.prepare("SELECT 1 FROM email_outbox WHERE id >= ?1 AND id < ?1 || '~' AND created_at >= ?2 LIMIT 1").bind(prefix, now - COOLDOWN_MS).first())
const queued = async (db, prefix) => Boolean(await db.prepare('SELECT 1 FROM email_outbox WHERE id >= ?1 AND id < ?1 || \'~\' LIMIT 1').bind(prefix).first())

// Cron step. Returns counts only. Never throws.
export async function founderAlerts(env, now = Date.now()) {
  if (!alertsEnabled(env)) return { enabled: false }
  const db = env.ONBOARDING_DB
  try {
    const admins = adminEmails(env)
    const to = admins.filter((e) => recipientAllowed(env, e))
    const tests = await testStatuses(env)
    const found = [...(await detectIncidents(env, now)), ...(await otherIncidents(db, now))]
    // Test businesses never alert; if the test list is unreadable nothing alerts (fails closed, decided next run).
    const candidates = tests === null ? [] : found.filter((a) => a.customer === PLATFORM || !statusIn(tests, a.customer).test)
    const ids = [...new Set(candidates.map((a) => a.customer))].filter((id) => id !== PLATFORM)
    const names = new Map([[PLATFORM, { name: 'GetShowUps platform' }]])
    for (const id of ids) {
      // Deleted (or deleting) accounts never alert.
      const r = await db.prepare('SELECT name, status, EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = c.id) AS deleted FROM customers c WHERE c.id = ?1').bind(id).first()
        .catch(() => db.prepare('SELECT name, status, 0 AS deleted FROM customers WHERE id = ?1').bind(id).first())
      if (r && !r.deleted) names.set(id, r)
    }
    const out = { enabled: true, recipients: to.length, held: admins.length - to.length, candidates: 0, queued: 0, digest: 0, cooldown: 0 }
    if (!to.length) return { ...out, candidates: candidates.length }
    // Once per recipient, ever: proof that alerts are on and reach a real inbox.
    for (const email of to)
      await enqueue(env, { id: `alert:on:v1:${await recipientRef(email)}`, to: email, template: 'founder_alert', subject: 'GetShowUps alerts are on', body: 'Founder alerts are now on. You will get one email per problem, at most one per business and kind every six hours. Nothing is wrong right now because of this email.' }, now)
    const fresh = []
    for (const a of candidates) {
      const biz = names.get(a.customer)
      if (!biz) continue
      a.id = `alert:${a.kind}:${a.customer}:${a.key}`
      if (await queued(db, `${a.id}:`)) continue
      // Flapping (fails, recovers, fails again) opens new incidents: at most one alert per business + kind per COOLDOWN.
      if (await recentlyAlerted(db, `alert:${a.kind}:${a.customer}:`, now)) {
        out.cooldown++
        continue
      }
      a.name = biz.name
      fresh.push(a)
    }
    out.candidates = fresh.length
    for (const a of fresh.slice(0, MAX_ALERTS)) {
      const { subject, body } = render(env, a, a.name, now)
      for (const email of to) await enqueue(env, { id: `${a.id}:${await recipientRef(email)}`, to: email, template: 'founder_alert', subject, body }, now)
      out.queued++
      await recordEvent(db, { type: 'alert.queued', actor: 'system:alerts', customer: a.customer, capability: 'platform.alerts', resource: { type: 'alert', id: a.kind }, outcome: 'success', details: { kind: a.kind }, at: now })
    }
    const rest = fresh.length - Math.min(fresh.length, MAX_ALERTS)
    if (rest > 0) {
      const hour = Math.floor(now / HOUR)
      const body = `${rest} more open incident(s) this hour were not emailed individually.\n\nBusiness Review: ${siteOrigin(env)}/admin/review`
      for (const email of to) await enqueue(env, { id: `alert:digest:${hour}:${await recipientRef(email)}`, to: email, template: 'founder_alert', subject: `GetShowUps alert: ${rest} more open incident(s)`, body }, now)
      out.digest = rest
    }
    return out
  } catch (err) {
    console.error('founder alerts failed:', err?.name)
    return { enabled: true, error: 'failed' }
  }
}

// ---------- Delivery status + controlled test (Control Center) ----------
// Status: the switch, how many admins the launch gate delivers to NOW (counts only, never addresses), last alert.
export async function alertsStatus(env) {
  const admins = adminEmails(env)
  const deliverable = admins.filter((e) => recipientAllowed(env, e)).length
  let last = null
  try {
    last = await env.ONBOARDING_DB.prepare("SELECT created_at AS at, status, error FROM email_outbox WHERE id >= 'alert:' AND id < 'alert;' ORDER BY created_at DESC LIMIT 1").first()
  } catch {
    last = null
  }
  return { enabled: alertsEnabled(env), emailConfigured: emailConfigured(env), admins: admins.length, deliverable, held: admins.length - deliverable, last: last ? { at: last.at, status: last.status, error: last.error || null } : null }
}

export const TEST_COOLDOWN_MS = 10 * MIN
const TEST_PREFIX = 'alert:test:'
// One clearly labelled test email to every deliverable admin, through the same outbox, gate and provider as a real
// alert, sent at once (not on the next cron). Only while FOUNDER_ALERTS_ENABLED is on, so it tests the real switch.
// Creates no incident and touches no business. At most one per 10 minutes. Returns counts and error codes only.
export async function sendTestAlert(env, now = Date.now()) {
  if (!alertsEnabled(env)) return { ok: false, error: 'alerts_disabled' }
  if (!emailConfigured(env)) return { ok: false, error: 'email_not_configured' }
  const db = env.ONBOARDING_DB
  const to = adminEmails(env).filter((e) => recipientAllowed(env, e))
  if (!to.length) return { ok: false, error: 'no_recipient' }
  const recent = await db.prepare('SELECT 1 FROM email_outbox WHERE id >= ?1 AND id < ?1 || \'~\' AND created_at >= ?2 LIMIT 1').bind(TEST_PREFIX, now - TEST_COOLDOWN_MS).first()
  if (recent) return { ok: false, error: 'too_soon' }
  const minute = Math.floor(now / MIN)
  const subject = 'GetShowUps alert: TEST (no action needed)'
  const body = [
    'This is a test of GetShowUps founder alerts, sent from the Control Center by a platform admin.',
    'No incident is open because of this email and no business is affected.',
    '',
    `Sent at: ${iso(now)}`,
    `Control Center: ${siteOrigin(env)}/admin/control`,
    '',
    'Real alerts use the same sender and subject prefix ("GetShowUps alert:").',
  ].join('\n')
  const ids = []
  for (const email of to) {
    const id = `${TEST_PREFIX}${minute}:${await recipientRef(email)}`
    if (await enqueue(env, { id, to: email, template: 'founder_alert', subject, body }, now)) ids.push(id)
  }
  await flushOutbox(env, now, ids.length || 1, { idPrefix: TEST_PREFIX })
  const rows = ids.length ? (await db.prepare(`SELECT status, error FROM email_outbox WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...ids).all()).results : []
  const sent = rows.filter((r) => r.status === 'sent').length
  const errors = [...new Set(rows.filter((r) => r.status !== 'sent').map((r) => r.error || r.status))]
  await recordEvent(db, { type: 'alert.test', actor: 'system:alerts', capability: 'platform.alerts', resource: { type: 'alert', id: 'test' }, outcome: sent === ids.length && sent > 0 ? 'success' : 'failure', details: { recipients: ids.length, sent }, at: now })
  return { ok: sent > 0, recipients: ids.length, sent, notSent: ids.length - sent, errors }
}
