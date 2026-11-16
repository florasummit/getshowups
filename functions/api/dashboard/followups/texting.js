// POST /api/dashboard/followups/texting — the owner's US texting registration (A2P 10DLC) preparation.
//   { action: 'save', details }   business facts (validated; never invented)
//   { action: 'approve', confirm: true }   the owner's explicit approval to submit (attestation shown in the UI)
// Submission to the provider and the provider's decision are recorded by a platform admin (registration.js).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { followupsReady } from '../../../../server/followups/settings.js'
import { approveSubmission, getRegistration, registrationView, saveFacts, validateFacts } from '../../../../server/followups/registration.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  if (!(await followupsReady(db))) return json(409, { error: 'not_ready' })
  const rl = await hit(env, 'followupWrite', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  let r
  if (body?.action === 'save') {
    const [errors, v] = validateFacts(body.details)
    if (errors.length) return json(400, { error: 'invalid_details', fields: errors })
    r = await saveFacts(db, id, v)
  } else if (body?.action === 'approve') {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    r = await approveSubmission(db, id, session.customer.name, session.email)
  } else return json(400, { error: 'invalid_request' })
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  return json(200, { texting: registrationView(await getRegistration(db, id), session.customer.name) })
}
