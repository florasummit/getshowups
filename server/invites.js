// Single-use onboarding invites, stored in D1 (env.ONBOARDING_DB).
// D1 is used instead of KV because KV is eventually consistent and cannot enforce single use:
// each state change below is one atomic UPDATE ... WHERE ... RETURNING.
import { randomToken, sha256Hex, STATE_TTL_SECONDS } from './google-oauth.js'

export const INVITE_TTL_MS = 48 * 60 * 60 * 1000
export const CUSTOMER_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

// Issues a new invite and invalidates any other outstanding invites for the same customer,
// so only one live link per customer exists at a time.
export async function createInvite(db, customer, purpose, now = Date.now()) {
  const token = randomToken(32)
  const tokenHash = await sha256Hex(token)
  const expiresAt = now + INVITE_TTL_MS
  await db.batch([
    db
      .prepare('UPDATE onboarding_invites SET used_at = ?1 WHERE customer = ?2 AND used_at IS NULL')
      .bind(now, customer),
    db
      .prepare(
        'INSERT INTO onboarding_invites (token_hash, customer, purpose, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(tokenHash, customer, purpose, now, expiresAt),
  ])
  return { token, expiresAt }
}

// Binds the invite to one browser session. Fails if the invite is used, expired, or another
// session claimed it less than STATE_TTL ago. A newer claim after that window replaces the old
// session, whose callback will then fail.
export async function claimInvite(db, tokenHash, sessionId, now = Date.now()) {
  return db
    .prepare(
      `UPDATE onboarding_invites
          SET claim_session = ?1, claimed_at = ?2
        WHERE token_hash = ?3
          AND used_at IS NULL
          AND expires_at > ?2
          AND (claimed_at IS NULL OR claimed_at <= ?4)
       RETURNING customer, purpose`,
    )
    .bind(sessionId, now, tokenHash, now - STATE_TTL_SECONDS * 1000)
    .first()
}

// Read-only lookup for the confirmation page. Changes nothing, so link scanners that prefetch
// the GET page cannot claim or burn the invite.
export async function peekInvite(db, tokenHash, now = Date.now()) {
  return db
    .prepare(
      `SELECT customer, purpose FROM onboarding_invites
        WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first()
}

// Undoes consumeInvite after a failure that stored nothing, so the same link can be retried.
// Only reverses the exact consume made by this session (matching used_at), and only if unexpired.
export async function releaseInvite(db, tokenHash, sessionId, usedAt, now = Date.now()) {
  const row = await db
    .prepare(
      `UPDATE onboarding_invites
          SET used_at = NULL, claim_session = NULL, claimed_at = NULL
        WHERE token_hash = ?1
          AND claim_session = ?2
          AND used_at = ?3
          AND expires_at > ?4
       RETURNING customer`,
    )
    .bind(tokenHash, sessionId, usedAt, now)
    .first()
  return Boolean(row)
}

// Marks the invite used. Succeeds exactly once, and only for the session that claimed it.
export async function consumeInvite(db, tokenHash, sessionId, now = Date.now()) {
  return db
    .prepare(
      `UPDATE onboarding_invites
          SET used_at = ?1
        WHERE token_hash = ?2
          AND claim_session = ?3
          AND used_at IS NULL
          AND expires_at > ?1
       RETURNING customer, purpose`,
    )
    .bind(now, tokenHash, sessionId)
    .first()
}
