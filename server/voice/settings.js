// Receptionist voice management (migration 0035, docs/RECEPTIONIST.md "Voice management").
//   Owners choose how the receptionist SOUNDS (a voice from the active provider's catalog, a personality preset, the
//   pace where supported). Platform admins choose the underlying PROVIDER, through a checked, confirmed, audited and
//   reversible switch. Customers never see a provider name.
//   No row = today's effective configuration (retell, the shared agent's own voice, standard manner): existing
//   businesses keep exactly what they have. Everything here is server-side authorization + validation; the UI only
//   shows what these functions answer.
import { audit } from '../platform.js'
import { isPlatformAdminEmail, providerDisabled, providerEvidence } from './customer.js'
import { testStatus } from '../testbusiness.js'
import { emailRef, recordEvent } from '../auditlog.js'
import { catalogFor, findVoice, validateVoice } from './catalog.js'
import { providerStatus, PROVIDERS } from './providers.js'
import { DEFAULT_PROVIDER, getVoiceSettings, LIVE_PROVIDERS, PACES, paceFor, PERSONALITIES, personalityPrompt, PROVIDER_CAPABILITIES, sessionVoiceFor } from './style.js'

export { DEFAULT_PROVIDER, getVoiceSettings, LIVE_PROVIDERS, PACES, paceFor, PERSONALITIES, personalityPrompt, PROVIDER_CAPABILITIES, sessionVoiceFor, catalogFor, findVoice }
// The seven engine tools every provider runs through server/voice/tools.js (names fixed there; counted, not imported,
// so this module stays out of the engine's import graph).
const REQUIRED_TOOLS = 7

export async function voiceSettingsReady(db) {
  try {
    const r = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'receptionist_voice_settings'").first()
    return Number(r?.n) === 1
  } catch {
    return false
  }
}

// What the owner sees and may change (provider name never included; capabilities of the ACTIVE provider only).
export function ownerView(s, env) {
  const cap = PROVIDER_CAPABILITIES[s.provider] || PROVIDER_CAPABILITIES[DEFAULT_PROVIDER]
  const status = providerStatus(env)[s.provider]
  return {
    voiceId: s.voiceId,
    voiceName: s.voiceName,
    personality: s.personality,
    pace: s.pace,
    language: s.language,
    version: s.version,
    capabilities: { voiceChoice: cap.voiceChoice && Boolean(status?.configured), previews: cap.previews, pace: cap.pace, languages: cap.languages },
    personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, name: p.name, blurb: p.blurb })),
    paces: Object.entries(PACES).map(([id, p]) => ({ id, name: p.name })),
  }
}

// Optimistic write shared by every change: the row is replaced only when `version` is what the writer read.
// `inherit` (migration 0036): true = this business follows the global default (an inherit row), false = explicit
// override (no inherit row), undefined = unchanged. Applied after the versioned write (idempotent; ignored before 0036).
// → { ok, settings } | { ok: false, error: 'stale' }
async function writeSettings(db, customerId, next, expectedVersion, by, now, { inherit } = {}) {
  const prevJson = next.previous ? JSON.stringify(next.previous) : null
  if (expectedVersion === 0) {
    const r = await db
      .prepare('INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, previous, version, updated_by, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM receptionist_voice_settings WHERE customer = ?1)')
      .bind(customerId, next.provider, next.voiceId, next.voiceName, next.personality, next.pace, next.language, prevJson, by, now)
      .run()
    if (!(r?.meta?.changes > 0)) return { ok: false, error: 'stale' }
  } else {
    const r = await db
      .prepare('UPDATE receptionist_voice_settings SET provider = ?2, voice_id = ?3, voice_name = ?4, personality = ?5, pace = ?6, language = ?7, previous = ?8, version = version + 1, updated_by = ?9, updated_at = ?10 WHERE customer = ?1 AND version = ?11')
      .bind(customerId, next.provider, next.voiceId, next.voiceName, next.personality, next.pace, next.language, prevJson, by, now, expectedVersion)
      .run()
    if (!(r?.meta?.changes > 0)) return { ok: false, error: 'stale' }
  }
  if (inherit !== undefined) await setInherit(db, customerId, inherit, now)
  return { ok: true, settings: await getVoiceSettings(db, customerId) }
}
export async function setInherit(db, customerId, inherit, now = Date.now()) {
  try {
    if (inherit) await db.prepare('INSERT OR IGNORE INTO receptionist_voice_inherit (customer, updated_at) VALUES (?1, ?2)').bind(customerId, now).run()
    else await db.prepare('DELETE FROM receptionist_voice_inherit WHERE customer = ?1').bind(customerId).run()
  } catch {
    // before migration 0036 there is no inheritance: the settings row decides, as before
  }
}

