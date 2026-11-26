// The <head> of a business's public pages (/book/<id>, /chat/<id>). They are served from the app's index.html, whose
// title, description and share card describe GetShowUps itself (its marketing line and its own price). A customer of
// the business must never see that in a browser tab, a search result or a link preview, so on these two routes the
// document leaves with neutral text; the page then names the business in the tab (src/public/head.js). No lookup, no
// business data: the same neutral head for every id, existing or not. GetShowUps' own pages keep its own head.
import { SALES_BUSINESS } from './public.js'

const ROUTE = /^\/(book|chat)\/([a-z0-9][a-z0-9-]{1,62})\/?$/
export const PUBLIC_HEAD = {
  book: { title: 'Book online', description: 'Pick a time that works for you and book online.' },
  chat: { title: 'Chat with us', description: 'Ask a question or book an appointment.' },
}

// Which kind of public business page a path is ('book' | 'chat'), or null (everything else, and GetShowUps' own).
export function publicPageKind(pathname) {
  const m = ROUTE.exec(String(pathname || ''))
  return m && m[2] !== SALES_BUSINESS ? m[1] : null
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const meta = (key) => new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="[^"]*"\\s*/?>\\s*`, 'g')

// index.html with the neutral head of that kind. Text in, text out (unit-tested against the real index.html).
export function neutralHead(html, kind) {
  const h = PUBLIC_HEAD[kind]
  if (!h) return html
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(h.title)}</title>`)
  out = out.replace(meta('description'), `<meta name="description" content="${attr(h.description)}" />\n    `)
  // The share card (title, text, picture, site name) is GetShowUps' own: left out entirely on a business's page.
  for (const key of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt', 'twitter:card', 'twitter:image', 'twitter:title', 'twitter:description']) out = out.replace(meta(key), '')
  return out
}

// Applied by functions/_middleware.js to a successful HTML answer for one of the two routes; anything else passes.
export async function withPublicHead(res, url, request) {
  const kind = request.method === 'GET' ? publicPageKind(url.pathname) : null
  if (!kind || res.status !== 200 || !/^text\/html\b/i.test(res.headers.get('Content-Type') || '')) return res
  const headers = new Headers(res.headers)
  // The body changes, so the file's own length and validator no longer describe it.
  for (const name of ['Content-Length', 'ETag']) headers.delete(name)
  return new Response(neutralHead(await res.text(), kind), { status: 200, headers })
}
