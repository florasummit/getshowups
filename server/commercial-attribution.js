// Commercial attribution (migration 0048): one row per business, recorded ONCE when the business is created (first
// touch), never overwritten except by an audited platform-admin correction (correctAttribution). It keeps apart
//   marketing_source  = where the visitor came from (utm_source / ref label, the same value as customers.source)
//   partner_id        = the referral partner whose link or code brought them (server/partners.js), or NULL
//   closing_rep_email = the staff member who closed an assisted sale (stream B), or NULL
//   channel           = 'self_serve' | 'founder' | 'sales_rep' | 'partner'
// Recording is records only: commissions accrue only from collected revenue and only while REFERRALS_ENABLED is exactly
// 'true' (server/commissions.js). Partners have no login and no access to anything.
// Manipulation guards: codes are validated (format, existing, active partner); a presented code that fails is recorded as
// a refusal code, never as the partner; self-referral (the partner's address is the owner's, a member's or the closing
// rep's, or shares a non-public email domain with them) is refused; only an active partner with terms in effect counts; the first VALID touch among the browser's first-touch
// candidates wins; the row is written once (INSERT … ON CONFLICT DO NOTHING).
import { recordEvent } from './auditlog.js'
import { cleanSource } from './customers.js'
import { termsAt } from './partner-terms.js'

export const CHANNELS = ['self_serve', 'founder', 'sales_rep', 'partner']
export const CODE_RE = /^[a-z0-9]{6,32}$/
const DAY = 86_400_000
const MAX_CANDIDATES = 3
const missing = (err) => String(err?.message || '').includes('no such table')

// Mailbox providers anyone can sign up at: sharing one of these domains says nothing about who someone is.
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
])
export const normEmail = (e) => String(e ?? '').trim().toLowerCase()
const domainOf = (e) => normEmail(e).split('@')[1] || ''
export const normCode = (c) => {
  const s = String(c ?? '').trim().toLowerCase()
  return CODE_RE.test(s) ? s : null
}

// true when the partner's own address is (or plausibly belongs to the same organization as) one of the given people.
export function selfReferral(partnerEmail, people) {
  const p = normEmail(partnerEmail)
  if (!p.includes('@')) return false
  const d = domainOf(p)
  return people.map(normEmail).filter((e) => e.includes('@')).some((e) => e === p || (!PUBLIC_EMAIL_DOMAINS.has(d) && domainOf(e) === d))
}

// The partner a code belongs to (any status), or null. Never throws.
async function partnerRow(db, code) {
  const c = normCode(code)
  if (!c) return null
  try {
    return (await db.prepare('SELECT id, name, contact_email, status FROM referral_partners WHERE code = ?1').bind(c).first()) || null
  } catch (err) {
    if (!missing(err)) console.error('partner lookup failed:', 'storage_error')
    return null
  }
}

// Contract (BRIEF): { id, name, status } for a valid code, else null. No contact details.
export async function partnerFromCode(db, code) {
  const p = await partnerRow(db, code)
  return p ? { id: p.id, name: p.name, status: p.status } : null
}

export const parseTerms = (t) => {
  try {
    return t ? JSON.parse(t) : null
  } catch {
    return null
  }
}
// The partner terms' attribution window: the referral touch must be no more than windowDays before the business was created.
export const inWindow = (terms, touchedAt, createdAt) => !terms?.windowDays || touchedAt == null || createdAt - touchedAt <= terms.windowDays * DAY

// Browser first-touch candidates: [{ code, at }] (oldest first), a bare code, or an array of codes. At most 3 are looked at.
function candidatesOf(partnerCode, now) {
  const list = Array.isArray(partnerCode) ? partnerCode : partnerCode == null || partnerCode === '' ? [] : [partnerCode]
  return list.slice(0, MAX_CANDIDATES).map((c) => {
    const code = typeof c === 'object' && c ? c.code : c
    const at = Number(typeof c === 'object' && c ? c.at : NaN)
    // A touch time from the browser is never in the future and never older than 10 years.
    return { code, at: Number.isFinite(at) ? Math.min(now, Math.max(now - 3650 * DAY, Math.floor(at))) : now }
  })
}

// Picks the partner: the first candidate that is a real, active partner passing every check. → { partner, touchedAt, refusal }
async function choosePartner(db, customerId, candidates, { ownerEmail, repEmail }, now) {
  if (!candidates.length) return { partner: null, touchedAt: null, refusal: null }
  let members = []
  try {
    members = (await db.prepare('SELECT email FROM customer_users WHERE customer = ?1').bind(customerId).all()).results.map((r) => r.email)
  } catch {
    members = []
  }
  const people = [ownerEmail, repEmail, ...members].filter(Boolean)
  let firstRefusal = null
  for (const c of candidates) {
    const p = await partnerRow(db, c.code)
    // Only an ACTIVE partner (terms set and the agreement accepted at activation) gains referrals; the window is the one of
    // the terms version in effect now, the version the business will earn under (server/partner-terms.js).
    const version = p && p.status === 'active' ? await termsAt(db, p.id, now) : null
    const refusal = !p ? 'unknown_code' : p.status !== 'active' ? 'not_active' : !version ? 'no_terms' : selfReferral(p.contact_email, people) ? 'self_referral' : !inWindow(version.terms, c.at, now) ? 'outside_window' : null
    if (!refusal) return { partner: p, touchedAt: c.at, refusal: null }
    firstRefusal ??= refusal
  }
  return { partner: null, touchedAt: null, refusal: firstRefusal }
}

