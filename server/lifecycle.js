// Customer lifecycle: one place that says where a business stands (billing, hosting, ads hold, recovery, deletion).
// Cancellation without deletion (owner decision 2026-11-14): a billed business whose subscription ended stays fully
// recoverable for 90 days from the end of its paid period; reactivating restores everything (nothing is removed in
// that time). When the 90 days are over, the account goes through the permanent deletion workflow, which runs only
// when ACCOUNT_DELETION_ENABLED is 'true' (approval); until then nothing is deleted and the account just waits.
// Never-billed pilots (PoolThru) and test businesses are never deleted this way.
import { getSubscription } from './stripe.js'
import { hostingStatus } from './website.js'
import { adsHold } from './ads/holds.js'
import { deletionEnabled, deletionStatus, requestDeletion } from './deletion.js'
import { testStatus } from './testbusiness.js'

export const RECOVERY_MS = 90 * 24 * 60 * 60 * 1000

async function billedSignup(db, customerId) {
  return Boolean(await db.prepare('SELECT 1 AS x FROM self_signups WHERE customer = ?1').bind(customerId).first())
}

// When a canceled subscription ended: its paid period end, or the cancellation itself (whichever is later).
async function endedAt(db, customerId, sub) {
  const ev = await db.prepare("SELECT max(at) AS at FROM events WHERE customer = ?1 AND type = 'subscription_canceled'").bind(customerId).first()
  const t = Math.max(sub.currentPeriodEnd || 0, ev?.at || 0)
  return t || null
}

export async function recoveryFor(env, customerId, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const sub = await getSubscription(db, customerId)
  if (sub?.status !== 'canceled') return null
  if (!sub.stripeSubscriptionId && !(await billedSignup(db, customerId))) return null
  const ended = await endedAt(db, customerId, sub)
  if (!ended) return null
  const until = ended + RECOVERY_MS
  return { endedAt: ended, until, daysLeft: Math.max(0, Math.ceil((until - now) / 86400000)), expired: now >= until, deletesAfter: deletionEnabled(env) }
}

export async function lifecycle(env, customerId, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const [sub, hosting, hold, recovery, deletion] = await Promise.all([
    getSubscription(db, customerId),
    hostingStatus(db, customerId, now),
    adsHold(env, customerId).catch(() => null),
    recoveryFor(env, customerId, now),
    deletionStatus(db, customerId),
  ])
  const stage = deletion
    ? deletion.status === 'completed'
      ? 'deleted'
      : 'deleting'
    : recovery
      ? recovery.expired
        ? 'recovery_ended'
        : 'canceled_recoverable'
      : sub?.status === 'past_due'
        ? 'payment_problem'
        : sub?.cancelAtPeriodEnd
          ? 'cancel_scheduled'
          : sub && ['active', 'trialing'].includes(sub.status)
            ? 'subscribed'
            : 'not_billed'
  return {
    stage,
    subscription: sub ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null,
    hosting,
    adsHold: hold?.reason ?? null,
    recovery,
    deletion: deletion ? { status: deletion.status, step: deletion.step } : null,
  }
}

// Cron: accounts whose 90-day recovery period is over enter the deletion workflow (only when deletion is enabled).
export async function processRecoveryExpiries(env, { now = Date.now(), limit = 5 } = {}) {
  if (!deletionEnabled(env)) return { enabled: false }
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT s.customer FROM subscriptions s
        WHERE s.status = 'canceled' AND coalesce(s.current_period_end, 0) <= ?1
          AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = s.customer)
        LIMIT 50`,
    )
    .bind(now - RECOVERY_MS)
    .all()
  let started = 0
  for (const { customer } of results) {
    if (started >= limit) break
    const r = await recoveryFor(env, customer, now)
    if (!r?.expired) continue
    if ((await testStatus(env, customer)).test) continue // test businesses are never deleted automatically
    const d = await requestDeletion(env, customer, { type: 'system', id: 'system:recovery_expired' }, now)
    if (d.ok) started++
  }
  return { enabled: true, started }
}
