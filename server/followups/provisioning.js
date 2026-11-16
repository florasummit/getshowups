// Twilio A2P 10DLC provisioning for ONE business, inside its own Twilio subaccount (twilio.js). Each step is a separate,
// confirmed, audited platform-admin action (functions/api/platform/messaging.js); nothing runs by itself.
//
// Paths (registration.js pathFor, from the owner's business type; never assumed):
//   low_volume_standard — businesses with an EIN: Secondary Customer Profile (policy secondary) → A2P Trust Product
//                         (us_a2p_messaging_profile_information) → Brand (SkipAutomaticSecVet) → campaign LOW_VOLUME.
//   sole_proprietor     — no EIN: Starter Customer Profile → Sole Proprietor Trust Product (sole_proprietor_information)
//                         → Brand SOLE_PROPRIETOR (Twilio texts the owner a one-time code; resend_otp) → campaign
//                         SOLE_PROPRIETOR (1 campaign, 1 number).
// Sources: twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api and …/onboarding-isv-api-sole-prop-new.
//
// Safety: steps that SUBMIT to Twilio/carriers or CHARGE money need TWILIO_REGISTRATION_SUBMIT === 'true' (release
// switch, approval) AND `approve: true` on that request (the founder's explicit yes for that step). Every provider
// object is recorded (sms_provider_objects); a request whose outcome is unknown is recorded without a SID and never
// repeated until an admin checks Twilio and clears it (`clear_unknown`). The registration only becomes 'approved' when
// Twilio reports the campaign VERIFIED (sync); nothing is inferred.
import { accountsReady, ensureSubaccount, parentAuth, parentConfigured, subaccountAuth, twilioRequest } from './twilio.js'
import { getRegistration, MESSAGE_FLOW, SAMPLES, USE_CASE } from './registration.js'
import { followupsReady } from './settings.js'
import { siteOrigin } from '../auth.js'
import { getProfile } from '../onboarding.js'
import { toE164 } from '../sms.js'

export const POLICIES = {
  secondary: 'RNdfbf3fae0e1107f8aded0e7cead80bf5', // Secondary Customer Profile (ISV client with an EIN)
  starter: 'RN806dd6cd175f314e1f96a9727ee271f4', // Starter Customer Profile (sole proprietor)
  a2p: 'RNb0d4771c2c98518d916a3d4cd70a8f8b', // A2P Messaging Profile trust product (standard / low-volume standard)
  soleProp: 'RN670d5d2e282a6130ae063b234b6019c8', // Sole Proprietor A2P trust product
}
const BUSINESS_TYPE = { llc: 'Limited Liability Corporation', corporation: 'Corporation', partnership: 'Partnership', nonprofit: 'Non-profit Corporation' }
const BU_RE = /^BU[0-9a-f]{32}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// In order. submits: goes to Twilio/carrier review. charges: Twilio bills it. Either needs the switch + approve.
export const STEPS = [
  { id: 'subaccount', label: 'Create the business’s Twilio subaccount (free)' },
  { id: 'customer_profile', label: 'Prepare the business profile (draft, free)' },
  { id: 'submit_profile', label: 'Submit the business profile to Twilio', submits: true },
  { id: 'a2p_bundle', label: 'Prepare the A2P messaging profile (draft, free)' },
  { id: 'submit_bundle', label: 'Submit the A2P messaging profile to Twilio', submits: true },
  { id: 'brand', label: 'Register the brand with carriers (fee)', submits: true, charges: true },
  { id: 'messaging_service', label: 'Create the business’s Messaging Service (free)' },
  { id: 'campaign', label: 'Register the texting campaign (vetting fee + monthly fee)', submits: true, charges: true },
  { id: 'phone_number', label: 'Buy a local number and attach it (monthly fee)', charges: true },
]
const STEP = Object.fromEntries(STEPS.map((s) => [s.id, s]))
// The provider object that proves each step is done.
const DONE_BY = { subaccount: null, customer_profile: 'profile_evaluation', submit_profile: 'profile_submitted', a2p_bundle: 'bundle_evaluation', submit_bundle: 'bundle_submitted', brand: 'brand', messaging_service: 'messaging_service', campaign: 'campaign', phone_number: 'phone_number' }

