// "Use my own hosting": the PUBLISHED website as plain static files (.zip) for any static host. Same renderer as
// GetShowUps hosting, so the pages are identical; every image, font and icon the pages use is included (owner photos
// get a file extension so any host serves them correctly). Booking and chat stay on GetShowUps (absolute links).
// Contact forms need GetShowUps hosting (their anti-spam token is time-limited), so they're left out of the files.
import { liveContent } from './website.js'
import { connectedHost } from './domains.js'
import { siteOrigin } from './auth.js'
import { chatLink, siteBusinessInfo } from './site-serve.js'
import { renderSite } from './site-render.js'
import { receptionistOn } from './receptionist/engine.js'
import { testStatus } from './testbusiness.js'
import { zip } from './zip.js'
import { onRequestGet as siteIcon } from '../functions/site-icon/[id].js'

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const REF = /\/site-(assets|stock|fonts|icon)\/[A-Za-z0-9._-]+(\?[A-Za-z0-9=&._-]*)?/g

// env.ASSETS: the Pages static assets binding (stock photos and fonts). Returns { ok, bytes?, filename?, error? }.
export async function staticExport(env, customer, requestUrl) {
  const db = env.ONBOARDING_DB
  const live = await liveContent(db, customer.id)
  if (!live) return { ok: false, error: 'not_published' }
  const origin = siteOrigin(env)
  const host = await connectedHost(db, customer.id)
  const info = { ...(await siteBusinessInfo(db, customer)), offerSms: false }
  const noindex = (await testStatus(env, customer.id)).test
  const chat = await receptionistOn(env, customer).catch(() => false)
  const slugs = live.content.site?.pages?.map((p) => p.slug) || ['']
  const files = []
  const pages = []
  for (const page of slugs) {
    const canonical = host ? `https://${host}/${page}` : `${origin}/p/${customer.id}${page ? `/${page}` : ''}`
    let html = renderSite(info, live.content, { canonical, bookUrl: `${origin}/book/${customer.id}`, privacyUrl: `${origin}/privacy`, noindex, page, pageBase: '', form: null })
    if (chat) html = html.replace('</body>', `${chatLink(`${origin}/chat/${customer.id}`)}</body>`)
    pages.push({ name: page ? `${page}/index.html` : 'index.html', html })
  }
  // Everything the pages reference, fetched once each.
  const refs = new Set(pages.flatMap((p) => p.html.match(REF) || []))
  const owned = await db.prepare('SELECT id, content_type, bytes FROM website_assets WHERE customer = ?1').bind(customer.id).all()
  const ownById = new Map(owned.results.map((r) => [r.id, r]))
  const rename = new Map()
  for (const ref of refs) {
    const [path] = ref.split('?')
    const [, kind, file] = path.match(/^\/site-([a-z]+)\/(.+)$/)
    if (kind === 'assets') {
      const a = ownById.get(file)
      if (!a) continue // not this business's image: never included
      const name = `site-assets/${file}.${EXT[a.content_type] || 'bin'}`
      files.push({ name, bytes: new Uint8Array(a.bytes) })
      rename.set(ref, `/${name}`)
    } else if (kind === 'icon') {
      const res = await siteIcon({ request: new Request(new URL(ref, origin)), params: { id: file } })
      if (!res.ok) continue
      files.push({ name: `site-icon/${file}`, bytes: new Uint8Array(await res.arrayBuffer()) })
      rename.set(ref, `/site-icon/${file}`)
    } else {
      const res = await env.ASSETS?.fetch(new Request(new URL(path, requestUrl))).catch(() => null)
      if (!res?.ok) continue
      files.push({ name: path.slice(1), bytes: new Uint8Array(await res.arrayBuffer()) })
    }
  }
  const sorted = [...rename.keys()].sort((a, b) => b.length - a.length)
  for (const p of pages) {
    let html = p.html
    for (const from of sorted) html = html.split(from).join(rename.get(from))
    files.unshift({ name: p.name, bytes: new TextEncoder().encode(html) })
  }
  files.push({
    name: 'README.txt',
    bytes: [
      `${customer.name}: website files (published version ${live.version})`,
      '',
      'Upload everything in this folder to the root of a static web host (for example Cloudflare Pages, Netlify or GitHub',
      'Pages), then point your domain to that host. Squarespace and Wix cannot host uploaded files.',
      '',
      `Booking and chat buttons open your GetShowUps pages (${origin}), so they keep working on any host.`,
      'Contact forms only work on GetShowUps hosting and are not included here.',
      'When you publish changes in GetShowUps, download and upload this folder again.',
    ].join('\n'),
  })
  return { ok: true, bytes: zip(files), filename: `website-${customer.id}-v${live.version}.zip`, files: files.length }
}
