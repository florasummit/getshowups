// GET /api/platform/voice-lab/status — platform admins only; 404 unless VOICE_LAB_ENABLED=true.
// Which providers are configured (booleans + codes, never values), the Lab's limits and usage today, the admin-marked
// test businesses the Lab may use, and recent Lab sessions. Read-only.
import { json } from '../../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../../server/platform.js'
import { labEnabled, labDailyMinutes, providerStatus, providerReadiness, COST_ESTIMATES, OPENAI_VOICES } from '../../../../server/voice/providers.js'
import { labMinutesToday, listLabSessions } from '../../../../server/voice/sessions.js'
import { catalogFor } from '../../../../server/voice/catalog.js'
import { isTestBusinessSql } from '../../../../server/testbusiness.js'
import { providerComparison, budgetOverview } from '../../../../server/voice/compare.js'
import { providerBalances, CHARGE_SUPPORT } from '../../../../server/voice/charges.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const { results } = await env.ONBOARDING_DB.prepare(`SELECT id, name, timezone FROM customers WHERE ${isTestBusinessSql('id')} AND status = 'active' ORDER BY name LIMIT 50`).all()
  const now = Date.now()
  // ?balances=1: the providers' balance reads (ElevenLabs' subscription; the others say they have none), on request only.
  const wantBalances = new URL(request.url).searchParams.get('balances') === '1'
  const [used, sessions, comparison, budgets, balances] = await Promise.all([labMinutesToday(env, now), listLabSessions(env, 20), providerComparison(env, { now }), budgetOverview(env, now), wantBalances ? providerBalances(env, now) : null])
  return json(200, { providers: providerStatus(env), readiness: providerReadiness(env), settings: { openai: { voices: OPENAI_VOICES.map((id) => ({ id, name: id })) }, retell: { voices: (await catalogFor(env, 'retell')).voices.map((v) => ({ id: v.id, name: v.name })) }, elevenlabs: { voices: (await catalogFor(env, 'elevenlabs')).voices.map((v) => ({ id: v.id, name: v.name })) } }, estimates: COST_ESTIMATES, limits: { dailyMinutes: labDailyMinutes(env), usedMinutesToday: used }, businesses: results, sessions, comparison, budgets, chargeSupport: CHARGE_SUPPORT, ...(balances ? { balances } : {}) })
}
