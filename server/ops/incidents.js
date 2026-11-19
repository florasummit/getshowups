// Incident register (migration 0031): automatic incident + bug reports for customer-impacting failures.
// Detection reuses the founder-alert rules (server/alerts.js detectIncidents: calendar, availability, comms) plus every
// other open failure event in audit_log (recordEvent outcome 'failure' without a later success), grouped per
// feature + business + action. One OPEN row per fingerprint (dedupe); each cron run updates occurrences/last_seen/
// evidence and resolves on evidence only:
//   success_seen     a later success event for the same feature + resource (availability, generic failures)
//   connected        the hourly calendar check finds a calendar again
//   no_new_failures  no delivery failure within the rule's window (comms; there is no "success" signal)
// Causes come from a fixed table (CAUSES) keyed by error code: confirmed / suspected / unknown. Nothing is inferred.
// Evidence: allowlisted keys, codes, counts, times, audit_log seqs only (≤ 2 KB). Test businesses: recorded, tagged
// is_test, never counted as customer impact. Never throws (cron step).
import { detectIncidents, kvCheckDue } from '../alerts.js'
import { recordEvent } from '../auditlog.js'
import { randomToken } from '../google-oauth.js'
import { statusIn, testStatuses } from '../testbusiness.js'
import './catalog.js' // capability journeys (cycle-safe: only read inside functions)
import { listCapabilities } from './registry.js'

const DAY = 86400000
export const RETENTION_MS = 365 * DAY
export const FAILURE_LOOKBACK_MS = 14 * DAY

export const RULES = {
  calendar: {
    feature: 'calendar.google', journey: 'booking', step: 'availability', severity: 'critical',
    impact: 'Customers can’t see or book times on this business’s booking page.',
    recovery: 'Ask the owner to reconnect Google Calendar (their dashboard shows "Needs reconnecting"). If several businesses fail at once, check Google’s status first.',
  },
  availability: {
    feature: 'calendar.google', journey: 'booking', step: 'availability', severity: 'high',
    impact: 'The booking page shows no times although the business may have free time.',
    recovery: 'Run "Diagnose calendar" for this account. If other businesses fail too, it is likely provider-wide; if only this one, ask the owner to reconnect.',
  },
  comms: {
    feature: 'messaging.email', journey: 'booking', step: 'confirmation', severity: 'high',
    impact: 'Customers or the owner did not receive messages.',
    recovery: 'Check the email/SMS provider status and the failure codes in the evidence. Failed messages are not resent automatically.',
  },
  failure: {
    feature: null, journey: null, step: null, severity: 'medium',
    impact: 'A recorded operation failed and has not succeeded since.',
    recovery: 'Open the event in Business Review for this business and retry the action once the cause is fixed.',
  },
}
// Error code → [cause certainty, fixed explanation]. Anything not listed is 'unknown' (shown as such).
export const CAUSES = {
  reconnect_required: ['confirmed', 'Google reported the grant is no longer valid (invalid_grant); the owner must reconnect.'],
  not_connected: ['confirmed', 'No calendar connection is stored for this business.'],
  decrypt_failed: ['confirmed', 'The stored calendar credential can’t be decrypted.'],
  record_invalid: ['confirmed', 'The stored calendar connection record is malformed.'],
  token_refresh_failed: ['suspected', 'Google refused or failed the token refresh without a definitive reason.'],
  test_mode: ['confirmed', 'The launch gate held the message (test mode).'],
}
export const causeFor = (code) => CAUSES[code] || ['unknown', null]
const HIGH_FEATURES = new Set(['calendar.google', 'billing.stripe', 'messaging.email', 'messaging.sms', 'receptionist.voice', 'receptionist.chat'])

const EVIDENCE_KEYS = ['code', 'error', 'source', 'failedLookups30m', 'failedLastHour', 'failedConfirmations', 'firstSeen', 'lastSeen', 'events', 'action', 'capability', 'resource', 'count']
export function sanitizeEvidence(e) {
  const out = {}
  for (const k of EVIDENCE_KEYS) {
    const v = e?.[k]
    if (v == null) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'string') out[k] = v.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48)
    else if (Array.isArray(v)) out[k] = v.filter((x) => Number.isInteger(x)).slice(-10)
  }
  const s = JSON.stringify(out)
  return s.length <= 2048 ? s : '{}'
}

