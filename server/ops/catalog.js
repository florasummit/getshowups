// The capabilities GetShowUps has today. Each declares where it sits in the journey, what it depends on, what its
// configuration says (state), how real production activity proves it works (verify: read-only database checks,
// no calls to outside services), what it is needed for (tier: operate | payments | advertising | optional | later,
// the founder's 2026-11-21 operating classification) and the existing screen where it is set up (action). A new feature adds its own registerCapability() call (here or in its module,
// imported below) and appears in Business Review with no UI change.
import { feedbackConfigured } from '../email-feedback.js'
import { registerCapability } from './registry.js'
import { stripeConfigured, stripeLiveEnabled } from '../stripe.js'
import { emailConfigured, messagesLive } from '../email.js'
import { smsConfigured } from '../sms.js'
import { modelConfigured } from '../receptionist/engine.js'
import { voiceBusinesses, voiceConfigured, voiceStatus } from '../receptionist/voice.js'
import { aiConfigured } from '../website-ai.js'
import { studioEnabled, studioPublishAllowed, studioSchemaReady } from '../website-studio.js'
import { providerConfigured } from '../domains.js'
import { adsEnabled } from '../ads/access.js'
import { studioEnabled as teachAiEnabled } from '../intelligence/access.js'
import { liveLaunchEnabled } from '../ads/campaigns.js'
import { metaConfigured } from '../ads/meta.js'
import { conversionsEnabled } from '../ads/conversions.js'
import { deletionEnabled, deletionStatus } from '../deletion.js'
import { retentionScheduleEnabled, lifecycle } from '../lifecycle.js'
import { adsHold, runningOnHold } from '../ads/holds.js'
import { customerRows } from '../metrics.js'
import { alertsEnabled } from '../alerts.js'
import { registerReady } from './incidents.js'
import './../conversations/providers.js' // AI / conversation providers register their own capabilities
import './../followups/ops.js' // follow-up engine, texts, assistant, texting registration

const DAY = 86400000
const ago = (ms, now) => {
  const d = Math.max(0, now - ms)
  return d < 3600000 ? `${Math.round(d / 60000)} min ago` : d < 2 * DAY ? `${Math.round(d / 3600000)} h ago` : `${Math.round(d / DAY)} days ago`
}
// "Seen working": the newest real activity, within a window.
const seen = (label, windowDays, sql, ...args) => async (env, now) => {
  const r = await env.ONBOARDING_DB.prepare(sql).bind(...args).first()
  const at = r?.at ?? null
  if (!at) return { ok: false, at: null, evidence: `No ${label} recorded yet` }
  return { ok: now - at <= windowDays * DAY, at, evidence: `Last ${label} ${ago(at, now)}` }
}
// Evidence counts only real businesses' activity (never test-marked leads or test businesses): a test business working is
// not proof that customers' traffic works, and must never make a capability look live-verified.
// Not a test business, and (if it was one and got unmarked) the row is not from its sandbox era: anything created up to
// unmarked_at stays sandboxed (server/testbusiness.js), so it can never establish real-world evidence.
const NOT_TEST_BIZ = (col, at) => `NOT EXISTS (SELECT 1 FROM test_businesses tb WHERE tb.customer = ${col} AND (tb.is_test = 1 OR (tb.unmarked_at IS NOT NULL AND ${at} <= tb.unmarked_at)))`
const REAL_LEAD = `NOT EXISTS (SELECT 1 FROM test_marks t WHERE t.lead_id = l.id AND t.is_test = 1) AND ${NOT_TEST_BIZ('l.customer', 'l.created_at')}`

