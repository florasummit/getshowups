// US business texting registration (A2P 10DLC), prepared with the owner and tracked honestly.
//
//   1. The owner enters the business facts carriers check (legal name, type, EIN unless sole proprietor, address,
//      website, contact) — validated here, never invented or pre-filled from guesses.
//   2. The owner reviews the use case and sample messages GetShowUps will send (fixed, from our templates) and
//      explicitly approves submission (attestation text + who/when, stored as a ref). Without that, nothing is submitted.
//   3. A platform admin submits it with the provider (manual today: no automated TrustHub/brand API calls) and records
//      what the PROVIDER reports: pending → approved | rejected (with the provider's reason) | suspended. Only that
//      recorded provider status can make a business "approved"; the owner can't, and nothing infers it.
//   4. The admin also records the business's own sender (Messaging Service and/or number) once provisioned.
// Live texts additionally need SMS_LIVE=true (settings.js). Changes are audited (no personal data in the audit log).
import { normalizeWebsiteUrl } from '../url.js'
import { toE164 } from '../sms.js'
import { sha256Hex } from '../google-oauth.js'
import { recordEvent } from '../auditlog.js'

export const BUSINESS_TYPES = ['sole_proprietor', 'llc', 'corporation', 'partnership', 'nonprofit']
export const PROVIDER_STATUSES = ['pending', 'approved', 'rejected', 'suspended']
export const ATTESTATION =
  'I confirm these business details are accurate, that I am authorized to register this business for text messaging, that GetShowUps may submit this registration to its messaging provider and carriers on my behalf, and that we will only text people who asked us to, as described.'
const ORIGIN = 'https://getshowups.com'
// Campaign description (what carriers read first): who texts whom, why, and that nothing is marketing.
export const USE_CASE = (name) =>
  `${name} is a local service business. It uses GetShowUps to text customers who asked to be contacted: replies to their own enquiry from ${name}'s website form or booking page, appointment confirmations and reminders, and up to two reminders to pick a time if they haven't booked. Customers can also text ${name} with questions. No marketing, no purchased or shared lists.`
// How people opt in (Twilio "message flow"): every opt-in path, with public URLs reviewers can open.
export const MESSAGE_FLOW = (name, id) =>
  `Customers opt in on ${name}'s public booking page (${ORIGIN}/book/${id}) or website contact form by checking an optional, unchecked box. Booking page: "Text me about this appointment (confirmation and reminders) from ${name} via GetShowUps. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book." Website form: "Text me about my request from ${name} via GetShowUps. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required." Both link to the texting terms (${ORIGIN}/sms-terms/${id}, which shows the boxes) and the privacy policy (${ORIGIN}/privacy). Texting is never required to book or to get a reply. A customer who texts ${name}'s number first also opts in to replies. Consent is never asked for by text. Reply STOP to opt out, HELP for help.`
// Samples = the real templates (server/messages.js, server/followups/assistant.js) with [variables].
export const SAMPLES = (name, id) => [
  `${name}: Hi [first name], thanks for your message about "[their request]". We'll be in touch soon, or pick a time: ${ORIGIN}/book/${id}?lead=[id]&k=[key] Reply STOP to opt out.`,
  `${name}: you're booked for [day, date] at [time]. Confirm you'll be there: ${ORIGIN}/api/appointment/confirm?a=[id]&k=[key] Reply STOP to opt out.`,
  `${name}: reminder of your appointment [tomorrow at 10:00 AM]. Reply STOP to opt out.`,
  `${name}: whenever you're ready, pick a time here: ${ORIGIN}/book/${id}?lead=[id]&k=[key] Reply STOP to opt out.`,
]

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// Owner-entered facts → [errors[], value].
export function validateFacts(b) {
  const errors = []
  const v = {
    legalName: clean(b?.legalName, 120),
    businessType: BUSINESS_TYPES.includes(b?.businessType) ? b.businessType : '',
    ein: clean(b?.ein, 20).replace(/[^\d-]/g, ''),
    address: clean(b?.address, 200),
    website: b?.website ? normalizeWebsiteUrl(String(b.website)) : [null, null],
    contactName: clean(b?.contactName, 80),
    contactEmail: clean(b?.contactEmail, 120).toLowerCase(),
    contactPhone: toE164(b?.contactPhone),
  }
  if (v.legalName.length < 2) errors.push('legalName')
  if (!v.businessType) errors.push('businessType')
  if (v.businessType !== 'sole_proprietor' && !/^\d{2}-?\d{7}$/.test(v.ein)) errors.push('ein')
  if (v.address.length < 8) errors.push('address')
  if (v.website[0] || !v.website[1]) errors.push('website')
  if (v.contactName.length < 2) errors.push('contactName')
  if (!EMAIL_RE.test(v.contactEmail)) errors.push('contactEmail')
  if (!v.contactPhone) errors.push('contactPhone')
  return [errors, { ...v, website: v.website[1] ? String(v.website[1]) : '' }]
}

export async function getRegistration(db, customer) {
  return db.prepare('SELECT * FROM sms_registrations WHERE customer = ?1').bind(customer).first()
}

