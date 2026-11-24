// The dashboard assistant's edges: request validation, curated help, evidence blocks and what works without a model. The
// conversation itself (tools, reasoning, checks) is server/operator.js. Off: AI_ASSIST_ENABLED=false or
// AI_ASSIST_CHAT_ENABLED=false.
import { HELP } from '../src/content/help.js'
import { diagnose, funnel } from './ads/funnel.js'
import { adsAccess } from './ads/access.js'
import { serviceAreaProposal, wantsServiceArea } from './proposals.js'
import { runTool, toolContext } from './operator-tools.js'
import { operatorConfigured } from './operator-model.js'
import { businessEligible } from './eligibility.js'
import { internalEmails } from './testdata.js'

export const LIMITS = { question: 500, answer: 900, history: 6 }
export const VIEWS = ['overview', 'appointments', 'followups', 'receptionist', 'teach', 'website', 'ads', 'settings']
export const PERIODS = [7, 30, 90]

export const chatEnabled = (env) => env.AI_ASSIST_CHAT_ENABLED !== 'false'
export const chatAccess = async (env, customer) => env.AI_ASSIST_ENABLED !== 'false' && chatEnabled(env) && operatorConfigured(env) && businessEligible(env, customer)

const clean = (v) => String(v ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()

// Which of the three periods a text names; null = none of them.
const SPOKEN = { 7: /\b(?:(?:7|seven)[- ]days?|(?:last|past|this) week)\b/i, 30: /\b(?:(?:30|thirty)[- ]days?|(?:last|past|this) month)\b/i, 90: /\b(?:(?:90|ninety)[- ]days?|(?:last|past) (?:quarter|(?:3|three) months))\b/i }
export const periodIn = (t) => PERIODS.find((d) => SPOKEN[d].test(t)) ?? null

export function validateQuestion(b) {
  const topic = b?.topic == null ? null : String(b.topic)
  if (topic !== null && !Object.hasOwn(HELP, topic)) return ['invalid_request']
  const view = b?.view == null ? 'overview' : String(b.view)
  if (!VIEWS.includes(view)) return ['invalid_request']
  const question = clean(b?.question)
  if (question.length < 2) return ['empty_question']
  if (question.length > LIMITS.question) return ['too_long']
  // days = the period of the Ads results being looked at; left out on every other screen. A period named in the question
  // wins. Anything else is refused: a period is never silently replaced by another.
  if (b.days !== undefined && !PERIODS.includes(b.days)) return ['invalid_request']
  const h = b.history === undefined ? [] : b.history
  if (!Array.isArray(h) || h.length > 20) return ['invalid_request']
  const history = h.slice(-LIMITS.history).map((x) => ({ q: clean(x?.q).slice(0, 200), a: String(x?.a ?? '').replace(/[^\P{Cc}\n]/gu, ' ').trim().slice(0, 900) }))
  const named = periodIn(question)
  const pending = (Array.isArray(b.pending) ? b.pending : []).slice(0, 4).map((p) => ({ type: String(p?.type || '').slice(0, 20), ref: /^[AL]\d{1,3}$/.test(String(p?.ref)) ? p.ref : null, change: clean(p?.change).slice(0, 160) }))
  const refs = b.refs && typeof b.refs === 'object' && !Array.isArray(b.refs) ? { A: b.refs.A, L: b.refs.L } : {}
  return [null, { topic, view, question, history, pending, refs, days: named ?? b.days ?? 30, results: b.days !== undefined }]
}

// "What is a qualified lead?" is answered from the curated help, word for word, without a model.
export function helpFor(question) {
  const m = /^(?:what(?:['’]s| is| are| does| do)|explain|define)\s+(?:an? |the |my |your )?(.+?)(?: mean(?:s)?)?\s*[?.!]*$/i.exec(question)
  if (!m) return null
  const want = m[1].toLowerCase()
  const hit = Object.entries(HELP).find(([, t]) => t.title.toLowerCase() === want)
  return hit ? `${hit[1].what} ${hit[1].why}` : null
}

const FUNNEL_Q = /\b(leads?|inquir\w+|bookings?|booked|jobs?|customers?|conver\w+)\b/i
const WHY_Q = /\b(why|where|bottleneck|losing|lose|lost|drop\w*|low|few|not|never|no|isn['’]?t|aren['’]?t|improve)\b/i
export const wantsFunnel = (q) => FUNNEL_Q.test(q) && WHY_Q.test(q) && /\b(book|conver|becom|turn|drop|los|bottleneck|funnel|get(ting)?|enough)/i.test(q)
const SENSITIVE = /\b(legal\w*|law\w*|lie|lying|llc|licen[cs]\w*|sue\w*|liab\w*|contracts?|tax\w*|irs|deduct\w*|payroll|employees?|contractors?|insur\w*|loans?|invest\w*|bankrupt\w*)\b/i
export const isSensitive = (q) => SENSITIVE.test(q)
export const SENSITIVE_NOTE = 'General information, not legal, tax or financial advice. Rules vary by place, so check with a professional before acting.'

const usd = (c) => (c == null ? 'not available' : `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`)

// What the records show about inquiries turning into jobs, in plain lines, with what can't be known. No model.
export function funnelEvidence(f) {
  const s = f.stages
  const known = [
    `${s.leads} inquiries${f.scope === 'ads' ? ' from your ads' : ''} in the last ${f.range.days} days; ${s.qualified} in your area${s.outsideArea ? `, ${s.outsideArea} outside it and waiting for your answer or declined` : ''}.`,
    `${s.booked} booked${s.cancelled ? `, ${s.cancelled} cancelled and didn’t rebook` : ''}; ${s.attended} showed up, ${s.noShow} no-shows.`,
    ...diagnose(f).filter((d) => d.level === 'act').map((d) => `${d.title}.`),
  ]
  const unknown = [
    s.leads < 10 && `${s.leads} ${s.leads === 1 ? 'inquiry is' : 'inquiries are'} too few to judge a rate.`,
    s.past > s.outcomeRecorded && `${s.past - s.outcomeRecorded} past visits aren’t marked, so show-ups may be higher.`,
    'Why a person didn’t book isn’t recorded, and calls outside GetShowUps aren’t seen.',
  ].filter(Boolean)
  return { known, unknown }
}

// Useful without any model: shown when the model can't be reached, is at its limit, or its answer failed the checks.
// Understands the plain, misspelled essentials (appointments, inquiries, money, bookings, ZIPs); never pretends more.
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
const mentions = (q, words) => {
  const t = q.toLowerCase().replace(/[^a-z ]/g, '')
  const parts = [...t.split(/\s+/), t.replace(/\s+/g, '')]
  return words.some((w) => parts.some((p) => p === w || (w.length > 6 && near(p, w))))
}
export async function withoutModel(env, customer, req) {
  if (wantsServiceArea(req.question)) {
    const p = await serviceAreaProposal(env, customer, req.question)
    return { kind: 'prepared', answer: p.text, ...(p.proposal ? { proposals: [p.proposal] } : {}) }
  }
  const c = toolContext(env, customer, req.refs)
  const list = async (name, args, text) => {
    const r = await runTool(c, name, args)
    if (r.error) return null
    const n = r.total ?? r.upcoming.total + r.outcome_not_recorded.total
    return { kind: 'records', answer: n ? text : 'Nothing like that is recorded right now.', records: [...c.shown.values()].slice(0, 8), refs: c.refs.book }
  }
  if (mentions(req.question, ['appointment', 'appointments', 'schedule', 'visits', 'calendar'])) return list('list_appointments', /\btomorrow|tmrw\b/i.test(req.question) ? { period: 'tomorrow' } : /\btoday\b/i.test(req.question) ? { period: 'today' } : {}, 'Here’s what’s recorded:')
  if (mentions(req.question, ['unanswered', 'answered', 'waiting'])) return list('list_leads', { which: 'unanswered' }, 'Nothing has been sent to these people yet:')
  if (mentions(req.question, ['leads', 'lead', 'inquiry', 'inquiries'])) return list('list_leads', { which: 'recent' }, 'Your latest inquiries:')
  return null
}

export const wantsMoney = (q) => /\b(revenue|income|earn\w*|made|make|paid|payments?|money|profit\w*|roi|roas|return on)\b/i.test(q) && /\b(ads?|advertis\w*|campaigns?|google|revenue|paid|payments?)\b/i.test(q)
// Recorded payments, the part from leads traced to ads, and why neither is what the ads earned. No model.
async function moneyEvidence(env, customer, days) {
  const opts = { days, internal: internalEmails(env) }
  const [all, ads] = await Promise.all([
    funnel(env.ONBOARDING_DB, customer.id, { ...opts, scope: 'all' }),
    adsAccess(env, customer).then((ok) => (ok ? funnel(env.ONBOARDING_DB, customer.id, { ...opts, scope: 'ads' }) : null)),
  ])
  const paid = (c) => (c == null ? 'none recorded' : usd(c))
  return {
    known: [
      `Payments you recorded for inquiries of the last ${days} days: ${paid(all.revenue.paidCents)}.`,
      ads && `Of those, for jobs from leads traced to your ads: ${paid(ads.revenue.paidCents)}.`,
      ads && `Ad spend Google reported: ${ads.spend.cents == null ? 'none reported' : usd(ads.spend.cents)}.`,
    ].filter(Boolean),
    unknown: [
      'How much of this your ads caused isn’t measured, so this isn’t a return on ad spend.',
      ads && ads.attribution.unattributed > 0 && `${ads.attribution.unattributed} of ${ads.attribution.allLeads} inquiries couldn’t be traced to an ad or came from elsewhere.`,
      all.stages.attended > all.revenue.paidJobs && `${all.stages.attended - all.revenue.paidJobs} of ${all.stages.attended} visits that happened have no payment recorded.`,
    ].filter(Boolean),
  }
}

// Shown with any question about money or inquiries becoming jobs, whether or not the model can be reached.
export async function evidenceFor(env, customer, req) {
  if (wantsMoney(req.question)) return moneyEvidence(env, customer, req.days)
  if (!wantsFunnel(req.question)) return null
  return funnelEvidence(await funnel(env.ONBOARDING_DB, customer.id, { days: req.days, scope: req.results ? 'ads' : 'all', internal: internalEmails(env) }))
}

