// Commission ledger (migration 0048, append-only: triggers refuse UPDATE/DELETE). Commissions come ONLY from revenue
// Stripe reports as collected, through the verified webhook (server/stripe.js handleEvent):
//   invoice.paid → accrueCommission: when REFERRALS_ENABLED is exactly 'true', the business has a partner attribution,
//     the partner is active with terms, the referral touch was inside the terms' window, the payment is inside the
//     recurring rule ('once' = the first commissioned payment only; 'months:N' = payments within N calendar months of
//     the first commissioned one; 'lifetime'), the subscription has not ended, the business is not a test business and
//     the partner is still not one of the business's people: ONE accrual per invoice (unique (kind, stripe_object_id)),
//     computed from amount_paid minus tax, with the applied terms snapshotted on the row.
//   charge.refunded → reversal proportional to the charge's cumulative refunded amount (key refund:<charge>:<cumulative>,
//     so a replay adds nothing and a second partial refund adds only the difference).
//   charge.dispute.created / charge.dispute.funds_withdrawn → one reversal per dispute (key dispute:<id>), proportional
//     to the disputed amount. Reversals never exceed what was accrued, and are applied whether or not the switch is on.
//   customer.subscription.deleted → endCommissions: no accrual for payments after the end.
// livemode is recorded on every row: only live rows can ever be a liability, and only while live billing is on; test-mode
// rows are shown apart as test. Nothing here pays anyone: there is no payout code.
import { recordEvent } from './auditlog.js'
import { parseTerms, inWindow, selfReferral } from './commercial-attribution.js'
import { testStatus } from './testbusiness.js'

export const referralsEnabled = (env) => env.REFERRALS_ENABLED === 'true'
const missing = (err) => String(err?.message || '').includes('no such table')

// Tax Stripe reports on the invoice: `total_taxes` (API 2025-03-31+) or `tax` (older versions).
export function invoiceTax(inv) {
  if (Array.isArray(inv?.total_taxes)) return inv.total_taxes.reduce((n, t) => n + (Number.isFinite(t?.amount) ? t.amount : 0), 0)
  return Number.isFinite(inv?.tax) ? inv.tax : 0
}
// The collected amount a commission is computed from: what was paid, less tax (never below zero).
export const commissionBasis = (inv) => Math.max(0, Number(inv?.amount_paid || 0) - Math.max(0, invoiceTax(inv)))

export function commissionAmount(terms, basisCents, currency) {
  if (!terms || basisCents <= 0) return 0
  if (terms.type === 'percent') return Math.round((basisCents * terms.value) / 100)
  if (terms.type === 'fixed') return terms.currency === String(currency || '').toLowerCase() ? Math.min(terms.value, basisCents) : 0
  return 0
}

const addMonths = (t, n) => {
  const d = new Date(t)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + n)
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  return d.getTime()
}
// Whether a payment at `at` falls inside the recurring rule, given the first commissioned payment (null: none yet).
export function withinRecurring(recurring, firstAt, at) {
  if (firstAt == null) return true
  if (recurring === 'lifetime') return true
  if (recurring === 'once') return false
  const m = /^months:(\d+)$/.exec(recurring || '')
  return Boolean(m) && at < addMonths(firstAt, Number(m[1]))
}

// The invoice's payment references, where the payload carries them (older API: charge/payment_intent; newer: payments).
function paymentRefs(inv) {
  const p = inv?.payments?.data?.find((x) => x?.payment)?.payment || {}
  const id = (v) => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null)
  return { charge: id(inv?.charge) || id(p.charge), paymentIntent: id(inv?.payment_intent) || id(p.payment_intent) }
}

const skip = (reason) => ({ accrued: false, reason })