// The owner's view: facts (their own), status, and the next step in plain words. Never the sender credentials.
export function registrationView(r, name, id) {
  const facts = r && r.legal_name ? { legalName: r.legal_name, businessType: r.business_type, ein: r.ein ? `•••${String(r.ein).slice(-4)}` : '', address: r.address, website: r.website, contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone } : null
  const status = r?.status || 'not_configured'
  const next =
    status === 'not_configured' ? 'enter_details'
    : status === 'ready' ? (r.approved_at ? 'waiting_for_submission' : 'approve')
    : status === 'pending' ? 'waiting_for_carriers'
    : status === 'rejected' ? 'fix_and_resubmit'
    : status === 'suspended' ? 'contact_support'
    : r.messaging_service || r.sender_phone ? 'done' : 'waiting_for_number'
  return {
    status,
    next,
    note: r?.status_note || null,
    statusAt: r?.status_at || null,
    approvedAt: r?.approved_at || null,
    facts,
    hasSender: Boolean(r?.messaging_service || r?.sender_phone),
    useCase: USE_CASE(name),
    messageFlow: MESSAGE_FLOW(name, id),
    samples: SAMPLES(name, id),
    termsUrl: `${ORIGIN}/sms-terms/${id}`,
    attestation: ATTESTATION,
  }
}

// Saving facts: a registration already with the provider (pending/approved) keeps its status, and a change after
// approval needs the owner's approval again (the provider must see the same facts the owner attested).
export async function saveFacts(db, customer, v, now = Date.now()) {
  const before = await getRegistration(db, customer)
  if (before && ['pending', 'approved', 'suspended'].includes(before.status)) return { ok: false, httpStatus: 409, error: 'registration_in_progress' }
  await db
    .prepare(
      `INSERT INTO sms_registrations (customer, legal_name, business_type, ein, address, website, contact_name, contact_email, contact_phone, use_case, sample_messages, approved_by, approved_at, status, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, 'ready', ?10)
       ON CONFLICT(customer) DO UPDATE SET legal_name = ?2, business_type = ?3, ein = ?4, address = ?5, website = ?6, contact_name = ?7, contact_email = ?8,
         contact_phone = ?9, approved_by = NULL, approved_at = NULL, status = CASE WHEN status = 'rejected' THEN 'ready' ELSE 'ready' END, updated_at = ?10`,
    )
    .bind(customer, v.legalName, v.businessType, v.ein || null, v.address, v.website, v.contactName, v.contactEmail, v.contactPhone, now)
    .run()
  return { ok: true }
}

// The owner's explicit approval to submit (the attestation text they saw). Stored as a ref, not the email.
export async function approveSubmission(db, customer, name, ownerEmail, now = Date.now()) {
  const r = await getRegistration(db, customer)
  if (!r || r.status !== 'ready') return { ok: false, httpStatus: 409, error: r ? 'registration_in_progress' : 'details_missing' }
  const ref = `ref:${(await sha256Hex(String(ownerEmail).toLowerCase())).slice(0, 16)}`
  await db
    .prepare("UPDATE sms_registrations SET approved_by = ?2, approved_at = ?3, use_case = ?4, sample_messages = ?5, updated_at = ?3 WHERE customer = ?1 AND status = 'ready'")
    .bind(customer, ref, now, USE_CASE(name), JSON.stringify(SAMPLES(name, customer)))
    .run()
  await recordEvent(db, { type: 'sms.registration_approved_by_owner', actorType: 'owner', actor: ownerEmail, customer, capability: 'followups.registration', resource: { type: 'sms_registration', id: customer }, outcome: 'success', details: { attestation: 'v1' }, at: now })
  return { ok: true }
}

// Platform admin: the provider's reported status and/or the business's provisioned sender. Approval is refused unless
// the owner approved submission first (we never register a business that didn't ask).
export async function recordProviderStatus(db, customer, { status, note = '', messagingService, senderPhone }, adminEmail, now = Date.now()) {
  const r = await getRegistration(db, customer)
  if (!r) return { ok: false, httpStatus: 409, error: 'details_missing' }
  if (status !== undefined && !PROVIDER_STATUSES.includes(status)) return { ok: false, httpStatus: 400, error: 'invalid_status' }
  if (status && !r.approved_at) return { ok: false, httpStatus: 409, error: 'owner_approval_missing' }
  if (messagingService !== undefined && messagingService !== null && !/^MG[0-9a-f]{32}$/i.test(messagingService)) return { ok: false, httpStatus: 400, error: 'invalid_messaging_service' }
  const phone = senderPhone === undefined || senderPhone === null ? senderPhone : toE164(senderPhone)
  if (senderPhone && !phone) return { ok: false, httpStatus: 400, error: 'invalid_phone' }
  try {
    await db
      .prepare(
        `UPDATE sms_registrations SET status = coalesce(?2, status), status_note = CASE WHEN ?2 IS NULL THEN status_note ELSE ?3 END, status_at = CASE WHEN ?2 IS NULL THEN status_at ELSE ?6 END,
           messaging_service = CASE WHEN ?7 = 1 THEN ?4 ELSE messaging_service END, sender_phone = CASE WHEN ?8 = 1 THEN ?5 ELSE sender_phone END, updated_at = ?6 WHERE customer = ?1`,
      )
      .bind(customer, status ?? null, clean(note, 200) || null, messagingService ?? null, phone ?? null, now, messagingService !== undefined ? 1 : 0, senderPhone !== undefined ? 1 : 0)
      .run()
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) return { ok: false, httpStatus: 409, error: 'sender_in_use' }
    throw err
  }
  // Audited by the caller (platform route: audit(), the permanent audit log).
  return { ok: true }
}
