// /api/platform/ai-spend — GetShowUps-paid AI spending (server/ai-budget.js). Platform admins only; business ids and
// micro-dollars, nothing else.
//   GET  → today's platform / public / per-business / per-entry spend, Retell minutes, ceilings, settings, warnings, switches
//   POST { action: 'set', key, value, reason, confirm: true }  key: platform_micros | public_micros | business_micros |
//        retell_minutes | all_off. Same origin, rate-limited per admin, audited (from → to, reason). Applies within 30 s.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { setBudgetSetting, spendToday } from '../../../server/ai-budget.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    return json(200, await spendToday(env))
  } catch {
    return json(503, { error: 'unavailable' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const b = (await request.json().catch(() => null)) || {}
  if (b.action !== 'set') return json(400, { error: 'invalid_action' })
  if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
  const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (reason.length < 3) return json(400, { error: 'reason_required' })
  const rl = await hit(env, 'aiBudgetAdmin', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const r = await setBudgetSetting(env, String(b.key || ''), b.value, admin.email)
  if (!r.ok) return json(r.error === 'not_ready' || r.error === 'storage_error' ? 503 : 400, { error: r.error })
  await audit(env, admin.email, 'ai_budget.set', null, { key: b.key, from: r.before, to: r.after, reason })
  return json(200, await spendToday(env))
}