const fail = (error, httpStatus = 409) => ({ ok: false, httpStatus, error })

async function objects(db, customer) {
  const { results } = await db.prepare('SELECT kind, sid, status, detail, updated_at FROM sms_provider_objects WHERE customer = ?1').bind(customer).all()
  return Object.fromEntries(results.map((r) => [r.kind, r]))
}
async function put(db, customer, kind, { sid = null, status = null, detail = null }, now) {
  await db
    .prepare(
      `INSERT INTO sms_provider_objects (customer, kind, sid, status, detail, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(customer, kind) DO UPDATE SET sid = coalesce(?3, sid), status = ?4, detail = ?5, updated_at = ?6`,
    )
    .bind(customer, kind, sid, status, detail, now)
    .run()
}

// Create one provider object once. Already there → its SID. Unknown earlier outcome → refuse (admin checks Twilio).
async function once(ctx, kind, request, sidOf = (b) => b?.sid) {
  const have = ctx.objs[kind]
  if (have?.sid) return have.sid
  if (have && !have.sid) throw Object.assign(new Error(kind), { code: 'unknown_outcome', kind })
  const r = await twilioRequest(ctx.env, request)
  if (!r.ok) {
    if (r.unknown) await put(ctx.db, ctx.customer, kind, { detail: 'unknown_outcome' }, ctx.now)
    throw Object.assign(new Error(kind), { code: r.unknown ? 'unknown_outcome' : r.error, kind })
  }
  const sid = sidOf(r.body)
  if (typeof sid !== 'string' || !/^[A-Z]{2}[0-9a-f]{32}$/.test(sid)) throw Object.assign(new Error(kind), { code: 'provider_bad_response', kind })
  await put(ctx.db, ctx.customer, kind, { sid, status: typeof r.body?.status === 'string' ? r.body.status.slice(0, 40) : null }, ctx.now)
  ctx.objs[kind] = { sid }
  return sid
}
const th = (path, params, auth) => ({ host: 'trusthub', path, params, auth })
const assign = (ctx, parentKind, parent, childKind, child, product = 'CustomerProfiles') =>
  once(ctx, `assign_${parentKind}_${childKind}`, th(`/v1/${product}/${parent}/EntityAssignments`, [['ObjectSid', child]], ctx.sub))

async function evaluate(ctx, kind, product, sid, policy) {
  const r = await twilioRequest(ctx.env, th(`/v1/${product}/${sid}/Evaluations`, [['PolicySid', policy]], ctx.sub))
  if (!r.ok) throw Object.assign(new Error(kind), { code: r.error, kind })
  const status = r.body?.status === 'compliant' ? 'compliant' : 'noncompliant'
  // Which requirements failed (Twilio's field names only, never values) so the admin knows what to fix.
  const failed = []
  for (const res of r.body?.results || []) for (const f of res?.fields || []) if (f?.passed === false && typeof f.object_field === 'string') failed.push(f.object_field.slice(0, 40))
  await put(ctx.db, ctx.customer, kind, { status, detail: failed.length ? failed.slice(0, 8).join(',') : null }, ctx.now)
  if (status !== 'compliant') throw Object.assign(new Error(kind), { code: `${kind.split('_')[0]}_noncompliant`, kind })
}

async function context(env, customer, now) {
  const db = env.ONBOARDING_DB
  if (!(await followupsReady(db)) || !(await accountsReady(db))) return { error: fail('not_ready') }
  if (!parentConfigured(env)) return { error: fail('provider_not_configured', 503) }
  const reg = await getRegistration(db, customer)
  if (!reg) return { error: fail('details_missing') }
  if (!reg.approved_at) return { error: fail('owner_approval_missing') }
  if (!reg.path || !reg.street) return { error: fail('details_incomplete') }
  if (!['ready', 'pending', 'approved'].includes(reg.status)) return { error: fail(`registration_${reg.status}`) }
  return { db, reg, objs: await objects(db, customer), env, customer, now }
}

