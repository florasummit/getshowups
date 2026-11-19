// Where the DRAFT shows a photo, and replacing a photo everywhere in the draft (no components here). The server keeps
// its own walk for every stored copy (server/assets.js photoUsage: live, saved versions, history, logos); this one only
// adds page · section names for the owner. Image slots of the Studio format mirror server/site-spec.js specImages
// (test/studio-hardening.test.js keeps the two in step).
import { SECTION_LABEL } from './site-templates.js'

const SLOT_KEYS = ['image', 'backgroundImage']
const ref = (id) => `asset:${id}`

// [{ page, section, label }] for every place the draft shows the photo (the logo is not a photo place).
export function draftPlaces(content, id) {
  const out = []
  const r = ref(id)
  for (const p of content?.site?.pages || [])
    for (const s of p.sections || []) {
      const hit = SLOT_KEYS.some((k) => s[k] === r) || (s.images || []).includes(r) || (s.items || []).some((x) => x?.image === r) || (s.blocks || []).some((b) => b?.image === r)
      if (hit) out.push({ page: p.slug, section: s.id, label: `${p.navLabel || 'Home'} · ${SECTION_LABEL[s.type] || s.type}${s.hidden ? ' (hidden)' : ''}` })
    }
  if (content?.hero === id) out.push({ page: null, section: null, label: 'Main photo' })
  if ((content?.photos || []).includes(id)) out.push({ page: null, section: null, label: 'Photo gallery' })
  if (content?.design?.heroImage === r || content?.design?.aboutImage === r) out.push({ page: null, section: null, label: 'Design photo' })
  return out
}

// A copy of the content with every draft use of photo `from` changed to photo `to` (both this business's ids).
// Lists that already contain `to` aren't given a duplicate. Returns { content, count }.
export function replacePhoto(content, from, to) {
  const c = JSON.parse(JSON.stringify(content))
  const a = ref(from)
  const b = ref(to)
  let count = 0
  const swapList = (list, x, y) => {
    if (!Array.isArray(list) || !list.includes(x)) return list
    count++
    return list.includes(y) ? list.filter((v) => v !== x) : list.map((v) => (v === x ? y : v))
  }
  const swap = (o, k, x, y) => {
    if (o && o[k] === x) {
      o[k] = y
      count++
    }
  }
  for (const p of c.site?.pages || [])
    for (const s of p.sections || []) {
      for (const k of SLOT_KEYS) swap(s, k, a, b)
      if (s.images) s.images = swapList(s.images, a, b)
      for (const x of s.items || []) swap(x, 'image', a, b)
      for (const bl of s.blocks || []) swap(bl, 'image', a, b)
    }
  swap(c, 'hero', from, to)
  if (c.photos) c.photos = swapList(c.photos, from, to)
  for (const k of ['heroImage', 'aboutImage']) swap(c.design, k, a, b)
  return { content: c, count }
}

// "Used on: …" for one photo: draft places (named), then what the server reported for stored copies.
export function usageText(places, usage) {
  const parts = places.map((p) => p.label)
  if (usage?.live) parts.push('your live website')
  if (usage?.versions) parts.push(`${usage.versions} saved version${usage.versions === 1 ? '' : 's'}`)
  if (usage?.history) parts.push('earlier drafts (History / undo)')
  if (usage?.draft && !places.length) parts.push('your draft')
  return parts
}
