// Design-quality checks on one AI answer (deterministic, no model call). Two tiers:
//   hard — the answer isn't a usable design (nothing to show, the first screen had to be invented, many invalid choices,
//          several sections dropped). After the one automatic revision it is an error: nothing is saved, the owner is told.
//   soft — a generic or repetitive choice (a first screen left to the default, two identical sections in a row, the
//          "different direction" isn't different). One automatic revision is asked for; the result is saved either way.
// `notes` are short instructions for that revision (no owner data in them).
const LAYOUT_TYPES = new Set(['hero', 'services', 'features', 'gallery', 'steps', 'cta'])

const bucket = (b) => (b.col?.[0] <= 4 ? 'L' : b.col?.[0] >= 9 ? 'R' : 'C')
// A coarse signature of the first screen: section type/layout, which blocks sit where, the type pairing and background.
export function firstScreenSignature(spec) {
  const s = spec?.pages?.[0]?.sections?.[0]
  if (!s) return ''
  const shape = s.type === 'composition' ? s.blocks.map((b) => `${b.kind[0]}${bucket(b)}${b.z ? 'z' : ''}`).sort().join('') : `${s.layout}/${s.imageSide}/${s.height}`
  return `${s.type}:${shape}|${spec.theme?.headingFont}|${spec.theme?.colors?.bg}`
}

export function checkDesign({ raw, spec, warnings = [], previous = null, mode = 'design' }) {
  const hard = []
  const soft = []
  const rawHome = Array.isArray(raw?.pages) && raw.pages[0] && Array.isArray(raw.pages[0].sections) ? raw.pages[0].sections : []
  const rawSections = (Array.isArray(raw?.pages) ? raw.pages : []).reduce((n, p) => n + (Array.isArray(p?.sections) ? p.sections.length : 0), 0)
  const invalid = warnings.filter((w) => w.reason === 'invalid_choice' || w.reason === 'empty_block').length
  const dropped = warnings.filter((w) => (w.reason === 'type' || w.reason === 'empty') && /^pages\.\d+\.sections\.\d+$/.test(w.where)).length
  const blocks = (spec?.pages || []).reduce((n, p) => n + p.sections.reduce((k, s) => k + (s.blocks?.length || 0), 0), 0)
  const decisions = 10 + rawSections * 6 + blocks * 5

  if (rawHome.length < 2) hard.push('too_few_sections')
  if (warnings.some((w) => w.reason === 'first_screen_added')) hard.push('first_screen_missing')
  if (invalid > Math.max(4, Math.round(decisions * 0.15))) hard.push('invalid_choices')
  if (dropped >= 2) hard.push('sections_dropped')

  const first = rawHome[0]
  if (first?.type === 'hero' && !first.layout) soft.push('default_first_screen')
  const home = spec?.pages?.[0]?.sections || []
  for (let i = 1; i < home.length; i++) {
    const a = home[i - 1]
    const b = home[i]
    if (a.type === b.type && a.type !== 'composition' && (!LAYOUT_TYPES.has(a.type) || a.layout === b.layout)) {
      soft.push('repeated_sections')
      break
    }
  }
  if (mode === 'different' && previous) {
    const same = firstScreenSignature(spec) === firstScreenSignature(previous) || (spec.theme?.headingFont === previous.theme?.headingFont && spec.theme?.colors?.bg === previous.theme?.colors?.bg)
    if (same) soft.push('same_direction')
  }
  const info = spec?.direction ? [] : ['no_direction']
  const NOTE = {
    too_few_sections: 'The home page needs a complete design (several sections), not one or two.',
    first_screen_missing: 'The home page must open with a hero or a composition that has a heading.',
    invalid_choices: 'Many values were not from the allowed lists; use only the listed options and token formats.',
    sections_dropped: 'Several sections were unusable (unknown type or empty); give every section real content.',
    default_first_screen: 'The first screen was left to the default layout; choose a deliberate first screen (a composition or a specific hero layout).',
    repeated_sections: 'Two sections in a row have the same structure; vary the composition between neighbouring sections.',
    same_direction: 'This was meant to be a different direction but the first screen, type pairing or palette is the same as before; change them.',
  }
  return { hard, soft, info, notes: [...hard, ...soft].map((c) => NOTE[c]), signature: firstScreenSignature(spec) }
}

// Model answers are kept privately for diagnosis (website_generations.content.raw, purged after RAW_RETENTION_DAYS):
// contact details, links and anything key-shaped are redacted, and the size is capped.
export const RAW_RETENTION_DAYS = 30
export function redactRaw(value, max = 60_000) {
  return JSON.stringify(value ?? null)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/https?:\/\/[^\s"\\]+/gi, '[url]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]')
    .slice(0, max)
}
