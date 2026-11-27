// Referral partners (migration 0048), managed by platform admins only (POST /api/platform/partners, audited). Partners
// have no login and see nothing: this is GetShowUps' own record of who refers customers and on what terms.
// Terms are set explicitly by the admin, field by field. There are NO default terms anywhere in code or docs: a partner
// without terms accrues nothing. Codes are random (31^10 ≈ 8·10^14), lower case, matched case-insensitively.
import { CODE_RE, normEmail, parseTerms } from './commercial-attribution.js'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no 0/o, 1/l/i: easy to read out on a call
const missing = (err) => String(err?.message || '').includes('no such table')
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/

export function newCode(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
const newId = () => `prt_${newCode(12)}`

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

const view = (p, origin) => ({
  id: p.id,
  name: p.name,
  contactEmail: p.contact_email || null,
  code: p.code,
  link: origin ? `${origin}/r/${p.code}` : `/r/${p.code}`,
  status: p.status,
  terms: parseTerms(p.terms),
  createdAt: p.created_at,
  updatedAt: p.updated_at,
})

// Partner admin view: partners, each with referred customers and ledger totals (live and test separately), plus the
// recent ledger entries. Business ids and names only; no owner contact details, no payment details.
export async function partnersOverview(env, { origin = null, live = false } = {}) {
  const db = env.ONBOARDING_DB
  let partners
  try {
    partners = (await db.prepare('SELECT * FROM referral_partners ORDER BY created_at DESC LIMIT 200').all()).results
  } catch (err) {
    if (missing(err)) return { ready: false, partners: [] }
    throw err
  }
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
        `SELECT partner_id, customer, livemode, currency, coalesce(sum(CASE WHEN kind = 'accrual' THEN amount_cents ELSE 0 END), 0) AS accrued,
                coalesce(sum(CASE WHEN kind = 'reversal' THEN amount_cents ELSE 0 END), 0) AS reversed
           FROM commission_ledger GROUP BY partner_id, customer, livemode, currency`,
      )
      .all()
  ).results
  const entries = (await db.prepare('SELECT id, partner_id, customer, kind, amount_cents, currency, basis_cents, livemode, rule, created_at FROM commission_ledger ORDER BY id DESC LIMIT 100').all()).results
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
  return {
    ready: true,
    live,
    partners: partners.map((p) => {
      const mine = sums.filter((s) => s.partner_id === p.id)
      return {
        ...view(p, origin),
        referred: referred.filter((r) => r.partner_id === p.id).map((r) => ({ customer: r.customer, name: r.name, channel: r.channel, testBusiness: Boolean(r.is_test), attributedAt: r.created_at, commissionEndedAt: r.commission_ended_at ?? null })),
        // Live liability counts only while live billing is on; test-mode accruals are shown apart and never owed.
        liability: live ? money(mine, 1) : {},
        testMode: money(mine, 0),
      }
    }),
    ledger: entries.map((e) => ({ id: e.id, partnerId: e.partner_id, customer: e.customer, kind: e.kind, amountCents: e.amount_cents, currency: e.currency, basisCents: e.basis_cents, livemode: e.livemode === 1, rule: parseTerms(e.rule), at: e.created_at })),
  }
}

async function ready(db) {
  try {
    await db.prepare('SELECT 1 FROM referral_partners LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

// One admin write. body: { action: 'create', name, contactEmail?, terms? } | { action: 'pause'|'resume', id }
//   | { action: 'terms', id, terms }. → { ok, partner, from?, to? } | { ok: false, error, httpStatus }
export async function savePartner(env, body, adminEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await ready(db))) return { ok: false, error: 'not_ready', httpStatus: 409 }
  const action = body?.action
  if (action === 'create') {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ')
    if (!name || name.length > 80) return { ok: false, error: 'invalid_name', httpStatus: 400 }
    const email = body.contactEmail ? normEmail(body.contactEmail) : null
    if (email && (!EMAIL_RE.test(email) || email.length > 254)) return { ok: false, error: 'invalid_email', httpStatus: 400 }
    let terms = null
    if (body.terms != null) {
      const [err, t] = validateTerms(body.terms)
      if (err) return { ok: false, error: err, httpStatus: 400 }
      terms = t
    }
    for (let i = 0; i < 5; i++) {
      const p = { id: newId(), name, contact_email: email, code: newCode(), status: 'active', terms: terms ? JSON.stringify(terms) : null, created_by: adminEmail, created_at: now, updated_at: now }
      try {
        await db
          .prepare('INSERT INTO referral_partners (id, name, contact_email, code, status, terms, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)')
          .bind(p.id, p.name, p.contact_email, p.code, p.status, p.terms, p.created_by, now)
          .run()
        return { ok: true, partner: view(p), to: { status: 'active', terms } }
      } catch (err) {
        if (!/UNIQUE|PRIMARY/i.test(String(err?.message))) throw err // a code collision: draw again
      }
    }
    return { ok: false, error: 'storage_error', httpStatus: 503 }
  }
  if (!['pause', 'resume', 'terms'].includes(action)) return { ok: false, error: 'invalid_request', httpStatus: 400 }
  const id = String(body.id ?? '')
  const prior = await db.prepare('SELECT * FROM referral_partners WHERE id = ?1').bind(id).first()
  if (!prior) return { ok: false, error: 'not_found', httpStatus: 404 }
  if (action === 'terms') {
    const [err, t] = validateTerms(body.terms)
    if (err) return { ok: false, error: err, httpStatus: 400 }
    await db.prepare('UPDATE referral_partners SET terms = ?2, updated_at = ?3 WHERE id = ?1').bind(id, JSON.stringify(t), now).run()
    return { ok: true, partner: view({ ...prior, terms: JSON.stringify(t), updated_at: now }), from: { terms: parseTerms(prior.terms) }, to: { terms: t } }
  }
  const status = action === 'pause' ? 'paused' : 'active'
  await db.prepare('UPDATE referral_partners SET status = ?2, updated_at = ?3 WHERE id = ?1').bind(id, status, now).run()
  return { ok: true, partner: view({ ...prior, status, updated_at: now }), from: { status: prior.status }, to: { status } }
}

export const validCode = (c) => CODE_RE.test(String(c || ''))
