// GetShowUps selling itself, end to end: which acquisition source each prospect came from, and which prospects went on to
// create a business and pay. Closes the loop the sales funnel (server/metrics.js salesFunnel) stops at.
//   prospect   = a lead of the GetShowUps sales business (SALES_BUSINESS), test records excluded (testdata.js rule)
//   source     = where the lead came from (server/ads/attribution.js): a GetShowUps campaign source, else the link's own
//                utm_source/utm_campaign (kept for booking-page leads), else 'direct' (no attribution recorded)
//   business   = a real (not test, not the sales business) business with an owner sign-in equal to the prospect's email,
//                created at or after the inquiry (a match, never a guess from names; emails never leave this function)
//   paying     = that business's subscription is ACTIVE and recorded as LIVE mode; in Stripe test mode nothing is paying
//   qualified  = the prospect was not screened out (lead status other than 'unqualified')
//   revenue    = LIVE payments (events 'revenue', livemode) of the business a prospect became, credited once, to the
//                prospect's FIRST inquiry (first touch); null outside live billing. Paid money only, never MRR or estimates
// Counts only. Spend = the sales business's own campaigns (ad_metrics_daily). CAC only with measured spend and ≥ 1
// paying customer in live mode; otherwise null (shown as unavailable), never estimated.
import { isTestLead } from './testdata.js'
import { isTestBusinessSql } from './testbusiness.js'
import { stripeLiveEnabled } from './stripe.js'
import { SALES_BUSINESS } from './metrics.js'
import { AD_SOURCES } from './ads/funnel.js'

const DAY = 86_400_000
const inList = (xs) => xs.map((x) => `'${x}'`).join(',')

export async function salesAttribution(env, { now = Date.now(), days = 90, internal = '[]' } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await db.prepare('SELECT id FROM customers WHERE id = ?1').bind(SALES_BUSINESS).first())) return null
  const since = now - days * DAY
  const live = stripeLiveEnabled(env)
  const source = `CASE WHEN a.source IN (${inList(AD_SOURCES)}) THEN a.source
                       WHEN json_extract(a.details, '$.utmSource') IS NOT NULL THEN 'link:' || json_extract(a.details, '$.utmSource')
                       ELSE 'direct' END`
  const campaign = `coalesce(a.campaign_id, json_extract(a.details, '$.utmCampaign'))`
  // One row per prospect: its source, whether it booked/attended a consultation, and the business it became (if any).
  const won = `(SELECT c.id FROM customer_users u JOIN customers c ON c.id = u.customer
                 WHERE lower(u.email) = lower(l.email) AND c.id <> ?1 AND c.created_at >= l.created_at AND NOT ${isTestBusinessSql('c.id')}
                 ORDER BY c.created_at LIMIT 1)`
  const paying = live
    ? `EXISTS (SELECT 1 FROM subscriptions s JOIN subscription_modes m ON m.customer = s.customer AND m.livemode = 1 WHERE s.customer = p.business AND s.status = 'active')`
    : '0'
  // Paid revenue of the won business, credited to the first inquiry from that address only (never twice).
  const revenue = live
    ? `CASE WHEN p.business IS NOT NULL AND p.first THEN (SELECT coalesce(sum(json_extract(e.props, '$.amountCents')), 0) FROM events e WHERE e.customer = p.business AND e.type = 'revenue' AND json_extract(e.props, '$.livemode') = 1) ELSE 0 END`
    : '0'
  let rows
  try {
    rows = (
      await db
        .prepare(
          `WITH p AS (
             SELECT l.id, ${source} AS source, ${campaign} AS campaign, ${won} AS business, l.status <> 'unqualified' AS qualified,
                    NOT EXISTS (SELECT 1 FROM leads e WHERE e.customer = l.customer AND lower(e.email) = lower(l.email) AND (e.created_at < l.created_at OR (e.created_at = l.created_at AND e.id < l.id))) AS first,
                    EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id AND ap.customer = l.customer AND ap.status IN ('booked','showed','no_show')) AS booked,
                    EXISTS (SELECT 1 FROM appointments ap WHERE ap.lead_id = l.id AND ap.customer = l.customer AND ap.status = 'showed') AS attended
               FROM leads l LEFT JOIN lead_attribution a ON a.lead_id = l.id AND a.customer = l.customer
              WHERE l.customer = ?1 AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')})
           SELECT source, campaign, count(*) AS prospects, sum(qualified) AS qualified, sum(${revenue}) AS revenue, sum(booked) AS booked, sum(attended) AS attended,
                  sum(business IS NOT NULL) AS businesses, sum(CASE WHEN business IS NOT NULL AND ${paying} THEN 1 ELSE 0 END) AS paying
             FROM p GROUP BY source, campaign ORDER BY prospects DESC, source LIMIT 50`,
        )
        .bind(SALES_BUSINESS, since, internal)
        .all()
    ).results
  } catch (err) {
    // Billing tables missing (older database) or storage failing: unavailable, never zeros that look like data.
    console.error('sales attribution unavailable:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return { days, live, unavailable: true }
  }
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0)
  const spend = await db
    .prepare('SELECT count(*) AS n, coalesce(sum(spend_cents), 0) AS cents, coalesce(sum(clicks), 0) AS clicks, coalesce(sum(impressions), 0) AS impressions FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2')
    .bind(SALES_BUSINESS, new Date(since).toISOString().slice(0, 10))
    .first()
    .catch(() => null)
  const measured = Number(spend?.n || 0) > 0
  const payingTotal = live ? sum('paying') : null
  return {
    days,
    live,
    prospects: sum('prospects'),
    qualified: sum('qualified'),
    revenueCents: live ? sum('revenue') : null,
    consultationsBooked: sum('booked'),
    consultationsAttended: sum('attended'),
    businessesCreated: sum('businesses'),
    paying: payingTotal,
    spendCents: measured ? Number(spend.cents) : null,
    clicks: measured ? Number(spend.clicks) : null,
    impressions: measured ? Number(spend.impressions) : null,
    cacCents: measured && payingTotal > 0 ? Math.round(Number(spend.cents) / payingTotal) : null,
    bySource: rows.map((r) => ({
      source: r.source,
      campaign: r.campaign ?? null,
      prospects: Number(r.prospects || 0),
      qualified: Number(r.qualified || 0),
      consultationsBooked: Number(r.booked || 0),
      consultationsAttended: Number(r.attended || 0),
      businessesCreated: Number(r.businesses || 0),
      paying: live ? Number(r.paying || 0) : null,
      revenueCents: live ? Number(r.revenue || 0) : null,
    })),
  }
}
