// The assistant without a model: where things are, what they mean, and what the records say. Exact or nothing: a question
// it doesn't understand returns null and the owner is told why the AI is out and what works. Used when the provider can't
// answer; places (placeAnswer) are answered this way always. Same tools, same session business, nothing saved.
import { insights } from './insights.js'
import { HELP } from '../src/content/help.js'
import { IDEAS } from '../src/content/assistant-ideas.js'
import { humanDate, plural } from '../src/lib/format.js'
import { periodIn } from './assist.js'
import { runTool, toolContext } from './operator-tools.js'
import { attention, attentionCard } from './attention.js'
import { setupCheck } from './setup-check.js'
import { funnel } from './ads/funnel.js'
import { adsAccess } from './ads/access.js'
import { internalEmails } from './testdata.js'

const words = (q) => ` ${q.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `
const has = (w, re) => re.test(w)

// What each page is for, and where controls are. Only what the dashboard really shows.
export const PAGES = {
  overview: ['Overview', 'what needs your attention, your last 30 days, and upcoming appointments'],
  appointments: ['Appointments', 'upcoming and past visits, where you mark what happened and what was paid, and people who haven’t booked yet'],
  followups: ['Follow-ups', 'people who contacted you and where each conversation stands'],
  receptionist: ['Receptionist', 'your AI receptionist: on or off, greeting, notes, conversations and call-back requests'],
  teach: ['Teach Your AI', 'rules for how your receptionist answers: write a change, test it, then publish it'],
  website: ['Website', 'your website: edit, preview, publish and connect your domain'],
  ads: ['Ads', 'your ad accounts, campaign drafts, budget and results'],
  settings: ['Settings', 'your business details, services and prices, service area, booking hours, Google Calendar and notices'],
}
// `go` may name a card on the page ("settings#booking-hours"): the panel's button opens the page and scrolls to it.
const SETTING = (what, card = '') => ({ text: `${what} is in Settings.`, go: `settings${card}` })
const PLACES = [
  [/\b(help|assistant|chat) (button|icon|link|panel|menu)\b|\bthe help\b|\b(get|find) help\b/, { text: 'Help is at the top of every dashboard page: “Assistant” opens this panel, and “Help” next to it opens the help topics and our email address. A small “?” beside a setting explains that setting.' }],
  [/\bsign ?out\b|\blog ?out\b/, { text: '“Sign out” is at the top right of every dashboard page.' }],
  [/\b(booking|business|working|opening)? ?hours\b/, SETTING('Booking hours', '#booking-hours')],
  [/\b(google )?calendar\b/, SETTING('Google Calendar', '#google-calendar')],
  [/\bservice area\b|\bzips?\b|\bzip codes?\b|\btowns\b/, SETTING('Your service area', '#business')],
  [/\bservices?\b|\bprices?\b|\bpricing\b|\bphone( number)?\b|\bbusiness (name|details)\b/, SETTING('That')],
  [/\bdomain\b/, { text: 'Your domain is on the Website page.', go: 'website' }],
  [/\bbudget\b|\bcampaigns?\b/, { text: 'Budget and campaigns are on the Ads page.', go: 'ads' }],
  [/\bgreeting\b|\bcall ?backs?\b/, { text: 'That is on the Receptionist page.', go: 'receptionist' }],
  [/\b(ai )?rules\b/, { text: 'Your AI’s rules are on Teach Your AI.', go: 'teach' }],
  [/\boutcomes?\b|\bmark\b|\bpayments?\b/, { text: 'Outcomes and payments are recorded on the Appointments page, next to each past visit.', go: 'appointments' }],
]
const PAGE_WORDS = [['overview', /\boverview\b|\bhome page\b/], ['appointments', /\bappointments?\b|\bbookings?\b|\bvisits?\b/], ['followups', /\bfollow ?ups?\b|\bleads?\b|\binquir(y|ies)\b/], ['teach', /\bteach( your ai)?\b/], ['receptionist', /\breceptionist\b/], ['website', /\bwebsite\b|\bmy site\b/], ['ads', /\bads?\b|\badvertising\b/], ['settings', /\bsettings?\b/]]
const WHERE = /^ (where (is|are|s|do i|can i|would i)|wheres|how (do|can) i (find|open|get to|go to|see|access|change|edit|update|connect|add|mark|record|reach)|(take|bring) me to|go to|open|show me (the )?(settings|website|ads|help|overview)( page)?) /
const THIS_PAGE = /^ (what (is|does|can i do (on|with|in))|explain|hows?|how does) (this|the) (page|screen|tab) ?(for|do|work|about|mean)? $|^ what (is|can i do|do i do) (here|on this page) $/

