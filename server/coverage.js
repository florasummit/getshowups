// Service-area (coverage) requests. Lead eligibility and booking eligibility are separate:
//   - every lead with valid contact details is KEPT, wherever they are;
//   - only a lead in the business's listed ZIPs (or one the owner approved) can book.
// A lead outside the listed ZIPs, or whose ZIP couldn't be verified, gets a pending coverage request (migration 0029)
// for the owner: "We serve this area" makes it bookable with the SAME lead (the visitor gets their booking link; no
// starting over), "We can't serve this area" keeps it on record, never bookable. A decision never changes the
// business's service ZIP list. Before 0029 is applied nothing changes (the lead is kept exactly as before).
import { emailRef } from './auditlog.js'
import { resumeUrl } from './links.js'

export async function coverageReady(db) {
  return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coverage_requests'").first().catch(() => null))
}

// The insert for a new out-of-area lead, to run in the same batch as the lead itself.
export const coverageInsert = (db, { leadId, customer, zip, check, now }) =>
  db
    .prepare("INSERT OR IGNORE INTO coverage_requests (lead_id, customer, zip, zip_check, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)")
    .bind(leadId, customer, String(zip || '').slice(0, 10), check, now)

// decision 'approve' | 'decline'. A pending or declined request can be approved; only a pending one can be declined.
// Returns { ok, coverage, bookingUrl? } — bookingUrl only after approval (the owner can also send it themselves).
export async function decideCoverage(env, customer, leadId, decision, by, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await coverageReady(db))) return { ok: false, httpStatus: 409, error: 'not_ready' }
  if (typeof leadId !== 'string' || leadId.length > 64 || !['approve', 'decline'].includes(decision)) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db
    .prepare('SELECT r.status, l.status AS lead_status FROM coverage_requests r JOIN leads l ON l.id = r.lead_id AND l.customer = r.customer WHERE r.lead_id = ?1 AND r.customer = ?2')
    .bind(leadId, customer.id)
    .first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const ref = await emailRef(by || 'owner')
  if (decision === 'decline') {
    if (row.status === 'declined') return { ok: true, unchanged: true, coverage: 'declined' }
    if (row.status !== 'pending') return { ok: false, httpStatus: 409, error: 'already_decided' }
    const r = await db
      .prepare("UPDATE coverage_requests SET status = 'declined', decided_at = ?3, decided_by = ?4 WHERE lead_id = ?1 AND customer = ?2 AND status = 'pending'")
      .bind(leadId, customer.id, now, ref)
      .run()
    return r?.meta?.changes ? { ok: true, coverage: 'declined' } : { ok: false, httpStatus: 409, error: 'already_decided' }
  }
  if (row.status === 'approved') return { ok: true, unchanged: true, coverage: 'approved', bookingUrl: row.lead_status === 'new' ? await resumeUrl(env, customer.id, leadId) : null }
  // Approve: the request and the lead change together; the lead becomes bookable only while it is still unbooked.
  await db.batch([
    db.prepare("UPDATE coverage_requests SET status = 'approved', decided_at = ?3, decided_by = ?4 WHERE lead_id = ?1 AND customer = ?2 AND status IN ('pending', 'declined')").bind(leadId, customer.id, now, ref),
    db.prepare("UPDATE leads SET status = 'new', updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND status = 'unqualified'").bind(leadId, customer.id, now),
  ])
  return { ok: true, coverage: 'approved', bookingUrl: await resumeUrl(env, customer.id, leadId) }
}

// Coverage state per lead for a business's lead list: Map(leadId → { status, zip, check }).
export async function coverageFor(db, customerId, leadIds) {
  const out = new Map()
  if (!leadIds.length || !(await coverageReady(db))) return out
  const { results } = await db
    .prepare(`SELECT lead_id, status, zip, zip_check FROM coverage_requests WHERE customer = ?1 AND lead_id IN (${leadIds.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(customerId, ...leadIds)
    .all()
  for (const r of results) out.set(r.lead_id, { status: r.status, zip: r.zip, check: r.zip_check })
  return out
}
