// What the dashboard shows, as structured facts for the assistant: one page at a time, read by the same services the pages
// use, for the session's business only. Names and contact details are never included (references instead). A part that
// can't be read is 'could not be read', never left out as if it were empty.
import { attention, attentionCard, openRequests } from './attention.js'
import { overview } from './booking.js'
import { readiness } from './onboarding.js'
import { insights } from './insights.js'
import { listThreads } from './followups/engine.js'
import { websiteSummary } from './website.js'
import { domainFor } from './domains.js'
import { loadRules } from './intelligence/store.js'
import { recordsFor, rulesLiveFor, studioAccess } from './intelligence/access.js'
import { adsAccess } from './ads/access.js'
import { adSummary, listCampaigns, liveFor } from './ads/campaigns.js'
import { adsHold, HOLD_REASONS } from './ads/holds.js'
import { currentApproval } from './ads/budget.js'
import { importedTotals } from './ads/imports.js'
import { listRecommendations } from './ads/recommend.js'
import { NEEDS_OWNER } from './attention.js'
import { apptRefs, leadByRefId, requestOut, runTool } from './operator-tools.js'
import { isTestLead } from './testdata.js'

const DAY = 86_400_000
const UNREAD = 'could not be read'
const part = (p) => Promise.resolve(p).catch(() => UNREAD)
const usd = (c) => (c == null ? 'none reported' : `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`)

// Every turn, whatever the page: who is waiting. Call backs and messages with their people, the rest as counts.
export async function waitingNow(c) {
  const a = await attention(c.env, c.customer.id, c.now)
  const card = attentionCard(a)
  const people = a.callbacks?.total || a.messages?.total ? await part(openRequests(c.db, c.customer.id).then((l) => l.slice(0, 8).map((r) => requestOut(c, r)))) : []
  const people5 = (total, ids) => (total ? part(ids().then((l) => Promise.all(l.map((id) => leadByRefId(c, id)))).then((l) => l.filter(Boolean))) : [])
  const ids = async (sql, ...x) => (await c.db.prepare(sql).bind(c.customer.id, c.internal, ...x).all()).results.map((r) => r.id)
  const real = isTestLead('l', '?2')
  const [replies, unbooked, outside] = await Promise.all([
    people5(a.replies?.total, () => ids(`SELECT l.id FROM lead_threads t JOIN leads l ON l.id = t.lead_id AND l.customer = t.customer WHERE t.customer = ?1 AND t.needs_owner IS NOT NULL AND NOT ${real} ORDER BY t.updated_at LIMIT 4`)),
    people5(a.unbooked?.total, () => ids(`SELECT l.id FROM leads l WHERE l.customer = ?1 AND l.status = 'new' AND l.created_at >= ?3 AND NOT ${real} ORDER BY l.created_at LIMIT 5`, c.now - 30 * DAY)),
    people5(a.coverage?.total, () => ids(`SELECT l.id FROM coverage_requests r JOIN leads l ON l.id = r.lead_id AND l.customer = r.customer WHERE r.customer = ?1 AND r.status = 'pending' AND NOT ${real} ORDER BY l.created_at LIMIT 3`)),
  ])
  const kind = (x) => (x === null ? UNREAD : x.total)
  return {
    call_backs_waiting: kind(a.callbacks),
    receptionist_messages_waiting: kind(a.messages),
    call_back_and_message_people: people,
    ...(Array.isArray(people) && people.length > 1 ? { waiting_longest_for_call_back_or_message: people.reduce((x, y) => (y.hours_ago > x.hours_ago ? y : x)).ref } : {}),
    conversations_needing_the_owner: kind(a.replies),
    ...(replies.length ? { conversation_people: replies } : {}),
    asked_but_not_booked_last_30_days: kind(a.unbooked),
    ...(unbooked.length ? { asked_but_not_booked_people_oldest_first: unbooked } : {}),
    outside_area_requests_waiting_for_a_decision: kind(a.coverage),
    ...(outside.length ? { outside_area_people: outside } : {}),
    past_visits_without_outcome: kind(a.outcomes),
    card,
  }
}

