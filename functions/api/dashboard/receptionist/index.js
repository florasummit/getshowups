// /api/dashboard/receptionist — the owner's AI receptionist.
//   GET  → { ready, configured, voice, settings, route, conversations[], counts }
//   POST { action: 'settings', enabled, mode, greeting, knowledge, transferPhone } → saved settings
//   GET ?id=<conversation> → { conversation: { transcript (spoken/typed lines only), events, summary, outcome, … } }
// Session business only; POST is same-origin and rate-limited.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { recordEvent } from '../../../../server/auditlog.js'
import { toE164 } from '../../../../server/sms.js'
import { getSettings, modelConfigured, receptionistReady, visibleTranscript } from '../../../../server/receptionist/engine.js'
import { LIMITS } from '../../../../server/receptionist/knowledge.js'
import { describeRoute, routeCall } from '../../../../server/receptionist/routing.js'
import { voiceConfigured } from '../../../../server/receptionist/voice.js'

const MODES = ['ai_first', 'human_first', 'after_hours']
const clean = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max)

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const customer = session.customer
  if (!(await receptionistReady(db))) return json(200, { ready: false })
  const id = new URL(request.url).searchParams.get('id')
  if (id) {
    const c = await db.prepare('SELECT * FROM receptionist_conversations WHERE id = ?1 AND customer = ?2').bind(id, customer.id).first()
    if (!c) return json(404, { error: 'not_found' })
    const { results } = await db.prepare('SELECT kind, ok, detail, at FROM receptionist_events WHERE conversation_id = ?1 AND customer = ?2 ORDER BY id').bind(id, customer.id).all()
    const state = JSON.parse(c.state || '{}')
    return json(200, {
      conversation: {
        id: c.id,
        channel: c.channel,
        status: c.status,
        outcome: c.outcome,
        summary: c.summary,
        handoff: state.handoff || null,
        leadId: c.lead_id,
        appointmentId: c.appointment_id,
        turns: c.turns,
        costMicros: c.cost_micros,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        transcript: visibleTranscript(JSON.parse(c.transcript || '[]')),
        events: results.map((e) => ({ kind: e.kind, ok: Boolean(e.ok), detail: e.detail, at: e.at })),
      },
    })
  }
  const settings = await getSettings(db, customer.id)
  const { results } = await db
    .prepare('SELECT id, channel, status, outcome, summary, turns, created_at, updated_at FROM receptionist_conversations WHERE customer = ?1 ORDER BY updated_at DESC LIMIT 50')
    .bind(customer.id)
    .all()
  const counts = await db
    .prepare("SELECT count(*) AS total, sum(status = 'booked') AS booked, sum(status = 'handoff') AS handoff FROM receptionist_conversations WHERE customer = ?1")
    .bind(customer.id)
    .first()
  const plan = routeCall(settings, customer, Date.now())
  return json(200, {
    ready: true,
    configured: modelConfigured(env),
    voice: voiceConfigured(env),
    settings,
    route: { ...plan, text: describeRoute(plan) },
    chatUrl: `/chat/${customer.id}`,
    counts: { total: Number(counts?.total) || 0, booked: Number(counts?.booked) || 0, handoff: Number(counts?.handoff) || 0 },
    conversations: results.map((r) => ({ id: r.id, channel: r.channel, status: r.status, outcome: r.outcome, summary: r.summary, turns: r.turns, createdAt: r.created_at, updatedAt: r.updated_at })),
  })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const db = env.ONBOARDING_DB
  if (!(await receptionistReady(db))) return json(409, { error: 'not_ready' })
  const rl = await hit(env, 'followupWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => ({}))
  if (b?.action !== 'settings') return json(400, { error: 'invalid_request' })
  const mode = MODES.includes(b.mode) ? b.mode : null
  const phone = b.transferPhone ? toE164(b.transferPhone) : ''
  if (!mode) return json(400, { error: 'invalid_mode', fields: ['mode'] })
  if (b.transferPhone && !phone) return json(400, { error: 'invalid_phone', fields: ['transferPhone'] })
  if (String(b.greeting || '').length > LIMITS.greeting || String(b.knowledge || '').length > LIMITS.knowledge) return json(400, { error: 'too_long', fields: ['greeting', 'knowledge'] })
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(customer) DO UPDATE SET enabled = ?2, mode = ?3, greeting = ?4, knowledge = ?5, transfer_phone = ?6, updated_at = ?7`,
    )
    .bind(session.customer.id, b.enabled === true ? 1 : 0, mode, clean(b.greeting, LIMITS.greeting) || null, clean(b.knowledge, LIMITS.knowledge) || null, phone || null, now)
    .run()
  await recordEvent(db, { type: 'receptionist.settings', actorType: 'owner', actor: session.email, customer: session.customer.id, capability: 'receptionist', resource: { type: 'receptionist', id: session.customer.id }, outcome: 'success', details: { enabled: b.enabled === true, mode } }).catch(() => {})
  return json(200, { settings: await getSettings(db, session.customer.id) })
}
