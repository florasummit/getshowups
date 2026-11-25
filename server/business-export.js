// The owner's data, portable: CSV for people, visits and money; JSON for settings, website and AI knowledge; the images.
// Every query is bound to one business. Left out on purpose: credentials and tokens, sign-in sessions, our system
// instructions, security logs, other businesses. Anything cut short for size says so in README.txt.
import { zip } from './zip.js'
import { getProfile } from './onboarding.js'
import { getPolicies } from './policies.js'
import { bookingRules } from './booking-rules.js'
import { loadWebsite } from './website.js'
import { blobBytes } from './assets.js'
import { domainFor } from './domains.js'
import { visibleTranscript } from './receptionist/engine.js'

export const MAX_ROWS = 20000
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const at = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '')
const money = (c) => (c == null ? '' : (c / 100).toFixed(2))

// Spreadsheet programs run cells starting with these characters as formulas: shown as text instead.
export const cell = (v) => {
  let s = String(v ?? '')
  if (/^\s*[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d\s().-]*$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
export const csv = (head, rows) => `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`

export async function businessExport(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const id = customer.id
  const notes = []
  const files = []
  const rowsOf = async (name, sql) => {
    try {
      const { results } = await db.prepare(`${sql} LIMIT ${MAX_ROWS + 1}`).bind(id).all()
      if (results.length > MAX_ROWS) notes.push(`${name}: only the first ${MAX_ROWS} rows fit. Contact hello@getshowups.com for the rest.`)
      return results.slice(0, MAX_ROWS)
    } catch (err) {
      // A part that doesn't exist yet is empty; a part that can't be read fails the export instead of looking empty.
      if (String(err?.message).includes('no such table')) return []
      throw err
    }
  }
  const addCsv = (name, head, rows) => files.push({ name, bytes: new TextEncoder().encode(csv(head, rows)) })
  const addJson = (name, v) => files.push({ name, bytes: new TextEncoder().encode(JSON.stringify(v, null, 2)) })

  const leads = await rowsOf('customers.csv', `SELECT l.*, a.street, a.unit, a.city, a.state, a.zip AS azip, t.source AS source, (SELECT is_test FROM test_marks m WHERE m.lead_id = l.id) AS test
      FROM leads l LEFT JOIN lead_addresses a ON a.lead_id = l.id LEFT JOIN lead_attribution t ON t.lead_id = l.id WHERE l.customer = ?1 ORDER BY l.created_at`)
  addCsv('customers.csv', ['id', 'asked_at', 'name', 'email', 'phone', 'need', 'zip', 'status', 'street', 'unit', 'city', 'state', 'address_zip', 'source', 'test_record'], leads.map((l) => [l.id, at(l.created_at), l.name, l.email, l.phone, l.need, l.zip, l.status, l.street, l.unit, l.city, l.state, l.azip, l.source || '', l.test ? 'yes' : '']))
  const appts = await rowsOf('appointments.csv', `SELECT a.*, l.name, o.work, o.value_cents,
        (SELECT amount_cents FROM revenue_entries r WHERE r.appointment_id = a.id AND r.kind = 'invoiced' ORDER BY r.id DESC LIMIT 1) AS invoiced,
        (SELECT amount_cents FROM revenue_entries r WHERE r.appointment_id = a.id AND r.kind = 'paid' ORDER BY r.id DESC LIMIT 1) AS paid
      FROM appointments a JOIN leads l ON l.id = a.lead_id LEFT JOIN appointment_outcomes o ON o.appointment_id = a.id WHERE a.customer = ?1 ORDER BY a.start_at`)
  addCsv('appointments.csv', ['id', 'customer_id', 'name', 'starts_at', 'ends_at', 'status', 'work', 'estimated_value', 'invoiced', 'paid'], appts.map((a) => [a.id, a.lead_id, a.name, at(a.start_at), at(a.end_at), a.status, a.work || '', money(a.value_cents), money(a.invoiced), money(a.paid)]))
  const changes = await rowsOf('appointment_history.csv', 'SELECT * FROM appointment_changes WHERE customer = ?1 ORDER BY changed_at')
  addCsv('appointment_history.csv', ['appointment_id', 'from', 'to', 'changed_at'], changes.map((c) => [c.appointment_id, c.from_status, c.to_status, at(c.changed_at)]))
  const pay = await rowsOf('recorded_payments.csv', 'SELECT * FROM revenue_entries WHERE customer = ?1 ORDER BY id')
  addCsv('recorded_payments.csv', ['appointment_id', 'kind', 'amount', 'recorded_at'], pay.map((r) => [r.appointment_id, r.kind, money(r.amount_cents), at(r.recorded_at)]))
  const req = await rowsOf('callbacks.csv', 'SELECT * FROM receptionist_requests WHERE customer = ?1 ORDER BY created_at')
  addCsv('callbacks.csv', ['id', 'kind', 'name', 'phone', 'email', 'note', 'urgent', 'status', 'created_at', 'resolved_at'], req.map((r) => [r.id, r.kind, r.name, r.phone, r.email, r.note, r.urgent ? 'yes' : '', r.status, at(r.created_at), at(r.resolved_at)]))
  const msgs = await rowsOf('messages.csv', "SELECT * FROM thread_messages WHERE customer = ?1 ORDER BY created_at")
  addCsv('messages.csv', ['customer_id', 'direction', 'channel', 'author', 'body', 'status', 'created_at'], msgs.map((m) => [m.lead_id, m.direction, m.channel, m.author, m.body, m.status, at(m.created_at)]))
  const conv = await rowsOf('receptionist_conversations.json', "SELECT id, channel, status, outcome, lead_id, summary, state, transcript, created_at FROM receptionist_conversations WHERE customer = ?1 ORDER BY created_at")
  addJson('receptionist_conversations.json', conv.map((c) => ({ id: c.id, channel: c.channel, status: c.status, outcome: c.outcome, customerId: c.lead_id, summary: c.summary, startedAt: at(c.created_at), lines: spoken(c) })))
  const ads = await rowsOf('ad_results.csv', 'SELECT m.*, k.platform FROM ad_metrics_daily m JOIN ad_campaigns k ON k.id = m.campaign_id WHERE k.customer = ?1 ORDER BY m.date')
  addCsv('ad_results.csv', ['date', 'platform', 'campaign', 'spend', 'clicks', 'impressions'], ads.map((m) => [m.date, m.platform, m.campaign_id, money(m.spend_cents), m.clicks, m.impressions]))

  const one = (sql) => db.prepare(sql).bind(id).first().catch((err) => (String(err?.message).includes('no such table') ? null : Promise.reject(err)))
  const [profile, policies, rules, rec, ai, versions, site, siteVersions, domain] = await Promise.all([
    getProfile(db, id),
    getPolicies(db, id),
    bookingRules(db, id),
    one('SELECT enabled, mode, greeting, knowledge FROM receptionist_settings WHERE customer = ?1'),
    one('SELECT draft, live_version FROM ai_rules WHERE customer = ?1'),
    rowsOf('ai_knowledge.json', 'SELECT version, config, note, created_at FROM ai_rule_versions WHERE customer = ?1 ORDER BY version'),
    loadWebsite(db, customer),
    rowsOf('website.json', 'SELECT version, content, created_at FROM website_versions WHERE customer = ?1 ORDER BY version'),
    domainFor(env, id),
  ])
  addJson('business.json', { id, name: customer.name, timezone: customer.timezone, appointmentMode: customer.appointmentMode, serviceZips: customer.serviceZips, hours: { days: customer.workdays, from: customer.dayStart, to: customer.dayEnd, minutes: customer.slotMinutes }, bookingNoticeMinutes: rules.minNoticeMinutes, closedDates: rules.closures, profile, policies, receptionist: rec && { on: Boolean(rec.enabled), mode: rec.mode, greeting: rec.greeting, knowledge: rec.knowledge }, domain: domain ? { hostname: domain.hostname, status: domain.status } : null })
  addJson('ai_knowledge.json', { draft: ai ? JSON.parse(ai.draft) : null, publishedVersion: ai?.live_version ?? null, versions: versions.map((v) => ({ version: v.version, note: v.note, at: at(v.created_at), config: JSON.parse(v.config) })) })
  addJson('website.json', { draft: site.draft, liveVersion: site.liveVersion, versions: siteVersions.map((v) => ({ version: v.version, at: at(v.created_at), content: JSON.parse(v.content) })) })

  const meta = await db.prepare('SELECT id, content_type, size FROM website_assets WHERE customer = ?1 ORDER BY created_at').bind(id).all()
  let used = 0
  let left = 0
  for (const a of meta.results) {
    if (used + a.size > MAX_IMAGE_BYTES) {
      left++
      continue
    }
    const r = await db.prepare('SELECT bytes FROM website_assets WHERE id = ?1 AND customer = ?2').bind(a.id, id).first()
    if (!r) continue
    used += a.size
    files.push({ name: `images/${a.id}.${a.content_type.split('/')[1].replace('jpeg', 'jpg')}`, bytes: blobBytes(r.bytes) })
  }
  if (left) notes.push(`${left} of ${meta.results.length} images didn't fit. Download them from Website → Photos.`)
  files.unshift({
    name: 'README.txt',
    bytes: new TextEncoder().encode(`GetShowUps export for ${customer.name}\nCreated ${at(now)} (all times are UTC)\n\ncustomers.csv, appointments.csv, appointment_history.csv, recorded_payments.csv, callbacks.csv, messages.csv, ad_results.csv: open in any spreadsheet.\nbusiness.json: settings, services, policies, closed dates. ai_knowledge.json: what you taught. website.json: drafts and published versions. images/: your photos.\n\nPayments are the amounts you recorded. Not included: passwords, connection keys, sign-in records, GetShowUps' own system instructions.\nYour Google Calendar, ad accounts and domain are in your own accounts.\n${notes.length ? `\nNot complete:\n- ${notes.join('\n- ')}\n` : '\nNothing was left out for size.\n'}`),
  })
  return { bytes: zip(files, new Date(now)), files: files.length, notes }
}

// Only what the customer saw or heard: no tool calls, instructions or internals.
function spoken(c) {
  try {
    return visibleTranscript(JSON.parse(c.transcript || '[]'), JSON.parse(c.state || '{}'))
  } catch {
    return []
  }
}
