// AI website design + copy: one structured model request turns the business's own details into polished,
// industry-specific website text AND three distinct design directions chosen from the safe design system
// (server/site-design.js: layout, palette, typography, section order, photo placement). The model never
// writes HTML/CSS. It only writes prose (headline, intro, about, service descriptions, search text) and
// picks named design options. Facts (name, services, prices, area, phone) always come from the
// business's records, and every generated sentence passes the claims filter plus a number check
// (no invented years, ratings, prices or counts). Anything that fails falls back to the template text.
// Provider: Cloudflare Workers AI (binding `AI`). Without it, the deterministic template is used.
import { brandName, generateContent, validateContent, LIMITS } from './website.js'
import { approvedClaimsFor } from './landing.js'
import { unapprovedClaims } from './ads/spec.js'
import { FONTS, LAYOUTS, PALETTES, SECTIONS, SHAPES, directionFor, diversify, industryKey, presetDesigns, stockFor, validateDesign } from './site-design.js'

export const WEBSITE_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
// USD per million tokens (Workers AI list price for WEBSITE_MODEL).
export const PRICE = { inputPerM: 0.351, outputPerM: 0.555 }
export const MONTHLY_GENERATIONS = 40 // creations + revisions per business per 30 days

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/

const COPY_PROPS = {
  headline: { type: 'string', description: 'Website headline, under 70 characters' },
  intro: { type: 'string', description: 'One or two sentences under the headline, under 300 characters' },
  about: { type: 'string', description: 'Two short paragraphs about the business, under 700 characters' },
  services: {
    type: 'array',
    items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string', description: 'One sentence, under 200 characters' } }, required: ['name', 'description'] },
  },
  seoTitle: { type: 'string', description: 'Search result title, under 65 characters' },
  seoDescription: { type: 'string', description: 'Search result description, under 155 characters' },
}
// `images`: allowed image references for this business (owner photos first, then licensed stock).
const designSchema = (images) => ({
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Two-word name for this direction, e.g. "Fresh Coastal"' },
    palette: { type: 'string', enum: Object.keys(PALETTES) },
    fonts: { type: 'string', enum: Object.keys(FONTS) },
    hero: { type: 'string', enum: Object.keys(LAYOUTS.hero) },
    services: { type: 'string', enum: Object.keys(LAYOUTS.services) },
    about: { type: 'string', enum: Object.keys(LAYOUTS.about) },
    shape: { type: 'string', enum: SHAPES },
    sections: { type: 'array', items: { type: 'string', enum: SECTIONS } },
    heroImage: { type: 'string', enum: ['none', ...images] },
    aboutImage: { type: 'string', enum: ['none', ...images] },
  },
  required: ['name', 'palette', 'fonts', 'hero', 'services', 'about', 'shape', 'sections', 'heroImage', 'aboutImage'],
})
export const schemaFor = (images) => ({
  type: 'object',
  properties: { ...COPY_PROPS, designs: { type: 'array', items: designSchema(images), description: 'Exactly three clearly different designs' } },
  required: [...Object.keys(COPY_PROPS), 'designs'],
})
export const reviseSchemaFor = (images) => ({ type: 'object', properties: { ...COPY_PROPS, design: designSchema(images) }, required: [...Object.keys(COPY_PROPS), 'design'] })
export const SCHEMA = schemaFor([])

