// Google Ads conversion feedback (off unless ADS_CONVERSIONS_ENABLED is exactly 'true', which needs approval: it
// adds the sensitive Data Manager OAuth scope). Since June 15, 2026 Google accepts new offline conversion uploads
// only through the Data Manager API (docs/GOOGLE_ADS_COMPLIANCE.md); conversion actions are still created with the
// Google Ads API.
//
// What is sent: for leads that came from a GetShowUps Google campaign (utm + gclid), three facts the business's own
// records hold: the request (lead), the booking, and the completed job (with the owner-reported value, when given).
// Never fabricated, never test records, never personal data (only the ad click id). Each event has a stable
// transactionId per conversion action, so retries and repeats are deduplicated by Google and by us (ad_actions id).
// No consent fields are sent: GetShowUps doesn't collect ad-data consent from customers, so it never claims it.
// Click ids are stored encrypted and deleted after 90 days.
import { encrypt, decrypt } from '../google-oauth.js'
import { isTestLead, internalEmails } from '../testdata.js'

export const conversionsEnabled = (env) => env?.ADS_CONVERSIONS_ENABLED === 'true'
export const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager'
const CLICK_ID_DAYS = 90
const MAX_ATTEMPTS = 5

// The conversion actions GetShowUps keeps in a connected account. Only the booking counts for bidding.
export const ACTIONS = {
  booked: { name: 'GetShowUps: booked appointment', category: 'BOOK_APPOINTMENT', primary: true },
  lead: { name: 'GetShowUps: booking request', category: 'SUBMIT_LEAD_FORM', primary: false },
  completed: { name: 'GetShowUps: completed job', category: 'CONVERTED_LEAD', primary: false },
}

const GCLID = /^[A-Za-z0-9_-]{10,200}$/
// Encrypted click id to keep with an attributed lead (only when conversion reporting is on).
export async function sealClickId(env, gclid) {
  if (!conversionsEnabled(env) || typeof gclid !== 'string' || !GCLID.test(gclid)) return null
  return encrypt(env, gclid)
}

// Cron: drop click ids older than 90 days (Google can't use them after that). Runs whether or not reporting is on.
export async function purgeClickIds(env, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare(
    "UPDATE lead_attribution SET details = json_remove(details, '$.gclidEnc') WHERE created_at < ?1 AND json_extract(details, '$.gclidEnc') IS NOT NULL",
  )
    .bind(now - CLICK_ID_DAYS * 86400000)
    .run()
  return { purged: r?.meta?.changes ?? 0 }
}

