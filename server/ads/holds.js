// Ads holds: the safety stop that pauses a business's running campaigns when it must not advertise.
// Owner decision (2026-11-14): pause immediately on the first failed payment, when the subscription ends,
// when a platform admin suspends the business, and (later) when the account is deleted. Pausing only
// reduces spend; nothing is ever resumed automatically: after the cause is fixed the owner presses Start.
//
// Holds are derived from existing records (no state of their own), so they lift by themselves when the
// cause is fixed, and a missed trigger is caught by the cron sweep (enforceAdsHolds).
//
// Billing holds apply only to billed businesses (a self-serve signup or a Stripe subscription) and only
// while billing is configured. Never-billed pilots (PoolThru) are never paused for billing.
import { stripeConfigured } from '../stripe.js'
import { adapter, logAction, verifyAndRecord } from './campaigns.js'

export const HOLD_REASONS = {
  suspended: 'GetShowUps paused this business',
  payment_failed: 'a subscription payment failed',
  subscription_ended: 'the GetShowUps subscription ended',
  account_deleted: 'the account is being deleted',
}

const PAUSED = { google: 'PAUSED', meta: 'PAUSED' }

async function lastEventAt(db, customerId, types) {
  const row = await db
    .prepare(`SELECT max(at) AS at FROM events WHERE customer = ?1 AND type IN (${types.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(customerId, ...types)
    .first()
  return row?.at ?? 0
}

// Returns { reason, since } or null. Fails closed: if the records can't be read, the caller gets an error.
export async function adsHold(env, customerId) {
  const db = env.ONBOARDING_DB
  const biz = await db.prepare('SELECT status FROM customers WHERE id = ?1').bind(customerId).first()
  if (!biz) return { reason: 'account_deleted' }
  const deleting = await db
    .prepare('SELECT 1 AS x FROM account_deletions WHERE customer = ?1')
    .bind(customerId)
    .first()
    .catch((err) => (err?.message?.includes('no such table') ? null : Promise.reject(err)))
  if (deleting) return { reason: 'account_deleted' }
  if (biz.status === 'suspended') return { reason: 'suspended' }
  if (!stripeConfigured(env)) return null
  const [sub, signup] = await Promise.all([
    db.prepare('SELECT status, stripe_subscription_id, last_event_at FROM subscriptions WHERE customer = ?1').bind(customerId).first(),
    db.prepare('SELECT 1 AS x FROM self_signups WHERE customer = ?1').bind(customerId).first(),
  ])
  const billed = Boolean(signup) || Boolean(sub?.stripe_subscription_id)
  if (!billed) return null
  if (!sub || sub.status === 'canceled') return { reason: 'subscription_ended' }
  if (sub.status === 'past_due') return { reason: 'payment_failed' }
  // The failed-payment event can arrive before Stripe's subscription update: a failure newer than the last
  // successful payment and the last time the subscription was seen in good standing is a hold already.
  const failedAt = await lastEventAt(db, customerId, ['payment_failed'])
  if (failedAt) {
    const paidAt = await lastEventAt(db, customerId, ['revenue', 'payment_succeeded'])
    const goodSince = ['active', 'trialing'].includes(sub.status) ? sub.last_event_at || 0 : 0
    if (failedAt > Math.max(paidAt, goodSince)) return { reason: 'payment_failed' }
  }
  if (sub.status === 'incomplete' && sub.stripe_subscription_id) return { reason: 'payment_failed' }
  return null
}

// Pauses every running campaign of one business on its platform, then reads each Google campaign back to
// confirm it is paused. Failures are recorded and retried by the cron sweep. Never resumes anything.
export async function enforceAdsHold(env, customerId, { actor = 'system:hold', hold = undefined, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const h = hold === undefined ? await adsHold(env, customerId) : hold
  if (!h) return { hold: null, paused: 0, verified: 0, failed: 0 }
  const why = `Paused automatically: ${HOLD_REASONS[h.reason] || 'ads are on hold'}. It stays paused until you start it again.`
  const { results } = await db
    .prepare("SELECT * FROM ad_campaigns WHERE customer = ?1 AND status = 'active' AND (platform_campaign_id IS NOT NULL OR platform_ids LIKE '%campaignId%')")
    .bind(customerId)
    .all()
  let paused = 0
  let verified = 0
  let failed = 0
  for (const row of results) {
    const a = await adapter(row.platform)
    const r = a ? await a.setStatus(env, customerId, row, PAUSED[row.platform]).catch(() => ({ ok: false, error: 'transient' })) : { ok: false, error: 'platform_unavailable' }
    if (!r.ok) {
      failed++
      await logAction(db, { customer: customerId, campaignId: row.id, actor, kind: 'pause', status: 'failed', reason: `Couldn't pause on ${row.platform === 'google' ? 'Google' : 'Meta'} (${r.error}); retrying every few minutes`, details: { hold: h.reason } }, now)
      continue
    }
    await db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = ?3 WHERE id = ?1 AND customer = ?2").bind(row.id, customerId, now).run()
    await logAction(db, { customer: customerId, campaignId: row.id, actor, kind: 'pause', reason: why, details: { hold: h.reason } }, now)
    paused++
    if (row.platform === 'google') {
      // Read back: Google's state wins (verifyAndRecord reconciles). If Google still shows it running, the row
      // goes back to 'active' and the next sweep pauses it again.
      const v = await verifyAndRecord(env, { ...row, status: 'paused' }, now).catch(() => ({ ok: false }))
      if (v.ok && v.google?.status === 'PAUSED') verified++
    }
  }
  return { hold: h.reason, paused, verified, failed }
}

// Cron safety net: every business that still has a running campaign is re-checked; held ones are paused.
export async function enforceAdsHolds(env, { now = Date.now(), limit = 25 } = {}) {
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare("SELECT DISTINCT customer FROM ad_campaigns WHERE status = 'active' LIMIT ?1").bind(limit).all()
  const out = { checked: 0, held: 0, paused: 0, failed: 0 }
  for (const { customer } of results) {
    out.checked++
    const r = await enforceAdsHold(env, customer, { now })
    if (r.hold) out.held++
    out.paused += r.paused
    out.failed += r.failed
  }
  return out
}
