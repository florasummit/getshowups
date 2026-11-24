// POST /api/cron/run — called every 5 minutes by the scheduler Worker (workers/scheduler).
// Auth: Authorization: Bearer <CRON_SECRET> (32+ chars). Sends due lead messages, queues onboarding
// follow-ups, flushes the account email outbox, and checks customer domains. Returns counts only.
import { purgeClickIds, uploadConversions } from '../../../server/ads/conversions.js'
import { json, missingConfig, sha256Hex, timingSafeEqual } from '../../../server/google-oauth.js'
import { processDueMessages } from '../../../server/messages.js'
import { retryEventCleanups } from '../../../server/booking.js'
import { processReplies, sendQueued, purgeOldMessages } from '../../../server/followups/engine.js'
import { syncPendingRegistrations } from '../../../server/followups/provisioning.js'
import { purgeOldConversations } from '../../../server/receptionist/engine.js'
import { queueFollowUps } from '../../../server/accounts.js'
import { flushOutbox } from '../../../server/email.js'
import { purgeDesignerRaw } from '../../../server/ai-designer.js'
import { queueOwnerNotices } from '../../../server/notify.js'
import { founderAlerts } from '../../../server/alerts.js'
import { syncIncidents } from '../../../server/ops/incidents.js'
import { purgeExpiredSessions } from '../../../server/sessions-purge.js'
import { purgeQa } from '../../../server/ops/qa.js'
import { hitByIp, tooManyJson } from '../../../server/ratelimit.js'
import { syncMetrics, pauseForOptimizer, verifyLaunched } from '../../../server/ads/campaigns.js'
import { enforceAdsHolds } from '../../../server/ads/holds.js'
import { auditCheckpoint } from '../../../server/auditlog.js'
import { processDeletions } from '../../../server/deletion.js'
import { processRecoveryExpiries } from '../../../server/lifecycle.js'
import { dailyReconciliation } from '../../../server/reconcile.js'
import { recordChanges } from '../../../server/ops/changes.js'
import { runOptimizer } from '../../../server/ads/optimizer.js'
import { pollVideos } from '../../../server/ads/creative.js'
import { checkDueDomains } from '../../../server/domains.js'

// Ads work runs after messages and never fails the run (each step reports its own error code).
async function adsStep(label, fn) {
  try {
    return await fn()
  } catch (err) {
    console.error(`cron ads ${label} failed:`, err?.name)
    return { error: 'failed' }
  }
}

