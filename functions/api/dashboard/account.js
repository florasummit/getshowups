// /api/dashboard/account — closing the business and the person's own account (server/deletion.js, server/people.js).
//   GET  → what closing would do (counts only), whether it is switched on, its recovery window and current state
//   POST { action: 'delete', confirm, name }        owner + recent sign-in + typed name; 404 unless ACCOUNT_DELETION_ENABLED
//        { action: 'undo_delete', confirm }         owner, within the recovery window
//        { action: 'request_closure' | 'withdraw_closure', confirm }   while deletion is off: a person handles it
//        { action: 'delete_me', confirm, email }    own account; recent sign-in + typed email; 404 unless switched on
import { json } from '../../../server/google-oauth.js'
import { SESSION_COOKIE, cookie, isOwner, needsFresh, requireSession } from '../../../server/auth.js'
import { cancelDeletion, closureRequest, deletionEnabled, deletionStatus, protectedBusiness, recoveryDays, requestDeletion, setClosureRequest } from '../../../server/deletion.js'
import { closingImpact } from '../../../server/closing-impact.js'
import { getSubscription } from '../../../server/stripe.js'
import { deletePerson, personState } from '../../../server/people.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false })
  if (response) return response
  const db = env.ONBOARDING_DB
  const c = session.customer
  const person = await personState(env, session)
  if (!c) return json(200, { enabled: deletionEnabled(env), person, email: session.email, business: null })
  const [owner, del, request_, impact, protectedBiz, sub] = await Promise.all([isOwner(db, session), deletionStatus(db, c.id), closureRequest(db, c.id).catch(() => null), closingImpact(env, c), protectedBusiness(env, c.id), getSubscription(db, c.id)])
  return json(200, {
    enabled: deletionEnabled(env),
    person,
    email: session.email,
    recoveryDays: recoveryDays(env),
    business: {
      name: c.name,
      owner,
      protected: protectedBiz,
      impact,
      request: request_,
      scheduledFor: del?.status === 'in_progress' && del.step === 'lockout' ? (del.report.scheduledFor ?? null) : null,
      chargesStopped: Boolean(del) && (!sub?.stripeSubscriptionId || sub.status === 'canceled' || sub.cancelAtPeriodEnd),
      adsPending: del?.report?.adsPending === true,
    },
  })
}

export async function onRequestPost({ request, env }) {
  const body = (await request.clone().json().catch(() => null)) || {}
  if (['delete', 'delete_me'].includes(body.action) && !deletionEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true, needCustomer: body.action !== 'delete_me' })
  if (response) return response
  if (!['delete', 'undo_delete', 'request_closure', 'withdraw_closure', 'delete_me'].includes(body.action)) return json(400, { error: 'invalid_request' })
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  const rl = await hit(env, 'accountWrite', session.customer?.id || session.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    if (body.action === 'delete_me') {
      if (norm(body.email) !== norm(session.email)) return json(400, { error: 'email_mismatch' })
      const stale = needsFresh(session)
      if (stale) return stale
      const r = await deletePerson(env, session)
      if (!r.ok) return json(r.status || 409, { error: r.error })
      const res = json(200, { deleted: true })
      res.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
      return res
    }
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    const id = session.customer.id
    const actor = { type: 'owner', id: session.email }
    if (body.action === 'undo_delete') {
      const r = await cancelDeletion(env, id, actor)
      return r.ok ? json(200, { ok: true }) : json(409, { error: r.error })
    }
    if (body.action === 'withdraw_closure') {
      const r = await setClosureRequest(env, id, 'withdrawn', actor)
      return r.ok ? json(200, { ok: true }) : json(409, { error: r.error })
    }
    if (body.action === 'delete' && norm(body.name) !== norm(session.customer.name)) return json(400, { error: 'name_mismatch' })
    const stale = needsFresh(session)
    if (stale) return stale
    if (body.action === 'request_closure') {
      const r = await setClosureRequest(env, id, 'requested', actor)
      return r.ok ? json(200, { ok: true }) : json(409, { error: r.error })
    }
    const r = await requestDeletion(env, id, actor)
    if (!r.ok) return json(r.error === 'not_found' ? 404 : 409, { error: r.error })
    return json(202, { deleting: true, status: r.status, scheduledFor: r.scheduledFor ?? null })
  } catch (err) {
    console.error('account action failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
