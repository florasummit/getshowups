// Referral partners (migration 0048), managed by platform admins only (POST /api/platform/partners, audited). Partners
// have no login and see nothing: this is GetShowUps' own record of who refers customers, on what terms, under which
// agreement, and what was paid to them outside GetShowUps.
//   Lifecycle: invited → onboarding → active ⇄ paused → ended (final). Activation (and resuming) needs a terms version and
//   the partner's recorded acceptance of the CURRENT agreement version; only an active partner gains referrals or earns.
//   Checklist: contact details, terms, agreement accepted, payout details (a free-text reference only).
//   Terms: versioned, append-only (server/partner-terms.js); NO default terms anywhere; no terms = nothing accrues.
//   Agreements: versions (title, label, text and/or https link); acceptance recorded by an admin (method recorded_by_admin).
//   Payouts: server/partner-payouts.js (recorded only; GetShowUps never initiates a payment).
// Card and bank numbers never enter the database: free text with 13–19-digit runs (server/enrollment.js looksLikeCard),
// any 8+ digit run, or an IBAN is refused before storage. Codes are random (31^10 ≈ 8·10^14), lower case.
import { CODE_RE, normEmail } from './commercial-attribution.js'
import { looksLikeCard } from './enrollment.js'
import { termsVersions, versionAt } from './partner-terms.js'
import { payoutOverview } from './partner-payouts.js'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no 0/o, 1/l/i: easy to read out on a call
const missing = (err) => String(err?.message || '').includes('no such table')
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/
const DAY = 86_400_000
export const STATUSES = ['invited', 'onboarding', 'active', 'paused', 'ended']
const MOVES = { invited: ['onboarding', 'active', 'ended'], onboarding: ['active', 'ended'], active: ['paused', 'ended'], paused: ['active', 'ended'], ended: [] }
const fail = (error, httpStatus = 400) => ({ ok: false, error, httpStatus })

export function newCode(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
const newId = () => `prt_${newCode(12)}`

// Bank or card numbers in free text: refused, never stored.
export const sensitiveNumber = (text) => {
  const s = String(text ?? '')
  return looksLikeCard(s) || /\d{8,}/.test(s) || /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i.test(s)
}
export const cleanText = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max)

// A date from the admin: 'YYYY-MM-DD' (UTC midnight) or epoch ms. → ms | null
export function parseDay(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''))
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(t).getUTCDate() === Number(m[3]) ? t : null
}

// → [error, terms]. Every field is required; nothing is filled in.
export function validateTerms(t) {
  if (!t || typeof t !== 'object') return ['invalid_terms']
  const type = t.type
  if (type !== 'percent' && type !== 'fixed') return ['invalid_terms_type']
  const value = Number(t.value)
  if (type === 'percent' && !(Number.isFinite(value) && value > 0 && value <= 100 && Math.abs(Math.round(value * 100) - value * 100) < 1e-9)) return ['invalid_terms_value']
  if (type === 'fixed' && !(Number.isInteger(value) && value > 0 && value <= 10_000_000)) return ['invalid_terms_value']
  const currency = type === 'fixed' ? String(t.currency || '').toLowerCase() : null
  if (type === 'fixed' && !/^[a-z]{3}$/.test(currency)) return ['invalid_terms_currency']
  const recurring = String(t.recurring || '')
  const months = /^months:(\d{1,3})$/.exec(recurring)
  if (!(recurring === 'once' || recurring === 'lifetime' || (months && Number(months[1]) >= 1 && Number(months[1]) <= 120))) return ['invalid_terms_recurring']
  const windowDays = Number(t.windowDays)
  if (!(Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 3650)) return ['invalid_terms_window']
  return [null, { type, value, ...(currency ? { currency } : {}), recurring, windowDays }]
}