// "Where is the help button?", "How do I change my hours?", "What is this page for?". Never reads records.
export function placeAnswer({ question, view, topic }) {
  const w = words(question)
  if (!topic && has(w, THIS_PAGE)) return { answer: `This is ${PAGES[view][0]}: ${PAGES[view][1]}.` }
  if (!has(w, WHERE)) return null
  // A person, place or time is data, not a control ("where is my next appointment", "where are my leads coming from").
  if (has(w, /\b(next|from|coming|today|tomorrow|week|most|losing|lost|drop\w*|customers?|should|money|going|better|more|best)\b/)) return null
  for (const [re, p] of PLACES) if (has(w, re)) return { answer: p.text, ...(p.go ? { go: p.go } : {}) }
  if (has(w, /\bbooking (page|link)\b|\b(add|record|mark|connect)\b/)) return null
  for (const [v, re] of PAGE_WORDS) if (has(w, re)) return { answer: `${PAGES[v][0]} is in the menu at the top: ${PAGES[v][1]}.`, go: v }
  return null
}

// The curated help topic a question names, longest title first; null when none or the question is about the owner's data.
const TITLES = Object.entries(HELP).map(([id, t]) => [id, words(t.title)]).sort((a, b) => b[1].length - a[1].length)
export const topicIn = (q) => TITLES.find(([, t]) => words(q).includes(t))?.[0] ?? null
const EXPLAIN = /^ (what|whats|explain|define|tell me (about|what)|how does|how do|why (is|are|does|do)|meaning of) /

const PERIODS = [[/\btoday\b/, 'today'], [/\btom+or+ow\b|\btmrw\b/, 'tomorrow'], [/\bnext week\b/, 'next_week'], [/\bthis week\b/, 'this_week'], [/\byesterday\b/, 'yesterday'], [/\blast week\b/, 'last_week'], [/\b(next 7 days|coming days)\b/, 'next_7_days']]
const periodOf = (w) => PERIODS.find(([re]) => has(w, re))?.[1]

const near = (word, want) => {
  if (Math.abs(word.length - want.length) > 3 || word.length < 4) return false
  const row = Array.from({ length: want.length + 1 }, (_, i) => i)
  for (let i = 1; i <= word.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= want.length; j++) {
      const t = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (word[i - 1] === want[j - 1] ? 0 : 1))
      prev = t
    }
  }
  return row[want.length] <= 3
}
const mentions = (w, list) => {
  const t = w.replace(/[^a-z ]/g, '').trim()
  const ws = t.split(/\s+/)
  const parts = [...ws, ...ws.slice(1).map((x, i) => ws[i] + x)] // "app oinmntes" is one word
  return list.some((x) => parts.some((p) => p === x || (x.length > 6 && near(p, x))))
}
// What a question asks the records for. Anything asking for a reason, a draft or a change is the model's.
export function intentOf(q) {
  const w = words(q)
  // Another business's records: this is the only one there is. Never answered with this one's numbers.
  if (has(w, /\b(another|other|different|someone elses|competitors?) (\w+ )?(business(es|s)?|company?s?|companies|accounts?|owners?)\b|\bcompetitors?\b/)) return 'other'
  if (has(w, /\bwhat (should|do|can) i (improve|fix|do|work on|focus on|look at)\b|\b(improve|fix|change) first\b|\bpriorit\w+\b/)) return 'priorities'
  if (has(w, /\b(change|update|set|edit) (my|our|the)( \w+)? hours\b/)) return 'change_hours'
  if (has(w, /\b(revenue|paid|payments|earned|income)\b/) && !has(w, /\b(why|advert\w*|ads?|campaigns?|roi|return)\b/)) return 'money'
  if (has(w, /\b(why|draft|write|prepare|add|remove|change|mark|cancel|reschedule|should|improve|compare|revenue|advert\w*|ads?|campaigns?|roi)\b/)) return null
  if (has(w, /\b(open|free|available) (times?|slots?|appointments?)\b|\bavail\w+\b|\bwhen (can|could) (someone|people|customers?) book\b/)) return 'times'
  if (has(w, /\b(ask(ing|ed)?|want(ing|ed)?|need(ing|ed)?|request(s|ed|ing)?)( me| us)? (for|about)\b|\bwhat (do|did|are) (people|customers|they|leads)( \w+)? (want|need|ask)/)) return 'needs'
  if (has(w, /\b(my|our|the|what|booking|business) hours\b|\bwhen (am|are) (i|we) open\b/)) return 'hours'
  if (has(w, /\b(my|our|the) (services|prices|towns|service area|settings|zips?|zip codes?)\b|\b(what|which) (services|zips?|zip codes?|towns)\b/)) return 'settings'
  if (mentions(w, ['unanswered', 'answered', 'waiting'])) return 'unanswered'
  if (has(w, /\b(how many|how much|numbers|results|stats|statistics|how (is|are|am) (it|things|we|i|(my |the )?business) (going|doing|performing))\b/)) return 'numbers'
  if (mentions(w, ['appointment', 'appointments', 'schedule', 'visits', 'calendar']) || has(w, /\bcoming up\b|^ whats on /)) return 'appointments'
  if (mentions(w, ['leads', 'lead', 'inquiry', 'inquiries']) || has(w, /\bwho asked\b/)) return 'leads'
  return null
}
const SHORT_FOLLOW = /^ (and |what about |how about |ok |then )*(for )?(today|tomorrow|tmrw|yesterday|this week|next week|last week|(the )?(last|past) \w+( \w+)?)( then)? $/

