// Phone calls from Google ads, as Google reports them (migration 0040; docs/GOOGLE_ACQUISITION.md "Calls"). Google's native
// forwarding keeps the business's own number; we only read (no line, routing or recording here). Google never tells who
// called, so calls are never matched to people automatically: the owner links a call to a customer or adds the caller.
// An added caller keeps the campaign Google named; a person already recorded keeps the source they came from first.
import { sha256Hex } from '../google-oauth.js'
import { createLead, validateLead } from '../booking.js'
import { zonedToUtc } from '../calendar.js'
import { resumeUrl } from '../links.js'
import { isTestLead } from '../testdata.js'
import { readCalls } from './google.js'

const DAY = 86_400_000
export const callsReady = async (db) => {
  try {
    return Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('google_calls', 'google_call_setup')").first())?.n) === 2
  } catch {
    return false
  }
}
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
// Google gives "YYYY-MM-DD HH:MM:SS" and documents no time zone for it; read as the Ads account's. Shown as Google gave it.
const instant = (s, tz) => {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(s)
  if (!m) return null
  try {
    return zonedToUtc(...m.slice(1).map(Number), tz || 'UTC')
  } catch {
    return zonedToUtc(...m.slice(1).map(Number), 'UTC')
  }
}

// 90 days the first time, then the last 7 (a call's details can arrive late). Owner marks and links are never overwritten.
export async function syncCalls(env, customerId, { now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await callsReady(db))) return { ok: true, skipped: 'not_ready' }
  const seen = await db.prepare('SELECT checked_at FROM google_call_setup WHERE customer = ?1').bind(customerId).first()
  const r = await readCalls(env, customerId, day(now - (seen ? 7 : 90) * DAY))
  if (!r.ok) return r
  const stmts = []
  for (const c of r.calls) {
    const at = instant(c.localTime, r.timeZone)
    if (at === null) continue
    stmts.push(
      db
        .prepare(
          `INSERT INTO google_calls (id, customer, campaign_external_id, local_time, started_at, duration_seconds, status, shown_on, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(customer, id) DO UPDATE SET campaign_external_id = ?3, local_time = ?4, started_at = ?5, duration_seconds = ?6, status = ?7, shown_on = ?8, synced_at = ?9`,
        )
        .bind(c.id, customerId, c.campaignExternalId, c.localTime, at, c.seconds, c.status, c.shownOn, now),
    )
  }
  stmts.push(
    db
      .prepare('INSERT INTO google_call_setup (customer, reporting, numbers_on_ads, time_zone, checked_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(customer) DO UPDATE SET reporting = ?2, numbers_on_ads = ?3, time_zone = ?4, checked_at = ?5')
      .bind(customerId, r.reporting === null ? null : Number(r.reporting), r.numbersOnAds, r.timeZone, now),
  )
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
  return { ok: true, calls: stmts.length - 1 }
}

const BOOKED = "a.status IN ('booked','showed','no_show')"
// What the linked people did: only from records, each person counted once.
async function outcomes(db, customerId, table, since, internal) {
  return db
    .prepare(
      `WITH p AS (SELECT DISTINCT l.id FROM ${table} g JOIN leads l ON l.id = g.lead_id AND l.customer = g.customer WHERE g.customer = ?1 AND g.${table === 'lsa_leads' ? 'created_at' : 'started_at'} >= ?2 AND NOT ${isTestLead('l', '?3')})
       SELECT (SELECT count(*) FROM p) AS people,
              (SELECT count(*) FROM p WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.customer = ?1 AND a.lead_id = p.id AND ${BOOKED})) AS booked,
              (SELECT count(*) FROM p WHERE EXISTS (SELECT 1 FROM appointments a JOIN appointment_outcomes o ON o.appointment_id = a.id AND o.customer = a.customer WHERE a.customer = ?1 AND a.lead_id = p.id AND a.status = 'showed' AND o.work = 'completed')) AS completed,
              (SELECT sum(x.amount_cents) FROM revenue_entries x JOIN appointments a ON a.id = x.appointment_id AND a.customer = x.customer WHERE x.customer = ?1 AND a.lead_id IN (SELECT id FROM p) AND a.status = 'showed' AND x.kind = 'paid'
                 AND x.id = (SELECT max(y.id) FROM revenue_entries y WHERE y.customer = x.customer AND y.appointment_id = x.appointment_id AND y.kind = 'paid')) AS paid`,
    )
    .bind(customerId, since, internal)
    .first()
    .then((r) => ({ people: r.people, booked: r.booked, completed: r.completed, paidCents: r.paid ?? null }))
}

