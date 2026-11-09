// GET /api/platform/overview — all businesses with onboarding/calendar/booking/billing status and
// attention flags, plus growth metrics. Also queues due onboarding follow-ups and flushes the outbox.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { customerRows, growth } from '../../../server/metrics.js'
import { queueFollowUps } from '../../../server/accounts.js'
import { flushOutbox } from '../../../server/email.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    await queueFollowUps(env)
    await flushOutbox(env)
    const customers = await customerRows(env)
    const metrics = await growth(env, customers)
    const { results: outbox } = await env.ONBOARDING_DB.prepare(
      'SELECT id, to_email, customer, template, subject, status, attempts, error, created_at, sent_at FROM email_outbox ORDER BY created_at DESC LIMIT 50',
    ).all()
    return json(200, { customers, metrics, outbox })
  } catch (err) {
    console.error('platform overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