// Owner: voice (from the ACTIVE provider's catalog), personality, pace. Never the provider.
// → { ok, settings } | { ok: false, error: invalid_voice_id | voice_unknown | catalog_unavailable | provider_not_configured |
//   invalid_personality | invalid_pace | pace_unsupported | stale | not_ready }
export async function saveVoicePreferences(env, customer, { voiceId, personality, pace, version }, actorEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await voiceSettingsReady(db))) return { ok: false, error: 'not_ready' }
  const cur = await getVoiceSettings(db, customer.id)
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', version: cur.version }
  const next = { ...cur }
  if (personality !== undefined) {
    if (!PERSONALITIES[personality]) return { ok: false, error: 'invalid_personality' }
    next.personality = personality
  }
  if (pace !== undefined) {
    if (!PACES[pace]) return { ok: false, error: 'invalid_pace' }
    if (pace !== 'normal' && !PROVIDER_CAPABILITIES[cur.provider].pace) return { ok: false, error: 'pace_unsupported' }
    next.pace = pace
  }
  if (voiceId !== undefined) {
    if (voiceId === null || voiceId === '') {
      next.voiceId = null
      next.voiceName = null
    } else {
      const v = await validateVoice(env, cur.provider, voiceId, { now })
      if (!v.ok) return { ok: false, error: v.error }
      next.voiceId = v.voice.id
      next.voiceName = v.voice.name
    }
  }
  // The owner's first row must not turn a business into a provider override: it keeps following the global default.
  const w = await writeSettings(db, customer.id, next, cur.version, await emailRef(actorEmail), now, { inherit: cur.inherited && cur.version === 0 ? true : undefined })
  if (!w.ok) return w
  await recordEvent(db, { type: 'receptionist.voice', actorType: 'owner', actor: actorEmail, customer: customer.id, capability: 'receptionist', resource: { type: 'receptionist_voice', id: customer.id }, outcome: 'success', details: { voice: next.voiceId ? 'chosen' : 'default', personality: next.personality, pace: next.pace }, at: now }).catch(() => {})
  return w
}

// ---------- admin: provider switching ----------
export { isPlatformAdminEmail }

// Readiness of every provider for THIS business, truthfully: configured? switched off? customer path? evidence of a
// finished session with audio both ways and the booking tools (server/voice/customer.js providerEvidence)? One state:
//   active          the business's provider for customers
//   ready           configured, on, customer path, evidence complete → may be activated
//   needs_test      configured and on, but no finished session with audio + tools for this business yet
//   not_configured  credentials missing on the platform        disabled   switched off (VOICE_PROVIDERS_DISABLED)
export async function providerOverview(env, customer, now = Date.now()) {
  const status = providerStatus(env)
  const current = await getVoiceSettings(env.ONBOARDING_DB, customer.id)
  const testable = await testStatus(env, customer.id).then((t) => t.test && !t.unreadable).catch(() => false)
  const providers = []
  for (const id of PROVIDERS) {
    const cap = PROVIDER_CAPABILITIES[id]
    const configured = Boolean(status[id].configured)
    const disabled = providerDisabled(env, id)
    const evidence = configured ? await providerEvidence(env, customer.id, id, now) : { ok: false, sessions: 0, audio: false, tools: false, lastAt: null, missing: ['session', 'audio', 'tools'] }
    const blockers = []
    if (!configured) blockers.push('not_configured')
    if (disabled) blockers.push('disabled')
    if (!cap.customers) blockers.push('no_customer_path')
    if (configured && !disabled && cap.customers && !evidence.ok && id !== current.provider) blockers.push('needs_test')
    const state = id === current.provider ? 'active' : !configured ? 'not_configured' : disabled ? 'disabled' : !cap.customers ? 'no_customer_path' : evidence.ok ? 'ready' : 'needs_test'
    providers.push({ id, name: cap.name, state, configured, enabled: !disabled, browserSessions: cap.customers ? 'customers' : cap.lab ? 'lab_only' : 'none', phone: cap.phone, customerPath: cap.customers, testAvailable: cap.lab && configured && !disabled, testUrl: testable && configured && !disabled ? `/chat/${customer.id}?test=${id}` : null, evidence, pace: cap.pace, previews: cap.previews, blockers })
  }
  return { current: current.provider, inherited: current.inherited, defaultProvider: current.defaultProvider, testBusiness: testable, providers }
}