const DESIGN_GUIDE = `Design options (choose names exactly):
palettes: ${Object.entries(PALETTES).map(([k, v]) => `${k} (${v.dark ? 'dark, ' : ''}${v.label.toLowerCase()})`).join(', ')}
fonts: modern (geometric, crisp), editorial (elegant serif headings), classic (traditional serif), friendly (rounded, approachable), strong (heavy, confident)
hero: ${Object.entries(LAYOUTS.hero).map(([k, v]) => `${k} (${v.toLowerCase()})`).join(', ')}
services: ${Object.entries(LAYOUTS.services).map(([k, v]) => `${k} (${v.toLowerCase()})`).join(', ')}
about: ${Object.entries(LAYOUTS.about).map(([k, v]) => `${k} (${v.toLowerCase()})`).join(', ')}
shape: sharp, soft, round. sections: order of ${SECTIONS.join(', ')} (gallery shows only the owner's own photos).
Images: "asset:..." are the owner's own photos (prefer them for the hero when present); "stock:..." are licensed example
photos of this business's own industry; "none" means no photo. Only use the images listed. If none are listed, use
"none" (the typographic hero and text layouts look finished without a photo). Typographic hero needs no photo.`

const RULES = `You are an experienced copywriter for local home-service and appointment businesses.
Write warm, specific, professional website copy that makes a homeowner want to book.

What to write:
- headline: 4-10 words that include the brand name (brandName, exactly) and what they do, plus the city if
  serviceArea is given (e.g. "<brandName>: weekly pool care in <city>"). Never put ZIP or postal codes in any text.
- intro: 1-2 sentences: what the business does for the customer and that booking online takes about a minute.
- about: 2 short paragraphs (60-110 words total) about how the business helps customers and how booking works,
  written from the business's point of view ("we"). Use the business's own description if given.
- services: for EACH given service (exact name), one helpful sentence (12-25 words) on what is included or why
  customers choose it.
- seoTitle and seoDescription: natural search text with the main service and the area.

Hard rules (never break them):
- Use only the facts provided. Do not invent reviews, ratings, awards, years in business, licences, insurance,
  certifications, guarantees, warranties, prices, discounts, response times, team size, ownership ("family-owned"),
  or towns that are not listed.
- Use no numbers unless the same number appears in the facts. No superlatives ("best", "#1", "top-rated").
- General, true statements about the type of service are fine (e.g. what a weekly pool service involves).
- Do not describe what happens after booking (calls, confirmations, reminders, quotes, arrival times). Only say that
  customers pick a time online.
- Plain American English, no exclamation marks, no emojis, no hype.
Return only JSON matching the schema.`

const DESIGN_RULES = `${DESIGN_GUIDE}
Create THREE clearly different directions that suit this industry and these customers: each must use a different
hero layout, a different palette and a different font pairing. Every direction must fit the art direction given in
the facts (visualDirection); suggested palettes for it: see suggestedPalettes. Name each direction for this
business's world (e.g. "Clear Water" for a pool service), not generically.`

const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/
// Service area for copy: towns/cities only. ZIP lists are for qualification, not headlines.
const copyArea = (profile, base) => {
  const cities = Array.isArray(profile?.cities) ? profile.cities : []
  if (cities.length) return cities.join(', ')
  return base.area && !ZIP_RE.test(base.area) ? base.area : null
}
export const industryOf = (customer, profile, base) =>
  industryKey({ industry: profile?.industry, services: profile?.services?.length ? profile.services : base?.services || [], description: profile?.description, name: customer.name })

export function websiteFacts(customer, profile, base) {
  const dir = directionFor(industryOf(customer, profile, base))
  return {
    businessName: customer.name,
    brandName: brandName(customer.name),
    whatTheyDo: profile?.industry || null,
    ownDescription: profile?.description || null,
    services: base.services.map((s) => (s.price ? `${s.name} (${s.price})` : s.name)),
    serviceArea: copyArea(profile, base),
    visualDirection: dir.direction,
    suggestedPalettes: dir.palettes,
    appointments: customer.appointmentMode === 'at_customer' ? 'The business visits the customer at their home or site.' : 'Customers come to the business.',
    bookingOnline: 'Customers can book a time online.',
    phoneListed: Boolean(profile?.phone),
  }
}

