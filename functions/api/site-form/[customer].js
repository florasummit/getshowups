// POST /api/site-form/:customer: a contact or quote-request form on a business website (server/site-form.js).
// Plain HTML form post (application/x-www-form-urlencoded) from the business's site (our /p/<id> address or its own
// domain), so no same-origin check: it is a public form, protected by the signed render time, a trap field and rate
// limits. Always answers with a 303 back to the page the form was on (never a JSON body a visitor would see).
import { bookableCustomer } from '../../../server/public.js'
import { hit, hitByIp } from '../../../server/ratelimit.js'
import { submitSiteForm } from '../../../server/site-form.js'
import { siteOrigin } from '../../../server/auth.js'
import { connectedHost } from '../../../server/domains.js'
import { liveContent } from '../../../server/website.js'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const fields = Object.fromEntries([...(await request.formData().catch(() => new FormData())).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : '']))
  let state
  const limited = (await hitByIp(env, 'siteForm', request)).limited || (await hit(env, 'siteFormPerBusiness', customer.id)).limited
  if (limited) state = 'rate_limited'
  else state = (await submitSiteForm(env, customer, fields)).state
  // Back to the page the form was on: only a page the live site really has, on the business's own address.
  const live = await liveContent(env.ONBOARDING_DB, customer.id).catch(() => null)
  const slug = SLUG_RE.test(fields.page || '') && live?.content?.site?.pages?.some((p) => p.slug === fields.page) ? fields.page : ''
  const host = await connectedHost(env.ONBOARDING_DB, customer.id).catch(() => null)
  const base = host ? `https://${host}${slug ? `/${slug}` : '/'}` : `${siteOrigin(env)}/p/${customer.id}${slug ? `/${slug}` : ''}`
  const query = state === 'sent' ? 'sent=1' : `form=${encodeURIComponent(state)}`
  const anchor = SLUG_RE.test(fields.section || '') ? `#f-${fields.section}` : ''
  return new Response(null, { status: 303, headers: { Location: `${base}?${query}${anchor}`, 'Cache-Control': 'no-store' } })
}
