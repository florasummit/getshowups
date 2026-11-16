// Design-quality checks on one AI answer (deterministic, no model call). Two tiers:
//   hard — the answer isn't a usable design (nothing to show, the first screen had to be invented, many invalid choices,
//          several sections dropped). After the one automatic revision it is an error: nothing is saved, the owner is told.
//   soft — a generic or repetitive choice (a first screen left to the default, two identical sections in a row, the
//          "different direction" isn't different). One automatic revision is asked for; the result is saved either way.
// `notes` are short instructions for that revision (no owner data in them).
import { compositionRoles } from './design-blocks.js'
const LAYOUT_TYPES = new Set(['hero', 'services', 'features', 'gallery', 'steps', 'cta'])

const bucket = (b) => (b.col?.[0] <= 4 ? 'L' : b.col?.[0] >= 9 ? 'R' : 'C')
// A coarse signature of the first screen: section type/layout, which blocks sit where, the type pairing and background.
export function firstScreenSignature(spec) {
  const s = spec?.pages?.[0]?.sections?.[0]
  if (!s) return ''
  const shape = s.type === 'composition' ? s.blocks.map((b) => `${b.kind[0]}${bucket(b)}${b.z ? 'z' : ''}`).sort().join('') : `${s.layout}/${s.imageSide}/${s.height}`
  return `${s.type}:${shape}|${spec.theme?.headingFont}|${spec.theme?.colors?.bg}`
}

// The first screen's structure, independent of left/right mirroring, fonts and colours: section shape, which kinds of
// blocks, how much of the width photos take, whether text sits over a photo, the headline's scale.
export function firstScreenStructure(spec) {
  const s = spec?.pages?.[0]?.sections?.[0]
  if (!s) return ''
  if (s.type !== 'composition') return `${s.type}:${s.layout}:${s.height}`
  const media = s.blocks.filter((b) => b.kind === 'media')
  const width = media.reduce((n, b) => n + b.col[1], 0)
  const overlap = s.blocks.some((b) => b.kind !== 'media' && b.z > 0 && media.some((m) => b.col[0] < m.col[0] + m.col[1] && m.col[0] < b.col[0] + b.col[1] && b.row[0] < m.row[0] + m.row[1] && m.row[0] < b.row[0] + b.row[1]))
  const heading = s.blocks.find((b) => b.kind === 'heading')
  return `composition:${s.height}:photos${media.length}:${width >= 10 ? 'wide' : width >= 5 ? 'half' : width ? 'small' : 'none'}:${overlap ? 'overlap' : 'side'}:${heading?.size || '-'}:${s.blocks.some((b) => b.kind === 'mark') ? 'mark' : ''}`
}

// The first screen's headline (normalised) and its largest photo.
export function firstScreenLead(spec) {
  const s = spec?.pages?.[0]?.sections?.[0]
  if (!s) return ['', '']
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (s.type !== 'composition') return [norm(s.heading), s.image || s.backgroundImage || '']
  const photo = s.blocks.filter((b) => b.kind === 'media').sort((a, b) => b.col[1] * b.row[1] - a.col[1] * a.row[1])[0]
  return [norm(s.blocks.find((b) => b.kind === 'heading')?.text), photo?.image || '']
}

