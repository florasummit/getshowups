// Business Review engine: turns the capability registry + standard events (audit_log) + records into the founder's
// operational map. Generic: it knows nothing about individual capabilities, so a newly registered capability shows up
// with its status, dependencies, events and incidents without changes here or in the UI.
//
// Status vocabulary (same as the architecture map):
//   live_verified  configured live AND real production activity seen recently (verify().ok)
//   built_tested   configured live, but not seen working recently (or no verification defined)
//   sandbox        works only with test accounts / test mode
//   disabled       built, switched off (usually needs an approval)
//   missing        not built
//   unknown        couldn't be determined (a check failed)
import './catalog.js'
import { JOURNEY, listCapabilities } from './registry.js'
import { buildInfo, configSnapshot, migrationStatus } from './changes.js'
import { listAudit, verifyAuditChain } from '../auditlog.js'
import { customerRows } from '../metrics.js'
import { lifecycle } from '../lifecycle.js'
import { CUSTOMER_RE } from '../invites.js'

const DAY = 86400000
export const STATUS = ['live_verified', 'built_tested', 'sandbox', 'disabled', 'missing', 'unknown']

const safe = async (fn, fallback) => {
  try {
    return await fn()
  } catch (err) {
    console.error('review check failed:', err?.message?.includes('no such table') ? 'table_missing' : err?.name)
    return fallback
  }
}

function statusOf(state, check) {
  if (!state) return 'unknown'
  if (state.mode === 'live') return check?.ok ? 'live_verified' : 'built_tested'
  return ['sandbox', 'disabled', 'missing'].includes(state.mode) ? state.mode : 'unknown'
}

// Failures (14 days) not followed by a success for the same capability + resource: still open.
async function openFailures(db, { capability = null, customer = null, since }) {
  const { results } = await db
    .prepare(
      `SELECT f.seq, f.at, f.action, f.customer, f.capability, f.resource_type, f.resource_id, f.details, f.correlation_id FROM audit_log f
        WHERE f.outcome = 'failure' AND f.at >= ?1 AND (?2 IS NULL OR f.capability = ?2) AND (?3 IS NULL OR f.customer = ?3)
          AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.capability IS f.capability AND s.outcome = 'success' AND s.seq > f.seq
                          AND s.resource_type IS f.resource_type AND s.resource_id IS f.resource_id)
        ORDER BY f.seq DESC LIMIT 100`,
    )
    .bind(since, capability, customer)
    .all()
  const seen = new Set()
  const out = []
  for (const r of results) {
    const key = `${r.capability}|${r.resource_type}|${r.resource_id}`
    if (seen.has(key)) continue // newest failure per resource
    seen.add(key)
    out.push({ at: r.at, action: r.action, customer: r.customer, capability: r.capability, resource: r.resource_type ? { type: r.resource_type, id: r.resource_id } : null, details: JSON.parse(r.details), correlationId: r.correlation_id })
  }
  return out
}

async function eventStats(db, capability, now) {
  const r = await db
    .prepare(
      `SELECT max(CASE WHEN outcome = 'success' THEN at END) AS last_success, max(CASE WHEN outcome = 'failure' THEN at END) AS last_failure,
              sum(CASE WHEN outcome = 'failure' AND at >= ?2 THEN 1 ELSE 0 END) AS failures7, count(*) AS total
         FROM audit_log WHERE capability = ?1`,
    )
    .bind(capability, now - 7 * DAY)
    .first()
  return { lastSuccess: r?.last_success ?? null, lastFailure: r?.last_failure ?? null, failures7: r?.failures7 ?? 0, total: r?.total ?? 0 }
}

