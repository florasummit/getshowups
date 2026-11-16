// Contact / quote-request forms on business websites (contact sections with `form`, server/site-spec.js).
// Business sites run no script, so the form is plain HTML posted to GetShowUps (/api/site-form/<id>), which:
//   - refuses bots: a trap field people never see (`website`), and a signed render time `t` (HMAC, no storage): sent
//     faster than MIN_AGE after the page was rendered, or older than MAX_AGE → refused (the visitor just sends again);
//   - rate-limits per visitor IP and per business (server/ratelimit.js siteForm, siteFormPerBusiness);
//   - validates like the booking page (server/booking.js validateLead) and stores the lead with the business's other
//     leads (createLead: same table, owner notices and follow-ups as booking-page leads; no second lead store);
//   - sends the visitor back to the page: ?sent=1 (thank you) or ?form=<reason> (the form shows what to fix).
// A lead is stored before anything downstream (messages, notices) runs, so a messaging failure never loses it.
import { linkToken, verifyLinkToken } from './links.js'
import { createLead, validateLead } from './booking.js'

export const MIN_AGE_MS = 3_000
export const MAX_AGE_MS = 24 * 60 * 60 * 1000
const PURPOSE = 'site-form'

export async function formToken(env, customerId, now = Date.now()) {
  return `${now}.${await linkToken(env, PURPOSE, `${customerId}:${now}`)}`
}

export async function checkFormToken(env, customerId, token, now = Date.now()) {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''))
  if (!m) return false
  const at = Number(m[1])
  if (now - at < MIN_AGE_MS || now - at > MAX_AGE_MS) return false
  return verifyLinkToken(env, PURPOSE, `${customerId}:${at}`, m[2])
}

// fields: the posted form (strings). Returns { state } for the page: 'sent' or an error code the form explains.
export async function submitSiteForm(env, customer, fields, now = Date.now()) {
  // A bot that filled the trap field is told "sent" and nothing is stored (no signal to adapt to).
  if (String(fields.website || '').trim()) return { state: 'sent', stored: false }
  if (!(await checkFormToken(env, customer.id, fields.t, now))) return { state: 'expired' }
  const quote = fields.kind === 'quote'
  const need = String(fields.need || '').trim()
  // Always validated as a message (no service address on a website form, even for businesses that visit customers).
  const [error, lead] = validateLead({ name: fields.name, email: fields.email, phone: fields.phone, need: need && quote ? `Quote request: ${need}` : need, zip: fields.zip }, 'at_business')
  if (error) return { state: error }
  if (customer.serviceZips.length && !lead.zip) return { state: 'invalid_zip' }
  try {
    const { id } = await createLead(env, customer, lead, now)
    return { state: 'sent', stored: true, leadId: id }
  } catch (err) {
    console.error('site form lead save failed:', err?.name)
    return { state: 'unavailable' }
  }
}
