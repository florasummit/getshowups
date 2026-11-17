// Money the business records against a visit, kept separate from attendance and from the estimated job value:
//   estimated  appointment_outcomes.value_cents (what the owner expects the job to be worth, set when marking a visit)
//   invoiced   what was billed            paid   what was actually received
// Only for visits that happened (status 'showed'). Append-only history (migration 0028): corrections add a row, so every
// change is kept; the latest row per kind is current. Nothing here is "revenue caused by ads" (that's attribution).
import { emailRef } from './auditlog.js'

export const MAX_CENTS = 100_000_000
export const REVENUE_KINDS = ['invoiced', 'paid']

export async function revenueReady(db) {
  return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revenue_entries'").first().catch(() => null))
}

// amountCents: integer ≥ 0, or null to clear. by: the owner's email (stored only as a reference).
export async function recordRevenue(db, customer, appointmentId, kind, amountCents, by, now = Date.now()) {
  if (!(await revenueReady(db))) return { ok: false, httpStatus: 409, error: 'not_ready' }
  if (typeof appointmentId !== 'string' || !REVENUE_KINDS.includes(kind)) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  if (amountCents !== null && (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > MAX_CENTS)) return { ok: false, httpStatus: 400, error: 'invalid_amount' }
  const appt = await db.prepare("SELECT id FROM appointments WHERE id = ?1 AND customer = ?2 AND status = 'showed'").bind(appointmentId, customer.id).first()
  if (!appt) return { ok: false, httpStatus: 404, error: 'not_found' }
  const current = await latest(db, customer.id, appointmentId)
  if ((current[kind] ?? null) === amountCents) return { ok: true, unchanged: true, revenue: current }
  await db.prepare('INSERT INTO revenue_entries (appointment_id, customer, kind, amount_cents, recorded_by, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(appointmentId, customer.id, kind, amountCents, await emailRef(by || 'owner'), now).run()
  return { ok: true, revenue: await latest(db, customer.id, appointmentId) }
}

// Current invoiced/paid for one appointment ({ invoiced: cents|null, paid: cents|null }).
export async function latest(db, customerId, appointmentId) {
  const { results } = await db
    .prepare('SELECT kind, amount_cents FROM revenue_entries WHERE id IN (SELECT max(id) FROM revenue_entries WHERE customer = ?1 AND appointment_id = ?2 GROUP BY kind)')
    .bind(customerId, appointmentId)
    .all()
  const out = { invoiced: null, paid: null }
  for (const r of results) out[r.kind] = r.amount_cents
  return out
}

// SQL (as a subquery) giving the current invoiced/paid per appointment of a business: join it as `rev` on appointment_id.
export const CURRENT_REVENUE_SQL = `SELECT appointment_id,
    max(CASE WHEN kind = 'invoiced' THEN amount_cents END) AS invoiced,
    max(CASE WHEN kind = 'paid' THEN amount_cents END) AS paid
  FROM revenue_entries WHERE id IN (SELECT max(id) FROM revenue_entries WHERE customer = ?1 GROUP BY appointment_id, kind)
  GROUP BY appointment_id`
