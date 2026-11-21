// Precise designer actions, decided BEFORE any model call (like server/intelligence/teach.js for Teach a Change).
//
// A narrow request ("remove my logo", "change the headline to …", "remove the photo in the About section") is matched
// by fixed patterns and becomes ONE operation from the allowlist below, with structured arguments checked against its
// schema. The operation is applied to a COPY of the CURRENT draft, the one changed value goes through the same gates as
// every other text or image (claims, invented numbers, limits, image ownership; validateContent for the save), the
// result is saved as the PRIVATE draft, read back, and reported exactly as found ({ applied, notApplied }). No model
// runs for these: no key, no cost, and nothing from the conversation history, previous designs or imported text can
// influence them. Anything the patterns don't place is either a clarifying question (nothing changes) or the broad
// designer flow (server/ai-designer.js designTurn).
//
// The owner's message is data: it is matched, never executed, and only the matched text of ONE field reaches the draft.
import { loadWebsite, logoAssetIdsFor, saveDraft, validateContent, LIMITS as CONTENT_LIMITS } from './website.js'
import { LIMITS, validateSpec } from './site-spec.js'
import { unapprovedClaims } from './ads/spec.js'
import { inventedNumbers } from './fact-numbers.js'
import { saveCheckpoint } from './website-history.js'
import { recordEvent } from './auditlog.js'
import { designContext } from './ai-designer.js'

// ── The operation allowlist. Every operation names its arguments and their schema; validateOperation() refuses anything
// else (unknown operation, unknown or missing argument, wrong type, out of range). Nothing free-form reaches the draft.
const ASSET_ID = /^[a-f0-9]{32}$/
const SLOT = /^(image|backgroundImage|images\.\d{1,2}|items\.\d{1,2}\.image|blocks\.\d{1,2}|hero|photos\.\d{1,2})$/
const PATH = /^(heading|eyebrow|text|body|blocks\.\d{1,2}\.text|headline|intro|about)$/
export const OPERATIONS = {
  remove_logo: { args: {} },
  restore_logo: { args: { assetId: { type: 'string', pattern: ASSET_ID, optional: true } } },
  replace_logo: { args: { named: { type: 'boolean', optional: true } } },
  set_headline: { args: { text: { type: 'string', min: 1, max: LIMITS.heading } } },
  remove_image: { args: { page: { type: 'integer', min: 0, max: LIMITS.pages - 1 }, section: { type: 'integer', min: 0, max: LIMITS.sectionsPerPage - 1 }, slot: { type: 'string', pattern: SLOT } } },
  set_section_text: { args: { page: { type: 'integer', min: 0, max: LIMITS.pages - 1 }, section: { type: 'integer', min: 0, max: LIMITS.sectionsPerPage - 1 }, path: { type: 'string', pattern: PATH }, text: { type: 'string', min: 1, max: LIMITS.body } } },
}
export const OPERATION_NAMES = Object.keys(OPERATIONS)

// → { name, args } with exactly the declared arguments, or null.
export function validateOperation(op) {
  if (!op || typeof op !== 'object' || typeof op.name !== 'string' || !Object.hasOwn(OPERATIONS, op.name)) return null
  const schema = OPERATIONS[op.name].args
  const given = op.args && typeof op.args === 'object' && !Array.isArray(op.args) ? op.args : {}
  if (Object.keys(given).some((k) => !Object.hasOwn(schema, k))) return null
  const args = {}
  for (const [k, rule] of Object.entries(schema)) {
    const v = given[k]
    if (v === undefined) {
      if (rule.optional) continue
      return null
    }
    if (rule.type === 'string') {
      if (typeof v !== 'string') return null
      if (rule.pattern && !rule.pattern.test(v)) return null
      if (rule.min !== undefined && v.length < rule.min) return null
      if (rule.max !== undefined && v.length > rule.max) return null
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(v) || v < rule.min || v > rule.max) return null
    } else if (rule.type === 'boolean') {
      if (typeof v !== 'boolean') return null
    } else return null
    args[k] = v
  }
  return { name: op.name, args }
}

// ── Reading the draft: sections, their labels, the pictures they show.
const TYPE_NAMES = { hero: 'the first screen', composition: 'the first screen', text: 'the text section', services: 'the services section', features: 'the features section', imageText: 'the photo-and-text section', gallery: 'the gallery', steps: 'the steps section', faq: 'the questions section', cta: 'the booking banner', area: 'the area section', contact: 'the contact section' }
const pageName = (p, pi) => (pi === 0 ? 'Home' : p.navLabel || p.slug || `page ${pi + 1}`)
const headingOf = (s) => (s.type === 'composition' ? s.blocks?.find((b) => b.kind === 'heading')?.text : s.heading) || ''
export function sectionLabel(site, pi, si, { page = true, full = false } = {}) {
  const p = site.pages[pi]
  const s = p.sections[si]
  const h = headingOf(s)
  const name = h ? `“${!full && h.length > 40 ? `${h.slice(0, 38).trim()}…` : h}”` : pi === 0 && si === 0 ? 'the first screen' : TYPE_NAMES[s.type] || 'the section'
  return page && site.pages.length > 1 ? `${name} (${pageName(p, pi)})` : name
}

