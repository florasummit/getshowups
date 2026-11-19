// Permanent account deletion (owner decision 2026-11-14; retention policy: docs/DATA_RETENTION.md).
// A durable, retryable, audited workflow, one row per business in account_deletions (migration 0016):
//   lockout      at once: booking/site off, members lose access, pending messages/invites cancelled
//   ads          every running campaign paused on its platform and read back (holds: account_deleted)
//   billing      Stripe subscriptions canceled now and confirmed; Stripe customer deleted
//   integrations Calendar/Ads/GoHighLevel credentials deleted (Google grant revoked unless shared),
//                own domain detached, ad creative files deleted
//   data         every business/personal record erased; only documented retained records stay
//   verify       re-checks that nothing erasable is left, then records the report
// Each step is idempotent; a failed step is retried with backoff by the cron (processDeletions). No undo window.
// Runs only when ACCOUNT_DELETION_ENABLED is exactly 'true' (approval); otherwise nothing is requested or run.
import { closeSubaccount } from './followups/twilio.js'
import { emailRef, recordEvent } from './auditlog.js'
import { decrypt, revokeUnlessInUse } from './google-oauth.js'
import { enforceAdsHold } from './ads/holds.js'
import { forgetConnection } from './ads/connections.js'
import { endBillingNow, getSubscription, stripeConfigured, subscriptionEnded } from './stripe.js'
import { deleteGhlConfig } from './ghl.js'
import { disconnectDomain } from './domains.js'

export const deletionEnabled = (env) => env.ACCOUNT_DELETION_ENABLED === 'true'
// Standard event fields for one deletion: every step of it shares one correlation id.
const ev = (customer, outcome) => ({ customer, capability: 'account.deletion', resource: { type: 'customer', id: customer }, outcome, correlationId: `deletion:${customer}` })
export const STEPS = ['lockout', 'ads', 'billing', 'integrations', 'data', 'verify']
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000

// Erased per business, children before parents (foreign keys).
export const ERASED_TABLES = [
  'receptionist_requests', 'receptionist_events', 'receptionist_calls', 'receptionist_conversations', 'receptionist_settings',
  'thread_messages', 'lead_threads', 'followup_settings', 'sms_provider_objects', 'sms_registration_extra', 'sms_accounts', 'sms_registrations', 'messages', 'sms_consents', 'message_optouts', 'appointment_confirmations', 'revenue_entries', 'coverage_requests', 'appointment_outcomes', 'appointment_changes',
  'lead_addresses', 'lead_attribution', 'test_marks', 'meta_lead_events', 'ghl_links', 'appointments', 'leads',
  'ad_metrics_daily', 'ad_creatives', 'ad_actions', 'ad_campaigns', 'ad_budget_approvals', 'ad_profiles', 'ad_connections',
  'website_versions', 'website_generations', 'website_ai_usage', 'website_assets', 'website_domains', 'websites', 'landing_pages',
  'business_profiles', 'service_settings', 'customer_settings', 'onboarding_marks', 'self_signups', 'account_invites',
  'onboarding_invites', 'customer_users', 'email_outbox', 'conversation_control', 'business_policies', 'email_suppressions', 'website_imports', 'ai_credentials', 'ai_key_usage', 'website_design_turns',
  'website_asset_hidden',
]
// Kept (no personal data, or needed for tax/accounting, disputes, security): see docs/DATA_RETENTION.md.
export const FINANCIAL_EVENTS = ['revenue', 'payment_failed', 'payment_succeeded', 'subscription_started', 'subscription_status_changed', 'subscription_canceled']
export const RETAINED = [
  'customers (tombstone: id only, name replaced; the id is never reused)',
  'subscriptions, subscription_modes, financial events (billing records: tax/accounting, disputes)',
  'ai_usage (GetShowUps cost records, no personal data)',
  'test_businesses (flag only)',
  'audit_log (no personal data) and admin_audit (emails replaced by refs)',
  'account_deletions (this record)',
]

export async function deletionStatus(db, customerId) {
  try {
    const r = await db.prepare('SELECT * FROM account_deletions WHERE customer = ?1').bind(customerId).first()
    return r ? { status: r.status, step: r.step, attempts: r.attempts, lastError: r.last_error, requestedAt: r.requested_at, completedAt: r.completed_at, report: JSON.parse(r.report) } : null
  } catch (err) {
    if (err?.message?.includes('no such table')) return null
    throw err
  }
}