// Read-only summary for the admin: path, account, each step done / next, statuses. No personal data, no secrets.
export async function provisioningState(env, customer) {
  const db = env.ONBOARDING_DB
  if (!(await accountsReady(db))) return { ready: false }
  const [reg, objs, acct] = await Promise.all([getRegistration(db, customer), objects(db, customer), db.prepare('SELECT status, usage_period, usage_count, usage_micros FROM sms_accounts WHERE customer = ?1').bind(customer).first()])
  const done = (id) => (id === 'subaccount' ? Boolean(acct) : Boolean(objs[DONE_BY[id]]?.sid || (DONE_BY[id]?.endsWith('_evaluation') && objs[DONE_BY[id]]?.status === 'compliant') || (DONE_BY[id]?.endsWith('_submitted') && objs[DONE_BY[id]])))
  const steps = STEPS.map((s) => ({ id: s.id, label: s.label, submits: Boolean(s.submits), charges: Boolean(s.charges), done: done(s.id) }))
  const unknown = Object.entries(objs).filter(([, o]) => !o.sid && o.detail === 'unknown_outcome').map(([k]) => k)
  return {
    ready: true,
    path: reg?.path || null,
    registration: reg?.status || 'not_configured',
    ownerApproved: Boolean(reg?.approved_at),
    account: acct ? { status: acct.status, usage: acct.usage_period ? { period: acct.usage_period, messages: acct.usage_count, micros: acct.usage_micros } : null } : null,
    steps,
    next: steps.find((s) => !s.done)?.id || null,
    statuses: Object.fromEntries(['profile_evaluation', 'profile_submitted', 'bundle_evaluation', 'bundle_submitted', 'brand', 'campaign'].filter((k) => objs[k]).map((k) => [k, objs[k].status || null])),
    unknown,
    submitEnabled: env.TWILIO_REGISTRATION_SUBMIT === 'true',
  }
}

// Run ONE step. opts: { approve, areaCode }.
export async function runStep(env, customer, stepId, opts = {}, now = Date.now()) {
  const step = STEP[stepId]
  if (!step) return fail('invalid_step', 400)
  const ctx = await context(env, customer, now)
  if (ctx.error) return ctx.error
  if ((step.submits || step.charges) && env.TWILIO_REGISTRATION_SUBMIT !== 'true') return fail('submission_disabled')
  if ((step.submits || step.charges) && opts.approve !== true) return fail('approval_required', 400)
  const state = await provisioningState(env, customer)
  const idx = STEPS.findIndex((s) => s.id === stepId)
  const missing = state.steps.slice(0, idx).find((s) => !s.done)
  if (missing) return fail(`needs_${missing.id}`)
  if (state.steps[idx].done) return { ok: true, step: stepId, already: true }
  try {
    if (stepId === 'subaccount') {
      const r = await ensureSubaccount(env, customer, now)
      return r.ok ? { ok: true, step: stepId, created: r.created } : fail(r.error, r.error === 'provider_not_configured' ? 503 : 409)
    }
    ctx.sub = await subaccountAuth(env, customer)
    if (!ctx.sub) return fail('no_account')
    await STEP_RUNNERS[stepId](ctx, opts)
    return { ok: true, step: stepId }
  } catch (err) {
    if (err?.code) return fail(err.code)
    throw err
  }
}

const sole = (ctx) => ctx.reg.path === 'sole_proprietor'
const profileEmail = (env) => (EMAIL_RE.test(env.TWILIO_PROFILE_EMAIL || '') ? env.TWILIO_PROFILE_EMAIL : null)

