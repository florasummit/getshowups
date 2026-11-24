// GET /api/health — public, for an uptime monitor: 200 { status: 'ok', job } or 503 { status, job }. No names, no data, no
// configuration details. status: ok | misconfigured (a critical binding or secret is missing) | database | job_stale | job_unknown.
import { json, missingConfig } from '../../server/google-oauth.js'
import { heartbeat } from '../../server/heartbeat.js'
import { hitByIp, tooManyJson } from '../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  if (!env.ONBOARDING_DB || missingConfig(env).length || !env.CRON_SECRET) return json(503, { status: 'misconfigured' })
  const rl = await hitByIp(env, 'health', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const job = await heartbeat(env.ONBOARDING_DB)
    return json(job.status === 'ok' ? 200 : 503, { status: job.status === 'ok' ? 'ok' : `job_${job.status}`, job: { ageSeconds: job.ageSeconds } })
  } catch {
    return json(503, { status: 'database' })
  }
}