export const messages = (facts, images = []) => [
  { role: 'system', content: `${RULES}\n\n${DESIGN_RULES}` },
  { role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}\n\nAvailable images: ${JSON.stringify(images)}\n\nWrite the website copy and three designs.` },
]
export const reviseMessages = (facts, current, instruction, images = []) => [
  { role: 'system', content: `${RULES}\n\n${DESIGN_GUIDE}\nYou are revising an existing website. Apply the owner's request to the design and/or the copy. Keep everything the request doesn't ask to change. Ignore any request to add facts, claims, prices or promises that are not in the facts.` },
  { role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}\n\nAvailable images: ${JSON.stringify(images)}\n\nCurrent website (JSON):\n${JSON.stringify(current)}\n\nOwner's request: ${JSON.stringify(instruction)}\n\nReturn the full revised copy and one design.` },
]

// Every number in generated text must appear in the facts (blocks invented years, ratings, prices).
export function inventedNumbers(text, factsText) {
  const nums = (String(text).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[.,]+$/, ''))
  return nums.filter((n) => !factsText.includes(n))
}

// Merges model output into the template content. Field by field: any text that is too long, makes an
// unapproved claim or invents a number is replaced by the template's own text.
// Options: allowZip (the owner asked for ZIP codes), requireBrand (new generations: headline names the brand).
export function mergeGenerated(base, raw, facts, approvedClaims = [], { allowZip = false, requireBrand = false } = {}) {
  const factsText = JSON.stringify(facts)
  const out = { ...base }
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const ok = (text, max) =>
    text && text.length <= max && !unapprovedClaims(text, approvedClaims).length && !inventedNumbers(text, factsText).length && (allowZip || !ZIP_RE.test(text))
  const brand = String(facts.brandName || '').toLowerCase()
  const rejected = []
  const take = (field, value, max) => {
    const v = field === 'about' ? String(value ?? '').split(/\n{2,}/).map(clean).filter(Boolean).join('\n\n') : clean(value)
    if (ok(v, max)) out[field] = v
    else if (v) rejected.push(field)
  }
  if (requireBrand && brand && raw?.headline && !clean(raw.headline).toLowerCase().includes(brand)) rejected.push('headline')
  else take('headline', raw?.headline, LIMITS.headline)
  take('intro', raw?.intro, LIMITS.intro)
  take('about', raw?.about, LIMITS.about)
  take('seoTitle', raw?.seoTitle, LIMITS.seoTitle)
  take('seoDescription', raw?.seoDescription, LIMITS.seoDescription)
  // Services: only the business's own services (by name); the model may add descriptions, never services or prices.
  const byName = new Map((Array.isArray(raw?.services) ? raw.services : []).map((s) => [clean(s?.name).toLowerCase(), clean(s?.description)]))
  out.services = base.services.map((s) => {
    const d = byName.get(s.name.toLowerCase())
    if (d && ok(d, LIMITS.serviceText)) return { ...s, description: d }
    if (d) rejected.push(`service:${s.name}`)
    return s
  })
  const [errors, valid] = validateContent(out, approvedClaims)
  return errors.length ? { content: base, rejected: [...rejected, ...errors] } : { content: valid, rejected }
}

