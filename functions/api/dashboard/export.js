// GET /api/dashboard/export — everything the business owns, as one .zip (CSV for people and money, JSON for the rest,
// uploaded images). The owner only, with a recent sign-in; built for the session's business only; audited.
import { json } from '../../../server/google-oauth.js'
import { isOwner, needsFresh, requireSession } from '../../../server/auth.js'
import { businessExport } from '../../../server/business-export.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { appendOwnerChange } from '../../../server/owner-changes.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  // Nobody else's page may trigger a download of this data.
  if (!['same-origin', 'none', null].includes(request.headers.get('Sec-Fetch-Site'))) return json(403, { error: 'forbidden' })
  try {
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    const stale = needsFresh(session)
    if (stale) return stale
    if (new URL(request.url).searchParams.get('check') === '1') return json(200, { ok: true })
    const rl = await hit(env, 'accountExport', session.customer.id)
    if (rl.limited) return tooManyJson(rl.retryAfter)
    const r = await businessExport(env, session.customer)
    await appendOwnerChange(env, session, 'account.data_exported', { files: r.files, bytes: r.bytes.length })
    return new Response(r.bytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${session.customer.id}-export.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch (err) {
    console.error('business export failed:', err?.name)
    return json(503, { error: 'export_failed' })
  }
}
