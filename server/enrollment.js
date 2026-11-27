// Assisted enrollment (migration 0047, docs/ASSISTED_ENROLLMENT.md): the founder or an authorized sales representative
// signs a business up on a call. ONE path into the same systems as self-service:
//   prospect   recorded details (no business yet)
//   workspace  createCustomer (no owner membership) + a self_signups row = an UNPAID self-serve business: not hosted,
//              not bookable, no paid tools (server/eligibility.js), no provider spend (business-accounts.js
//              assistedUnpaid), no public website, no AI website calls by staff
//   payment    Stripe-hosted Checkout through createCheckout (customer first, duplicate-subscription refusal, sandbox /
//              live rules unchanged); link copied or emailed through the outbox + launch gate
//   paid       ONLY Stripe's verified subscription event (webhook → syncEnrollmentFor); the view re-derives it from the
//              stored subscription, never from anything staff say
//   configure  the ordinary dashboard routes with a staff context (server/staff-context.js), audited
//   invite     the existing account invitation (server/accounts.js, kind 'claim'), bound to business + owner email
//   claimed    the owner signs in with the invited, verified email, accepts the terms and becomes the owner in one atomic
//              step; staff access ends
// Card data never enters GetShowUps: notes refuse anything that looks like a card number. Nothing is deleted
// automatically: an unpaid enrollment older than ABANDON_AFTER_DAYS is SHOWN as abandoned until staff resend or mark it.
import { randomToken } from './google-oauth.js'
import { EMAIL_RE, customerFromRow, siteOrigin } from './auth.js'
import { isValidTimeZone } from './calendar.js'
import { createCustomer, getCustomer, progress } from './customers.js'
import { normalizePhone, readiness, saveProfile } from './onboarding.js'
import { setupCheck } from './setup-check.js'
import { billingSubscription, createCheckout, listPlans } from './stripe.js'
import { enqueue } from './email.js'
import { claimBound, findActive, issueInvite, maskEmail, revokeInvite } from './accounts.js'
import { audit } from './platform.js'
import { recordEvent } from './auditlog.js'
import { track } from './events.js'
import { rolesOf } from './roles.js'
import { CONFIGURABLE_STAGES } from './staff-context.js'
import { attributeAssisted, phoneHook } from './enrollment-hooks.js'

// An unpaid enrollment this old is shown as abandoned (configurable here; documented in docs/ASSISTED_ENROLLMENT.md).
export const ABANDON_AFTER_DAYS = 14
// The version of the handoff terms the owner accepts on /claim (src/claim/Claim.jsx shows the text; bump both together).
export const CLAIM_TERMS_VERSION = 'assisted-claim-2026-11-26'
export const STAGES = ['prospect', 'payment_sent', 'paid', 'configuring', 'ready', 'invited', 'claimed', 'abandoned']
const PAID = ['active', 'trialing', 'past_due']
const DAY = 86_400_000
const ID_RE = /^enr_[A-Za-z0-9_-]{16}$/
const noTable = (err) => /no such table/i.test(String(err?.message || ''))
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const fail = (httpStatus, error, extra = {}) => ({ ok: false, httpStatus, error, ...extra })

// Card numbers never enter GetShowUps (not in notes, not in any field): any run of 13–19 digits, with or without
// spaces or dashes, is refused before storage. (Phone numbers are at most 15 digits with a country code and are
// entered in their own field, which takes 10–11 digits only.)
export const looksLikeCard = (text) => /(?:\d[ -]?){12,18}\d/.test(String(text ?? ''))

export async function enrollmentsReady(db) {
  try {
    await db.prepare('SELECT 1 FROM assisted_enrollments LIMIT 1').first()
    return true
  } catch (err) {
    if (noTable(err)) return false
    throw err
  }
}

