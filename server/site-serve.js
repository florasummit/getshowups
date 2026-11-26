// Serves a business's public website (getshowups.com/p/:id or a connected domain). A site is shown
// only when it is published, the business is active and bookable, and hosting is included in its plan.
// Anything else gets the same "not available" page as an unknown address (no information leaks).
import { testStatus } from './testbusiness.js'
import { CUSTOMER_RE } from './invites.js'
import { customerFromRow, siteOrigin } from './auth.js'
import { offerSmsFor } from './followups/settings.js'
import { receptionistOn } from './receptionist/engine.js'
import { chatPanel, chatPanelSetting } from './chat-panel.js'

// Floating "Chat or talk with us" link (inline styles only; the site CSP allows no scripts and no frames).
export const chatLink = (href) =>
  `<a href="${href.replace(/[<>"']/g, '').replace(/&/g, '&amp;')}" data-gsu-chat style="position:fixed;right:16px;bottom:16px;z-index:50;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:999px;background:#111113;color:#fff;font:600 15px/1.2 system-ui,-apple-system,sans-serif;text-decoration:none;box-shadow:0 8px 24px rgb(0 0 0 / .25)">Chat or talk with us</a>`
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
  // Days with their own hours (server/day-hours.js) only when there are any, so other sites' content stays as before.
  const own = customer.dayHours && Object.keys(customer.dayHours).length ? { dayHours: customer.dayHours } : {}
  const hours = customer.hoursConfirmed && customer.workdays?.length ? { dayStart: customer.dayStart, dayEnd: customer.dayEnd, workdays: customer.workdays, ...own } : null
  return { id: customer.id, name: customer.name, appointmentMode: customer.appointmentMode, phone: p?.phone || '', cities, hours }
}

// Where a customer can reach a business that has no phone on record (booking page, BOOK-03): its LIVE website, else its
// chat page when that would open. Only addresses the business already shows the public; null when there is neither.
export async function reachFor(env, customer) {
  const db = env.ONBOARDING_DB
  const origin = siteOrigin(env)
  try {
    if (isHosted(await hostingStatus(db, customer.id, Date.now(), env)) && (await liveContent(db, customer.id))) {
      const host = await connectedHost(db, customer.id)
      return { kind: 'website', url: host ? `https://${host}/` : `${origin}/p/${customer.id}` }
    }
  } catch {
    // unreadable: try the chat
  }
  if (await receptionistOn(env, customer).catch(() => false)) return { kind: 'chat', url: `${origin}/chat/${customer.id}` }
  return null
}

// page: a page slug of an AI-designed (multi-page) site; '' is the home page. Unknown pages are "not available".
export async function serveSite(env, request, id, page = '') {
  const db = env.ONBOARDING_DB
  const rl = await hitByIp(env, 'pageView', request)
  if (rl.limited) return htmlResponse(429, renderNotice('Please wait a moment', 'Too many requests. Try again shortly.'), { cache: 'no-store' })
  try {
    const customer = await businessForSite(env, id)
    if (!customer) return unavailable()
    if (!isHosted(await hostingStatus(db, customer.id, Date.now(), env))) return unavailable()
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
    // Ad attribution (utm_* / gclid from the ad's landing address) rides along with the form and the chat link, so leads
    // from the website are tied to the campaign the same way booking-page leads are (server/ads/attribution.js).
    const carried = carryQuery(request.url)
    const form = { action: `${origin}/api/site-form/${customer.id}`, token: await formToken(env, customer.id), state, attribution: Object.fromEntries(new URLSearchParams(carried.slice(1))) }
    // A page showing a send result is personal to that visitor: not cached.
    // Website forms offer texting only when this business can text (own sender + approved registration).
    const info = { ...(await siteBusinessInfo(db, customer)), offerSms: await offerSmsFor(env, customer), smsTermsUrl: `${origin}/sms-terms/${customer.id}` }
    let html = renderSite(info, live.content, { canonical, bookUrl, privacyUrl: `${origin}/privacy`, noindex, page, pageBase: host ? '' : `/p/${customer.id}`, form })
    // AI receptionist on: one plain link to the business's chat/voice page on GetShowUps (no script on the site).
    // The owner may show the same chat page in a panel instead (server/chat-panel.js; off = the link, unchanged). A
    // setting that can't be read is the link.
    let frame = null
    if (await receptionistOn(env, customer).catch(() => false)) {
      const href = `${origin}/chat/${customer.id}${carried}`
      const panel = (await chatPanelSetting(db, customer.id).catch(() => ({ on: false }))).on
      if (panel) frame = origin
      html = html.replace('</body>', `${panel ? chatPanel(href) : chatLink(href)}</body>`)
    }
    return htmlResponse(200, html, { noindex, formAction: origin, ...(frame ? { frame } : {}), ...(state ? { cache: 'no-store' } : {}) })
  } catch (err) {
    console.error('site render failed:', err?.message)
    return htmlResponse(503, renderNotice('We can’t load this website right now', 'Please try again in a moment.'), { cache: 'no-store' })
  }
}