// RFC 3339 with offset (Data Manager eventTimestamp).
const rfc3339 = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// Conversion events still to report for one business (≤ limit), oldest first. Pure read.
export async function pendingEvents(env, customerId, now = Date.now(), limit = 200) {
  const db = env.ONBOARDING_DB
  const since = now - CLICK_ID_DAYS * 86400000
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT 'lead' AS kind, l.id AS entity, l.created_at AS at, NULL AS value_cents, a.details FROM lead_attribution a JOIN leads l ON l.id = a.lead_id
           WHERE a.customer = ?1 AND a.source = 'google_ads' AND a.created_at >= ?2 AND NOT ${isTestLead('l', '?3')}
         UNION ALL
         SELECT 'booked', p.id, p.created_at, NULL, a.details FROM appointments p JOIN leads l ON l.id = p.lead_id JOIN lead_attribution a ON a.lead_id = l.id
           WHERE a.customer = ?1 AND a.source = 'google_ads' AND a.created_at >= ?2 AND p.status IN ('booked', 'showed') AND NOT ${isTestLead('l', '?3')}
         UNION ALL
         SELECT 'completed', o.appointment_id, o.reported_at, o.value_cents, a.details FROM appointment_outcomes o JOIN appointments p ON p.id = o.appointment_id
           JOIN leads l ON l.id = p.lead_id JOIN lead_attribution a ON a.lead_id = l.id
           WHERE a.customer = ?1 AND a.source = 'google_ads' AND a.created_at >= ?2 AND o.work = 'completed' AND NOT ${isTestLead('l', '?3')}
       ) e
       WHERE json_extract(e.details, '$.gclidEnc') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ad_actions x WHERE x.id = 'conv:' || e.kind || ':' || e.entity AND (x.status IN ('applied', 'skipped') OR json_extract(x.details, '$.attempts') >= ${MAX_ATTEMPTS}))
       ORDER BY e.at LIMIT ?4`,
    )
    .bind(customerId, since, internalEmails(env), limit)
    .all()
  return results
}

async function record(db, customerId, kind, entity, status, reason, details, now) {
  const id = `conv:${kind}:${entity}`
  const prev = await db.prepare('SELECT details FROM ad_actions WHERE id = ?1').bind(id).first()
  const attempts = (prev ? JSON.parse(prev.details || '{}').attempts || 0 : 0) + (status === 'failed' ? 1 : 0)
  const body = JSON.stringify({ ...details, attempts })
  if (prev) await db.prepare('UPDATE ad_actions SET status = ?2, reason = ?3, details = ?4, at = ?5 WHERE id = ?1').bind(id, status, reason, body, now).run()
  else await db.prepare("INSERT INTO ad_actions (id, customer, campaign_id, actor, kind, status, reason, details, at) VALUES (?1, ?2, NULL, 'system', 'conversion', ?3, ?4, ?5, ?6)").bind(id, customerId, status, reason, body, now).run()
}

// Cron: report pending conversions per business through the adapter (Data Manager ingest). Only when enabled and the
// business's Google sign-in granted the Data Manager scope. Fast-fail API: a request either imports all or nothing.
export async function uploadConversions(env, adapter, { now = Date.now(), limit = 20 } = {}) {
  if (!conversionsEnabled(env)) return { enabled: 0 } // counts only (cron reports numbers)
  const db = env.ONBOARDING_DB
  const { results: conns } = await db.prepare("SELECT customer, account_id, extra FROM ad_connections WHERE platform = 'google' AND status = 'connected' LIMIT ?1").bind(limit).all()
  const summary = { sent: 0, failed: 0, skipped: 0, businesses: 0 }
  for (const conn of conns) {
    const extra = JSON.parse(conn.extra || '{}')
    const actionIds = extra.conversionActions || {}
    const events = await pendingEvents(env, conn.customer, now)
    if (!events.length) continue
    summary.businesses++
    for (const kind of Object.keys(ACTIONS)) {
      const batch = events.filter((e) => e.kind === kind)
      if (!batch.length) continue
      if (!actionIds[kind]) {
        summary.skipped += batch.length // set up when the owner creates a campaign (ensureConversionActions)
        continue
      }
      const prepared = []
      for (const e of batch) {
        let gclid = null
        try {
          gclid = await decrypt(env, JSON.parse(e.details).gclidEnc)
        } catch {}
        if (!gclid || !GCLID.test(gclid)) {
          await record(db, conn.customer, kind, e.entity, 'skipped', 'Click id unreadable', {}, now)
          summary.skipped++
          continue
        }
        prepared.push({
          entity: e.entity,
          event: {
            transactionId: `${kind}:${e.entity}`,
            eventTimestamp: rfc3339(e.at),
            eventSource: 'WEB',
            adIdentifiers: { gclid },
            ...(kind === 'completed' && Number.isInteger(e.value_cents) && e.value_cents > 0 ? { conversionValue: e.value_cents / 100, currency: extra.currency || 'USD' } : {}),
          },
        })
      }
      if (!prepared.length) continue
      const r = await adapter.ingestConversions(env, conn.customer, actionIds[kind], prepared.map((p) => p.event))
      if (r.error === 'scope_missing') {
        summary.skipped += prepared.length // the owner reconnects once to grant conversion reporting; nothing recorded
        continue
      }
      for (const p of prepared) {
        if (r.ok) await record(db, conn.customer, kind, p.entity, 'applied', `Reported to Google Ads (${kind})`, { requestId: r.requestId || null }, now)
        else if (r.retryable) await record(db, conn.customer, kind, p.entity, 'failed', `Google Ads didn't accept it yet (${r.error}); will retry`, { error: r.error }, now)
        else await record(db, conn.customer, kind, p.entity, 'skipped', `Google Ads refused it (${r.error})`, { error: r.error }, now)
      }
      if (r.ok) summary.sent += prepared.length
      else summary.failed += prepared.length
    }
  }
  return summary
}