// → { accrued: true, amountCents } | { accrued: false, reason }. Storage errors throw (the webhook then lets Stripe retry;
// the ledger's unique key makes the retry safe). Before migration 0048: no-op.
export async function accrueCommission(env, customer, event, inv, now = Date.now()) {
  if (!referralsEnabled(env)) return skip('off')
  const db = env.ONBOARDING_DB
  if (!customer || typeof inv?.id !== 'string' || !(Number(inv.amount_paid) > 0)) return skip('nothing_paid')
  let a
  try {
    a = await db.prepare('SELECT * FROM commercial_attribution WHERE customer = ?1').bind(customer).first()
  } catch (err) {
    if (missing(err)) return skip('not_ready')
    throw err
  }
  if (!a?.partner_id) return skip('no_partner')
  const paidAt = Number.isFinite(inv.status_transitions?.paid_at) ? inv.status_transitions.paid_at * 1000 : event.created * 1000
  if (a.commission_ended_at && paidAt > a.commission_ended_at) return skip('subscription_ended')
  if ((await testStatus(env, customer)).test) return skip('test_business')
  const p = await db.prepare('SELECT id, contact_email, status, terms, updated_at FROM referral_partners WHERE id = ?1').bind(a.partner_id).first()
  if (!p) return skip('no_partner')
  if (p.status !== 'active') return skip('partner_paused')
  const terms = parseTerms(p.terms)
  if (!terms) return skip('no_terms')
  if (!inWindow(terms, a.partner_touched_at, a.created_at)) return skip('outside_window')
  const members = (await db.prepare('SELECT email FROM customer_users WHERE customer = ?1').bind(customer).all()).results.map((r) => r.email)
  if (selfReferral(p.contact_email, [...members, a.closing_rep_email].filter(Boolean))) return skip('self_referral')
  const first = await db.prepare("SELECT min(created_at) AS at FROM commission_ledger WHERE partner_id = ?1 AND customer = ?2 AND kind = 'accrual'").bind(p.id, customer).first()
  if (!withinRecurring(terms.recurring, first?.at ?? null, paidAt)) return skip('recurring_rule')
  const basis = commissionBasis(inv)
  const amount = commissionAmount(terms, basis, inv.currency)
  if (amount <= 0) return skip(terms.type === 'fixed' && terms.currency !== String(inv.currency || '').toLowerCase() ? 'currency_mismatch' : 'nothing_due')
  const refs = paymentRefs(inv)
  const rule = { partnerId: p.id, ...terms, termsUpdatedAt: p.updated_at }
  const r = await db
    .prepare(
      `INSERT INTO commission_ledger (partner_id, customer, kind, stripe_object_id, stripe_invoice_id, stripe_charge_id, stripe_payment_intent, amount_cents, currency, basis_cents, paid_cents, livemode, rule, created_at)
       VALUES (?1, ?2, 'accrual', ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(kind, stripe_object_id) DO NOTHING`,
    )
    .bind(p.id, customer, inv.id, refs.charge, refs.paymentIntent, amount, String(inv.currency || '').toLowerCase(), basis, Number(inv.amount_paid), event.livemode === true ? 1 : 0, JSON.stringify(rule), paidAt)
    .run()
  if ((r?.meta?.changes ?? 0) === 0) return skip('duplicate')
  await recordEvent(db, { type: 'commission.accrued', actor: 'stripe', customer, capability: 'commercial.commissions', resource: { type: 'invoice', id: inv.id }, correlationId: `stripe:${event.id}`, details: { partner: p.id, amountCents: amount, basisCents: basis, currency: inv.currency ?? null, livemode: event.livemode === true }, at: now })
  return { accrued: true, amountCents: amount }
}

// The accrual a charge belongs to: by charge id, payment intent or invoice id; otherwise (newer API payloads carry none
// of them on the invoice) by asking Stripe which invoice the payment intent paid (lookupInvoice, read-only).
async function accrualFor(db, { charge, paymentIntent, invoice }, lookupInvoice) {
  const q = "SELECT * FROM commission_ledger WHERE kind = 'accrual' AND (stripe_charge_id = ?1 OR stripe_payment_intent = ?2 OR stripe_invoice_id = ?3) ORDER BY id LIMIT 1"
  const hit = await db.prepare(q).bind(charge || '\u0000', paymentIntent || '\u0000', invoice || '\u0000').first()
  if (hit || !paymentIntent || !lookupInvoice) return hit || null
  const found = await lookupInvoice(paymentIntent)
  return found ? (await db.prepare(q).bind('\u0000', '\u0000', found).first()) || null : null
}