// → { kind, answer, records?, go?, refs } | null
export async function plainAnswer(env, customer, req) {
  const place = placeAnswer(req)
  if (place) return { kind: 'help', ...place }
  const w = words(req.question)
  const prior = [...(req.history || [])].reverse()
  // "Why?" / "What does that mean?": about the selected explanation, or the one the conversation just named.
  const asksWhy = has(w, /^ (but )?(why|how come|why not|why is that|why does (it|that) matter|explain|what does (it|that) mean|tell me more|more) $/)
  if (asksWhy) {
    const id = req.topic || prior.map((h) => topicIn(h.q)).find(Boolean)
    if (id) return { kind: 'help', answer: `${HELP[id].title}: ${HELP[id].why} Next: ${HELP[id].next}` }
    if (prior[0] && intentOf(prior[0].q)) return { kind: 'records', answer: `I can’t explain the reasons behind “${prior[0].q.slice(0, 80)}” without AI. Records show what happened, not why a person did it.` }
    if (prior[0] && placeAnswer({ question: prior[0].q, view: req.view })) return { kind: 'help', answer: 'That’s where it is on the page. If you meant something else, say a little more, like “why does the service area matter?”' }
    return null
  }
  const q = req.question
  let intent = intentOf(q)
  if (!intent && has(w, SHORT_FOLLOW)) intent = prior.map((h) => intentOf(h.q)).find(Boolean) ?? null
  const topic = topicIn(q)
  if (topic && has(w, EXPLAIN) && !has(w, /\b(my|our|me|us)\b/)) return { kind: 'help', answer: `${HELP[topic].what} ${HELP[topic].why}` }
  if (!intent) return null

  if (intent === 'other') return { kind: 'help', answer: 'I only have this business’s records. Other businesses’ information isn’t available here.' }
  if (intent === 'change_hours') return { kind: 'help', answer: 'You can change booking hours in Settings. Preparing the change for you in this chat needs AI, which isn’t available right now. Nothing was changed.', go: 'settings#booking-hours' }
  if (intent === 'priorities') {
    // The same three sources the dashboard shows, in the order Overview lists them: people waiting, then what the setup
    // check found, then suggestions. A part that can't be read is left out, never guessed.
    const [card, setup, found] = await Promise.all([attention(env, customer.id).then(attentionCard).catch(() => null), setupCheck(env, customer).catch(() => null), insights(env, customer).catch(() => [])])
    const list = [
      ...(card?.items || []).map((x) => ({ text: `${x.text}.`, go: x.page })),
      ...(setup?.items || []).filter((x) => x.level !== 'optional').map((x) => ({ text: `${x.title}. ${x.why}`, go: x.where })),
      ...found.map((x) => ({ text: `${x.title}. ${x.evidence?.[0] ?? ''}`.trim(), go: x.home })),
    ].slice(0, 3)
    return { kind: 'records', answer: list.length ? `From your records, most important first:\n${list.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}` : 'Nothing in your records needs fixing right now.', ...(list[0]?.go ? { go: list[0].go } : {}) }
  }
  const c = toolContext(env, customer, req.refs)
  const run = async (name, args = {}) => {
    const r = await runTool(c, name, args)
    return r.error && r.error !== 'calendar_unavailable' ? null : r
  }
  const shown = (answer) => ({ kind: 'records', answer, records: [...c.shown.values()].slice(0, 8), refs: c.refs.book })
  const period = periodOf(words(q))
  const days = periodIn(q) ?? (has(words(q), /\byear\b/) ? 365 : null)
  if (intent === 'times') {
    const r = await run('open_times', period ? { period } : {})
    if (!r) return null
    if (r.error) return { kind: 'records', answer: 'Your Google Calendar can’t be read right now, so open times are unknown. Settings shows its status.', go: 'settings' }
    return { kind: 'records', answer: r.open_times ? `${r.open_times} open ${r.open_times === 1 ? 'time' : 'times'} (${r.period}). First: ${r.first_times.slice(0, 4).join('; ')}.` : `No open times (${r.period}).` }
  }
  if (intent === 'hours' || intent === 'settings') {
    const r = await run('business_settings')
    if (!r) return null
    if (intent === 'hours') return { kind: 'records', answer: `Your booking hours: ${r.booking_hours}. ${r.appointment_minutes} minutes each, ${zoneWords(r.time_zone)}.`, go: 'settings#booking-hours' }
    const z = r.service_area_zips
    return { kind: 'records', answer: `Services: ${r.services.map((s) => `${s.name} (${s.price})`).join(', ') || 'none added yet'}. Towns: ${r.towns.join(', ') || 'none added yet'}. Service area: ${Array.isArray(z) ? z.join(', ') : z}. Hours: ${r.booking_hours}.`, go: 'settings' }
  }
  if (intent === 'numbers' || intent === 'money') {
    const r = await run('business_numbers', { period: period ?? (days === 7 ? 'last_7_days' : days === 90 ? 'last_90_days' : 'last_30_days') })
    if (r && intent === 'money') return { kind: 'records', answer: `Payments you recorded (${r.period}): ${r.payments_recorded}. Money nobody recorded isn’t counted.` }
    return r && { kind: 'records', answer: `${sentence(r.period)}: ${countsLine(r)}, payments recorded: ${r.payments_recorded}.` }
  }
  if (intent === 'appointments') {
    // "Which visits need an outcome?": past ones nobody marked.
    if (has(w, /\b(outcomes?|not marked|unmarked)\b/)) {
      const r = await run('list_appointments', { state: 'needs_outcome' })
      return r && shown(r.total ? `${plural(r.total, 'past visit')} still ${r.total === 1 ? 'needs' : 'need'} an outcome. Mark them on Appointments:` : 'No. Every past visit has an outcome.')
    }
    const r = await run('list_appointments', period ? { period } : {})
    if (!r) return null
    if (r.total === undefined) return shown(r.upcoming.total + r.outcome_not_recorded.total ? `${plural(r.upcoming.total, 'upcoming visit')}${r.outcome_not_recorded.total ? `, and ${plural(r.outcome_not_recorded.total, 'past visit')} without an outcome` : ''}:` : 'Nothing is coming up, and no past visit is waiting for an outcome.')
    return shown(r.total ? `${plural(r.total, 'appointment')} (${r.period}):` : `Nothing is booked (${r.period}).`)
  }
  if (intent === 'needs') {
    const span = days ?? 90
    const r = await run('list_leads', { which: 'recent', days: span })
    if (!r) return null
    if (!r.total) return shown(`Nobody left a request in the last ${span} days.`)
    const count = new Map()
    for (const x of c.shown.values()) {
      const k = String(x.what || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'nothing written'
      const key = k.toLowerCase()
      count.set(key, { text: count.get(key)?.text ?? k, n: (count.get(key)?.n ?? 0) + 1 })
    }
    const list = [...count.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((x) => `“${x.text}”${x.n > 1 ? ` (${x.n})` : ''}`)
    return shown(`What people wrote, from your ${r.shown < r.total ? `latest ${r.shown} of ${r.total}` : r.total} ${r.total === 1 ? 'request' : 'requests'} in the last ${span} days: ${list.join(', ')}.`)
  }
  const r = await run('list_leads', { which: intent === 'unanswered' ? 'unanswered' : 'recent', ...(days ? { days } : {}) })
  return r && shown(!r.total ? 'Nothing like that is recorded right now.' : intent === 'unanswered' ? 'Nothing has been sent to these people yet:' : 'Your latest inquiries:')
}

// "Eastern Time", never the zone's code ("America/New_York"); an unknown zone is shown as it is stored.
const zoneWords = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(0).find((p) => p.type === 'timeZoneName')?.value || tz
  } catch {
    return tz
  }
}
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1)
// One wording for the three counts, wherever the assistant gives them (the same counts Overview shows for 30 days).
const countsLine = (r) => `${plural(r.new_inquiries, 'new inquiry', 'new inquiries')}, ${plural(r.bookings_made, 'booking')} made, ${plural(r.visits_happened, 'visit')} marked as happened`