// Returns [error, value]. Every text field is checked for card data.
export function validateProspect(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const raw = ['businessName', 'ownerName', 'ownerEmail', 'phone', 'notes', 'timezone', 'planId', 'assignedRepEmail'].map((k) => b[k])
  if (raw.some(looksLikeCard)) return ['card_data_refused']
  const v = {
    businessName: clean(b.businessName, 120),
    ownerName: clean(b.ownerName, 120),
    ownerEmail: String(b.ownerEmail ?? '').trim().toLowerCase(),
    phone: b.phone ? normalizePhone(b.phone) : '',
    notes: String(b.notes ?? '').replace(/\r/g, '').trim().slice(0, 2000),
    timezone: String(b.timezone || 'America/New_York'),
    planId: b.planId ? String(b.planId).slice(0, 40) : null,
  }
  if (!partial || b.businessName !== undefined) if (v.businessName.length < 2 || v.businessName.length > 80) return ['invalid_name']
  if (v.ownerName.length > 80) return ['invalid_owner_name']
  if (!partial || b.ownerEmail !== undefined) if (!EMAIL_RE.test(v.ownerEmail)) return ['invalid_email']
  if (v.phone === null) return ['invalid_phone']
  if (!isValidTimeZone(v.timezone)) return ['invalid_timezone']
  return [null, v]
}

// ---------- access ----------
// Who may do what (checked on every call; roles are read fresh by the route through requireRole):
//   platform admin   everything, every enrollment
//   sales_rep        own (assigned) enrollments only: view, edit, workspace, payment, configure, invite, abandon
//   onboarding       any enrollment before the handoff: view, configure, invite (never payment, assignment or roles)
const REP_ACTIONS = ['view', 'edit', 'workspace', 'payment', 'configure', 'invite', 'abandon']
const ONBOARDING_ACTIONS = ['view', 'configure', 'invite']
export function may(staff, row, action) {
  if (!staff || !row) return false
  if (staff.roles.has('platform_admin')) return true
  if (staff.roles.has('sales_rep') && row.assigned_rep_email === staff.email && REP_ACTIONS.includes(action)) return true
  if (staff.roles.has('onboarding') && ONBOARDING_ACTIONS.includes(action)) return action === 'view' || CONFIGURABLE_STAGES.includes(row.stage)
  return false
}
const visibleSql = (staff) =>
  staff.roles.has('platform_admin') || staff.roles.has('onboarding') ? { where: '1 = 1', args: [] } : { where: 'assigned_rep_email = ?1', args: [staff.email] }

async function load(db, id) {
  if (!ID_RE.test(String(id || ''))) return null
  return db.prepare('SELECT * FROM assisted_enrollments WHERE id = ?1').bind(id).first()
}
// One enrollment the staff member may act on, or a refusal. A row they may not see answers not_found (no enumeration).
async function forAction(env, staff, id, action) {
  const db = env.ONBOARDING_DB
  if (!(await enrollmentsReady(db))) return { error: fail(503, 'migration_required') }
  const row = await load(db, id)
  if (!row || !may(staff, row, 'view')) return { error: fail(404, 'not_found') }
  if (!may(staff, row, action)) return { error: fail(403, 'forbidden_role') }
  return { row }
}

// ---------- facts + stage ----------
async function inviteState(db, row, now) {
  if (!row.invite_id) return { state: 'none' }
  const r = await db.prepare('SELECT created_at, expires_at, accepted_at, revoked_at, sent_count FROM account_invites WHERE id = ?1').bind(row.invite_id).first()
  if (!r) return { state: 'none' }
  const state = r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expires_at <= now ? 'expired' : 'pending'
  return { state, sentAt: r.created_at, expiresAt: r.expires_at }
}

async function facts(env, row, now) {
  const db = env.ONBOARDING_DB
  if (!row.customer) return { customer: null, paid: false, sub: null, invite: { state: 'none' } }
  const customer = customerFromRow(await getCustomer(db, row.customer))
  const sub = customer ? await billingSubscription(env, row.customer) : null
  return { customer, sub, paid: Boolean(sub && PAID.includes(sub.status)), invite: await inviteState(db, row, now) }
}