export async function onRequestPost({ request, env }) {
  if (missingConfig(env).length || !env.CRON_SECRET || env.CRON_SECRET.length < 32) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'cron', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const header = request.headers.get('Authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!presented || !timingSafeEqual(await sha256Hex(presented), await sha256Hex(env.CRON_SECRET))) return json(401, { error: 'unauthorized' })
  try {
    const messages = await processDueMessages(env)
    // Conversations: answers to texts still waiting (the webhook normally answers at once), then queued messages.
    const followups = {
      replies: await adsStep('followup replies', () => processReplies(env)),
      sent: await adsStep('followup send', () => sendQueued(env)),
      purged: await adsStep('followup retention', () => purgeOldMessages(env)),
      // Texting registrations with Twilio: read what Twilio reports (hourly per business, read-only).
      registrations: await adsStep('texting registrations', () => syncPendingRegistrations(env)),
      receptionistPurged: await adsStep('receptionist retention', () => purgeOldConversations(env)),
      // Calendar events left behind by a failed booking whose cleanup failed (open calendar.google failures).
      eventCleanups: await adsStep('event cleanups', () => retryEventCleanups(env)),
    }
    const onboardingQueued = await queueFollowUps(env)
    // New bookings / unbooked leads → the business's members (queued before the flush so they go out this run).
    const ownerNotices = await adsStep('owner notices', () => queueOwnerNotices(env))
    // Founder alerts (FOUNDER_ALERTS_ENABLED, off by default): queued before the flush so they go out this run.
    const alerts = await adsStep('founder alerts', () => founderAlerts(env))
    const outbox = await flushOutbox(env)
    const ads = {
      // First: the safety stop. Businesses on hold (failed payment, ended subscription, suspension) get any
      // still-running campaign paused (retries failed webhook-time pauses). Owner-approved; decrease-only.
      holds: await adsStep('holds', () => enforceAdsHolds(env)),
      metrics: await adsStep('metrics', () => syncMetrics(env)),
      verify: await adsStep('verify', () => verifyLaunched(env)),
      // The account's own campaigns (Journey A): read-only copy refreshed about daily per business (migration 0037).
      imports: await adsStep('imports', async () => (await import('../../../server/ads/imports.js')).syncAllImported(env)),
      // Meta long-lived tokens (~60 days) are renewed by re-exchange while still valid; expired → reconnect_required.
      metaTokens: await adsStep('meta tokens', async () => (await import('../../../server/ads/meta.js')).refreshMetaTokens(env)),
      clickIds: await adsStep('click ids', () => purgeClickIds(env)),
      conversions: await adsStep('conversions', async () => uploadConversions(env, await import('../../../server/ads/google.js'))),
      // Google Ads Developer Policies restrict unattended ("headless") changes: unless ADS_AUTOMATION_ENABLED is
      // exactly 'true' (approval), the optimizer only recommends; owners make every change themselves.
      optimizer: await adsStep('optimizer', () => runOptimizer(env, { pause: env.ADS_AUTOMATION_ENABLED === 'true' ? pauseForOptimizer : null })),
      // The account's own campaigns: recommendation-only findings over Google's numbers (never a change by itself).
      recommendImported: await adsStep('recommend imported', async () => (await import('../../../server/ads/recommend.js')).recommendImported(env)),
      videos: await adsStep('videos', () => pollVideos(env)),
    }
    const domains = await adsStep('domains', () => checkDueDomains(env))
    // Retention: private copies of raw AI design answers are removed after 30 days.
    const designerRaw = await adsStep('designer raw', () => purgeDesignerRaw(env.ONBOARDING_DB))
    // Account deletions (only when ACCOUNT_DELETION_ENABLED='true'): retries due steps with backoff.
    // Canceled accounts past their 90-day recovery period enter deletion (only when deletion is enabled).
    const recovery = await adsStep('recovery', () => processRecoveryExpiries(env))
    const deletions = await adsStep('deletions', () => processDeletions(env))
    // Stripe vs our records, once a day (read-only toward Stripe; differences are reported, never auto-fixed).
    const reconcile = await adsStep('reconcile', () => dailyReconciliation(env))
    // Business Review change history: a new release or a changed switch is recorded once.
    const changes = await adsStep('changes', () => recordChanges(env))
    const audit = await adsStep('audit', async () => {
      const r = await auditCheckpoint(env.ONBOARDING_DB)
      return r.skipped ? { skipped: true } : { ok: r.ok === true, checked: r.checked ?? 0 }
    })
    // Incident register (migration 0031; no-op before it): open / update / resolve from the same records. Last, so
    // it can never use up this request's query budget before the delivery, ads safety-stop or billing steps.
    const incidents = await adsStep('incidents', () => syncIncidents(env))
    // QA history retention (migration 0032; no-op before it): automated 90 days, human 365 days.
    const sessions = await adsStep('expired sessions', () => purgeExpiredSessions(env))
    await adsStep('qa retention', () => purgeQa(env.ONBOARDING_DB))
    return json(200, { messages, followups, onboardingQueued, ownerNotices, alerts, incidents, outbox: { sent: outbox.sent, failed: outbox.failed }, ads, domains, designerRaw, recovery, deletions, reconcile, changes, audit, sessions })
  } catch (err) {
    console.error('cron run failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
