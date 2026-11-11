// Design system for generated websites. The AI chooses ONLY from these named options (validated here);
// it never writes HTML, CSS or scripts. Every combination is designed to look finished and stay accessible
// (palettes checked for AA text contrast; accent buttons carry their own readable text colour).
import STOCK from './stock-photos.js'

export const PALETTES = {
  lagoon: { label: 'Lagoon', bg: '#f6fbfc', surface: '#e4f2f4', ink: '#0d2a33', muted: '#486570', accent: '#0b6f78', onAccent: '#ffffff', line: '#cfe3e7' },
  midnight: { label: 'Midnight', dark: true, bg: '#0b1620', surface: '#13232f', ink: '#eef6f8', muted: '#a3b8c2', accent: '#5fd4d0', onAccent: '#062023', line: '#223746' },
  sand: { label: 'Sand', bg: '#fbf7f1', surface: '#f2e9dc', ink: '#2b2118', muted: '#6b5d4e', accent: '#a8481f', onAccent: '#ffffff', line: '#e4d8c6' },
  forest: { label: 'Forest', bg: '#f4f6f1', surface: '#e3eadc', ink: '#1b291d', muted: '#536253', accent: '#2c6537', onAccent: '#ffffff', line: '#d3ddca' },
  graphite: { label: 'Graphite', bg: '#ffffff', surface: '#f1f1ee', ink: '#141414', muted: '#5c5c58', accent: '#141414', onAccent: '#ffffff', line: '#e2e2dd' },
  citrus: { label: 'Citrus', bg: '#fffdf8', surface: '#fff0dc', ink: '#1f1a14', muted: '#665b4e', accent: '#b0440f', onAccent: '#ffffff', line: '#f1dfc6' },
  navy: { label: 'Navy', bg: '#f7f8fb', surface: '#e8ecf5', ink: '#121a2c', muted: '#525d77', accent: '#1f3a8a', onAccent: '#ffffff', line: '#d8deeb' },
  ember: { label: 'Ember', dark: true, bg: '#1b1512', surface: '#28201b', ink: '#f6eee6', muted: '#c4b3a3', accent: '#efa86b', onAccent: '#1b1512', line: '#3a2e26' },
}

export const FONTS = {
  modern: { label: 'Modern', head: 'Space Grotesk', headFile: 'space-grotesk', headWeight: 700, body: 'Inter', bodyFile: 'inter', tracking: '-0.03em' },
  editorial: { label: 'Editorial', head: 'Fraunces', headFile: 'fraunces', headWeight: 600, body: 'Inter', bodyFile: 'inter', tracking: '-0.02em' },
  classic: { label: 'Classic', head: 'Playfair Display', headFile: 'playfair-display', headWeight: 700, body: 'DM Sans', bodyFile: 'dm-sans', tracking: '-0.01em' },
  friendly: { label: 'Friendly', head: 'DM Sans', headFile: 'dm-sans', headWeight: 650, body: 'DM Sans', bodyFile: 'dm-sans', tracking: '-0.035em' },
  strong: { label: 'Strong', head: 'Archivo', headFile: 'archivo', headWeight: 800, body: 'Inter', bodyFile: 'inter', tracking: '-0.035em' },
}

export const LAYOUTS = {
  hero: {
    split: 'Headline beside a large photo',
    immersive: 'Full-width photo with the headline on top',
    stacked: 'Centered headline with a wide photo below',
    typographic: 'Large confident type, no photo',
  },
  services: { cards: 'Cards in a grid', rows: 'Numbered list with prices', tiles: 'Large two-column tiles' },
  about: { split: 'Text beside a photo', statement: 'One large statement on a coloured band', plain: 'Simple text' },
}
export const SHAPES = ['sharp', 'soft', 'round']
export const SECTIONS = ['services', 'about', 'gallery', 'process']

export const STOCK_IDS = new Set(STOCK.map((s) => s.id))
export const stockById = (id) => STOCK.find((s) => s.id === id)

// Industries we have a visual direction for. Each one has ONLY its own photos (never another industry's),
// palettes and names that suit it, and a short art direction for the AI. Unknown industry → no stock photo
// at all (text-led layouts), never a generic house or interior.
export const INDUSTRIES = {
  pool: {
    re: /pool|\bspas?\b|hot ?tubs?/i,
    photos: /^pool-/,
    palettes: ['lagoon', 'midnight', 'navy'],
    names: ['Clear Water', 'Deep End', 'Poolside Classic'],
    direction: 'clear blue water, sunlit pools and outdoor living; fresh, clean, calm; blues and teals',
  },
  cleaning: {
    re: /clean|maid|janitor|housekeep/i,
    photos: /^clean-/,
    palettes: ['lagoon', 'graphite', 'sand'],
    names: ['Spotless', 'Crisp Modern', 'Warm Home'],
    direction: 'bright, tidy, airy rooms; light backgrounds, crisp type, a sense of calm order',
  },
  lawn: {
    re: /lawn|landscap|garden|\btrees?\b|\byards?\b|mow|hedge|irrigat/i,
    photos: /^(lawn|garden)-/,
    palettes: ['forest', 'sand', 'graphite'],
    names: ['Green Lawn', 'Natural Earth', 'Clean Cut'],
    direction: 'healthy green lawns and gardens; natural greens and earth tones; grounded and dependable',
  },
  trades: {
    re: /hvac|heating|air condition|plumb|electric|handyman|roof|repair|contractor|construction|remodel|paint|carpent/i,
    photos: /^tools-/,
    palettes: ['navy', 'graphite', 'ember'],
    names: ['Pro Trade', 'Workshop', 'Solid Build'],
    direction: 'tools and craftsmanship; strong, dependable, practical; navy, charcoal and warm accents',
  },
}
const NEUTRAL = { palettes: ['lagoon', 'graphite', 'sand'], names: ['Fresh', 'Bold', 'Classic'], direction: 'clean, confident, text-led layouts' }

