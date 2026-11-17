// /api/dashboard/receptionist — the owner's AI receptionist.
//   GET  → { ready, capabilities, settings, warnings, counts, requests[], conversations[] }
//   GET ?id=<conversation> → { conversation: { transcript (what the customer saw/heard), events, outcome, … } }
//   POST { action: 'settings', enabled, mode, greeting, knowledge, transferPhone } → saved settings
//   POST { action: 'resolve', requestId } → callback request / message marked done
// Session business only; POST is same-origin and rate-limited.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { recordEvent } from '../../../../server/auditlog.js'
import { toE164 } from '../../../../server/sms.js'
import { messagesLive } from '../../../../server/email.js'
import { getSettings, modelConfigured, receptionistReady, receptionistRequestsReady, visibleTranscript } from '../../../../server/receptionist/engine.js'
import { knowledgeFor, knowledgeWarnings, LIMITS } from '../../../../server/receptionist/knowledge.js'
import { voiceConfigured } from '../../../../server/receptionist/voice.js'

const MODES = ['ai_first', 'human_first', 'after_hours']
const clean = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max)

// Staff notification for one request, from the owner-notice outbox — never assumed.
function notification(r, outbox) {
  const rows = outbox.filter((o) => o.id.startsWith(`owner_callback:${r.id}:`))
  if (rows.some((o) => o.status === 'sent')) return 'sent'
  if (rows.some((o) => o.status === 'pending')) return 'pending'
  if (rows.length && rows.every((o) => o.status === 'failed')) return 'failed'
  // No outbox row yet: the 5-minute notice scan hasn't run (recorded), or it found nobody it may email (not_sent).
  return r.held ? 'not_sent' : 'recorded'
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const customer = session.customer
  if (!(await receptionistReady(db))) return json(200, { ready: false })
  const withRequests = await receptionistRequestsReady(db)
  const id = new URL(request.url).searchParams.get('id')
  if (id) {
    const c = await db.prepare('SELECT * FROM receptionist_conversations WHERE id = ?1 AND customer = ?2').bind(id, customer.id).first()
    if (!c) return json(404, { error: 'not_found' })
    const { results } = await db.prepare('SELECT kind, ok, detail, at FROM receptionist_events WHERE conversation_id = ?1 AND customer = ?2 ORDER BY id').bind(id, customer.id).all()
    const state = JSON.parse(c.state || '{}')
    const k = state.customer || {}
    const request = withRequests ? await db.prepare("SELECT id, kind, status, urgent FROM receptionist_requests WHERE conversation_id = ?1 AND customer = ?2 ORDER BY status = 'open' DESC LIMIT 1").bind(id, customer.id).first() : null
    return json(200, {
      conversation: {
        id: c.id,
        channel: c.channel,
        status: c.status,
        outcome: c.outcome,
        summary: c.summary,
        customerName: k.name || null,
        // What the receptionist collected (the owner's own customer's details; never logged).
        collected: { name: k.name || null, phone: k.phone || null, email: k.email || null, zip: k.zip || null, address: k.street ? `${k.street}, ${k.city || ''} ${String(k.state || '').toUpperCase()} ${k.zip || ''}`.replace(/\s+/g, ' ').trim() : null, need: k.need || null },
        bookedAt: state.booked?.start ? new Date(state.booked.start).toISOString() : null,
        request: request ? { id: request.id, kind: request.kind, open: request.status === 'open', urgent: Boolean(request.urgent) } : null,
        ended: Boolean(state.endedAt),
        appointmentId: c.appointment_id,
        turns: c.turns,
        costMicros: c.cost_micros,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        transcript: visibleTranscript(JSON.parse(c.transcript || '[]'), state),
        events: results.map((e) => ({ kind: e.kind, ok: Boolean(e.ok), detail: e.detail, at: e.at })),
      },
    })
  }
  const settings = await getSettings(db, customer.id)
  const k = await knowledgeFor(env, customer, settings)
  const { results: convs } = await db
    .prepare('SELECT id, channel, status, outcome, summary, state, turns, created_at, updated_at FROM receptionist_conversations WHERE customer = ?1 AND turns > 0 ORDER BY updated_at DESC LIMIT 50')
    .bind(customer.id)
    .all()
  const requests = withRequests
    ? (await db.prepare("SELECT * FROM receptionist_requests WHERE customer = ?1 ORDER BY status = 'open' DESC, created_at DESC LIMIT 50").bind(customer.id).all()).results
    : []
  const outbox = requests.length ? (await db.prepare("SELECT id, status FROM email_outbox WHERE customer = ?1 AND template = 'owner_callback'").bind(customer.id).all()).results : []
  const counts = await db
    .prepare("SELECT sum(status = 'booked') AS booked, count(*) AS total FROM receptionist_conversations WHERE customer = ?1 AND turns > 0")
    .bind(customer.id)
    .first()
  return json(200, {
    ready: true,
    capabilities: {
      model: modelConfigured(env), // the AI can answer at all
      chat: modelConfigured(env),
      voice: modelConfigured(env) && voiceConfigured(env), // browser microphone calls
      callbacks: withRequests, // callback requests and messages are recorded
      staffEmail: messagesLive(env) ? 'live' : 'test_mode', // owner emails about callbacks leave test mode only with MESSAGES_LIVE
      phoneLine: false, // no phone number is connected to GetShowUps: no phone routing, no live transfer
    },
    settings,
    warnings: knowledgeWarnings(k),
    chatUrl: `/chat/${customer.id}`,
    counts: { booked: Number(counts?.booked) || 0, needsAttention: requests.filter((r) => r.status === 'open').length, total: Number(counts?.total) || 0 },
    requests: requests.map((r) => ({ id: r.id, kind: r.kind, name: r.name, phone: r.phone, email: r.email, note: r.note, urgent: Boolean(r.urgent), status: r.status, notification: notification(r, outbox), conversationId: r.conversation_id, createdAt: r.created_at })),
    conversations: convs.map((r) => {
      const st = JSON.parse(r.state || '{}')
      return { id: r.id, channel: r.channel, status: r.status, outcome: r.outcome, summary: r.summary, customerName: st.customer?.name || null, need: st.customer?.need || null, bookedAt: st.booked?.start ? new Date(st.booked.start).toISOString() : null, ended: Boolean(st.endedAt), turns: r.turns, createdAt: r.created_at, updatedAt: r.updated_at }
    }),
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
  const now = Date.now()
  if (b?.action === 'resolve') {
    if (!(await receptionistRequestsReady(db)) || typeof b.requestId !== 'string') return json(400, { error: 'invalid_request' })
    const r = await db.prepare("UPDATE receptionist_requests SET status = 'resolved', resolved_at = ?3, updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND status = 'open'").bind(b.requestId, session.customer.id, now).run()
    if (!(r?.meta?.changes > 0)) return json(404, { error: 'not_found' })
    await recordEvent(db, { type: 'receptionist.request_resolved', actorType: 'owner', actor: session.email, customer: session.customer.id, capability: 'receptionist', resource: { type: 'receptionist_request', id: b.requestId }, outcome: 'success' }).catch(() => {})
    return json(200, { ok: true })
  }
  if (b?.action !== 'settings') return json(400, { error: 'invalid_request' })
  const mode = MODES.includes(b.mode) ? b.mode : null
  const phone = b.transferPhone ? toE164(b.transferPhone) : ''
  if (!mode) return json(400, { error: 'invalid_mode', fields: ['mode'] })
  if (b.transferPhone && !phone) return json(400, { error: 'invalid_phone', fields: ['transferPhone'] })
  if (String(b.greeting || '').length > LIMITS.greeting || String(b.knowledge || '').length > LIMITS.knowledge) return json(400, { error: 'too_long', fields: ['greeting', 'knowledge'] })
  await db
    .prepare(
      `INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(customer) DO UPDATE SET enabled = ?2, mode = ?3, greeting = ?4, knowledge = ?5, transfer_phone = ?6, updated_at = ?7`,
    )
    .bind(session.customer.id, b.enabled === true ? 1 : 0, mode, clean(b.greeting, LIMITS.greeting) || null, clean(b.knowledge, LIMITS.knowledge) || null, phone || null, now)
    .run()
  await recordEvent(db, { type: 'receptionist.settings', actorType: 'owner', actor: session.email, customer: session.customer.id, capability: 'receptionist', resource: { type: 'receptionist', id: session.customer.id }, outcome: 'success', details: { enabled: b.enabled === true, mode } }).catch(() => {})
  const settings = await getSettings(db, session.customer.id)
  return json(200, { settings, warnings: knowledgeWarnings(await knowledgeFor(env, session.customer, settings)) })
}
