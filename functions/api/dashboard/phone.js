// /api/dashboard/phone — the business's phone line (server/telephony/, docs/TELEPHONE.md). 404 unless PHONE_ENABLED=true.
//   GET  → { lines, settings, destinations, calls, usage, setup, purchase, ai, recording: false, costs }
//   POST { action, … } (same origin, the session's business only, rate-limited):
//     settings { answer, ringSeconds, fallback, afterHours, screen, version }   → 409 stale when changed elsewhere
//     add_destination { number, label } · remove_destination { id } · verify_destination { id } → { code } (a call is placed)
//     search_numbers { areaCode } · buy_number { number, source, confirm: true }   (PHONE_NUMBER_PURCHASE=true; paid)
//     update_line { id, source, forwardedFrom, forwardMode } · release_line { id, confirm: true }
//     show_number { id, confirm: true, base }   the line becomes the phone on the website, booking page and receptionist
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit } from '../../../server/ratelimit.js'
import { getProfile } from '../../../server/onboarding.js'
import { getSettings as receptionistSettings } from '../../../server/receptionist/engine.js'
import { voiceConfigured, voiceAllowedFor } from '../../../server/receptionist/voice.js'
import { listCalls } from '../../../server/telephony/calls.js'
import {
  COST_ESTIMATES, activeLines, addDestination, buyNumber, destinations, getSettings, limits, phoneEnabled, phoneReady, phoneSetup,
  purchaseEnabled, releaseLine, removeDestination, saveSettings, searchNumbers, startVerification, updateLine, usage,
} from '../../../server/telephony/lines.js'

const off = (env) => !phoneEnabled(env)

async function state(env, customer) {
  const db = env.ONBOARDING_DB
  const [lines, settings, dest, calls, used, setup, rec, profile] = await Promise.all([
    activeLines(db, customer.id),
    getSettings(db, customer.id),
    destinations(db, customer.id),
    listCalls(db, customer.id, { days: 30, limit: 25 }),
    usage(db, customer.id),
    phoneSetup(env, customer.id),
    receptionistSettings(db, customer.id).catch(() => null),
    getProfile(db, customer.id).catch(() => null),
  ])
  return {
    lines: lines.map((l) => ({ id: l.id, number: l.number, source: l.source, forwardedFrom: l.forwarded_from, forwardMode: l.forward_mode, shown: profile?.phone ? profile.phone.replace(/\D/g, '').endsWith(l.number.slice(2)) : false })),
    settings,
    destinations: dest.map((d) => ({ id: d.id, number: d.number, label: d.label, verified: Boolean(d.verified_at) })),
    calls,
    usage: used,
    limits: limits(env),
    setup,
    purchase: purchaseEnabled(env),
    // The AI can answer phone calls only when the receptionist is on and voice is released for this business.
    ai: { available: Boolean(rec?.enabled) && voiceConfigured(env) && voiceAllowedFor(env, customer.id), receptionistOn: Boolean(rec?.enabled) },
    recording: false,
    costs: COST_ESTIMATES,
    websitePhone: profile?.phone || '',
  }
}

export async function onRequestGet({ request, env }) {
  if (off(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await phoneReady(env.ONBOARDING_DB))) return json(200, { unavailable: true })
  return json(200, await state(env, session.customer))
}

export async function onRequestPost({ request, env }) {
  if (off(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await phoneReady(env.ONBOARDING_DB))) return json(503, { error: 'not_ready' })
  const rl = await hit(env, 'phoneWrite', session.customer.id)
  if (rl.limited) return json(429, { error: 'rate_limited' })
  const b = await request.json().catch(() => null)
  const c = session.customer
  const origin = new URL(request.url).origin
  const actor = `owner:${session.email}`
  let r
  try {
    switch (b?.action) {
      case 'settings':
        if (b.fallback === 'ai') {
          const rec = await receptionistSettings(env.ONBOARDING_DB, c.id).catch(() => null)
          if (!rec?.enabled || !voiceConfigured(env) || !voiceAllowedFor(env, c.id)) return json(400, { error: 'ai_unavailable' })
        }
        r = await saveSettings(env, c, b)
        break
      case 'add_destination':
        r = await addDestination(env, c, b)
        break
      case 'remove_destination':
        r = await removeDestination(env, c, b.id)
        break
      case 'verify_destination':
        r = await startVerification(env, c, b.id, { origin })
        break
      case 'search_numbers':
        r = await searchNumbers(env, c, b.areaCode)
        break
      case 'buy_number':
        if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
        r = await buyNumber(env, c, b, { origin, actor })
        break
      case 'update_line':
        r = await updateLine(env, c, b)
        break
      case 'release_line':
        if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
        r = await releaseLine(env, c, b.id, { actor })
        break
      case 'show_number': {
        if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
        const line = (await activeLines(env.ONBOARDING_DB, c.id)).find((l) => l.id === b.id)
        if (!line) return json(404, { error: 'not_found' })
        const profile = await getProfile(env.ONBOARDING_DB, c.id)
        if (!profile) return json(409, { error: 'profile_missing' })
        // `base` = the phone the page showed: changed elsewhere since → nothing replaced.
        if (typeof b.base === 'string' && b.base !== (profile.phone || '')) return json(409, { error: 'conflict' })
        await env.ONBOARDING_DB.prepare('UPDATE business_profiles SET phone = ?2, updated_at = ?3 WHERE customer = ?1').bind(c.id, line.number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'), Date.now()).run()
        r = { ok: true }
        break
      }
      default:
        return json(400, { error: 'invalid_request' })
    }
  } catch (err) {
    console.error('phone action failed:', b?.action, err?.name)
    return json(503, { error: 'storage_error' })
  }
  if (!r.ok) return json(r.status || 400, { error: r.error, ...(r.fields ? { fields: r.fields } : {}) })
  const rest = Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'ok' && k !== 'status'))
  return json(200, { ...rest, state: await state(env, c) })
}