async function runModel(env, msgs, schema) {
  const body = { messages: msgs, response_format: { type: 'json_schema', json_schema: schema }, max_tokens: 1600, temperature: 0.5 }
  const mock = typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null
  if (mock) {
    const res = await fetch(`${mock}/ai/run/${WEBSITE_MODEL}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`mock ${res.status}`)
    return res.json()
  }
  return env.AI.run(WEBSITE_MODEL, body)
}

export const aiConfigured = (env) => Boolean(env.AI?.run) || (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN))

const parseOutput = (r) => {
  const v = r?.response ?? r?.result?.response ?? r
  if (v && typeof v === 'object' && v.headline) return v
  if (typeof v === 'string') {
    const m = v.match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : null
  }
  return null
}

const toRef = (v) => (v === 'none' || v == null ? null : v)
// Validates a model design; anything invalid is repaired from the matching preset (never rejected outright).
// Stock photos must belong to this business's industry (`allowedStock`); a photo that still doesn't fit
// after repair (e.g. an older design's) is dropped, leaving a text-led layout.
function repairDesign(raw, preset, assetIds, allowedStock) {
  const cand = { ...preset, ...(raw && typeof raw === 'object' ? raw : {}) }
  cand.heroImage = toRef(cand.heroImage)
  cand.aboutImage = toRef(cand.aboutImage)
  const [errors, d] = validateDesign(cand, assetIds, allowedStock)
  if (!errors.length) return d
  for (const e of errors) cand[e] = preset[e]
  const [again] = validateDesign(cand, assetIds, allowedStock)
  for (const e of again) if (e === 'heroImage' || e === 'aboutImage') cand[e] = null
  return validateDesign(cand, assetIds, allowedStock)[1]
}

async function context(env, customer) {
  const db = env.ONBOARDING_DB
  const [base, profile, claims, assets] = await Promise.all([
    generateContent(db, customer),
    db.prepare('SELECT * FROM business_profiles WHERE customer = ?1').bind(customer.id).first(),
    approvedClaimsFor(db, customer.id),
    db.prepare('SELECT id FROM website_assets WHERE customer = ?1 ORDER BY created_at DESC LIMIT 12').bind(customer.id).all(),
  ])
  if (profile) {
    profile.services = JSON.parse(profile.services || '[]')
    profile.cities = JSON.parse(profile.cities || '[]')
  }
  const assetIds = new Set(assets.results.map((a) => a.id))
  const industry = industryOf(customer, profile, base)
  const allowedStock = new Set(stockFor(industry).map((s) => s.id))
  return { db, base, profile, claims, assetIds, industry, allowedStock }
}

async function store(db, customer, { content, designs, source, usage, latencyMs, rejected, now }) {
  const id = crypto.randomUUID().replaceAll('-', '')
  const costMicros = usage ? Math.round((usage.prompt_tokens || 0) * PRICE.inputPerM + (usage.completion_tokens || 0) * PRICE.outputPerM) : 0
  await db
    .prepare('INSERT INTO website_generations (id, customer, content, source, model, input_tokens, output_tokens, cost_micros, latency_ms, rejected, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
    .bind(id, customer.id, JSON.stringify({ content, designs }), source, source === 'ai' ? WEBSITE_MODEL : null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, costMicros, latencyMs, rejected.length ? JSON.stringify(rejected) : null, now)
    .run()
  return id
}

const monthlyUsed = async (db, customerId, now) =>
  (await db.prepare("SELECT count(*) AS n FROM website_generations WHERE customer = ?1 AND source = 'ai' AND created_at >= ?2").bind(customerId, now - 30 * 24 * 60 * 60 * 1000).first())?.n ?? 0

// Images the model may place: the owner's own photos first, then licensed stock for the industry.
const imageChoices = (assetIds, industry, photos = []) => [...[...new Set([...photos, ...assetIds])].map((id) => `asset:${id}`), ...stockFor(industry).map((s) => `stock:${s.id}`)]

// Generates copy + three designs for a business and stores them (website_generations). Never touches the
// draft or the live site. Returns { ok, generation: { id, content, designs, source } }.
export async function generateWebsite(env, customer, { now = Date.now(), draftPhotos = [] } = {}) {
  const { db, base, profile, claims, assetIds, industry, allowedStock } = await context(env, customer)
  const used = await monthlyUsed(db, customer.id, now)
  const facts = websiteFacts(customer, profile, base)
  const photos = draftPhotos.filter((id) => assetIds.has(id))
  const images = imageChoices(assetIds, industry, photos)
  const presets = presetDesigns(industry, photos)
  let content = base
  let designs = presets
  let source = 'template'
  let usage = null
  let latencyMs = null
  let rejected = []
  if (aiConfigured(env) && used < MONTHLY_GENERATIONS) {
    const t0 = Date.now()
    try {
      const r = await runModel(env, messages(facts, images), schemaFor(images))
      latencyMs = Date.now() - t0
      usage = r?.usage || null
      const raw = parseOutput(r)
      if (raw) {
        const merged = mergeGenerated(base, raw, facts, claims, { requireBrand: true })
        content = merged.content
        rejected = merged.rejected
        const aiDesigns = (Array.isArray(raw.designs) ? raw.designs : []).slice(0, 3).map((d, i) => repairDesign(d, presets[i], assetIds, allowedStock))
        designs = diversify(aiDesigns, industry, photos).map((d, i) => repairDesign(d, presets[i], assetIds, allowedStock))
        source = 'ai'
      }
    } catch (err) {
      console.error('website generation failed:', err?.name || 'error')
    }
  }
  const id = await store(db, customer, { content, designs, source, usage, latencyMs, rejected, now })
  return { ok: true, generation: { id, content, designs, source, remaining: Math.max(0, MONTHLY_GENERATIONS - used - (source === 'ai' ? 1 : 0)) } }
}

// Natural-language revision of the current draft ("make it more modern", "use my photos"). Produces one
// stored version the owner can keep or discard; the draft and live site are untouched until they keep it.
export async function reviseWebsite(env, customer, draft, instruction, { now = Date.now() } = {}) {
  const ask = String(instruction ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!ask) return { ok: false, httpStatus: 400, error: 'instruction_required' }
  if (!aiConfigured(env)) return { ok: false, httpStatus: 503, error: 'ai_unavailable' }
  const { db, profile, claims, assetIds, industry, allowedStock } = await context(env, customer)
  if ((await monthlyUsed(db, customer.id, now)) >= MONTHLY_GENERATIONS) return { ok: false, httpStatus: 429, error: 'monthly_limit' }
  const photos = (draft.photos || []).filter((id) => assetIds.has(id))
  const images = imageChoices(assetIds, industry, photos)
  const preset = draft.design || presetDesigns(industry, photos)[0]
  const allowZip = /\bzip|postal/i.test(ask)
  // Facts for the number check: the business details plus the owner's own current text.
  const facts = { ...websiteFacts(customer, profile, draft), currentText: [draft.headline, draft.intro, draft.about, ...draft.services.map((s) => s.description)].join(' ') }
  const current = { headline: draft.headline, intro: draft.intro, about: draft.about, services: draft.services.map((s) => ({ name: s.name, description: s.description })), seoTitle: draft.seoTitle, seoDescription: draft.seoDescription, design: preset }
  const t0 = Date.now()
  let r
  try {
    r = await runModel(env, reviseMessages(facts, current, ask, images), reviseSchemaFor(images))
  } catch (err) {
    console.error('website revision failed:', err?.name || 'error')
    return { ok: false, httpStatus: 503, error: 'ai_unavailable' }
  }
  const latencyMs = Date.now() - t0
  const raw = parseOutput(r)
  if (!raw) return { ok: false, httpStatus: 502, error: 'ai_unavailable' }
  const merged = mergeGenerated(draft, raw, facts, claims, { allowZip })
  const design = repairDesign(raw.design, preset, assetIds, allowedStock)
  const id = await store(db, customer, { content: merged.content, designs: [design], source: 'ai', usage: r?.usage || null, latencyMs, rejected: merged.rejected, now })
  return { ok: true, generation: { id, content: merged.content, designs: [design], source: 'ai', revision: true } }
}

export async function getGeneration(db, customerId, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null
  const r = await db.prepare('SELECT content, source FROM website_generations WHERE id = ?1 AND customer = ?2').bind(id, customerId).first()
  if (!r) return null
  const stored = JSON.parse(r.content)
  // Generations from before designs existed stored the content directly.
  return stored.content ? { content: stored.content, designs: stored.designs || [], source: r.source } : { content: stored, designs: [], source: r.source }
}