async function reversedSoFar(db, accrualId) {
  const r = await db
    .prepare("SELECT coalesce(sum(CASE WHEN stripe_object_id LIKE 'refund:%' THEN -amount_cents ELSE 0 END), 0) AS refunds, coalesce(sum(-amount_cents), 0) AS total FROM commission_ledger WHERE kind = 'reversal' AND reverses = ?1")
    .bind(accrualId)
    .first()
  return { refunds: Number(r?.refunds || 0), total: Number(r?.total || 0) }
}

// charge.refunded | charge.dispute.created | charge.dispute.funds_withdrawn. lookupInvoice(paymentIntentId) → invoice id
// or null; it throws on a Stripe failure so the webhook is retried. → { reversed: true, amountCents } | { reversed: false, reason }
export async function reverseCommission(env, event, { lookupInvoice = null, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const obj = event.data?.object || {}
  const dispute = event.type.startsWith('charge.dispute.')
  const id = (v) => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null)
  const ref = dispute ? { charge: id(obj.charge), paymentIntent: id(obj.payment_intent), invoice: null } : { charge: id(obj.id), paymentIntent: id(obj.payment_intent), invoice: id(obj.invoice) }
  let acc
  try {
    acc = await accrualFor(db, ref, lookupInvoice)
  } catch (err) {
    if (missing(err)) return { reversed: false, reason: 'not_ready' }
    throw err
  }
  if (!acc) return { reversed: false, reason: 'no_accrual' }
  const so = await reversedSoFar(db, acc.id)
  const left = acc.amount_cents - so.total
  let delta
  let key
  let paid
  if (dispute) {
    if (typeof obj.id !== 'string') return { reversed: false, reason: 'invalid' }
    paid = Math.max(0, Number(obj.amount || 0))
    key = `dispute:${obj.id}`
    delta = Math.min(left, Math.round((acc.amount_cents * Math.min(paid, acc.paid_cents)) / acc.paid_cents))
  } else {
    const total = Number(obj.amount || acc.paid_cents)
    paid = Math.max(0, Math.min(Number(obj.amount_refunded || 0), total))
    key = `refund:${ref.charge}:${paid}`
    // Cumulative: the share of the commission matching everything refunded so far, less what refunds already reversed.
    delta = Math.min(left, Math.round((acc.amount_cents * paid) / total) - so.refunds)
  }
  if (!(delta > 0)) return { reversed: false, reason: 'nothing_left' }
  const r = await db
    .prepare(
      `INSERT INTO commission_ledger (partner_id, customer, kind, stripe_object_id, stripe_invoice_id, stripe_charge_id, stripe_payment_intent, amount_cents, currency, basis_cents, paid_cents, livemode, rule, reverses, created_at)
       VALUES (?1, ?2, 'reversal', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) ON CONFLICT(kind, stripe_object_id) DO NOTHING`,
    )
    .bind(acc.partner_id, acc.customer, key, acc.stripe_invoice_id, ref.charge, ref.paymentIntent, -delta, acc.currency, acc.basis_cents, paid, acc.livemode, acc.rule, acc.id, now)
    .run()
  if ((r?.meta?.changes ?? 0) === 0) return { reversed: false, reason: 'duplicate' }
  await recordEvent(db, { type: 'commission.reversed', actor: 'stripe', customer: acc.customer, capability: 'commercial.commissions', resource: { type: dispute ? 'dispute' : 'charge', id: dispute ? obj.id : ref.charge }, correlationId: `stripe:${event.id}`, details: { partner: acc.partner_id, amountCents: delta, reason: dispute ? 'dispute' : 'refund', livemode: acc.livemode === 1 }, at: now })
  return { reversed: true, amountCents: delta }
}

// The subscription ended: no commission for payments after `at`. Fail-soft (before 0048, or no attribution: nothing).
export async function endCommissions(db, customer, at) {
  try {
    await db.prepare('UPDATE commercial_attribution SET commission_ended_at = ?2 WHERE customer = ?1 AND commission_ended_at IS NULL').bind(customer, at).run()
  } catch (err) {
    if (!missing(err)) throw err
  }
}
