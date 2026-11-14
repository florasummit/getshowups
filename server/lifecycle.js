// Customer lifecycle: one place that says where a business stands (billing, hosting, ads hold, recovery, deletion).
// Cancellation without deletion (owner decision 2026-11-14): a billed business whose subscription ended stays fully
// recoverable for 90 days from the end of its paid period; reactivating restores everything (nothing is removed in
// that time). Day 90 is NOT authorization to delete: recovery eligibility simply expires (recorded once). What happens
// to the data afterwards is the retention schedule (docs/DATA_RETENTION.md), applied only when it has been separately
// approved and disclosed: RETENTION_SCHEDULE_ENABLED='true' (and the deletion workflow enabled). Until then the data is
// kept and the founder sees "recovery period over" as a decision to make. Never pilots (PoolThru) or test businesses.
import { getSubscription } from './stripe.js'
import { hostingStatus } from './website.js'
import { adsHold } from './ads/holds.js'
import { deletionEnabled, deletionStatus, requestDeletion } from './deletion.js'
import { recordEvent } from './auditlog.js'
import { testStatus } from './testbusiness.js'

export const RECOVERY_MS = 90 * 24 * 60 * 60 * 1000
// The retention schedule after recovery ends: separately approved from deletion itself.
export const retentionScheduleEnabled = (env) => env.RETENTION_SCHEDULE_ENABLED === 'true' && deletionEnabled(env)

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
  return { endedAt: ended, until, daysLeft: Math.max(0, Math.ceil((until - now) / 86400000)), expired: now >= until, retentionScheduled: retentionScheduleEnabled(env) }
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

// Cron: recovery periods that ended. Always: record the expiry once (a standard event the founder sees).
// Only with the separately approved retention schedule: hand the account to the deletion workflow.
export async function processRecoveryExpiries(env, { now = Date.now(), limit = 5 } = {}) {
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT s.customer FROM subscriptions s
        WHERE s.status = 'canceled' AND coalesce(s.current_period_end, 0) <= ?1
          AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = s.customer)
          AND (?2 = 1 OR NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.customer = s.customer AND a.action = 'lifecycle.recovery_expired'))
        ORDER BY s.current_period_end
        LIMIT 25`, // per cron run: measured ~5 queries each; keeps the run under D1's per-request query limit
    )
    .bind(now - RECOVERY_MS, retentionScheduleEnabled(env) ? 1 : 0)
    .all()
    .catch((err) => (err?.message?.includes('no such table') ? { results: [] } : Promise.reject(err)))
  const scheduled = retentionScheduleEnabled(env)
  let expired = 0
  let started = 0
  for (const { customer } of results) {
    const r = await recoveryFor(env, customer, now)
    if (!r?.expired) continue
    const id = `recovery:${customer}:${r.until}`
    const seen = await db.prepare('SELECT 1 AS x FROM audit_log WHERE correlation_id = ?1 LIMIT 1').bind(id).first().catch(() => null)
    if (!seen) {
      await recordEvent(db, { type: 'lifecycle.recovery_expired', actor: 'system:lifecycle', customer, capability: 'billing.lifecycle', resource: { type: 'customer', id: customer }, outcome: 'info', correlationId: id, details: { endedAt: r.endedAt, until: r.until, retentionScheduled: scheduled }, at: now })
      expired++
    }
    if (!scheduled || started >= limit) continue
    if ((await testStatus(env, customer)).test) continue // test businesses are never removed by the schedule
    const d = await requestDeletion(env, customer, { type: 'system', id: 'system:retention_schedule' }, now)
    if (d.ok) started++
  }
  return { expired, retentionSchedule: scheduled, started }
}