// Starts a deletion (idempotent) and runs as far as it can right away. actor: { type: 'owner'|'admin', id }.
export async function requestDeletion(env, customerId, actor, now = Date.now()) {
  if (!deletionEnabled(env)) return { ok: false, error: 'not_enabled' }
  const db = env.ONBOARDING_DB
  const exists = await db.prepare('SELECT id FROM customers WHERE id = ?1').bind(customerId).first()
  if (!exists) return { ok: false, error: 'not_found' }
  const by = actor.type === 'owner' ? `owner:${await emailRef(actor.id)}` : actor.type === 'admin' ? String(actor.id).toLowerCase() : String(actor.id || 'system')
  const created = await db
    .prepare("INSERT OR IGNORE INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at) VALUES (?1, ?2, ?3, 'in_progress', 'lockout', ?2)")
    .bind(customerId, now, by)
    .run()
  if ((created?.meta?.changes ?? 0) > 0) {
    const actorType = ['admin', 'owner'].includes(actor.type) ? actor.type : 'system'
    await recordEvent(db, { type: 'account.deletion_requested', actorType, actor: actorType === 'owner' ? `owner:${actor.id}` : actorType === 'admin' ? actor.id : by, ...ev(customerId, 'success'), at: now })
  }
  const r = await advanceDeletion(env, customerId, now)
  return { ok: true, ...r }
}

// ---------- steps ----------
async function lockout(env, id, now) {
  const db = env.ONBOARDING_DB
  await db.prepare("UPDATE customers SET status = 'suspended', updated_at = ?2 WHERE id = ?1").bind(id, now).run()
  const members = await db.prepare('DELETE FROM customer_users WHERE customer = ?1').bind(id).run()
  const messages = await db.prepare("UPDATE messages SET status = 'skipped', error = 'account_deleted', updated_at = ?2 WHERE customer = ?1 AND status IN ('scheduled', 'sending')").bind(id, now).run()
  const invites = await db.prepare('UPDATE account_invites SET revoked_at = coalesce(revoked_at, ?2) WHERE customer = ?1').bind(id, now).run()
  await db.prepare("DELETE FROM email_outbox WHERE customer = ?1 AND status = 'pending'").bind(id).run()
  // The hosted website goes offline now (suspension already stops serving; this also clears the published version).
  const site = await db.prepare('UPDATE websites SET live_version = NULL, published_at = NULL, updated_at = ?2 WHERE customer = ?1 AND live_version IS NOT NULL').bind(id, now).run()
  return { websiteUnpublished: site.meta.changes > 0, membersRemoved: members.meta.changes, messagesCancelled: messages.meta.changes, invitesRevoked: invites.meta.changes }
}

async function ads(env, id, now) {
  const r = await enforceAdsHold(env, id, { actor: 'system:deletion', hold: { reason: 'account_deleted' }, now, correlationId: `deletion:${id}` })
  const left = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND status IN ('active', 'launching')").bind(id).first()
  // Credentials are never removed (next step) while a managed campaign may still run. A campaign we can't reach needs a
  // platform admin to record that it was paused in Google Ads (/api/platform/campaign-pause); until then we wait.
  if (r.unreachable) throw step('ads_unreachable_confirm_paused', { running: left.n })
  if (r.failed || left.n) throw step('ads_not_paused', { running: left.n })
  return { paused: r.paused, verified: r.verified }
}

async function billing(env, id) {
  const sub = await getSubscription(env.ONBOARDING_DB, id)
  if (!sub?.stripeCustomerId && !sub?.stripeSubscriptionId) return { skipped: 'no_billing' }
  if (!stripeConfigured(env)) throw step('billing_unavailable')
  const r = await endBillingNow(env, { stripeCustomerId: sub.stripeCustomerId, stripeSubscriptionId: sub.stripeSubscriptionId })
  if (!r.ok) throw step(`stripe_${r.error}`)
  return { canceled: r.canceled, customerDeleted: r.customerDeleted }
}

