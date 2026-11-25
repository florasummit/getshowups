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
import { adminEmails } from './platform.js'
import { closeSubaccount } from './followups/twilio.js'
import { emailRef, recordEvent } from './auditlog.js'
import { decrypt, revokeUnlessInUse } from './google-oauth.js'
import { enforceAdsHold } from './ads/holds.js'
import { forgetConnection } from './ads/connections.js'
import { endBillingNow, getSubscription, stripeConfigured, stripeModeMismatch, subscriptionEnded } from './stripe.js'
import { deleteGhlConfig } from './ghl.js'
import { disconnectDomain } from './domains.js'
import { accountOf } from './business-accounts.js'
import { SALES_BUSINESS } from './public.js'
import { scheduleCancel } from './billing-details.js'

export const deletionEnabled = (env) => env.ACCOUNT_DELETION_ENABLED === 'true'
// Standard event fields for one deletion: every step of it shares one correlation id.
const ev = (customer, outcome) => ({ customer, capability: 'account.deletion', resource: { type: 'customer', id: customer }, outcome, correlationId: `deletion:${customer}` })
export const STEPS = ['lockout', 'ads', 'billing', 'integrations', 'data', 'verify']
// Optional recovery window before anything is erased (0 = none, the owner decision of 2026-11-14; 14 is proposed, not
// approved). During it the business is offline, its ads are paused and its plan is set to end; the owner can undo.
export const recoveryDays = (env) => {
  const n = Number(env.ACCOUNT_RECOVERY_DAYS)
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : 0
}
// Businesses nobody may delete from the product: ours (internal_live) and the sales record. Reclassify first, on purpose.
// An unreadable classification is treated as protected.
export async function protectedBusiness(env, id) {
  if (id === SALES_BUSINESS) return true
  try {
    return (await accountOf(env, id)).classification === 'internal_live'
  } catch {
    return true
  }
}
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000

// Erased per business, children before parents (foreign keys).
export const ERASED_TABLES = [
  'ai_rule_versions', 'ai_rules',
  'receptionist_requests', 'receptionist_events', 'receptionist_calls', 'receptionist_conversations', 'receptionist_settings', 'receptionist_voice_inherit', 'receptionist_voice_settings',
  'thread_messages', 'lead_threads', 'followup_settings', 'sms_provider_objects', 'sms_registration_extra', 'sms_accounts', 'sms_registrations', 'messages', 'sms_consents', 'message_optouts', 'appointment_confirmations', 'revenue_entries', 'coverage_requests', 'appointment_outcomes', 'appointment_changes',
  'lead_addresses', 'lead_attribution', 'test_marks', 'meta_lead_events', 'ghl_links', 'lsa_leads', 'google_calls', 'google_call_setup', 'appointments', 'leads',
  'ad_change_requests', 'ad_imported_metrics_daily', 'ad_imported_campaigns', 'ad_import_state', 'ad_templates', 'gbp_connections',
  'ad_metrics_daily', 'ad_creatives', 'ad_actions', 'ad_campaigns', 'ad_budget_approvals', 'ad_profiles', 'ad_connections',
  'website_versions', 'website_generations', 'website_ai_usage', 'website_assets', 'website_domains', 'websites', 'landing_pages',
  'business_profiles', 'service_settings', 'customer_settings', 'onboarding_marks', 'self_signups', 'account_invites',
  'onboarding_invites', 'customer_users', 'email_outbox', 'conversation_control', 'business_policies', 'email_suppressions', 'website_imports', 'ai_credentials', 'ai_key_usage', 'website_design_turns',
  'booking_rules', 'business_closures', 'owner_notice_off', 'business_restrictions',
  'acceptance_sessions', 'acceptance_grants', 'website_asset_hidden', 'ops_incidents', 'qa_runs', 'business_accounts',
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
    return r ? { status: r.status, step: r.step, attempts: r.attempts, lastError: r.last_error, requestedAt: r.requested_at, completedAt: r.completed_at, report: parsed(r.report) } : null
  } catch (err) {
    if (err?.message?.includes('no such table')) return null
    throw err
  }
}