const STEP_RUNNERS = {
  async customer_profile(ctx) {
    const { reg, env } = ctx
    const primary = env.TWILIO_PRIMARY_PROFILE_SID
    if (!BU_RE.test(primary || '')) throw Object.assign(new Error(), { code: 'primary_profile_missing' })
    const email = profileEmail(env)
    if (!email) throw Object.assign(new Error(), { code: 'profile_email_missing' })
    const name = `${reg.legal_name} (${ctx.customer})`.slice(0, 64)
    const profile = await once(ctx, 'customer_profile', th('/v1/CustomerProfiles', [['FriendlyName', name], ['Email', email], ['PolicySid', sole(ctx) ? POLICIES.starter : POLICIES.secondary]], ctx.sub))
    const info = sole(ctx)
      ? await once(ctx, 'starter_info', th('/v1/EndUsers', [['FriendlyName', `${name} contact`], ['Type', 'starter_customer_profile_information'], ['Attributes', JSON.stringify({ email: reg.contact_email, first_name: reg.rep_first_name, last_name: reg.rep_last_name, phone_number: reg.contact_phone })]], ctx.sub))
      : await once(
          ctx,
          'business_info',
          th(
            '/v1/EndUsers',
            [
              ['FriendlyName', `${name} business`],
              ['Type', 'customer_profile_business_information'],
              [
                'Attributes',
                JSON.stringify({
                  business_identity: 'direct_customer',
                  business_industry: reg.industry,
                  business_name: reg.legal_name,
                  business_regions_of_operation: 'USA_AND_CANADA',
                  business_registration_identifier: 'EIN',
                  business_registration_number: reg.ein,
                  business_type: BUSINESS_TYPE[reg.business_type] || 'Limited Liability Corporation',
                  website_url: reg.website,
                }),
              ],
            ],
            ctx.sub,
          ),
        )
    await assign(ctx, 'profile', profile, sole(ctx) ? 'starter_info' : 'business_info', info)
    if (!sole(ctx)) {
      const rep = await once(
        ctx,
        'representative',
        th('/v1/EndUsers', [['FriendlyName', `${name} representative`], ['Type', 'authorized_representative_1'], ['Attributes', JSON.stringify({ business_title: reg.rep_title, email: reg.contact_email, first_name: reg.rep_first_name, job_position: reg.rep_job_position, last_name: reg.rep_last_name, phone_number: reg.contact_phone })]], ctx.sub),
      )
      await assign(ctx, 'profile', profile, 'representative', rep)
    }
    const address = await once(ctx, 'address', {
      host: 'api',
      path: `/2010-04-01/Accounts/${ctx.sub.sid}/Addresses.json`,
      params: [['CustomerName', reg.legal_name], ['Street', reg.street], ['StreetSecondary', reg.street2], ['City', reg.city], ['Region', reg.region], ['PostalCode', reg.postal_code], ['IsoCountry', 'US'], ['FriendlyName', name]],
      auth: ctx.sub,
    })
    const doc = await once(ctx, 'address_document', th('/v1/SupportingDocuments', [['FriendlyName', `${name} address`], ['Type', 'customer_profile_address'], ['Attributes', JSON.stringify({ address_sids: address })]], ctx.sub))
    await assign(ctx, 'profile', profile, 'address_document', doc)
    // The client profile is linked to GetShowUps's approved Primary (ISV) profile.
    await assign(ctx, 'profile', profile, 'primary', primary)
    await evaluate(ctx, 'profile_evaluation', 'CustomerProfiles', profile, sole(ctx) ? POLICIES.starter : POLICIES.secondary)
  },
  async submit_profile(ctx) {
    await submit(ctx, 'profile_submitted', 'CustomerProfiles', ctx.objs.customer_profile.sid)
    // With the provider now (what the owner sees: "Pending with carriers").
    await ctx.db.prepare("UPDATE sms_registrations SET status = 'pending', status_at = ?2, updated_at = ?2 WHERE customer = ?1 AND status = 'ready'").bind(ctx.customer, ctx.now).run()
  },
  async a2p_bundle(ctx) {
    const { reg, env } = ctx
    const email = profileEmail(env)
    if (!email) throw Object.assign(new Error(), { code: 'profile_email_missing' })
    const name = `${reg.legal_name} (${ctx.customer}) A2P`.slice(0, 64)
    const bundle = await once(ctx, 'a2p_bundle', th('/v1/TrustProducts', [['FriendlyName', name], ['Email', email], ['PolicySid', sole(ctx) ? POLICIES.soleProp : POLICIES.a2p]], ctx.sub))
    const info = sole(ctx)
      ? await once(ctx, 'a2p_info', th('/v1/EndUsers', [['FriendlyName', `${name} info`], ['Type', 'sole_proprietor_information'], ['Attributes', JSON.stringify({ brand_name: reg.legal_name, vertical: reg.industry, mobile_phone_number: reg.contact_phone })]], ctx.sub))
      : await once(ctx, 'a2p_info', th('/v1/EndUsers', [['FriendlyName', `${name} info`], ['Type', 'us_a2p_messaging_profile_information'], ['Attributes', JSON.stringify({ company_type: reg.business_type === 'nonprofit' ? 'non-profit' : 'private' })]], ctx.sub))
    await assign(ctx, 'bundle', bundle, 'a2p_info', info, 'TrustProducts')
    await assign(ctx, 'bundle', bundle, 'profile', ctx.objs.customer_profile.sid, 'TrustProducts')
    await evaluate(ctx, 'bundle_evaluation', 'TrustProducts', bundle, sole(ctx) ? POLICIES.soleProp : POLICIES.a2p)
  },
  async submit_bundle(ctx) {
    await submit(ctx, 'bundle_submitted', 'TrustProducts', ctx.objs.a2p_bundle.sid)
  },
  async brand(ctx) {
    const params = [['CustomerProfileBundleSid', ctx.objs.customer_profile.sid], ['A2PProfileBundleSid', ctx.objs.a2p_bundle.sid]]
    if (sole(ctx)) params.push(['BrandType', 'SOLE_PROPRIETOR'])
    else params.push(['SkipAutomaticSecVet', 'true']) // Low-Volume Standard: no secondary vetting
    await once(ctx, 'brand', { host: 'messaging', path: '/v1/a2p/BrandRegistrations', params, auth: ctx.sub })
  },
  async messaging_service(ctx) {
    // Twilio: create the campaign only for an APPROVED brand (sync records the brand status).
    if (String(ctx.objs.brand?.status || '').toUpperCase() !== 'APPROVED') throw Object.assign(new Error(), { code: 'brand_not_approved' })
    const name = `${ctx.reg.legal_name} via GetShowUps`.slice(0, 64)
    await once(ctx, 'messaging_service', { host: 'messaging', path: '/v1/Services', params: [['FriendlyName', name], ['InboundRequestUrl', `${siteOrigin(ctx.env)}/api/sms/twilio/inbound`]], auth: ctx.sub })
  },
  async campaign(ctx) {
    const mg = ctx.objs.messaging_service.sid
    const name = (await ctx.db.prepare('SELECT name FROM customers WHERE id = ?1').bind(ctx.customer).first())?.name || ctx.reg.legal_name
    const params = [
      ['BrandRegistrationSid', ctx.objs.brand.sid],
      ['Description', USE_CASE(name)],
      ['MessageFlow', MESSAGE_FLOW(name, ctx.customer)],
      ...SAMPLES(name, ctx.customer).map((s) => ['MessageSamples', s]),
      ['UsAppToPersonUsecase', sole(ctx) ? 'SOLE_PROPRIETOR' : 'LOW_VOLUME'],
      ['HasEmbeddedLinks', 'true'],
      ['HasEmbeddedPhone', 'false'],
    ]
    await once(ctx, 'campaign', { host: 'messaging', path: `/v1/Services/${mg}/Compliance/Usa2p`, params, auth: ctx.sub })
  },
  async phone_number(ctx, opts) {
    const area = /^\d{3}$/.test(String(opts.areaCode || '')) ? String(opts.areaCode) : (toE164((await getProfile(ctx.db, ctx.customer).catch(() => null))?.phone) || '').slice(2, 5)
    if (!/^\d{3}$/.test(area)) throw Object.assign(new Error(), { code: 'area_code_required' })
    const parent = parentAuth(ctx.env)
    let pn = ctx.objs.phone_number?.sid
    if (!pn) {
      const search = await twilioRequest(ctx.env, { method: 'GET', path: `/2010-04-01/Accounts/${ctx.sub.sid}/AvailablePhoneNumbers/US/Local.json`, params: [['AreaCode', area], ['SmsEnabled', 'true'], ['PageSize', '1']], auth: parent })
      if (!search.ok) throw Object.assign(new Error(), { code: search.error })
      const number = search.body?.available_phone_numbers?.[0]?.phone_number
      if (!toE164(number)) throw Object.assign(new Error(), { code: 'no_number_available' })
      pn = await once(ctx, 'phone_number', { path: `/2010-04-01/Accounts/${ctx.sub.sid}/IncomingPhoneNumbers.json`, params: [['PhoneNumber', number], ['FriendlyName', `${ctx.customer} (GetShowUps)`]], auth: parent })
      await put(ctx.db, ctx.customer, 'phone_number', { sid: pn, status: toE164(number) }, ctx.now)
      ctx.objs.phone_number = { sid: pn, status: toE164(number) }
    }
    const mg = ctx.objs.messaging_service.sid
    await once(ctx, 'service_number', { host: 'messaging', path: `/v1/Services/${mg}/PhoneNumbers`, params: [['PhoneNumberSid', pn]], auth: ctx.sub })
    // The business's own sender (texts still wait for the campaign's approval: smsReadiness).
    try {
      await ctx.db.prepare('UPDATE sms_registrations SET messaging_service = ?2, sender_phone = ?3, updated_at = ?4 WHERE customer = ?1').bind(ctx.customer, mg, ctx.objs.phone_number.status, ctx.now).run()
    } catch (err) {
      if (String(err?.message).includes('UNIQUE')) throw Object.assign(new Error(), { code: 'sender_in_use' })
      throw err
    }
  },
}

