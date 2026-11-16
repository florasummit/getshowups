// /api/dashboard/followups — the signed-in business's Follow-ups area (session customer only; no customer parameter).
//   GET  → { ready, automations, settings, channels, texting (setup + status), counts, threads }
//   POST { action: 'settings', settings } | { action: 'automations', enabled }   (same-origin)
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { emailConfigured, messagesLive } from '../../../../server/email.js'
import { followupsReady, getSettings, validateSettings, saveSettings, smsReadiness, smsLive, followupAiOn, killSwitch } from '../../../../server/followups/settings.js'
import { getRegistration, registrationView } from '../../../../server/followups/registration.js'
import { listThreads } from '../../../../server/followups/engine.js'
import { assistantConfigured } from '../../../../server/followups/assistant.js'
import { recordEvent } from '../../../../server/auditlog.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  if (!(await followupsReady(db))) return json(200, { ready: false })
  try {
    const reg = await getRegistration(db, id)
    const sms = smsReadiness(env, reg)
    const auto = await db.prepare('SELECT coalesce((SELECT automations FROM customer_settings WHERE customer = ?1), 1) AS on_').bind(id).first()
    const { threads, counts } = await listThreads(env, id)
    return json(200, {
      ready: true,
      automations: Boolean(auto?.on_),
      settings: await getSettings(db, id),
      channels: {
        email: emailConfigured(env) && !killSwitch(env),
        sms: sms.ok,
        smsReasons: sms.reasons,
        // Launch gates: until switched on, messages reach only the platform's test recipients.
        testMode: !messagesLive(env),
        smsTestMode: !smsLive(env),
        assistant: followupAiOn(env) && assistantConfigured(env),
        paused: killSwitch(env),
      },
      texting: registrationView(reg, session.customer.name, session.customer.id),
      counts,
      threads,
    })
  } catch (err) {
    console.error('followups: overview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  if (!(await followupsReady(db))) return json(409, { error: 'not_ready' })
  const rl = await hit(env, 'followupWrite', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (body?.action === 'settings') {
    const [error, s] = validateSettings(body.settings)
    if (error) return json(400, { error })
    await saveSettings(db, id, s)
    await recordEvent(db, { type: 'followups.settings_changed', actorType: 'owner', actor: session.email, customer: id, capability: 'followups.settings', resource: { type: 'business', id }, outcome: 'success', details: { ...s } })
    return json(200, { settings: s })
  }
  if (body?.action === 'automations' && typeof body.enabled === 'boolean') {
    await db.prepare('INSERT INTO customer_settings (customer, automations, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET automations = ?2, updated_at = ?3').bind(id, body.enabled ? 1 : 0, Date.now()).run()
    await recordEvent(db, { type: body.enabled ? 'followups.resumed' : 'followups.paused', actorType: 'owner', actor: session.email, customer: id, capability: 'followups.settings', resource: { type: 'business', id }, outcome: 'success' })
    return json(200, { automations: body.enabled })
  }
  return json(400, { error: 'invalid_request' })
}