// Starts a deletion (idempotent) and runs as far as it can right away. actor: { type: 'owner'|'admin', id }.
export async function requestDeletion(env, customerId, actor, now = Date.now()) {
  if (!deletionEnabled(env)) return { ok: false, error: 'not_enabled' }
  const db = env.ONBOARDING_DB
  const exists = await db.prepare('SELECT id, status FROM customers WHERE id = ?1').bind(customerId).first()
  if (!exists) return { ok: false, error: 'not_found' }
  if (await protectedBusiness(env, customerId)) return { ok: false, error: 'protected_business' }
  const days = actor.type === 'system' ? 0 : recoveryDays(env)
  const scheduledFor = days ? now + days * 86400000 : null
  const report = scheduledFor ? { scheduledFor, wasStatus: exists.status } : {}
  const by = actor.type === 'owner' ? `owner:${await emailRef(actor.id)}` : actor.type === 'admin' ? String(actor.id).toLowerCase() : String(actor.id || 'system')
  const created = await db
    .prepare("INSERT OR IGNORE INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at, report) VALUES (?1, ?2, ?3, 'in_progress', 'lockout', ?4, ?5)")
    .bind(customerId, now, by, scheduledFor ?? now, JSON.stringify(report))
    .run()
  if ((created?.meta?.changes ?? 0) > 0) {
    const actorType = ['admin', 'owner'].includes(actor.type) ? actor.type : 'system'
    await recordEvent(db, { type: 'account.deletion_requested', actorType, actor: actorType === 'owner' ? `owner:${actor.id}` : actorType === 'admin' ? actor.id : by, ...ev(customerId, 'success'), at: now })
  }
  const r = await advanceDeletion(env, customerId, now)
  return { ok: true, ...r }
}

// The recovery window: offline, ads paused, plan set to end (asked again every cron run until Stripe confirms it), so
// nothing is charged or published while the owner can still change their mind. Nothing is erased.
const OPEN = "status = 'in_progress' AND step = 'lockout' AND json_valid(report) AND json_extract(report, '$.claimed') IS NULL"
const stillClosing = (db, id, now) => db.prepare(`SELECT 1 AS x FROM account_deletions WHERE customer = ?1 AND ${OPEN} AND next_attempt_at > ?2`).bind(id, now).first()
async function holdForRecovery(env, id, report, now) {
  const db = env.ONBOARDING_DB
  // Every change only while the closing still stands: an undo made meanwhile always wins.
  const open = `EXISTS (SELECT 1 FROM account_deletions WHERE customer = ?1 AND ${OPEN} AND next_attempt_at > ?2)`
  await db.prepare(`UPDATE customers SET status = 'suspended', updated_at = ?2 WHERE id = ?1 AND status <> 'suspended' AND ${open}`).bind(id, now).run()
  await db.prepare(`UPDATE messages SET status = 'skipped', error = 'account_closing', updated_at = ?2 WHERE customer = ?1 AND status = 'scheduled' AND ${open}`).bind(id, now).run()
  if (!(await stillClosing(db, id, now))) return report
  const a = await enforceAdsHold(env, id, { actor: 'system:deletion', hold: { reason: 'account_deleted' }, now, correlationId: `deletion:${id}` }).catch(() => ({ failed: -1, paused: 0 }))
  if (!(await stillClosing(db, id, now))) return report
  const b = await scheduleCancel(env, id, now).catch(() => ({ ok: false, error: 'internal_error' }))
  // Only its own keys: a suspension recorded meanwhile (wasStatus) is never overwritten.
  const next = { ...report, adsPaused: (report.adsPaused || 0) + (a.paused || 0), adsPending: a.failed !== 0, billingEnds: b.ok === true, billingError: b.ok ? null : String(b.error || 'failed') }
  await db
    .prepare(`UPDATE account_deletions SET report = json_set(report, '$.adsPaused', ?3, '$.adsPending', json(?4), '$.billingEnds', json(?5), '$.billingError', ?6) WHERE customer = ?1 AND ${OPEN} AND next_attempt_at > ?2`)
    .bind(id, now, next.adsPaused, String(next.adsPending), String(next.billingEnds), next.billingError)
    .run()
  return next
}

