// Constrained optimizer. Deterministic rules only; it can PAUSE (safety) and RECOMMEND, never raise a
// budget, never resume, never launch. Every decision is written to ad_actions with a deterministic id
// (campaign:rule:day), so re-running the same day is a no-op. Owners override by resuming/pausing
// themselves; an owner resume is respected for the rest of that day.
import { currentApproval } from './budget.js'

export const RULES = {
  staleHours: 36, // metrics older than this on a live campaign → alert
  overspendFactor: 1.25, // yesterday's spend above budget × this → pause (platforms can overdeliver ~2× a day)
  minSpendForJudgementCents: 15000, // $150 in the last 14 days before judging performance
  minClicksForTrackingCheck: 60, // clicks in 14 days with zero leads → tracking alert
  budgetDownPct: 20, // recommended cut when cost per lead is far above target
  cplTargetShareOfValue: 0.5, // target cost per lead ≤ 50% of the owner-stated first-job value
}

const DAY = 86400000
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const monthStartDay = (ms) => day(ms).slice(0, 8) + '01'

// Evaluates one campaign. Pure: returns decisions, does not write. `stats` from campaignStats().
export function evaluate(campaign, stats, { approvalMonthlyCents, customerValueCents }, now = Date.now()) {
  const out = []
  if (!['active'].includes(campaign.status)) return out
  const today = day(now)
  const add = (rule, kind, status, reason, details = {}) => out.push({ id: `${campaign.id}:${rule}:${today}`, rule, kind, status, reason, details })

  // 1. Hard ceiling: month-to-date spend for the business at or over the approved monthly budget.
  if (approvalMonthlyCents == null) {
    add('no_approval', 'pause', 'applied', 'No active owner budget approval. Paused until the owner approves a budget.')
    return out
  }
  if (stats.businessMonthSpendCents >= approvalMonthlyCents) {
    add('month_ceiling', 'pause', 'applied', 'This month’s ad spend reached the budget you approved. Paused so it cannot go over.', { spentCents: stats.businessMonthSpendCents, approvedCents: approvalMonthlyCents })
    return out
  }
  // 2. Overdelivery yesterday well beyond the daily budget.
  if (stats.yesterdaySpendCents > campaign.daily_budget_cents * RULES.overspendFactor && stats.ownerResumedToday !== true) {
    add('overspend', 'pause', 'applied', 'Yesterday’s spend was well above the daily budget. Paused for review.', { spentCents: stats.yesterdaySpendCents, dailyBudgetCents: campaign.daily_budget_cents })
    return out
  }
  // 3. Data freshness.
  if (!stats.lastFetchedAt || now - stats.lastFetchedAt > RULES.staleHours * 3600000) {
    add('stale_data', 'alert', 'recommended', 'Performance data has not updated recently, so no optimization was made. Reconnect the ad account if this continues.')
    return out
  }
  // Not enough data yet → no judgement.
  if (stats.spend14Cents < RULES.minSpendForJudgementCents) return out

  // 4. Tracking failure: clicks but no leads at all.
  if (stats.clicks14 >= RULES.minClicksForTrackingCheck && stats.leads14 === 0) {
    add('tracking', 'alert', 'recommended', 'Ads got clicks but no leads arrived in GetShowUps. Check that ads point to your booking page or lead form.', { clicks: stats.clicks14 })
    if (stats.conversions14 === 0) add('no_results', 'pause', 'recommended', 'Spent over $150 in 14 days with no leads. Consider pausing until tracking is fixed.', { spentCents: stats.spend14Cents })
    return out
  }
  // 5. Cost per lead far above target (only when the owner told us a job value).
  if (customerValueCents > 0 && stats.leads14 > 0) {
    const cpl = Math.round(stats.spend14Cents / stats.leads14)
    const target = Math.round(customerValueCents * RULES.cplTargetShareOfValue)
    if (cpl > target * 2) {
      const newDaily = Math.max(500, Math.floor((campaign.daily_budget_cents * (100 - RULES.budgetDownPct)) / 100))
      if (newDaily < campaign.daily_budget_cents) add('cpl_high', 'budget_down', 'recommended', `Cost per lead ($${(cpl / 100).toFixed(0)}) is more than twice the target. Consider lowering the daily budget.`, { costPerLeadCents: cpl, targetCents: target, fromCents: campaign.daily_budget_cents, toCents: newDaily })
    }
  }
  return out
}

