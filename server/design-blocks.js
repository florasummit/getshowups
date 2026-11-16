// Composition blocks in the shape the AI writes them: a few plain strings per block, so the structured-output schema stays
// small (Anthropic compiles it into a grammar with a size limit). Placement and look are space-separated tokens:
//   place  "c1/7 r2/1 z1 x-start y-end"    column start/span on 12 columns, row start/span (rows 1–6), layer 0–2,
//                                          horizontal/vertical alignment
//   look   "display aspect-4x5 focus-50-30 shape-arch duo secondary m-order-2 m-span-2 m-hide"
//          size (display|xl|l|m|s) · image proportion · crop focus % · shape · treatment (tint|duo|scrim) ·
//          secondary button · phone order / width (of 4 columns) / hide (photos and marks only)
// parseBlock() turns them into the structured block validateSpec checks; unknown tokens are listed in `invalid` so the
// validator REPORTS them (never silently ignored). blockToModel() is the reverse, for revising the current design.
import { COMPOSITION } from './site-spec.js'

const SIZES = new Set(COMPOSITION.size)
const SHAPES = new Set(['rect', 'rounded', 'arch', 'circle'])
const TREATS = new Set(COMPOSITION.treat.filter((t) => t !== 'none'))
const ASPECTS = new Set(COMPOSITION.aspect)

export function parseBlock(b) {
  if (!b || typeof b !== 'object') return b
  // Already structured (e.g. the compact answer was converted first): parsing again would drop its placement and label.
  if (!('place' in b) && !('look' in b)) return b
  const out = { kind: b.kind, invalid: [] }
  for (const tok of String(b.place || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    let m
    if ((m = tok.match(/^c(\d{1,2})\/(\d{1,2})$/))) out.col = [Number(m[1]), Number(m[2])]
    else if ((m = tok.match(/^r(\d)\/(\d)$/))) out.row = [Number(m[1]), Number(m[2])]
    else if ((m = tok.match(/^z(\d)$/))) out.z = Number(m[1])
    else if ((m = tok.match(/^x-(start|center|end)$/))) out.x = m[1]
    else if ((m = tok.match(/^y-(start|center|end|stretch)$/))) out.y = m[1]
    else out.invalid.push(tok)
  }
  const m = {}
  for (const tok of String(b.look || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    let x
    if (SIZES.has(tok)) out.size = tok
    else if (tok === 'size') continue // "size display" (live GPT answer, 2026-11-16): the value is the next token
    else if ((x = tok.match(/^size-([a-z]+)$/)) && SIZES.has(x[1])) out.size = x[1]
    else if ((x = tok.match(/^aspect-([0-9x]+|auto)$/)) && ASPECTS.has(x[1])) out.aspect = x[1]
    else if ((x = tok.match(/^focus-(\d{1,3})-(\d{1,3})$/))) out.focus = [Number(x[1]), Number(x[2])]
    else if ((x = tok.match(/^shape-([a-z]+)$/)) && SHAPES.has(x[1])) out.shape = x[1]
    else if (TREATS.has(tok)) out.treat = tok
    else if (tok === 'secondary') out.secondary = true
    else if ((x = tok.match(/^m-order-(\d{1,2})$/))) m.order = Number(x[1])
    else if ((x = tok.match(/^m-span-(\d)$/))) m.span = Number(x[1])
    else if (tok === 'm-hide') m.hide = true
    else out.invalid.push(tok)
  }
  if (Object.keys(m).length) out.m = m
  // One text field per block: the heading/text/mark words, a button's label, or a photo's alt text.
  if (b.kind === 'button') Object.assign(out, { label: b.text, target: b.target || 'book' })
  else if (b.kind === 'media') Object.assign(out, { image: b.image, alt: b.text })
  else out.text = b.text
  if (!out.invalid.length) delete out.invalid
  return out
}

export function blockToModel(b) {
  const place = [b.col && `c${b.col[0]}/${b.col[1]}`, b.row && `r${b.row[0]}/${b.row[1]}`, `z${b.z || 0}`, b.x && b.x !== 'start' && `x-${b.x}`, b.y && b.y !== 'start' && `y-${b.y}`].filter(Boolean).join(' ')
  const look = [b.size, b.kind === 'media' && `aspect-${b.aspect}`, b.kind === 'media' && b.focus && `focus-${b.focus[0]}-${b.focus[1]}`, b.kind === 'media' && b.shape && b.shape !== 'rect' && `shape-${b.shape}`, b.kind === 'media' && b.treat && b.treat !== 'none' && b.treat, b.secondary && 'secondary', b.m && `m-order-${b.m.order}`, b.m && b.m.span !== 4 && `m-span-${b.m.span}`, b.m?.hide && 'm-hide'].filter(Boolean).join(' ')
  return { kind: b.kind, place, look, text: b.kind === 'button' ? b.label : b.kind === 'media' ? b.alt || '' : b.text || '', image: b.kind === 'media' ? b.image : '', target: b.kind === 'button' ? b.target : '' }
}

// The composition section of a validated spec in the shape the model reads (for revisions).
export const sectionBlocksToModel = (s) => (s?.type === 'composition' ? { ...s, blocks: (s.blocks || []).map(blockToModel) } : s)
export const sectionBlocksFromModel = (s) => (s && typeof s === 'object' && Array.isArray(s.blocks) ? { ...s, blocks: s.blocks.map(parseBlock) } : s)

// Claude's compact answer carries composition blocks in the section's existing `items` list (no new schema fields: the
// compact schema must stay the size Anthropic compiled live; adding a `blocks` array was refused as "compiled grammar is
// too large", 2026-11-16). item.title = "<kind> <place and look tokens>", item.text = the words / button label / photo alt,
// item.image = the photo ref (media) or the link target (button).
const PLACE = /^(c\d{1,2}\/\d{1,2}|r\d\/\d|z\d|x-[a-z]+|y-[a-z]+)$/
export function itemToBlock(x) {
  if (!x || typeof x !== 'object') return x
  const [kind = '', ...tokens] = String(x.title || '').trim().toLowerCase().split(/\s+/)
  const place = tokens.filter((t) => PLACE.test(t)).join(' ')
  const look = tokens.filter((t) => !PLACE.test(t)).join(' ')
  return parseBlock({ kind, place, look, text: x.text, image: kind === 'media' ? x.image : '', target: kind === 'button' ? x.image || 'book' : '' })
}
export function blockToItem(b) {
  const m = blockToModel(b)
  return { serviceIndex: -1, icon: '', title: [m.kind, m.place, m.look].filter(Boolean).join(' '), text: m.text, image: b.kind === 'media' ? m.image : b.kind === 'button' ? m.target : '' }
}
