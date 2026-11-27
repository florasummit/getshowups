// Partner payouts made OUTSIDE GetShowUps, recorded by a platform admin (migration 0048 partner_payouts +
// payout_settlements, both append-only). GetShowUps never initiates, schedules or sends a payment: there is no payment
// call anywhere in this module.
//   Balance (per currency, LIVE ledger rows only; test-mode commissions are never payable):
//     earned = accruals − reversals · paid = payouts − payout reversals · owed = earned − paid (negative = overpaid).
//   A payout either settles specific accruals (itemized; its amount is their net after refunds/disputes) or is an amount
//   on account. It can never exceed the owed balance: the INSERT itself is guarded by the balance, so two admins saving at
//   once can't both pass. An accrual can never be settled twice: payout_settlements is unique on (ledger_id, cycle),
//   where cycle counts that accrual's earlier settlements cancelled by a payout reversal.
//   A mistaken payout is corrected by a 'reversal' row (one per payout, unique), which frees what it settled; nothing is
//   ever edited or deleted.
import { cleanText, parseDay, sensitiveNumber } from './partners.js'

const DAY = 86_400_000
const fail = (error, httpStatus = 400) => ({ ok: false, error, httpStatus })
const newId = (prefix) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')}`

const ACTIVE_SETTLEMENT = `EXISTS (SELECT 1 FROM payout_settlements s WHERE s.ledger_id = a.id AND NOT EXISTS (SELECT 1 FROM partner_payouts x WHERE x.reverses = s.payout_id))`
const NET = `a.amount_cents + coalesce((SELECT sum(r.amount_cents) FROM commission_ledger r WHERE r.kind = 'reversal' AND r.reverses = a.id), 0)`
// Owed balance of a partner in a currency, as SQL (?1 partner, ?2 currency).
const OWED = `((SELECT coalesce(sum(amount_cents), 0) FROM commission_ledger WHERE partner_id = ?1 AND livemode = 1 AND currency = ?2)
             - (SELECT coalesce(sum(CASE WHEN kind = 'payout' THEN amount_cents ELSE -amount_cents END), 0) FROM partner_payouts WHERE partner_id = ?1 AND currency = ?2))`

export async function payoutOverview(db, partnerId) {
  const accruals = (
    await db
      .prepare(`SELECT a.id, a.customer, a.currency, a.created_at, ${NET} AS net, ${ACTIVE_SETTLEMENT} AS settled FROM commission_ledger a WHERE a.partner_id = ?1 AND a.kind = 'accrual' AND a.livemode = 1 ORDER BY a.id`)
      .bind(partnerId)
      .all()
  ).results
  const earned = (await db.prepare('SELECT currency, sum(amount_cents) AS cents FROM commission_ledger WHERE partner_id = ?1 AND livemode = 1 GROUP BY currency').bind(partnerId).all()).results
  const rows = (await db.prepare('SELECT * FROM partner_payouts WHERE partner_id = ?1 ORDER BY created_at, id').bind(partnerId).all()).results
  const settlements = (await db.prepare('SELECT s.payout_id, s.ledger_id, s.amount_cents FROM payout_settlements s JOIN partner_payouts p ON p.id = s.payout_id WHERE p.partner_id = ?1').bind(partnerId).all()).results
  const balances = {}
  const bal = (c) => (balances[c] ||= { earnedCents: 0, paidCents: 0, owedCents: 0 })
  for (const e of earned) bal(e.currency).earnedCents += Number(e.cents || 0)
  for (const p of rows) bal(p.currency).paidCents += p.kind === 'payout' ? p.amount_cents : -p.amount_cents
  for (const b of Object.values(balances)) b.owedCents = b.earnedCents - b.paidCents
  const reversedBy = new Map(rows.filter((r) => r.kind === 'reversal').map((r) => [r.reverses, r.id]))
  return {
    balances,
    history: rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      amountCents: p.amount_cents,
      currency: p.currency,
      paidOn: p.paid_on ?? null,
      methodLabel: p.method_label ?? null,
      externalReference: p.external_reference ?? null,
      periodFrom: p.period_from ?? null,
      periodTo: p.period_to ?? null,
      note: p.note ?? null,
      reverses: p.reverses ?? null,
      reversedBy: reversedBy.get(p.id) ?? null,
      settles: settlements.filter((s) => s.payout_id === p.id).map((s) => s.ledger_id),
      recordedBy: p.recorded_by,
      createdAt: p.created_at,
    })),
    unsettled: accruals.filter((a) => !a.settled && Number(a.net) > 0).map((a) => ({ ledgerId: a.id, customer: a.customer, netCents: Number(a.net), currency: a.currency, at: a.created_at })),
  }
}

