// Enterprise inquiries ("Contact sales" on the pricing section). No new store and no CRM: an inquiry is a lead of the
// GetShowUps sales business (server/public.js SALES_BUSINESS, the same record the sales chat writes to), so it shows
// in that dashboard's leads, counts in the admin sales funnel and reaches the founder through the existing owner
// notice (server/notify.js owner_lead, through the outbox and launch gate). Protection is the website form's:
// a trap field people never see, a signed render time (server/site-form.js formToken: sent faster than 3 s after the
// form opened or older than a day → refused), rate limits per visitor and overall, validation like every lead.
// No automatic message goes to the person (server/messages.js): a person replies.
// The organization facts are kept in the lead's `need` text (one line, length-limited); nothing is logged.
import { SALES_BUSINESS } from './public.js'
import { getCustomer } from './customers.js'
import { customerFromRow } from './auth.js'
import { createLead, validateLead } from './booking.js'
import { formToken, checkFormToken } from './site-form.js'

export const SOURCE = 'enterprise_inquiry'
const TOKEN_KEY = 'enterprise:inquiry' // ':' is never part of a business id, so no website form's token works here

export const ORG_TYPES = {
  agency: 'Agency',
  franchise: 'Franchise',
  program: 'Entrepreneurship program',
  university: 'University',
  multi_location: 'Multi-location business',
  other: 'Other',
}
export const LIMITS = { organization: 120, goal: 300, maxCount: 100000 }

export const inquiryToken = (env, now = Date.now()) => formToken(env, TOKEN_KEY, now)

const text = (v, max) =>
  String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

// → [error] | [null, { organization, type, count, goal, lead }]
export function validateInquiry(fields) {
  const organization = text(fields?.organization, LIMITS.organization)
  if (organization.length < 2) return ['invalid_organization']
  const type = String(fields?.type || '')
  if (!Object.hasOwn(ORG_TYPES, type)) return ['invalid_type']
  const rawCount = String(fields?.count ?? '').trim()
  let count = null
  if (rawCount) {
    if (!/^\d{1,6}$/.test(rawCount)) return ['invalid_count']
    count = Number(rawCount)
    if (count < 1 || count > LIMITS.maxCount) return ['invalid_count']
  }
  const goal = text(fields?.goal, LIMITS.goal)
  if (goal.length < 2) return ['invalid_goal']
  const need = `Enterprise inquiry: ${organization} (${ORG_TYPES[type]}${count ? `, about ${count} ${count === 1 ? 'business' : 'businesses'}` : ''}). Goal: ${goal}`
  // No phone is asked (nothing to visit); name and email are validated exactly like a booking-page lead.
  const [error, lead] = validateLead({ name: fields?.name, email: fields?.email, need }, 'at_business', { requirePhone: false })
  if (error) return [error]
  return [null, { organization, type, count, goal, lead }]
}

// → { state: 'sent', stored, leadId? } | { state: <error code> }
export async function submitInquiry(env, fields, now = Date.now()) {
  // A bot that filled the trap field is told "sent" and nothing is stored (no signal to adapt to).
  if (String(fields?.website || '').trim()) return { state: 'sent', stored: false }
  if (!(await checkFormToken(env, TOKEN_KEY, fields?.t, now))) return { state: 'expired' }
  const [error, inquiry] = validateInquiry(fields)
  if (error) return { state: error }
  let customer
  try {
    customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, SALES_BUSINESS))
  } catch (err) {
    console.error('enterprise inquiry: sales business lookup failed:', err?.name)
    return { state: 'unavailable' }
  }
  if (!customer || customer.status !== 'active') return { state: 'unavailable' }
  try {
    const { id } = await createLead(env, customer, { ...inquiry.lead, source: SOURCE }, now)
    return { state: 'sent', stored: true, leadId: id }
  } catch (err) {
    console.error('enterprise inquiry save failed:', err?.name)
    return { state: 'unavailable' }
  }
}
