// POST /api/dashboard/automations — turn automatic follow-ups and reminders on or off for the
// signed-in business.   Body: { enabled: true | false }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { track } from '../../../server/events.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return json(400, { error: 'invalid_request' })
  try {
    await env.ONBOARDING_DB.prepare(
      'INSERT INTO customer_settings (customer, automations, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET automations = ?2, updated_at = ?3',
    )
      .bind(session.customer.id, body.enabled ? 1 : 0, Date.now())
      .run()
  } catch (err) {
    console.error('automations save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  await track(env, 'automations_changed', { customer: session.customer.id, props: { enabled: body.enabled } })
  return json(200, { enabled: body.enabled })
}