async function ready(db) {
  try {
    await db.prepare('SELECT 1 FROM referral_partners LIMIT 1').first()
    await db.prepare('SELECT 1 FROM partner_payouts LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

const agreementView = (a) => ({ id: a.id, title: a.title, versionLabel: a.version_label, body: a.body || null, url: a.url || null, createdBy: a.created_by, createdAt: a.created_at })
export async function agreements(db) {
  return (await db.prepare('SELECT * FROM partner_agreements ORDER BY id DESC').all()).results.map(agreementView)
}

// What activation needs, and the checklist the admin sees. current = the newest agreement version (or null).
export function checklistFor(p, { versions, acceptances, current, now = Date.now() }) {
  const accepted = Boolean(current && acceptances.some((a) => a.agreementId === current.id))
  const items = {
    contactDetails: Boolean(p.name && p.contact_email),
    terms: versions.length > 0,
    agreement: accepted,
    payoutDetails: Boolean(p.payout_reference),
  }
  const blockers = []
  if (!versions.length) blockers.push('terms_required')
  if (!current) blockers.push('no_agreement')
  else if (!accepted) blockers.push('agreement_not_accepted')
  return { items, blockers, termsInEffect: Boolean(versionAt(versions, now)) }
}

async function acceptancesOf(db, partnerId) {
  return (
    await db.prepare('SELECT a.agreement_id, a.accepted_at, a.evidence, a.recorded_by, g.version_label, g.title FROM partner_acceptances a JOIN partner_agreements g ON g.id = a.agreement_id WHERE a.partner_id = ?1 ORDER BY a.accepted_at').bind(partnerId).all()
  ).results.map((r) => ({ agreementId: r.agreement_id, versionLabel: r.version_label, title: r.title, acceptedAt: r.accepted_at, evidence: r.evidence || null, recordedBy: r.recorded_by }))
}

const money = (rows, mode) => {
  const out = {}
  for (const r of rows.filter((x) => x.livemode === mode)) {
    const m = (out[r.currency] ||= { accruedCents: 0, reversedCents: 0, owedCents: 0 })
    m.accruedCents += Number(r.accrued)
    m.reversedCents += -Number(r.reversed)
    m.owedCents += Number(r.accrued) + Number(r.reversed)
  }
  return out
}

// Partner admin view: agreements (current first, with the partners who haven't accepted it) and, per partner, its
// lifecycle, checklist, terms history, acceptances, referred businesses, ledger totals (live and test apart) and payouts.
// Business ids and names only; no owner contact details, no payment details.
export async function partnersOverview(env, { origin = null, live = false, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  let partners
  try {
    partners = (await db.prepare('SELECT * FROM referral_partners ORDER BY created_at DESC LIMIT 200').all()).results
    await db.prepare('SELECT 1 FROM partner_payouts LIMIT 1').first()
  } catch (err) {
    if (missing(err)) return { ready: false, partners: [], agreements: [], ledger: [] }
    throw err
  }
  const docs = await agreements(db)
  const current = docs[0] || null
  const referred = (
    await db
      .prepare(
        `SELECT a.partner_id, a.customer, c.name, a.channel, a.created_at, a.commission_ended_at,
                EXISTS (SELECT 1 FROM test_businesses tb WHERE tb.customer = a.customer AND tb.is_test = 1) AS is_test
           FROM commercial_attribution a JOIN customers c ON c.id = a.customer WHERE a.partner_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 1000`,
      )
      .all()
  ).results
  const sums = (
    await db
      .prepare(
        `SELECT partner_id, livemode, currency, coalesce(sum(CASE WHEN kind = 'accrual' THEN amount_cents ELSE 0 END), 0) AS accrued,
                coalesce(sum(CASE WHEN kind = 'reversal' THEN amount_cents ELSE 0 END), 0) AS reversed
           FROM commission_ledger GROUP BY partner_id, livemode, currency`,
      )
      .all()
  ).results
  const entries = (await db.prepare('SELECT id, partner_id, customer, kind, amount_cents, currency, basis_cents, livemode, rule, terms_version_id, created_at FROM commission_ledger ORDER BY id DESC LIMIT 100').all()).results
  const out = []
  for (const p of partners) {
    const versions = await termsVersions(db, p.id)
    const acceptances = await acceptancesOf(db, p.id)
    const mine = sums.filter((s) => s.partner_id === p.id)
    const inEffect = versionAt(versions, now)
    out.push({
      id: p.id,
      name: p.name,
      contactEmail: p.contact_email || null,
      payoutReference: p.payout_reference || null,
      code: p.code,
      link: origin ? `${origin}/r/${p.code}` : `/r/${p.code}`,
      status: p.status,
      moves: MOVES[p.status] || [],
      checklist: checklistFor(p, { versions, acceptances, current, now }),
      terms: inEffect?.terms ?? null,
      termsVersion: inEffect?.version ?? null,
      termsHistory: versions.map((v) => ({ id: v.id, version: v.version, terms: v.terms, effectiveFrom: v.effectiveFrom, createdAt: v.createdAt, inEffect: v.id === inEffect?.id, scheduled: v.effectiveFrom > now })),
      acceptances,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      referred: referred.filter((r) => r.partner_id === p.id).map((r) => ({ customer: r.customer, name: r.name, channel: r.channel, testBusiness: Boolean(r.is_test), attributedAt: r.created_at, commissionEndedAt: r.commission_ended_at ?? null })),
      // Live liability counts only while live billing is on; test-mode accruals are shown apart and never owed.
      liability: live ? money(mine, 1) : {},
      testMode: money(mine, 0),
      payouts: await payoutOverview(db, p.id),
    })
  }
  return {
    ready: true,
    live,
    agreements: docs.map((d, i) => ({ ...d, current: i === 0 })),
    notAccepted: current ? out.filter((p) => p.status !== 'ended' && !p.acceptances.some((a) => a.agreementId === current.id)).map((p) => ({ id: p.id, name: p.name, status: p.status })) : [],
    partners: out,
    ledger: entries.map((e) => ({ id: e.id, partnerId: e.partner_id, customer: e.customer, kind: e.kind, amountCents: e.amount_cents, currency: e.currency, basisCents: e.basis_cents, livemode: e.livemode === 1, termsVersionId: e.terms_version_id ?? null, rule: JSON.parse(e.rule || 'null'), at: e.created_at })),
  }
}

const partnerView = (p) => ({ id: p.id, name: p.name, code: p.code, link: `/r/${p.code}`, status: p.status })

// Adds terms version N+1. effectiveFrom: default now; never before the previous version's date or the latest accrual.
async function addTermsVersion(db, partnerId, rawTerms, effectiveFrom, adminEmail, now) {
  const [err, t] = validateTerms(rawTerms)
  if (err) return [fail(err)]
  const at = effectiveFrom == null || effectiveFrom === '' ? now : parseDay(effectiveFrom)
  if (at == null) return [fail('invalid_effective_date')]
  const prior = await db.prepare('SELECT max(version) AS v, max(effective_from) AS at FROM partner_terms WHERE partner_id = ?1').bind(partnerId).first()
  const lastAccrual = await db.prepare("SELECT max(created_at) AS at FROM commission_ledger WHERE partner_id = ?1 AND kind = 'accrual'").bind(partnerId).first()
  if (prior?.at != null && at < prior.at) return [fail('effective_before_previous', 409)]
  if (lastAccrual?.at != null && at < lastAccrual.at) return [fail('effective_before_accrual', 409)]
  const version = Number(prior?.v || 0) + 1
  try {
    await db.prepare('INSERT INTO partner_terms (partner_id, version, terms, effective_from, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(partnerId, version, JSON.stringify(t), at, adminEmail, now).run()
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return [fail('conflict', 409)] // another admin added a version at the same moment
    throw e
  }
  return [null, { version, terms: t, effectiveFrom: at }]
}

// One admin write. → { ok, partner?, audit: { action, details } } | { ok: false, error, httpStatus }. Every free-text
// field is checked for bank/card numbers. Audit details carry ids, statuses, terms and labels, never a contact address.
export async function savePartner(env, body, adminEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await ready(db))) return fail('not_ready', 409)
  const action = body?.action
  const texts = ['name', 'payoutReference', 'evidence', 'title', 'versionLabel', 'body'].map((k) => body?.[k])
  if (texts.some(sensitiveNumber)) return fail('sensitive_number')

  if (action === 'agreement') {
    const title = cleanText(body.title, 120)
    const label = cleanText(body.versionLabel, 40)
    const text = cleanText(body.body, 20000) || null
    const url = cleanText(body.url, 500) || null
    if (!title) return fail('invalid_title')
    if (!label) return fail('invalid_version_label')
    if (!text && !url) return fail('agreement_empty')
    if (url && !/^https:\/\/[^\s<>"']+$/i.test(url)) return fail('invalid_url')
    try {
      await db.prepare('INSERT INTO partner_agreements (title, version_label, body, url, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(title, label, text, url, adminEmail, now).run()
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return fail('version_label_taken', 409)
      throw e
    }
    const row = await db.prepare('SELECT id FROM partner_agreements WHERE version_label = ?1').bind(label).first()
    return { ok: true, agreement: { id: row.id, title, versionLabel: label }, audit: { action: 'partner.agreement_added', details: { agreement: row.id, title, versionLabel: label, url } } }
  }

  if (action === 'create') {
    const name = cleanText(body.name, 200).replace(/\s+/g, ' ')
    if (!name || name.length > 80) return fail('invalid_name')
    const email = body.contactEmail ? normEmail(body.contactEmail) : null
    if (email && (!EMAIL_RE.test(email) || email.length > 254)) return fail('invalid_email')
    const payout = cleanText(body.payoutReference, 200) || null
    if (body.terms != null && validateTerms(body.terms)[0]) return fail(validateTerms(body.terms)[0])
    if (body.terms != null && body.effectiveFrom != null && body.effectiveFrom !== '' && parseDay(body.effectiveFrom) == null) return fail('invalid_effective_date')
    for (let i = 0; i < 5; i++) {
      const p = { id: newId(), name, contact_email: email, code: newCode(), status: 'invited', payout_reference: payout }
      try {
        await db
          .prepare('INSERT INTO referral_partners (id, name, contact_email, code, status, payout_reference, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)')
          .bind(p.id, p.name, p.contact_email, p.code, p.status, p.payout_reference, adminEmail, now)
          .run()
      } catch (err) {
        if (/UNIQUE|PRIMARY/i.test(String(err?.message))) continue // a code collision: draw again
        throw err
      }
      let terms = null
      if (body.terms != null) {
        const [e, v] = await addTermsVersion(db, p.id, body.terms, body.effectiveFrom, adminEmail, now)
        if (e) return e
        terms = v
      }
      return { ok: true, partner: partnerView(p), audit: { action: 'partner.created', details: { partner: p.id, status: 'invited', terms: terms ? { version: terms.version, ...terms.terms } : null } } }
    }
    return fail('storage_error', 503)
  }

  const id = String(body?.id ?? '')
  const prior = id ? await db.prepare('SELECT * FROM referral_partners WHERE id = ?1').bind(id).first() : null
  if (!['details', 'status', 'pause', 'resume', 'terms', 'accept'].includes(action)) return fail('invalid_request')
  if (!prior) return fail('not_found', 404)

  if (action === 'details') {
    const next = { name: prior.name, contact_email: prior.contact_email, payout_reference: prior.payout_reference }
    const changed = []
    if (body.name !== undefined) {
      const name = cleanText(body.name, 200).replace(/\s+/g, ' ')
      if (!name || name.length > 80) return fail('invalid_name')
      next.name = name
    }
    if (body.contactEmail !== undefined) {
      const email = body.contactEmail ? normEmail(body.contactEmail) : null
      if (email && (!EMAIL_RE.test(email) || email.length > 254)) return fail('invalid_email')
      next.contact_email = email
    }
    if (body.payoutReference !== undefined) next.payout_reference = cleanText(body.payoutReference, 200) || null
    for (const k of Object.keys(next)) if (next[k] !== prior[k]) changed.push(k === 'contact_email' ? 'contactEmail' : k === 'payout_reference' ? 'payoutReference' : k)
    if (!changed.length) return { ok: true, partner: partnerView(prior), audit: null }
    await db.prepare('UPDATE referral_partners SET name = ?2, contact_email = ?3, payout_reference = ?4, updated_at = ?5 WHERE id = ?1').bind(id, next.name, next.contact_email, next.payout_reference, now).run()
    // The audit names which fields changed, never the contact address or payout text itself.
    return { ok: true, partner: partnerView({ ...prior, ...next }), audit: { action: 'partner.details_changed', details: { partner: id, changed } } }
  }

  if (action === 'terms') {
    if (prior.status === 'ended') return fail('partner_ended', 409)
    const [e, v] = await addTermsVersion(db, id, body.terms, body.effectiveFrom, adminEmail, now)
    if (e) return e
    await db.prepare('UPDATE referral_partners SET updated_at = ?2 WHERE id = ?1').bind(id, now).run()
    return { ok: true, partner: partnerView(prior), version: v.version, audit: { action: 'partner.terms_versioned', details: { partner: id, version: v.version, effectiveFrom: v.effectiveFrom, terms: v.terms } } }
  }

  if (action === 'accept') {
    const agreementId = Number(body.agreementId)
    const doc = Number.isInteger(agreementId) ? await db.prepare('SELECT id, version_label FROM partner_agreements WHERE id = ?1').bind(agreementId).first() : null
    if (!doc) return fail('unknown_agreement')
    const at = body.acceptedAt == null || body.acceptedAt === '' ? now : parseDay(body.acceptedAt)
    if (at == null || at > now + DAY) return fail('invalid_accepted_date')
    const evidence = cleanText(body.evidence, 500) || null
    try {
      await db
        .prepare("INSERT INTO partner_acceptances (partner_id, agreement_id, accepted_at, method, evidence, recorded_by, created_at) VALUES (?1, ?2, ?3, 'recorded_by_admin', ?4, ?5, ?6)")
        .bind(id, doc.id, at, evidence, adminEmail, now)
        .run()
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) return fail('already_accepted', 409)
      throw e
    }
    return { ok: true, partner: partnerView(prior), audit: { action: 'partner.agreement_accepted', details: { partner: id, agreement: doc.id, versionLabel: doc.version_label, acceptedAt: at, method: 'recorded_by_admin', evidence: Boolean(evidence) } } }
  }

  // Status: { to } (or the older pause/resume).
  const to = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : String(body.to || '')
  if (!STATUSES.includes(to)) return fail('invalid_status')
  if (!(MOVES[prior.status] || []).includes(to)) return fail(prior.status === to ? 'unchanged' : 'invalid_transition', 409)
  if (to === 'ended' && body.confirm !== true) return fail('confirmation_required')
  if (to === 'active') {
    const versions = await termsVersions(db, id)
    const current = (await agreements(db))[0] || null
    const { blockers } = checklistFor(prior, { versions, acceptances: await acceptancesOf(db, id), current, now })
    if (blockers.length) return fail(blockers[0], 409)
  }
  const r = await db.prepare('UPDATE referral_partners SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = ?4').bind(id, to, now, prior.status).run()
  if ((r?.meta?.changes ?? 0) === 0) return fail('conflict', 409)
  return { ok: true, partner: partnerView({ ...prior, status: to }), audit: { action: 'partner.status_changed', details: { partner: id, from: prior.status, to } } }
}

export const validCode = (c) => CODE_RE.test(String(c || ''))
