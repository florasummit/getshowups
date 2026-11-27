// Applies ONE change the admin assistant prepared (tools.js prepare_*), after the platform admin's explicit Approve
// (confirm: true). The same pattern as the owner's server/proposals.js: the card carries what was reviewed (`before`);
// every apply re-reads the records, refuses when they changed (409 stale), and runs ONLY through the existing audited
// server functions the admin pages use. The allowlist is closed: anything else is 400.
import { audit } from '../platform.js'
import { resendInvite } from '../accounts.js'
import { emailConfigured, flushOutbox } from '../email.js'
import { markAbandoned, sendInvitation } from '../enrollment.js'
import { reconcileBilling, lastReconciliation } from '../reconcile.js'
import { saveAcquisitionCode } from '../acquisition.js'
import { setTestBusiness, testStatus } from '../testbusiness.js'
import { stripeConfigured } from '../stripe.js'
import { CUSTOMER_RE } from '../invites.js'
import { SALES_BUSINESS } from '../metrics.js'

export const TYPES = ['resend_invitation', 'mark_abandoned', 'run_reconciliation', 'code_status', 'test_mark']
const ENR_RE = /^enr_[A-Za-z0-9_-]{16}$/
const INV_RE = /^[A-Za-z0-9_-]{8,40}$/
const fail = (status, error) => ({ ok: false, status, error })
const NEVER_TEST = new Set([SALES_BUSINESS, 'poolthru-llc'])

export async function applyAdminProposal(env, admin, body, now = Date.now()) {
  const p = body?.proposal
  if (body?.confirm !== true) return fail(400, 'confirmation_required')
  if (!p || typeof p !== 'object' || !TYPES.includes(p.type) || !p.before || typeof p.before !== 'object') return fail(400, 'invalid_request')
  const db = env.ONBOARDING_DB
  const staff = { email: admin.email, roles: new Set(['platform_admin']) }
  const t = p.target || {}

  if (p.type === 'resend_invitation' && t.kind === 'business') {
    if (!CUSTOMER_RE.test(String(t.id)) || !INV_RE.test(String(p.before.inviteId))) return fail(400, 'invalid_request')
    if (await db.prepare('SELECT 1 FROM customer_users WHERE customer = ?1 LIMIT 1').bind(t.id).first()) return fail(409, 'stale')
    const latest = await db.prepare('SELECT id FROM account_invites WHERE customer = ?1 AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(t.id).first()
    if (latest?.id !== p.before.inviteId) return fail(409, 'stale')
    const invite = await resendInvite(env, { id: latest.id, actor: admin.email }, now)
    if (!invite) return fail(409, 'stale')
    await audit(env, admin.email, 'invite.resend', t.id, { previousInviteId: latest.id, inviteId: invite.id, via: 'admin_assistant' })
    const delivery = await flushOutbox(env).catch(() => ({ sent: 0 }))
    return { ok: true, state: !emailConfigured(env) ? 'New invitation created; email delivery isn’t configured, so it is queued.' : delivery.sent > 0 ? 'New invitation sent.' : 'New invitation queued for sending.' }
  }
  if (p.type === 'resend_invitation' && t.kind === 'enrollment') {
    if (!ENR_RE.test(String(t.id))) return fail(400, 'invalid_request')
    const cur = await db.prepare('SELECT stage, invite_id FROM assisted_enrollments WHERE id = ?1').bind(t.id).first()
    if (!cur) return fail(404, 'not_found')
    if (cur.stage !== p.before.stage || (cur.invite_id ?? null) !== (p.before.inviteId ?? null)) return fail(409, 'stale')
    const r = await sendInvitation(env, staff, t.id, now)
    if (!r.ok) return fail(r.httpStatus, r.error)
    return { ok: true, state: 'Ownership invitation sent (the email goes through the outbox and the launch gate).' }
  }
  if (p.type === 'mark_abandoned') {
    if (t.kind !== 'enrollment' || !ENR_RE.test(String(t.id))) return fail(400, 'invalid_request')
    const cur = await db.prepare('SELECT stage FROM assisted_enrollments WHERE id = ?1').bind(t.id).first()
    if (!cur) return fail(404, 'not_found')
    if (cur.stage === 'abandoned') return { ok: true, already: true, state: 'Already marked abandoned.' }
    if (cur.stage !== p.before.stage) return fail(409, 'stale')
    const r = await markAbandoned(env, staff, t.id, now)
    if (!r.ok) return fail(r.httpStatus, r.error)
    return { ok: true, state: 'Marked abandoned.' }
  }
  if (p.type === 'run_reconciliation') {
    if (!stripeConfigured(env)) return fail(409, 'not_configured')
    const last = await lastReconciliation(db)
    // Someone ran it since this was prepared: the newer result is the answer; nothing runs twice.
    if ((last?.at ?? null) !== (p.before.lastAt ?? null)) return { ok: true, already: true, state: `Already ran since this was prepared: ${last?.real ?? 0} issue(s) on real businesses.` }
    const r = await reconcileBilling(env, { actor: admin.email, now })
    if (!r.ok) return fail(r.error === 'not_configured' ? 409 : 502, r.error)
    return { ok: true, state: `Reconciliation finished: ${r.issues} issue(s), ${r.real} on real businesses.` }
  }
  if (p.type === 'code_status') {
    const code = String(t.id || '')
    const status = p.after?.status
    const cur = await db.prepare('SELECT status FROM acquisition_codes WHERE code = ?1').bind(code).first().catch(() => null)
    if ((cur?.status || 'prepared') !== p.before.status) return fail(409, 'stale')
    const r = await saveAcquisitionCode(env, { code, status }, now)
    if (!r.ok) return fail(r.httpStatus, r.error)
    await audit(env, admin.email, 'acquisition.code_updated', null, { code: r.code, activity: r.activity, from: r.from, to: r.to, via: 'admin_assistant' })
    return { ok: true, state: `Recorded as ${String(status).replace('_', ' ')}.` }
  }
  if (p.type === 'test_mark') {
    const id = String(t.id || '')
    const want = p.after?.test
    if (t.kind !== 'business' || !CUSTOMER_RE.test(id) || typeof want !== 'boolean' || typeof p.before.test !== 'boolean') return fail(400, 'invalid_request')
    if (want && NEVER_TEST.has(id)) return fail(403, 'not_allowed')
    if (!(await db.prepare('SELECT 1 FROM customers WHERE id = ?1').bind(id).first())) return fail(404, 'not_found')
    const cur = await testStatus(env, id)
    if (cur.unreadable) return fail(503, 'storage_error')
    if (cur.test === want) return { ok: true, already: true, state: want ? 'Already a test business.' : 'Already not a test business.' }
    if (cur.test !== p.before.test) return fail(409, 'stale')
    const r = await setTestBusiness(env, id, want, admin.email, now)
    if (!r.ok) return fail(r.httpStatus || 503, r.error)
    if (r.changed) await audit(env, admin.email, want ? 'customer.test_mark' : 'customer.test_unmark', id, { via: 'admin_assistant' })
    return { ok: true, state: want ? 'Marked as a test business.' : 'Test-business mark removed.' }
  }
  return fail(400, 'invalid_request')
}
