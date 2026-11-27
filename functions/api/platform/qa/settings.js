// QA settings (platform admins): the QA evaluation budget (daily + monthly, micro-dollars; default 0 = paid evaluations
// refused), the paid-evaluations switch (still needs QA_PAID_EVALS='true'), screenshot retention in days, and the
// optional daily production verification.
//   GET  /api/platform/qa/settings
//   POST /api/platform/qa/settings { key, value, reason, confirm: true }   (same-origin, audited from → to)
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaGet, qaPost } from '../../../../server/ops/qa-route.js'
import { qaSettings, setQaSetting } from '../../../../server/ops/qa-spend.js'

export const onRequestGet = qaGet(async ({ env }) => {
  const s = await qaSettings(env.ONBOARDING_DB)
  return json(200, { settings: s.values, max: s.max, changed: s.changed })
})

export const onRequestPost = qaPost(async ({ env, body, admin, actor }) => {
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  const reason = String(body.reason || '').trim().slice(0, 200)
  if (reason.length < 3) return json(400, { error: 'reason_required' })
  const r = await setQaSetting(env.ONBOARDING_DB, String(body.key || ''), body.value, actor)
  if (r.error) return fail(r)
  await audit(env, admin.email, 'qa.setting_changed', null, { key: body.key, from: r.before, to: r.after, reason })
  return json(200, r)
})