// The switching checklist (nothing changes). Every check answers from configuration and records; blockers block.
// → { ok, provider, checks: [{ id, ok, note }], blockers: [codes], consequences: [text], voice: {id,name}|null, transfer: {...} }
export async function checkProviderSwitch(env, customer, { provider, voiceId = '', useDefaultVoice = false }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const cur = await getVoiceSettings(db, customer.id)
  const checks = []
  const blockers = []
  const add = (id, ok, note, code = id) => {
    checks.push({ id, ok, note })
    if (!ok) blockers.push(code)
  }
  if (!PROVIDERS.includes(provider)) return { ok: false, provider, checks: [{ id: 'provider', ok: false, note: 'Unknown provider.' }], blockers: ['invalid_provider'], consequences: [], voice: null }
  const cap = PROVIDER_CAPABILITIES[provider]
  const status = providerStatus(env)[provider]
  add('configuration', Boolean(status.configured), status.configured ? `${cap.name} is configured on this platform.` : `${cap.name} is not configured (credentials missing).`, 'not_configured')
  add('customer_path', cap.customers, cap.customers ? `${cap.name} has the customer-facing browser voice path (sessions, tools and lifecycle through our server).` : `${cap.name} has no customer-facing path.`, 'no_customer_path')
  add('enabled', !providerDisabled(env, provider), providerDisabled(env, provider) ? `${cap.name} is switched off for customers (VOICE_PROVIDERS_DISABLED).` : `${cap.name} is not switched off.`, 'disabled')
  add('eligibility', customer.status === 'active' && (await voiceSettingsReady(db)), customer.status === 'active' ? 'Business is active.' : 'Business is suspended.', 'business_not_eligible')
  add('phone_routing', true, 'No phone line is connected to GetShowUps; phone routing is unaffected by a switch.')
  add('tools', REQUIRED_TOOLS === 7, 'All seven receptionist tools run on our server for every provider.', 'tools_missing')
  let voice = null
  if (voiceId) {
    const v = await validateVoice(env, provider, voiceId, { now })
    add('voice', v.ok, v.ok ? `Voice "${v.voice.name}" is in the ${cap.name} catalog.` : `The chosen voice is not available on ${cap.name} (${v.error}).`, v.ok ? 'voice' : v.error)
    if (v.ok) voice = { id: v.voice.id, name: v.voice.name }
  } else if (cur.voiceId && cur.provider !== provider && !useDefaultVoice) {
    add('voice', false, `The current voice ("${cur.voiceName || cur.voiceId}") belongs to ${PROVIDER_CAPABILITIES[cur.provider].name} and cannot transfer: choose a ${cap.name} voice, or its default voice, explicitly.`, 'voice_replacement_required')
  } else if (cur.voiceId && cur.provider === provider) {
    voice = { id: cur.voiceId, name: cur.voiceName }
    add('voice', true, `Keeps the current voice "${cur.voiceName || cur.voiceId}".`)
  } else {
    add('voice', true, `${cap.name}'s default voice will be used.`)
  }
  const bookable = customer.hoursConfirmed && Boolean(await env.GOOGLE_TOKENS?.get(`google:${customer.id}`).catch(() => null))
  add('booking', Boolean(bookable), bookable ? 'Calendar connected and booking hours confirmed; bookings go through the same engine on every provider.' : 'Calendar not connected or hours not confirmed: the receptionist cannot book yet.', 'booking_not_ready')
  const ev = await providerEvidence(env, customer.id, provider, now)
  const MISSING = { session: 'no finished session', audio: 'audio both ways not measured (caller heard and receptionist heard)', tools: 'the availability and booking tools did not both succeed' }
  add('verified', ev.ok, ev.ok ? `Verified for this business: ${ev.sessions} finished ${cap.name} session(s) in the last 30 days with audio both ways and the booking tools running through our server.` : `Not verified for this business yet: ${ev.missing.map((m) => MISSING[m]).join('; ')}. Run a test session on this business (Test now) with the candidate provider: say hello, ask for times and book (dry run).`, 'test_session_required')
  const same = cur.provider === provider && (voice?.id || null) === (cur.voiceId || null)
  if (same) add('change', false, 'Nothing would change.', 'no_change')
  const consequences = [
    `New customer voice sessions use ${cap.name} from the moment the switch is confirmed; sessions already in progress stay on ${PROVIDER_CAPABILITIES[cur.provider].name} (each session is pinned to the provider it started with).`,
    voice ? `Voice becomes "${voice.name}".` : `Voice becomes ${cap.name}'s default voice.`,
    `Personality "${PERSONALITIES[cur.personality]?.name || cur.personality}" is kept (it is provider-independent).`,
    cap.pace ? `Pace "${PACES[cur.pace]?.name || cur.pace}" is kept.` : cur.pace !== 'normal' ? `Pace is not supported on ${cap.name}: it will not apply (setting kept for a rollback).` : 'Pace: normal.',
    'Website chat, bookings, calendar, phone settings, conversation history and the greeting are unaffected.',
    cur.inherited ? `This business currently follows the global default (${PROVIDER_CAPABILITIES[cur.defaultProvider]?.name || cur.defaultProvider}); after the switch it has an explicit provider of its own and no longer follows global changes.` : 'This business keeps an explicit provider of its own (not the global default).',
    'The previous provider and voice are kept for a one-click rollback.',
  ]
  return { ok: blockers.length === 0, provider, checks, blockers, consequences, voice, inherited: cur.inherited, transfer: { personality: true, pace: cap.pace, voice: cur.provider === provider } }
}