// A rough desktop layout of one composition (no browser): 1200px content width on 12 columns, type sizes close to the
// renderer's at 1440px, photos by their proportion, auto-height grid rows. Good enough to spot the obvious problems —
// a section that is mostly empty, a tall empty band beside a short column, edges that miss each other by one column —
// not a pixel-perfect render.
const W = 1200
const GAP = 24
const CW = (W - 11 * GAP) / 12
const FONT = { display: 100, xl: 62, l: 42, m: 21, s: 15 }
const RATIO = { auto: 4 / 3, '1x1': 1, '4x5': 0.8, '3x4': 0.75, '4x3': 4 / 3, '3x2': 1.5, '16x9': 16 / 9, '21x9': 21 / 9 }
const blockWidth = (b) => b.col[1] * CW + (b.col[1] - 1) * GAP
function contentHeight(b) {
  const w = blockWidth(b)
  if (b.kind === 'media') return w / (RATIO[b.aspect] || RATIO.auto)
  if (b.kind === 'button') return 52
  const fs = FONT[b.size] || (b.kind === 'heading' ? FONT.xl : FONT.m)
  const lh = b.kind === 'text' ? 1.6 : 1.02
  const perLine = Math.max(4, Math.floor(w / (fs * 0.52)))
  const lines = String(b.text || '').split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0)
  return lines * fs * lh
}
export function layoutComposition(section) {
  const all = (section?.blocks || []).filter((b) => Array.isArray(b.col) && Array.isArray(b.row))
  if (!all.length) return null
  // Same desktop roles as the renderer: a backdrop or a full-height photo takes the section's height (its own proportion
  // or the stack's, whichever is taller) and the other blocks sit centred on it.
  const { backdrop, centred } = compositionRoles(all)
  const whole = all.filter((b) => b === backdrop || centred.has(b))
  const blocks = all.filter((b) => !whole.includes(b))
  if (!blocks.length) return { rects: whole.map((b) => ({ b, x0: b.col[0] - 1, x1: b.col[0] - 1 + b.col[1], y0: 0, y1: contentHeight(b) })), height: Math.max(...whole.map(contentHeight)) }
  const flow = flowLayout(blocks)
  const height = Math.max(flow.height, ...whole.map(contentHeight))
  const dy = (height - flow.height) / 2
  return { rects: [...whole.map((b) => ({ b, x0: b.col[0] - 1, x1: b.col[0] - 1 + b.col[1], y0: 0, y1: height })), ...flow.rects.map((r) => ({ ...r, y0: r.y0 + dy, y1: r.y1 + dy }))], height }
}
function flowLayout(blocks) {
  const rows = Math.max(...blocks.map((b) => b.row[0] + b.row[1] - 1))
  const h = Array(rows + 1).fill(0)
  const span = (b) => [...Array(b.row[1]).keys()].map((i) => b.row[0] + i)
  for (const b of [...blocks].sort((a, c) => a.row[1] - c.row[1])) {
    const rs = span(b)
    const need = contentHeight(b) - rs.reduce((n, r) => n + h[r], 0) - GAP * (rs.length - 1)
    if (need > 0) for (const r of rs) h[r] += need / rs.length
  }
  const top = (r) => h.slice(1, r).reduce((n, x) => n + x, 0) + GAP * (r - 1)
  const rects = blocks.map((b) => {
    const areaTop = top(b.row[0])
    const areaH = top(b.row[0] + b.row[1]) - GAP - areaTop
    const own = b.y === 'stretch' ? areaH : Math.min(areaH, contentHeight(b))
    const y = b.y === 'end' ? areaTop + areaH - own : b.y === 'center' ? areaTop + (areaH - own) / 2 : areaTop
    return { b, x0: b.col[0] - 1, x1: b.col[0] - 1 + b.col[1], y0: y, y1: y + own }
  })
  const height = Math.max(...rects.map((r) => r.y1))
  return { rects, height }
}
// Obvious balance problems in one composition. Intentional whitespace is allowed: an open side or a quiet margin is
// fine; what's flagged is (a) a section that is mostly empty, (b) a tall empty band inside the composition's own width
// (one column ends far above the other, leaving a hole), (c) stacked blocks whose left edges miss by one column.
export function compositionBalance(section) {
  const L = layoutComposition(section)
  if (!L || L.rects.length < 2 || !L.rects.some((r) => r.b.kind === 'media')) return []
  const issues = []
  const step = 10
  const slices = Math.ceil(L.height / step)
  const used = L.rects.reduce((n, r) => n + (r.x1 - r.x0) * (r.y1 - r.y0), 0)
  const x0 = Math.min(...L.rects.map((r) => r.x0))
  const x1 = Math.max(...L.rects.map((r) => r.x1))
  if (used / ((x1 - x0) * L.height) < 0.4) issues.push('mostly_empty')
  // Holes: per column, empty runs below content in that column. A band = at least 3 neighbouring columns empty over the
  // same stretch, taller than 35% of the section and 220px (a gutter or a single short column is fine).
  // A stack of words sharing a left edge reads as one column as wide as its widest block: a ragged right edge (a short
  // button under a wide headline) is not a hole.
  const words = L.rects.filter((r) => r.b.kind !== 'media')
  const solid = L.rects.map((r) => (r.b.kind === 'media' ? r : { ...r, x1: Math.max(...words.filter((w) => w.x0 === r.x0).map((w) => w.x1)) }))
  const limit = Math.max(220, L.height * 0.35)
  const empty = []
  for (let c = x0; c < x1; c++) {
    const covered = [...Array(slices).keys()].map((i) => solid.some((r) => r.x0 <= c && c < r.x1 && r.y0 <= i * step + step / 2 && i * step + step / 2 < r.y1))
    const first = covered.indexOf(true)
    empty.push(covered.map((v, i) => first >= 0 && i > first && !v))
  }
  for (let c = 0; c + 2 < empty.length && !issues.includes('empty_band'); c++) {
    let run = 0
    for (let i = 0; i < slices; i++) {
      run = empty[c][i] && empty[c + 1][i] && empty[c + 2][i] ? run + 1 : 0
      if (run * step > limit) {
        issues.push('empty_band')
        break
      }
    }
  }
  // Layered blocks (a card over a photo) are offset on purpose; only plain stacked blocks must share an edge.
  const layered = (r) => r.b.kind !== 'media' && L.rects.some((m) => m.b.kind === 'media' && m.x0 < r.x1 && r.x0 < m.x1 && m.y0 < r.y1 && r.y0 < m.y1)
  const stacked = L.rects.filter((r) => r.b.x !== 'center' && !layered(r))
  if (stacked.some((a) => stacked.some((b) => a !== b && b.y0 >= a.y1 - 1 && a.x0 < b.x1 && b.x0 < a.x1 && Math.abs(a.x0 - b.x0) === 1))) issues.push('misaligned')
  // A photo mostly hidden under a card layered above it (over half, by this rough estimate) reads as a stray strip (live GPT revision, 2026-11-16: a
  // 4-column photo with a headline card over its lower two-thirds). Words written INSIDE a photo (white over a darkening
  // layer) are the photo's own text, not a cover; only blocks that stick out past it (raised cards) count.
  const inside = (r, m) => r.x0 >= m.x0 && r.x1 <= m.x1 && r.y0 >= m.y0 - 1 && r.y1 <= m.y1 + 1
  for (const m of L.rects.filter((r) => r.b.kind === 'media')) {
    const covers = L.rects.filter((r) => r.b.kind !== 'media' && r.b.z > m.b.z && !inside(r, m) && r.x0 < m.x1 && m.x0 < r.x1 && r.y0 < m.y1 && m.y0 < r.y1)
    if (!covers.length) continue
    let hidden = 0
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
      const x = m.x0 + ((i + 0.5) / 20) * (m.x1 - m.x0)
      const y = m.y0 + ((j + 0.5) / 20) * (m.y1 - m.y0)
      if (covers.some((r) => r.x0 <= x && x < r.x1 && r.y0 <= y && y < r.y1)) hidden++
    }
    if (hidden / 400 > 0.5) {
      issues.push('buried_photo')
      break
    }
  }
  return issues
}
// A "safe" first screen: one photo beside the text, nothing overlapping, no mark, a headline below display size.
export function conventionalFirstScreen(spec) {
  const s = spec?.pages?.[0]?.sections?.[0]
  if (!s) return false
  if (s.type === 'hero') return ['split', 'centered', 'stacked'].includes(s.layout)
  if (s.type !== 'composition') return false
  const media = s.blocks.filter((b) => b.kind === 'media')
  const overlap = /:overlap:/.test(firstScreenStructure(spec))
  const heading = s.blocks.find((b) => b.kind === 'heading')
  return media.length <= 1 && !overlap && !s.blocks.some((b) => b.kind === 'mark') && !(heading?.size === 'display' && heading.col[1] >= 8)
}