// The stage the records say. claimed is final; 'paid' and later need the verified subscription.
export function deriveStage(row, { paid, ready, invite }) {
  if (row.stage === 'claimed') return 'claimed'
  if (!paid) {
    if (row.stage === 'abandoned') return 'abandoned'
    return row.payment_sent_at ? 'payment_sent' : 'prospect'
  }
  if (row.invite_id && invite?.state !== 'none') return 'invited'
  if (ready) return 'ready'
  return row.config_started_at ? 'configuring' : 'paid'
}
export const isStale = (row, stage, now = Date.now()) => ['prospect', 'payment_sent'].includes(stage) && now - row.created_at > ABANDON_AFTER_DAYS * DAY

// Persists the derived stage (and paid_at) so lists and reports read the same thing. Never moves a claimed row.
async function persistStage(db, row, stage, paid, now) {
  if (stage === row.stage && (!paid || row.paid_at)) return row
  await db
    .prepare("UPDATE assisted_enrollments SET stage = ?2, paid_at = CASE WHEN ?3 = 1 THEN coalesce(paid_at, ?4) ELSE paid_at END, abandoned_at = CASE WHEN ?3 = 1 THEN NULL ELSE abandoned_at END, updated_at = ?4 WHERE id = ?1 AND stage <> 'claimed'")
    .bind(row.id, stage, paid ? 1 : 0, now)
    .run()
  return { ...row, stage, paid_at: paid ? row.paid_at || now : row.paid_at }
}

// Called by the Stripe webhook after a verified subscription event (server/stripe.js handleEvent). Fail-soft.
export async function syncEnrollmentFor(env, customerId, now = Date.now()) {
  const db = env.ONBOARDING_DB
  let row
  try {
    row = await db.prepare('SELECT * FROM assisted_enrollments WHERE customer = ?1').bind(customerId).first()
  } catch (err) {
    if (noTable(err)) return null
    throw err
  }
  if (!row || row.stage === 'claimed') return null
  const f = await facts(env, row, now)
  const ready = f.paid ? (await checklist(env, row, f, now)).ready : false
  const stage = deriveStage(row, { paid: f.paid, ready, invite: f.invite })
  const updated = await persistStage(db, row, stage, f.paid, now)
  if (f.paid && !row.paid_at) await recordEvent(db, { type: 'enrollment.paid', actor: 'stripe', customer: customerId, capability: 'billing.stripe', resource: { type: 'enrollment', id: row.id }, outcome: 'success', details: { from: row.stage } })
  return updated.stage
}

// ---------- readiness checklist ----------
// The SAME definitions as self-service: the onboarding steps (server/onboarding.js onboardingSteps via progress), the
// launch readiness rows (readiness) and the setup check (server/setup-check.js), plus payment, invitation and phone.
// required = what must be true before the ownership invitation: paid, business details, services, booking hours.
const REQUIRED_STEPS = ['details', 'services', 'hours']
const STEP_LABELS = { details: 'Business details', services: 'Services and prices', calendar: 'Google Calendar (the owner connects it)', hours: 'Booking hours', website: 'Website', address: 'Website address', publish: 'Website published' }
export async function checklist(env, row, f, now = Date.now()) {
  if (!f.customer) return { items: [], ready: false, setupChecks: [], phone: await phoneHook(env, null).catch(() => null) }
  const calendar = Boolean(await env.GOOGLE_TOKENS.get(`google:${f.customer.id}`))
  const p = await progress(env, f.customer)
  const items = [{ id: 'payment', label: 'Subscription paid (Stripe)', state: f.paid ? 'ok' : 'action', detail: f.sub?.status || 'not_started', required: true }]
  for (const s of p.steps) {
    if (s.id === 'business' || s.id === 'payment' || s.id === 'launch') continue
    items.push({ id: s.id, label: STEP_LABELS[s.id] || s.id, state: s.done ? 'ok' : 'action', required: REQUIRED_STEPS.includes(s.id) })
  }
  const launch = await readiness(env, f.customer, { calendarStatus: calendar ? 'healthy' : 'not_connected', origin: siteOrigin(env) }).catch(() => null)
  const rec = launch?.items.find((i) => i.id === 'receptionist')
  if (rec) items.push({ id: 'receptionist', label: 'AI receptionist (the owner turns it on)', state: rec.state, detail: rec.detail, required: false })
  const checks = await setupCheck(env, f.customer, now).catch(() => [])
  const phone = await phoneHook(env, f.customer.id).catch(() => ({ state: 'not_available', label: 'Phone: not available yet' }))
  items.push({ id: 'phone', label: phone?.label || 'Phone', state: phone?.state === 'ready' ? 'ok' : 'off', detail: phone?.state || 'not_available', required: false, ...(phone?.href ? { href: phone.href } : {}) })
  items.push({ id: 'invitation', label: 'Ownership invitation', state: f.invite.state === 'accepted' ? 'ok' : f.invite.state === 'pending' ? 'pending' : 'action', detail: f.invite.state, required: false })
  return {
    items,
    ready: items.filter((i) => i.required).every((i) => i.state === 'ok'),
    setupChecks: (Array.isArray(checks) ? checks : []).filter((c) => c.level === 'critical' || c.level === 'important').map((c) => ({ id: c.id, level: c.level, title: c.title })),
    phone,
  }
}

