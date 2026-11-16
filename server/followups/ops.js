// Platform view of follow-ups (counts only: no message text, names, numbers or emails), for /admin.
import { followupsReady, killSwitch, smsLive, followupAiOn } from './settings.js'
import { smsConfigured } from '../sms.js'
import { messagesLive } from '../email.js'
import { registerCapability } from '../ops/registry.js'

const HOUR = 3_600_000
export const SPIKE_PER_HOUR = 100

export async function followupOps(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const switches = { killSwitch: killSwitch(env), smsLive: smsLive(env), messagesLive: messagesLive(env), assistant: followupAiOn(env), twilioConfigured: smsConfigured(env) }
  if (!(await followupsReady(db))) return { ready: false, switches }
  const day = now - 24 * HOUR
  const q = (sql, ...a) => db.prepare(sql).bind(...a)
  const [perBiz, stuck, waiting, webhooks, failures, spikes, regs, scheduled] = await Promise.all([
    q(
      `SELECT tm.customer, c.name,
              sum(CASE WHEN tm.channel = 'sms' AND tm.direction = 'out' AND tm.status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS texts,
              sum(CASE WHEN tm.channel = 'sms' AND tm.direction = 'in' THEN 1 ELSE 0 END) AS inbound,
              sum(CASE WHEN tm.channel = 'email' AND tm.direction = 'out' AND tm.status = 'sent' THEN 1 ELSE 0 END) AS emails,
              sum(CASE WHEN tm.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              sum(CASE WHEN tm.author = 'ai' THEN 1 ELSE 0 END) AS ai,
              coalesce(sum(tm.cost_micros), 0) AS cost_micros
         FROM thread_messages tm JOIN customers c ON c.id = tm.customer
        WHERE tm.created_at > ?1 GROUP BY tm.customer ORDER BY texts DESC LIMIT 100`,
      day,
    ).all(),
    q("SELECT count(*) AS n FROM thread_messages WHERE status = 'sending' AND updated_at < ?1", now - 10 * 60_000).first(),
    q("SELECT count(*) AS n FROM lead_threads WHERE next_action IN ('reply', 'replying') AND next_action_at < ?1", now - 15 * 60_000).first(),
    q("SELECT count(*) AS n FROM audit_log WHERE action IN ('sms.webhook_rejected', 'sms.inbound_unrouted') AND at > ?1", day).first(),
    q("SELECT action, count(*) AS n FROM audit_log WHERE action IN ('followups.send_failed', 'followups.delivery_failed', 'followups.ai_fallback', 'sms.opt_out', 'sms.inbound_spike', 'followups.handoff') AND at > ?1 GROUP BY action", day).all(),
    q("SELECT customer, count(*) AS n FROM thread_messages WHERE direction = 'out' AND created_at > ?1 GROUP BY customer HAVING n > ?2", now - HOUR, SPIKE_PER_HOUR).all(),
    q('SELECT r.customer, c.name, r.status, r.status_at, r.approved_at IS NOT NULL AS owner_approved, (r.messaging_service IS NOT NULL OR r.sender_phone IS NOT NULL) AS has_sender FROM sms_registrations r JOIN customers c ON c.id = r.customer ORDER BY r.updated_at DESC LIMIT 200').all(),
    q("SELECT count(*) AS n, sum(CASE WHEN send_at < ?1 THEN 1 ELSE 0 END) AS overdue FROM messages WHERE status = 'scheduled'", now - 30 * 60_000).first(),
  ])
  const ev = Object.fromEntries(failures.results.map((r) => [r.action, r.n]))
  return {
    ready: true,
    switches,
    last24h: {
      sendFailures: ev['followups.send_failed'] || 0,
      deliveryFailures: ev['followups.delivery_failed'] || 0,
      aiFallbacks: ev['followups.ai_fallback'] || 0,
      optOuts: ev['sms.opt_out'] || 0,
      handoffs: ev['followups.handoff'] || 0,
      inboundSpikes: ev['sms.inbound_spike'] || 0,
      webhookProblems: webhooks?.n ?? 0,
    },
    stuck: { sending: stuck?.n ?? 0, repliesWaiting: waiting?.n ?? 0, scheduledOverdue: scheduled?.overdue ?? 0 },
    spikes: spikes.results.map((r) => ({ customer: r.customer, lastHour: r.n })),
    businesses: perBiz.results.map((r) => ({ customer: r.customer, name: r.name, texts: r.texts, inbound: r.inbound, emails: r.emails, failed: r.failed, ai: r.ai, costMicros: r.cost_micros })),
    registrations: regs.results.map((r) => ({ customer: r.customer, name: r.name, status: r.status, statusAt: r.status_at, ownerApproved: Boolean(r.owner_approved), hasSender: Boolean(r.has_sender) })),
  }
}

// Business Review entries (server/ops/registry.js).
registerCapability({
  id: 'followups.engine',
  name: 'Lead follow-up engine (conversations)',
  journey: 'lead',
  dependsOn: ['platform.database', 'lead.capture'],
  state: (env) => (killSwitch(env) ? { mode: 'disabled', note: 'MESSAGING_KILL_SWITCH is on' } : { mode: 'sandbox', note: 'Built and tested; needs migration 0024' }),
})
registerCapability({
  id: 'followups.sms',
  name: 'Two-way texts (Twilio)',
  journey: 'lead',
  external: 'Twilio',
  dependsOn: ['followups.engine'],
  state: (env) => (!smsConfigured(env) ? { mode: 'missing', note: 'TWILIO_* not configured', approval: 'Twilio account + A2P 10DLC' } : smsLive(env) ? { mode: 'live' } : { mode: 'sandbox', note: 'SMS_LIVE off: test recipients only', approval: 'SMS_LIVE=true' }),
})
registerCapability({
  id: 'followups.assistant',
  name: 'Follow-up assistant (included model)',
  journey: 'lead',
  external: 'Cloudflare Workers AI',
  dependsOn: ['followups.engine'],
  state: (env) => (followupAiOn(env) ? { mode: env.AI?.run ? 'live' : 'missing', note: env.AI?.run ? null : 'AI binding missing' } : { mode: 'disabled', note: 'FOLLOWUP_AI off: fixed safe replies', approval: 'FOLLOWUP_AI=true + AI binding' }),
})
registerCapability({
  id: 'followups.registration',
  name: 'US texting registration (A2P 10DLC) tracking',
  journey: 'lead',
  external: 'Twilio / carriers',
  dependsOn: ['followups.engine'],
  state: () => ({ mode: 'sandbox', note: 'Owner prepares + approves; admin submits and records the provider status' }),
})