export async function callReport(db, customerId, { days = 30, now = Date.now(), internal = '[]', list = 50 } = {}) {
  if (!(await callsReady(db))) return { ready: false }
  const since = now - days * DAY
  const [setup, sum, rows, lsa, results, lsaResults] = await Promise.all([
    db.prepare('SELECT * FROM google_call_setup WHERE customer = ?1').bind(customerId).first(),
    db.prepare("SELECT count(*) AS total, coalesce(sum(status = 'RECEIVED'), 0) AS answered, coalesce(sum(status = 'MISSED'), 0) AS missed, coalesce(sum(status = 'MISSED' AND handled_at IS NULL AND lead_id IS NULL), 0) AS open FROM google_calls WHERE customer = ?1 AND started_at >= ?2").bind(customerId, since).first(),
    db
      .prepare(
        `SELECT g.id, g.local_time, g.duration_seconds, g.status, g.shown_on, g.handled_at, g.lead_id, l.name AS lead_name, CASE WHEN k.id IS NOT NULL THEN 'GetShowUps campaign' ELSE i.name END AS campaign
           FROM google_calls g LEFT JOIN leads l ON l.id = g.lead_id AND l.customer = g.customer
           LEFT JOIN ad_campaigns k ON k.customer = g.customer AND k.platform = 'google' AND k.platform_campaign_id = g.campaign_external_id
           LEFT JOIN ad_imported_campaigns i ON i.customer = g.customer AND i.external_id = g.campaign_external_id
          WHERE g.customer = ?1 AND g.started_at >= ?2 ORDER BY (g.status = 'MISSED' AND g.handled_at IS NULL AND g.lead_id IS NULL) DESC, g.started_at DESC LIMIT ?3`,
      )
      .bind(customerId, since, list)
      .all(),
    db.prepare('SELECT s.id, s.lead_type, s.lead_status, s.charged, s.created_at, s.lead_id, l.name AS lead_name FROM lsa_leads s LEFT JOIN leads l ON l.id = s.lead_id AND l.customer = s.customer WHERE s.customer = ?1 AND s.created_at >= ?2 ORDER BY s.created_at DESC LIMIT ?3').bind(customerId, since, list).all(),
    outcomes(db, customerId, 'google_calls', since, internal),
    outcomes(db, customerId, 'lsa_leads', since, internal),
  ])
  const who = (r) => (r.lead_id ? { id: r.lead_id, name: r.lead_name } : null)
  return {
    ready: true,
    days,
    setup: setup ? { checkedAt: setup.checked_at, reporting: setup.reporting === null ? null : Boolean(setup.reporting), numbersOnAds: setup.numbers_on_ads, timeZone: setup.time_zone } : null,
    totals: { calls: sum.total, answered: sum.answered, missed: sum.missed, missedOpen: sum.open },
    results,
    lsaResults,
    calls: rows.results.map((r) => ({ id: r.id, localTime: r.local_time.slice(0, 16), seconds: r.duration_seconds, status: r.status, shownOn: r.shown_on, campaign: r.campaign || null, handled: Boolean(r.handled_at), lead: who(r) })),
    lsa: lsa.results.map((r) => ({ id: r.id, type: r.lead_type, status: r.lead_status, charged: Boolean(r.charged), createdAt: r.created_at, lead: who(r) })),
  }
}