export async function campaignStats(db, campaign, now = Date.now()) {
  const since14 = day(now - 14 * DAY)
  const yesterday = day(now - DAY)
  const [m, y, biz, leads, resumed] = await Promise.all([
    db.prepare('SELECT coalesce(sum(spend_cents),0) AS spend, coalesce(sum(clicks),0) AS clicks, coalesce(sum(conversions),0) AS conv, max(fetched_at) AS fetched FROM ad_metrics_daily WHERE campaign_id = ?1 AND date >= ?2').bind(campaign.id, since14).first(),
    db.prepare('SELECT coalesce(sum(spend_cents),0) AS spend FROM ad_metrics_daily WHERE campaign_id = ?1 AND date = ?2').bind(campaign.id, yesterday).first(),
    db.prepare('SELECT coalesce(sum(spend_cents),0) AS spend FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2').bind(campaign.customer, monthStartDay(now)).first(),
    db.prepare('SELECT count(*) AS n FROM lead_attribution WHERE campaign_id = ?1 AND created_at >= ?2').bind(campaign.id, now - 14 * DAY).first(),
    db.prepare("SELECT 1 AS x FROM ad_actions WHERE campaign_id = ?1 AND kind = 'resume' AND actor LIKE 'owner:%' AND at >= ?2 LIMIT 1").bind(campaign.id, Date.parse(day(now))).first(),
  ])
  const lastFetched = await db.prepare('SELECT max(fetched_at) AS f FROM ad_metrics_daily WHERE campaign_id = ?1').bind(campaign.id).first()
  return {
    spend14Cents: m?.spend ?? 0,
    clicks14: m?.clicks ?? 0,
    conversions14: m?.conv ?? 0,
    lastFetchedAt: lastFetched?.f ?? null,
    yesterdaySpendCents: y?.spend ?? 0,
    businessMonthSpendCents: biz?.spend ?? 0,
    leads14: leads?.n ?? 0,
    ownerResumedToday: Boolean(resumed),
  }
}

// Runs the optimizer for every active campaign. `pause(env, campaign)` performs the platform pause and
// returns {ok}. Decisions are idempotent per campaign/rule/day.
export async function runOptimizer(env, { pause, now = Date.now(), limit = 50 } = {}) {
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare("SELECT * FROM ad_campaigns WHERE status = 'active' ORDER BY updated_at LIMIT ?1").bind(limit).all()
  const summary = { campaigns: results.length, paused: 0, recommended: 0, failed: 0 }
  for (const campaign of results) {
    const approval = await currentApproval(db, campaign.customer)
    const profile = await db.prepare('SELECT customer_value_cents FROM ad_profiles WHERE customer = ?1').bind(campaign.customer).first()
    const stats = await campaignStats(db, campaign, now)
    const decisions = evaluate(campaign, stats, { approvalMonthlyCents: approval?.monthly_cents ?? null, customerValueCents: profile?.customer_value_cents ?? 0 }, now)
    for (const d of decisions) {
      const exists = await db.prepare('SELECT 1 AS x FROM ad_actions WHERE id = ?1').bind(d.id).first()
      if (exists) continue
      let status = d.status
      let reason = d.reason
      if (d.kind === 'pause' && d.status === 'applied' && !pause) {
        // Automatic changes are off: the owner sees a recommendation and decides.
        status = 'recommended'
        reason = `Recommended: pause this campaign. ${d.reason}`
        summary.recommended++
      } else if (d.kind === 'pause' && d.status === 'applied') {
        const r = pause ? await pause(env, campaign) : { ok: false }
        if (r.ok) {
          await db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = ?2 WHERE id = ?1").bind(campaign.id, now).run()
          summary.paused++
        } else {
          status = 'failed'
          summary.failed++
        }
      } else summary.recommended++
      await db
        .prepare("INSERT OR IGNORE INTO ad_actions (id, customer, campaign_id, actor, kind, status, reason, details, at) VALUES (?1, ?2, ?3, 'optimizer', ?4, ?5, ?6, ?7, ?8)")
        .bind(d.id, campaign.customer, campaign.id, d.kind, status, reason, JSON.stringify(d.details), now)
        .run()
    }
  }
  return summary
}
