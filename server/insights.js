// Proactive insights for the owner's dashboard: a few deterministic checks over this business's own records. No model, no
// polling, nothing stored except a dismissal (an `events` row: codes and a count). Each signal: what is true, the
// evidence, one useful next step, one home page. Ordered by priority; the page shows at most one.
//   priority 1 broken now · 2 a customer is waiting · 3 a supported improvement · 4 setup
// A check that can't be read says nothing (never a guess). Off: AI_INSIGHTS_ENABLED=false.
import { track } from './events.js'
import { diagnose, funnel } from './ads/funnel.js'
import { adsAccess } from './ads/access.js'
import { internalEmails, isTestLead } from './testdata.js'
import { UNANSWERED } from './attention.js'
import { getProfile } from './onboarding.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const COOLDOWN = { snooze: 3 * DAY, dismiss: 30 * DAY }
export const MIN_OUTSIDE = 3
export const insightsEnabled = (env) => env.AI_INSIGHTS_ENABLED !== 'false'
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`

// → { zip, n, check }[]: where recent leads outside the listed ZIPs came from (newest 90 days, tests excluded).
export async function outsideZips(env, customer, now = Date.now()) {
  if (!customer.serviceZips?.length) return []
  const { results } = await env.ONBOARDING_DB.prepare(
    `SELECT r.zip, r.zip_check AS chk, count(*) AS n FROM coverage_requests r JOIN leads l ON l.id = r.lead_id AND l.customer = r.customer
      WHERE r.customer = ?1 AND r.created_at >= ?2 AND NOT ${isTestLead('l', '?3')} GROUP BY r.zip, r.zip_check ORDER BY n DESC, r.zip LIMIT 20`,
  )
    .bind(customer.id, now - 90 * DAY, internalEmails(env))
    .all()
  return results.filter((r) => !customer.serviceZips.includes(r.zip)).map((r) => ({ zip: r.zip, n: Number(r.n), check: r.chk }))
}

// Unbooked leads from the last 14 days, older than a day, that nothing was ever sent to.
export async function unanswered(env, customer, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare(
    `SELECT count(*) AS n FROM leads l LEFT JOIN lead_threads t ON t.lead_id = l.id AND t.customer = l.customer
      WHERE l.customer = ?1 AND ${UNANSWERED} AND l.created_at BETWEEN ?2 AND ?3 AND NOT ${isTestLead('l', '?4')}`,
  )
    .bind(customer.id, now - 14 * DAY, now - DAY, internalEmails(env))
    .first()
  return Number(r?.n) || 0
}

const CHECKS = [
  async (env, c) => {
    const r = await env.ONBOARDING_DB.prepare("SELECT code FROM ops_incidents WHERE customer = ?1 AND feature = 'calendar.google' AND status = 'open' ORDER BY last_seen DESC LIMIT 1").bind(c.id).first()
    return r && { id: 'calendar', priority: 1, home: 'settings', level: 1, title: 'Customers may not see times: your calendar needs attention', evidence: ['Our last checks of your Google Calendar failed and it hasn’t recovered yet.'], action: ['Check the calendar', 'settings'], ask: 'What happens while my calendar isn’t connected?', topic: 'calendar' }
  },
  async (env, c, now) => {
    const n = await unanswered(env, c, now)
    return n > 0 && { id: 'unanswered', priority: 2, home: 'followups', level: n, title: `${people(n)} asked more than a day ago and nothing has been sent to them`, evidence: [`${n} unbooked ${n === 1 ? 'inquiry' : 'inquiries'} from the last 14 days, each older than a day, with no message sent from GetShowUps.`, 'If you called them, we can’t see that.'], action: ['Open follow-ups', 'followups'], ask: 'How should I answer people who asked and haven’t booked?', topic: 'followups' }
  },
  async (env, c, now) => {
    const zips = await outsideZips(env, c, now)
    const n = zips.reduce((s, z) => s + z.n, 0)
    if (n < MIN_OUTSIDE) return null
    const repeat = zips.filter((z) => z.check === 'outside' && z.n > 1)
    return { id: 'outside_area', priority: 3, home: 'appointments', level: n, title: `${n} recent inquiries came from outside your service area`, evidence: [`Last 90 days: ${zips.slice(0, 4).map((z) => `${z.zip || 'no ZIP'} (${z.n})`).join(', ')}.`, repeat.length ? 'Adding a ZIP lets people there book without waiting for you.' : 'No ZIP repeats, so this may be normal.'], action: ['Review my ZIP codes', 'assist'], ask: 'Help me improve my service area', topic: null }
  },
  async (env, c, now) => {
    const d = diagnose(await funnel(env.ONBOARDING_DB, c.id, { days: 30, scope: 'all', internal: internalEmails(env), now })).find((x) => x.level === 'act' && x.id !== 'outside_area')
    return d && { id: d.id, priority: 3, home: 'overview', level: 1, title: d.title, evidence: [d.detail, d.sample && `Based on ${d.sample} in the last 30 days.`].filter(Boolean), action: d.id === 'outcomes_missing' ? ['Mark visits', 'appointments'] : null, ask: d.id === 'attendance' ? 'What can I do about no-shows?' : 'Why are my leads not becoming booked jobs?', topic: null }
  },
  async (env, c, now) => {
    if (!(await adsAccess(env, c))) return null
    const day = (t) => new Date(t).toISOString().slice(0, 10)
    const r = await env.ONBOARDING_DB.prepare(
      `SELECT count(*) AS n FROM ad_campaigns k WHERE k.customer = ?1 AND k.status = 'active' AND k.launched_at IS NOT NULL AND k.launched_at < ?2
        AND NOT EXISTS (SELECT 1 FROM ad_metrics_daily m WHERE m.campaign_id = k.id AND m.date >= ?3)`,
    )
      .bind(c.id, now - 3 * DAY, day(now - 4 * DAY))
      .first()
    const n = Number(r?.n) || 0
    return n > 0 && { id: 'ads_gap', priority: 3, home: 'ads', level: n, title: `No recent results from ${n === 1 ? 'a running campaign' : `${n} running campaigns`}`, evidence: ['Nothing has been reported for at least three days, so spend and cost per booking can’t be measured.', 'This doesn’t mean nothing was spent: check the ad account.'], action: ['Open Ads', 'ads'], ask: 'Why can’t my ad results be measured?', topic: 'ad_spend' }
  },
  async (env, c) => {
    const [rec, profile] = await Promise.all([env.ONBOARDING_DB.prepare('SELECT enabled FROM receptionist_settings WHERE customer = ?1').bind(c.id).first(), getProfile(env.ONBOARDING_DB, c.id)])
    return rec?.enabled === 1 && !profile?.services?.length && { id: 'no_services', priority: 4, home: 'receptionist', level: 1, title: 'Your receptionist is on but knows no services', evidence: ['No services are listed, so it can’t say what you do.'], action: ['Add services', 'settings'], ask: 'What does the receptionist use to answer?', topic: 'receptionist' }
  },
]

// The same insight comes back after its cooldown, or sooner when there is clearly more of it (level = its count).
const hidden = (d, level, now) => d && now < d.until && level <= Math.max(d.level + 2, d.level * 1.5)

export async function insights(env, customer, now = Date.now()) {
  if (!insightsEnabled(env)) return []
  const [found, { results }] = await Promise.all([
    Promise.all(CHECKS.map((f) => f(env, customer, now).catch(() => null))),
    env.ONBOARDING_DB.prepare("SELECT props FROM events WHERE customer = ?1 AND type = 'insight_dismissed' AND at >= ?2 LIMIT 50").bind(customer.id, now - COOLDOWN.dismiss).all(),
  ])
  const gone = Object.fromEntries(results.map((r) => JSON.parse(r.props)).map((p) => [p.id, p]))
  return found.filter((x) => x && !hidden(gone[x.id], x.level, now)).sort((a, b) => a.priority - b.priority)
}

// Only an insight that is true right now can be dismissed; the level comes from the records, never from the browser.
export async function dismissInsight(env, customer, id, kind, now = Date.now()) {
  if (!Object.hasOwn(COOLDOWN, kind)) return false
  const it = (await insights(env, customer, now)).find((x) => x.id === id)
  if (!it) return false
  await track(env, 'insight_dismissed', { id: `insight:${customer.id}:${id}`, customer: customer.id, props: { id, kind, level: it.level, until: now + COOLDOWN[kind] }, at: now, replace: true })
  return true
}
