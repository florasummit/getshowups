// What the vault reads from the business (docs/RESEARCH_VAULT.md). One source of truth for every metric: the SAME
// functions the dashboards use (server/growth.js growthMeasure for GetShowUps itself, server/ads/funnel.js funnel for a
// business, server/ai-budget.js for AI spend). Nothing is recomputed differently here.
// Data scope: GetShowUps corporate metrics, and per-business funnels ONLY for GetShowUps-owned businesses (account type
// internal_live, e.g. PoolThru). Customer businesses are never read: cross-account research needs a legal basis and
// customer permission that don't exist yet (crossAccount below says so). Every value carries a data kind:
// measured | estimated | simulated | test | missing | unverified. Missing data is reported as missing, never filled in.
import { growthMeasure } from '../growth.js'
import { funnel } from '../ads/funnel.js'
import { accountsMap } from '../business-accounts.js'
import { internalEmails } from '../testdata.js'
import { spendToday } from '../ai-budget.js'
import { wilson, analyzeExperiment, round } from './math.js'
import { createNode } from './store.js'
import { NEEDS } from './programs.js'

const DAY = 86_400_000
const KIND = { live: 'measured', unavailable: 'missing', estimate: 'estimated', test: 'test' }
export const CROSS_ACCOUNT = { enabled: false, reason: 'Needs a legal basis and customer permission (Terms/DPA) before any customer business is analysed, even in aggregate. When enabled: cohorts of at least 5 businesses, aggregates only, no personal data.' }

export async function internalBusinesses(env) {
  const map = await accountsMap(env).catch(() => null)
  if (!map) return []
  return [...map.entries()].filter(([, a]) => a.classification === 'internal_live').map(([id]) => id).slice(0, 10)
}

// The funnel of one GetShowUps-owned business, with sample-size flags and intervals. Provider attendance is NOT recorded
// separately in GetShowUps ("happened" means the visit took place), so it is reported as missing, not inferred.
export async function businessFunnel(env, id, { days = 90, now = Date.now() } = {}) {
  const f = await funnel(env.ONBOARDING_DB, id, { days, scope: 'all', internal: internalEmails(env), now })
  const s = f.stages
  const stage = (name, num, den, min) => ({ name, n: den, x: num, rate: den >= min ? wilson(num, den) : null, sample: den >= min ? 'enough' : 'insufficient' })
  return {
    business: id,
    days,
    counts: { leads: s.leads, qualified: s.qualified, outsideArea: s.outsideArea, booked: s.booked, cancelled: s.cancelled, past: s.past, outcomeRecorded: s.outcomeRecorded, happened: s.attended, noShow: s.noShow, completed: s.completed },
    stages: [
      stage('qualified / leads', s.qualified, s.leads, 10),
      stage('booked / qualified', s.booked, s.qualified, 10),
      stage('happened / past bookings with an outcome', s.attended, s.attended + s.noShow, 5),
      stage('completed / happened', s.completed, s.attended, 5),
    ],
    providerAttendance: { dataKind: 'missing', note: 'Not recorded separately: "happened" covers both sides. Recording who missed a visit needs a product change.' },
    money: { spendCents: f.spend.cents, spendKind: f.spend.cents == null ? 'missing' : 'measured', paidCents: f.revenue.paidCents, paidKind: f.revenue.paidCents == null ? 'missing' : 'measured', estimatedCents: f.revenue.estimatedCents, estimatedKind: f.revenue.estimatedCents == null ? 'missing' : 'estimated' },
    unrecordedPast: Math.max(0, s.past - s.outcomeRecorded),
  }
}

