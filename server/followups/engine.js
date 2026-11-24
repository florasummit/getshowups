// The follow-up engine: lead received → consent checked → immediate response → conversation → booking → follow-ups stop.
// Leads stay in `leads`, scheduled automatic messages in `messages` (server/messages.js), opt-outs in message_optouts,
// SMS consent in sms_consents, who's in charge in conversation_control. This module adds the conversation itself
// (lead_threads + thread_messages, migration 0024) and executes decisions; assistant.js only decides.
//
// Safety, in one place (sendQueued): a message leaves only if the platform switch is on, the business may text
// (smsReadiness: provider + own sender + APPROVED registration), the person consented (texts) and hasn't opted out or
// bounced, the launch gate allows the recipient (SMS_LIVE / MESSAGES_LIVE / test business), automation isn't paused or
// taken over (for automatic messages), it isn't quiet hours (automatic, not a direct answer), and the business and
// lead are under their limits. Each message is claimed atomically, sent at most once (an unknown outcome is never
// retried), and recorded with the provider's id.
import { customerFromRow } from '../auth.js'
import { getCustomer } from '../customers.js'
import { getProfile } from '../onboarding.js'
import { policiesOrEmpty } from '../policies.js'
import { approvedClaimsFor } from '../landing.js'
import { emailConfigured, recipientAllowed } from '../email.js'
import { isOptedOut, recordOptOut, addressHash } from '../optouts.js'
import { isSuppressed } from '../email-feedback.js'
import { toE164 } from '../sms.js'
import { randomToken } from '../google-oauth.js'
import { sandboxed, testStatus } from '../testbusiness.js'
import { resumeUrl, confirmUrl, linkToken, verifyLinkToken } from '../links.js'
import { acquireControl, currentController, releaseControl } from '../conversations/control.js'
import { internalEmails, isTestLead } from '../testdata.js'
import { recordEvent } from '../auditlog.js'
import { hit } from '../ratelimit.js'
import { classify, helpText, startText, humanText, cancelText, fallbackText, aiReply, assistantConfigured } from './assistant.js'
import { send } from './transport.js'
import { followupsReady, getSettings, inQuietHours, killSwitch, followupAiOn, registrationOf, smsLive, smsReadiness } from './settings.js'

const MIN = 60_000
const HOUR = 60 * MIN
export const LIMITS = {
  autoPerLeadPerDay: 3, //      automatic + assistant texts to one person per 24 h (direct fixed replies excluded)
  aiPerLeadPerDay: 6, //        assistant answers to one person per 24 h; then the owner is asked to take over
  textsPerBusinessPerDay: 300, // all texts from one business per 24 h (spike guard)
  aiCostMicrosPerBusinessPerDay: 200_000, // $0.20/day of included-model use per business (≈ hundreds of replies)
  maxAttempts: 3,
  stuckMs: 10 * MIN,
  answerWithinMs: 30 * MIN, //  a reply to an inbound text may go out in quiet hours within this window
}
export const SOURCES = ['website_form', 'booking_page', 'sms', 'chat', 'google_ads', 'meta_lead_form', 'gbp', 'call', 'enterprise_inquiry', 'other']

const newId = () => randomToken(12)
const ok = (v = {}) => ({ ok: true, ...v })
const fail = (httpStatus, error) => ({ ok: false, httpStatus, error })
const safely = async (label, fn) => {
  try {
    return await fn()
  } catch (err) {
    console.error(`followups: ${label} failed:`, err?.name || 'error')
    return null
  }
}

// ---------- source adapter: every lead enters here ----------