const PAGES = {
  async overview(c) {
    const [o, next, ins, ads, site] = await Promise.all([
      part(overview(c.db, c.customer.id, c.now, c.internal)),
      part(setup(c)),
      part(insights(c.env, c.customer, c.now)),
      part(adsAccess(c.env, c.customer).then((ok) => (ok ? adSummary(c.db, c.customer.id, c.now, c.internal) : null))),
      part(websiteSummary(c.db, c.customer.id)),
    ])
    const real = (l) => l.filter((x) => !x.test)
    return {
      ...(o === UNREAD
        ? { last_30_days_tiles: UNREAD }
        : {
            last_30_days_tiles: { new_inquiries: o.stats.leads, booked: o.stats.booked, visits_marked_as_happened: o.stats.showed, no_shows: o.stats.noShow, jobs_completed: o.stats.completed, rate_tile: 'shown only after 5 recorded outcomes' },
            upcoming_section: { total: real(o.upcoming).length, first: await apptRefs(c, real(o.upcoming).slice(0, 3)), test_visits_also_listed_with_a_test_tag: o.upcoming.length - real(o.upcoming).length },
            how_did_it_go_section: { total: real(o.needsOutcome).length, first: await apptRefs(c, real(o.needsOutcome).slice(0, 3)), test_visits_also_listed_with_a_test_tag: o.needsOutcome.length - real(o.needsOutcome).length },
          }),
      next_step_card: next,
      suggestion_card: ins === UNREAD ? UNREAD : (ins[0] && { title: ins[0].title, evidence: ins[0].evidence }) || 'none',
      advertising_tiles_last_30_days: ads === null || ads === UNREAD ? (ads === null ? 'not shown: Ads is not available' : UNREAD) : { ad_spend: usd(ads.spendCents), clicks: ads.clicks ?? 'none reported', inquiries_from_ads: ads.leads, bookings: ads.booked, showed_up: ads.showed, cost_per_booking: ads.costPerBookingCents == null ? 'nothing to divide yet' : usd(ads.costPerBookingCents), ...(ads.testAccount ? { note: 'Google Ads test account: not real results' } : {}) },
      website_card: site === UNREAD ? UNREAD : site.published ? 'published' : 'not published',
    }
  },
  async appointments(c) {
    const [list, card] = await Promise.all([part(runTool(c, 'list_appointments', {})), part(runTool(c, 'list_leads', { which: 'outside_area', days: 90 }))])
    return { appointments: list, outside_area_requests: card === UNREAD || card.error ? UNREAD : { total: card.total, waiting_for_the_owner: card.items.filter((x) => /pending/.test(x.state)).length } }
  },
  async followups(c) {
    const r = await part(listThreads(c.env, c.customer.id, { now: c.now }))
    if (r === UNREAD) return { inbox: UNREAD }
    const need = r.threads.filter((t) => t.needsOwner && !t.test).slice(0, 8)
    return {
      tiles_last_30_days: { new_leads: r.counts.leads, contacted: r.counts.contacted, replied: r.counts.replied, booked: r.counts.booked, need_you: r.counts.needsYou },
      conversations_needing_the_owner: await Promise.all(need.map(async (t) => ({ ...((await leadByRefId(c, t.id)) || {}), why: NEEDS_OWNER[t.needsOwner] || 'needs the owner', ...(t.failures ? { messages_not_delivered: t.failures } : {}) }))),
      note: 'This inbox holds written conversations. Call-back requests are on Receptionist, not here.',
      automatic_follow_ups: c.customer.automations ? 'on' : 'paused',
      sending_to_customers: c.env.MESSAGES_LIVE === 'true' ? 'live' : 'not live yet',
    }
  },
  async receptionist(c) {
    const [set, conv, open] = await Promise.all([
      part(c.db.prepare('SELECT enabled, greeting, knowledge FROM receptionist_settings WHERE customer = ?1').bind(c.customer.id).first()),
      part(c.db.prepare("SELECT count(*) AS n, coalesce(sum(status = 'booked'), 0) AS booked, max(updated_at) AS last FROM receptionist_conversations WHERE customer = ?1 AND turns > 0 AND updated_at >= ?2").bind(c.customer.id, c.now - 30 * DAY).first()),
      part(openRequests(c.db, c.customer.id)),
    ])
    return {
      receptionist: set === UNREAD ? UNREAD : set?.enabled === 1 ? 'on (website chat)' : 'off',
      greeting: set === UNREAD ? UNREAD : set?.greeting ? 'set by the owner' : 'standard',
      owner_notes: set === UNREAD ? UNREAD : set?.knowledge ? 'written' : 'none',
      phone_calls: 'not available: no phone line is connected',
      conversations_last_30_days: conv === UNREAD ? UNREAD : { total: Number(conv?.n) || 0, booked: Number(conv?.booked) || 0 },
      needs_attention: open === UNREAD ? UNREAD : { total: open.length, people: open.slice(0, 8).map((r) => requestOut(c, r)) },
      how_to_clear: 'After calling or answering, the owner presses Mark done on this page, or approves a prepared "dealt with" card here.',
    }
  },
  async teach(c) {
    if (!(await part(studioAccess(c.env, c.customer)))) return { teach_your_ai: 'not available for this business' }
    const r = await part(recordsFor(c.env, c.customer, c.now).then((x) => loadRules(c.db, c.customer.id, x)))
    if (r === UNREAD) return { rules: UNREAD }
    return { rules: r.saved ? 'a draft is saved' : 'nothing saved yet (standard behaviour)', published_version: r.liveVersion ?? 'none', unpublished_changes: r.hasDraftChanges, problems_in_draft: r.errors.length, customers_get_the_published_rules: rulesLiveFor(c.env, c.customer.id) && r.liveVersion ? 'yes, when the receptionist is on' : 'not yet' }
  },
  async website(c) {
    const [s, d] = await Promise.all([part(websiteSummary(c.db, c.customer.id)), part(domainFor(c.env, c.customer.id))])
    return { website: s === UNREAD ? UNREAD : s.published ? 'published' : s.exists ? 'draft, not published' : 'none yet', own_domain: d === UNREAD ? UNREAD : d ? { status: d.status, step: d.step } : 'none connected', booking_page: 'has its own link and works without a website' }
  },
  async ads(c) {
    if (!(await part(adsAccess(c.env, c.customer)))) return { ads: 'not available for this business' }
    const id = c.customer.id
    const [conns, list, sum, hold, budget, imp, rec, live] = await Promise.all([
      part(c.db.prepare('SELECT platform, status FROM ad_connections WHERE customer = ?1').bind(id).all().then((r) => r.results)),
      part(listCampaigns(c.db, id)),
      part(adSummary(c.db, id, c.now, c.internal)),
      part(adsHold(c.env, id)),
      part(currentApproval(c.db, id)),
      part(importedTotals(c.db, id, { days: 30, now: c.now })),
      part(listRecommendations(c.db, id, { now: c.now })),
      part(liveFor(c.env, id)),
    ])
    return {
      ad_accounts: conns === UNREAD ? UNREAD : conns.length ? conns.map((x) => `${x.platform}: ${x.status}`) : 'none connected',
      campaigns_made_here: list === UNREAD ? UNREAD : list.slice(0, 8).map((k) => ({ platform: k.platform, status: k.status, daily_budget: k.dailyBudgetCents ? usd(k.dailyBudgetCents) : 'not set', launched: k.launched, ...(k.lastError ? { last_problem: 'the last action failed' } : {}) })),
      results_last_30_days: sum === UNREAD ? UNREAD : { ad_spend: usd(sum.spendCents), clicks: sum.clicks ?? 'none reported', inquiries_from_ads: sum.leads, bookings: sum.booked, showed_up: sum.showed, ...(sum.testAccount ? { note: 'Google Ads test account: not real results' } : {}) },
      hold: hold === UNREAD ? UNREAD : hold ? HOLD_REASONS[hold.reason] : 'none',
      monthly_budget_approved: budget === UNREAD ? UNREAD : budget ? usd(budget.monthly_cents) : 'none approved',
      campaigns_run_in_google_directly: imp === UNREAD ? UNREAD : imp ? { campaigns: imp.campaigns, spend: usd(imp.spendCents), clicks: imp.clicks ?? 'none reported', note: 'Google’s own numbers, separate from the results above' } : 'none read',
      suggestions: rec === UNREAD ? UNREAD : Object.values(rec).flat().slice(0, 4).map((x) => `${x.title}. ${x.suggestion || ''}`.trim()),
      starting_live_ads: live === true ? 'allowed after the owner approves' : 'not released yet by GetShowUps: a campaign made here would be created paused',
    }
  },
  async settings(c) {
    const [s, next] = await Promise.all([part(runTool(c, 'business_settings', {})), part(setup(c))])
    return { settings: s, setup_status: next }
  },
}

