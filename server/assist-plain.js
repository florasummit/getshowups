// The assistant without a model: where things are, what they mean, and what the records say. Exact or nothing: a question
// it doesn't understand returns null and the owner is told why the AI is out and what works. Used when the provider can't
// answer; places (placeAnswer) are answered this way always. Same tools, same session business, nothing saved.
import { insights } from './insights.js'
import { HELP } from '../src/content/help.js'
import { periodIn } from './assist.js'
import { runTool, toolContext } from './operator-tools.js'

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
const SETTING = (what) => ({ text: `${what} is in Settings.`, go: 'settings' })
const PLACES = [
  [/\b(help|assistant|chat) (button|icon|link|panel|menu)\b|\bthe help\b|\b(get|find) help\b/, { text: 'Help is at the top of every dashboard page: “Assistant” opens this panel, and “Help” next to it writes an email to our team. A small “?” beside a setting explains that setting.' }],
  [/\bsign ?out\b|\blog ?out\b/, { text: '“Sign out” is at the top right of every dashboard page.' }],
  [/\b(booking|business|working|opening)? ?hours\b/, SETTING('Booking hours')],
  [/\b(google )?calendar\b/, SETTING('Google Calendar')],
  [/\bservice area\b|\bzips?\b|\bzip codes?\b|\btowns\b/, SETTING('Your service area')],
  [/\bservices?\b|\bprices?\b|\bpricing\b|\bphone( number)?\b|\bbusiness (name|details)\b/, SETTING('That')],
  [/\bdomain\b/, { text: 'Your domain is on the Website page.', go: 'website' }],
  [/\bbudget\b|\bcampaigns?\b/, { text: 'Budget and campaigns are on the Ads page.', go: 'ads' }],
  [/\bgreeting\b|\bcall ?backs?\b/, { text: 'That is on the Receptionist page.', go: 'receptionist' }],
  [/\b(ai )?rules\b/, { text: 'Your AI’s rules are on Teach Your AI.', go: 'teach' }],
  [/\boutcomes?\b|\bmark\b|\bpayments?\b/, { text: 'Outcomes and payments are recorded on the Appointments page, next to each past visit.', go: 'appointments' }],
]
const PAGE_WORDS = [['overview', /\boverview\b|\bhome page\b/], ['appointments', /\bappointments?\b|\bbookings?\b|\bvisits?\b/], ['followups', /\bfollow ?ups?\b|\bleads?\b|\binquir(y|ies)\b/], ['teach', /\bteach( your ai)?\b/], ['receptionist', /\breceptionist\b/], ['website', /\bwebsite\b|\bmy site\b/], ['ads', /\bads?\b|\badvertising\b/], ['settings', /\bsettings?\b/]]
const WHERE = /^ (where (is|are|s|do i|can i|would i)|wheres|how (do|can) i (find|open|get to|go to|see|access|change|edit|update|connect|add|mark|record|reach)|(take|bring) me to|go to|open|show me (the )?(settings|website|ads|help|overview)( page)?) /
const THIS_PAGE = /^ (what (is|does|can i do (on|with|in))|explain|hows?|how does) (this|here|the) ?(page|screen|tab|section)? ?(for|do|work|about|mean)? $|^ what (is|can i do|do i do) (here|on this page) $|^ what is this $/

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
  const parts = [...t.split(/\s+/), t.replace(/\s+/g, '')]
  return list.some((x) => parts.some((p) => p === x || (x.length > 6 && near(p, x))))
}
// What a question asks the records for. Anything asking for a reason, a draft or a change is the model's.
export function intentOf(q) {
  const w = words(q)
  // Another business's records: this is the only one there is. Never answered with this one's numbers.
  if (has(w, /\b(another|other|different|someone elses|competitors?) (\w+ )?(business(es|s)?|company?s?|companies|accounts?|owners?)\b|\bcompetitors?\b/)) return 'other'
  if (has(w, /\bwhat (should|do|can) i (improve|fix|do|work on|focus on|look at)\b|\b(improve|fix) first\b|\bpriorit\w+\b/)) return 'priorities'
  if (has(w, /\b(change|update|set|edit) (my|our|the)( \w+)? hours\b/)) return 'change_hours'
  if (has(w, /\b(revenue|paid|payments|earned|income)\b/) && !has(w, /\b(why|advert\w*|ads?|campaigns?|roi|return)\b/)) return 'money'
  if (has(w, /\b(why|draft|write|prepare|add|remove|change|mark|cancel|reschedule|should|improve|compare|revenue|advert\w*|ads?|campaigns?|roi)\b/)) return null
  if (has(w, /\b(open|free|available) (times?|slots?|appointments?)\b|\bavail\w+\b|\bwhen (can|could) (someone|people|customers?) book\b/)) return 'times'
  if (has(w, /\b(ask(ing|ed)?|want(ing|ed)?|need(ing|ed)?|request(s|ed|ing)?)( me| us)? (for|about)\b|\bwhat (do|did|are) (people|customers|they|leads)( \w+)? (want|need|ask)/)) return 'needs'
  if (has(w, /\b(my|our|the|what|booking|business) hours\b|\bwhen (am|are) (i|we) open\b/)) return 'hours'
  if (has(w, /\b(my|our|the) (services|prices|towns|service area|settings|zips?|zip codes?)\b|\b(what|which) (services|zips?|zip codes?|towns)\b/)) return 'settings'
  if (mentions(w, ['unanswered', 'answered', 'waiting'])) return 'unanswered'
  if (has(w, /\b(how many|how much|numbers|results|stats|statistics|how (is|are|am) (it|things|we|i|(my |the )?business) (going|doing|performing))\b/)) return 'numbers'
  if (mentions(w, ['appointment', 'appointments', 'schedule', 'visits', 'calendar']) || has(w, /\bcoming up\b/)) return 'appointments'
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
  if (intent === 'change_hours') return { kind: 'help', answer: 'You can change booking hours in Settings. Preparing the change for you in this chat needs AI, which isn’t available right now. Nothing was changed.', go: 'settings' }
  if (intent === 'priorities') {
    const list = (await insights(env, customer)).slice(0, 3)
    return { kind: 'records', answer: list.length ? `From your records, most important first:\n${list.map((x, i) => `${i + 1}. ${x.title}. ${x.evidence?.[0] ?? ''}`.trim()).join('\n')}` : 'Nothing in your records needs fixing right now.', ...(list[0]?.home ? { go: list[0].home } : {}) }
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
    if (intent === 'hours') return { kind: 'records', answer: `Your booking hours: ${r.booking_hours}. ${r.appointment_minutes} minutes each, ${r.time_zone}.`, go: 'settings' }
    const z = r.service_area_zips
    return { kind: 'records', answer: `Services: ${r.services.map((s) => `${s.name} (${s.price})`).join(', ') || 'none added yet'}. Towns: ${r.towns.join(', ') || 'none added yet'}. Service area: ${Array.isArray(z) ? z.join(', ') : z}. Hours: ${r.booking_hours}.`, go: 'settings' }
  }
  if (intent === 'numbers' || intent === 'money') {
    const r = await run('business_numbers', { period: period ?? (days === 7 ? 'last_7_days' : days === 90 ? 'last_90_days' : 'last_30_days') })
    if (r && intent === 'money') return { kind: 'records', answer: `Payments you recorded (${r.period}): ${r.payments_recorded}. Money nobody recorded isn’t counted.` }
    return r && { kind: 'records', answer: `${r.period}: ${r.new_inquiries} new inquiries, ${r.bookings_made} bookings made, ${r.visits_happened} visits marked as happened, payments recorded: ${r.payments_recorded}.` }
  }
  if (intent === 'appointments') {
    const r = await run('list_appointments', period ? { period } : {})
    if (!r) return null
    return shown((r.total ?? r.upcoming.total + r.outcome_not_recorded.total) ? 'Here’s what’s recorded:' : 'Nothing like that is recorded right now.')
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

// What to offer when the AI is out: these always work on this page without it.
export const worksWithoutAi = (view) => ({ teach: ['What do people ask me for?', 'What is this page for?'], appointments: ['What’s coming up?', 'What open times do I have?'], followups: ['Who hasn’t been answered?', 'Who asked recently?'], receptionist: ['Who asked recently?', 'What is this page for?'], settings: ['What are my hours?', 'What are my services?'] })[view] || ['What’s coming up?', 'Who asked recently?']
