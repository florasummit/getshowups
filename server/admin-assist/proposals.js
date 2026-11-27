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
import { emailRef } from '../auditlog.js'
import { makePlan } from '../ops/qa-plan.js'
import { createExecution } from '../ops/qa-executions.js'
import { BACKLOG_KINDS, changeStatus, createItem, getItemRow } from '../ops/qa-items.js'
import { qaCenterReady } from '../ops/qa-results.js'
import { SAFE_PRESETS } from './qa.js'

export const TYPES = ['resend_invitation', 'mark_abandoned', 'run_reconciliation', 'code_status', 'test_mark', 'qa_run', 'qa_item', 'qa_status']
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
  // ---------- QA Command Center: through qa-core's own functions, with the checks its routes make ----------
  if (['qa_run', 'qa_item', 'qa_status'].includes(p.type) && !(await qaCenterReady(db))) return fail(503, 'not_available')
  if (p.type === 'qa_run') {
    const preset = p.after?.preset
    if (!SAFE_PRESETS.includes(preset) || typeof p.before.planId !== 'string') return fail(400, 'invalid_request')
    const plan = await makePlan(env, { preset }, now)
    // The plan shown on the card must still be the plan (same tests, same deployed commit).
    if (plan.planId !== p.before.planId) return fail(409, 'stale')
    if (!plan.runnable) return fail(403, 'not_runnable')
    if (plan.estimate.usdMicros > 0 || plan.scope.byClass.authorization > 0) return fail(403, 'not_allowed')
    if (plan.duplicate && p.after.rerun !== true) return fail(409, 'stale')
    const r = await createExecution(env, plan, await emailRef(admin.email), now)
    await audit(env, admin.email, 'qa.execution_requested', null, { execution: r.execution?.id ?? r.executionId ?? null, environment: plan.environment, preset, tests: plan.scope.tests, usdMicros: 0, outcome: r.error || r.execution?.status, via: 'admin_assistant' })
    if (r.error) return fail(r.error === 'already_running' ? 409 : 403, r.error)
    return { ok: true, state: plan.environment === 'production' ? 'Production verification queued; results appear in the QA Command Center within minutes.' : 'Run requested; results appear in the QA Command Center when it finishes.' }
  }
  if (p.type === 'qa_item') {
    const a = p.after || {}
    if (!BACKLOG_KINDS.includes(a.kind) || typeof a.title !== 'string') return fail(400, 'invalid_request')
    const r = await createItem(db, { kind: a.kind, title: a.title, description: a.description ?? undefined, area: a.area ?? undefined, customerImpact: a.customerImpact ?? undefined }, await emailRef(admin.email), now)
    if (r.error) return fail(400, r.error)
    await audit(env, admin.email, 'qa.item_create', null, { item: r.item.id, kind: r.item.kind, status: r.item.status, via: 'admin_assistant' })
    return { ok: true, state: 'Added to the backlog (Inbox). Nothing else starts.' }
  }
  if (p.type === 'qa_status') {
    const id = String(t.id || '')
    const status = p.after?.status
    if (t.kind !== 'qa_item' || typeof status !== 'string' || status === 'verified') return fail(400, 'invalid_request')
    const cur = await getItemRow(db, id)
    if (!cur) return fail(404, 'not_found')
    if (cur.status === status) return { ok: true, already: true, state: 'Already in that status.' }
    if (cur.status !== p.before.status) return fail(409, 'stale')
    const r = await changeStatus(db, { id, status }, await emailRef(admin.email), now)
    if (r.error) return fail(r.error === 'conflict' ? 409 : 400, r.error)
    await audit(env, admin.email, 'qa.item_status', null, { item: id, kind: r.item.kind, status: r.item.status, via: 'admin_assistant' })
    return { ok: true, state: 'Status changed.' }
  }
  return fail(400, 'invalid_request')
}