// body: { id (partner), paidOn, methodLabel, externalReference?, periodFrom?, periodTo?, note?, and either accrualIds: [ledger
// ids] (itemized) or amountCents + currency (on account) }. → { ok, payout, audit } | { ok: false, error, httpStatus }
export async function recordPayout(env, body, adminEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const partner = await db.prepare('SELECT id FROM referral_partners WHERE id = ?1').bind(String(body?.id ?? '')).first()
  if (!partner) return fail('not_found', 404)
  const paidOn = parseDay(body.paidOn)
  if (paidOn == null || paidOn > now + DAY) return fail('invalid_paid_on')
  const method = cleanText(body.methodLabel, 60)
  if (!method) return fail('invalid_method')
  const reference = cleanText(body.externalReference, 120) || null
  const note = cleanText(body.note, 500) || null
  if ([body.methodLabel, body.externalReference, body.note].some(sensitiveNumber)) return fail('sensitive_number')
  const from = body.periodFrom ? parseDay(body.periodFrom) : null
  const to = body.periodTo ? parseDay(body.periodTo) : null
  if ((body.periodFrom && from == null) || (body.periodTo && to == null) || (from != null && to != null && from > to)) return fail('invalid_period')

  let amount
  let currency
  let items = []
  if (Array.isArray(body.accrualIds) && body.accrualIds.length) {
    const ids = [...new Set(body.accrualIds.map(Number))]
    if (ids.some((x) => !Number.isInteger(x)) || ids.length > 500) return fail('unknown_accrual')
    const rows = (
      await db
        .prepare(`SELECT a.id, a.currency, ${NET} AS net, ${ACTIVE_SETTLEMENT} AS settled FROM commission_ledger a WHERE a.partner_id = ?1 AND a.kind = 'accrual' AND a.livemode = 1 AND a.id IN (${ids.map(() => '?').join(',')})`)
        .bind(partner.id, ...ids)
        .all()
    ).results
    if (rows.length !== ids.length) return fail('unknown_accrual')
    if (rows.some((r) => r.settled)) return fail('already_settled', 409)
    if (rows.some((r) => Number(r.net) <= 0)) return fail('nothing_owed_on_accrual')
    if (new Set(rows.map((r) => r.currency)).size !== 1) return fail('mixed_currency')
    currency = rows[0].currency
    amount = rows.reduce((n, r) => n + Number(r.net), 0)
    if (body.amountCents != null && Number(body.amountCents) !== amount) return fail('amount_mismatch')
    for (const r of rows) {
      const c = await db.prepare('SELECT count(*) AS n FROM payout_settlements s WHERE s.ledger_id = ?1 AND EXISTS (SELECT 1 FROM partner_payouts x WHERE x.reverses = s.payout_id)').bind(r.id).first()
      items.push({ ledgerId: r.id, cycle: Number(c?.n || 0), amount: Number(r.net) })
    }
  } else {
    amount = Number(body.amountCents)
    currency = String(body.currency || '').toLowerCase()
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) return fail('invalid_amount')
    if (!/^[a-z]{3}$/.test(currency)) return fail('invalid_currency')
  }
  const id = newId('pay')
  const stmts = [
    db
      .prepare(
        `INSERT INTO partner_payouts (id, partner_id, kind, amount_cents, currency, paid_on, method_label, external_reference, period_from, period_to, note, recorded_by, created_at)
         SELECT ?3, ?1, 'payout', ?4, ?2, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE ${OWED} >= ?4`,
      )
      .bind(partner.id, currency, id, amount, paidOn, method, reference, from, to, note, adminEmail, now),
    ...items.map((it) =>
      db
        .prepare('INSERT INTO payout_settlements (payout_id, ledger_id, cycle, amount_cents, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM partner_payouts WHERE id = ?1)')
        .bind(id, it.ledgerId, it.cycle, it.amount, now),
    ),
  ]
  try {
    await db.batch(stmts)
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail('already_settled', 409) // another payout settled one of them first
    throw e
  }
  if (!(await db.prepare('SELECT 1 FROM partner_payouts WHERE id = ?1').bind(id).first())) return fail('over_balance', 409)
  return {
    ok: true,
    payout: { id, amountCents: amount, currency, settles: items.map((i) => i.ledgerId) },
    audit: { action: 'partner.payout_recorded', details: { partner: partner.id, payout: id, amountCents: amount, currency, paidOn, method, reference: Boolean(reference), settled: items.length, onAccount: items.length === 0 } },
  }
}

// { id (partner), payoutId, note?, confirm: true } → a reversal row (the payout stays, marked reversed; what it settled is
// free again). One reversal per payout.
export async function reversePayout(env, body, adminEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (body?.confirm !== true) return fail('confirmation_required')
  const p = await db.prepare("SELECT * FROM partner_payouts WHERE id = ?1 AND partner_id = ?2 AND kind = 'payout'").bind(String(body.payoutId ?? ''), String(body.id ?? '')).first()
  if (!p) return fail('not_found', 404)
  if (sensitiveNumber(body.note)) return fail('sensitive_number')
  const id = newId('rev')
  try {
    await db
      .prepare("INSERT INTO partner_payouts (id, partner_id, kind, amount_cents, currency, note, reverses, recorded_by, created_at) VALUES (?1, ?2, 'reversal', ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(id, p.partner_id, p.amount_cents, p.currency, cleanText(body.note, 500) || null, p.id, adminEmail, now)
      .run()
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail('already_reversed', 409)
    throw e
  }
  return { ok: true, reversal: { id, reverses: p.id }, audit: { action: 'partner.payout_reversed', details: { partner: p.partner_id, payout: p.id, reversal: id, amountCents: p.amount_cents, currency: p.currency } } }
}
