// /api/platform/voice-provider — the Admin Console entry point for voice-provider management (platform admins only,
// server-checked on every request; business membership is neither required nor consulted).
//   GET                              → { businesses: [{ id, name, status, test, receptionist, provider, providerName, inherited }],
//                                        global: { ready, current, counts, providers } }        (server/voice/global.js)
//   GET ?global_check=<provider>     → { check }  the global checklist: platform checks + every inherited business (nothing changes)
//   GET ?customer=<id>               → { business, ready, voice, providers, history }   (server/voice/admin.js adminVoiceView)
//   GET ?customer=<id>&catalog=<p>   → { provider, voices: [...] }                     (a provider's voice catalog)
//   POST { action: 'check', customer, provider, voiceId?, useDefaultVoice? }           → { check }  (nothing changes)
//   POST { action: 'switch', customer, confirmCustomer, provider, voiceId?, useDefaultVoice?, confirm: true, version }
//   POST { action: 'rollback', customer, confirmCustomer, confirm: true, version }
//   POST { action: 'global_check', provider }                                           → { check }  (nothing changes)
//   POST { action: 'global_switch', provider, confirmProvider, mode: 'all' | 'staged', confirm: true, version }
//   POST { action: 'global_rollback', confirmProvider, confirm: true, version }
//   GET ?global_promote_check=<provider>[&include_overrides=1]  |  POST { action: 'global_promote_check', provider?, includeOverrides? }
//                                    → { check }  the promotion checklist (provider-level verification + every business in
//                                      scope through its compatibility checks; warnings vs blockers; nothing changes)
//   POST { action: 'global_promote', provider?, confirmProvider, includeOverrides?, acknowledgeUnverified?, confirm: true, version }
//                                    → promotes the target (default: the current global default) to 100% of the businesses
//                                      in scope in one guarded batch; { global, applied, distribution, check, businesses }
// Global changes (server/voice/global.js) require the provider id typed back (`confirmProvider` = the provider the
// platform ends up on) and carry the global version read (409 stale).
// The switch and the rollback are the SAME functions the dashboard control calls (checklist, blockers, confirmation,
// version, one conditional write, audit, rollback kept). On top, the console requires the business id typed back
// (`confirmCustomer` must equal `customer`), so the selected business is unmistakable before anything changes.
// Writes are same-origin and rate-limited per admin. Nothing here returns transcripts or customer details.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { adminVoiceView, listVoiceBusinesses, loadVoiceBusiness } from '../../../server/voice/admin.js'
import { checkGlobalPromotion, checkGlobalSwitch, getGlobalDefault, globalOverview, promoteGlobalProvider, rollbackGlobalProvider, switchGlobalProvider } from '../../../server/voice/global.js'
import { catalogFor, checkProviderSwitch, PROVIDER_CAPABILITIES, rollbackProvider, switchProvider } from '../../../server/voice/settings.js'
import { PROVIDERS } from '../../../server/voice/providers.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const url = new URL(request.url)
  const id = url.searchParams.get('customer')
  const gc = url.searchParams.get('global_check')
  if (gc) return PROVIDERS.includes(gc) ? json(200, { check: await checkGlobalSwitch(env, { provider: gc }) }) : json(400, { error: 'invalid_provider' })
  const gp = url.searchParams.get('global_promote_check')
  if (gp) return PROVIDERS.includes(gp) ? json(200, { check: await checkGlobalPromotion(env, { provider: gp, includeOverrides: url.searchParams.get('include_overrides') === '1' }) }) : json(400, { error: 'invalid_provider' })
  if (!id) return json(200, { businesses: await listVoiceBusinesses(env), global: await globalOverview(env) })
  const { customer, error, httpStatus } = await loadVoiceBusiness(env, id)
  if (error) return json(httpStatus, { error })
  const asked = url.searchParams.get('catalog')
  if (asked) {
    if (!PROVIDERS.includes(asked)) return json(400, { error: 'invalid_provider' })
    const rl = await hit(env, 'voiceCatalog', customer.id) // same budget as the owner's catalog route (a refresh hits the provider)
    if (rl.limited) return tooManyJson(rl.retryAfter)
    const c = await catalogFor(env, asked, { refresh: url.searchParams.get('refresh') === '1' })
    const cap = PROVIDER_CAPABILITIES[asked]
    return json(200, { provider: asked, voices: c.voices.map((v) => ({ id: v.id, name: v.name, preview: cap.previews ? v.preview : null, language: v.language, accent: v.accent, gender: v.gender, age: v.age, description: v.description })), fetchedAt: c.fetchedAt, ...(c.stale ? { stale: true } : {}), ...(c.error ? { error: c.error } : {}) })
  }
  return json(200, await adminVoiceView(env, customer))
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'voiceProviderAdmin', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => ({}))
  const action = b?.action
  const now = Date.now()
  if (action === 'global_check' || action === 'global_switch' || action === 'global_rollback' || action === 'global_promote_check' || action === 'global_promote') {
    const provider = String(b.provider || '')
    if (action === 'global_check') return PROVIDERS.includes(provider) ? json(200, { check: await checkGlobalSwitch(env, { provider }, now) }) : json(400, { error: 'invalid_provider' })
    const includeOverrides = b.includeOverrides === true
    if (action === 'global_promote_check') {
      const target = provider || (await getGlobalDefault(env.ONBOARDING_DB)).provider
      return PROVIDERS.includes(target) ? json(200, { check: await checkGlobalPromotion(env, { provider: target, includeOverrides }, now) }) : json(400, { error: 'invalid_provider' })
    }
    if (action === 'global_promote') {
      const target = provider || (await getGlobalDefault(env.ONBOARDING_DB)).provider
      if (!PROVIDERS.includes(target)) return json(400, { error: 'invalid_provider' })
      if (String(b.confirmProvider || '').toLowerCase() !== target) return json(400, { error: 'confirm_provider_mismatch' })
      const r = await promoteGlobalProvider(env, admin, { provider: target, includeOverrides, acknowledgeUnverified: b.acknowledgeUnverified === true, confirm: b.confirm === true, version: b.version }, now)
      if (!r.ok) return json(r.error === 'not_platform_admin' ? 403 : ['blocked', 'confirmation_required', 'acknowledgement_required', 'stale'].includes(r.error) ? 409 : 400, { error: r.error, ...(r.check ? { check: r.check } : {}), ...(r.version !== undefined ? { version: r.version } : {}) })
      return json(200, { global: await globalOverview(env), applied: r.applied, distribution: r.distribution, check: r.check, businesses: await listVoiceBusinesses(env) })
    }
    // The provider the platform ends up on must be typed back (the target for a switch, the previous one for a rollback).
    const typed = String(b.confirmProvider || '').toLowerCase()
    if (action === 'global_switch') {
      if (!PROVIDERS.includes(provider)) return json(400, { error: 'invalid_provider' })
      if (typed !== provider) return json(400, { error: 'confirm_provider_mismatch' })
      const r = await switchGlobalProvider(env, admin, { provider, mode: b.mode === 'all' ? 'all' : 'staged', confirm: b.confirm === true, version: b.version }, now)
      if (!r.ok) return json(r.error === 'not_platform_admin' ? 403 : r.error === 'blocked' || r.error === 'confirmation_required' || r.error === 'stale' ? 409 : 400, { error: r.error, ...(r.reason ? { reason: r.reason } : {}), ...(r.check ? { check: r.check } : {}), ...(r.version !== undefined ? { version: r.version } : {}) })
      return json(200, { global: await globalOverview(env), applied: r.applied, check: r.check, businesses: await listVoiceBusinesses(env) })
    }
    const cur = await getGlobalDefault(env.ONBOARDING_DB)
    if (!cur.previous || typed !== cur.previous) return json(400, { error: 'confirm_provider_mismatch' })
    const r = await rollbackGlobalProvider(env, admin, { confirm: b.confirm === true, version: b.version }, now)
    if (!r.ok) return json(r.error === 'not_platform_admin' ? 403 : r.error === 'confirmation_required' || r.error === 'stale' ? 409 : 400, { error: r.error, ...(r.previous ? { previous: r.previous } : {}), ...(r.version !== undefined ? { version: r.version } : {}) })
    return json(200, { global: await globalOverview(env), undone: r.undone, businesses: await listVoiceBusinesses(env) })
  }
  if (!['check', 'switch', 'rollback'].includes(action)) return json(400, { error: 'invalid_action' })
  const { customer, error, httpStatus } = await loadVoiceBusiness(env, b.customer)
  if (error) return json(httpStatus, { error })
  const input = { provider: String(b.provider || ''), voiceId: typeof b.voiceId === 'string' ? b.voiceId : '', useDefaultVoice: b.useDefaultVoice === true }
  if (action === 'check') return json(200, { check: await checkProviderSwitch(env, customer, input, now) })
  // A change needs the business id typed back: the console never acts on a business the admin did not name.
  if (String(b.confirmCustomer || '').toLowerCase() !== customer.id) return json(400, { error: 'confirm_customer_mismatch' })
  if (action === 'switch') {
    const r = await switchProvider(env, customer, admin, { ...input, confirm: b.confirm === true, version: b.version }, now)
    if (!r.ok) return json(r.error === 'not_platform_admin' ? 403 : r.error === 'blocked' || r.error === 'confirmation_required' || r.error === 'stale' ? 409 : 400, { error: r.error, check: r.check, ...(r.version !== undefined ? { version: r.version } : {}) })
    return json(200, { check: r.check, ...(await adminVoiceView(env, customer, now)) })
  }
  const r = await rollbackProvider(env, customer, admin, { confirm: b.confirm === true, version: b.version }, now)
  if (!r.ok) return json(r.error === 'not_platform_admin' ? 403 : r.error === 'confirmation_required' || r.error === 'stale' ? 409 : 400, { error: r.error, ...(r.previous ? { previous: r.previous } : {}), ...(r.version !== undefined ? { version: r.version } : {}) })
  return json(200, await adminVoiceView(env, customer, now))
}