async function submit(ctx, kind, product, sid) {
  if (ctx.objs[kind]) return
  const r = await twilioRequest(ctx.env, th(`/v1/${product}/${sid}`, [['Status', 'pending-review']], ctx.sub))
  if (!r.ok && !r.unknown) throw Object.assign(new Error(kind), { code: r.error, kind })
  // Unknown outcome: recorded as submitted-unknown; sync reads the real status from Twilio.
  await put(ctx.db, ctx.customer, kind, { status: r.ok ? String(r.body?.status || 'pending-review').slice(0, 40) : null, detail: r.ok ? null : 'unknown_outcome' }, ctx.now)
}

// Sole proprietor: ask Twilio to text the owner's mobile a new one-time code (they reply to verify the brand).
export async function resendOtp(env, customer, now = Date.now()) {
  const ctx = await context(env, customer, now)
  if (ctx.error) return ctx.error
  if (ctx.reg.path !== 'sole_proprietor') return fail('not_sole_proprietor')
  const brand = ctx.objs.brand?.sid
  if (!brand) return fail('needs_brand')
  const sub = await subaccountAuth(env, customer)
  if (!sub) return fail('no_account')
  const r = await twilioRequest(env, { host: 'messaging', path: `/v1/a2p/BrandRegistrations/${brand}/SmsOtp`, auth: sub })
  return r.ok ? { ok: true } : fail(r.error)
}

