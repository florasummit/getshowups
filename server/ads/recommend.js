// Recommendations for the account's own (imported) campaigns: deterministic rules over Google's numbers and, for
// Local Services, Google's lead records; recommendation-only (nothing is ever changed by itself; the owner acts
// through the approval flow in server/ads/changes.js). Each finding says what was observed, the numbers behind it,
// what to consider, why it should help, how sure the rule is and its limits. Rules need minimum data and never
// recommend more spend. Written to ad_actions (actor 'optimizer', kind 'recommend', status 'recommended') with a
// deterministic id per campaign, rule and day, so a day's run is a no-op when repeated.
import { lsaSummary } from './lsa.js'
import { importsReady } from './imports.js'

const DAY = 86_400_000
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
export const RULES = {
  minSpend14Cents: 15000, // $150 in 14 days before judging
  minClicks14: 60,
  budgetUseShare: 0.9, // 14-day spend ≥ 90% of 14 × daily budget → budget-limited
  cplShareOfValue: 0.5, // Local Services: cost per charged lead above half the first-job value → worth a look
  staleHours: 36,
}
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// Pure. `c`: an imported campaign row (+ settings parsed); `stats`: 14-day Google numbers and freshness; `lsa`: the
// Local Services summary for the period (or null); `ctx`: the owner's first-job value.
export function evaluateImported(c, stats, lsa, { customerValueCents = 0 } = {}, now = Date.now()) {
  const out = []
  if (c.status !== 'ENABLED') return out
  const today = day(now)
  const add = (rule, level, title, observed, suggestion, mechanism, confidence, limits, details = {}) =>
    out.push({ id: `${c.id}:${rule}:${today}`, rule, level, title, observed, suggestion, mechanism, confidence, limits, details, approval: 'Any change goes through your approval here or in Google Ads; nothing changes by itself.' })
  if (!stats.lastFetchedAt || now - stats.lastFetchedAt > RULES.staleHours * 3600_000) {
    add('stale', 'info', 'Google’s numbers for this campaign are out of date', 'No fresh numbers in the last day and a half.', 'Press Refresh; if it keeps happening, reconnect Google Ads.', 'Without fresh numbers nothing below can be judged.', 'high', 'A reporting gap, not a performance finding.')
    return out
  }
  if (c.channel_type === 'LOCAL_SERVICES') {
    if (lsa && lsa.spendCents != null && lsa.spendCents >= RULES.minSpend14Cents && lsa.charged === 0)
      add('lsa_no_charged_leads', 'watch', 'Spending with no charged leads', `${usd(lsa.spendCents)} reported by Google in the period and no charged lead.`, 'Check the campaign’s service area, hours and job types in Google; check that calls are being answered.', 'Local Services charges per lead, so spend without charged leads usually means the listing isn’t winning leads or they were credited back.', 'medium', `Based on Google’s lead records (${lsa.total} lead${lsa.total === 1 ? '' : 's'} in the period).`, { spendCents: lsa.spendCents })
    if (lsa && customerValueCents > 0 && lsa.costPerChargedLeadCents != null && lsa.charged >= 5 && lsa.costPerChargedLeadCents > customerValueCents * RULES.cplShareOfValue)
      add('lsa_cpl_high', 'watch', 'Cost per charged lead is high next to your typical first job', `${usd(lsa.costPerChargedLeadCents)} per charged lead across ${lsa.charged} leads; your typical first job is ${usd(customerValueCents)}.`, 'Review the job types and service area the campaign targets; dispute leads that weren’t real requests.', 'Narrower job types and area usually lower the share of leads you pay for but can’t serve.', 'medium', 'Google’s lead cost is not reported per lead; this uses the campaign’s spend divided by charged leads.', { cplCents: lsa.costPerChargedLeadCents })
    return out
  }
  if (stats.spend14Cents < RULES.minSpend14Cents) return out
  if (stats.clicks14 >= RULES.minClicks14 && stats.conversions14 === 0 && stats.gsuLeads14 === 0)
    add('no_conversions', 'act', 'Clicks but nothing Google or GetShowUps can count as a lead', `${usd(stats.spend14Cents)} and ${stats.clicks14} clicks in 14 days; Google counted 0 conversions and no lead reached GetShowUps from this campaign.`, 'Check the landing page and conversion tracking in Google Ads, or point the ads at your GetShowUps booking page so every lead is captured.', 'Without a working form or tracking, the budget buys visits that cannot become leads.', 'high', 'Google’s conversion count depends on its own tracking setup, which GetShowUps cannot see.', { spendCents: stats.spend14Cents, clicks: stats.clicks14 })
  if (c.daily_budget_cents && stats.spend14Cents >= 14 * c.daily_budget_cents * RULES.budgetUseShare)
    add('budget_limited', 'info', 'The campaign uses its full budget almost every day', `${usd(stats.spend14Cents)} in 14 days against a ${usd(c.daily_budget_cents)} daily budget.`, 'Only you decide whether to raise it; a raise never happens by itself. Before raising, check the leads it brings are ones you can book.', 'A budget that runs out early misses searches later in the day.', 'medium', 'Says nothing about lead quality; see the booking rate in Results.', { spendCents: stats.spend14Cents, dailyBudgetCents: c.daily_budget_cents })
  const s = c.settings || {}
  if (s.networks?.display === true) add('display_on', 'watch', 'Display Network is switched on for a Search campaign', 'The campaign can show banner ads on other websites, not only on Google search results.', 'Consider turning the Display Network off in Google Ads for a local service campaign.', 'Searches show intent (“pool repair near me”); banner placements rarely do, and they spend budget.', 'low', 'Google does not report spend per network here, so the share going to banners is unknown.')
  if (s.networks?.searchPartners === true) add('partners_on', 'info', 'Search partners are switched on', 'Ads can also show on Google’s partner sites.', 'Keep an eye on it; many local advertisers turn partners off after comparing results.', 'Partner traffic is often cheaper but converts less; the effect differs by trade.', 'low', 'No per-network figures are available here.')
  if (s.geoTargetType && s.geoTargetType !== 'PRESENCE') add('geo_interest', 'watch', 'Location targeting includes people merely interested in the area', 'Google’s targeting is set to presence or interest, so people elsewhere can see the ads.', 'For a local service, “presence” (people in the area) usually fits better; change it in Google Ads.', 'People outside the service area cannot book a visit.', 'medium', 'Based on the campaign setting Google reports, not on where clicks came from.')
  return out
}