// ---------- views ----------
function viewOf(row, stage, now) {
  return {
    id: row.id,
    customer: row.customer,
    businessName: row.business_name,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    phone: row.phone,
    timezone: row.timezone,
    notes: row.notes,
    planId: row.plan_id,
    assignedRep: row.assigned_rep_email,
    stage,
    stale: isStale(row, stage, now),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paymentSentAt: row.payment_sent_at,
    paymentSends: row.payment_sends,
    paidAt: row.paid_at,
    invitedAt: row.invited_at,
    claimedAt: row.claimed_at,
    abandonedAt: row.abandoned_at,
  }
}

export async function listEnrollments(env, staff, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await enrollmentsReady(db))) return { ready: false, enrollments: [] }
  const { where, args } = visibleSql(staff)
  const { results } = await db.prepare(`SELECT * FROM assisted_enrollments WHERE ${where} ORDER BY updated_at DESC LIMIT 200`).bind(...args).all()
  return { ready: true, enrollments: results.map((r) => viewOf(r, r.stage, now)) }
}

export async function enrollmentDetail(env, staff, id, now = Date.now()) {
  const { row: r0, error } = await forAction(env, staff, id, 'view')
  if (error) return error
  const f = await facts(env, r0, now)
  const list = await checklist(env, r0, f, now)
  const stage = deriveStage(r0, { paid: f.paid, ready: list.ready, invite: f.invite })
  const row = await persistStage(env.ONBOARDING_DB, r0, stage, f.paid, now)
  return {
    ok: true,
    enrollment: viewOf(row, stage, now),
    payment: { paid: f.paid, status: f.sub?.status ?? null, sentAt: row.payment_sent_at, sends: row.payment_sends },
    invitation: f.invite,
    checklist: list,
    configureUrl: row.customer && CONFIGURABLE_STAGES.includes(stage) ? `/dashboard?enrollment=${row.id}` : null,
    previewUrl: row.customer && CONFIGURABLE_STAGES.includes(stage) ? `/api/dashboard/website/preview?enrollment=${row.id}` : null,
    can: Object.fromEntries(['edit', 'workspace', 'payment', 'configure', 'invite', 'abandon', 'assign'].map((a) => [a, may(staff, row, a)])),
  }
}