export async function capabilityStatuses(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const caps = listCapabilities()
  const rows = []
  for (const c of caps) {
    const state = await safe(() => c.state(env), null)
    const check = c.verify ? await safe(() => c.verify(env, now), { ok: false, at: null, evidence: 'Check failed' }) : null
    const events = await safe(() => eventStats(db, c.id, now), { lastSuccess: null, lastFailure: null, failures7: 0, total: 0 })
    const open = await safe(() => openFailures(db, { capability: c.id, since: now - 14 * DAY }), [])
    rows.push({
      id: c.id,
      name: c.name,
      journey: c.journey,
      description: c.description || null,
      external: c.external || null,
      dependsOn: c.dependsOn,
      status: statusOf(state, check),
      mode: state?.mode ?? 'unknown',
      note: state?.note ?? null,
      approval: state?.approval ?? null,
      blockers: c.blockers,
      verification: check ? { ok: Boolean(check.ok), at: check.at ?? null, evidence: check.evidence ?? null } : null,
      events,
      openFailures: open,
    })
  }
  // Dependencies: names, what each is used by, and which declared dependencies are not usable.
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const r of rows) {
    r.usedBy = rows.filter((x) => x.dependsOn.includes(r.id)).map((x) => x.id)
    r.blockedBy = r.dependsOn.filter((d) => !byId.has(d) || ['disabled', 'missing', 'unknown'].includes(byId.get(d).status))
  }
  return rows
}

export async function platformReview(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const capabilities = await capabilityStatuses(env, now)
  const businesses = await safe(() => customerRows(env, now), [])
  const build = await buildInfo(env)
  const migrations = await safe(() => migrationStatus(env, build), null)
  const chain = await safe(() => verifyAuditChain(db), null)
  const changes = await safe(() => listAudit(db, { capability: 'platform.release', limit: 20 }), [])
  const incidents = []
  for (const c of capabilities) {
    for (const f of c.openFailures) incidents.push({ kind: 'failure', severity: 'high', capability: c.id, customer: f.customer, at: f.at, title: `${f.action} failed`, detail: f.details?.code || f.details?.error || null, resource: f.resource })
    // Seen working before, quiet now: a possible regression. (Never seen yet is not an incident; it shows as Built + tested.)
    if (c.status === 'built_tested' && c.verification && !c.verification.ok && c.verification.at && c.mode === 'live') incidents.push({ kind: 'not_verified', severity: 'medium', capability: c.id, at: c.verification.at, title: `${c.name}: not seen working recently`, detail: c.verification.evidence })
    if (c.status === 'unknown') incidents.push({ kind: 'unknown', severity: 'medium', capability: c.id, title: `${c.name}: status unknown`, detail: c.note })
  }
  for (const b of businesses.filter((x) => x.attention?.length && !x.testBusiness)) incidents.push({ kind: 'business', severity: b.attention.some((a) => ['ads_running_on_hold', 'deletion_stuck', 'past_due'].includes(a)) ? 'high' : 'low', customer: b.id, title: b.name, detail: b.attention.join(', ') })
  if (chain && !chain.ok) incidents.unshift({ kind: 'audit', severity: 'high', capability: 'platform.audit', title: `Audit log integrity check failed at entry ${chain.brokenAt}`, detail: chain.reason })
  const pending = (migrations || []).filter((m) => m.applied === false)
  for (const m of pending) incidents.push({ kind: 'migration', severity: 'medium', title: `Migration ${m.file} not applied`, detail: `missing: ${m.missing.join(', ')}` })
  const rank = { high: 0, medium: 1, low: 2 }
  incidents.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.at || 0) - (a.at || 0))
  const approvals = capabilities.filter((c) => c.approval && ['disabled', 'sandbox'].includes(c.status)).map((c) => ({ capability: c.id, name: c.name, approval: c.approval }))
  const blocked = capabilities.filter((c) => c.blockers.length || c.blockedBy.length).map((c) => ({ capability: c.id, name: c.name, blockers: c.blockers, blockedBy: c.blockedBy }))
  const counts = Object.fromEntries(STATUS.map((s) => [s, capabilities.filter((c) => c.status === s).length]))
  return {
    generatedAt: now,
    journey: JOURNEY.map((j) => ({ ...j, capabilities: capabilities.filter((c) => c.journey === j.id).map((c) => c.id) })),
    capabilities,
    counts,
    incidents,
    approvals,
    blocked,
    release: { build: build ? { commit: build.commit, builtAt: build.builtAt, branch: build.branch } : null, migrations, config: configSnapshot(env), history: changes },
    audit: chain ? { ok: chain.ok, checked: chain.checked ?? null, brokenAt: chain.brokenAt ?? null } : null,
    businesses: businesses.map((b) => ({ id: b.id, name: b.name, deleted: Boolean(b.deleted), testBusiness: b.testBusiness, attention: b.attention })),
  }
}