// The panel's own suggestions (src/content/assistant-ideas.js) and the countable follow-ups under a number
// (src/content/help.js `ask`) are offered by the product, so each must return the fact it asks for. These are answered
// from the records, always and without a model; the same words typed by hand get the same answer. A suggestion that asks
// for writing or a judgement ("Draft a follow-up for me") is not here: that is the model's, and null is returned.
const key = (q) => words(q).trim()
const OFFERED = new Set([...Object.values(IDEAS).flat(), ...Object.values(HELP).flatMap((t) => t.ask || [])].map(key))
export const isOffered = (question) => OFFERED.has(key(question))
export async function offeredAnswer(env, customer, req) {
  if (!isOffered(req.question)) return null
  const w = words(req.question)
  const c = toolContext(env, customer, req.refs)
  const run = async (name, args = {}) => {
    const r = await runTool(c, name, args)
    return r.error ? null : r
  }
  const shown = (answer) => ({ kind: 'records', answer, records: [...c.shown.values()].slice(0, 8), refs: c.refs.book })
  const span = req.days === 7 ? 'last_7_days' : req.days === 90 ? 'last_90_days' : 'last_30_days'
  if (has(w, /\b(left to mark|need an outcome)\b/)) {
    const r = await run('list_appointments', { state: 'needs_outcome' })
    return r && shown(r.total ? `${plural(r.total, 'past visit')} still ${r.total === 1 ? 'needs' : 'need'} an outcome. Mark them on Appointments:` : 'No. Every past visit has an outcome.')
  }
  if (has(w, /\boutside my area\b/)) {
    const r = await run('list_leads', { which: 'outside_area', days: 90 })
    return r && shown(r.total ? `${plural(r.total, 'person', 'people')} asked from outside your service area in the last 90 days:` : 'Nobody asked from outside your service area in the last 90 days.')
  }
  if (has(w, /\bcompare the last 30 days\b/)) {
    const r = await run('compare_periods', { first: 'last_30_days', second: 'previous_30_days' })
    return r && { kind: 'records', answer: `Last 30 days: ${countsLine(r.first)}, payments recorded: ${r.first.payments_recorded}.\nThe 30 days before: ${countsLine(r.second)}, payments recorded: ${r.second.payments_recorded}.\nWith counts this small, a difference isn’t a trend.` }
  }
  if (has(w, /\b(ads bring in|leads came from ads|of these became bookings|get for this spend)\b/)) {
    if (!(await adsAccess(env, customer))) return { kind: 'help', answer: 'Ads aren’t available for this business right now, so there is nothing from ads to show.' }
    const f = await funnel(env.ONBOARDING_DB, customer.id, { days: req.days || 30, scope: 'ads', internal: internalEmails(env) })
    const usd = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
    return { kind: 'records', answer: `From leads traced to your ads in the last ${f.range.days} days: ${plural(f.stages.leads, 'inquiry', 'inquiries')}, ${f.stages.booked} booked, ${f.stages.attended} marked as happened. Payments you recorded for those jobs: ${f.revenue.paidCents == null ? 'none recorded' : usd(f.revenue.paidCents)}. Ad spend Google reported: ${f.spend.cents == null ? 'none reported' : usd(f.spend.cents)}. How much of this the ads caused isn’t measured.`, go: 'ads' }
  }
  if (has(w, /\b(inquiries became bookings|no shows did i have)\b/)) {
    const r = await run('business_numbers', { period: span })
    if (!r) return null
    return { kind: 'records', answer: has(w, /\bno shows\b/) ? `${sentence(r.period)}: ${plural(r.no_shows, 'no-show')}, ${plural(r.visits_happened, 'visit')} marked as happened${r.past_visits_without_outcome ? `, ${plural(r.past_visits_without_outcome, 'past visit')} not marked yet` : ''}.` : `${sentence(r.period)}: ${plural(r.new_inquiries, 'new inquiry', 'new inquiries')} and ${plural(r.bookings_made, 'booking')} made. A booking can come from an earlier inquiry, so this isn’t a rate.` }
  }
  if (has(w, /\bzip codes do i list\b/)) {
    const r = await run('business_settings')
    if (!r) return null
    const z = r.service_area_zips
    return { kind: 'records', answer: Array.isArray(z) && z.length ? `You list ${plural(z.length, 'ZIP code')}: ${z.join(', ')}.` : 'You list no ZIP codes, so anyone can book wherever they are.', go: 'settings#business' }
  }
  // The rest are ordinary record questions ("What are my hours?", "Who asked recently?"): asked on their own, not as a
  // follow-up to whatever was said before.
  return plainAnswer(env, customer, { ...req, history: [], topic: null })
}