// ---------- actions ----------
export async function createEnrollment(env, staff, body, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!staff.roles.has('platform_admin') && !staff.roles.has('sales_rep')) return fail(403, 'forbidden_role')
  if (!(await enrollmentsReady(db))) return fail(503, 'migration_required')
  const [err, v] = validateProspect(body)
  if (err) return fail(400, err)
  const plans = await listPlans(db)
  const planId = v.planId && plans.some((p) => p.id === v.planId) ? v.planId : plans[0]?.id ?? null
  // A representative's prospects are theirs; the founder may assign one to an active representative (or keep it).
  let rep = staff.roles.has('platform_admin') ? null : staff.email
  if (staff.roles.has('platform_admin') && body?.assignedRepEmail) {
    const want = String(body.assignedRepEmail).trim().toLowerCase()
    if (!(await rolesOf(env, want)).has('sales_rep')) return fail(400, 'not_a_rep')
    rep = want
  }
  const id = `enr_${randomToken(12)}`
  await db
    .prepare(
      `INSERT INTO assisted_enrollments (id, business_name, owner_name, owner_email, phone, timezone, notes, plan_id, assigned_rep_email, stage, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'prospect', ?10, ?11, ?11)`,
    )
    .bind(id, v.businessName, v.ownerName, v.ownerEmail, v.phone || '', v.timezone, v.notes, planId, rep, staff.email, now)
    .run()
  await audit(env, staff.email, 'enrollment.created', null, { enrollment: id, assigned: rep ? 'rep' : 'founder', plan: planId })
  return { ok: true, id }
}

export async function updateProspect(env, staff, id, body, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'edit')
  if (error) return error
  if (row.stage === 'claimed') return fail(409, 'already_claimed')
  const [err, v] = validateProspect({ businessName: row.business_name, ownerEmail: row.owner_email, ...body }, { partial: true })
  if (err) return fail(400, err)
  // The owner email is bound into the ownership invitation: once one is out, it changes only by revoking it first.
  if (v.ownerEmail !== row.owner_email && row.invite_id && (await inviteState(env.ONBOARDING_DB, row, now)).state === 'pending') return fail(409, 'invitation_pending')
  const plans = await listPlans(env.ONBOARDING_DB)
  const planId = row.customer ? row.plan_id : v.planId && plans.some((p) => p.id === v.planId) ? v.planId : row.plan_id
  await env.ONBOARDING_DB.prepare('UPDATE assisted_enrollments SET business_name = ?2, owner_name = ?3, owner_email = ?4, phone = ?5, notes = ?6, plan_id = ?7, timezone = ?8, updated_at = ?9 WHERE id = ?1')
    .bind(row.id, row.customer ? row.business_name : v.businessName, v.ownerName, v.ownerEmail, v.phone || '', v.notes, planId, row.customer ? row.timezone : v.timezone, now)
    .run()
  await audit(env, staff.email, 'enrollment.updated', row.customer, { enrollment: row.id })
  return { ok: true }
}

export async function assignEnrollment(env, staff, id, repEmail, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'assign')
  if (error) return error
  if (row.stage === 'claimed') return fail(409, 'already_claimed')
  const want = repEmail ? String(repEmail).trim().toLowerCase() : null
  if (want && !(await rolesOf(env, want)).has('sales_rep')) return fail(400, 'not_a_rep')
  await env.ONBOARDING_DB.prepare('UPDATE assisted_enrollments SET assigned_rep_email = ?2, updated_at = ?3 WHERE id = ?1').bind(row.id, want, now).run()
  await audit(env, staff.email, 'enrollment.assigned', row.customer, { enrollment: row.id, to: want })
  return { ok: true }
}