// Called by createLead (booking page, website forms) and by future sources. Idempotent (one thread per lead).
export async function ingestLead(env, customerId, leadId, source, now = Date.now()) {
  if (!(await followupsReady(env.ONBOARDING_DB))) return false
  const src = SOURCES.includes(source) ? source : 'other'
  return safely('ingest', async () => {
    const r = await env.ONBOARDING_DB.prepare('INSERT OR IGNORE INTO lead_threads (lead_id, customer, source, stage, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
      .bind(leadId, customerId, src, 'new', now)
      .run()
    return (r?.meta?.changes ?? 0) > 0
  })
}

// Booking made / cancelled: the thread follows (scheduled follow-ups already retire themselves on lead status).
export async function markStage(env, customerId, leadId, stage, now = Date.now()) {
  if (!(await followupsReady(env.ONBOARDING_DB))) return
  await safely('stage', () =>
    env.ONBOARDING_DB.prepare(
      `UPDATE lead_threads SET stage = ?3, next_action = CASE WHEN ?3 IN ('booked', 'opted_out', 'closed') THEN NULL ELSE next_action END, updated_at = ?4
        WHERE lead_id = ?1 AND customer = ?2 AND stage <> 'opted_out'`,
    )
      .bind(leadId, customerId, stage, now)
      .run(),
  )
}

// ---------- business facts (verified records only) ----------

// profile: an already-started getProfile read (the receptionist needs it too), so it is read once per turn.
export async function businessFacts(env, customer, { profile: given } = {}) {
  const db = env.ONBOARDING_DB
  const [profile, pol] = await Promise.all([given || getProfile(db, customer.id).catch(() => null), policiesOrEmpty(db, customer.id)])
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // Hours are stored as 'HH:MM'.
  const hm = (t) => {
    const [h, m] = String(t).split(':').map(Number)
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  }
  const hours = customer.hoursConfirmed && customer.workdays?.length ? `${customer.workdays.map((d) => days[d]).join(', ')} ${hm(customer.dayStart)}–${hm(customer.dayEnd)}` : ''
  return {
    name: customer.name,
    phone: profile?.phone || '',
    services: (profile?.services || []).filter((s) => s && s.name).map((s) => ({ name: String(s.name), price: s.price ? String(s.price) : '' })),
    area: (profile?.cities || []).join(', '),
    hours,
    visit: customer.appointmentMode === 'at_customer',
    beforeVisit: pol.beforeVisit || '',
    cancellation: pol.cancellation || '',
  }
}

// ---------- inbound texts ----------

async function businessForSender(db, { to, messagingService }) {
  const toNum = toE164(to)
  const r = await db
    .prepare('SELECT customer FROM sms_registrations WHERE (sender_phone IS NOT NULL AND sender_phone = ?1) OR (messaging_service IS NOT NULL AND messaging_service = ?2) LIMIT 2')
    .bind(toNum || '', messagingService || '')
    .all()
  // Exactly one business owns a sender (unique index on sender_phone; a shared service would be ambiguous: refused).
  return r.results.length === 1 ? r.results[0].customer : null
}

async function leadForPhone(db, customer, phone) {
  const want = toE164(phone)
  if (!want) return null
  // Most recent lead of THIS business with this number (phones are stored as typed: compared normalized).
  const { results } = await db.prepare('SELECT id, phone, status FROM leads WHERE customer = ?1 ORDER BY created_at DESC LIMIT 500').bind(customer).all()
  return results.find((l) => toE164(l.phone) === want) || null
}

// One inbound text (already signature-checked). Idempotent per provider message id. Returns { ok, duplicate?, action }.
// optOutType: Twilio's OptOutType (STOP | START | HELP) when the provider's keyword handling (default or Advanced
// Opt-Out) already recognised the keyword AND answered it. Twilio's verdict wins over our own keyword list, and we never
// send a second answer to a keyword the provider already answered.
const PROVIDER_KEYWORDS = { STOP: 'stop', START: 'start', HELP: 'help' }
// accountCustomer: the business whose Twilio subaccount signed the webhook (null = the parent account).
export async function handleInbound(env, { from, to, body, providerId, messagingService, optOutType, accountCustomer = null }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await followupsReady(db))) return fail(503, 'not_ready')
  const routed = await businessForSender(db, { to, messagingService })
  // Tenant isolation: a sender is only accepted from its own business's subaccount.
  const customerId = routed && (accountCustomer === null || accountCustomer === routed) ? routed : null
  if (!customerId) {
    await recordEvent(db, { type: 'sms.inbound_unrouted', actor: 'system:twilio', capability: 'followups.sms_inbound', resource: { type: 'sender', id: 'unknown' }, outcome: 'failure', details: { reason: routed ? 'account_mismatch' : 'unknown_sender' }, at: now })
    return ok({ action: 'unrouted' })
  }
  const rl = await hit(env, 'smsInboundPerSender', customerId, now)
  if (rl.limited) {
    await recordEvent(db, { type: 'sms.inbound_spike', actor: 'system:twilio', customer: customerId, capability: 'followups.sms_inbound', resource: { type: 'business', id: customerId }, outcome: 'failure', details: { reason: 'rate_limited' }, at: now })
    return ok({ action: 'rate_limited' })
  }
  const text = String(body || '').slice(0, 1600)
  let lead = await leadForPhone(db, customerId, from)
  if (!lead) {
    // Someone texted the business first: a lead from the "sms" source (they started the conversation; no follow-ups
    // are scheduled for it, the business may answer).
    const id = randomToken(12)
    await db.batch([
      db.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?1, ?2, 'Text message', '', ?3, 'Text message', '', 'new', ?4, ?5, ?5)").bind(id, customerId, toE164(from), randomToken(16), now),
      db.prepare("INSERT OR IGNORE INTO lead_threads (lead_id, customer, source, stage, created_at, updated_at) VALUES (?1, ?2, 'sms', 'new', ?3, ?3)").bind(id, customerId, now),
    ])
    lead = { id, phone: toE164(from), status: 'new' }
  } else await ingestLead(env, customerId, lead.id, 'other', now)
  // Record the message once (unique provider id): a repeated webhook stops here.
  const msgId = newId()
  const ins = await db
    .prepare("INSERT OR IGNORE INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, provider_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'in', 'sms', 'lead', ?4, 'received', ?5, ?6, ?6)")
    .bind(msgId, customerId, lead.id, text, providerId || null, now)
    .run()
  if (!(ins?.meta?.changes > 0)) return ok({ duplicate: true, action: 'duplicate' })

  const providerKind = PROVIDER_KEYWORDS[String(optOutType || '').toUpperCase()] || null
  const c = providerKind ? { kind: providerKind } : classify(text)
  const biz = { name: (await db.prepare('SELECT name FROM customers WHERE id = ?1').bind(customerId).first())?.name || 'The business', phone: (await getProfile(db, customerId).catch(() => null))?.phone || '' }
  const stage = (s) => db.prepare("UPDATE lead_threads SET stage = CASE WHEN stage IN ('booked', 'opted_out') AND ?3 = 'replied' THEN stage ELSE ?3 END, last_inbound_at = ?4, updated_at = ?4 WHERE lead_id = ?1 AND customer = ?2").bind(lead.id, customerId, s, now).run()
  const event = (type, details = {}) => recordEvent(db, { type, actor: 'system:twilio', customer: customerId, capability: 'followups.sms_inbound', resource: { type: 'lead', id: lead.id }, outcome: 'success', details, at: now })

  if (c.kind === 'stop') {
    // Immediate suppression; every queued/scheduled text to this person from this business is retired now.
    await recordOptOut(env, customerId, 'sms', lead.phone, 'carrier_stop', now)
    await db.batch([
      db.prepare("UPDATE lead_threads SET stage = 'opted_out', next_action = NULL, last_inbound_at = ?3, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(lead.id, customerId, now),
      db.prepare("UPDATE thread_messages SET status = 'skipped', error = 'opted_out', updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND status = 'queued' AND channel = 'sms'").bind(lead.id, customerId, now),
      db.prepare("UPDATE messages SET status = 'skipped', error = 'opted_out', updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND status = 'scheduled' AND channel = 'sms'").bind(lead.id, customerId, now),
    ])
    await event('sms.opt_out', { via: 'stop' })
    // The provider (Twilio Advanced Opt-Out) sends the required confirmation; we send nothing more.
    return ok({ action: 'stopped' })
  }
  if (c.kind === 'start') {
    const hash = await addressHash('sms', lead.phone)
    if (hash) await db.prepare("DELETE FROM message_optouts WHERE customer = ?1 AND channel = 'sms' AND address_hash = ?2 AND source = 'carrier_stop'").bind(customerId, hash).run()
    await db.prepare("UPDATE lead_threads SET stage = CASE WHEN stage = 'opted_out' THEN 'replied' ELSE stage END, last_inbound_at = ?3, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(lead.id, customerId, now).run()
    await event('sms.opt_in', { via: 'start' })
    if (!providerKind) await queue(db, { customer: customerId, leadId: lead.id, channel: 'sms', author: 'system', body: startText(biz), id: `start:${msgId}`, direct: true }, now)
    return ok({ action: 'started' })
  }
  await stage('replied')
  if (c.kind === 'help') {
    if (!providerKind) await queue(db, { customer: customerId, leadId: lead.id, channel: 'sms', author: 'system', body: helpText(biz), id: `help:${msgId}`, direct: true }, now)
    return ok({ action: 'help' })
  }
  if (c.kind === 'human') {
    await acquireControl(db, { customer: customerId, conversationId: lead.id, controller: 'human', now })
    await db.prepare("UPDATE lead_threads SET needs_owner = 'human_requested', next_action = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(lead.id, customerId, now).run()
    await queue(db, { customer: customerId, leadId: lead.id, channel: 'sms', author: 'system', body: humanText(biz), id: `human:${msgId}`, direct: true }, now)
    await event('followups.handoff', { reason: 'human_requested' })
    return ok({ action: 'human' })
  }
  if (c.kind === 'cancel_request') {
    // Never cancels by itself: the person gets their own signed cancel link (the same one as in their confirmation).
    const appt = await db.prepare("SELECT id FROM appointments WHERE customer = ?1 AND lead_id = ?2 AND status = 'booked' AND start_at > ?3 ORDER BY start_at LIMIT 1").bind(customerId, lead.id, now).first()
    const link = appt ? `${await confirmUrl(env, appt.id)}&do=cancel` : null
    await db.prepare("UPDATE lead_threads SET needs_owner = CASE WHEN ?3 = 1 THEN needs_owner ELSE 'cancel_request' END, updated_at = ?4 WHERE lead_id = ?1 AND customer = ?2").bind(lead.id, customerId, link ? 1 : 0, now).run()
    await queue(db, { customer: customerId, leadId: lead.id, channel: 'sms', author: 'system', body: cancelText(biz, link), id: `cancel:${msgId}`, direct: true }, now)
    return ok({ action: 'cancel_link' })
  }
  // A question or anything else: answered by the assistant (or the fixed reply) shortly, unless a person is in charge.
  const holder = await currentController(db, customerId, lead.id, now)
  if (holder?.controller === 'human') return ok({ action: 'owner_handles' })
  await db.prepare("UPDATE lead_threads SET next_action = 'reply', next_action_at = ?3, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND stage NOT IN ('opted_out', 'closed')").bind(lead.id, customerId, now).run()
  // Interested but not booked: one nudge a day later (once per lead; retired by a booking, takeover or opt-out).
  if (lead.status === 'new') {
    const consent = await db.prepare('SELECT 1 AS y FROM sms_consents WHERE lead_id = ?1 AND customer = ?2').bind(lead.id, customerId).first()
    const email = (await db.prepare('SELECT email FROM leads WHERE id = ?1 AND customer = ?2').bind(lead.id, customerId).first())?.email
    const rows = [...(email ? ['email'] : []), ...(consent ? ['sms'] : [])].map((ch) => db.prepare("INSERT OR IGNORE INTO messages (id, customer, lead_id, appointment_id, kind, channel, send_at, status, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'interested_followup', ?4, ?5, 'scheduled', ?6, ?6)").bind(`interested_followup:${ch}:${lead.id}`, customerId, lead.id, ch, now + 24 * HOUR, now))
    const auto = await db.prepare('SELECT coalesce((SELECT automations FROM customer_settings WHERE customer = ?1), 1) AS on_').bind(customerId).first()
    if (auto?.on_ && rows.length) await db.batch(rows)
  }
  return ok({ action: 'reply_pending' })
}

// ---------- answering ----------

// Threads waiting for an answer (claimed atomically; a reply id derived from the inbound message, so never twice).
export async function processReplies(env, now = Date.now(), limit = 10) {
  const db = env.ONBOARDING_DB
  const out = { answered: 0, fallback: 0, handed_off: 0 }
  if (!(await followupsReady(db))) return out
  await db.prepare("UPDATE lead_threads SET next_action = 'reply', updated_at = ?1 WHERE next_action = 'replying' AND updated_at < ?2").bind(now, now - LIMITS.stuckMs).run()
  const { results } = await db.prepare("SELECT lead_id, customer FROM lead_threads WHERE next_action = 'reply' AND next_action_at <= ?1 ORDER BY next_action_at LIMIT ?2").bind(now, limit).all()
  for (const t of results) {
    const claimed = await db.prepare("UPDATE lead_threads SET next_action = 'replying', updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND next_action = 'reply' RETURNING lead_id").bind(t.lead_id, t.customer, now).first()
    if (!claimed) continue
    const r = await safely('reply', () => answer(env, t.customer, t.lead_id, now))
    await db.prepare("UPDATE lead_threads SET next_action = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND next_action = 'replying'").bind(t.lead_id, t.customer, now).run()
    if (r) out[r] = (out[r] || 0) + 1
  }
  return out
}

async function answer(env, customerId, leadId, now) {
  const db = env.ONBOARDING_DB
  const customer = customerFromRow(await getCustomer(db, customerId))
  if (!customer) return null
  const { results: hist } = await db.prepare("SELECT id, direction, body FROM thread_messages WHERE customer = ?1 AND lead_id = ?2 AND channel = 'sms' AND status <> 'skipped' ORDER BY created_at DESC, id LIMIT 12").bind(customerId, leadId).all()
  const lastIn = hist.find((m) => m.direction === 'in')
  if (!lastIn) return null
  const history = hist.reverse().map((m) => ({ from: m.direction === 'in' ? 'lead' : 'business', text: m.body }))
  const facts = await businessFacts(env, customer)
  const settings = await getSettings(db, customerId)
  const bookUrl = await resumeUrl(env, customerId, leadId)
  const lead = await db.prepare('SELECT status FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customerId).first()
  const id = `reply:${lastIn.id}`
  const handoff = async (reason) => {
    await db.prepare('UPDATE lead_threads SET needs_owner = ?3, updated_at = ?4 WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId, reason, now).run()
    await recordEvent(db, { type: 'followups.handoff', actor: 'system:assistant', customer: customerId, capability: 'followups.assistant', resource: { type: 'lead', id: leadId }, outcome: 'success', details: { reason }, at: now })
  }
  // Only a lead that can book gets the booking link: not booked ones, and not out-of-area ones still waiting for the
  // owner's coverage decision (server/coverage.js) — a link they can't use would promise service.
  const link = lead?.status === 'new' ? bookUrl : null
  // Automatic messages paused by the owner: nothing automatic goes out; the owner is asked to answer.
  const paused = await db.prepare('SELECT coalesce((SELECT automations FROM customer_settings WHERE customer = ?1), 1) AS on_').bind(customerId).first()
  if (!paused?.on_) {
    await handoff('needs_reply')
    return 'handed_off'
  }
  // The assistant runs only when the platform allows it, the owner wants it, and the business is within its limits.
  const aiAllowed = followupAiOn(env) && assistantConfigured(env) && settings.aiReplies
  if (aiAllowed) {
    const thread = await db.prepare('SELECT ai_replies FROM lead_threads WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId).first()
    const usedToday = await db.prepare("SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS cost FROM thread_messages WHERE customer = ?1 AND author = 'ai' AND created_at > ?2").bind(customerId, now - 24 * HOUR).first()
    const leadToday = await db.prepare("SELECT count(*) AS n FROM thread_messages WHERE customer = ?1 AND lead_id = ?2 AND author = 'ai' AND created_at > ?3").bind(customerId, leadId, now - 24 * HOUR).first()
    if ((leadToday?.n ?? 0) >= LIMITS.aiPerLeadPerDay || (usedToday?.cost ?? 0) >= LIMITS.aiCostMicrosPerBusinessPerDay) {
      await handoff('ai_limit')
    } else {
      const r = await aiReply(env, facts, history, { approvedClaims: await approvedClaimsFor(db, customerId).catch(() => []) })
      if (r.ok) {
        const wantsBooking = ['wants_to_book', 'reschedule', 'question'].includes(r.intent) && link
        const body = `${r.reply}${wantsBooking ? ` Pick a time: ${link}` : ''}`
        await queue(db, { customer: customerId, leadId, channel: 'sms', author: 'ai', body, id, direct: true, costMicros: r.costMicros }, now)
        await db.prepare('UPDATE lead_threads SET ai_replies = ?3, updated_at = ?4 WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId, (thread?.ai_replies ?? 0) + 1, now).run()
        if (r.intent === 'not_interested') await markStage(env, customerId, leadId, 'closed', now)
        return 'answered'
      }
      await recordEvent(db, { type: 'followups.ai_fallback', actor: 'system:assistant', customer: customerId, capability: 'followups.assistant', resource: { type: 'lead', id: leadId }, outcome: r.reason === 'ai_timeout' || r.reason === 'ai_error' ? 'failure' : 'success', details: { reason: r.reason }, at: now })
      await handoff(r.reason === 'ai_unsure' ? 'ai_unsure' : 'ai_fallback')
    }
  } else await handoff('needs_reply')
  // Fixed, safe reply (no model): acknowledges, offers the booking link, and the owner is asked to follow up.
  await queue(db, { customer: customerId, leadId, channel: 'sms', author: 'system', body: fallbackText(facts, link), id, direct: true }, now)
  return 'fallback'
}

// ---------- queue + send ----------

// direct: an answer to something the person just sent (may go out in quiet hours; doesn't count toward automatic caps).
async function queue(db, { customer, leadId, channel, author, body, id, direct = false, costMicros = null, subject = null }, now) {
  const stored = subject ? `${subject}\n\n${body}` : body
  await db
    .prepare("INSERT OR IGNORE INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, error, cost_micros, created_at, updated_at) VALUES (?1, ?2, ?3, 'out', ?4, ?5, ?6, 'queued', ?7, ?8, ?9, ?9)")
    .bind(id || newId(), customer, leadId, channel, author, stored.slice(0, 4000), direct ? 'direct' : null, costMicros, now)
    .run()
}

const SEND_SQL = `
  SELECT tm.*, l.phone AS lead_phone, l.email AS lead_email, l.status AS lead_status, c.name AS biz, c.status AS cstatus, c.timezone,
         coalesce((SELECT cs.automations FROM customer_settings cs WHERE cs.customer = tm.customer), 1) AS automations,
         (SELECT 1 FROM sms_consents sc WHERE sc.lead_id = tm.lead_id AND sc.customer = tm.customer) AS sms_consent,
         (SELECT controller FROM conversation_control cc WHERE cc.customer = tm.customer AND cc.conversation_id = tm.lead_id) AS controller,
         (SELECT stage FROM lead_threads lt WHERE lt.lead_id = tm.lead_id AND lt.customer = tm.customer) AS stage,
         (SELECT source FROM lead_threads lt WHERE lt.lead_id = tm.lead_id AND lt.customer = tm.customer) AS source,
         (SELECT min(u.email) FROM customer_users u WHERE u.customer = tm.customer) AS owner
    FROM thread_messages tm
    JOIN customers c ON c.id = tm.customer
    JOIN leads l ON l.id = tm.lead_id AND l.customer = tm.customer
   WHERE tm.status = 'queued' AND tm.direction = 'out' AND (tm.attempts = 0 OR tm.updated_at <= ?2 - tm.attempts * 120000)
   ORDER BY tm.created_at LIMIT ?1`

// Why a queued message must not go out now: null = send; { skip: code } = never; { later: ts } = wait.
export async function holdReason(env, m, now, cache) {
  const db = env.ONBOARDING_DB
  if (killSwitch(env)) return { skip: 'paused_by_platform' }
  if (m.cstatus !== 'active') return { skip: 'business_inactive' }
  const auto = m.author === 'ai' || m.author === 'auto'
  if (auto && (!m.automations || m.controller === 'human')) return { skip: m.controller === 'human' ? 'human_takeover' : 'automation_paused' }
  if (m.stage === 'opted_out' && m.channel === 'sms' && m.author !== 'owner') return { skip: 'opted_out' }
  if (m.channel === 'sms') {
    if (!cache.reg.has(m.customer)) cache.reg.set(m.customer, smsReadiness(env, await registrationOf(db, m.customer)))
    const ready = cache.reg.get(m.customer)
    if (!ready.ok) return { skip: 'sms_not_ready' }
    // Consent: recorded on a form, or the person texted the business first (they started this conversation).
    const startedByThem = m.source === 'sms' || (await db.prepare("SELECT 1 FROM thread_messages WHERE customer = ?1 AND lead_id = ?2 AND direction = 'in' LIMIT 1").bind(m.customer, m.lead_id).first())
    if (!m.sms_consent && !startedByThem) return { skip: 'no_consent' }
    const opted = await isOptedOut(env, m.customer, 'sms', m.lead_phone)
    if (opted === null) return { skip: 'optout_unknown' }
    if (opted) return { skip: 'opted_out' }
    const day = await db.prepare("SELECT count(*) AS n FROM thread_messages WHERE customer = ?1 AND channel = 'sms' AND direction = 'out' AND status IN ('sent', 'delivered', 'sending') AND updated_at > ?2").bind(m.customer, now - 24 * HOUR).first()
    if ((day?.n ?? 0) >= LIMITS.textsPerBusinessPerDay) return { skip: 'business_daily_limit' }
    if (auto && m.error !== 'direct') {
      const lead = await db.prepare("SELECT count(*) AS n FROM thread_messages WHERE customer = ?1 AND lead_id = ?2 AND channel = 'sms' AND direction = 'out' AND author IN ('ai', 'auto') AND status IN ('sent', 'delivered') AND updated_at > ?3").bind(m.customer, m.lead_id, now - 24 * HOUR).first()
      if ((lead?.n ?? 0) >= LIMITS.autoPerLeadPerDay) return { skip: 'lead_daily_limit' }
    }
    // Quiet hours apply to messages nobody is waiting for; a direct answer may go out within 30 minutes of their text.
    const settings = await getSettings(db, m.customer)
    if (inQuietHours(now, m.timezone, settings) && !(m.error === 'direct' && now - m.created_at < LIMITS.answerWithinMs)) {
      return m.author === 'owner' ? null : { skip: 'quiet_hours' }
    }
  } else if (m.channel === 'email') {
    if (!emailConfigured(env)) return { skip: 'no_provider' }
    if (!m.lead_email) return { skip: 'no_email' }
    if (await isSuppressed(env, m.customer, m.lead_email)) return { skip: 'suppressed' }
  }
  // Stale automatic sales messages never go out after a booking.
  if (m.author === 'auto' && m.lead_status === 'booked') return { skip: 'not_needed' }
  return null
}

export async function sendQueued(env, now = Date.now(), limit = 20) {
  const db = env.ONBOARDING_DB
  const out = { sent: 0, failed: 0, skipped: 0 }
  if (!(await followupsReady(db))) return out
  // A send that died mid-way: outcome unknown, never resent (no duplicate texts).
  await db.prepare("UPDATE thread_messages SET status = 'failed', error = 'interrupted', updated_at = ?1 WHERE status = 'sending' AND updated_at < ?2").bind(now, now - LIMITS.stuckMs).run()
  const { results } = await db.prepare(SEND_SQL).bind(limit, now).all()
  const cache = { reg: new Map(), test: new Map() }
  for (const m of results) {
    const hold = await holdReason(env, m, now, cache)
    if (hold?.skip) {
      await db.prepare("UPDATE thread_messages SET status = 'skipped', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'queued'").bind(m.id, hold.skip, now).run()
      out.skipped++
      continue
    }
    if (!cache.test.has(m.customer)) cache.test.set(m.customer, await testStatus(env, m.customer).catch(() => ({ test: true })))
    const testOnly = sandboxed(cache.test.get(m.customer), m.created_at) || (m.channel === 'sms' && !smsLive(env))
    const to = m.channel === 'sms' ? m.lead_phone : m.lead_email
    if (!recipientAllowed(env, to, { testOnly })) {
      await db.prepare("UPDATE thread_messages SET status = 'skipped', error = 'test_mode', updated_at = ?2 WHERE id = ?1 AND status = 'queued'").bind(m.id, now).run()
      out.skipped++
      continue
    }
    const claimed = await db.prepare("UPDATE thread_messages SET status = 'sending', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status = 'queued' RETURNING attempts").bind(m.id, now).first()
    if (!claimed) continue
    const statusToken = m.channel === 'sms' ? `${m.id}.${await linkToken(env, 'sms_status', m.id)}` : null
    const [subject, ...rest] = m.channel === 'email' && m.body.includes('\n\n') ? m.body.split('\n\n') : [null]
    const r = await send(env, m.channel, {
      id: `thread:${m.id}`,
      to,
      text: m.channel === 'email' ? `${rest.join('\n\n')}\n\n— ${m.biz}` : m.body,
      subject: subject || `Message from ${m.biz}`,
      fromName: `${m.biz} via GetShowUps`,
      replyTo: m.owner,
      testOnly,
      sender: cache.reg.get(m.customer)?.sender,
      statusToken,
    }).catch(() => ({ ok: false, error: 'internal_error', permanent: true }))
    if (r.ok) {
      await db.batch([
        db.prepare("UPDATE thread_messages SET status = 'sent', error = NULL, provider_id = ?2, segments = ?3, cost_micros = coalesce(cost_micros, 0) + coalesce(?4, 0), updated_at = ?5 WHERE id = ?1").bind(m.id, r.providerId, r.segments, r.costMicros, now),
        db.prepare("UPDATE lead_threads SET last_outbound_at = ?3, stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(m.lead_id, m.customer, now),
      ])
      out.sent++
    } else if (r.permanent || claimed.attempts >= LIMITS.maxAttempts) {
      if (m.channel === 'sms' && r.error === 'twilio_21610') await recordOptOut(env, m.customer, 'sms', m.lead_phone, 'carrier_stop', now).catch(() => {})
      await db.prepare("UPDATE thread_messages SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").bind(m.id, r.error, now).run()
      await recordEvent(db, { type: 'followups.send_failed', actor: 'system:followups', customer: m.customer, capability: `followups.${m.channel}`, resource: { type: 'message', id: m.id }, outcome: 'failure', details: { error: r.error }, at: now })
      out.failed++
    } else {
      // Retry later (bounded); a direct answer keeps its marker.
      await db.prepare("UPDATE thread_messages SET status = 'queued', error = CASE WHEN error = 'direct' THEN 'direct' ELSE ?2 END, updated_at = ?3 WHERE id = ?1").bind(m.id, r.error, now).run()
    }
  }
  return out
}

// Delivery updates from the provider (status callback, signed link per message).
const DELIVERY = { delivered: 'delivered', undelivered: 'failed', failed: 'failed', sent: 'sent' }
export async function deliveryUpdate(env, token, params, now = Date.now()) {
  const [id, sig] = String(token || '').split('.')
  if (!id || !sig || !(await verifyLinkToken(env, 'sms_status', id, sig))) return fail(403, 'forbidden')
  const status = DELIVERY[String(params.get('MessageStatus') || '').toLowerCase()]
  if (!status) return ok({ ignored: true })
  const code = params.get('ErrorCode')
  const db = env.ONBOARDING_DB
  // Only forward progress (sent → delivered/failed); repeated callbacks change nothing.
  const r = await db
    .prepare("UPDATE thread_messages SET status = ?2, error = CASE WHEN ?2 = 'failed' THEN ?3 ELSE error END, updated_at = ?4 WHERE id = ?1 AND status IN ('sending', 'sent') AND status <> ?2 RETURNING customer, lead_id")
    .bind(id, status, code && /^\d{3,6}$/.test(code) ? `twilio_${code}` : 'undelivered', now)
    .first()
  if (r && status === 'failed') {
    if (code === '21610') {
      const lead = await db.prepare('SELECT phone FROM leads WHERE id = ?1 AND customer = ?2').bind(r.lead_id, r.customer).first()
      if (lead) await recordOptOut(env, r.customer, 'sms', lead.phone, 'carrier_stop', now)
    }
    await recordEvent(db, { type: 'followups.delivery_failed', actor: 'system:twilio', customer: r.customer, capability: 'followups.sms', resource: { type: 'message', id }, outcome: 'failure', details: { error: code ? `twilio_${code}` : 'undelivered' }, at: now })
  }
  return ok({ updated: Boolean(r) })
}

// Automatic messages sent by server/messages.js also appear in the conversation (same text the person received).
export async function recordAutomatic(env, { id, customer, leadId, channel, body, providerId }, now = Date.now()) {
  if (!(await followupsReady(env.ONBOARDING_DB))) return
  await safely('record automatic', async () => {
    await env.ONBOARDING_DB.batch([
      env.ONBOARDING_DB.prepare("INSERT OR IGNORE INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, provider_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'out', ?4, 'auto', ?5, 'sent', ?6, ?7, ?7)").bind(`msg:${id}`, customer, leadId, channel, String(body).slice(0, 4000), providerId || null, now),
      env.ONBOARDING_DB.prepare("UPDATE lead_threads SET last_outbound_at = ?3, stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(leadId, customer, now),
    ])
  })
}

// ---------- the owner's inbox (session customer only; never a customer parameter) ----------

const STAGE_ORDER = { new: 0, contacted: 1, replied: 2, booked: 3, closed: 4, opted_out: 5 }
export async function listThreads(env, customerId, { now = Date.now(), limit = 100 } = {}) {
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT lt.lead_id, lt.source, lt.stage, lt.needs_owner, lt.last_inbound_at, lt.last_outbound_at, lt.updated_at, lt.created_at,
              l.name, l.need, l.status AS lead_status,
              (SELECT controller FROM conversation_control cc WHERE cc.customer = lt.customer AND cc.conversation_id = lt.lead_id) AS controller,
              (SELECT body FROM thread_messages tm WHERE tm.customer = lt.customer AND tm.lead_id = lt.lead_id AND tm.status <> 'skipped' ORDER BY tm.created_at DESC LIMIT 1) AS last_body,
              (SELECT count(*) FROM thread_messages tm WHERE tm.customer = lt.customer AND tm.lead_id = lt.lead_id AND tm.status = 'failed') AS failures,
              ${isTestLead('l', '?3')} AS test
         FROM lead_threads lt JOIN leads l ON l.id = lt.lead_id AND l.customer = lt.customer
        WHERE lt.customer = ?1
        ORDER BY (lt.needs_owner IS NOT NULL) DESC, coalesce(lt.last_inbound_at, lt.created_at) DESC
        LIMIT ?2`,
    )
    .bind(customerId, limit, internalEmails(env))
    .all()
    .catch(async () => db.prepare('SELECT lt.*, l.name, l.need, l.status AS lead_status, NULL AS controller, NULL AS last_body, 0 AS failures, NULL AS test FROM lead_threads lt JOIN leads l ON l.id = lt.lead_id AND l.customer = lt.customer WHERE lt.customer = ?1 ORDER BY lt.created_at DESC LIMIT ?2').bind(customerId, limit).all())
  const threads = results.map((r) => ({
    id: r.lead_id,
    name: r.name,
    need: r.need,
    source: r.source,
    stage: r.lead_status === 'booked' && STAGE_ORDER[r.stage] < STAGE_ORDER.booked ? 'booked' : r.stage,
    needsOwner: r.needs_owner || null,
    takenOver: r.controller === 'human',
    preview: r.last_body ? String(r.last_body).replace(/\s+/g, ' ').slice(0, 120) : '',
    lastActivity: Math.max(r.last_inbound_at || 0, r.last_outbound_at || 0, r.created_at),
    failures: r.failures || 0,
    test: Boolean(r.test),
  }))
  const real = threads.filter((t) => !t.test)
  const since = now - 30 * 24 * HOUR
  const recent = real.filter((t) => t.lastActivity >= since)
  return {
    threads,
    counts: {
      leads: recent.length,
      contacted: recent.filter((t) => t.stage !== 'new').length,
      replied: recent.filter((t) => ['replied', 'booked'].includes(t.stage) && t.lastActivity).length,
      booked: recent.filter((t) => t.stage === 'booked').length,
      needsYou: real.filter((t) => t.needsOwner).length,
    },
  }
}

export async function threadView(env, customerId, leadId) {
  const db = env.ONBOARDING_DB
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(leadId || '')) return fail(400, 'invalid_request')
  const t = await db.prepare('SELECT lt.*, l.name, l.need, l.email, l.phone, l.status AS lead_status FROM lead_threads lt JOIN leads l ON l.id = lt.lead_id AND l.customer = lt.customer WHERE lt.lead_id = ?1 AND lt.customer = ?2').bind(leadId, customerId).first()
  if (!t) return fail(404, 'not_found')
  const { results } = await db.prepare('SELECT id, direction, channel, author, body, status, error, created_at FROM thread_messages WHERE customer = ?1 AND lead_id = ?2 ORDER BY created_at, id LIMIT 300').bind(customerId, leadId).all()
  const sched = await db.prepare("SELECT kind, channel, send_at, status, error FROM messages WHERE customer = ?1 AND lead_id = ?2 AND status IN ('scheduled', 'skipped', 'failed') ORDER BY send_at LIMIT 30").bind(customerId, leadId).all()
  const holder = await currentController(db, customerId, leadId)
  const consent = await db.prepare('SELECT 1 AS y FROM sms_consents WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId).first()
  const opted = await isOptedOut(env, customerId, 'sms', t.phone)
  return ok({
    thread: {
      id: t.lead_id,
      name: t.name,
      need: t.need,
      email: t.email,
      phone: t.phone,
      source: t.source,
      stage: t.lead_status === 'booked' && !['booked', 'closed', 'opted_out'].includes(t.stage) ? 'booked' : t.stage,
      needsOwner: t.needs_owner || null,
      takenOver: holder?.controller === 'human',
      smsConsent: Boolean(consent) || t.source === 'sms',
      smsOptedOut: opted === true,
    },
    messages: results.map((m) => ({ id: m.id, direction: m.direction, channel: m.channel, author: m.author, body: m.body, status: m.status, error: m.error === 'direct' ? null : m.error, at: m.created_at })),
    upcoming: sched.results.filter((s) => s.status === 'scheduled').map((s) => ({ kind: s.kind, channel: s.channel, at: s.send_at })),
  })
}

// Owner actions. `who`: the signed-in owner's email (audit refs only).
export async function ownerAction(env, customerId, leadId, action, { text = '', channel = null, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const t = await threadView(env, customerId, leadId)
  if (!t.ok) return t
  const th = t.thread
  if (action === 'takeover') {
    await acquireControl(db, { customer: customerId, conversationId: leadId, controller: 'human', now })
    await db.prepare("UPDATE lead_threads SET next_action = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2").bind(leadId, customerId, now).run()
    return ok()
  }
  if (action === 'release') {
    await releaseControl(db, { customer: customerId, conversationId: leadId, controller: 'human', now })
    await db.prepare('UPDATE lead_threads SET needs_owner = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId, now).run()
    return ok()
  }
  if (action === 'done') {
    await db.prepare('UPDATE lead_threads SET needs_owner = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId, now).run()
    return ok()
  }
  if (action === 'close') {
    await markStage(env, customerId, leadId, 'closed', now)
    await db.prepare("UPDATE messages SET status = 'skipped', error = 'closed', updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2 AND status = 'scheduled' AND kind NOT IN ('confirmation', 'reminder_24h', 'reminder_2h')").bind(leadId, customerId, now).run()
    await db.prepare('UPDATE lead_threads SET needs_owner = NULL WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId).run()
    return ok()
  }
  if (action === 'reply') {
    const body = String(text || '').trim()
    if (!body || body.length > 1000) return fail(400, 'invalid_message')
    // Text only where it's allowed (consent, not opted out, business ready); otherwise email; never a silent swap.
    const sms = await smsReadiness(env, await registrationOf(db, customerId))
    const canText = sms.ok && th.smsConsent && !th.smsOptedOut && th.phone
    const want = channel || (canText ? 'sms' : 'email')
    if (want === 'sms' && !canText) return fail(409, th.smsOptedOut ? 'opted_out' : !th.smsConsent ? 'no_consent' : 'sms_not_ready')
    if (want === 'email' && !th.email) return fail(409, 'no_email')
    if (!['sms', 'email'].includes(want)) return fail(400, 'invalid_request')
    // Replying personally takes the conversation over (the assistant stops until handed back).
    await acquireControl(db, { customer: customerId, conversationId: leadId, controller: 'human', now })
    const id = newId()
    await queue(db, { customer: customerId, leadId, channel: want, author: 'owner', body, id, subject: want === 'email' ? `Re: your request` : null }, now)
    await db.prepare('UPDATE lead_threads SET needs_owner = NULL, next_action = NULL, updated_at = ?3 WHERE lead_id = ?1 AND customer = ?2').bind(leadId, customerId, now).run()
    return ok({ id, channel: want })
  }
  return fail(400, 'invalid_request')
}


// Retention: conversation text older than 365 days is removed (the thread and its counts stay). Bounded per run.
export const RETENTION_MS = 365 * 24 * HOUR
export async function purgeOldMessages(env, now = Date.now()) {
  if (!(await followupsReady(env.ONBOARDING_DB))) return { removed: 0 }
  const r = await env.ONBOARDING_DB.prepare("DELETE FROM thread_messages WHERE id IN (SELECT id FROM thread_messages WHERE created_at < ?1 AND status NOT IN ('queued', 'sending') LIMIT 500)").bind(now - RETENTION_MS).run()
  return { removed: r?.meta?.changes ?? 0 }
}
