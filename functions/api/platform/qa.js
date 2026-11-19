// QA (platform admins only).
//   GET  /api/platform/qa                → automated + human runs, failed journeys, activation, journey definitions
//   GET  /api/platform/qa?run=<id>       → one run: results (failed first), findings
//   GET  /api/platform/qa?test=<test id> → retest history of one test
//   POST /api/platform/qa { action: start | step | finding | finish, ... } → guided human QA (same-origin, audited
//        on start/finish). Records observations only; it never changes a business, a message or a setting.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { addFinding, finishHumanRun, qaOverview, qaReady, recordStep, runDetail, startHumanRun, testHistory } from '../../../server/ops/qa.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const p = new URL(request.url).searchParams
  try {
    if (!(await qaReady(db))) return json(200, { available: false })
    if (p.get('run')) {
      const d = await runDetail(db, p.get('run'))
      return d ? json(200, d) : json(404, { error: 'not_found' })
    }
    if (p.get('test')) return json(200, { history: await testHistory(db, p.get('test')) })
    return json(200, { available: true, ...(await qaOverview(db)) })
  } catch (err) {
    console.error('qa read failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const db = env.ONBOARDING_DB
  if (!(await qaReady(db))) return json(503, { error: 'not_available' })
  const rl = await hit(env, 'qaWrite', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = (await request.json().catch(() => null)) || {}
  try {
    let r
    if (b.action === 'start') {
      const customer = b.customer ? String(b.customer).toLowerCase() : null
      if (customer && !CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })
      r = await startHumanRun(db, { journey: b.journey, customer, provider: b.provider || 'mocked', testerEmail: admin.email })
      if (r.id) await audit(env, admin.email, 'qa.human_run_started', customer, { journey: b.journey, run: r.id })
    } else if (b.action === 'step') r = await recordStep(db, b)
    else if (b.action === 'finding') r = await addFinding(db, b)
    else if (b.action === 'finish') {
      r = await finishHumanRun(db, b)
      if (r.status) await audit(env, admin.email, 'qa.human_run_finished', null, { run: String(b.run), status: r.status })
    } else return json(400, { error: 'invalid_action' })
    if (r.error) return json(r.error === 'not_found' ? 404 : r.error === 'run_finished' ? 409 : 400, { error: r.error })
    return json(200, r)
  } catch (err) {
    console.error('qa write failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