// ---------- platform ----------
registerCapability({
  id: 'platform.database',
  tier: 'operate',
  name: 'Database (Cloudflare D1)',
  journey: 'platform',
  external: 'Cloudflare',
  state: () => ({ mode: 'live' }),
  verify: async (env) => {
    const r = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").first()
    return { ok: r.n > 0, at: Date.now(), evidence: `Reachable, ${r.n} tables` }
  },
})
registerCapability({
  id: 'platform.alerts',
  tier: 'optional',
  name: 'Founder alerts (email to platform admins)',
  journey: 'platform',
  description: 'Calendar broken, booking page without times, messages failing: one email per incident (server/alerts.js).',
  external: 'Resend',
  state: (env) =>
    !alertsEnabled(env)
      ? { mode: 'disabled', note: 'FOUNDER_ALERTS_ENABLED off', approval: 'FOUNDER_ALERTS_ENABLED + founder address in MESSAGE_TEST_RECIPIENTS' }
      : !emailConfigured(env)
        ? { mode: 'disabled', note: 'Email provider not configured' }
        : { mode: 'live', note: messagesLive(env) ? 'Platform admins' : 'Platform admins listed in MESSAGE_TEST_RECIPIENTS' },
})
registerCapability({
  id: 'platform.incidents',
  tier: 'operate',
  action: { label: 'Open the Control Center', href: '/admin/control' },
  name: 'Incident register (Control Center)',
  journey: 'platform',
  description: 'Customer-impacting failures from existing records, deduplicated, resolved on evidence (server/ops/incidents.js).',
  dependsOn: ['platform.database', 'platform.cron'],
  state: async (env) => ((await registerReady(env.ONBOARDING_DB)) ? { mode: 'live', note: 'Built from records every cron run' } : { mode: 'disabled', note: 'Migration 0031 not applied', approval: 'Apply migration 0031' }),
})
registerCapability({
  id: 'platform.tokens',
  tier: 'operate',
  name: 'Encrypted credentials store (KV)',
  journey: 'platform',
  external: 'Cloudflare',
  state: (env) => ({ mode: env.TOKEN_ENCRYPTION_KEY ? 'live' : 'disabled', note: env.TOKEN_ENCRYPTION_KEY ? null : 'TOKEN_ENCRYPTION_KEY missing' }),
  verify: async (env) => {
    const ids = []
    let cursor
    for (let page = 0; page < 100; page++) {
      const r = await env.GOOGLE_TOKENS.list({ prefix: 'google:', cursor })
      ids.push(...r.keys.map((k) => k.name.slice('google:'.length)))
      if (r.list_complete || !r.cursor) break
      cursor = r.cursor
    }
    const { results } = await env.ONBOARDING_DB.prepare('SELECT id FROM customers').all()
    const known = new Set(results.map((x) => x.id))
    const orphans = ids.filter((id) => !known.has(id))
    if (orphans.length) return { ok: false, problem: true, at: Date.now(), evidence: `${orphans.length} Calendar credential${orphans.length === 1 ? '' : 's'} stored for a business that doesn't exist (${orphans.join(', ')}); ${ids.length - orphans.length} in use` }
    return { ok: true, at: Date.now(), evidence: `Reachable, ${ids.length} calendar connection${ids.length === 1 ? '' : 's'} stored, all belonging to a business` }
  },
})
registerCapability({
  id: 'platform.audit',
  tier: 'operate',
  name: 'Permanent audit log',
  journey: 'platform',
  dependsOn: ['platform.database', 'platform.cron'],
  state: () => ({ mode: 'live' }),
  verify: seen('verified audit checkpoint', 2, "SELECT max(at) AS at FROM audit_log WHERE action = 'audit.checkpoint' AND outcome = 'success'"),
})
registerCapability({
  id: 'platform.cron',
  tier: 'operate',
  name: 'Scheduler (every 5 minutes)',
  journey: 'platform',
  description: 'Sends due messages, pauses held ads, retries deletions, reconciles billing, checks the audit chain.',
  dependsOn: ['platform.database'],
  external: 'Cloudflare',
  state: () => ({ mode: 'live' }),
  // The daily audit checkpoint is written by the cron run, so it proves the scheduler is running.
  verify: seen('scheduled run (daily checkpoint)', 2, "SELECT max(at) AS at FROM audit_log WHERE action = 'audit.checkpoint'"),
})
registerCapability({
  id: 'platform.admin',
  tier: 'operate',
  action: { label: 'Open the admin console', href: '/admin' },
  name: 'Founder admin console',
  journey: 'platform',
  dependsOn: ['auth.google_signin', 'platform.audit'],
  state: (env) => ({ mode: String(env.PLATFORM_ADMIN_EMAILS || '').includes('@') ? 'live' : 'disabled', note: 'Access from PLATFORM_ADMIN_EMAILS only' }),
  verify: async (env, now) => {
    const admins = String(env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    if (!admins.length) return { ok: false, at: null, evidence: 'No admin configured' }
    const r = await env.ONBOARDING_DB.prepare(`SELECT max(created_at) AS at FROM sessions WHERE lower(email) IN (${admins.map((_, i) => `?${i + 1}`).join(',')})`).bind(...admins).first()
    return r?.at ? { ok: now - r.at <= 30 * DAY, at: r.at, evidence: `Last founder sign-in ${ago(r.at, now)}` } : { ok: false, at: null, evidence: 'No founder sign-in recorded yet' }
  },
})

// ---------- sign up / billing / onboarding ----------
registerCapability({
  id: 'auth.google_signin',
  tier: 'operate',
  name: 'Sign in with Google',
  journey: 'signup',
  external: 'Google',
  dependsOn: ['platform.database'],
  state: () => ({ mode: 'live', note: 'openid + email only' }),
  verify: seen('sign-in by a real business member', 30, `SELECT max(s.created_at) AS at FROM sessions s JOIN customer_users u ON u.email = s.email WHERE ${NOT_TEST_BIZ('u.customer', 's.created_at')}`),
})
registerCapability({
  id: 'billing.stripe',
  tier: 'payments',
  action: { label: 'Billing reconciliation in the admin console', href: '/admin' },
  name: 'Stripe billing ($499/month)',
  journey: 'billing',
  external: 'Stripe',
  dependsOn: ['platform.database'],
  state: (env) =>
    !stripeConfigured(env)
      ? { mode: 'disabled', note: 'Stripe not configured' }
      : stripeLiveEnabled(env)
        ? { mode: 'live' }
        : { mode: 'sandbox', note: 'Stripe test mode: no real charges', approval: 'STRIPE_LIVE_ENABLED=true with live keys, price and webhook' },
  verify: seen('Stripe webhook received', 30, 'SELECT max(received_at) AS at FROM stripe_events'),
  business: async (env, id) => {
    const s = await env.ONBOARDING_DB.prepare('SELECT status, cancel_at_period_end FROM subscriptions WHERE customer = ?1').bind(id).first()
    if (!s) return { status: 'off', summary: 'Not billed' }
    return { status: ['active', 'trialing'].includes(s.status) && !s.cancel_at_period_end ? 'ok' : 'attention', summary: `${s.status}${s.cancel_at_period_end ? ', cancellation scheduled' : ''}` }
  },
})
registerCapability({
  id: 'billing.reconcile',
  tier: 'payments',
  action: { label: 'Billing reconciliation card', href: '/admin' },
  name: 'Billing reconciliation (Stripe vs records)',
  journey: 'billing',
  dependsOn: ['billing.stripe', 'platform.cron', 'platform.audit'],
  external: 'Stripe',
  state: (env) => (stripeConfigured(env) ? { mode: stripeLiveEnabled(env) ? 'live' : 'sandbox' } : { mode: 'disabled', note: 'Stripe not configured' }),
  verify: async (env, now) => {
    const r = await env.ONBOARDING_DB.prepare("SELECT at, details FROM audit_log WHERE action = 'billing.reconciliation' ORDER BY seq DESC LIMIT 1").first()
    if (!r) return { ok: false, at: null, evidence: 'Not run yet' }
    const d = JSON.parse(r.details)
    const kinds = Object.entries(d.byType || {}).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')
    // Differences classified by the run (server/reconcile.js scopeOf): only those for real businesses are a problem;
    // Stripe objects for ids that don't exist here (sandbox leftovers) and test businesses are reported, not alarming.
    if (d.issues && (d.real === undefined || d.real > 0)) return { ok: false, problem: true, at: r.at, evidence: `${d.real ?? d.issues} difference(s) between Stripe and our records for real businesses (${kinds}), checked ${ago(r.at, now)}` }
    if (d.issues) return { ok: now - r.at < 2 * DAY, at: r.at, evidence: `No differences for real businesses; ${d.issues} for test or unknown records (sandbox leftovers: ${kinds}), checked ${ago(r.at, now)}` }
    return { ok: now - r.at < 2 * DAY, at: r.at, evidence: `Clean ${ago(r.at, now)}` }
  },
})
registerCapability({
  id: 'billing.lifecycle',
  tier: 'payments',
  name: 'Cancellation, 90-day recovery, payment problems',
  journey: 'account',
  dependsOn: ['billing.stripe', 'platform.cron'],
  state: () => ({ mode: 'live' }),
  business: async (env, id) => {
    const l = await lifecycle(env, id)
    const attention = ['payment_problem', 'recovery_ended', 'deleting'].includes(l.stage)
    return { status: attention ? 'attention' : 'ok', summary: l.stage.replace(/_/g, ' ') + (l.recovery && !l.recovery.expired ? ` (recoverable ${l.recovery.daysLeft} more days)` : '') }
  },
})
registerCapability({
  id: 'onboarding.selfserve',
  tier: 'payments',
  action: { label: 'Self-serve sign-up', href: '/dashboard?plan=founding' },
  name: 'Self-serve onboarding',
  journey: 'onboarding',
  dependsOn: ['auth.google_signin', 'billing.stripe', 'calendar.google', 'website.hosting'],
  state: () => ({ mode: 'live' }),
  verify: seen('real business finished setup', 60, `SELECT max(at) AS at FROM events e WHERE type = 'setup_completed' AND ${NOT_TEST_BIZ('e.customer', 'e.at')}`),
})

// ---------- website ----------
registerCapability({
  id: 'website.hosting',
  tier: 'operate',
  action: { label: 'Website tab (business dashboard)', href: '/dashboard/website' },
  name: 'Hosted business websites',
  journey: 'website',
  dependsOn: ['platform.database'],
  state: () => ({ mode: 'live' }),
  verify: seen('real business website published', 60, `SELECT max(published_at) AS at FROM websites w WHERE live_version IS NOT NULL AND ${NOT_TEST_BIZ('w.customer', 'w.published_at')}`),
  business: async (env, id) => {
    const w = await env.ONBOARDING_DB.prepare('SELECT live_version FROM websites WHERE customer = ?1').bind(id).first()
    return w?.live_version ? { status: 'ok', summary: `Published (version ${w.live_version})` } : { status: 'off', summary: 'Not published' }
  },
})
registerCapability({
  id: 'website.ai',
  tier: 'optional',
  action: { label: 'Website tab', href: '/dashboard/website' },
  name: 'AI website designs',
  journey: 'website',
  external: 'Cloudflare Workers AI',
  dependsOn: ['website.hosting'],
  state: (env) => (aiConfigured(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Template fallback only', approval: 'AI binding on the Pages project' }),
  verify: seen('AI generation for a real business', 30, `SELECT max(created_at) AS at FROM website_generations g WHERE source = 'ai' AND ${NOT_TEST_BIZ('g.customer', 'g.created_at')}`),
})
registerCapability({
  id: 'website.studio',
  tier: 'optional',
  action: { label: 'Website Studio', href: '/dashboard/website' },
  name: 'Website Studio (AI designer on the business’s own Claude/OpenAI key)',
  journey: 'website',
  external: 'Customer-owned Anthropic / OpenAI accounts',
  dependsOn: ['website.hosting'],
  // Every eligible business (server/website-studio.js); hidden until its tables exist. Publishing is a separate switch.
  state: async (env) => {
    const publishing = studioPublishAllowed(env) ? 'publishing on for every eligible business' : 'publishing PAUSED (WEBSITE_STUDIO_PUBLISH=false)'
    if (!studioEnabled(env)) return { mode: 'disabled', note: `Switched off (WEBSITE_STUDIO_ENABLED=false); ${publishing}` }
    const ready = await studioSchemaReady(env.ONBOARDING_DB).catch(() => false)
    return ready ? { mode: 'live', note: `Every eligible business; ${publishing}` } : { mode: 'missing', note: `Hidden until migrations 0021–0023 are applied; ${publishing}`, approval: 'Production migrations 0021–0023' }
  },
})
registerCapability({
  id: 'website.domains',
  tier: 'optional',
  action: { label: 'Domain settings (Website tab)', href: '/dashboard/website' },
  name: 'Own domains',
  journey: 'website',
  external: 'Cloudflare',
  dependsOn: ['website.hosting'],
  state: (env) => (providerConfigured(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Domain proof works; attaching needs the Cloudflare API token', approval: 'CF_API_TOKEN, CF_ACCOUNT_ID, CF_PAGES_PROJECT' }),
  verify: seen('domain connected', 90, "SELECT max(connected_at) AS at FROM website_domains WHERE status = 'connected'"),
})

// ---------- advertising ----------
registerCapability({
  id: 'ads.google',
  tier: 'advertising',
  action: { label: 'Ads tab (business dashboard)', href: '/dashboard/ads' },
  name: 'Google Ads campaigns',
  journey: 'advertising',
  external: 'Google Ads',
  dependsOn: ['platform.tokens', 'billing.stripe', 'ads.safety_stop'],
  blockers: ['Google Cloud project at Test access level: real ad accounts are refused by Google', 'Google OAuth verification (sensitive scopes) pending'],
  state: (env) =>
    !adsEnabled(env)
      ? { mode: 'disabled', note: 'ADS_ENABLED off' }
      : liveLaunchEnabled(env)
        ? { mode: 'live' }
        : { mode: 'sandbox', note: 'Google Ads test accounts only; nothing serves or spends', approval: 'ADS_LIVE_LAUNCH=true' },
  verify: seen('campaign read back from Google', 7, "SELECT max(at) AS at FROM ad_actions WHERE kind = 'verify' AND status = 'applied'"),
  business: async (env, id) => {
    const c = await env.ONBOARDING_DB.prepare("SELECT status, account_id FROM ad_connections WHERE customer = ?1 AND platform = 'google'").bind(id).first()
    const stuck = await runningOnHold(env, id).catch(() => null)
    if (stuck) return { status: 'attention', summary: `${stuck.running} campaign(s) still running on hold${stuck.unreachable ? ' (unreachable)' : ''}` }
    const n = await env.ONBOARDING_DB.prepare("SELECT sum(status = 'active') AS running, sum(status = 'paused') AS paused FROM ad_campaigns WHERE customer = ?1 AND platform_campaign_id IS NOT NULL").bind(id).first()
    if (!c) return { status: 'off', summary: 'Not connected' }
    return { status: c.status === 'connected' ? 'ok' : 'attention', summary: `${c.status}; ${n?.running || 0} running, ${n?.paused || 0} paused` }
  },
})
registerCapability({
  id: 'ads.meta',
  tier: 'advertising',
  action: { label: 'Ads tab (business dashboard)', href: '/dashboard/ads' },
  name: 'Meta (Facebook/Instagram) ads',
  journey: 'advertising',
  external: 'Meta',
  dependsOn: ['platform.tokens', 'ads.safety_stop'],
  description: 'Lead ads on Facebook/Instagram: draft, preview, review, dry run; created PAUSED; read back and compared; paused/resumed; leads by webhook.',
  blockers: ['Meta app with Business verification and App Review (ads_management, leads_retrieval, pages_* permissions) — external, founder'],
  state: (env) =>
    metaConfigured(env)
      ? liveLaunchEnabled(env)
        ? { mode: 'live', note: 'Connected owners can create paused campaigns and start them (approved budget, subscription)' }
        : { mode: 'sandbox', note: 'Connect, draft, preview, review and dry run; creating a paused campaign needs ADS_LIVE_LAUNCH', approval: 'ADS_LIVE_LAUNCH=true (creating paused campaigns) and, separately, each owner’s Start' }
      : { mode: 'disabled', note: 'Meta app not configured: owners see “not available yet”; drafts and previews still work', approval: 'META_APP_ID + META_APP_SECRET (+ META_WEBHOOK_VERIFY_TOKEN) from a Meta app with Business verification and App Review', needs: 'configuration' },
  verify: seen('Meta campaign read back', 7, "SELECT max(at) AS at FROM ad_actions WHERE kind = 'verify' AND status = 'applied' AND campaign_id IN (SELECT id FROM ad_campaigns WHERE platform = 'meta')"),
})
registerCapability({
  id: 'ads.safety_stop',
  tier: 'advertising',
  name: 'Ads safety stop (pause on failed payment, cancellation, suspension, deletion)',
  journey: 'advertising',
  dependsOn: ['billing.stripe', 'platform.cron', 'platform.audit'],
  state: (env) => (adsEnabled(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Ads off' }),
  verify: async (env, now) => {
    // Healthy = no business on hold with a campaign still running (one query for all businesses).
    const stuck = (await customerRows(env, now)).filter((b) => b.attention.includes('ads_running_on_hold')).length
    const last = await env.ONBOARDING_DB.prepare("SELECT max(at) AS at FROM audit_log WHERE action = 'ads.pause' AND actor LIKE 'system:%' AND outcome = 'success'").first()
    if (stuck) return { ok: false, problem: true, at: now, evidence: `${stuck} business(es) on hold with campaigns still running` }
    // Never triggered = no evidence it works in production yet (not a success).
    return last?.at ? { ok: true, at: last.at, evidence: `Last automatic pause ${ago(last.at, now)}; none running on hold` } : { ok: false, at: null, evidence: 'Never triggered in production yet; none running on hold' }
  },
  business: async (env, id) => {
    const h = await adsHold(env, id).catch(() => null)
    return h ? { status: 'attention', summary: `On hold: ${h.reason.replace(/_/g, ' ')}` } : { status: 'ok', summary: 'No hold' }
  },
})
registerCapability({
  id: 'ads.conversions',
  tier: 'later',
  name: 'Conversions sent to Google',
  journey: 'results',
  external: 'Google Data Manager API',
  dependsOn: ['ads.google'],
  state: (env) => (conversionsEnabled(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Needs a new sensitive OAuth scope', approval: 'ADS_CONVERSIONS_ENABLED + datamanager scope verification' }),
})

// ---------- lead / booking / show-up / results ----------
registerCapability({
  id: 'lead.capture',
  tier: 'operate',
  action: { label: 'Appointments (business dashboard)', href: '/dashboard/appointments' },
  name: 'Lead capture (website + booking page)',
  journey: 'lead',
  dependsOn: ['website.hosting', 'platform.database'],
  state: () => ({ mode: 'live' }),
  verify: seen('real lead', 30, `SELECT max(l.created_at) AS at FROM leads l WHERE ${REAL_LEAD}`),
})
registerCapability({
  id: 'lead.qualify',
  tier: 'later',
  name: 'Qualify or route leads (book / qualify / human)',
  journey: 'lead',
  dependsOn: ['lead.capture'],
  state: () => ({ mode: 'missing', note: 'On the to-do list' }),
})
registerCapability({
  id: 'calendar.google',
  tier: 'operate',
  action: { label: 'Connect Google Calendar (business Settings)', href: '/dashboard/settings' },
  name: 'Google Calendar booking',
  journey: 'booking',
  external: 'Google Calendar',
  dependsOn: ['platform.tokens', 'auth.google_signin'],
  state: () => ({ mode: 'live', note: 'free/busy + own events only' }),
  verify: seen('real booking placed on Google Calendar', 30, `SELECT max(a.created_at) AS at FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.google_event_id IS NOT NULL AND ${REAL_LEAD}`),
  business: async (env, id) => ((await env.GOOGLE_TOKENS.get(`google:${id}`)) ? { status: 'ok', summary: 'Connected' } : { status: 'attention', summary: 'Not connected' }),
})
registerCapability({
  id: 'messaging.email',
  tier: 'operate',
  name: 'Email confirmations, reminders, follow-ups',
  journey: 'booking',
  external: 'Resend',
  dependsOn: ['platform.cron'],
  state: (env) =>
    !emailConfigured(env)
      ? { mode: 'disabled', note: 'Resend not configured' }
      : messagesLive(env)
        ? { mode: 'live' }
        : { mode: 'sandbox', note: 'Sent to test recipients only', approval: 'MESSAGES_LIVE=true' },
  verify: seen('email accepted by Resend for a real business', 30, `SELECT max(updated_at) AS at FROM messages m WHERE status = 'sent' AND channel = 'email' AND ${NOT_TEST_BIZ('m.customer', 'm.created_at')}`),
})
registerCapability({
  id: 'messaging.owner_notices',
  tier: 'optional',
  name: 'Owner notices (new bookings and unbooked leads)',
  journey: 'lead',
  description: 'Emails the business members about each new booking, and about a qualified lead not booked after 10 minutes.',
  external: 'Resend',
  dependsOn: ['messaging.email', 'platform.cron'],
  state: (env) =>
    !emailConfigured(env)
      ? { mode: 'disabled', note: 'Resend not configured' }
      : messagesLive(env)
        ? { mode: 'live' }
        : { mode: 'sandbox', note: 'Sent to test recipients only', approval: 'MESSAGES_LIVE=true' },
  verify: seen('owner notice sent for a real business', 30, `SELECT max(sent_at) AS at FROM email_outbox o WHERE status = 'sent' AND template IN ('owner_booking', 'owner_lead', 'owner_cancel', 'owner_bounce') AND ${NOT_TEST_BIZ('o.customer', 'o.created_at')}`),
})
registerCapability({
  id: 'messaging.email_feedback',
  tier: 'optional',
  name: 'Email bounces and spam complaints (Resend webhook)',
  journey: 'booking',
  description: 'Permanently bounced or complaining addresses are not emailed again; the owner is asked to call instead.',
  external: 'Resend',
  dependsOn: ['messaging.email'],
  state: (env) =>
    feedbackConfigured(env)
      ? { mode: 'live' }
      : { mode: 'missing', note: 'No signed webhook: bounces go unnoticed', approval: 'RESEND_WEBHOOK_SECRET + webhook endpoint in Resend' },
  verify: seen('bounce or complaint received for a real business', 90, `SELECT max(created_at) AS at FROM email_suppressions s WHERE ${NOT_TEST_BIZ('s.customer', 's.created_at')}`),
})
registerCapability({
  id: 'messaging.sms',
  tier: 'later',
  action: { label: 'Messaging operations (admin console)', href: '/admin' },
  name: 'Text messages',
  journey: 'booking',
  external: 'Twilio',
  dependsOn: ['platform.cron', 'messaging.optouts'],
  blockers: ['Twilio account + A2P 10DLC registration'],
  state: (env) => (smsConfigured(env) ? { mode: messagesLive(env) ? 'live' : 'sandbox' } : { mode: 'disabled', note: 'Twilio not configured' }),
})
registerCapability({
  id: 'messaging.optouts',
  tier: 'operate',
  name: 'Unsubscribe and STOP handling',
  journey: 'booking',
  dependsOn: ['platform.database'],
  state: () => ({ mode: 'live' }),
})
registerCapability({
  id: 'showup.outcomes',
  tier: 'operate',
  action: { label: 'Appointments (business dashboard)', href: '/dashboard/appointments' },
  name: 'Show-up and job tracking',
  journey: 'showup',
  dependsOn: ['calendar.google'],
  state: () => ({ mode: 'live' }),
  verify: seen('attendance recorded for a real booking', 30, `SELECT max(a.updated_at) AS at FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.status IN ('showed', 'no_show') AND ${REAL_LEAD}`),
})
registerCapability({
  id: 'results.attribution',
  tier: 'advertising',
  name: 'Attribution (which campaign brought the lead)',
  journey: 'results',
  dependsOn: ['lead.capture', 'ads.google'],
  state: () => ({ mode: 'live' }),
  verify: seen('attributed real lead', 30, `SELECT max(la.created_at) AS at FROM lead_attribution la JOIN leads l ON l.id = la.lead_id WHERE ${REAL_LEAD}`),
})

// ---------- account lifecycle ----------
registerCapability({
  id: 'account.deletion',
  tier: 'payments',
  name: 'Permanent account deletion',
  journey: 'account',
  dependsOn: ['ads.safety_stop', 'billing.stripe', 'platform.tokens', 'platform.audit', 'platform.cron'],
  state: (env) => (deletionEnabled(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Built and tested; off', approval: 'Retention policy + ACCOUNT_DELETION_ENABLED (migrations 0015, 0016)' }),
  business: async (env, id) => {
    const d = await deletionStatus(env.ONBOARDING_DB, id)
    return d ? { status: d.status === 'completed' ? 'off' : 'attention', summary: d.status === 'completed' ? 'Deleted' : `Deleting: ${d.step}${d.lastError ? ` (failing: ${d.lastError})` : ''}` } : null
  },
})
registerCapability({
  id: 'account.retention',
  tier: 'later',
  name: 'Retention schedule after the 90-day recovery period',
  journey: 'account',
  dependsOn: ['account.deletion', 'billing.lifecycle'],
  state: (env) => (retentionScheduleEnabled(env) ? { mode: 'live' } : { mode: 'disabled', note: 'Day 90 only records the expiry', approval: 'Approved, disclosed retention schedule + RETENTION_SCHEDULE_ENABLED' }),
})
// ---------- AI receptionist (server/receptionist/) ----------
registerCapability({
  id: 'receptionist.chat',
  tier: 'operate',
  action: { label: 'Receptionist settings (business Settings)', href: '/dashboard/settings' },
  name: 'AI receptionist: website chat',
  journey: 'lead',
  description: 'Answers customers from the business records and books through the same booking engine.',
  external: 'Anthropic',
  dependsOn: ['calendar.google', 'platform.database'],
  state: (env) => (modelConfigured(env) ? { mode: 'live', note: 'Off per business until the owner turns it on' } : { mode: 'disabled', note: env.RECEPTIONIST_ENABLED === 'false' ? 'Kill switch on' : 'Model key not set' }),
  verify: seen('real receptionist conversation', 30, `SELECT max(c.updated_at) AS at FROM receptionist_conversations c WHERE c.turns > 0 AND ${NOT_TEST_BIZ('c.customer', 'c.created_at')}`),
})
registerCapability({
  id: 'receptionist.voice',
  tier: 'optional',
  action: { label: 'Voice Lab', href: '/admin/voice-lab' },
  name: 'AI receptionist: browser voice (Retell)',
  journey: 'lead',
  description: 'Browser voice calls; released per business (RECEPTIONIST_VOICE_BUSINESSES). Failures: voice_turn / voice_frame events.',
  external: 'Retell',
  dependsOn: ['receptionist.chat'],
  state: (env) =>
    !modelConfigured(env) || !voiceConfigured(env)
      ? { mode: 'disabled', note: 'Retell not configured' }
      : voiceBusinesses(env).length
        ? { mode: 'sandbox', note: `In testing for ${voiceBusinesses(env).length} business(es)`, approval: 'Voice reliability sign-off (owner) before wider release' }
        : { mode: 'disabled', note: 'In testing: no business released', approval: 'RECEPTIONIST_VOICE_BUSINESSES' },
  verify: seen('voice turn answered for a real business', 30, `SELECT max(e.at) AS at FROM receptionist_events e WHERE e.kind = 'voice_turn' AND e.ok = 1 AND ${NOT_TEST_BIZ('e.customer', 'e.at')}`),
  business: async (env, id) => {
    const s = voiceStatus(env, id)
    return s === 'available' ? { status: 'ok', summary: 'Voice released' } : { status: 'off', summary: s === 'testing' ? 'Voice in testing (not released)' : 'Voice not configured' }
  },
})
// ---------- Teach Your AI (server/intelligence/, migration 0033) ----------
registerCapability({
  id: 'intelligence.studio',
  tier: 'optional',
  action: { label: 'Teach Your AI (business Settings)', href: '/dashboard/settings' },
  name: 'Teach Your AI: owner rules for the receptionist',
  journey: 'lead',
  description: 'Owners configure, test and publish versioned AI rules. Published rules reach real conversations only for AI_RULES_LIVE_BUSINESSES.',
  dependsOn: ['receptionist.chat'],
  state: (env) => {
    // Owner editing: every eligible business (server/eligibility.js) unless switched off; live use: the listed ones.
    const studio = teachAiEnabled(env)
    const live = env.AI_RULES_ENABLED === 'false' ? 0 : String(env.AI_RULES_LIVE_BUSINESSES || '').split(',').filter((s) => s.trim()).length
    if (!studio && !live) return { mode: 'disabled', note: 'Owner editing switched off (AI_STUDIO_ENABLED=false); live use off' }
    return live ? { mode: 'sandbox', note: `Editing for every eligible business; live rules for ${live} business(es)`, approval: 'Pilot sign-off before wider release' } : { mode: 'sandbox', note: 'Editing for every eligible business; live use off', approval: 'AI_RULES_LIVE_BUSINESSES' }
  },
  verify: seen('conversation using published AI rules', 30, `SELECT max(e.at) AS at FROM receptionist_events e WHERE e.kind = 'rules' AND ${NOT_TEST_BIZ('e.customer', 'e.at')}`),
})
registerCapability({
  id: 'lead.enterprise_inquiry',
  tier: 'optional',
  name: 'Enterprise inquiries (pricing → Contact sales)',
  journey: 'lead',
  description: 'Stored as leads of the GetShowUps sales business; a person replies (server/enterprise.js).',
  dependsOn: ['lead.capture'],
  state: () => ({ mode: 'live', note: 'Needs the active "getshowups" business record' }),
  verify: seen('enterprise inquiry', 60, `SELECT max(l.created_at) AS at FROM leads l JOIN lead_threads t ON t.lead_id = l.id WHERE t.source = 'enterprise_inquiry' AND ${REAL_LEAD}`),
})
registerCapability({
  id: 'assist.writing',
  tier: 'optional',
  name: 'Writing help in settings fields',
  journey: 'onboarding',
  description: 'Owner-pressed suggestions (included model), checked and never saved automatically (server/writing.js).',
  state: (env) => (env.AI_ASSIST_ENABLED === 'false' ? { mode: 'disabled', note: 'AI_ASSIST_ENABLED=false' } : env.AI?.run ? { mode: 'live' } : { mode: 'missing', note: 'Workers AI binding missing' }),
  verify: seen('writing suggestion', 30, `SELECT max(at) AS at FROM events e WHERE e.type = 'ai_write' AND json_extract(e.props, '$.ok') = 1 AND ${NOT_TEST_BIZ('e.customer', 'e.at')}`),
})
registerCapability({
  id: 'crm.ghl',
  tier: 'later',
  name: 'GoHighLevel sync',
  journey: 'lead',
  external: 'GoHighLevel',
  dependsOn: ['lead.capture'],
  state: (env) => (env.GHL_ENABLED === 'true' ? { mode: 'sandbox', note: 'In testing with founding customers' } : { mode: 'disabled', note: 'GHL_ENABLED off' }),
})