// "Create workspace": the business through the ordinary path, no owner membership, billed (self_signups row with the
// chosen plan) so it stays unpaid until Stripe confirms. One workspace per enrollment (claimed atomically first).
export async function createWorkspace(env, staff, id, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'workspace')
  if (error) return error
  const db = env.ONBOARDING_DB
  if (row.customer || row.workspace_at) return fail(409, 'workspace_exists')
  if (row.stage === 'claimed') return fail(409, 'already_claimed')
  const plan = row.plan_id ? (await listPlans(db)).find((p) => p.id === row.plan_id) : null
  if (!plan) return fail(409, 'plan_required')
  const claim = await db.prepare('UPDATE assisted_enrollments SET workspace_at = ?2, updated_at = ?2 WHERE id = ?1 AND workspace_at IS NULL AND customer IS NULL').bind(row.id, now).run()
  if (!claim.meta?.changes) return fail(409, 'workspace_exists')
  let customerId
  try {
    customerId = await createCustomer(env, null, { name: row.business_name.slice(0, 80), timezone: row.timezone, serviceZips: [], appointmentMode: 'at_business' }, { source: 'assisted', via: 'admin_invite', planId: plan.id }, now)
  } catch (err) {
    await db.prepare('UPDATE assisted_enrollments SET workspace_at = NULL WHERE id = ?1 AND customer IS NULL').bind(row.id).run()
    throw err
  }
  await db.prepare('UPDATE assisted_enrollments SET customer = ?2, updated_at = ?3 WHERE id = ?1').bind(row.id, customerId, now).run()
  // What the owner already said on the call is not asked again: the phone number goes into the business details.
  if (row.phone) await saveProfile(db, customerId, { phone: row.phone, industry: '', description: '', services: [], cities: [] }, now)
  await attributeAssisted(env, customerId, { channel: row.assigned_rep_email ? 'sales_rep' : 'founder', repEmail: row.assigned_rep_email || staff.email }, now).catch(() => null)
  await audit(env, staff.email, 'enrollment.workspace_created', customerId, { enrollment: row.id, plan: plan.id })
  return { ok: true, customer: customerId }
}

// The authorization the owner sees on Stripe's page, next to Stripe's own price and frequency (no invented price).
const authorizationText = (businessName) =>
  `By subscribing you authorize GetShowUps to charge the price shown above to this card every month for ${businessName.slice(0, 80)} until you cancel. You can cancel any time from Billing in your GetShowUps dashboard; your plan then runs to the end of the period you paid for.`

export async function sendPaymentLink(env, staff, id, { email = false } = {}, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'payment')
  if (error) return error
  const db = env.ONBOARDING_DB
  if (!row.customer) return fail(409, 'workspace_required')
  if (row.stage === 'claimed') return fail(409, 'already_claimed')
  const f = await facts(env, row, now)
  if (f.paid) return fail(409, 'already_paid')
  const origin = siteOrigin(env)
  const r = await createCheckout(env, {
    customer: { id: row.customer },
    email: row.owner_email,
    planId: row.plan_id,
    origin,
    assisted: { enrollment: row.id, success: '/claim?paid=1', cancel: '/claim?paid=0', authorization: authorizationText(row.business_name) },
  })
  if (!r.ok) return fail(r.httpStatus && r.httpStatus >= 400 && r.httpStatus < 500 ? (r.httpStatus === 404 ? 409 : r.httpStatus) : 502, r.error === 'use_portal' ? 'subscription_exists' : r.error)
  const sends = (row.payment_sends || 0) + 1
  await db
    .prepare("UPDATE assisted_enrollments SET payment_sent_at = ?2, payment_sends = ?3, stage = CASE WHEN stage IN ('prospect', 'abandoned') THEN 'payment_sent' ELSE stage END, abandoned_at = NULL, updated_at = ?2 WHERE id = ?1")
    .bind(row.id, now, sends)
    .run()
  let emailed = false
  if (email) {
    // Through the outbox: delivered only by the configured provider and the launch gate (MESSAGE_TEST_RECIPIENTS until live).
    emailed = await enqueue(env, {
      id: `enrollment-payment:${row.id}:${sends}`,
      to: row.owner_email,
      customer: row.customer,
      template: 'assisted_payment',
      subject: `Complete your GetShowUps subscription for ${row.business_name.slice(0, 80)}`,
      body: `Here is the secure Stripe page to start your GetShowUps subscription for ${row.business_name.slice(0, 80)}:\n${r.url}\n\nStripe shows the price and billing frequency before you pay. GetShowUps never sees your card details.`,
    }, now)
  }
  await audit(env, staff.email, 'enrollment.payment_link', row.customer, { enrollment: row.id, emailed, resumed: Boolean(r.resumed), sends })
  return { ok: true, url: r.url, emailed }
}