export async function importedStats(db, c, now = Date.now()) {
  const since = day(now - 14 * DAY)
  const [m, f, leads] = await Promise.all([
    db.prepare('SELECT coalesce(sum(spend_cents),0) AS spend, coalesce(sum(clicks),0) AS clicks, coalesce(sum(conversions),0) AS conv FROM ad_imported_metrics_daily WHERE imported_id = ?1 AND date >= ?2').bind(c.id, since).first(),
    db.prepare('SELECT max(fetched_at) AS f FROM ad_imported_metrics_daily WHERE imported_id = ?1').bind(c.id).first(),
    db.prepare('SELECT count(*) AS n FROM lead_attribution WHERE campaign_id = ?1 AND created_at >= ?2').bind(c.id, now - 14 * DAY).first(),
  ])
  return { spend14Cents: m?.spend ?? 0, clicks14: m?.clicks ?? 0, conversions14: Number(m?.conv ?? 0), lastFetchedAt: f?.f ?? null, gsuLeads14: leads?.n ?? 0 }
}

// Cron: every running imported campaign, bounded; findings are written once per campaign, rule and day.
export async function recommendImported(env, { now = Date.now(), limit = 50 } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await importsReady(db))) return { skipped: 'not_ready' }
  const { results } = await db.prepare("SELECT * FROM ad_imported_campaigns WHERE status = 'ENABLED' ORDER BY synced_at LIMIT ?1").bind(limit).all()
  const summary = { campaigns: results.length, recommended: 0 }
  const lsaByCustomer = new Map()
  for (const c of results) {
    let settings = {}
    try {
      settings = JSON.parse(c.settings || '{}')
    } catch {}
    const profile = await db.prepare('SELECT customer_value_cents FROM ad_profiles WHERE customer = ?1').bind(c.customer).first()
    const stats = await importedStats(db, c, now)
    let lsa = null
    if (c.channel_type === 'LOCAL_SERVICES') {
      if (!lsaByCustomer.has(c.customer)) lsaByCustomer.set(c.customer, await lsaSummary(db, c.customer, { days: 14, now }))
      lsa = lsaByCustomer.get(c.customer)[c.id] || null
    }
    for (const d of evaluateImported({ ...c, settings }, stats, lsa, { customerValueCents: profile?.customer_value_cents ?? 0 }, now)) {
      const r = await db
        .prepare("INSERT OR IGNORE INTO ad_actions (id, customer, campaign_id, actor, kind, status, reason, details, at) VALUES (?1, ?2, ?3, 'optimizer', 'recommend', 'recommended', ?4, ?5, ?6)")
        .bind(d.id, c.customer, c.id, d.title, JSON.stringify({ rule: d.rule, level: d.level, observed: d.observed, suggestion: d.suggestion, mechanism: d.mechanism, confidence: d.confidence, limits: d.limits, approval: d.approval, ...d.details }), now)
        .run()
      if (r.meta.changes) summary.recommended++
    }
  }
  return summary
}

// The last 14 days of findings per imported campaign (for the Ads tab).
export async function listRecommendations(db, customerId, { now = Date.now() } = {}) {
  if (!(await importsReady(db))) return {}
  const { results } = await db.prepare("SELECT campaign_id, reason, details, at FROM ad_actions WHERE customer = ?1 AND kind = 'recommend' AND at >= ?2 ORDER BY at DESC LIMIT 200").bind(customerId, now - 14 * DAY).all()
  const out = {}
  const seen = new Set()
  for (const r of results) {
    let d = {}
    try {
      d = JSON.parse(r.details || '{}')
    } catch {}
    const key = `${r.campaign_id}:${d.rule}`
    if (seen.has(key)) continue // the newest finding per rule
    seen.add(key)
    ;(out[r.campaign_id] ||= []).push({ rule: d.rule, level: d.level || 'info', title: r.reason, observed: d.observed, suggestion: d.suggestion, mechanism: d.mechanism, confidence: d.confidence, limits: d.limits, approval: d.approval, at: r.at })
  }
  const order = { act: 0, watch: 1, info: 2 }
  for (const list of Object.values(out)) list.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
  return out
}
