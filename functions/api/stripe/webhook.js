// POST /api/stripe/webhook — Stripe events. Signature verified against the raw body; each event id
// is processed once (stripe_events). On a processing error the receipt is removed and 500 returned
// so Stripe retries.
import { json } from '../../../server/google-oauth.js'
import { handleEvent, stripeConfigured, verifySignature } from '../../../server/stripe.js'

export async function onRequestPost({ request, env }) {
  if (!stripeConfigured(env) || !env.ONBOARDING_DB) return json(503, { error: 'not_configured' })
  const raw = await request.text()
  if (!(await verifySignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json(400, { error: 'invalid_signature' })
  }
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return json(400, { error: 'invalid_payload' })
  }
  if (typeof event?.id !== 'string' || typeof event?.type !== 'string') return json(400, { error: 'invalid_payload' })

  const db = env.ONBOARDING_DB
  const receipt = await db.prepare('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?1, ?2, ?3)').bind(event.id, event.type, Date.now()).run()
  if ((receipt?.meta?.changes ?? receipt?.changes ?? 0) === 0) return json(200, { received: true, duplicate: true })
  try {
    const result = await handleEvent(env, event)
    return json(200, { received: true, handled: result.handled })
  } catch (err) {
    console.error('stripe webhook failed:', event.type, err?.message)
    await db.prepare('DELETE FROM stripe_events WHERE id = ?1').bind(event.id).run().catch(() => {})
    return json(500, { error: 'processing_failed' })
  }
}
