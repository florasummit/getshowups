// Serves a business's public website (getshowups.com/p/:id or a connected domain). A site is shown
// only when it is published, the business is active and bookable, and hosting is included in its plan.
// Anything else gets the same "not available" page as an unknown address (no information leaks).
import { CUSTOMER_RE } from './invites.js'
import { customerFromRow, siteOrigin } from './auth.js'
import { getCustomer } from './customers.js'
import { hitByIp } from './ratelimit.js'
import { hostingStatus, isHosted, liveContent } from './website.js'
import { connectedHost } from './domains.js'
import { carryQuery, htmlResponse, renderNotice, renderSite } from './site-render.js'

const unavailable = () => htmlResponse(404, renderNotice('This website isn’t available', 'Check the address and try again.'), { cache: 'no-store' })

export async function businessForSite(env, id) {
  if (!CUSTOMER_RE.test(id)) return null
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, id))
  if (!customer || customer.status !== 'active' || !customer.hoursConfirmed || !(await env.GOOGLE_TOKENS.get(`google:${id}`))) return null
  return customer
}

export async function siteBusinessInfo(db, customer) {
  const phone = (await db.prepare('SELECT phone FROM business_profiles WHERE customer = ?1').bind(customer.id).first())?.phone || ''
  return { id: customer.id, name: customer.name, appointmentMode: customer.appointmentMode, phone }
}

export async function serveSite(env, request, id) {
  const db = env.ONBOARDING_DB
  const rl = await hitByIp(env, 'pageView', request)
  if (rl.limited) return htmlResponse(429, renderNotice('Please wait a moment', 'Too many requests. Try again shortly.'), { cache: 'no-store' })
  try {
    const customer = await businessForSite(env, id)
    if (!customer) return unavailable()
    if (!isHosted(await hostingStatus(db, customer.id))) return unavailable()
    const live = await liveContent(db, customer.id)
    if (!live) return unavailable()
    const host = await connectedHost(db, customer.id)
    const canonical = host ? `https://${host}/` : `${siteOrigin(env)}/p/${customer.id}`
    // Booking always happens on the GetShowUps address (same-origin checks, one sign-in domain).
    const origin = siteOrigin(env)
    const bookUrl = `${origin}/book/${customer.id}${carryQuery(request.url)}`
    return htmlResponse(200, renderSite(await siteBusinessInfo(db, customer), live.content, { canonical, bookUrl, privacyUrl: `${origin}/privacy` }))
  } catch (err) {
    console.error('site render failed:', err?.message)
    return htmlResponse(503, renderNotice('We can’t load this website right now', 'Please try again in a moment.'), { cache: 'no-store' })
  }
}
