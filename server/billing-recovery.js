// Payment recovery email (idea adopted from the parallel ops-core patch): when a subscription payment fails, each
// owner of the business gets one email per invoice asking them to update their card. It goes through the email
// outbox, so the launch gate applies (MESSAGES_LIVE unset → test recipients only; test businesses always test-only).
// Ads are paused separately by the ads hold (server/ads/holds.js); this email says so only when ads are running or held.
import { enqueue } from './email.js'
import { recordEvent } from './auditlog.js'
import { siteOrigin } from './auth.js'

export async function queueRecoveryEmail(env, customer, invoiceId, { correlationId = null, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const biz = await db.prepare('SELECT name FROM customers WHERE id = ?1').bind(customer).first()
  if (!biz) return { queued: 0 }
  const { results: owners } = await db.prepare('SELECT email FROM customer_users WHERE customer = ?1 ORDER BY created_at LIMIT 5').bind(customer).all()
  if (!owners.length) return { queued: 0 }
  const ads = await db.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND platform_campaign_id IS NOT NULL AND status IN ('active', 'paused')").bind(customer).first()
  const link = `${siteOrigin(env)}/dashboard/settings`
  const body = [
    'Hi,',
    '',
    `We couldn't collect the latest GetShowUps payment for ${biz.name}. Your website and booking page keep working while you update your card.`,
    ...(ads?.n ? ['', 'Your GetShowUps ad campaigns are paused until the payment goes through. Nothing restarts by itself: start them again from the Ads tab afterwards.'] : []),
    '',
    `Update your payment details: ${link}`,
    '',
    'If you think this is a mistake, just reply to this email.',
    '',
    'GetShowUps',
  ].join('\n')
  let queued = 0
  for (const { email } of owners) {
    const ok = await enqueue(env, { id: `billing-recovery:${customer}:${invoiceId}:${email}`, to: email, customer, template: 'billing_recovery', subject: 'Your GetShowUps payment didn’t go through', body }, now)
    if (ok) queued++
  }
  if (queued) await recordEvent(db, { type: 'billing.recovery_email', actor: 'system:billing', customer, capability: 'billing.stripe', resource: { type: 'invoice', id: invoiceId }, outcome: 'success', correlationId, details: { recipients: queued }, at: now })
  return { queued }
}
