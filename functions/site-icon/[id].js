// GET /site-icon/<business-id>.svg?c=<hex>: a business website's favicon when it has no logo: its first letter on its
// brand colour (so a business site never shows GetShowUps' icon). No storage, no lookup: built from the request only
// (the letter comes from the validated business id, the colour from a 6-digit hex), cached for a day.
const ID_RE = /^([a-z0-9][a-z0-9-]{1,62})\.svg$/
const HEX_RE = /^[0-9a-f]{6}$/i

const lum = (hex) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

export async function onRequestGet({ request, params }) {
  const m = ID_RE.exec(String(params.id || ''))
  if (!m) return new Response('Not found', { status: 404 })
  const c = new URL(request.url).searchParams.get('c') || ''
  const bg = HEX_RE.test(c) ? c.toLowerCase() : '1d5fa8'
  const fg = lum(bg) > 0.45 ? '#111111' : '#ffffff'
  const letter = m[1][0].toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#${bg}"/><text x="32" y="44" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="700" fill="${fg}">${letter}</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' } })
}
