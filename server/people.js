// The people of a business and a person's own account. One person (a Google-verified email) belongs to one business.
// Owner = longest-standing member (server/auth.js ownerEmail). A business always keeps at least one member: the
// conditions are inside the statements, so two simultaneous removals can't empty it.
import { adminEmails } from './platform.js'
import { emailRef, recordEvent } from './auditlog.js'
import { sha256Hex } from './google-oauth.js'
import { EMAIL_RE, ownerEmail } from './auth.js'
import { issueInvite, revokeInvite } from './accounts.js'
import { recipientAllowed } from './email.js'
import { hit } from './ratelimit.js'
import { testStatus } from './testbusiness.js'

export const MAX_MEMBERS = 10
const note = (env, type, customer, actor, details, now) => recordEvent(env.ONBOARDING_DB, { type, actorType: 'owner', actor: `owner:${actor}`, customer, capability: 'account.people', resource: { type: 'customer', id: customer }, outcome: 'success', details, at: now })
const isAdmin = (env, email) => adminEmails(env).includes(String(email).toLowerCase())

export async function listPeople(env, session, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  const [members, invites, sessions] = await Promise.all([
    db.prepare('SELECT email, created_at FROM customer_users WHERE customer = ?1 ORDER BY created_at, rowid').bind(id).all(),
    db.prepare('SELECT id, email, created_at, expires_at FROM account_invites WHERE customer = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 20').bind(id, now).all(),
    db.prepare('SELECT token_hash, created_at, expires_at FROM sessions WHERE email = ?1 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 50').bind(session.email, now).all(),
  ])
  const owner = members.results[0]?.email ?? null
  return {
    you: { email: session.email, owner: owner === session.email, signedInAt: session.signedInAt ?? null },
    members: members.results.map((m) => ({ email: m.email, since: m.created_at, owner: m.email === owner, you: m.email === session.email })),
    invites: invites.results.map((i) => ({ id: i.id, email: i.email, expiresAt: i.expires_at })),
    sessions: sessions.results.map((s) => ({ at: s.created_at, expiresAt: s.expires_at, current: s.token_hash === session.tokenHash })),
  }
}

// The link is returned to the owner (who can pass it on) and emailed only if the launch gate would deliver it now.
export async function invitePerson(env, session, email, now = Date.now()) {
  const e = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(e)) return { ok: false, status: 400, error: 'invalid_email' }
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  const n = await db.prepare('SELECT (SELECT count(*) FROM customer_users WHERE customer = ?1) + (SELECT count(*) FROM account_invites WHERE customer = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS n').bind(id, now).first()
  if (n.n >= MAX_MEMBERS) return { ok: false, status: 409, error: 'too_many' }
  if (await db.prepare('SELECT 1 AS x FROM customer_users WHERE email = ?1 AND customer = ?2').bind(e, id).first()) return { ok: false, status: 409, error: 'already_member' }
  if ((await hit(env, 'accountInvite', id)).limited) return { ok: false, status: 429, error: 'rate_limited' }
  const r = await issueInvite(env, { email: e, customer: id, businessName: session.customer.name, actor: `owner:${await emailRef(session.email)}` }, now)
  const emailed = recipientAllowed(env, e, { testOnly: (await testStatus(env, id)).test })
  await note(env, 'account.member_invited', id, session.email, {}, now)
  return { ok: true, url: r.url, expiresAt: r.expiresAt, emailed }
}

export async function cancelInvite(env, session, inviteId, now = Date.now()) {
  const own = await env.ONBOARDING_DB.prepare('SELECT 1 AS x FROM account_invites WHERE id = ?1 AND customer = ?2').bind(String(inviteId || ''), session.customer.id).first()
  if (!own || !(await revokeInvite(env.ONBOARDING_DB, inviteId, now))) return { ok: false, status: 404, error: 'not_found' }
  // Its email, if it hadn't left yet, isn't sent any more.
  await env.ONBOARDING_DB.prepare("DELETE FROM email_outbox WHERE id = ?1 AND status = 'pending'").bind(`invite:${inviteId}`).run()
  return { ok: true }
}