async function integrations(env, id) {
  const kv = env.GOOGLE_TOKENS
  const out = { calendar: false, googleRevoked: false, archives: 0, ads: [], ghl: false, domain: null, creatives: 0, twilio: null }
  // The business's own Twilio subaccount is closed (Twilio releases its numbers); never the parent account.
  const tw = await closeSubaccount(env, id).catch(() => ({ ok: false, error: 'storage_error' }))
  if (!tw.ok) throw step(`twilio_${tw.error}`)
  out.twilio = tw.skipped ? null : 'closed'
  // Google Calendar (and archived records from older OAuth clients): delete ours first, then revoke the grant
  // unless another stored connection still uses it (one grant per Google account + client).
  const keys = [`google:${id}`]
  const archived = await kv.list({ prefix: `google-archive:${id}:` })
  keys.push(...archived.keys.map((k) => k.name))
  for (const key of keys) {
    const raw = await kv.get(key)
    if (!raw) continue
    let rec = null
    try {
      rec = JSON.parse(raw)
    } catch {}
    await kv.delete(key)
    if (key.startsWith('google:')) out.calendar = true
    else out.archives++
    if (rec?.refreshToken) {
      const token = await decrypt(env, rec.refreshToken).catch(() => null)
      if (token && (await revokeUnlessInUse(token, rec.googleSub, env, rec.clientId ?? env.GOOGLE_CLIENT_ID))) out.googleRevoked = true
    }
  }
  for (const platform of ['google', 'meta']) {
    if (await kv.get(`ads:${platform}:${id}`)) out.ads.push(platform)
    await forgetConnection(env, platform, id)
  }
  if (await kv.get(`ghl:${id}`)) out.ghl = true
  await deleteGhlConfig(env, id).catch(() => kv.delete(`ghl:${id}`))
  const domain = await env.ONBOARDING_DB.prepare("SELECT hostname, attached_at FROM website_domains WHERE customer = ?1 AND status <> 'removed'").bind(id).first()
  if (domain) {
    const d = await disconnectDomain(env, id)
    if (!d.ok) throw step(`domain_${d.error}`)
    out.domain = 'detached'
  }
  const { results: files } = await env.ONBOARDING_DB.prepare('SELECT storage_key FROM ad_creatives WHERE customer = ?1 AND storage_key IS NOT NULL').bind(id).all()
  if (files.length && !env.AD_ASSETS) throw step('asset_storage_unavailable')
  for (const f of files) {
    await env.AD_ASSETS.delete(f.storage_key)
    out.creatives++
  }
  return out
}

async function data(env, id, now) {
  const db = env.ONBOARDING_DB
  const erased = {}
  for (const t of ERASED_TABLES) {
    // A table whose migration isn't applied yet holds no data: nothing to erase (any other error still fails the step).
    const r = await db
      .prepare(`DELETE FROM ${t} WHERE customer = ?1`)
      .bind(id)
      .run()
      .catch((err) => {
        if (String(err?.message).includes('no such table')) return { meta: { changes: 0 } }
        throw err
      })
    if (r.meta.changes) erased[t] = r.meta.changes
  }
  const ev = await db.prepare(`DELETE FROM events WHERE customer = ?1 AND type NOT IN (${FINANCIAL_EVENTS.map((t) => `'${t}'`).join(',')})`).bind(id).run()
  if (ev.meta.changes) erased.events = ev.meta.changes
  // admin_audit (staff log): keep the entries, replace any email in their details with a one-way ref.
  // admin_audit (staff log): keep the entries; emails become refs and free text (names, reasons) is erased.
  const { results: audits } = await db.prepare('SELECT id, details FROM admin_audit WHERE customer = ?1').bind(id).all()
  let scrubbed = 0
  for (const a of audits) {
    let parsed
    try {
      parsed = JSON.parse(a.details || '{}')
    } catch {
      parsed = {}
    }
    const clean = await scrubStaffDetails(parsed)
    const next = JSON.stringify(clean)
    if (next === a.details) continue
    await db.prepare('UPDATE admin_audit SET details = ?2 WHERE id = ?1').bind(a.id, next).run()
    scrubbed++
  }
  if (scrubbed) erased.admin_audit_scrubbed = scrubbed
  // Tombstone: the id stays (links retained billing/audit records; never reused), nothing else identifying.
  await db.prepare("UPDATE customers SET name = 'Deleted business', service_zips = '', status = 'suspended', updated_at = ?2 WHERE id = ?1").bind(id, now).run()
  return { erased }
}

async function verify(env, id) {
  const db = env.ONBOARDING_DB
  const left = {}
  for (const t of ERASED_TABLES) {
    const r = await db
      .prepare(`SELECT count(*) AS n FROM ${t} WHERE customer = ?1`)
      .bind(id)
      .first()
      .catch((err) => {
        if (String(err?.message).includes('no such table')) return { n: 0 }
        throw err
      })
    if (r.n) left[t] = r.n
  }
  const ev = await db.prepare(`SELECT count(*) AS n FROM events WHERE customer = ?1 AND type NOT IN (${FINANCIAL_EVENTS.map((t) => `'${t}'`).join(',')})`).bind(id).first()
  if (ev.n) left.events = ev.n
  const name = await db.prepare('SELECT name FROM customers WHERE id = ?1').bind(id).first()
  if (name && name.name !== 'Deleted business') left.customers = 1
  const kv = env.GOOGLE_TOKENS
  for (const key of [`google:${id}`, `ads:google:${id}`, `ads:meta:${id}`, `ghl:${id}`]) if (await kv.get(key)) left[key.split(':')[0] + (key.startsWith('ads') ? `:${key.split(':')[1]}` : '')] = 1
  if ((await kv.list({ prefix: `google-archive:${id}:` })).keys.length) left['google-archive'] = 1
  const sub = await getSubscription(db, id)
  if (sub?.stripeSubscriptionId && stripeConfigured(env)) {
    const r = await subscriptionEnded(env, sub.stripeSubscriptionId) // read-only confirmation
    if (!r.ok) left.stripe = r.error
    else if (!r.ended) left.stripe = 'not_canceled'
  }
  if (Object.keys(left).length) throw step('residual_data', { left })
  return { clean: true, retained: RETAINED }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
async function scrubStaffDetails(v) {
  if (typeof v === 'string') {
    let s = v
    for (const e of new Set(v.match(EMAIL) || [])) s = s.split(e).join(await emailRef(e))
    return /^[A-Za-z0-9_.:/+@-]{1,80}$/.test(s) ? s : '[erased]'
  }
  if (Array.isArray(v)) return Promise.all(v.map(scrubStaffDetails))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = await scrubStaffDetails(x)
    return o
  }
  return v
}

