// Account invitations (admin invite and admin-assisted setup) and onboarding follow-ups.
// All onboarding paths share one model: customers + customer_users. An invitation binds one email
// to one business; only that Google-verified email can accept it, and only once, before expiry.
import { randomToken, sha256Hex, timingSafeEqual } from './google-oauth.js'
import { siteOrigin } from './auth.js'
import { enqueue } from './email.js'
import { track } from './events.js'
import { progress } from './customers.js'
import { customerFromRow } from './auth.js'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const inviteUrl = (env, token) => `${siteOrigin(env)}/dashboard?invite=${token}`

function inviteEmail(env, { token, businessName }) {
  return {
    subject: `Set up ${businessName} on GetShowUps`,
    body: `You've been invited to set up ${businessName} on GetShowUps.\n\nOpen this link and sign in with this email address's Google account:\n${inviteUrl(env, token)}\n\nThe link expires in 7 days.`,
  }
}

// Creates (or replaces) the active invitation for email → customer and queues the email.
export async function issueInvite(env, { email, customer, businessName, actor }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const token = randomToken(32)
  const id = randomToken(12)
  await db.batch([
    db
      .prepare('UPDATE account_invites SET revoked_at = ?3 WHERE email = ?1 AND customer = ?2 AND accepted_at IS NULL AND revoked_at IS NULL')
      .bind(email, customer, now),
    db
      .prepare(
        'INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at, sent_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)',
      )
      .bind(id, await sha256Hex(token), email, customer, actor, now, now + INVITE_TTL_MS),
  ])
  const message = inviteEmail(env, { token, businessName })
  await enqueue(env, { id: `invite:${id}`, to: email, customer, template: 'invite', ...message }, now)
  await track(env, 'invite_created', { id: `invite_created:${id}`, customer, at: now })
  return { id, url: inviteUrl(env, token), expiresAt: now + INVITE_TTL_MS }
}

async function findActive(db, token, now) {
  if (!TOKEN_RE.test(String(token))) return null
  const row = await db
    .prepare(
      `SELECT i.*, c.name AS business_name FROM account_invites i JOIN customers c ON c.id = i.customer
        WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2`,
    )
    .bind(await sha256Hex(token), now)
    .first()
  return row && timingSafeEqual(row.token_hash, await sha256Hex(token)) ? row : null
}

const maskEmail = (e) => e.replace(/^(.)[^@]*(@.*)$/, (_, a, b) => `${a}•••${b}`)

// Public preview for the sign-in screen: business name and a masked email only.
export async function peekAccountInvite(env, token, now = Date.now()) {
  const row = await findActive(env.ONBOARDING_DB, token, now)
  return row ? { businessName: row.business_name, email: maskEmail(row.email) } : null
}

// Accepts an invitation for the signed-in email. Returns { ok } or { ok:false, error }.
export async function acceptInvite(env, { token, email, hasBusiness }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await findActive(db, token, now)
  if (!row) return { ok: false, error: 'invite_invalid' }
  if (row.email !== email) return { ok: false, error: 'wrong_account', expected: maskEmail(row.email) }
  if (hasBusiness) return { ok: false, error: 'already_in_business' }
  try {
    await db.batch([
      db.prepare('UPDATE account_invites SET accepted_at = ?2 WHERE id = ?1 AND accepted_at IS NULL').bind(row.id, now),
      db.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?1, ?2, ?3)').bind(email, row.customer, now),
    ])
  } catch (err) {
    if (/UNIQUE|PRIMARY/i.test(String(err?.message))) return { ok: false, error: 'already_in_business' }
    throw err
  }
  await track(env, 'invite_accepted', { id: `invite_accepted:${row.id}`, customer: row.customer, at: now })
  return { ok: true, customer: row.customer }
}

export async function resendInvite(env, { id, actor }, now = Date.now()) {
  const row = await env.ONBOARDING_DB.prepare(
    'SELECT i.email, i.customer, c.name FROM account_invites i JOIN customers c ON c.id = i.customer WHERE i.id = ?1 AND i.accepted_at IS NULL',
  )
    .bind(id)
    .first()
  if (!row) return null
  return issueInvite(env, { email: row.email, customer: row.customer, businessName: row.name, actor }, now)
}

export async function revokeInvite(db, id, now = Date.now()) {
  const row = await db
    .prepare('UPDATE account_invites SET revoked_at = ?2 WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING customer')
    .bind(id, now)
    .first()
  return row?.customer ?? null
}

// Onboarding follow-ups (idempotent, dedupe ids): setup unfinished 24 h after signup, invitation not
// accepted after 3 days. Queued in the outbox; delivered only if an email provider is configured.
export async function queueFollowUps(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  let queued = 0
  const { results: stalled } = await db
    .prepare(
      `SELECT c.*, (SELECT min(email) FROM customer_users u WHERE u.customer = c.id) AS owner
         FROM customers c WHERE c.status = 'active' AND c.created_at < ?1 AND c.created_at > ?2`,
    )
    .bind(now - DAY, now - 30 * DAY)
    .all()
  for (const row of stalled) {
    if (!row.owner) continue
    if ((await progress(env, customerFromRow(row))).complete) continue
    const ok = await enqueue(env, {
      id: `followup:setup:${row.id}`,
      to: row.owner,
      customer: row.id,
      template: 'setup_reminder',
      subject: `Finish setting up ${row.name}`,
      body: `Your GetShowUps booking page is almost ready. Pick up where you left off:\n${siteOrigin(env)}/dashboard`,
    }, now)
    if (ok) queued++
  }
  const { results: pending } = await db
    .prepare(
      `SELECT i.id, i.email, i.customer FROM account_invites i
        WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?1 AND i.created_at < ?2`,
    )
    .bind(now, now - 3 * DAY)
    .all()
  for (const inv of pending) {
    const ok = await enqueue(env, {
      id: `followup:invite:${inv.id}`,
      to: inv.email,
      customer: inv.customer,
      template: 'invite_reminder',
      subject: 'Your GetShowUps invitation is waiting',
      body: `Your invitation to GetShowUps expires soon. Open the original invitation email to get started, or ask us for a new link.`,
    }, now)
    if (ok) queued++
  }
  return queued
}