// Where value is lost, and what kind of cause each loss could have. Never assigns blame: a loss with an unknown cause
// says so and recommends investigation. Warns against buying demand while a later stage is broken.
export function accountability(f) {
  const c = f.counts
  const losses = [
    { stage: 'Outside the service area', count: c.outsideArea, possibleCauses: ['advertising targeting', 'website/receptionist area wording', 'service-area settings'], attribution: 'unknown' },
    { stage: 'Qualified but never booked', count: Math.max(0, c.qualified - c.booked), possibleCauses: ['no suitable times (scheduling)', 'price or offer', 'receptionist or booking-page friction', 'customer changed mind'], attribution: 'unknown' },
    { stage: 'Booked, then cancelled', count: c.cancelled, possibleCauses: ['customer', 'provider', 'scheduling'], attribution: 'unknown' },
    { stage: 'Booked, did not happen', count: c.noShow, possibleCauses: ['customer no-show', 'provider did not attend (not recorded separately)'], attribution: 'unknown' },
    { stage: 'Past visits with no outcome recorded', count: f.unrecordedPast, possibleCauses: ['outcome not marked by the owner'], attribution: 'data gap' },
  ].filter((l) => l.count > 0)
  const happenedStage = f.stages[2]
  const warnings = []
  if (happenedStage.rate && happenedStage.rate.high < 0.7) warnings.push('Fewer than 7 in 10 booked visits are happening (even at the top of the interval): adding ad spend would buy demand that is lost after booking. Fix that stage first.')
  if (f.providerAttendance.dataKind === 'missing') warnings.push('Platform and provider performance can\'t be separated at the "happened" stage until provider attendance is recorded.')
  return { losses: losses.sort((a, b) => b.count - a.count), warnings, recommendation: losses.length ? 'Investigate the largest loss first; record the cause when known (an evidence record).' : 'No losses recorded in the period.' }
}

export async function observatory(env, now = Date.now()) {
  const [growth, ai, internal] = await Promise.all([growthMeasure(env, now).catch(() => null), spendToday(env, now).catch(() => null), internalBusinesses(env)])
  const businesses = []
  for (const id of internal) {
    const f = await businessFunnel(env, id, { now }).catch(() => null)
    businesses.push(f ? { ...f, accountability: accountability(f) } : { business: id, error: 'unreadable' })
  }
  return {
    generatedAt: now,
    corporate: growth ? growth.items.map((i) => ({ key: i.key, group: i.group, label: i.label, value: i.value, unit: i.unit, n: i.n, note: i.note, dataKind: KIND[i.kind] || 'unverified' })) : null,
    billingMode: growth?.billingMode ?? null,
    aiToday: ai ? { platformMicros: ai.platform, publicMicros: ai.public, ceilings: ai.ceilings, voiceMinutes: ai.voice, dataKind: 'measured' } : null,
    infrastructure: { dataKind: 'missing', note: 'Cloudflare and provider plans are fixed fees outside the records; per-use infrastructure cost is not measured.' },
    businesses,
    crossAccount: CROSS_ACCOUNT,
    notMeasured: ['provider attendance (separately)', 'customer lifetime value (no paying customers yet)', 'administrative time saved', 'time to market', 'support burden', 'contribution profit (no cost-of-service data)'],
  }
}

// Event-driven evidence scan, run only when a researcher asks (no cron): compares the last 30 days with the 30 before
// for each GetShowUps-owned business and proposes an observation only when both windows have enough cases and the change
// is unlikely to be noise (two-proportion test, p < 0.01). Dormant otherwise. Bounded: ≤ 10 businesses, ≤ 5 proposals.
export async function scan(env, r, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const ids = await internalBusinesses(env)
  const created = []
  const checked = []
  for (const id of ids) {
    if (created.length >= 5) break
    const cur = await funnel(db, id, { days: 30, scope: 'all', internal: internalEmails(env), now })
    const prev = await funnel(db, id, { days: 30, scope: 'all', internal: internalEmails(env), now: now - 30 * DAY })
    const a = { n: prev.stages.qualified, x: prev.stages.booked }
    const b = { n: cur.stages.qualified, x: cur.stages.booked }
    const t = analyzeExperiment({ controlN: a.n, controlSuccesses: a.x, treatmentN: b.n, treatmentSuccesses: b.x, plannedSample: 20 })
    checked.push({ business: id, metric: 'booked / qualified', before: a, after: b, verdict: t.verdict })
    if (a.n < 20 || b.n < 20 || !(t.pValue < 0.01)) continue
    const key = `booking-rate:${id}:${new Date(now).toISOString().slice(0, 7)}`
    const dup = await db.prepare("SELECT 1 FROM research_nodes WHERE kind = 'observation' AND json_extract(body, '$.source') = ?1").bind(key).first()
    if (dup) continue
    const res = await createNode(env, r, 'observation', { title: `Booking rate changed for ${id}: ${Math.round((a.x / a.n) * 100)}% → ${Math.round((b.x / b.n) * 100)}%`, program: 'GS-ECO-002', body: { what: `Qualified leads that booked, previous 30 days ${a.x}/${a.n}, last 30 days ${b.x}/${b.n} (p = ${t.pValue}). A change, not a cause.`, source: key, quality: 'measured; observational (no control group)' } }, now)
    if (res.ok) created.push(res.id)
  }
  return { checked, created, dormant: !created.length, note: created.length ? 'Proposed observations need a person to confirm or reject them.' : 'Nothing changed enough on enough data: the scan stays dormant.' }
}

