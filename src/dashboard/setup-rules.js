// Small rules of the guided setup that are worth testing on their own (test/setup-rules.test.js). Pure: no browser APIs.
import { industryKey } from '../../server/site-design.js'

// The whole self-serve path, in the product's order (server/onboarding.js onboardingSteps). Shown on step 1, before the
// business exists and the server can list the steps itself.
export const SELF_SERVE_STEPS = ['business', 'payment', 'details', 'services', 'calendar', 'hours', 'website', 'address', 'publish', 'launch']

// The trades the "What do you do?" field suggests: all of them work at the customer's home or site.
export const INDUSTRIES = ['Pool service', 'Lawn care', 'House cleaning', 'Pest control', 'HVAC', 'Plumbing', 'Electrical', 'Pressure washing', 'Handyman', 'Window cleaning', 'Roofing', 'Landscaping']

// Does a business of this kind usually go to the customer? The suggested trades above, or anything the website
// designer's industry matching (server/site-design.js industryKey) recognises as pool, cleaning, lawn or a trade.
// Wellness and professional services (customers come in) and anything unrecognised are not: the owner chooses.
const VISITING = ['pool', 'cleaning', 'lawn', 'trades']
export function visitsCustomers(industry) {
  const text = String(industry || '').trim().toLowerCase()
  if (!text) return false
  if (INDUSTRIES.some((i) => i.toLowerCase() === text)) return true
  return VISITING.includes(industryKey({ industry: text }))
}

// Which step is on screen, and where Back, Continue and the progress bar lead.
//   steps: [{ id, done }] in order · editing: the id of an earlier step the owner went back to (or null)
// frontier = the first unfinished step (the last one when everything is done). The owner may open any step up to the
// frontier; Continue on an earlier step goes to the NEXT step, so going Back N times and continuing walks through the
// same N steps instead of jumping ahead.
export function stepPosition(steps, editing) {
  const firstOpen = steps.findIndex((s) => !s.done)
  const frontier = firstOpen === -1 ? steps.length - 1 : firstOpen
  const at = editing ? steps.findIndex((s) => s.id === editing) : -1
  const index = at >= 0 && at < frontier ? at : frontier
  const target = (i) => (i >= 0 && i < frontier ? steps[i].id : null) // null = the frontier itself
  return { index, frontier, current: steps[index].id, back: index > 0 ? target(index - 1) : undefined, next: target(index + 1), target, canOpen: (i) => i !== index && i <= frontier }
}

// Decisions the dashboard's setup check would raise right after setup (server/setup-check.js: holiday_open, no_notice),
// from GET /api/dashboard/availability. The same 21-day window, so the two never disagree.
export const HOLIDAY_WINDOW_DAYS = 21
export const SUGGESTED_NOTICE_MINUTES = 120
export function setupDecisions(availability) {
  if (!availability?.ready) return []
  const limit = new Date(Date.parse(`${availability.today}T00:00:00Z`) + HOLIDAY_WINDOW_DAYS * 86400000).toISOString().slice(0, 10)
  const out = (availability.suggested || []).filter((h) => h.date >= availability.today && h.date <= limit).map((h) => ({ id: `holiday:${h.date}`, kind: 'holiday', date: h.date, label: h.label }))
  if (availability.minNoticeMinutes === 0) out.push({ id: 'notice', kind: 'notice', minutes: SUGGESTED_NOTICE_MINUTES })
  return out
}
// The body to save when the owner accepts one: the current rules plus that single change (nothing else moves).
export function acceptDecision(availability, decision) {
  const base = { minNoticeMinutes: availability.minNoticeMinutes, closures: availability.closures }
  const next = decision.kind === 'holiday' ? { ...base, closures: [...base.closures.filter((c) => c.date !== decision.date), { date: decision.date, label: decision.label }].sort((a, b) => a.date.localeCompare(b.date)) } : { ...base, minNoticeMinutes: decision.minutes }
  return { ...next, base }
}