// Removes one member and signs them out. Never the last one, and only the owner may remove someone else.
export async function removePerson(env, session, email, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  const e = String(email || '').trim().toLowerCase()
  const self = e === session.email
  const owner = await ownerEmail(db, id)
  if (!self && owner !== session.email) return { ok: false, status: 403, error: 'owner_only' }
  const r = await db.prepare('DELETE FROM customer_users WHERE email = ?1 AND customer = ?2 AND (SELECT count(*) FROM customer_users WHERE customer = ?2) > 1').bind(e, id).run()
  if (!r.meta.changes) {
    const there = await db.prepare('SELECT 1 AS x FROM customer_users WHERE email = ?1 AND customer = ?2').bind(e, id).first()
    return there ? { ok: false, status: 409, error: 'last_member' } : { ok: false, status: 404, error: 'not_found' }
  }
  await db.prepare('DELETE FROM sessions WHERE email = ?1').bind(e).run()
  await db.prepare('DELETE FROM owner_notice_off WHERE customer = ?1 AND email = ?2').bind(id, e).run().catch(() => {})
  await note(env, self ? 'account.member_left' : 'account.member_removed', id, session.email, { ownerChanged: e === owner }, now)
  return { ok: true, left: self }
}

// Ends this person's other sessions, or all of them.
export async function endSessions(env, session, { all = false } = {}, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('DELETE FROM sessions WHERE email = ?1 AND (?2 = 1 OR token_hash <> ?3)').bind(session.email, all ? 1 : 0, session.tokenHash).run()
  if (session.customer) await note(env, 'account.sessions_ended', session.customer.id, session.email, { all, ended: r.meta.changes }, now)
  return { ok: true, ended: r.meta.changes }
}

// What deleting the person's own account would do.
export async function personState(env, session) {
  if (isAdmin(env, session.email)) return 'platform_admin'
  if (!session.customer) return 'free'
  const n = await env.ONBOARDING_DB.prepare('SELECT count(*) AS n FROM customer_users WHERE customer = ?1').bind(session.customer.id).first()
  return n.n > 1 ? 'leaves_business' : 'only_member'
}

// Permanently removes the person: membership, sessions, invitations, queued and past account email, notification choices
// and the sign-up marker. Emails in the staff log become one-way refs. Never a platform admin, never a business's last
// member (they close the business first). Audit entries hold no email.
export async function deletePerson(env, session, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const email = session.email
  const st = await personState(env, session)
  if (st === 'platform_admin' || st === 'only_member') return { ok: false, status: 409, error: st }
  const id = session.customer?.id ?? null
  if (id) {
    const r = await removePerson(env, session, email, now)
    if (!r.ok) return r
  }
  const ref = await emailRef(email)
  const { results } = await db.prepare("SELECT id, actor, details FROM admin_audit WHERE instr(lower(actor), ?1) > 0 OR instr(lower(details), ?1) > 0").bind(email).all()
  // Whole addresses only: never part of someone else's.
  const swap = (v) => String(v).replace(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (m.toLowerCase() === email ? ref : m))
  const opt = (q) => db.prepare(q).bind(email).run().catch((err) => (String(err?.message).includes('no such table') ? null : Promise.reject(err)))
  await opt('DELETE FROM owner_notice_off WHERE email = ?1')
  await db.batch([
    ...results.map((a) => db.prepare('UPDATE admin_audit SET actor = ?2, details = ?3 WHERE id = ?1').bind(a.id, swap(a.actor), swap(a.details))),
    db.prepare('DELETE FROM account_invites WHERE email = ?1').bind(email),
    db.prepare('DELETE FROM email_outbox WHERE lower(to_email) = ?1').bind(email),
    db.prepare("DELETE FROM events WHERE id = ?1").bind(`signup:${await sha256Hex(email)}`),
    db.prepare('DELETE FROM customer_users WHERE email = ?1').bind(email),
    db.prepare('DELETE FROM sessions WHERE email = ?1').bind(email), // last: the request that asked is signed out too
  ])
  const left = await db.prepare('SELECT (SELECT count(*) FROM sessions WHERE email = ?1) + (SELECT count(*) FROM customer_users WHERE email = ?1) + (SELECT count(*) FROM account_invites WHERE email = ?1) + (SELECT count(*) FROM email_outbox WHERE lower(to_email) = ?1) AS n').bind(email).first()
  if (left.n) return { ok: false, status: 503, error: 'not_confirmed' }
  await recordEvent(db, { type: 'account.person_deleted', actorType: 'owner', actor: `owner:${email}`, customer: id, capability: 'account.deletion', resource: { type: 'person', id: ref }, outcome: 'success', details: { leftBusiness: Boolean(id) }, at: now })
  return { ok: true }
}
