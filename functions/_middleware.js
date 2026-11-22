// Hostname routing for connected business domains. Requests to our own addresses pass straight through.
// A customer hostname serves only that business's website (and its images, robots and sitemap);
// everything else on it redirects to the site root. Booking, sign-in and the dashboard stay on the
// GetShowUps address. Unknown hostnames get a plain "not available" page.
import { missingConfig } from '../server/google-oauth.js'
import { siteOrigin } from '../server/auth.js'
import { customerForHost } from '../server/domains.js'
import { serveSite } from '../server/site-serve.js'
import { liveContent } from '../server/website.js'
import { testStatus } from '../server/testbusiness.js'
import { htmlResponse, renderNotice } from '../server/site-render.js'

export function isOwnHost(host, env) {
  if (!host) return true
  const h = host.toLowerCase().replace(/:\d+$/, '')
  if (h === '127.0.0.1' || h === 'localhost' || h.endsWith('.pages.dev')) return true
  try {
    const own = new URL(siteOrigin(env)).hostname
    return h === own || h === `www.${own}`
  } catch {
    return true
  }
}

// Common addresses of the same page on other website builders → the page slugs GetShowUps' page templates use.
const OLD_ADDRESS_ALIASES = {
  'about-us': 'about',
  'our-story': 'about',
  'who-we-are': 'about',
  'contact-us': 'contact',
  'privacy-policy': 'privacy',
  'privacy-notice': 'privacy',
  'terms-of-service': 'terms',
  'terms-and-conditions': 'terms',
  'terms-of-use': 'terms',
  faqs: 'faq',
  'our-services': 'services',
  'service-areas': 'service-area',
  'areas-we-serve': 'service-area',
}
const text = (body, type = 'text/plain; charset=utf-8') => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })

// Our own host: the signed-in areas can't be framed by another site (clickjacking: a hidden frame tricking an owner into
// "Publish" or "Approve budget"), and browsers are told to use HTTPS only. Business websites set their own strict CSP
// (no scripts at all, frame-ancestors 'none') in their renderer; booking/chat pages stay embeddable for now.
export const FRAME_PROTECTED = /^\/(dashboard|admin)(\/|$)/
export async function withAppHeaders(res, url) {
  // A WebSocket upgrade (voice receptionist) must be returned as is: re-wrapping would drop the socket.
  if (res.status === 101 || res.webSocket) return res
  const headers = new Headers(res.headers)
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=15552000')
  if (FRAME_PROTECTED.test(url.pathname)) {
    headers.set('X-Frame-Options', 'DENY')
    if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export async function onRequest(context) {
  const { request, env, next } = context
  const url = new URL(request.url)
  // Preview deployments have no bindings: nothing to route.
  if (missingConfig(env).length || isOwnHost(url.hostname, env)) return withAppHeaders(await next(), url)
  // Certificate validation and platform paths are left to the hosting platform.
  if (url.pathname.startsWith('/.well-known/acme-challenge/') || url.pathname.startsWith('/cdn-cgi/')) return next()

  const host = url.hostname.toLowerCase()
  const site = await customerForHost(env.ONBOARDING_DB, host).catch(() => null)
  if (!site) return htmlResponse(404, renderNotice('This website isn’t available', 'Check the address and try again.'), { cache: 'no-store' })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })

  const p = url.pathname
  if (p === '/.well-known/getshowups-site') return new Response(site.verify_token.slice(0, 12), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
  if (p === '/' || p === '/index.html') return serveSite(env, request, site.customer)
  if (p.startsWith('/site-assets/') || p.startsWith('/site-stock/') || p.startsWith('/site-fonts/') || p.startsWith('/site-icon/')) return next()
  if (p === '/robots.txt') return text(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`)
  if (p === '/sitemap.xml') {
    // Every page of the published site (AI-designed sites can have several); test businesses are never listed.
    const live = await liveContent(env.ONBOARDING_DB, site.customer).catch(() => null)
    const test = (await testStatus(env, site.customer).catch(() => ({ test: true }))).test
    const slugs = test || !live ? [] : (live.content.site?.pages || [{ slug: '' }]).map((pg) => pg.slug)
    const lastmod = live?.publishedAt ? `<lastmod>${new Date(live.publishedAt).toISOString().slice(0, 10)}</lastmod>` : ''
    const urls = slugs.map((s) => `<url><loc>https://${host}/${s}</loc>${lastmod}</url>`).join('')
    return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`, 'application/xml')
  }
  if (p === '/favicon.svg' || p === '/favicon.ico') return next()
  if (p.startsWith('/dashboard') || p.startsWith('/book/')) return Response.redirect(`${siteOrigin(env)}${p}${url.search}`, 302)
  const live = await liveContent(env.ONBOARDING_DB, site.customer).catch(() => null)
  // A page of an AI-designed (multi-page) site, e.g. /services (published pages only; same rules as the home page).
  const slug = p.toLowerCase().replace(/^\/|\/+$/g, '')
  if (slug && live?.content?.site?.pages?.some((pg) => pg.slug === slug)) return serveSite(env, request, site.customer, slug)
  // A common old-site address for a page this site now has (e.g. /privacy-policy once a Privacy page exists), even when
  // the page was added after the import — so old links reach the closest page, not the home page.
  const alias = OLD_ADDRESS_ALIASES[slug]
  if (alias && live?.content?.site?.pages?.some((pg) => pg.slug === alias)) return Response.redirect(`https://${host}/${alias}`, 301)
  // An address from the business's previous website: send it to the matching place (published redirects only).
  const r = (live?.content?.redirects || []).find((x) => x.from === p.toLowerCase().replace(/\/+$/, ''))
  if (r) return Response.redirect(r.to === 'book' ? `${siteOrigin(env)}/book/${site.customer}` : `https://${host}${r.to}`, 301)
  return Response.redirect(`https://${host}/`, 301)
}