const STEP = { subscription: 'plan and billing', calendar: 'Google Calendar', hours: 'booking hours', page: 'website', domain: 'own domain', booking: 'first booking', email: 'customer emails', sms: 'text messages', ads: 'ads' }
async function setup(c) {
  const kv = await c.env.GOOGLE_TOKENS.get(`google:${c.customer.id}`)
  const r = await readiness(c.env, c.customer, { calendarStatus: kv ? 'healthy' : 'not_connected' })
  const todo = r.items.filter((i) => i.state === 'action').map((i) => `${STEP[i.id]}: ${i.detail === 'healthy' ? 'ok' : i.detail || 'not set'}`)
  return { to_do: todo.length ? todo : 'nothing', waiting: r.items.filter((i) => i.state === 'pending').map((i) => `${STEP[i.id]}: ${i.detail}`), calendar_note: 'last known; not checked with Google just now' }
}

// What each page is about and what the owner can do there, so neither is guessed.
const ABOUT = {
  overview: ['the business today', ['see what needs attention', 'record how a past visit went'], []],
  appointments: ['visits and people who have not booked', ['record outcomes and payments', 'cancel an upcoming visit', 'approve or decline outside-area requests'], ['move a visit to another time (cancel it; the customer picks a new time)', 'refunds']],
  followups: ['written conversations', ['write and send a reply to someone with a conversation', 'pause automatic follow-ups'], ['call-back requests (Receptionist)']],
  receptionist: ['the AI receptionist (website chat)', ['turn it on or off', 'greeting and notes', 'mark call backs and messages done'], ['phone calls']],
  teach: ['rules for how the receptionist answers', ['write, test and publish a rule'], []],
  website: ['the business website', ['edit, preview, publish', 'connect a domain'], []],
  ads: ['advertising', ['connect an ad account', 'prepare a campaign', 'approve a budget'], []],
  settings: ['business details and setup', ['services and prices', 'phone', 'service area', 'booking hours', 'Google Calendar', 'policies'], []],
}
export const pageState = async (c, page) => ({ this_page_is_about: ABOUT[page][0], owner_can_do_here: ABOUT[page][1], ...(ABOUT[page][2].length ? { not_possible_here: ABOUT[page][2] } : {}), ...(await PAGES[page](c)) })
export const selectedLead = async (c, id) => {
  const r = await leadByRefId(c, id)
  return r && { what: 'the conversation open on screen', ...r }
}
