// GET /r/<code> — a referral link. Redirects to the homepage with ?partner=<code>, where the browser keeps it as a
// first-touch candidate (src/lib/referral.js) for the self-serve signup. Nothing is looked up or stored here, so a
// visitor can't learn whether a code exists (the same redirect either way); the code is validated when a business is
// created (server/commercial-attribution.js). A malformed code is dropped. Rate limited per IP (fails open).
import { CODE_RE } from '../../server/commercial-attribution.js'
import { hitByIp, tooManyPage } from '../../server/ratelimit.js'

export async function onRequestGet({ request, env, params }) {
  if (env?.ONBOARDING_DB) {
    const rl = await hitByIp(env, 'referralLink', request)
    if (rl.limited) return tooManyPage(rl.retryAfter)
  }
  const code = String(params.code || '').trim().toLowerCase()
  const to = new URL('/', request.url)
  if (CODE_RE.test(code)) to.searchParams.set('partner', code)
  return new Response(null, { status: 302, headers: { Location: `${to.pathname}${to.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}