// Records the business's attribution once (idempotent: a second call changes nothing). Never throws; before migration
// 0048 it is a no-op. → { ok, recorded, channel, partnerId, refusal } | { ok: false, error }
export async function recordAttribution(db, customerId, { channel = 'self_serve', partnerCode = null, repEmail = null, source = null, ownerEmail = null } = {}, now = Date.now()) {
  try {
    if (!CHANNELS.includes(channel)) channel = 'self_serve'
    const rep = normEmail(repEmail).includes('@') ? normEmail(repEmail).slice(0, 254) : null
    const { partner, touchedAt, refusal } = await choosePartner(db, customerId, candidatesOf(partnerCode, now), { ownerEmail, repEmail: rep }, now)
    // A self-serve signup through a partner's link is the partner channel; an assisted sale keeps its own channel and
    // still records the referring partner separately.
    const ch = partner && channel === 'self_serve' ? 'partner' : channel
    const r = await db
      .prepare(
        `INSERT INTO commercial_attribution (customer, channel, marketing_source, partner_id, closing_rep_email, partner_touched_at, partner_refusal, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(customer) DO NOTHING`,
      )
      .bind(customerId, ch, cleanSource(source), partner?.id ?? null, rep, touchedAt, refusal, now)
      .run()
    const recorded = (r?.meta?.changes ?? 0) > 0
    if (recorded) await recordEvent(db, { type: 'commercial.attributed', customer: customerId, capability: 'commercial.attribution', resource: { type: 'customer', id: customerId }, details: { channel: ch, partner: partner?.id ?? null, refusal, rep: Boolean(rep) }, at: now })
    return { ok: true, recorded, channel: ch, partnerId: partner?.id ?? null, refusal }
  } catch (err) {
    if (missing(err)) return { ok: true, recorded: false, unavailable: true }
    console.error('attribution not recorded:', 'storage_error')
    return { ok: false, error: 'storage_error' }
  }
}

export async function attributionFor(db, customerId) {
  try {
    return (await db.prepare('SELECT * FROM commercial_attribution WHERE customer = ?1').bind(customerId).first()) || null
  } catch (err) {
    if (missing(err)) return null
    throw err
  }
}

// Audited platform-admin correction (the only way an attribution changes). fields: { channel?, partnerId? (null clears),
// repEmail? (null clears) }. A corrected partner must exist and pass the self-referral check against the business's
// members. → { ok, from, to } | { ok: false, error, httpStatus }
export async function correctAttribution(env, customerId, fields, adminEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await db.prepare('SELECT 1 FROM customers WHERE id = ?1').bind(customerId).first())) return { ok: false, error: 'not_found', httpStatus: 404 }
  let prior
  try {
    prior = await attributionFor(db, customerId)
  } catch {
    return { ok: false, error: 'storage_error', httpStatus: 503 }
  }
  try {
    await db.prepare('SELECT 1 FROM commercial_attribution LIMIT 1').first()
  } catch {
    return { ok: false, error: 'not_ready', httpStatus: 409 }
  }
  const to = { channel: prior?.channel ?? 'self_serve', partnerId: prior?.partner_id ?? null, repEmail: prior?.closing_rep_email ?? null }
  if (fields.channel !== undefined) {
    if (!CHANNELS.includes(fields.channel)) return { ok: false, error: 'invalid_channel', httpStatus: 400 }
    to.channel = fields.channel
  }
  if (fields.repEmail !== undefined) {
    const e = normEmail(fields.repEmail)
    if (fields.repEmail !== null && !/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/.test(e)) return { ok: false, error: 'invalid_email', httpStatus: 400 }
    to.repEmail = fields.repEmail === null ? null : e
  }
  if (fields.partnerId !== undefined) {
    if (fields.partnerId === null) to.partnerId = null
    else {
      const p = await db.prepare('SELECT id, contact_email FROM referral_partners WHERE id = ?1').bind(String(fields.partnerId)).first()
      if (!p) return { ok: false, error: 'unknown_partner', httpStatus: 400 }
      const members = (await db.prepare('SELECT email FROM customer_users WHERE customer = ?1').bind(customerId).all()).results.map((r) => r.email)
      if (selfReferral(p.contact_email, [...members, to.repEmail].filter(Boolean))) return { ok: false, error: 'self_referral', httpStatus: 409 }
      to.partnerId = p.id
    }
  }
  const from = { channel: prior?.channel ?? null, partnerId: prior?.partner_id ?? null, repEmail: prior?.closing_rep_email ?? null }
  await db
    .prepare(
      `INSERT INTO commercial_attribution (customer, channel, marketing_source, partner_id, closing_rep_email, partner_refusal, corrected_at, corrected_by, created_at)
       VALUES (?1, ?2, 'direct', ?3, ?4, NULL, ?5, ?6, ?5)
       ON CONFLICT(customer) DO UPDATE SET channel = ?2, partner_id = ?3, closing_rep_email = ?4, partner_refusal = NULL, corrected_at = ?5, corrected_by = ?6`,
    )
    .bind(customerId, to.channel, to.partnerId, to.repEmail, now, adminEmail)
    .run()
  return { ok: true, from, to }
}