// A typed QUESTION about one fact the records hold (DASH-01): a listed service's price, the minimum notice, the closed
// dates. Answered from the records with no model call when the match is unambiguous; anything else (a request, a "why",
// advice, a service that isn't listed or matches more than one) returns null and goes the usual way.
const FACT_Q = /^ (what|whats|how much|how long|how far|when|which|do i|do we|is|are|am i|tell me) /
const NOT_FACT = /\b(why|should|draft|write|change|set|update|edit|raise|lower|increase|decrease|add|remove|stop|mark|record|cancel|compare|improve|better|competitors?|average|typical|others)\b/
const ASKS_PRICE = /\b(how much|price|prices|pricing|cost|costs|charge|charges|rate|fee)\b/
const ASKS_NOTICE = /\b(minimum )?notice\b|\bhow (far|long) (in advance|ahead|before)\b|\bsame day\b|\blast minute\b/
const ASKS_CLOSED = /\bclosed (dates?|days?)\b|\bholidays?\b|\bdays? off\b|\bwhen (am i|are we) closed\b/
const significant = (s) => words(s).trim().split(' ').filter((x) => x.length > 2 && !['the', 'and', 'for', 'with', 'per', 'visit', 'service', 'services'].includes(x))
export async function typedFactAnswer(env, customer, req) {
  const w = words(req.question)
  if (!has(w, FACT_Q) || has(w, NOT_FACT)) return null
  const want = has(w, ASKS_NOTICE) ? 'notice' : has(w, ASKS_CLOSED) ? 'closed' : has(w, ASKS_PRICE) ? 'price' : null
  if (!want) return null
  const r = await runTool(toolContext(env, customer, req.refs), 'business_settings', {})
  if (!r || r.error) return null
  if (want === 'notice') {
    if (r.minimum_booking_notice === 'could not be read') return null
    const m = /^(\d+) minutes$/.exec(r.minimum_booking_notice)
    const said = m ? (Number(m[1]) % 60 === 0 ? plural(Number(m[1]) / 60, 'hour') : plural(Number(m[1]), 'minute')) : null
    return { kind: 'records', answer: said ? `Your minimum notice is ${said}: nobody can book a time that starts sooner than that.` : 'You have no minimum notice: a customer can book a time that starts in a few minutes.', go: 'settings#closed-dates' }
  }
  if (want === 'closed') {
    if (!Array.isArray(r.closed_dates)) return r.closed_dates === 'none' ? { kind: 'records', answer: 'You have no closed dates. Customers can book any of your booking days.', go: 'settings#closed-dates' } : null
    const list = r.closed_dates.map((x) => x.replace(/^(\d{4}-\d{2}-\d{2})/, (d) => humanDate(d)))
    return { kind: 'records', answer: `Closed: ${list.join('; ')}.`, go: 'settings#closed-dates' }
  }
  // A price: exactly one listed service whose every significant word is in the question.
  const asked = new Set(significant(req.question))
  const hits = r.services.filter((s) => {
    const name = significant(s.name)
    return name.length && name.every((x) => asked.has(x) || asked.has(`${x}s`) || asked.has(x.replace(/s$/, '')))
  })
  if (hits.length !== 1) return null
  const s = hits[0]
  return { kind: 'records', answer: s.price === 'no price listed' ? `${s.name} has no price listed. Add one in Settings, in “Services and prices”.` : `${s.name}: ${s.price}, as listed in Settings.`, go: 'settings#services' }
}

// What to offer when the AI is out: these always work on this page without it.
export const worksWithoutAi = (view) => ({ teach: ['What do people ask me for?', 'What is this page for?'], appointments: ['What’s coming up?', 'What open times do I have?'], followups: ['Who hasn’t been answered?', 'Who asked recently?'], receptionist: ['Who asked recently?', 'What is this page for?'], settings: ['What are my hours?', 'What are my services?'] })[view] || ['What’s coming up?', 'Who asked recently?']