const TABLE = { call: 'google_calls', lsa: 'lsa_leads' }
const find = (db, customerId, kind, id) =>
  TABLE[kind] && /^[A-Za-z0-9_~-]{1,80}$/.test(String(id)) && db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE customer = ?1 AND id = ?2`).bind(customerId, String(id)).first()

export async function markHandled(db, customerId, id, handled, now = Date.now()) {
  const r = await db.prepare('UPDATE google_calls SET handled_at = ?3 WHERE customer = ?1 AND id = ?2').bind(customerId, String(id), handled ? now : null).run()
  return r?.meta?.changes ? { ok: true } : { ok: false, error: 'not_found' }
}

// The campaign Google named for this call or lead, as an attribution row (first source wins: never replaced).
async function attribute(db, customerId, kind, row, leadId, now) {
  const ours = kind === 'call' && row.campaign_external_id ? await db.prepare("SELECT id FROM ad_campaigns WHERE customer = ?1 AND platform = 'google' AND platform_campaign_id = ?2").bind(customerId, row.campaign_external_id).first() : null
  const theirs = ours
    ? null
    : kind === 'lsa'
      ? row.imported_id && { id: row.imported_id }
      : row.campaign_external_id && (await db.prepare("SELECT id FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google' AND external_id = ?2").bind(customerId, row.campaign_external_id).first())
  if (!ours && !theirs) return false
  const r = await db
    .prepare('INSERT OR IGNORE INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(leadId, customerId, ours ? 'google_ads' : 'google_ads_imported', (ours || theirs).id, JSON.stringify({ via: kind === 'lsa' ? 'local_services' : 'google_call', ref: String(row.id) }), now)
    .run()
  return Boolean(r?.meta?.changes)
}

// Links a call to someone already recorded (leadId null = unlink). Their source stays what it was: a person who first came
// another way isn't moved to the ad because they also called. Unlinking removes only what adding this caller recorded.
export async function linkCall(db, customerId, kind, id, leadId, now = Date.now()) {
  const row = await find(db, customerId, kind, id)
  if (!row) return { ok: false, error: 'not_found' }
  if (leadId) {
    const lead = await db.prepare('SELECT id FROM leads WHERE id = ?1 AND customer = ?2').bind(String(leadId), customerId).first()
    if (!lead) return { ok: false, error: 'lead_not_found' }
  } else if (row.lead_id) {
    await db
      .prepare("DELETE FROM lead_attribution WHERE customer = ?1 AND lead_id = ?2 AND json_extract(details, '$.via') = ?3 AND json_extract(details, '$.ref') = ?4")
      .bind(customerId, row.lead_id, kind === 'lsa' ? 'local_services' : 'google_call', String(row.id))
      .run()
  }
  await db.prepare(`UPDATE ${TABLE[kind]} SET lead_id = ?3${kind === 'call' ? ', handled_at = coalesce(handled_at, ?4)' : ''} WHERE customer = ?1 AND id = ?2`).bind(...[customerId, String(row.id), leadId ? String(leadId) : null, ...(kind === 'call' ? [leadId ? now : row.handled_at ?? null] : [])]).run()
  return { ok: true }
}

// The owner spoke to the caller and types who they are: one customer per call (a repeat finds the same one). No automatic
// message goes out for it. → { ok, leadId, bookUrl: their own booking link }
export async function addCaller(env, customer, kind, id, body, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await find(db, customer.id, kind, id)
  if (!row) return { ok: false, error: 'not_found' }
  if (row.lead_id) return { ok: false, error: 'already_linked' }
  const [error, lead] = validateLead({ name: body?.name, phone: body?.phone, need: body?.need, zip: body?.zip, email: '' }, 'at_business', { requireEmail: false, lenientZip: true })
  if (error) return { ok: false, error }
  const leadId = `gc${(await sha256Hex(`${customer.id}:${kind}:${row.id}`)).slice(0, 22)}`
  if (!(await db.prepare('SELECT id FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customer.id).first())) await createLead(env, customer, { ...lead, smsConsent: false, source: 'google_call' }, now, { id: leadId })
  await attribute(db, customer.id, kind, row, leadId, now)
  await linkCall(db, customer.id, kind, id, leadId, now)
  return { ok: true, leadId, bookUrl: await resumeUrl(env, customer.id, leadId) }
}