export function checkDesign({ raw, spec, warnings = [], previous = null, mode = 'design', fresh = false }) {
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
  // A different direction needs a different first-screen STRUCTURE: mirroring it or changing fonts/colours isn't one
  // (live GPT answer 2026-11-16: the "different" design was the first one flipped left-to-right with a serif).
  if (mode === 'different' && previous && firstScreenStructure(spec) === firstScreenStructure(previous)) soft.push('same_direction')
  // …and its own words and picture: live GPT 2026-11-16 kept "Less upkeep. More pool time." and the same lead photo in
  // a structurally new direction, so the two read as one site.
  else if (mode === 'different' && previous && firstScreenLead(spec).some((x, i) => x && x === firstScreenLead(previous)[i])) soft.push('same_lead')
  // New designs (not owner-requested revisions, which may ask for something simple) shouldn't open with the safe
  // template: one photo beside the text (live GPT answers 2026-11-16: all three first screens were this).
  if (fresh && conventionalFirstScreen(spec)) soft.push('conventional_first_screen')
  const balance = new Set((spec?.pages || []).flatMap((p) => p.sections.filter((s) => s.type === 'composition').flatMap((s) => compositionBalance(s))))
  if (balance.size) soft.push('unbalanced_composition')
  const info = spec?.direction ? [] : ['no_direction']
  const NOTE = {
    too_few_sections: 'The home page needs a complete design (several sections), not one or two.',
    first_screen_missing: 'The home page must open with a hero or a composition that has a heading.',
    invalid_choices: 'Many values were not from the allowed lists; use only the listed options and token formats.',
    sections_dropped: 'Several sections were unusable (unknown type or empty); give every section real content.',
    default_first_screen: 'The first screen was left to the default layout; choose a deliberate first screen (a composition or a specific hero layout).',
    repeated_sections: 'Two sections in a row have the same structure; vary the composition between neighbouring sections.',
    same_direction: 'This was meant to be a different direction but the first screen, type pairing or palette is the same as before; change them.',
    same_lead: 'This was meant to be a different direction but the first screen repeats the previous headline or leads with the same photo; write a new headline and open with a different photo (or with type alone).',
    conventional_first_screen: 'The first screen is the safe template (one photo beside the text). Recompose it with one of the FIRST-SCREEN RECIPES: overlap the headline with a large photo, or a display headline across 8+ columns, or a collage of 2-3 photos at different sizes, or a type poster with a mark.',
    unbalanced_composition: `A composition looks unbalanced: ${[...balance].map((x) => ({ mostly_empty: 'most of its area is empty', empty_band: 'a tall empty band where one column ends far above the other', misaligned: 'stacked blocks whose left edges miss each other by one column', buried_photo: 'a photo almost entirely hidden under a card layered over it' })[x]).join('; ')}. Align stacked blocks to the same column edge, and size rows so the columns end together (or make the empty side deliberate); a layered card may overlap a photo's edge, not hide most of it.`,
  }
  return { hard, soft, info, balance: [...balance], notes: [...hard, ...soft].map((c) => NOTE[c]), signature: firstScreenSignature(spec) }
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
