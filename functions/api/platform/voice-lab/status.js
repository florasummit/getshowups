// GET /api/platform/voice-lab/status — platform admins only; 404 unless VOICE_LAB_ENABLED=true.
// Which providers are configured (booleans + codes, never values), the Lab's limits and usage today, the admin-marked
// test businesses the Lab may use, and recent Lab sessions. Read-only.
import { json } from '../../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../../server/platform.js'
import { labEnabled, labDailyMinutes, providerStatus, COST_ESTIMATES } from '../../../../server/voice/providers.js'
import { labMinutesToday, listLabSessions } from '../../../../server/voice/sessions.js'
import { isTestBusinessSql } from '../../../../server/testbusiness.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const { results } = await env.ONBOARDING_DB.prepare(`SELECT id, name, timezone FROM customers WHERE ${isTestBusinessSql('id')} AND status = 'active' ORDER BY name LIMIT 50`).all()
  const [used, sessions] = await Promise.all([labMinutesToday(env), listLabSessions(env, 20)])
  return json(200, { providers: providerStatus(env), estimates: COST_ESTIMATES, limits: { dailyMinutes: labDailyMinutes(env), usedMinutesToday: used }, businesses: results, sessions })
}