// Decision queue: recommendations ranked by expected net value under uncertainty (probability × benefit range − cost).
// Unquantified recommendations are listed after the ranked ones, never given a made-up value.
export function rankDecisions(recs) {
  const ranked = recs.map((r) => {
    const b = r.body
    const q = [b.benefitLow, b.benefitHigh, b.probability, b.cost].every((v) => v != null && Number.isFinite(v))
    const low = q ? round(b.probability * b.benefitLow - b.cost, 2) : null
    const high = q ? round(b.probability * b.benefitHigh - b.cost, 2) : null
    const mid = q ? round((low + high) / 2, 2) : null
    return { ...r, value: q ? { low, mid, high } : null, quantified: q }
  })
  return ranked.sort((x, y) => (y.quantified - x.quantified) || ((y.value?.mid ?? 0) - (x.value?.mid ?? 0)))
}

// Deterministic research assistant ("Challenge" mode over the records): what is unproven, contradicted or unsupported.
export async function gaps(db) {
  const q = (sql) => db.prepare(sql).all().then((r) => r.results).catch(() => [])
  const [unsupported, recsNoEvidence, contradicted, runningNoPlan, approvedOnIllustrative] = await Promise.all([
    q("SELECT id, title FROM research_nodes n WHERE kind IN ('hypothesis', 'thesis') AND status NOT IN ('retired') AND NOT EXISTS (SELECT 1 FROM research_edges e WHERE e.to_id = n.id AND e.relation IN ('supports', 'contradicts', 'tests')) LIMIT 20"),
    q("SELECT id, title FROM research_nodes n WHERE kind = 'recommendation' AND status IN ('proposed', 'approved') AND NOT EXISTS (SELECT 1 FROM research_edges e WHERE e.to_id = n.id AND e.relation IN ('supports', 'informs', 'derives')) LIMIT 20"),
    q("SELECT DISTINCT n.id, n.title FROM research_nodes n JOIN research_edges e ON e.to_id = n.id AND e.relation = 'contradicts' WHERE n.status NOT IN ('retired', 'contradicted') LIMIT 20"),
    q("SELECT id, title FROM research_nodes WHERE kind = 'experiment' AND status = 'running' AND json_extract(body, '$.plannedSample') IS NULL LIMIT 20"),
    q("SELECT id, title FROM research_nodes WHERE kind = 'recommendation' AND status = 'approved' AND json_extract(body, '$.validationStatus') LIKE '%illustrative%' LIMIT 20"),
  ])
  return [
    { gap: 'Hypotheses and theses with no evidence or test linked', items: unsupported },
    { gap: 'Recommendations with no supporting record linked', items: recsNoEvidence },
    { gap: 'Records contradicted by evidence but not yet re-assessed', items: contradicted },
    { gap: 'Running experiments without a planned sample (no valid verdict possible)', items: runningNoPlan },
    { gap: 'Approved recommendations resting on an illustrative (unvalidated) model', items: approvedOnIllustrative },
  ]
}

// Which programs (records of kind 'program', never code) have the data they need right now, so dormant ones say why.
export function programStatus(obs, counts, programs) {
  const have = {
    spend: obs.businesses.some((b) => b.money?.spendKind === 'measured'),
    leads: obs.businesses.some((b) => b.counts?.leads >= 10),
    booked: obs.businesses.some((b) => b.counts?.booked >= 5),
    outcomes: obs.businesses.some((b) => b.counts?.outcomeRecorded >= 5),
    paidRevenue: obs.businesses.some((b) => b.money?.paidKind === 'measured'),
    experiments: counts.completedExperiments > 0,
    recommendations: counts.recommendations > 0,
    customers: obs.corporate?.some((i) => i.key === 'payingCustomers' && i.value > 0) ?? false,
    crossAccount: CROSS_ACCOUNT.enabled,
    external: false,
  }
  return programs.map((p) => {
    const needs = p.body.needs || []
    const missing = needs.filter((n) => !have[n])
    return { id: p.program, recordId: p.id, title: p.title, question: p.body.question, models: p.body.models || [], dormantUntil: p.body.dormantUntil || missing.map((n) => NEEDS[n]).join('; '), ready: needs.length > 0 && missing.length === 0, missing: missing.map((n) => NEEDS[n]), records: (counts.byProgram[p.program] || 0) - 1 }
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)))
}
