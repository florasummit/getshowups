// Phone calls from Google ads, as Google reports them (migration 0040; docs/GOOGLE_ACQUISITION.md "Calls"). Google's native
// forwarding keeps the business's own number; we only read (no line, routing or recording here). Google never tells who
// called, so calls are never matched to people automatically: the owner links a call to a customer or adds the caller.
// An added caller keeps the campaign Google named; a person already recorded keeps the source they came from first.
import { sha256Hex } from '../google-oauth.js'
import { createLead, validateLead } from '../booking.js'
import { zonedToUtc } from '../calendar.js'
import { resumeUrl } from '../links.js'
import { internalEmails, isTestLead } from '../testdata.js'
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

// Off unless exactly 'true': the privacy policy has to name call records before any are read (approval).
export const callsOn = (env) => env.GOOGLE_CALLS_ENABLED === 'true'

// 90 days the first time (or for another Ads account), otherwise since a week before the last read. A few statements whatever
// the number of calls: the scheduled job shares one query budget. Owner marks and links are never overwritten.
export async function syncCalls(env, customerId, { now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  if (!callsOn(env) || !(await callsReady(db))) return { ok: true, skipped: 'not_ready' }
  const [seen, conn] = await Promise.all([
    db.prepare('SELECT checked_at, account_id FROM google_call_setup WHERE customer = ?1').bind(customerId).first(),
    db.prepare("SELECT account_id FROM ad_connections WHERE customer = ?1 AND platform = 'google'").bind(customerId).first(),
  ])
  const from = seen && seen.account_id === String(conn?.account_id) ? Math.max(now - 90 * DAY, Math.min(now, seen.checked_at) - 7 * DAY) : now - 90 * DAY
  const r = await readCalls(env, customerId, day(from))
  if (!r.ok) return r
  const rows = r.calls.map((c) => ({ ...c, at: instant(c.localTime, r.timeZone) })).filter((c) => c.at !== null)
  const stmts = []
  for (let i = 0; i < rows.length; i += 200)
    stmts.push(
      db
        .prepare(
          `INSERT INTO google_calls (id, customer, campaign_external_id, local_time, started_at, duration_seconds, status, shown_on, synced_at)
           SELECT json_extract(j.value,'$.id'), ?1, json_extract(j.value,'$.campaignExternalId'), json_extract(j.value,'$.localTime'), json_extract(j.value,'$.at'), json_extract(j.value,'$.seconds'), json_extract(j.value,'$.status'), json_extract(j.value,'$.shownOn'), ?2 FROM json_each(?3) j WHERE true
           ON CONFLICT(customer, id) DO UPDATE SET campaign_external_id = excluded.campaign_external_id, local_time = excluded.local_time, started_at = excluded.started_at, duration_seconds = excluded.duration_seconds, status = excluded.status, shown_on = excluded.shown_on, synced_at = excluded.synced_at`,
        )
        .bind(customerId, now, JSON.stringify(rows.slice(i, i + 200))),
    )
  stmts.push(
    db
      .prepare('INSERT INTO google_call_setup (customer, account_id, reporting, numbers_on_ads, time_zone, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(customer) DO UPDATE SET account_id = ?2, reporting = ?3, numbers_on_ads = ?4, time_zone = ?5, checked_at = ?6')
      .bind(customerId, r.accountId, r.reporting === null ? null : Number(r.reporting), r.numbersOnAds, r.timeZone, now),
  )
  await db.batch(stmts)
  return { ok: true, calls: rows.length }
}

// What the linked people did SINCE their first linked call (an older job isn't this call's result), each person once.
async function outcomes(db, customerId, table, since, internal) {
  const t = table === 'lsa_leads' ? 'created_at' : 'started_at'
  const mine = 'JOIN p ON p.id = a.lead_id WHERE a.customer = ?1 AND a.created_at >= p.since - 3600000'
  return db
    .prepare(
      `WITH p AS (SELECT l.id, min(g.${t}) AS since FROM ${table} g JOIN leads l ON l.id = g.lead_id AND l.customer = g.customer WHERE g.customer = ?1 AND g.${t} >= ?2 AND NOT ${isTestLead('l', '?3')} GROUP BY l.id)
       SELECT (SELECT count(*) FROM p) AS people,
              (SELECT count(DISTINCT a.lead_id) FROM appointments a ${mine} AND a.status IN ('booked','showed','no_show')) AS booked,
              (SELECT count(DISTINCT a.lead_id) FROM appointments a JOIN appointment_outcomes o ON o.appointment_id = a.id AND o.customer = a.customer ${mine} AND a.status = 'showed' AND o.work = 'completed') AS completed,
              (SELECT sum(x.amount_cents) FROM appointments a JOIN revenue_entries x ON x.appointment_id = a.id AND x.customer = a.customer ${mine} AND a.status = 'showed' AND x.kind = 'paid'
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
// another way isn't moved to the ad because they also called. Whoever it was linked to before loses only what adding them from
// this call recorded. Refused when the link changed meanwhile.
export async function linkCall(db, customerId, kind, id, leadId, now = Date.now(), expected) {
  const row = await find(db, customerId, kind, id)
  if (!row) return { ok: false, error: 'not_found' }
  const before = row.lead_id ?? null
  if (expected !== undefined && expected !== before) return { ok: false, error: 'already_linked' }
  if (leadId && !(await db.prepare('SELECT id FROM leads WHERE id = ?1 AND customer = ?2').bind(String(leadId), customerId).first())) return { ok: false, error: 'lead_not_found' }
  const r = await db.prepare(`UPDATE ${TABLE[kind]} SET lead_id = ?3 WHERE customer = ?1 AND id = ?2 AND lead_id IS ?4`).bind(customerId, String(row.id), leadId ? String(leadId) : null, before).run()
  if (!r?.meta?.changes) return { ok: false, error: 'already_linked' }
  if (before && before !== leadId)
    await db
      .prepare("DELETE FROM lead_attribution WHERE customer = ?1 AND lead_id = ?2 AND json_extract(details, '$.via') = ?3 AND json_extract(details, '$.ref') = ?4")
      .bind(customerId, before, kind === 'lsa' ? 'local_services' : 'google_call', String(row.id))
      .run()
  return { ok: true }
}

const DIGITS = ["' '", "'-'", "'('", "')'", "'.'", "'+'"].reduce((sql, c) => `replace(${sql}, ${c}, '')`, 'phone')
// The owner spoke to the caller and types who they are. A phone number already on record is that person, never a second one;
// the same call and number again is a retry. No automatic message and no notice goes out (the owner did this themselves). The
// inquiry is dated when they called. → { ok, leadId, bookUrl: their own booking link, when times can be booked }
export async function addCaller(env, customer, kind, id, body, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await find(db, customer.id, kind, id)
  if (!row) return { ok: false, error: 'not_found' }
  const [error, lead] = validateLead({ name: body?.name, phone: body?.phone, need: body?.need, zip: body?.zip, address: body?.address, email: '', zipConfirmed: true }, customer.appointmentMode, { requireEmail: false })
  if (error) return { ok: false, error }
  if (customer.serviceZips?.length && !lead.zip) return { ok: false, error: 'invalid_zip' }
  const phone = lead.phone.replace(/\D/g, '').slice(-10)
  const leadId = `gcall_${(await sha256Hex(`${customer.id}:${kind}:${row.id}:${phone}`)).slice(0, 22)}`
  // Already added by the same call and number (a retry after a failure in between): finished, never a second one.
  if (row.lead_id && row.lead_id !== leadId) return { ok: false, error: 'already_linked' }
  const known = await db.prepare(`SELECT id, name FROM leads l WHERE NOT ${isTestLead('l', '?4')} AND customer = ?1 AND substr(${DIGITS}, -10) = ?2 AND id <> ?3 ORDER BY created_at LIMIT 1`).bind(customer.id, phone, leadId, internalEmails(env)).first()
  if (known) return { ok: false, error: 'already_customer', lead: { id: known.id, name: known.name } }
  const read = () => db.prepare('SELECT id, status FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customer.id).first()
  if (!(await read()))
    await createLead(env, customer, { ...lead, smsConsent: false, source: 'google_call' }, Math.min(now, kind === 'lsa' ? row.created_at : row.started_at), { id: leadId }).catch(async (err) => {
      if (!(await read())) throw err // the same form sent twice at once: one of them made it
    })
  if (!row.lead_id) {
    const linked = await linkCall(db, customer.id, kind, id, leadId, now, null)
    if (!linked.ok) return linked
  }
  await attribute(db, customer.id, kind, row, leadId, now)
  const status = (await read())?.status
  return { ok: true, leadId, ...(status === 'new' ? { bookUrl: await resumeUrl(env, customer.id, leadId) } : { notBookable: status === 'unqualified' ? 'outside_area' : 'booked' }) }
}