// Undo within the window. The plan stays set to end: charging again takes the owner's own "Keep my plan". Ads stay paused.
export async function cancelDeletion(env, id, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  // One transaction, every part under the same condition, the record last: never half undone.
  // Also after the date while deletion is switched off (nothing can run then, so nobody is stranded). Never a restored one.
  const can = `${OPEN} AND attempts = 0 AND json_extract(report, '$.scheduledFor') IS NOT NULL AND requested_by <> 'system:restore' AND (next_attempt_at > ?2 OR ?3 = 1)`
  const off = deletionEnabled(env) ? 0 : 1
  const cond = `EXISTS (SELECT 1 FROM account_deletions WHERE customer = ?1 AND ${can}`
  const done = await db.batch([
    db.prepare(`UPDATE customers SET status = 'active', updated_at = ?2 WHERE id = ?1 AND status = 'suspended' AND ${cond} AND json_extract(report, '$.wasStatus') = 'active')`).bind(id, now, off),
    // Reminders stopped by the closing that are still due later are put back.
    db.prepare(`UPDATE messages SET status = 'scheduled', error = NULL, updated_at = ?2 WHERE customer = ?1 AND status = 'skipped' AND error = 'account_closing' AND send_at > ?2 AND ${cond})`).bind(id, now, off),
    db.prepare(`DELETE FROM account_deletions WHERE customer = ?1 AND ${can}`).bind(id, now, off),
  ])
  if (!done.at(-1)?.meta?.changes) return { ok: false, error: 'not_scheduled' }
  await recordEvent(db, { type: 'account.deletion_withdrawn', actorType: actor.type, actor: actor.type === 'owner' ? `owner:${actor.id}` : actor.id, ...ev(id, 'success'), at: now })
  return { ok: true }
}

// ---------- steps ----------
async function lockout(env, id, now) {
  const db = env.ONBOARDING_DB
  await db.prepare("UPDATE customers SET status = 'suspended', updated_at = ?2 WHERE id = ?1").bind(id, now).run()
  // Members are signed out everywhere (an email belongs to one business). A platform admin who is also a member keeps theirs.
  const admins = adminEmails(env)
  const sessions = await db
    .prepare(`DELETE FROM sessions WHERE email IN (SELECT email FROM customer_users WHERE customer = ?1)${admins.length ? ` AND lower(email) NOT IN (${admins.map((_, i) => `?${i + 2}`).join(', ')})` : ''}`)
    .bind(id, ...admins)
    .run()
  const members = await db.prepare('DELETE FROM customer_users WHERE customer = ?1').bind(id).run()
  const messages = await db.prepare("UPDATE messages SET status = 'skipped', error = 'account_deleted', updated_at = ?2 WHERE customer = ?1 AND status IN ('scheduled', 'sending')").bind(id, now).run()
  const invites = await db.prepare('UPDATE account_invites SET revoked_at = coalesce(revoked_at, ?2) WHERE customer = ?1').bind(id, now).run()
  await db.prepare("DELETE FROM email_outbox WHERE customer = ?1 AND status = 'pending'").bind(id).run()
  // The hosted website goes offline now (suspension already stops serving; this also clears the published version).
  const site = await db.prepare('UPDATE websites SET live_version = NULL, published_at = NULL, updated_at = ?2 WHERE customer = ?1 AND live_version IS NOT NULL').bind(id, now).run()
  return { websiteUnpublished: site.meta.changes > 0, membersRemoved: members.meta.changes, sessionsEnded: sessions.meta.changes, messagesCancelled: messages.meta.changes, invitesRevoked: invites.meta.changes }
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
  // A live subscription can't be ended, or seen to have ended, with a test key or the wrong Stripe account.
  if (stripeModeMismatch(env, sub)) throw step('stripe_mode_mismatch')
  const r = await endBillingNow(env, { stripeCustomerId: sub.stripeCustomerId, stripeSubscriptionId: sub.stripeSubscriptionId, mustExist: sub.livemode === true })
  if (!r.ok) throw step(`stripe_${r.error}`)
  return { canceled: r.canceled, notFound: r.notFound, customerDeleted: r.customerDeleted }
}

