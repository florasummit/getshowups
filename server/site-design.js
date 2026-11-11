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

// Stock photos that suit an industry (generic, non-identifying scenes; never shown as "our work").
const GROUPS = [
  [/pool|spa|hot tub/i, 'pool-'],
  [/clean|maid|janitor|window/i, 'clean-'],
  [/lawn|landscap|garden|tree|yard|mow/i, 'lawn-|garden-'],
  [/hvac|plumb|electric|handyman|roof|repair|contractor|construction|remodel|paint|carpent/i, 'tools-'],
]
export function stockFor(industry) {
  const g = GROUPS.find(([re]) => re.test(String(industry || '')))
  const re = new RegExp(`^(${g ? g[1] : 'home-'})`)
  const list = STOCK.filter((s) => re.test(s.id))
  return list.length ? list : STOCK.filter((s) => s.id.startsWith('home-'))
}

// Image reference: 'asset:<32 hex>' (owner upload) or 'stock:<id>' (licensed library) or null.
const imageOk = (ref, assetIds) =>
  ref == null || (typeof ref === 'string' && ((ref.startsWith('stock:') && STOCK_IDS.has(ref.slice(6))) || (ref.startsWith('asset:') && /^[a-f0-9]{32}$/.test(ref.slice(6)) && (!assetIds || assetIds.has(ref.slice(6))))))

// Returns [errors[], design]. Unknown values are errors (the generator repairs before saving).
export function validateDesign(d, assetIds = null) {
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
  if (!imageOk(design.heroImage, assetIds)) errors.push('heroImage')
  if (!imageOk(design.aboutImage, assetIds)) errors.push('aboutImage')
  return [errors, design]
}

// Three deliberately different starting points (used when no AI is available, and to repair AI output).
export function presetDesigns(industry, photos = []) {
  const stock = stockFor(industry)
  const own = photos.map((id) => `asset:${id}`)
  const img = (i) => own[i] ?? (stock[i % stock.length] ? `stock:${stock[i % stock.length].id}` : null)
  return [
    { name: 'Fresh', palette: 'lagoon', fonts: 'modern', hero: 'split', services: 'cards', about: 'split', shape: 'round', sections: ['services', 'process', 'about', 'gallery'], heroImage: img(0), aboutImage: img(1) },
    { name: 'Bold', palette: 'midnight', fonts: 'strong', hero: 'immersive', services: 'rows', about: 'statement', shape: 'sharp', sections: ['services', 'about', 'gallery', 'process'], heroImage: img(2), aboutImage: null },
    { name: 'Classic', palette: 'sand', fonts: 'editorial', hero: 'typographic', services: 'tiles', about: 'split', shape: 'soft', sections: ['about', 'services', 'process', 'gallery'], heroImage: null, aboutImage: img(3) },
  ]
}

// Makes three AI designs genuinely different: no two share a hero layout, palette or font pairing.
export function diversify(designs, industry, photos) {
  const presets = presetDesigns(industry, photos)
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
