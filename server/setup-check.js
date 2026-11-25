// Is this business set up to serve real customers? Deterministic checks over its own records (no model): what is missing
// or disagrees, what that means for a customer, and where to fix it. Nothing here blocks operating.
//   critical  customers can't book, or could book when they shouldn't   important  customers get wrong or no answers
//   optional  worth doing
// Read by Settings (the list), the suggestion card and the owner assistant, so all three say the same thing.
import { bookingRules } from './booking-rules.js'
import { dateIn, holidays, weekday } from './dates.js'
import { getProfile } from './onboarding.js'
import { getPolicies } from './policies.js'
import { liveContent } from './website.js'

const ORDER = { critical: 0, important: 1, optional: 2 }
const plain = (s) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9$+]+/g, ' ').replace(/\b(llc|inc|co|corp|ltd)\b/g, '').replace(/\s+/g, ' ').trim()
const RECURRING = /\b(weekly|biweekly|bi-weekly|monthly|maintenance plan|every (week|month|other week)|recurring|subscription|membership|plan)\b/i
const UNIT = /\b(per|each|every|a)\s+(visit|month|week|year|season|hour|hr|job|service|stop|pool|unit|sq|square)|\/\s?(visit|mo|month|wk|week|yr|year|hr|hour|season)|\b(monthly|weekly|hourly|flat|fixed|one[- ]time)\b/i
export const missingUnit = (s) => /\$?\d/.test(s.price || '') && RECURRING.test(s.name) && !UNIT.test(s.price)

export async function setupCheck(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const UNREAD = Symbol('unread')
  const soft = (p) => Promise.resolve(p).catch(() => UNREAD)
  const [profile, policies, rules, cal, live, rec] = await Promise.all([
    soft(getProfile(db, customer.id)),
    soft(getPolicies(db, customer.id)),
    soft(bookingRules(db, customer.id)),
    soft(env.GOOGLE_TOKENS.get(`google:${customer.id}`).then(Boolean)),
    soft(liveContent(db, customer.id)),
    soft(db.prepare('SELECT enabled, greeting FROM receptionist_settings WHERE customer = ?1').bind(customer.id).first()),
  ])
  const out = []
  const add = (id, level, title, why, fix, where) => out.push({ id, level, title, why, fix, where })
  const visits = customer.appointmentMode === 'at_customer'
  if (cal === false) add('calendar', 'critical', 'Google Calendar isn’t connected', 'Customers can’t see any times.', 'Connect it in Settings.', 'settings#google-calendar')
  if (!customer.hoursConfirmed) add('hours', 'critical', 'Booking hours aren’t set', 'Customers can’t book.', 'Set your days and hours.', 'settings#booking-hours')
  if (rules !== UNREAD && rules.ready) {
    const today = dateIn(now, customer.timezone)
    const closed = new Set(rules.closures.map((c) => c.date))
    const open = holidays(today, 21).filter((h) => !closed.has(h.date) && customer.workdays.includes(weekday(h.date)))
    if (open.length) add('holiday_open', 'critical', `Customers can book ${open.map((h) => `${h.label} (${h.date})`).join(' and ')}`, 'It’s one of your booking days and isn’t marked closed.', 'Add it to Closed dates, or ignore this if you work that day.', 'settings#closed-dates')
    if (rules.minNoticeMinutes === 0) add('no_notice', 'important', 'Customers can book a time that starts in minutes', 'No minimum notice is set.', 'Choose a minimum notice.', 'settings#closed-dates')
  }
  if (visits && !customer.serviceZips.length) add('no_area', 'important', 'Anyone, anywhere, can book a visit', 'You visit customers and no service ZIP codes are listed.', 'List the ZIP codes you serve. Others can still ask, and you decide.', 'settings#business')
  const services = profile === UNREAD ? null : profile?.services || []
  if (services) {
    if (!services.length) add('no_services', 'important', 'No services are listed', 'The receptionist and assistant can’t say what you do or what it costs.', 'Add your services and prices.', 'settings#services')
    const unit = services.filter(missingUnit)
    if (unit.length) add('price_unit', 'important', `${unit.map((s) => `“${s.name}” (${s.price})`).join(', ')}: per visit, week or month?`, 'Customers and the receptionist can’t tell what the price covers.', 'Write it in the price, for example “$300+ per month”.', 'settings#services')
    const site = live && live !== UNREAD ? live.content?.services || [] : []
    if (site.length && services.length) {
      const mine = new Map(services.map((s) => [plain(s.name), plain(s.price)]))
      const diff = site.filter((s) => !mine.has(plain(s.name)) || (s.price && mine.get(plain(s.name)) !== plain(s.price))).map((s) => s.name)
      const extra = services.filter((s) => !site.some((x) => plain(x.name) === plain(s.name))).map((s) => s.name)
      if (diff.length || extra.length) add('services_differ', 'important', 'Your website and your service list disagree', `Different or missing: ${[...new Set([...diff, ...extra])].slice(0, 6).join(', ')}. Customers could see one price and be told another.`, 'Make them match in Settings and Website.', 'settings#services')
    }
    if (!profile?.phone) add('no_phone', 'important', 'No phone number', 'Customers have no way to call you; your website hides its call button.', 'Add your business phone.', 'settings#details')
    if (!profile?.cities?.length && visits) add('no_towns', 'important', 'No towns are listed', 'The website and receptionist can’t say where you work.', 'List the towns you serve.', 'settings#details')
    if (!profile?.description) add('no_description', 'optional', 'No short description', 'The receptionist has less to say about you.', 'Add two sentences.', 'settings#details')
  }
  if (/\b(LLC|Inc\.?|Corp\.?|Ltd\.?)\s*$/i.test(customer.name)) add('legal_name', 'optional', `Customers see “${customer.name}” when they book`, 'A legal suffix reads oddly on a booking page.', 'Use the name on your truck or sign.', 'settings#business')
  if (rec && rec !== UNREAD && rec.enabled === 1 && /\b(calling|your call|on the line)\b/i.test(rec.greeting || '')) add('greeting_call', 'optional', 'Your chat greeting sounds like a phone call', `It says “${String(rec.greeting).slice(0, 80)}”.`, 'Change the greeting on Receptionist.', 'receptionist')
  if (policies !== UNREAD && !policies.beforeVisit) add('no_visit_note', 'optional', 'No visit instructions', 'Customers aren’t told about gates, pets or parking.', 'Add a note in Settings.', 'settings#policies')
  if (policies !== UNREAD && !policies.cancellation) add('no_cancellation', 'optional', 'No cancellation note', 'Customers don’t know how much notice you want.', 'Add one in Settings.', 'settings#policies')
  if (visits && customer.slotMinutes <= 30) add('short_visits', 'optional', `Every visit is ${customer.slotMinutes} minutes`, 'Back-to-back visits leave no time for longer jobs or driving.', 'Choose a longer visit length under Booking hours.', 'settings#booking-hours')
  const unread = [['details', profile], ['policies', policies], ['closed dates', rules], ['calendar', cal], ['website', live], ['receptionist', rec]].filter(([, v]) => v === UNREAD).map(([k]) => k)
  return { items: out.sort((a, b) => ORDER[a.level] - ORDER[b.level]), unread }
}
