// Receptionist routing, provider-neutral: who answers an incoming call (or live conversation) for a business.
//   ai_first    — the AI answers; transfer to staff when a transfer number is set and it is within business hours.
//   human_first — staff answer; the AI takes calls they don't answer (needs the provider's no-answer forwarding).
//   after_hours — staff answer during business hours (AI on no-answer); the AI answers outside them.
// Returns a plan the telephony adapter executes: { answer: 'ai' | 'human', onNoAnswer: 'ai' | null, transfer: E.164 | null,
// ringSeconds }. Website chat and browser voice calls are always answered by the AI (no staff ringing on the web).
const HM = (v) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? Number(String(v).split(':')[0]) * 60 + Number(String(v).split(':')[1]) : Number(v))

export function withinHours(customer, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: customer.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]))
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  const minutes = Number(p.hour) * 60 + Number(p.minute)
  return (customer.workdays || []).includes(day) && minutes >= HM(customer.dayStart) && minutes < HM(customer.dayEnd)
}

export const RING_SECONDS = 20
export function routeCall({ mode = 'ai_first', transferPhone = '' }, customer, now = Date.now(), { channel = 'phone' } = {}) {
  const open = withinHours(customer, now)
  const staff = /^\+1\d{10}$/.test(transferPhone || '') ? transferPhone : null
  if (channel !== 'phone') return { answer: 'ai', onNoAnswer: null, transfer: null, ringSeconds: 0, open }
  if (mode === 'human_first' && staff) return { answer: 'human', onNoAnswer: 'ai', transfer: staff, ringSeconds: RING_SECONDS, open }
  if (mode === 'after_hours' && staff && open) return { answer: 'human', onNoAnswer: 'ai', transfer: staff, ringSeconds: RING_SECONDS, open }
  // ai_first, after hours, or no staff number: the AI answers; it may transfer to staff while they are working.
  return { answer: 'ai', onNoAnswer: null, transfer: staff && open ? staff : null, ringSeconds: 0, open }
}

// Plain words for the owner's settings screen.
export function describeRoute(plan) {
  if (plan.answer === 'human') return `Calls ring your team for ${plan.ringSeconds} seconds; the AI receptionist answers if nobody picks up.`
  if (plan.transfer) return 'The AI receptionist answers and can transfer callers to your team.'
  return 'The AI receptionist answers every call.'
}