// Admin: switch after the checklist passes and the admin confirmed. Atomic (one conditional write), audited either way.
// → { ok, settings, check } | { ok: false, error: 'blocked' | 'confirmation_required' | 'stale' | 'not_platform_admin', check }
export async function switchProvider(env, customer, admin, { provider, voiceId = '', useDefaultVoice = false, confirm = false, version }, now = Date.now()) {
  if (!isPlatformAdminEmail(env, admin?.email)) return { ok: false, error: 'not_platform_admin' }
  const db = env.ONBOARDING_DB
  const check = await checkProviderSwitch(env, customer, { provider, voiceId, useDefaultVoice }, now)
  const cur = await getVoiceSettings(db, customer.id)
  const detail = { from: cur.provider, to: provider, voiceFrom: cur.voiceId ? 'chosen' : 'default', voiceTo: check.voice ? 'chosen' : 'default', blockers: check.blockers }
  if (!check.ok) {
    await audit(env, admin.email, 'receptionist.provider_switch_blocked', customer.id, { ...detail, outcome: 'blocked' }).catch(() => {})
    return { ok: false, error: 'blocked', check }
  }
  if (confirm !== true) return { ok: false, error: 'confirmation_required', check }
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', check, version: cur.version }
  const next = { ...cur, provider, voiceId: check.voice?.id || null, voiceName: check.voice?.name || null, previous: { provider: cur.provider, voiceId: cur.voiceId, voiceName: cur.voiceName, pace: cur.pace, inherited: cur.inherited, at: now } }
  // An explicit switch is an override: the business stops following the global default.
  const w = await writeSettings(db, customer.id, next, cur.version, await emailRef(admin.email), now, { inherit: false })
  await audit(env, admin.email, 'receptionist.provider_switched', customer.id, { ...detail, inherited: cur.inherited, outcome: w.ok ? 'success' : w.error }).catch(() => {})
  return w.ok ? { ok: true, settings: w.settings, check } : { ...w, check }
}

// Admin: back to the configuration before the last switch (provider + voice + pace), one conditional write, audited.
export async function rollbackProvider(env, customer, admin, { confirm = false, version }, now = Date.now()) {
  if (!isPlatformAdminEmail(env, admin?.email)) return { ok: false, error: 'not_platform_admin' }
  const db = env.ONBOARDING_DB
  const cur = await getVoiceSettings(db, customer.id)
  if (!cur.previous) return { ok: false, error: 'nothing_to_roll_back' }
  if (confirm !== true) return { ok: false, error: 'confirmation_required', previous: cur.previous }
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', version: cur.version }
  const p = cur.previous
  if (!PROVIDERS.includes(p.provider)) return { ok: false, error: 'invalid_previous' }
  const next = { ...cur, provider: p.provider, voiceId: p.voiceId || null, voiceName: p.voiceName || null, pace: PACES[p.pace] ? p.pace : cur.pace, previous: null }
  // Back to following the global default only if that is what the business did AND the default still is that provider
  // (otherwise a rollback would silently land it on a provider it was never verified on): else an explicit override.
  const inherit = Boolean(p.inherited) && cur.defaultProvider === p.provider
  const w = await writeSettings(db, customer.id, next, cur.version, await emailRef(admin.email), now, { inherit })
  await audit(env, admin.email, 'receptionist.provider_rolled_back', customer.id, { from: cur.provider, to: p.provider, inherited: inherit, outcome: w.ok ? 'success' : w.error }).catch(() => {})
  return w
}

// Lab sessions: an admin may test a candidate voice of any provider; it must be in that provider's catalog.
export async function labVoiceFor(env, provider, voiceId, now = Date.now()) {
  if (!voiceId) return null
  const v = await validateVoice(env, provider, voiceId, { now })
  return v.ok ? v.voice.id : null
}