// Admin checked Twilio after an unknown outcome and found the object missing: allow that request again.
export async function clearUnknown(env, customer, kind) {
  if (!(await accountsReady(env.ONBOARDING_DB)) || typeof kind !== 'string' || kind.length > 60) return fail('invalid_request', 400)
  const r = await env.ONBOARDING_DB.prepare("DELETE FROM sms_provider_objects WHERE customer = ?1 AND kind = ?2 AND sid IS NULL AND detail = 'unknown_outcome'").bind(customer, kind).run()
  return r.meta?.changes ? { ok: true } : fail('not_found', 404)
}

// Read what Twilio reports and update the registration (the ONLY way it becomes approved). Read-only toward Twilio.
const up = (s) => String(s || '').toUpperCase()
export async function syncRegistration(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await accountsReady(db))) return fail('not_ready')
  const reg = await getRegistration(db, customer)
  if (!reg?.approved_at) return fail('owner_approval_missing')
  const sub = await subaccountAuth(env, customer)
  if (!sub) return fail('no_account')
  const objs = await objects(db, customer)
  const read = async (kind, host, path, field = 'status') => {
    if (!objs[kind]?.sid) return null
    const r = await twilioRequest(env, { host, method: 'GET', path, auth: sub })
    if (!r.ok) return null
    const status = String(r.body?.[field] ?? r.body?.status ?? '').slice(0, 40) || null
    await put(db, customer, kind, { status, detail: objs[kind].detail }, now)
    return status
  }
  const profile = await read('customer_profile', 'trusthub', `/v1/CustomerProfiles/${objs.customer_profile?.sid}`)
  const bundle = await read('a2p_bundle', 'trusthub', `/v1/TrustProducts/${objs.a2p_bundle?.sid}`)
  const brand = await read('brand', 'messaging', `/v1/a2p/BrandRegistrations/${objs.brand?.sid}`)
  const campaign = objs.messaging_service?.sid ? await read('campaign', 'messaging', `/v1/Services/${objs.messaging_service.sid}/Compliance/Usa2p/${objs.campaign?.sid}`, 'campaign_status') : null
  const [status, note] =
    up(campaign) === 'VERIFIED' ? ['approved', null]
    : up(campaign) === 'SUSPENDED' || up(brand) === 'SUSPENDED' ? ['suspended', up(campaign) === 'SUSPENDED' ? 'campaign_suspended' : 'brand_suspended']
    : up(campaign) === 'FAILED' ? ['rejected', 'campaign_failed']
    : up(brand) === 'FAILED' ? ['rejected', 'brand_failed']
    : profile === 'twilio-rejected' ? ['rejected', 'profile_rejected']
    : bundle === 'twilio-rejected' ? ['rejected', 'a2p_profile_rejected']
    : objs.profile_submitted ? ['pending', null]
    : [reg.status, reg.status_note]
  if (status !== reg.status || note !== reg.status_note) {
    await db.prepare('UPDATE sms_registrations SET status = ?2, status_note = ?3, status_at = ?4, updated_at = ?4 WHERE customer = ?1').bind(customer, status, note, now).run()
  }
  return { ok: true, status, note, provider: { profile, bundle, brand, campaign }, changed: status !== reg.status }
}

// Cron: re-read up to `limit` registrations that are with the provider, at most hourly each (read-only).
export async function syncPendingRegistrations(env, now = Date.now(), limit = 5) {
  const db = env.ONBOARDING_DB
  if (!parentConfigured(env) || !(await accountsReady(db))) return { checked: 0 }
  const { results } = await db
    .prepare(
      `SELECT r.customer FROM sms_registrations r JOIN sms_accounts a ON a.customer = r.customer AND a.status = 'active'
       WHERE r.status IN ('pending', 'approved') AND coalesce((SELECT max(updated_at) FROM sms_provider_objects o WHERE o.customer = r.customer AND o.kind IN ('brand', 'campaign', 'customer_profile')), 0) < ?1
       ORDER BY r.updated_at LIMIT ?2`,
    )
    .bind(now - 60 * 60 * 1000, limit)
    .all()
  let checked = 0
  for (const { customer } of results) {
    const r = await syncRegistration(env, customer, now).catch(() => null)
    if (r) checked++
  }
  return { checked }
}
