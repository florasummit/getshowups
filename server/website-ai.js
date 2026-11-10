// AI website copy: one structured model request turns the business's own details into polished,
// industry-specific website text. The model only writes prose (headline, intro, about, service
// descriptions, search text). Facts (name, services, prices, area, phone) always come from the
// business's records, and every generated sentence passes the claims filter plus a number check
// (no invented years, ratings, prices or counts). Anything that fails falls back to the template text.
// Provider: Cloudflare Workers AI (binding `AI`). Without it, the deterministic template is used.
import { generateContent, validateContent, LIMITS } from './website.js'
import { approvedClaimsFor } from './landing.js'
import { unapprovedClaims } from './ads/spec.js'

export const WEBSITE_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
// USD per million tokens (Workers AI list price for WEBSITE_MODEL).
export const PRICE = { inputPerM: 0.351, outputPerM: 0.555 }
export const MONTHLY_GENERATIONS = 20

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/

export const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Website headline, under 70 characters' },
    intro: { type: 'string', description: 'One or two sentences under the headline, under 300 characters' },
    about: { type: 'string', description: 'Two short paragraphs about the business, under 700 characters' },
    services: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string', description: 'One sentence, under 200 characters' } }, required: ['name', 'description'] },
    },
    seoTitle: { type: 'string', description: 'Search result title, under 65 characters' },
    seoDescription: { type: 'string', description: 'Search result description, under 155 characters' },
  },
  required: ['headline', 'intro', 'about', 'services', 'seoTitle', 'seoDescription'],
}

const RULES = `You are an experienced copywriter for local home-service and appointment businesses.
Write warm, specific, professional website copy that makes a homeowner want to book.

What to write:
- headline: a clear benefit plus what they do and where (if an area is given), 4-9 words. Not just the business name.
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

export function websiteFacts(customer, profile, base) {
  return {
    businessName: customer.name,
    whatTheyDo: profile?.industry || null,
    ownDescription: profile?.description || null,
    services: base.services.map((s) => (s.price ? `${s.name} (${s.price})` : s.name)),
    serviceArea: base.area || null,
    appointments: customer.appointmentMode === 'at_customer' ? 'The business visits the customer at their home or site.' : 'Customers come to the business.',
    bookingOnline: 'Customers can book a time online.',
    phoneListed: Boolean(profile?.phone),
  }
}

export const messages = (facts) => [
  { role: 'system', content: RULES },
  { role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}\n\nWrite the website copy.` },
]

// Every number in generated text must appear in the facts (blocks invented years, ratings, prices).
export function inventedNumbers(text, factsText) {
  const nums = (String(text).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[.,]+$/, ''))
  return nums.filter((n) => !factsText.includes(n))
}

// Merges model output into the template content. Field by field: any text that is too long, makes an
// unapproved claim or invents a number is replaced by the template's own text.
export function mergeGenerated(base, raw, facts, approvedClaims = []) {
  const factsText = JSON.stringify(facts)
  const out = { ...base }
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const ok = (text, max) => text && text.length <= max && !unapprovedClaims(text, approvedClaims).length && !inventedNumbers(text, factsText).length
  const rejected = []
  const take = (field, value, max) => {
    const v = field === 'about' ? String(value ?? '').split(/\n{2,}/).map(clean).filter(Boolean).join('\n\n') : clean(value)
    if (ok(v, max)) out[field] = v
    else if (v) rejected.push(field)
  }
  take('headline', raw?.headline, LIMITS.headline)
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

async function runModel(env, msgs) {
  const body = { messages: msgs, response_format: { type: 'json_schema', json_schema: SCHEMA }, max_tokens: 1200, temperature: 0.4 }
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

// Generates website content for a business and stores it (website_generations). Never touches the
// draft or the live site. Returns { ok, generation: { id, content, source } } or a failure code.
export async function generateWebsite(env, customer, { now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const month = now - 30 * 24 * 60 * 60 * 1000
  const used = await db.prepare("SELECT count(*) AS n FROM website_generations WHERE customer = ?1 AND source = 'ai' AND created_at >= ?2").bind(customer.id, month).first()
  const [base, profile, claims] = await Promise.all([
    generateContent(db, customer),
    db.prepare('SELECT * FROM business_profiles WHERE customer = ?1').bind(customer.id).first(),
    approvedClaimsFor(db, customer.id),
  ])
  if (profile) profile.services = JSON.parse(profile.services || '[]')
  const facts = websiteFacts(customer, profile, base)
  let content = base
  let source = 'template'
  let usage = null
  let latencyMs = null
  let rejected = []
  if (aiConfigured(env) && (used?.n ?? 0) < MONTHLY_GENERATIONS) {
    const t0 = Date.now()
    try {
      const r = await runModel(env, messages(facts))
      latencyMs = Date.now() - t0
      usage = r?.usage || null
      const raw = parseOutput(r)
      if (raw) {
        const merged = mergeGenerated(base, raw, facts, claims)
        content = merged.content
        rejected = merged.rejected
        source = 'ai'
      }
    } catch (err) {
      console.error('website generation failed:', err?.name || 'error')
    }
  }
  const id = crypto.randomUUID().replaceAll('-', '')
  const costMicros = usage ? Math.round((usage.prompt_tokens || 0) * PRICE.inputPerM + (usage.completion_tokens || 0) * PRICE.outputPerM) : 0
  await db
    .prepare('INSERT INTO website_generations (id, customer, content, source, model, input_tokens, output_tokens, cost_micros, latency_ms, rejected, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
    .bind(id, customer.id, JSON.stringify(content), source, source === 'ai' ? WEBSITE_MODEL : null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, costMicros, latencyMs, rejected.length ? JSON.stringify(rejected) : null, now)
    .run()
  return { ok: true, generation: { id, content, source, remaining: Math.max(0, MONTHLY_GENERATIONS - (used?.n ?? 0) - (source === 'ai' ? 1 : 0)) } }
}

export async function getGeneration(db, customerId, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null
  const r = await db.prepare('SELECT content, source FROM website_generations WHERE id = ?1 AND customer = ?2').bind(id, customerId).first()
  return r && { content: JSON.parse(r.content), source: r.source }
}