// Open failure groups other than availability (handled by its own rule) and our own bookkeeping events.
async function openFailureGroups(db, now) {
  const { results } = await db
    .prepare(
      `SELECT f.seq, f.at, f.action, f.customer, f.capability, f.resource_type, f.details FROM audit_log f
        WHERE f.outcome = 'failure' AND f.at >= ?1 AND f.capability IS NOT NULL
          AND f.capability NOT IN ('platform.alerts', 'platform.incidents')
          AND f.action NOT IN ('followups.send_failed', 'followups.delivery_failed') -- counted by the comms rule
          AND NOT (f.capability = 'calendar.google' AND f.resource_type = 'availability')
          AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.capability IS f.capability AND s.outcome = 'success' AND s.seq > f.seq
                          AND s.resource_type IS f.resource_type AND s.resource_id IS f.resource_id)
        ORDER BY f.seq LIMIT 500`,
    )
    .bind(now - FAILURE_LOOKBACK_MS)
    .all()
  const groups = new Map()
  for (const r of results) {
    const fp = `failure:${r.capability}:${r.customer || 'platform'}:${r.action}`
    const g = groups.get(fp) || { fingerprint: fp, kind: 'failure', customer: r.customer || null, feature: r.capability, step: r.action, firstSeen: r.at, count: 0, events: [] }
    g.count++
    g.lastSeen = r.at
    g.events.push(r.seq)
    try {
      const d = JSON.parse(r.details || '{}')
      g.code = String(d.error || d.code || d.reason || r.action).slice(0, 40)
    } catch {
      g.code = r.action
    }
    groups.set(fp, g)
  }
  return groups
}

// Still-open availability failures for one business (no later success): count, last, newest code.
async function openAvailability(db, customer, since) {
  const r = await db
    .prepare(
      `SELECT count(*) AS n, max(f.at) AS last, max(f.seq) AS seq FROM audit_log f
        WHERE f.customer = ?1 AND f.capability = 'calendar.google' AND f.resource_type = 'availability' AND f.outcome = 'failure' AND f.at >= ?2
          AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.capability = 'calendar.google' AND s.resource_type = 'availability' AND s.resource_id = f.resource_id AND s.outcome = 'success' AND s.seq > f.seq)`,
    )
    .bind(customer, since)
    .first()
  return r?.n ? { count: r.n, last: r.last, seq: r.seq } : null
}

// A success for the incident's feature + business recorded after its first failure (generic incidents).
const successSince = async (db, inc) =>
  Boolean(
    await db
      .prepare("SELECT 1 FROM audit_log WHERE capability = ?1 AND customer IS ?2 AND outcome = 'success' AND at >= ?3 LIMIT 1")
      .bind(inc.feature, inc.customer, inc.first_seen)
      .first(),
  )

const journeyOf = (feature) => listCapabilities().find((c) => c.id === feature)?.journey || 'platform'

function fromDetector(a) {
  const source = a.kind === 'calendar' && String(a.key).startsWith('d') ? 'kv' : 'lookup'
  const fingerprint = a.kind === 'calendar' ? `calendar:${a.customer}:${source}` : `${a.kind}:${a.customer}`
  const f = a.facts || {}
  const code = f.error || (a.kind === 'comms' ? (f.failedConfirmations ? 'confirmation_failed' : 'delivery_failed') : 'unknown')
  const severity = a.kind === 'comms' && f.failedConfirmations ? 'critical' : RULES[a.kind].severity
  return { fingerprint, kind: a.kind, customer: a.customer, feature: RULES[a.kind].feature, step: RULES[a.kind].step, code, severity, source, firstSeen: f.firstSeen || null, lastSeen: f.lastSeen || null, count: f.failedLookups30m || f.failedLastHour || 1, evidence: { ...f, source } }
}