// Recognises the industry from the business's own details, most specific source first: the industry they
// chose, then their service names, then their description and name. Returns a key of INDUSTRIES or null.
export function industryKey({ industry, services = [], description, name } = {}) {
  const sources = [industry, services.map((s) => (typeof s === 'string' ? s : s?.name)).join(' '), description, name]
  for (const text of sources) {
    const hit = Object.entries(INDUSTRIES).find(([, v]) => v.re.test(String(text || '')))
    if (hit) return hit[0]
  }
  return null
}
export const directionFor = (key) => INDUSTRIES[key] || NEUTRAL

// Stock photos for an industry key (see industryKey). Unknown → [] (no unrelated photos, ever).
export function stockFor(key) {
  const ind = INDUSTRIES[key]
  return ind ? STOCK.filter((s) => ind.photos.test(s.id)) : []
}

// Image reference: 'asset:<32 hex>' (owner upload) or 'stock:<id>' (licensed library) or null.
// `allowedStock` (a Set of stock ids) limits stock photos to the business's own industry.
const imageOk = (ref, assetIds, allowedStock) =>
  ref == null || (typeof ref === 'string' && ((ref.startsWith('stock:') && STOCK_IDS.has(ref.slice(6)) && (!allowedStock || allowedStock.has(ref.slice(6)))) || (ref.startsWith('asset:') && /^[a-f0-9]{32}$/.test(ref.slice(6)) && (!assetIds || assetIds.has(ref.slice(6))))))

// Returns [errors[], design]. Unknown values are errors (the generator repairs before saving).
export function validateDesign(d, assetIds = null, allowedStock = null) {
  const errors = []
  if (!d || typeof d !== 'object') return [['design'], null]
  const pick = (v, allowed, field) => (allowed.includes(v) ? v : (errors.push(field), allowed[0]))
  const sections = (Array.isArray(d.sections) ? d.sections : []).filter((s, i, a) => SECTIONS.includes(s) && a.indexOf(s) === i)
  if (!sections.includes('services')) sections.unshift('services')
  const design = {
    name: String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 30),
    palette: pick(d.palette, Object.keys(PALETTES), 'palette'),
    fonts: pick(d.fonts, Object.keys(FONTS), 'fonts'),
    hero: pick(d.hero, Object.keys(LAYOUTS.hero), 'hero'),
    services: pick(d.services, Object.keys(LAYOUTS.services), 'services'),
    about: pick(d.about, Object.keys(LAYOUTS.about), 'about'),
    shape: pick(d.shape, SHAPES, 'shape'),
    sections,
    heroImage: d.heroImage ?? null,
    aboutImage: d.aboutImage ?? null,
  }
  if (!imageOk(design.heroImage, assetIds, allowedStock)) errors.push('heroImage')
  if (!imageOk(design.aboutImage, assetIds, allowedStock)) errors.push('aboutImage')
  return [errors, design]
}

// Three deliberately different starting points for an industry key (used when no AI is available, and to
// repair AI output). Owner photos first, then the industry's own stock; with neither, text-led layouts.
export function presetDesigns(key, photos = []) {
  const stock = stockFor(key)
  const dir = directionFor(key)
  const own = photos.map((id) => `asset:${id}`)
  const img = (i) => own[i] ?? (stock.length ? `stock:${stock[i % stock.length].id}` : null)
  const [p1, p2, p3] = dir.palettes
  const [n1, n2, n3] = dir.names
  const imagery = own.length || stock.length
  return [
    { name: n1, palette: p1, fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'process', 'about', 'gallery'], heroImage: img(0), aboutImage: img(1) },
    { name: n2, palette: p2, fonts: 'strong', hero: imagery ? 'immersive' : 'stacked', services: 'rows', about: 'statement', shape: 'sharp', sections: ['services', 'about', 'gallery', 'process'], heroImage: img(2), aboutImage: null },
    { name: n3, palette: p3, fonts: 'editorial', hero: 'typographic', services: 'tiles', about: imagery ? 'split' : 'plain', shape: 'soft', sections: ['about', 'services', 'process', 'gallery'], heroImage: null, aboutImage: img(3) },
  ]
}

// Makes three AI designs genuinely different: no two share a hero layout, palette or font pairing.
export function diversify(designs, key, photos) {
  const presets = presetDesigns(key, photos)
  const out = []
  for (let i = 0; i < 3; i++) {
    const d = { ...(designs[i] || presets[i]) }
    for (const key of ['hero', 'palette', 'fonts']) {
      if (out.some((o) => o[key] === d[key])) {
        const options = key === 'hero' ? Object.keys(LAYOUTS.hero) : key === 'palette' ? Object.keys(PALETTES) : Object.keys(FONTS)
        d[key] = [presets[i][key], ...options].find((v) => !out.some((o) => o[key] === v))
      }
    }
    out.push(d)
  }
  return out
}