async function integrations(env, id) {
  const kv = env.GOOGLE_TOKENS
  const out = { calendar: false, googleRevoked: false, archives: 0, ads: [], ghl: false, domain: null, creatives: 0, twilio: null }
  // The business's own Twilio subaccount is closed (Twilio releases its numbers); never the parent account.
  const tw = await closeSubaccount(env, id).catch(() => ({ ok: false, error: 'storage_error' }))
  if (!tw.ok) throw step(`twilio_${tw.error}`)
  out.twilio = tw.skipped ? null : 'closed'
  for (const platform of ['google', 'meta', 'gbp', 'openai']) {
    if (await kv.get(`ads:${platform}:${id}`)) out.ads.push(platform)
    await forgetConnection(env, platform, id)
  }
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
  for (const key of [`google:${id}`, `ads:google:${id}`, `ads:meta:${id}`, `ads:gbp:${id}`, `ads:openai:${id}`, `ghl:${id}`]) if (await kv.get(key)) left[key.split(':')[0] + (key.startsWith('ads') ? `:${key.split(':')[1]}` : '')] = 1
  if ((await kv.list({ prefix: `google-archive:${id}:` })).keys.length) left['google-archive'] = 1
  const sub = await getSubscription(db, id)
  if (sub?.stripeSubscriptionId && stripeConfigured(env) && stripeModeMismatch(env, sub)) left.stripe = 'mode_mismatch'
  else if (sub?.stripeSubscriptionId && stripeConfigured(env)) {
    const r = await subscriptionEnded(env, sub.stripeSubscriptionId, { mustExist: sub.livemode === true }) // read-only confirmation
    if (!r.ok) left.stripe = r.error
    else if (!r.ended) left.stripe = 'not_canceled'
  }
  if (Object.keys(left).length) throw step('residual_data', { left })
  // Outside the database on purpose, and before the job can be called completed: a database restored to before the
  // deletion can't bring the business back (replayRestored).
  await kv.put(`deleted:${id}`, JSON.stringify({ at: Date.now() }))
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

// A damaged report loses its notes, never the job.
const parsed = (v) => {
  try {
    const o = JSON.parse(v || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
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
  const report = parsed(job.report)
  if (job.step === 'lockout' && report.scheduledFor > now) return { status: 'scheduled', scheduledFor: report.scheduledFor, report: await holdForRecovery(env, customerId, report, now) }
  // Reclassified as ours since it was asked: held, not deleted (an admin undoes it, or reclassifies on purpose).
  if (job.step === 'lockout' && !report.claimed && job.requested_by !== 'system:restore' && (await protectedBusiness(env, customerId))) {
    await db.prepare("UPDATE account_deletions SET last_error = 'protected_business', next_attempt_at = ?2 WHERE customer = ?1 AND status = 'in_progress' AND next_attempt_at = ?3").bind(customerId, now + 86400000, job.next_attempt_at).run()
    return { status: 'in_progress', step: 'lockout', error: 'protected_business' }
  }
  // Claimed before anything is changed: an undo can no longer succeed after this, and a job that was undone stops here.
  report.claimed = now
  const claimed = await db.prepare("UPDATE account_deletions SET report = json_set(CASE WHEN json_valid(report) THEN report ELSE '{}' END, '$.claimed', ?2) WHERE customer = ?1 AND status = 'in_progress' AND step = ?3 AND requested_at = ?4 AND next_attempt_at = ?5 RETURNING customer").bind(customerId, now, job.step, job.requested_at, job.next_attempt_at).first()
  if (!claimed) return { status: 'not_found' }
  let i = STEPS.indexOf(job.step)
  while (i >= 0 && i < STEPS.length) {
    const name = STEPS[i]
    try {
      report[name] = await RUN[name](env, customerId, now)
    } catch (err) {
      const code = /^[a-z_]{2,60}$/.test(err?.code || '') ? err.code : 'internal_error'
      if (!err?.code) console.error('deletion step failed:', name, err?.name)
      const attempts = job.step === name || name === 'verify' ? job.attempts + 1 : 1
      const wait = Math.min(MAX_BACKOFF_MS, 5 * 60 * 1000 * 2 ** Math.min(attempts - 1, 6))
      report[`${name}_error`] = { code, ...(err?.extra || {}) }
      // Something is still there (written late, or by this very failure): go back to the step that clears it, not to the
      // check that only finds it.
      const left = name === 'verify' ? Object.keys(err?.extra?.left || {}) : []
      const resume = !left.length ? name : left.includes('stripe') ? 'billing' : left.some((k) => /^(google|google-archive|ghl|ads(:.*)?)$/.test(k)) ? 'integrations' : 'data'
      await db
        .prepare('UPDATE account_deletions SET step = ?2, attempts = ?3, last_error = ?4, next_attempt_at = ?5, report = ?6 WHERE customer = ?1 AND status = \'in_progress\'')
        .bind(customerId, resume, attempts, code, now + wait, JSON.stringify(report))
        .run()
      await recordEvent(db, { type: 'account.deletion_step_failed', actor: 'system:deletion', ...ev(customerId, 'failure'), details: { step: name, code, attempts, nextAttemptAt: now + wait }, at: now })
      return { status: 'in_progress', step: name, error: code, attempts }
    }
    delete report[`${name}_error`]
    i++
    const next = STEPS[i] ?? 'done'
    const moved = await db
      .prepare(`UPDATE account_deletions SET step = ?2, attempts = 0, last_error = NULL, report = ?3${next === 'done' ? ", status = 'completed', completed_at = ?4" : ''} WHERE customer = ?1 AND status = 'in_progress'`)
      .bind(customerId, next, JSON.stringify(report), ...(next === 'done' ? [now] : []))
      .run()
    if (!moved.meta.changes) return { status: 'completed', step: 'done' } // another run finished it
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
  // Once an hour (a KV list): also while deletion is off, so a restore never puts a deleted business back online.
  const replayed = now % 3600000 < 300000 ? await replayRestored(env, now).catch(() => -1) : 0
  if (!deletionEnabled(env)) return { enabled: false, ...(replayed ? { replayed } : {}) }
  let rows
  try {
    // Recovery windows still open: whatever isn't stopped (a plan that would renew, also one resumed in Stripe; an ad) is
    // tried again. Random order, so ones that keep failing never starve the others.
    const waiting = (
      await env.ONBOARDING_DB.prepare(
        `SELECT d.customer, d.report FROM account_deletions d LEFT JOIN subscriptions s ON s.customer = d.customer
          WHERE d.status = 'in_progress' AND d.step = 'lockout' AND d.next_attempt_at > ?1 AND json_valid(d.report) AND json_extract(d.report, '$.scheduledFor') > ?1
            AND (coalesce(json_extract(d.report, '$.billingEnds'), 0) = 0 OR json_extract(d.report, '$.adsPending') = 1 OR (s.stripe_subscription_id IS NOT NULL AND s.status <> 'canceled' AND s.cancel_at_period_end = 0))
          ORDER BY random() LIMIT 5`,
      )
        .bind(now)
        .all()
    ).results
    for (const w of waiting) await holdForRecovery(env, w.customer, parsed(w.report), now).catch((err) => console.error('closing hold failed:', err?.name))
    rows = (await env.ONBOARDING_DB.prepare("SELECT customer FROM account_deletions WHERE status = 'in_progress' AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ?2").bind(now, limit).all()).results
  } catch (err) {
    if (err?.message?.includes('no such table')) return { enabled: true, advanced: 0 }
    throw err
  }
  let completed = 0
  let failed = 0
  for (const { customer } of rows) {
    // One that can't even be recorded waits an hour and never blocks the others.
    const r = await advanceDeletion(env, customer, now).catch(async (err) => {
      console.error('deletion run failed:', err?.name)
      await env.ONBOARDING_DB.prepare("UPDATE account_deletions SET next_attempt_at = ?2, last_error = 'internal_error' WHERE customer = ?1 AND status = 'in_progress'").bind(customer, now + 3600000).run().catch(() => {})
      return { error: 'internal_error' }
    })
    if (r.status === 'completed') completed++
    else if (r.error) failed++
  }
  return { enabled: true, advanced: rows.length, completed, failed, ...(replayed ? { replayed } : {}) }
}

// A deleted business that is back as a normal record (the database was restored to an earlier point): offline at once
// (also while deletion is off) and, when deletion is on, the whole workflow runs again. Returns how many were found.
export async function replayRestored(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  let cursor
  let found = 0
  for (let page = 0; page < 20; page++) {
    const l = await env.GOOGLE_TOKENS.list({ prefix: 'deleted:', cursor })
    const ids = l.keys.map((k) => k.name.slice('deleted:'.length))
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50)
      const { results } = await db.prepare(`SELECT c.id FROM customers c LEFT JOIN account_deletions d ON d.customer = c.id WHERE c.id IN (${part.map((_, j) => `?${j + 1}`).join(',')}) AND (c.name <> 'Deleted business' OR c.status <> 'suspended') AND (d.customer IS NULL OR d.status = 'completed' OR (d.step = 'lockout' AND d.requested_by <> 'system:restore'))`).bind(...part).all()
      for (const { id } of results) {
        // Deletion off: only taken offline. On: the workflow below erases it again.
        if (deletionEnabled(env)) await lockout(env, id, now)
        else await db.prepare("UPDATE customers SET status = 'suspended', updated_at = ?2 WHERE id = ?1").bind(id, now).run()
        await db
          .prepare("INSERT INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at, report) VALUES (?1, ?2, 'system:restore', 'in_progress', 'lockout', ?2, '{}') ON CONFLICT(customer) DO UPDATE SET requested_by = 'system:restore', status = 'in_progress', step = 'lockout', attempts = 0, completed_at = NULL, next_attempt_at = ?2, report = '{}'")
          .bind(id, now)
          .run()
        await recordEvent(db, { type: 'account.deletion_replayed', actor: 'system:deletion', ...ev(id, 'failure'), details: { reason: 'database_restored' }, at: now })
        found++
      }
    }
    if (l.list_complete || !l.cursor) break
    cursor = l.cursor
  }
  return found
}

// ---------- closing requests while deletion is switched off ----------
// The owner asks; a person at GetShowUps handles it (privacy policy: "we handle the request by hand"). Kept in the
// permanent log (codes only); open = asked and neither withdrawn nor resolved since.
const REQ = ['account.closure_requested', 'account.closure_withdrawn', 'account.closure_resolved']
export async function closureRequest(db, id) {
  const r = await db.prepare(`SELECT action, at FROM audit_log WHERE customer = ?1 AND action IN ('${REQ.join("','")}') ORDER BY seq DESC LIMIT 1`).bind(id).first()
  return r?.action === REQ[0] ? { at: r.at } : null
}
export async function setClosureRequest(env, id, kind, actor, details = {}, now = Date.now()) {
  const open = await closureRequest(env.ONBOARDING_DB, id)
  if ((kind === 'requested') === Boolean(open)) return { ok: false, error: open ? 'already_requested' : 'not_requested' }
  await recordEvent(env.ONBOARDING_DB, { type: `account.closure_${kind}`, actorType: actor.type, actor: actor.type === 'owner' ? `owner:${actor.id}` : actor.id, customer: id, capability: 'account.deletion', resource: { type: 'customer', id }, outcome: 'info', correlationId: `closure:${id}`, details, at: now })
  return { ok: true }
}
// Every closing request and deletion, for the platform console.
export async function closures(db) {
  const { results } = await db
    .prepare(`SELECT a.customer, a.at, c.name FROM audit_log a JOIN (SELECT customer, max(seq) AS seq FROM audit_log WHERE action IN ('${REQ.join("','")}') GROUP BY customer) m ON m.seq = a.seq LEFT JOIN customers c ON c.id = a.customer WHERE a.action = '${REQ[0]}' ORDER BY a.at LIMIT 100`)
    .all()
  const del = await db.prepare('SELECT d.customer, c.name, d.status, d.step, d.attempts, d.last_error, d.requested_at, d.next_attempt_at, d.completed_at, d.report FROM account_deletions d LEFT JOIN customers c ON c.id = d.customer ORDER BY d.requested_at DESC LIMIT 100').all()
  return {
    requests: results.filter((r) => !del.results.some((d) => d.customer === r.customer)).map((r) => ({ customer: r.customer, name: r.name, at: r.at })),
    deletions: del.results.map((d) => {
      const rep = parsed(d.report)
      const scheduled = d.status === 'in_progress' && d.step === 'lockout' && rep.scheduledFor && !rep.claimed && d.attempts === 0 ? rep.scheduledFor : null
      return { customer: d.customer, name: d.name, state: d.status === 'completed' ? 'completed' : scheduled ? 'scheduled' : d.last_error ? 'failed' : 'running', step: d.step, attempts: d.attempts, error: d.last_error, requestedAt: d.requested_at, completedAt: d.completed_at, scheduledFor: scheduled, nextAttemptAt: d.status === 'completed' ? null : d.next_attempt_at, billingError: rep.billingError ?? null, adsPending: rep.adsPending === true }
    }),
  }
}