export async function registerReady(db) {
  try {
    await db.prepare('SELECT 1 FROM ops_incidents LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

export async function syncIncidents(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await registerReady(db))) return { ready: false }
  const out = { ready: true, opened: 0, updated: 0, resolved: 0 }
  try {
    const tests = await testStatuses(env)
    const isTest = (c) => (c ? (tests === null ? true : statusIn(tests, c).test) : false)
    const detected = new Map()
    for (const a of await detectIncidents(env, now)) {
      const d = fromDetector(a)
      detected.set(d.fingerprint, d)
    }
    const generic = await openFailureGroups(db, now)
    const kvRan = kvCheckDue(now)

    const { results: open } = await db.prepare("SELECT * FROM ops_incidents WHERE status = 'open' LIMIT 500").all()
    for (const inc of open) {
      let still = null
      let resolution = 'success_seen'
      if (inc.kind === 'availability' || (inc.kind === 'calendar' && inc.fingerprint.endsWith(':lookup'))) {
        const oa = await openAvailability(db, inc.customer, inc.first_seen - 60000)
        if (oa) still = { lastSeen: oa.last, count: oa.count, evidence: { ...JSON.parse(inc.evidence || '{}'), lastSeen: oa.last, count: oa.count } }
      } else if (inc.kind === 'calendar') {
        if (!kvRan) still = { lastSeen: inc.last_seen, count: inc.occurrences, evidence: JSON.parse(inc.evidence || '{}') }
        else if (detected.has(inc.fingerprint)) still = { lastSeen: now, count: inc.occurrences + 1, evidence: JSON.parse(inc.evidence || '{}') }
        resolution = 'connected'
      } else if (inc.kind === 'comms') {
        const d = detected.get(inc.fingerprint)
        if (d) still = { lastSeen: now, count: Math.max(inc.occurrences, d.count), evidence: d.evidence }
        resolution = 'no_new_failures'
      } else {
        const g = generic.get(inc.fingerprint)
        if (g) still = { lastSeen: g.lastSeen, count: g.count, evidence: { code: g.code, action: g.step, capability: g.feature, events: g.events, count: g.count } }
        // Gone from the open-failure groups: either a later success closed it, or the failures aged out of the
        // lookback window without one. Only the first is "success seen".
        else if (!(await successSince(db, inc))) resolution = 'no_new_failures'
      }
      detected.delete(inc.fingerprint)
      generic.delete(inc.fingerprint)
      if (still) {
        await db
          .prepare("UPDATE ops_incidents SET last_seen = max(last_seen, ?2), occurrences = max(occurrences, ?3), evidence = ?4 WHERE id = ?1 AND status = 'open'")
          .bind(inc.id, still.lastSeen || inc.last_seen, still.count || inc.occurrences, sanitizeEvidence(still.evidence))
          .run()
        out.updated++
      } else {
        await db.prepare("UPDATE ops_incidents SET status = 'resolved', resolved_at = ?2, resolution = ?3 WHERE id = ?1 AND status = 'open'").bind(inc.id, now, resolution).run()
        await recordEvent(db, { type: 'incident.resolved', actor: 'system:incidents', customer: inc.customer, capability: 'platform.incidents', resource: { type: 'incident', id: inc.id }, outcome: 'success', details: { kind: inc.kind, code: inc.code, resolution }, at: now })
        out.resolved++
      }
    }

    const fresh = [...detected.values()]
    for (const g of generic.values()) {
      fresh.push({ ...g, severity: HIGH_FEATURES.has(g.feature) ? 'high' : 'medium', evidence: { code: g.code, action: g.step, capability: g.feature, events: g.events, count: g.count } })
    }
    for (const d of fresh) {
      const rule = RULES[d.kind]
      const feature = d.feature || rule.feature
      const [cause] = causeFor(d.code)
      const id = `inc_${randomToken(9)}`
      const r = await db
        .prepare(
          `INSERT OR IGNORE INTO ops_incidents (id, fingerprint, customer, feature, journey, step, kind, code, severity, cause, status, is_test, evidence, occurrences, first_seen, last_seen, detected_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11, ?12, ?13, ?14, ?15, ?16)`,
        )
        .bind(id, d.fingerprint, d.customer, feature, rule.journey || journeyOf(feature), d.step || rule.step || 'unknown', d.kind, String(d.code).slice(0, 40), d.severity || rule.severity, cause, isTest(d.customer) ? 1 : 0, sanitizeEvidence(d.evidence), d.count || 1, d.firstSeen || now, d.lastSeen || now, now)
        .run()
      if ((r?.meta?.changes ?? 0) > 0) {
        out.opened++
        await recordEvent(db, { type: 'incident.opened', actor: 'system:incidents', customer: d.customer, capability: 'platform.incidents', resource: { type: 'incident', id }, outcome: 'info', details: { kind: d.kind, code: String(d.code).slice(0, 40) }, at: now })
      }
    }
    await db.prepare("DELETE FROM ops_incidents WHERE status = 'resolved' AND resolved_at < ?1").bind(now - RETENTION_MS).run()
    return out
  } catch (err) {
    console.error('incidents sync failed:', err?.name)
    return { ...out, error: 'failed' }
  }
}

// Read side (admin only; routes check requirePlatformAdmin). Adds the rule text (impact, cause note, recovery).
export function present(row) {
  const rule = RULES[row.kind] || RULES.failure
  const [, causeNote] = causeFor(row.code)
  let evidence = {}
  try {
    evidence = JSON.parse(row.evidence || '{}')
  } catch {}
  return {
    id: row.id, fingerprint: row.fingerprint, customer: row.customer, feature: row.feature, journey: row.journey, step: row.step, kind: row.kind,
    code: row.code, severity: row.severity, cause: row.cause, causeNote, impact: rule.impact, recovery: rule.recovery, status: row.status,
    test: Boolean(row.is_test), evidence, occurrences: row.occurrences, firstSeen: row.first_seen, lastSeen: row.last_seen,
    detectedAt: row.detected_at, resolvedAt: row.resolved_at, resolution: row.resolution,
  }
}
const SEV = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
export async function listIncidents(db, { customer = null, status = null, limit = 50 } = {}) {
  if (!(await registerReady(db))) return []
  const { results } = await db
    .prepare(`SELECT * FROM ops_incidents WHERE (?1 IS NULL OR customer = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY status = 'open' DESC, ${SEV}, last_seen DESC LIMIT ?3`)
    .bind(customer, status, Math.min(Math.max(Number(limit) || 50, 1), 200))
    .all()
  return results.map(present)
}
