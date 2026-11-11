// Hostname routing for connected business domains. Requests to our own addresses pass straight through.
// A customer hostname serves only that business's website (and its images, robots and sitemap);
// everything else on it redirects to the site root. Booking, sign-in and the dashboard stay on the
// GetShowUps address. Unknown hostnames get a plain "not available" page.
import { missingConfig } from '../server/google-oauth.js'
import { siteOrigin } from '../server/auth.js'
import { customerForHost } from '../server/domains.js'
import { serveSite } from '../server/site-serve.js'
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

const text = (body, type = 'text/plain; charset=utf-8') => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })

export async function onRequest(context) {
  const { request, env, next } = context
  const url = new URL(request.url)
  // Preview deployments have no bindings: nothing to route.
  if (missingConfig(env).length || isOwnHost(url.hostname, env)) return next()
  // Certificate validation and platform paths are left to the hosting platform.
  if (url.pathname.startsWith('/.well-known/acme-challenge/') || url.pathname.startsWith('/cdn-cgi/')) return next()

  const host = url.hostname.toLowerCase()
  const site = await customerForHost(env.ONBOARDING_DB, host).catch(() => null)
  if (!site) return htmlResponse(404, renderNotice('This website isn’t available', 'Check the address and try again.'), { cache: 'no-store' })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })

  const p = url.pathname
  if (p === '/.well-known/getshowups-site') return new Response(site.verify_token.slice(0, 12), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
  if (p === '/' || p === '/index.html') return serveSite(env, request, site.customer)
  if (p.startsWith('/site-assets/') || p.startsWith('/site-stock/') || p.startsWith('/site-fonts/')) return next()
  if (p === '/robots.txt') return text(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`)
  if (p === '/sitemap.xml') return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${host}/</loc></url></urlset>\n`, 'application/xml')
  if (p === '/favicon.svg' || p === '/favicon.ico') return next()
  if (p.startsWith('/dashboard') || p.startsWith('/book/')) return Response.redirect(`${siteOrigin(env)}${p}${url.search}`, 302)
  return Response.redirect(`https://${host}/`, 301)
}
