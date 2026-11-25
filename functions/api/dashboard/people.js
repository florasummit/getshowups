// /api/dashboard/people — who can sign in to this business, the signed-in person's sessions and notification choices.
//   GET → { you, members, invites, sessions, notices|null }
//   POST { action: 'invite', email } | { action: 'cancel_invite', id } | { action: 'remove', email, confirm }   owner, recent sign-in
//        { action: 'leave', confirm }                                                                          anyone but the last
//        { action: 'end_sessions', all } | { action: 'notice', kind, on }                                      yourself
import { json } from '../../../server/google-oauth.js'
import { isOwner, needsFresh, requireSession } from '../../../server/auth.js'
import { cancelInvite, endSessions, invitePerson, listPeople, removePerson } from '../../../server/people.js'
import { myNotices, setNotice } from '../../../server/notice-prefs.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const [p, notices] = await Promise.all([listPeople(env, session), myNotices(env.ONBOARDING_DB, session.customer.id, session.email).catch(() => null)])
  return json(200, { ...p, notices })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'accountWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = (await request.json().catch(() => null)) || {}
  const done = (r) => (r.ok ? json(200, r) : json(r.status || 400, { error: r.error }))
  try {
    if (b.action === 'end_sessions') return done(await endSessions(env, session, { all: b.all === true }))
    if (b.action === 'notice') return (await setNotice(env.ONBOARDING_DB, session.customer.id, session.email, b.kind, b.on)) ? json(200, { ok: true }) : json(400, { error: 'invalid_request' })
    if (b.action === 'leave') return b.confirm === true ? done(await removePerson(env, session, session.email)) : json(400, { error: 'confirmation_required' })
    if (!['invite', 'cancel_invite', 'remove'].includes(b.action)) return json(400, { error: 'invalid_request' })
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    if (b.action === 'cancel_invite') return done(await cancelInvite(env, session, b.id))
    const stale = needsFresh(session)
    if (stale) return stale
    if (b.action === 'invite') return done(await invitePerson(env, session, b.email))
    return b.confirm === true ? done(await removePerson(env, session, b.email)) : json(400, { error: 'confirmation_required' })
  } catch (err) {
    console.error('people action failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
