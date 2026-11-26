// "Describe a change" for a multi-page website (finding WEB-08). The included writer (server/website-ai.js
// reviseWebsite: ONE request, prose + named design options, claims filter, invented-number check) knows a flat
// website: headline, introduction, About text, service descriptions and a design (palette, lettering, shape, first
// screen photo). This is the adapter both ways, with no model call of its own:
//   reviseView(draft)            the multi-page draft as that flat website (what the model is shown);
//   applyRevision(draft, g)      what the model CHANGED, written onto the draft's own pages: only fields that differ
//                                from what it was shown (g.basis) are touched, so a colour or headline the owner edited
//                                by hand is never reset by a change that didn't ask for it.
// It can change: the first screen's headline and introduction, the About text, service descriptions, colours,
// lettering, corner shape and the first screen's photo. It cannot add, remove or reorder pages and sections, and it
// never touches a legal page (privacy policy, terms). The result is validated like every save (validateContent →
// validateSpec) by the caller and stays a pending version until the owner keeps it.
import { FONTS, PALETTES } from './site-design.js'
import { lookFromDesign } from './site-starter.js'

const home = (site) => (site?.pages || []).find((p) => p.slug === '' && !p.legal) || null
const opener = (site) => home(site)?.sections?.find((s) => !s.hidden && (s.type === 'hero' || s.type === 'composition')) || null
const blockOf = (s, kind) => (s?.blocks || []).find((b) => b.kind === kind) || null
// The About text: a text section named about on the home page, else the first text section of an About page.
const aboutSection = (site) => {
  const pages = (site?.pages || []).filter((p) => !p.legal)
  return home(site)?.sections?.find((s) => s.type === 'text' && /^about/.test(s.id)) || pages.find((p) => p.slug === 'about')?.sections?.find((s) => s.type === 'text') || null
}

export function reviseView(draft) {
  const site = draft.site
  const top = opener(site)
  const headline = (top?.type === 'composition' ? blockOf(top, 'heading')?.text : top?.heading) || draft.headline
  const intro = (top?.type === 'composition' ? blockOf(top, 'text')?.text : top?.text) || draft.intro
  const about = aboutSection(site)?.body ?? draft.about ?? ''
  // Without pages and old addresses: the writer's own validation is for the flat website.
  const { site: _site, redirects: _redirects, ...flat } = draft
  return { ...flat, headline, intro, about }
}

const RADIUS = { sharp: 0, soft: 10, round: 22 }
// Returns { content, changed[] }: a copy of `draft` with the revision's changes; changed = what was touched (codes).
export function applyRevision(draft, g) {
  const basis = g.basis || {}
  const next = g.content || {}
  const design = g.designs?.[0] || null
  const was = basis.design || {}
  const out = JSON.parse(JSON.stringify(draft))
  const changed = []
  const differs = (k) => typeof next[k] === 'string' && next[k] && next[k] !== basis[k]
  const top = opener(out.site)
  if (top && differs('headline')) {
    const block = top.type === 'composition' ? blockOf(top, 'heading') : null
    if (block) block.text = next.headline
    else if (top.type !== 'composition') top.heading = next.headline
    out.headline = next.headline
    changed.push('headline')
  }
  if (top && differs('intro')) {
    const block = top.type === 'composition' ? blockOf(top, 'text') : null
    if (block) block.text = next.intro
    else if (top.type !== 'composition') top.text = next.intro
    out.intro = next.intro
    changed.push('intro')
  }
  const about = aboutSection(out.site)
  if (about && differs('about')) {
    about.body = next.about
    out.about = next.about
    changed.push('about')
  }
  // Service descriptions (the shared list; matched by name, never added or removed, prices untouched).
  const before = new Map((basis.services || []).map((s) => [String(s.name).toLowerCase(), s.description || '']))
  const after = new Map((next.services || []).map((s) => [String(s.name).toLowerCase(), s.description || '']))
  for (const s of out.services || []) {
    const d = after.get(String(s.name).toLowerCase())
    if (d && d !== before.get(String(s.name).toLowerCase())) {
      s.description = d
      if (!changed.includes('services')) changed.push('services')
    }
  }
  if (design && out.site?.theme) {
    const t = out.site.theme
    if (design.palette !== was.palette && PALETTES[design.palette]) {
      t.colors = lookFromDesign({ palette: design.palette, fonts: FONTS[design.fonts] ? design.fonts : 'modern' }, { theme: t }).theme.colors
      changed.push('colours')
    }
    if (design.fonts !== was.fonts && FONTS[design.fonts]) {
      const f = FONTS[design.fonts]
      Object.assign(t, { headingFont: f.headFile, bodyFont: f.bodyFile, headingWeight: f.headWeight })
      changed.push('lettering')
    }
    if (design.shape !== was.shape && design.shape in RADIUS) {
      t.radius = RADIUS[design.shape]
      changed.push('shape')
    }
    // The first screen's photo, when the writer chose another one (e.g. "use my photos"); never removes a photo.
    if (top?.type === 'hero' && typeof design.heroImage === 'string' && design.heroImage !== was.heroImage && design.heroImage !== top.image) {
      top.image = design.heroImage
      if (top.layout === 'minimal' || top.layout === 'editorial') top.layout = 'split'
      changed.push('photo')
    }
  }
  return { content: out, changed }
}