const RUN = { lockout, ads, billing, integrations, data, verify }
const step = (code, extra = {}) => Object.assign(new Error(code), { code, extra })

// Runs the remaining steps of one deletion, in order, until done or a step fails (then schedules a retry).
export async function advanceDeletion(env, customerId, now = Date.now()) {
  if (!deletionEnabled(env)) return { status: 'paused', error: 'not_enabled' }
  const db = env.ONBOARDING_DB
  const job = await db.prepare('SELECT * FROM account_deletions WHERE customer = ?1').bind(customerId).first()
  if (!job) return { status: 'not_found' }
  if (job.status === 'completed') return { status: 'completed', step: 'done' }
  const report = JSON.parse(job.report || '{}')
  let i = STEPS.indexOf(job.step)
  while (i >= 0 && i < STEPS.length) {
    const name = STEPS[i]
    try {
      report[name] = await RUN[name](env, customerId, now)
    } catch (err) {
      const code = /^[a-z_]{2,60}$/.test(err?.code || '') ? err.code : 'internal_error'
      if (!err?.code) console.error('deletion step failed:', name, err?.name)
      const attempts = job.step === name ? job.attempts + 1 : 1
      const wait = Math.min(MAX_BACKOFF_MS, 5 * 60 * 1000 * 2 ** Math.min(attempts - 1, 6))
      report[`${name}_error`] = { code, ...(err?.extra || {}) }
      await db
        .prepare('UPDATE account_deletions SET step = ?2, attempts = ?3, last_error = ?4, next_attempt_at = ?5, report = ?6 WHERE customer = ?1')
        .bind(customerId, name, attempts, code, now + wait, JSON.stringify(report))
        .run()
      await recordEvent(db, { type: 'account.deletion_step_failed', actor: 'system:deletion', ...ev(customerId, 'failure'), details: { step: name, code, attempts, nextAttemptAt: now + wait }, at: now })
      return { status: 'in_progress', step: name, error: code, attempts }
    }
    delete report[`${name}_error`]
    i++
    const next = STEPS[i] ?? 'done'
    await db
      .prepare(`UPDATE account_deletions SET step = ?2, attempts = 0, last_error = NULL, report = ?3${next === 'done' ? ", status = 'completed', completed_at = ?4" : ''} WHERE customer = ?1`)
      .bind(customerId, next, JSON.stringify(report), ...(next === 'done' ? [now] : []))
      .run()
    await recordEvent(db, { type: `account.deletion_${name}`, actor: 'system:deletion', ...ev(customerId, 'success'), details: summary(name, report[name]), at: now })
  }
  await recordEvent(db, { type: 'account.deletion_completed', actor: 'system:deletion', ...ev(customerId, 'success'), details: { retained: RETAINED.length }, at: now })
  return { status: 'completed', step: 'done' }
}

// Audit details: counts and outcomes only.
function summary(name, r) {
  if (name === 'data') return { tables: Object.keys(r.erased).length, rows: Object.values(r.erased).reduce((a, b) => a + b, 0) }
  return Object.fromEntries(Object.entries(r || {}).filter(([, v]) => ['number', 'boolean', 'string'].includes(typeof v) || v === null))
}

// Cron: advance due deletions (bounded).
// limit 2: a full deletion measured 118 D1 queries (scripts/scale-bench.mjs); the cron run shares ~1,000 per request.
export async function processDeletions(env, { now = Date.now(), limit = 2 } = {}) {
  if (!deletionEnabled(env)) return { enabled: false }
  let rows
  try {
    rows = (await env.ONBOARDING_DB.prepare("SELECT customer FROM account_deletions WHERE status = 'in_progress' AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ?2").bind(now, limit).all()).results
  } catch (err) {
    if (err?.message?.includes('no such table')) return { enabled: true, advanced: 0 }
    throw err
  }
  let completed = 0
  let failed = 0
  for (const { customer } of rows) {
    const r = await advanceDeletion(env, customer, now)
    if (r.status === 'completed') completed++
    else if (r.error) failed++
  }
  return { enabled: true, advanced: rows.length, completed, failed }
}