export async function markAbandoned(env, staff, id, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'abandon')
  if (error) return error
  const f = await facts(env, row, now)
  if (f.paid || row.stage === 'claimed') return fail(409, 'already_paid')
  await env.ONBOARDING_DB.prepare("UPDATE assisted_enrollments SET stage = 'abandoned', abandoned_at = ?2, updated_at = ?2 WHERE id = ?1 AND stage <> 'claimed'").bind(row.id, now).run()
  if (row.invite_id) await revokeInvite(env.ONBOARDING_DB, row.invite_id, now)
  await audit(env, staff.email, 'enrollment.abandoned', row.customer, { enrollment: row.id })
  return { ok: true }
}

// Ownership invitation: only once paid and the required setup is done. Resend = a new invitation (the previous one is
// revoked by issueInvite). The email goes through the outbox + launch gate; the link is also returned for the call.
export async function sendInvitation(env, staff, id, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'invite')
  if (error) return error
  if (row.stage === 'claimed') return fail(409, 'already_claimed')
  if (!row.customer) return fail(409, 'workspace_required')
  const f = await facts(env, row, now)
  if (!f.paid) return fail(409, 'payment_required')
  const list = await checklist(env, row, f, now)
  if (!list.ready) return fail(409, 'not_ready', { missing: list.items.filter((i) => i.required && i.state !== 'ok').map((i) => i.id) })
  const db = env.ONBOARDING_DB
  const member = await db.prepare('SELECT 1 FROM customer_users WHERE customer = ?1 LIMIT 1').bind(row.customer).first()
  if (member) return fail(409, 'already_claimed')
  const inv = await issueInvite(env, { email: row.owner_email, customer: row.customer, businessName: f.customer.name, actor: staff.email, kind: 'claim' }, now)
  await db.prepare("UPDATE assisted_enrollments SET invite_id = ?2, invited_at = ?3, stage = 'invited', updated_at = ?3 WHERE id = ?1 AND stage <> 'claimed'").bind(row.id, inv.id, now).run()
  await audit(env, staff.email, 'enrollment.invitation_sent', row.customer, { enrollment: row.id, resend: Boolean(row.invite_id) })
  return { ok: true, url: inv.url, expiresAt: inv.expiresAt }
}

export async function revokeInvitation(env, staff, id, now = Date.now()) {
  const { row, error } = await forAction(env, staff, id, 'invite')
  if (error) return error
  if (!row.invite_id) return fail(409, 'no_invitation')
  const revoked = await revokeInvite(env.ONBOARDING_DB, row.invite_id, now)
  if (!revoked) return fail(409, 'no_invitation')
  await audit(env, staff.email, 'enrollment.invitation_revoked', row.customer, { enrollment: row.id })
  return { ok: true }
}

// ---------- ownership claim (public page /claim; the signed-in session's VERIFIED email decides) ----------
async function claimRows(db, token, now) {
  const invite = await findActive(db, token, now)
  if (!invite || !(await claimBound(db, invite.id))) return null
  const enrollment = await db.prepare('SELECT * FROM assisted_enrollments WHERE invite_id = ?1').bind(invite.id).first()
  return enrollment ? { invite, enrollment } : null
}

// What the claim page shows. Same 404 for unknown, expired, revoked and used links. The invited address is masked; the
// signed-in person sees only their own address.
export async function peekClaim(env, token, session, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await enrollmentsReady(db))) return null
  const found = await claimRows(db, token, now)
  if (!found) return null
  const { invite } = found
  const base = { businessName: invite.business_name, email: maskEmail(invite.email), termsVersion: CLAIM_TERMS_VERSION }
  if (!session) return { ...base, state: 'signed_out' }
  if (session.email !== invite.email) return { ...base, state: 'wrong_account', signedInAs: session.email }
  if (session.customer) return { ...base, state: 'has_business', signedInAs: session.email, ownBusiness: session.customer.name }
  return { ...base, state: 'ready', signedInAs: session.email }
}

