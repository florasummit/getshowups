// Serves a business's public website (getshowups.com/p/:id or a connected domain). A site is shown
// only when it is published, the business is active and bookable, and hosting is included in its plan.
// Anything else gets the same "not available" page as an unknown address (no information leaks).
import { testStatus } from './testbusiness.js'
import { CUSTOMER_RE } from './invites.js'
import { customerFromRow, siteOrigin } from './auth.js'
import { smsReadyFor } from './followups/settings.js'
import { getCustomer } from './customers.js'
import { hitByIp } from './ratelimit.js'
import { hostingStatus, isHosted, liveContent } from './website.js'
import { connectedHost } from './domains.js'
import { carryQuery, htmlResponse, renderNotice, renderSite } from './site-render.js'
import { formToken } from './site-form.js'

const unavailable = () => htmlResponse(404, renderNotice('This website isn’t available', 'Check the address and try again.'), { cache: 'no-store' })

export async function businessForSite(env, id) {
  if (!CUSTOMER_RE.test(id)) return null
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, id))
  if (!customer || customer.status !== 'active' || !customer.hoursConfirmed || !(await env.GOOGLE_TOKENS.get(`google:${id}`))) return null
  return customer
}

export async function siteBusinessInfo(db, customer) {
  const p = await db.prepare('SELECT phone, cities FROM business_profiles WHERE customer = ?1').bind(customer.id).first()
  const cities = (() => {
    try {
      return JSON.parse(p?.cities || '[]')
    } catch {
      return []
    }
  })()
  // Hours: the owner's confirmed booking hours (structured data only; never shown as a promise of availability).
  const hours = customer.hoursConfirmed && customer.workdays?.length ? { dayStart: customer.dayStart, dayEnd: customer.dayEnd, workdays: customer.workdays } : null
  return { id: customer.id, name: customer.name, appointmentMode: customer.appointmentMode, phone: p?.phone || '', cities, hours }
}

// page: a page slug of an AI-designed (multi-page) site; '' is the home page. Unknown pages are "not available".
export async function serveSite(env, request, id, page = '') {
  const db = env.ONBOARDING_DB
  const rl = await hitByIp(env, 'pageView', request)
  if (rl.limited) return htmlResponse(429, renderNotice('Please wait a moment', 'Too many requests. Try again shortly.'), { cache: 'no-store' })
  try {
    const customer = await businessForSite(env, id)
    if (!customer) return unavailable()
    if (!isHosted(await hostingStatus(db, customer.id))) return unavailable()
    const live = await liveContent(db, customer.id)
    if (!live) return unavailable()
    if (page && !live.content.site?.pages?.some((p) => p.slug === page)) return unavailable()
    const host = await connectedHost(db, customer.id)
    const canonical = host ? `https://${host}/` : `${siteOrigin(env)}/p/${customer.id}`
    // Booking always happens on the GetShowUps address (same-origin checks, one sign-in domain).
    const origin = siteOrigin(env)
    const bookUrl = `${origin}/book/${customer.id}${carryQuery(request.url)}`
    // Test businesses (admin-marked) are published for checks only: never indexed (fails closed via testStatus).
    const noindex = (await testStatus(env, customer.id)).test
    // Contact/quote forms (server/site-form.js): where they post, a signed render time, and the result of a send.
    const q = new URL(request.url).searchParams
    const state = q.get('sent') === '1' ? 'sent' : /^[a-z_]{3,24}$/.test(q.get('form') || '') ? q.get('form') : null
    const form = { action: `${origin}/api/site-form/${customer.id}`, token: await formToken(env, customer.id), state }
    // A page showing a send result is personal to that visitor: not cached.
    // Website forms offer texting only when this business can text (own sender + approved registration).
    const info = { ...(await siteBusinessInfo(db, customer)), offerSms: Boolean(customer.automations) && (await smsReadyFor(env, customer.id)).ok, smsTermsUrl: `${origin}/sms-terms/${customer.id}` }
    return htmlResponse(200, renderSite(info, live.content, { canonical, bookUrl, privacyUrl: `${origin}/privacy`, noindex, page, pageBase: host ? '' : `/p/${customer.id}`, form }), { noindex, formAction: origin, ...(state ? { cache: 'no-store' } : {}) })
  } catch (err) {
    console.error('site render failed:', err?.message)
    return htmlResponse(503, renderNotice('We can’t load this website right now', 'Please try again in a moment.'), { cache: 'no-store' })
  }
}
