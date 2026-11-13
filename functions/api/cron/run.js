// POST /api/cron/run — called every 5 minutes by the scheduler Worker (workers/scheduler).
// Auth: Authorization: Bearer <CRON_SECRET> (32+ chars). Sends due lead messages, queues onboarding
// follow-ups, flushes the account email outbox, and checks customer domains. Returns counts only.
import { purgeClickIds, uploadConversions } from '../../../server/ads/conversions.js'
import { json, missingConfig, sha256Hex, timingSafeEqual } from '../../../server/google-oauth.js'
import { processDueMessages } from '../../../server/messages.js'
import { queueFollowUps } from '../../../server/accounts.js'
import { flushOutbox } from '../../../server/email.js'
import { hitByIp, tooManyJson } from '../../../server/ratelimit.js'
import { syncMetrics, pauseForOptimizer, verifyLaunched } from '../../../server/ads/campaigns.js'
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
    const onboardingQueued = await queueFollowUps(env)
    const outbox = await flushOutbox(env)
    const ads = {
      metrics: await adsStep('metrics', () => syncMetrics(env)),
      verify: await adsStep('verify', () => verifyLaunched(env)),
      clickIds: await adsStep('click ids', () => purgeClickIds(env)),
      conversions: await adsStep('conversions', async () => uploadConversions(env, await import('../../../server/ads/google.js'))),
      // Google Ads Developer Policies restrict unattended ("headless") changes: unless ADS_AUTOMATION_ENABLED is
      // exactly 'true' (approval), the optimizer only recommends; owners make every change themselves.
      optimizer: await adsStep('optimizer', () => runOptimizer(env, { pause: env.ADS_AUTOMATION_ENABLED === 'true' ? pauseForOptimizer : null })),
      videos: await adsStep('videos', () => pollVideos(env)),
    }
    const domains = await adsStep('domains', () => checkDueDomains(env))
    return json(200, { messages, onboardingQueued, outbox: { sent: outbox.sent, failed: outbox.failed }, ads, domains })
  } catch (err) {
    console.error('cron run failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