// Every picture on the site, in reading order: { page, section, slot, n (position in its section), label, say }
// (say = words the owner can use to name exactly this one).
export function imageSlots(site) {
  const out = []
  if (!site?.pages) return out
  site.pages.forEach((p, pi) =>
    p.sections.forEach((s, si) => {
      const inSection = []
      const add = (slot, what) => inSection.push({ page: pi, section: si, slot, what })
      if (s.backgroundImage) add('backgroundImage', 'the background photo')
      if (s.image) add('image', s.type === 'hero' ? 'the main photo' : 'the photo')
      ;(s.images || []).forEach((_, i) => add(`images.${i}`, s.type === 'gallery' ? `photo ${i + 1}` : `collage photo ${i + 1}`))
      ;(s.items || []).forEach((x, i) => x?.image && add(`items.${i}.image`, `the photo of item ${i + 1}`))
      ;(s.blocks || []).forEach((b, i) => b?.kind === 'media' && add(`blocks.${i}`, `photo ${inSection.filter((x) => x.slot.startsWith('blocks.')).length + 1}`))
      const where = sectionLabel(site, pi, si, { page: false, full: true })
      inSection.forEach((x, n) => out.push({ ...x, n: n + 1, label: `${x.what} in ${sectionLabel(site, pi, si)}`, say: `remove ${inSection.length > 1 ? `photo ${n + 1}` : 'the photo'} in ${where}` }))
    }),
  )
  return out
}
// Pictures of a content document without an AI design (the classic template): the main photo and the photo list.
export function classicImageSlots(draft) {
  const out = []
  if (draft.hero) out.push({ page: 0, section: 0, slot: 'hero', what: 'the main photo', n: 0, label: 'the main photo', say: 'remove the main photo' })
  ;(draft.photos || []).forEach((_, i) => out.push({ page: 0, section: 0, slot: `photos.${i}`, what: `photo ${i + 1}`, n: i + 1, label: `photo ${i + 1}`, say: `remove photo ${i + 1}` }))
  return out
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
const strip = (ref) =>
  norm(ref)
    .replace(/^["']|["']$/g, '')
    .replace(/^(?:the|my|our|that|this) /, '')
    .replace(/ (?:section|page|part|block|area|bit)$/, '')
    .replace(/^["']|["']$/g, '')
    .trim()
const bySection = (site, test) => site.pages.flatMap((p, pi) => p.sections.map((s, si) => (test(s, pi, si) ? [pi, si] : null)).filter(Boolean))
const SECTION_WORDS = [
  [/^(?:top|first screen|first section|opening|hero|banner|header|start|beginning|top of the (?:page|site|home ?page)|first part|page|site|website|whole site)$/, () => [[0, 0]]],
  [/^(?:home|home ?page|front page|main page|landing page)$/, (site) => site.pages[0].sections.map((_, si) => [0, si])],
  [/^section (\d{1,2})$/, (site, m) => (site.pages[0].sections[Number(m[1]) - 1] ? [[0, Number(m[1]) - 1]] : [])],
  [/^about(?: us| me)?$/, (site) => bySection(site, (s) => /\babout\b/i.test(`${headingOf(s)} ${s.eyebrow || ''} ${s.id}`))],
  [/^(?:services?|service list|pricing|prices|what we do)$/, (site) => bySection(site, (s) => s.type === 'services')],
  [/^(?:faq|faqs|questions|q ?& ?a|good to know|common questions)$/, (site) => bySection(site, (s) => s.type === 'faq')],
  [/^(?:contact|contact us|get in touch)$/, (site) => bySection(site, (s) => s.type === 'contact')],
  [/^(?:area|service area|where we work|towns|coverage)$/, (site) => bySection(site, (s) => s.type === 'area')],
  [/^(?:steps|how it works|process|how booking works)$/, (site) => bySection(site, (s) => s.type === 'steps')],
  [/^(?:gallery|our work|photos|work)$/, (site) => bySection(site, (s) => s.type === 'gallery')],
  [/^(?:features|why us|benefits|highlights)$/, (site) => bySection(site, (s) => s.type === 'features')],
  [/^(?:cta|booking banner|call to action|bottom banner|book banner)$/, (site) => bySection(site, (s) => s.type === 'cta')],
]

// A reference the owner typed ("the about section", "services page", "section 2", a heading) → [page, section] pairs.
export function matchSections(site, ref) {
  if (!site?.pages?.length) return []
  // "… page" names a page (every section on it; the caller narrows further).
  const pg = norm(ref).match(/^(?:the |my |our )?(.+?) page$/)
  if (pg) {
    const pi = site.pages.findIndex((p, i) => i > 0 && (norm(p.navLabel) === pg[1] || norm(p.slug) === pg[1] || norm(p.slug).replace(/-/g, ' ') === pg[1]))
    if (pi >= 0) return site.pages[pi].sections.map((_, si) => [pi, si])
  }
  // The words as typed first: "Our promise" is a heading before it is "the promise section".
  const typed = norm(ref).replace(/^["']|["']$/g, '').replace(/ (?:section|page)$/, '').trim()
  const byTyped = typed ? bySection(site, (s) => norm(headingOf(s)) === typed || norm(s.eyebrow) === typed) : []
  if (byTyped.length) return byTyped
  const r = strip(ref)
  if (!r) return []
  for (const [re, fn] of SECTION_WORDS) {
    const m = r.match(re)
    if (m) {
      const found = fn(site, m)
      if (found.length) return found
    }
  }
  // A page by name ("services page", "about page"): every section on it (the caller narrows further).
  const page = site.pages.findIndex((p, pi) => pi > 0 && (norm(p.navLabel) === r || norm(p.slug) === r || norm(p.slug).replace(/-/g, ' ') === r))
  if (page >= 0) return site.pages[page].sections.map((_, si) => [page, si])
  // By heading, eyebrow or id.
  const exact = bySection(site, (s) => norm(headingOf(s)) === r || norm(s.eyebrow) === r || s.id === r.replace(/\s+/g, '-'))
  if (exact.length) return exact
  return bySection(site, (s) => r.length >= 3 && (norm(headingOf(s)).includes(r) || norm(s.eyebrow).includes(r)))
}

// ── Fixed patterns. Leading politeness and trailing thanks are stripped first; the core must match the WHOLE message,
// so "remove my logo and redesign the home page" is not a narrow request.
const LEAD = /^(?:(?:hi|hello|hey|ok|okay|please|thanks|now|also|next|and|then|so)[,!. ]+)*(?:(?:can|could|would|will) you (?:please )?|please (?:just )?|i(?:'d| would) like (?:you )?to |i want (?:you )?to |i need (?:you )?to |let's |just |kindly )?/i
const TAIL = /(?:[,.!]* ?(?:please|thanks|thank you))*[.!?\s]*$/i
const SITE = '(?:site|website|page|header|home ?page|draft|top|design)'
// Case is kept (the owner's words go into the draft as typed); the patterns match case-insensitively.
const core = (message) =>
  String(message || '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD, '')
    .replace(TAIL, '')
    .trim()
// Quoted text is taken exactly (its punctuation included); unquoted text loses only a sentence-ending full stop.
const unquote = (t) => {
  const s = String(t || '').trim()
  const q = s.match(/^["'“‘](.*)["'”’][.!]?$/)
  return (q ? q[1] : s.replace(/\.$/, '')).trim()
}

const LOGO = '(?:the |my |our )?logo(?: image| picture| file)?'
const RE = {
  removeLogo: [
    new RegExp(`^(?:remove|delete|get rid of|drop|hide|clear|kill|lose|ditch|take (?:off|away|out|down)) ${LOGO}(?: (?:from|off|out of|on) (?:the |my )?${SITE})?$`, 'i'),
    new RegExp(`^take ${LOGO} (?:off|away|down|out)(?: (?:of |from )?(?:the |my )?${SITE})?$`, 'i'),
    new RegExp(`^(?:no |without |i (?:don't|do not) want (?:a |the |my )?)logo(?: (?:any ?more|anymore|on (?:the |my )?${SITE}))?$`, 'i'),
    new RegExp(`^(?:the |my )?logo (?:should (?:go|be removed|not (?:show|appear|be there))|goes|off|out|has to go|needs to go)$`, 'i'),
  ],
  restoreLogo: [
    new RegExp(`^(?:put|bring|add) ${LOGO} back(?: (?:on|in|to|onto) (?:the |my )?${SITE})?$`, 'i'),
    new RegExp(`^(?:restore|re-?add|show|display|re-?enable|undo removing|un-?remove) ${LOGO}(?: again)?$`, 'i'),
    new RegExp(`^(?:use|show|add) (?:the|my|our) logo(?: (?:that |which )?(?:i|we) (?:uploaded|added|had|sent|gave you))?(?: again)?$`, 'i'),
    new RegExp(`^(?:i|we) want ${LOGO} back$`, 'i'),
  ],
  replaceLogo: [
    new RegExp(`^(?:replace|change|swap(?: out)?|update|switch|edit|upload|add|use|set|pick|choose|select) (?:the |my |our )?(?:a |an |another |some |new |different |other )*logo(?: (?:with|to|for|by|from) (?<named>.+))?$`, 'i'),
    new RegExp(`^(?:i|we) (?:want|need|'?d like|would like|have) (?:a |an |another )?(?:new |different |other |updated )?logo(?: (?<named>.+))?$`, 'i'),
    /^(?:use|make|set|take) (?<named>.+?) (?:as|for|to be) (?:the |my |our )?(?:new )?logo$/i,
    /^(?:new|different|another|other) logo$/i,
  ],
  // "change the heading of the about section to X" (one field of one section) — tried before the headline patterns.
  sectionField: [
    /^(?:change|update|set|edit|rewrite|replace|make|alter|switch) (?:the )?(?<field>text|copy|paragraph|wording|words|body|description|intro|heading|headline|title|subheading|sub-heading|eyebrow|label) (?:in|of|on|for|under|at) (?<ref>.+?) (?:to(?: say| read)?|say|read|into|:|=)\s*(?<text>.+)$/i,
    /^(?:change|update|set|edit|rewrite|replace|make|alter|switch) (?<ref>.+?)(?:'s| section's| page's) (?<field>text|copy|paragraph|wording|words|body|description|intro|heading|headline|title|subheading|sub-heading|eyebrow|label) (?:to(?: say| read)?|say|read|into|:|=)\s*(?<text>.+)$/i,
    /^(?:the )?(?<field>text|copy|paragraph|wording|words|body|description|intro|heading|headline|title|subheading|sub-heading|eyebrow) (?:in|of|on|for|under|at) (?<ref>.+?) should (?:say|read|be)\s*(?<text>.+)$/i,
    /^(?:rename|retitle|re-?title|call|name|relabel) (?<ref>.+?) (?:to|as|:)\s*(?<text>.+)$/i,
  ],
  headline: [
    /^(?:change|update|set|edit|rewrite|replace|make|alter|switch) (?:the |my |our )?(?:main |home ?page |first[- ]screen |hero |top |big |site |website |opening )?(?:headline|heading|title|h1|tagline)(?: (?:on|of|at) (?:the )?(?:home ?page|first screen|front page|top|site|website))? (?:to(?: say| read)?|say|read|into|:|=)\s*(?<text>.+)$/i,
    /^(?:make |let |have )?(?:the |my |our )?(?:main |home ?page |first[- ]screen |hero |top |big |site |website |opening )?(?:headline|heading|title|h1|tagline) (?:should )?(?:say|read|be)\s*(?<text>.+)$/i,
    /^(?:headline|heading|title|h1|tagline)\s*[:=]\s*(?<text>.+)$/i,
  ],
  removeImage: [
    /^(?:remove|delete|get rid of|drop|hide|lose|ditch|take (?:off|away|out|down)) (?:all (?:of )?|every )?(?:the |that |this |my |our )?(?:(?<q>main|hero|big|large|top|first|opening|cover|background|second|third|fourth|1st|2nd|3rd|4th|about|services?|gallery|contact|faq|collage) )?(?:(?<n>photo|picture|image|pic|photograph) ?(?<num>\d{1,2})?|(?<n2>photos|pictures|images|pics))(?: (?:in|on|from|of|at|under|inside) (?<ref>.+?))?(?: (?:off|out|away|from (?:the |my )?(?:site|website|page|draft)))?$/i,
    /^take (?:the |that |this |my )?(?:(?<q>main|hero|big|large|top|first|opening|cover|background|about|services?|gallery|collage) )?(?<n>photo|picture|image|pic) ?(?<num>\d{1,2})? (?:off|out|away|down)(?: (?:of|from) (?<ref>.+?))?$/i,
  ],
}
// A logo request inside a longer message: the model cannot change logos (and must not claim to), so it is never sent.
const LOGO_MENTION = /\b(?:remove|delete|drop|hide|replace|swap|upload|restore|add|change|update|switch|without|no) (?:the |my |our |a |an |new |different |another )*logo\b|\b(?:get rid of|take (?:off|away|out|down)|put|bring)\b[^.!?]{0,20}\blogo\b|\blogo\b (?:back|off|away|out|gone)\b/i

const FIELD_PATH = { heading: 'heading', headline: 'heading', title: 'heading', subheading: 'text', 'sub-heading': 'text', eyebrow: 'eyebrow', label: 'eyebrow', text: 'text', copy: 'text', paragraph: 'text', wording: 'text', words: 'text', body: 'text', description: 'text', intro: 'text' }
const FIELD_NAMES = { heading: 'heading', eyebrow: 'small label', text: 'text', body: 'text', headline: 'headline', intro: 'intro', about: 'about text' }
const firstMatch = (res, text) => {
  for (const re of res) {
    const m = text.match(re)
    if (m) return m
  }
  return null
}

// Where a section keeps the field the owner means (compositions keep their words in blocks; text sections in `body`).
function fieldPath(section, field) {
  if (section.type === 'composition') {
    const kind = field === 'heading' ? 'heading' : 'text'
    const i = (section.blocks || []).findIndex((b) => b.kind === kind)
    return i >= 0 ? `blocks.${i}.text` : null
  }
  if (field === 'text') return ['text', 'imageText'].includes(section.type) ? 'body' : 'text'
  return field
}
const limitFor = (path) => (path === 'body' ? LIMITS.body : path === 'eyebrow' ? LIMITS.eyebrow : path === 'text' ? LIMITS.text : LIMITS.heading)
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
function set(obj, path, value) {
  const keys = path.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k]
  if (value === undefined) delete o[keys.at(-1)]
  else o[keys.at(-1)] = value
}
const clone = (v) => JSON.parse(JSON.stringify(v))
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

// ── Intent detection: the owner's message + the CURRENT draft → { kind: 'op', op } | { kind: 'clarify', ... } | { kind: 'broad' }.
export function detectIntent(message, draft) {
  const text = core(message)
  if (!text) return { kind: 'broad' }
  const site = draft?.site || null
  const clarify = (reason, reply, options = []) => ({ kind: 'clarify', reason, reply, options })
  const op = (name, args = {}) => {
    const v = validateOperation({ name, args })
    return v ? { kind: 'op', op: v } : clarify('invalid', 'I couldn’t apply that exactly as written. Nothing changed.')
  }

  if (firstMatch(RE.removeLogo, text)) return op('remove_logo')
  if (firstMatch(RE.restoreLogo, text)) return op('restore_logo')
  const rl = firstMatch(RE.replaceLogo, text)
  if (rl) return op('replace_logo', { named: Boolean(rl.groups?.named) || /\.(?:png|jpe?g|svg|webp|gif)\b|\b(?:named|called|file)\b/i.test(text) })

  const sf = firstMatch(RE.sectionField, text)
  if (sf) {
    const field = sf.groups.field ? FIELD_PATH[sf.groups.field.toLowerCase()] || 'text' : 'heading'
    const value = unquote(sf.groups.text)
    if (!value) return clarify('empty', 'What should it say? Nothing changed.')
    const ref = sf.groups.ref
    if (!site) {
      const r = strip(ref)
      const classic = /^about/.test(r) ? 'about' : /^(?:intro|introduction|opening text|first paragraph)/.test(r) ? 'intro' : /^(?:top|headline|heading|first screen|hero|page|site|website)$/.test(r) ? 'headline' : null
      const path = classic === 'headline' ? 'headline' : classic && field !== 'heading' ? classic : null
      if (!path) return clarify('not_found', `I couldn’t find “${r}” on your draft. You can change the headline, the intro or the about text. Nothing changed.`)
      if (value.length > CONTENT_LIMITS[path]) return clarify('too_long', refusalText('too_long', FIELD_NAMES[path], value, CONTENT_LIMITS[path]))
      return op('set_section_text', { page: 0, section: 0, path, text: value })
    }
    const found = matchSections(site, ref)
    if (!found.length) return clarify('not_found', `I couldn’t find a section called “${strip(ref)}”. Sections on your site: ${allSections(site)}. Nothing changed.`)
    const withField = found.map(([pi, si]) => [pi, si, fieldPath(site.pages[pi].sections[si], field)]).filter(([, , p]) => p)
    if (withField.length !== 1) return clarify('ambiguous', `Which section do you mean? ${withField.length ? withField.map(([pi, si]) => sectionLabel(site, pi, si)).join(', ') : 'None of those has that kind of text.'} Nothing changed.`, withField.map(([pi, si]) => sectionLabel(site, pi, si)))
    const [pi, si, path] = withField[0]
    if (value.length > limitFor(path)) return clarify('too_long', refusalText('too_long', `${FIELD_NAMES[path.startsWith('blocks.') ? (field === 'heading' ? 'heading' : 'text') : path]} of ${sectionLabel(site, pi, si)}`, value, limitFor(path)))
    return op('set_section_text', { page: pi, section: si, path, text: value })
  }

  const hl = firstMatch(RE.headline, text)
  if (hl) {
    const value = unquote(hl.groups.text)
    if (!value) return clarify('empty', 'What should the headline say? Nothing changed.')
    const max = site ? LIMITS.heading : CONTENT_LIMITS.headline
    if (value.length > max) return clarify('too_long', refusalText('too_long', 'headline', value, max))
    return op('set_headline', { text: value })
  }

  const ri = firstMatch(RE.removeImage, text)
  if (ri) {
    const g = ri.groups || {}
    const slots = site ? imageSlots(site) : classicImageSlots(draft)
    if (g.n2) return clarify('several', `I remove one picture at a time. Which one? ${listSlots(slots)} Nothing changed.`)
    if (!slots.length) return clarify('not_found', 'There are no pictures on your draft to remove. Nothing changed.')
    let cands = slots
    const q = (g.q || '').toLowerCase()
    const ordinal = g.num ? Number(g.num) : { second: 2, third: 3, fourth: 4, '2nd': 2, '3rd': 3, '4th': 4, first: 1, '1st': 1 }[q]
    if (g.ref) {
      if (site) {
        const found = matchSections(site, g.ref)
        if (!found.length) return clarify('not_found', `I couldn’t find “${strip(g.ref)}”. Pictures on your site: ${listSlots(slots)} Nothing changed.`)
        cands = cands.filter((c) => found.some(([pi, si]) => pi === c.page && si === c.section))
      } else if (!/^(?:top|home|home ?page|site|website|first screen|page|hero|header)$/.test(strip(g.ref))) return clarify('not_found', `I couldn’t find “${strip(g.ref)}”. Pictures on your draft: ${listSlots(slots)} Nothing changed.`)
    }
    if (/^(?:main|hero|big|large|top|opening|cover)$/.test(q)) cands = cands.filter((c) => (site ? c.page === 0 && c.section === 0 : c.slot === 'hero'))
    else if (q === 'background') cands = cands.filter((c) => c.slot === 'backgroundImage')
    else if (q === 'collage') cands = cands.filter((c) => c.slot.startsWith('images.') || c.slot.startsWith('blocks.'))
    else if (site && /^(?:about|services?|gallery|contact|faq)$/.test(q)) {
      const found = matchSections(site, q)
      cands = cands.filter((c) => found.some(([pi, si]) => pi === c.page && si === c.section))
    }
    if (ordinal) {
      const inSection = cands.filter((c) => c.n === ordinal)
      cands = inSection.length ? inSection : cands[ordinal - 1] && !g.ref && !q ? [cands[ordinal - 1]] : []
    }
    if (/^(?:main|hero)$/.test(q) && cands.length > 1) cands = [...cands.filter((c) => c.slot === 'image' || c.slot === 'hero'), ...cands.filter((c) => c.slot.startsWith('blocks.'))].slice(0, 1)
    if (cands.length === 1) return op('remove_image', { page: cands[0].page, section: cands[0].section, slot: cands[0].slot })
    if (!cands.length) return clarify('not_found', `I couldn’t find that picture. Pictures on your ${site ? 'site' : 'draft'}: ${listSlots(slots)} Nothing changed.`)
    return clarify('ambiguous', `Which picture do you mean? ${listSlots(cands)} Nothing changed.`, cands.map((c) => c.label))
  }

  if (LOGO_MENTION.test(text)) return clarify('logo_separately', 'Logo changes are done one at a time, by themselves: send “Remove my logo” or “Put my logo back” on its own, or use the Logo control (Replace / Upload) in the editor. Describe any other change in a separate message. Nothing changed.')
  return { kind: 'broad' }
}
const allSections = (site) => site.pages.flatMap((p, pi) => p.sections.map((_, si) => sectionLabel(site, pi, si))).join(', ')
const listSlots = (slots) => (slots.length ? `${slots.slice(0, 10).map((s) => `${s.label} (say “${s.say}”)`).join('; ')}${slots.length > 10 ? '; …' : ''}.` : 'none.')

// One text value through the designer's gates: length, approved claims only, no number that isn't in the records.
function textGate(value, max, ctx) {
  const wanted = clean(value)
  if (!wanted) return 'invalid_content'
  if (wanted.length > max) return 'too_long'
  if (unapprovedClaims(wanted, ctx.claims).length) return 'claim'
  if (ctx.factsText && inventedNumbers(wanted, ctx.factsText).length) return 'invented_number'
  return null
}
const specAssetIds = (site) => {
  const out = []
  for (const p of site?.pages || []) for (const s of p.sections) for (const v of [s.image, s.backgroundImage, ...(s.images || []), ...(s.items || []).map((x) => x?.image), ...(s.blocks || []).map((b) => b?.image)]) if (typeof v === 'string' && v.startsWith('asset:')) out.push(v.slice(6))
  return out
}

// ── Applying one operation to the CURRENT draft (the session's business only; nothing else is read or written).
// Returns { ok: true, reply, generationId, applied: [code], notApplied: [{ op, reason }] } or { ok: false, httpStatus, error }.
export async function applyIntent(env, customer, intent, { by, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const owner = clean(intent?.message).slice(0, 1200)
  const record = async (reply, generationId = null) => {
    await db.batch([
      db.prepare("INSERT INTO website_design_turns (customer, role, text, generation_id, created_at) VALUES (?1, 'owner', ?2, NULL, ?3)").bind(customer.id, owner || '(empty)', now),
      db.prepare("INSERT INTO website_design_turns (customer, role, text, generation_id, created_at) VALUES (?1, 'designer', ?2, ?3, ?4)").bind(customer.id, reply, generationId, now + 1),
    ])
  }
  if (intent?.kind === 'clarify') {
    await record(intent.reply)
    return { ok: true, reply: intent.reply, generationId: null, applied: [], notApplied: [{ op: 'clarify', reason: intent.reason }], options: intent.options || [] }
  }
  const op = validateOperation(intent?.op)
  if (!op) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  // The current draft (authoritative), this business's images, its approved claims and the facts for the number check.
  const ctx = await designContext(env, customer)
  const owned = ctx.owned // every image the business owns (the logo pointer is checked against these)
  const draft = ctx.draft
  const next = clone(draft)
  let code = null
  let refusal = null
  let detail = ''
  const refuse = (reason, text) => {
    refusal = { op: op.name, reason }
    detail = text
  }
  // Sets one field of the site and checks that validateSpec (as the save runs it) keeps exactly that value there.
  const setSiteText = (pi, si, path, value) => {
    const s = next.site.pages[pi]?.sections[si]
    if (!s || (path.startsWith('blocks.') ? !s.blocks?.[Number(path.split('.')[1])] : !['heading', 'eyebrow', 'text', 'body'].includes(path))) return 'not_found'
    const reason = textGate(value, limitFor(path.startsWith('blocks.') ? (s.blocks[Number(path.split('.')[1])].kind === 'heading' ? 'heading' : 'text') : path), ctx)
    if (reason) return reason
    set(s, path, clean(value))
    const { spec } = validateSpec(next.site, { assetIds: ctx.assetIds, services: ctx.services, claims: ctx.claims })
    if (get(spec, `pages.${pi}.sections.${si}.${path}`) !== clean(value)) return 'invalid_content'
    next.site = spec
    return null
  }
  const setClassicText = (field, value) => {
    const reason = textGate(value, CONTENT_LIMITS[field], ctx)
    if (reason) return reason
    next[field] = clean(value)
    const [errors] = validateContent(next, ctx.claims, owned, { prior: draft.services, photoIds: ctx.assetIds })
    return errors.some((e) => e === field || e === `${field}:unapproved_claim`) ? 'invalid_content' : null
  }

  if (op.name === 'remove_logo') {
    if (draft.logo == null) refuse('no_logo', 'There’s no logo on your draft right now, so nothing changed.')
    else {
      next.logo = null // explicit: no logo (never a missing field, which older content read as "not set")
      code = 'logo_removed'
    }
  } else if (op.name === 'replace_logo') {
    if (op.args.named) refuse('cannot_name_file', 'I can’t pick an image by its name: uploaded pictures don’t keep their file names, and I never choose images for you. Use the Logo control (Replace / Upload) in the editor. Nothing changed.')
    else refuse('use_logo_control', 'I can’t choose or upload images. To add or replace your logo, use the Logo control (Replace / Upload) in the editor. Nothing changed.')
  } else if (op.name === 'restore_logo') {
    if (draft.logo) refuse('already_logo', 'Your logo is already on the draft, so nothing changed.')
    else {
      const pick = op.args.assetId ? (owned.has(op.args.assetId) && (await logoAssetIdsFor(db, customer.id, draft)).has(op.args.assetId) ? { id: op.args.assetId, from: 'your logo' } : null) : await previousLogo(db, customer.id, draft, owned)
      if (!pick) refuse('no_logo_available', 'I can’t find a logo of yours to put back. Upload one with the Logo control (Replace / Upload) in the editor. Nothing changed.')
      else {
        next.logo = pick.id
        code = 'logo_restored'
        detail = pick.from
      }
    }
  } else if (op.name === 'set_headline') {
    const value = op.args.text
    let reason
    if (next.site) {
      const s = next.site.pages[0]?.sections[0]
      const path = s ? fieldPath(s, 'heading') : null
      reason = path ? setSiteText(0, 0, path, value) : 'not_found'
    } else reason = setClassicText('headline', value)
    if (reason === 'not_found') refuse(reason, 'Your first screen has no headline I can change. Nothing changed.')
    else if (reason) refuse(reason, refusalText(reason, 'headline', value, next.site ? LIMITS.heading : CONTENT_LIMITS.headline))
    else {
      code = 'headline_changed'
      detail = clean(value)
    }
  } else if (op.name === 'set_section_text') {
    const { page, section, path, text: value } = op.args
    if (next.site) {
      const what = path === 'heading' || (path.startsWith('blocks.') && next.site.pages[page]?.sections[section]?.blocks?.[Number(path.split('.')[1])]?.kind === 'heading') ? 'heading' : path === 'eyebrow' ? 'small label' : 'text'
      const reason = setSiteText(page, section, path, value)
      if (reason === 'not_found') refuse(reason, 'I couldn’t find that section any more (the draft changed). Nothing changed.')
      else if (reason) refuse(reason, refusalText(reason, `${what} of ${sectionLabel(draft.site, page, section)}`, value, limitFor(what === 'heading' ? 'heading' : path)))
      else {
        code = what === 'heading' ? 'section_renamed' : 'section_text_changed'
        detail = `${what} of ${sectionLabel(draft.site, page, section)}`
      }
    } else {
      const field = ['headline', 'intro', 'about'].includes(path) ? path : null
      const reason = field ? setClassicText(field, value) : 'not_found'
      if (reason === 'not_found') refuse(reason, 'That field doesn’t exist on this draft. Nothing changed.')
      else if (reason) refuse(reason, refusalText(reason, FIELD_NAMES[field], value, CONTENT_LIMITS[field]))
      else {
        code = field === 'headline' ? 'headline_changed' : 'section_text_changed'
        detail = FIELD_NAMES[field]
      }
    }
  } else if (op.name === 'remove_image') {
    const { page, section, slot } = op.args
    const slots = next.site ? imageSlots(next.site) : classicImageSlots(next)
    const target = slots.find((x) => x.page === page && x.section === section && x.slot === slot)
    if (!target) refuse('not_found', 'I couldn’t find that picture any more (the draft changed). Nothing changed.')
    else if (!next.site) {
      if (slot === 'hero') next.hero = null
      else next.photos.splice(Number(slot.split('.')[1]), 1)
      code = 'image_removed'
      detail = target.label
    } else {
      const s = next.site.pages[page].sections[section]
      if (slot === 'image') {
        delete s.image
        delete s.imageAlt
      } else if (slot === 'backgroundImage') {
        delete s.backgroundImage
        if (s.background === 'image') s.background = 'bg'
      } else if (slot.startsWith('images.')) s.images.splice(Number(slot.split('.')[1]), 1)
      else if (slot.startsWith('items.')) delete s.items[Number(slot.split('.')[1])].image
      else if (slot.startsWith('blocks.')) s.blocks.splice(Number(slot.split('.')[1]), 1)
      const { spec, warnings } = validateSpec(next.site, { assetIds: ctx.assetIds, services: ctx.services, claims: ctx.claims })
      const kept = spec.pages[page]?.sections[section]
      if (!kept || kept.id !== s.id || warnings.some((w) => w.where === `pages.${page}.sections.${section}` && w.reason === 'empty')) refuse('only_content', 'That picture is all that section has, so removing it would remove the whole section. Nothing changed. If that’s what you want, remove the section in the editor.')
      else {
        next.site = spec
        code = 'image_removed'
        detail = target.label
      }
    }
  }

  if (!code) {
    await record(detail)
    return { ok: true, reply: detail, generationId: null, applied: [], notApplied: [refusal] }
  }
  // Same gates as every save; the services keep their ids (prior); legal pages are never touched here.
  // Photos may come only from the owner's photos (never a logo as a photo); the logo pointer from every owned file.
  const [errors, content] = validateContent(next, ctx.claims, owned, { prior: draft.services, photoIds: ctx.assetIds })
  if (errors.length) {
    const reply = 'I couldn’t make that change safely, so nothing changed.'
    await record(reply)
    return { ok: true, reply, generationId: null, applied: [], notApplied: [{ op: op.name, reason: 'invalid_content' }] }
  }
  // Ownership is never widened by an operation: the result uses only this business's images (defence in depth).
  const images = [content.logo, content.hero, ...(content.photos || []), ...specAssetIds(content.site)].filter(Boolean)
  if (images.some((id) => !owned.has(id))) return { ok: false, httpStatus: 403, error: 'forbidden' }
  // A server copy of the draft as it was (restorable from the editor's history and by "Undo this change").
  const checkpointId = await saveCheckpoint(db, customer.id, draft, 'before_designer_change', now)
  await saveDraft(db, customer.id, content, now)
  // Re-read what is stored and report exactly that.
  const after = (await loadWebsite(db, customer)).draft
  const verified = verify(op, after, draft)
  const reply = verified ? successText(code, detail) : 'I tried to make that change but could not confirm it was saved. Please check the preview; nothing else was touched.'
  await record(reply, verified ? checkpointId : null)
  await recordEvent(db, { type: 'website.design_intent', actor: by ? `owner:${by}` : 'system', customer: customer.id, capability: 'website.ai', resource: { type: 'website', id: customer.id }, outcome: verified ? 'success' : 'failure', details: { op: op.name, applied: verified ? [code] : [], verified } })
  return verified ? { ok: true, reply, generationId: checkpointId, applied: [code], notApplied: [] } : { ok: true, reply, generationId: null, applied: [], notApplied: [{ op: op.name, reason: 'verify_failed' }] }
}

// The logo to put back: the one a designer turn removed most recently (its "before" copy), else the logo of the most
// recently published version. Only an image this business still owns and that was its logo (never a photo).
async function previousLogo(db, customerId, draft, owned) {
  const removed = await db
    .prepare("SELECT json_extract(content, '$.draft.logo') AS logo FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'checkpoint' AND json_extract(content, '$.reason') = 'before_designer_change' AND json_type(content, '$.draft.logo') = 'text' ORDER BY created_at DESC LIMIT 5")
    .bind(customerId)
    .all()
  for (const r of removed.results) if (ASSET_ID.test(r.logo || '') && owned.has(r.logo)) return { id: r.logo, from: 'the logo you removed earlier' }
  const logos = await logoAssetIdsFor(db, customerId, draft)
  const versions = await db.prepare("SELECT json_extract(content, '$.logo') AS logo FROM website_versions WHERE customer = ?1 ORDER BY version DESC").bind(customerId).all()
  for (const r of versions.results) if (ASSET_ID.test(r.logo || '') && owned.has(r.logo) && logos.has(r.logo)) return { id: r.logo, from: 'the logo from your last published version' }
  return null
}

// What is actually stored after the save, compared with what the operation promised.
function verify(op, after, before) {
  switch (op.name) {
    case 'remove_logo':
      return after.logo === null
    case 'restore_logo':
      return typeof after.logo === 'string' && ASSET_ID.test(after.logo)
    case 'set_headline': {
      const wanted = clean(op.args.text)
      if (!after.site) return after.headline === wanted
      const s = after.site.pages[0]?.sections[0]
      return Boolean(s) && get(s, fieldPath(s, 'heading') || 'heading') === wanted
    }
    case 'set_section_text': {
      const wanted = clean(op.args.text)
      if (!after.site) return after[op.args.path] === wanted
      return get(after.site.pages[op.args.page]?.sections[op.args.section] || {}, op.args.path) === wanted
    }
    case 'remove_image': {
      const slots = after.site ? imageSlots(after.site) : classicImageSlots(after)
      const was = (before.site ? imageSlots(before.site) : classicImageSlots(before)).length
      return slots.length === was - 1 && (!after.site || after.site.pages.length === before.site.pages.length)
    }
    default:
      return false
  }
}

const successText = (code, detail) =>
  ({
    logo_removed: 'Done: the logo is removed from your draft. Nothing else changed. Publish when you’re ready.',
    logo_restored: `Done: your logo is back (${detail}). Nothing else changed.`,
    headline_changed: `Done: the headline now reads “${detail}”. Nothing else changed.`,
    section_renamed: `Done: the ${detail} is changed. Nothing else changed.`,
    section_text_changed: `Done: the ${detail} is changed. Nothing else changed.`,
    image_removed: `Done: removed ${detail}. Nothing else changed.`,
  })[code]
const refusalText = (reason, what, value, max) =>
  ({
    claim: `Not changed: “${value}” contains a promise or claim we can’t verify (for example reviews, guarantees, licences or “best”), so the ${what} stays as it is.`,
    invented_number: `Not changed: “${value}” contains a number that isn’t in your business records, so the ${what} stays as it is. Add the fact in Settings first, or leave the number out.`,
    too_long: `Not changed: that text is too long for the ${what} (up to ${max} characters).`,
  })[reason] || `Not changed: that text can’t be used for the ${what}.`