export async function claimBusiness(env, { token, session, acceptTerms, termsVersion }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await enrollmentsReady(db))) return fail(404, 'invite_invalid')
  const found = await claimRows(db, token, now)
  if (!found) return fail(404, 'invite_invalid')
  const { invite, enrollment } = found
  if (enrollment.stage === 'claimed' || enrollment.stage === 'abandoned') return fail(404, 'invite_invalid')
  // Binding: the verified signed-in email must be the invited one. Never linked by name or a typed address.
  if (session.email !== invite.email) return fail(409, 'wrong_account', { expected: maskEmail(invite.email) })
  // An email that already owns a business keeps it; nothing is merged.
  if (session.customer) return fail(409, 'already_in_business')
  if (acceptTerms !== true || termsVersion !== CLAIM_TERMS_VERSION) return fail(400, 'terms_required')
  if (await db.prepare('SELECT 1 FROM customer_users WHERE customer = ?1 LIMIT 1').bind(enrollment.customer).first()) return fail(409, 'already_claimed')
  const sub = await billingSubscription(env, enrollment.customer)
  if (!sub || !PAID.includes(sub.status)) return fail(409, 'payment_required')
  // The owner lands on the configured dashboard: when everything but the final screen is done, onboarding is finished
  // in the same step (otherwise they continue at the first step that isn't done; nothing done is asked again).
  const customer = customerFromRow(await getCustomer(db, enrollment.customer))
  const steps = (await progress(env, customer)).steps
  const finished = steps.filter((s) => s.id !== 'launch').every((s) => s.done)
  const gate = 'EXISTS (SELECT 1 FROM assisted_enrollments WHERE id = ?1 AND claimed_at = ?2 AND claimed_by = ?3)'
  try {
    await db.batch([
      db
        .prepare("UPDATE assisted_enrollments SET stage = 'claimed', claimed_at = ?2, claimed_by = ?3, terms_version = ?5, terms_accepted_at = ?2, assignment_closed_at = ?2, updated_at = ?2 WHERE id = ?1 AND invite_id = ?4 AND claimed_at IS NULL AND stage <> 'claimed'")
        .bind(enrollment.id, now, session.email, invite.id, CLAIM_TERMS_VERSION),
      db.prepare(`INSERT INTO customer_users (email, customer, created_at) SELECT ?3, ?4, ?2 WHERE ${gate}`).bind(enrollment.id, now, session.email, enrollment.customer),
      db.prepare(`UPDATE account_invites SET accepted_at = ?2 WHERE id = ?4 AND accepted_at IS NULL AND ${gate}`).bind(enrollment.id, now, session.email, invite.id),
      ...(finished ? [db.prepare(`UPDATE self_signups SET onboarded_at = coalesce(onboarded_at, ?2), test_checked_at = coalesce(test_checked_at, ?2) WHERE customer = ?4 AND ${gate}`).bind(enrollment.id, now, session.email, enrollment.customer)] : []),
    ])
  } catch (err) {
    if (/UNIQUE|PRIMARY/i.test(String(err?.message))) return fail(409, 'already_in_business')
    throw err
  }
  const member = await db.prepare('SELECT 1 FROM customer_users WHERE email = ?1 AND customer = ?2').bind(session.email, enrollment.customer).first()
  if (!member) return fail(404, 'invite_invalid') // lost a race with another claim: nothing of ours was written
  await recordEvent(db, { type: 'enrollment.claimed', actorType: 'owner', actor: session.email, customer: enrollment.customer, capability: 'enrollment', resource: { type: 'enrollment', id: enrollment.id }, outcome: 'success', details: { termsVersion: CLAIM_TERMS_VERSION, onboarded: finished } })
  await track(env, 'invite_accepted', { id: `invite_accepted:${invite.id}`, customer: enrollment.customer, at: now })
  return { ok: true, customer: enrollment.customer, onboarded: finished }
}