// One business: lifecycle, setup, connections, ads, funnel counts, per-capability status, events, open failures.
// Counts only for leads/appointments (no names, emails, phones or addresses).
export async function businessReview(env, id, now = Date.now()) {
  if (!CUSTOMER_RE.test(id || '')) return null
  const db = env.ONBOARDING_DB
  const summary = (await customerRows(env, now)).find((c) => c.id === id)
  if (!summary) return null
  const since30 = now - 30 * DAY
  const REAL = "NOT EXISTS (SELECT 1 FROM test_marks t WHERE t.lead_id = l.id AND t.is_test = 1)"
  const funnel = await safe(
    () =>
      db
        .prepare(
          `SELECT (SELECT count(*) FROM leads l WHERE l.customer = ?1 AND ${REAL}) AS leads,
                  (SELECT count(*) FROM leads l WHERE l.customer = ?1 AND l.created_at >= ?2 AND ${REAL}) AS leads30,
                  (SELECT count(*) FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.status IN ('booked','showed','no_show') AND ${REAL}) AS booked,
                  (SELECT count(*) FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.status = 'showed' AND ${REAL}) AS showed,
                  (SELECT count(*) FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.status = 'no_show' AND ${REAL}) AS no_show,
                  (SELECT count(*) FROM leads l WHERE l.customer = ?1 AND NOT ${REAL}) AS test_leads`,
        )
        .bind(id, since30)
        .first(),
    {},
  )
  const attribution = await safe(async () => (await db.prepare('SELECT source, count(*) AS n FROM lead_attribution WHERE customer = ?1 GROUP BY source').bind(id).all()).results, [])
  const campaigns = await safe(
    async () =>
      (await db.prepare('SELECT id, platform, status, daily_budget_cents, platform_campaign_id IS NOT NULL AS launched, last_error, updated_at FROM ad_campaigns WHERE customer = ?1 AND status <> ? ORDER BY updated_at DESC LIMIT 20').bind(id, 'removed').all()).results.map((c) => ({
        id: c.id,
        platform: c.platform,
        status: c.status,
        dailyBudgetCents: c.daily_budget_cents,
        launched: Boolean(c.launched),
        lastError: c.last_error,
        updatedAt: c.updated_at,
      })),
    [],
  )
  const budget = await safe(() => db.prepare('SELECT monthly_cents, approved_at FROM ad_budget_approvals WHERE customer = ?1 AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1').bind(id).first(), null)
  const caps = []
  for (const c of listCapabilities()) {
    if (!c.business) continue
    const r = await safe(() => c.business(env, id), { status: 'unknown', summary: 'Check failed' })
    if (r) caps.push({ id: c.id, name: c.name, journey: c.journey, ...r })
  }
  return {
    id,
    name: summary.name,
    deleted: Boolean(summary.deleted),
    testBusiness: summary.testBusiness,
    status: summary.status,
    onboarding: summary.onboarding,
    createdAt: summary.createdAt,
    attention: summary.attention,
    website: summary.website,
    calendarConnected: summary.calendarConnected,
    lifecycle: await safe(() => lifecycle(env, id, now), null),
    funnel,
    attribution,
    ads: { campaigns, budget: budget ? { monthlyCents: budget.monthly_cents, approvedAt: budget.approved_at } : null },
    capabilities: caps,
    events: await safe(() => listAudit(db, { customer: id, limit: 50 }), []),
    openFailures: await safe(() => openFailures(db, { customer: id, since: now - 14 * DAY }), []),
  }
}
