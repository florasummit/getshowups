// What customers should know (migration 0019): two short notes the owner writes. Customer-facing, so they go through
// the same claims filter as the profile. Empty notes are simply not shown.
import { unapprovedClaims } from './ads/spec.js'

export const POLICY_FIELDS = { beforeVisit: 'before_visit', cancellation: 'cancellation' }
export const POLICY_MAX = 300
const printable = (ch) => ch === '\n' || (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
const clean = (v) =>
  Array.from(String(v ?? '').replace(/\r\n?/g, '\n')).filter(printable).join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

export function validatePolicies(body) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  const p = {}
  for (const k of Object.keys(POLICY_FIELDS)) {
    p[k] = clean(b[k])
    if (p[k].length > POLICY_MAX) errors.push(k)
    else if (p[k] && unapprovedClaims(p[k]).length) errors.push(`${k}:unapproved_claim`)
  }
  return [errors, p]
}

export async function getPolicies(db, customerId) {
  const r = await db.prepare('SELECT before_visit, cancellation FROM business_policies WHERE customer = ?1').bind(customerId).first()
  return { beforeVisit: r?.before_visit ?? '', cancellation: r?.cancellation ?? '' }
}

export async function savePolicies(db, customerId, p, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO business_policies (customer, before_visit, cancellation, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(customer) DO UPDATE SET before_visit = ?2, cancellation = ?3, updated_at = ?4`,
    )
    .bind(customerId, p.beforeVisit, p.cancellation, now)
    .run()
}

// Customer-facing reads (booking page, emails) never fail because of the notes: missing table / storage error → none.
export async function policiesOrEmpty(db, customerId) {
  try {
    return await getPolicies(db, customerId)
  } catch {
    return { beforeVisit: '', cancellation: '' }
  }
}
