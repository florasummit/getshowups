// Websites and the ONE service catalog (server/services.js, business_profiles.services; finding WEB-14).
// A website keeps its own list of services (content.services: order, which ones it shows, the design's words per
// section), but a service LINKED to a catalog service shows the catalog's name, price and description (when the
// catalog has one) at request time, and a service hidden in the catalog is not shown. Linked = the website service's
// catalogId is a current catalog id, else (content saved before links existed) exactly one catalog service has its
// name. Anything else renders from the website's own copy, exactly as before. No migration: catalogId is stored on the
// website service only once an owner saves it.
// Editing: a name/price/description the owner changed in the website editor is written to the catalog through
// validateServices (the same validated path as Settings → Services); adding a service in the Studio adds it to the
// catalog (addCatalogService); removing one from the website only removes it from the website.
import { LIMITS as CATALOG_LIMITS, MAX_SERVICES, readServices, validateServices } from './services.js'

export const CATALOG_ID_RE = /^sv_[a-z0-9]{3,16}$/
// Names compare by letters and digits only ("One Time Service" = "one-time service"); ambiguity still means no link.
const key = (n) => String(n ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const FIELDS = ['name', 'price', 'description']

// The stored catalog (JSON text or array) → normalized services with ids; null when there is no profile row.
export function parseCatalog(stored) {
  if (stored == null) return null
  try {
    return readServices(typeof stored === 'string' ? JSON.parse(stored) : stored)
  } catch {
    return null
  }
}

// services[] → catalog entry (or null) per position. A catalog service links to at most one website service.
export function catalogLinks(services, catalog) {
  const list = Array.isArray(services) ? services : []
  if (!Array.isArray(catalog) || !catalog.length) return list.map(() => null)
  const byId = new Map(catalog.map((c) => [c.id, c]))
  const used = new Set()
  const out = list.map((s) => {
    const c = typeof s?.catalogId === 'string' ? byId.get(s.catalogId) : null
    if (!c || used.has(c.id)) return null
    used.add(c.id)
    return c
  })
  return out.map((c, i) => {
    if (c) return c
    const k = key(list[i]?.name)
    const same = k ? catalog.filter((x) => key(x.name) === k) : []
    if (same.length !== 1 || used.has(same[0].id)) return null
    // Unambiguous on the website side too: another website service with the same name would make it a guess.
    if (list.filter((s, j) => j !== i && !out[j] && key(s?.name) === k).length) return null
    used.add(same[0].id)
    return same[0]
  })
}

const linked = (s, c) => ({ ...s, catalogId: c.id, name: c.name, price: c.price, description: c.description || s.description || '' })

// Rendering: content with linked services showing the catalog. values: false keeps the content's own values (the
// editor's live preview of unsaved typing) and applies only the hidden flag. Unchanged content when nothing links.
export function withCatalog(content, catalog, { values = true } = {}) {
  if (!content || !Array.isArray(content.services) || !Array.isArray(catalog) || !catalog.length) return content
  const links = catalogLinks(content.services, catalog)
  if (!links.some(Boolean)) return content
  const shown = content.services.map((s, i) => (links[i] && values ? linked(s, links[i]) : s))
  const hidden = new Set(links.map((c, i) => (c?.hidden ? i : -1)).filter((i) => i >= 0))
  // Older renderers list content.services directly: a hidden service is simply left out.
  if (!content.site) return { ...content, services: shown.filter((_, i) => !hidden.has(i)) }
  if (!hidden.size) return { ...content, services: shown }
  // Multi-page sites refer to services by id (or, read-time only, position): the list stays, the references to a hidden
  // service are left out of each services section; a section left with none is not shown.
  const ids = new Set([...hidden].map((i) => content.services[i]?.id).filter(Boolean))
  const off = (it) => (typeof it?.serviceId === 'string' ? ids.has(it.serviceId) : Number.isInteger(it?.serviceIndex) && hidden.has(it.serviceIndex))
  const pages = (content.site.pages || []).map((p) => ({
    ...p,
    sections: (p.sections || []).map((s) => {
      if (s?.type !== 'services' || !Array.isArray(s.items) || !s.items.some(off)) return s
      const items = s.items.filter((it) => !off(it))
      return { ...s, items, ...(items.length ? {} : { hidden: true }) }
    }),
  }))
  return { ...content, services: shown, site: { ...content.site, pages } }
}

// The owner's editor: the draft with linked services showing the catalog (and their catalogId; a service without one is
// on the website only), stale links dropped, plus the catalog ids hidden in Settings → Services (not shown publicly).
export function editorServices(content, catalog) {
  if (!content || !Array.isArray(content.services)) return { content, hidden: [] }
  const links = catalogLinks(content.services, catalog)
  const services = content.services.map((s, i) => {
    if (links[i]) return linked(s, links[i])
    if (s?.catalogId === undefined) return s
    const { catalogId: _stale, ...rest } = s
    return rest
  })
  return { content: { ...content, services }, hidden: links.filter((c) => c?.hidden).map((c) => c.id) }
}

// A save: which catalog services the owner changed from the website editor. `stored`: the draft's services as last saved
// (raw), so a value the editor merely still shows (Settings changed it since) is not written back over the catalog.
// Returns { errors, catalog (next list, or null = nothing to write), services (with catalogId set) }.
export function catalogEdits(services, stored, catalog, { designed = false } = {}) {
  const list = Array.isArray(services) ? services : []
  if (!Array.isArray(catalog) || !catalog.length || !list.length) return { errors: [], catalog: null, services: list }
  const links = catalogLinks(list, catalog)
  const before = Array.isArray(stored) ? stored : []
  const prevOf = (s) => (designed && s.id ? before.find((p) => p?.id === s.id) : null) || (s.catalogId ? before.find((p) => p?.catalogId === s.catalogId) : null) || before.find((p) => key(p?.name) === key(s.name))
  const next = catalog.map((c) => ({ ...c }))
  let changed = false
  for (const [i, s] of list.entries()) {
    const c = links[i]
    const p = c ? prevOf(s) : null
    if (!c || !p) continue
    const target = next.find((x) => x.id === c.id)
    for (const f of FIELDS) {
      const v = s[f] ?? ''
      // An emptied website description falls back to the catalog's (it is shown from there), so it never erases it.
      if (v === (p[f] ?? '') || v === target[f] || (f === 'description' && !v)) continue
      target[f] = v
      changed = true
    }
  }
  if (!changed) return { errors: [], catalog: null, services: list.map((s, i) => (links[i] ? { ...s, catalogId: links[i].id } : s)) }
  const [errors, saved] = validateServices(next, catalog)
  if (errors.length) return { errors, catalog: null, services: list }
  // validateServices keeps order and ids (a legacy row gets its first stored id here): re-point the links.
  const idAt = new Map(next.map((c, j) => [c.id, saved[j]?.id]))
  return { errors: [], catalog: saved, services: list.map((s, i) => (links[i] ? { ...s, catalogId: idAt.get(links[i].id) || links[i].id } : s)) }
}

// Studio "Add a service" / "Add to booking page": one service into the catalog (visible, bookable, one slot; the owner
// refines it in Settings → Services). The same name already in the catalog is that service (never a duplicate).
// Returns [error | null, service, list | null (null = nothing to write)].
export function addToCatalog(catalog, input) {
  const current = Array.isArray(catalog) ? catalog : []
  const name = String(input?.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return ['services']
  const same = current.find((c) => key(c.name) === key(name))
  if (same) return [null, same, null]
  if (current.length >= MAX_SERVICES) return ['services_full']
  const description = String(input?.description ?? '').replace(/\s+/g, ' ').trim()
  const fresh = { name, price: String(input?.price ?? ''), ...(description && description.length <= CATALOG_LIMITS.description ? { description } : {}) }
  const [errors, saved] = validateServices([...current, fresh], current)
  if (errors.length) return [errors[0]]
  return [null, saved.at(-1), saved]
}

// Writes the catalog (business_profiles.services) for a business that has a profile row; false when it has none.
export async function writeCatalog(db, customerId, services, now = Date.now()) {
  const r = await db.prepare('UPDATE business_profiles SET services = ?2, updated_at = ?3 WHERE customer = ?1').bind(customerId, JSON.stringify(services), now).run()
  return (r?.meta?.changes ?? 0) > 0
}

export async function readCatalog(db, customerId) {
  const r = await db.prepare('SELECT services FROM business_profiles WHERE customer = ?1').bind(customerId).first()
  return r ? parseCatalog(r.services) : null
}
