// POST /api/dashboard/test-mark { leadId, isTest } — the owner marks a lead (and its appointments) as a
// test, or as a real customer. Nothing is deleted; test records are only left out of results.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { markTest } from '../../../server/testdata.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const r = await markTest(env.ONBOARDING_DB, session.customer.id, body?.leadId, body?.isTest, session.email)
  return r.ok ? json(200, { ok: true }) : json(r.httpStatus, { error: r.error })
}
