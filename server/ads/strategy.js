// AI campaign strategy: turns a business's ad profile into editable draft campaign specs plus
// creative concepts. Claude (claude-opus-5-5, structured JSON output) writes the plan; every text is
// then filtered through spec limits and the unapproved-claims check, so model output never reaches an
// ad platform unvalidated. Without ANTHROPIC_API_KEY a clearly labelled template draft is produced.
import Anthropic from '@anthropic-ai/sdk'
import { LIMITS, unapprovedClaims } from './spec.js'
import { recordTextUsage } from './creative.js'

export const STRATEGY_MODEL = 'claude-opus-5-5'
const PRICE = { inputPerM: 4, outputPerM: 20 } // USD per million tokens (claude-opus-5-5)

const textList = (n, len) => ({ type: 'array', items: { type: 'string', maxLength: len }, minItems: 1, maxItems: n })
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recommendedChannels', 'rationale', 'google', 'meta', 'imageConcepts', 'videoConcepts', 'tracking', 'landing'],
  properties: {
    recommendedChannels: { type: 'array', items: { type: 'string', enum: ['google', 'meta'] }, minItems: 1, maxItems: 2 },
    googleBudgetShare: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', maxLength: 600 },
    google: {
      type: 'object',
      additionalProperties: false,
      required: ['keywords', 'negativeKeywords', 'headlines', 'descriptions'],
      properties: {
        keywords: {
          type: 'array',
          maxItems: 30,
          items: { type: 'object', additionalProperties: false, required: ['text', 'match'], properties: { text: { type: 'string', maxLength: 80 }, match: { type: 'string', enum: ['PHRASE', 'EXACT'] } } },
        },
        negativeKeywords: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40 },
        headlines: textList(15, 40),
        descriptions: textList(4, 100),
        path1: { type: 'string', maxLength: 15 },
        path2: { type: 'string', maxLength: 15 },
      },
    },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['primaryTexts', 'headlines', 'callToAction'],
      properties: {
        primaryTexts: textList(3, 500),
        headlines: textList(3, 50),
        description: { type: 'string', maxLength: 80 },
        callToAction: { type: 'string', enum: ['GET_QUOTE', 'BOOK_NOW', 'LEARN_MORE', 'CONTACT_US'] },
      },
    },
    imageConcepts: textList(3, 400),
    videoConcepts: textList(2, 400),
    tracking: textList(5, 200),
    landing: { type: 'string', maxLength: 300 },
  },
}

const SYSTEM = `You plan local lead-generation ads for small home-service businesses. Produce a practical first campaign plan.

Hard rules:
- Use only facts given in the business profile. Never invent reviews, ratings, awards, licenses, insurance, guarantees, discounts, prices, response times, years in business, or before/after results. A claim of that kind may appear only if it is listed under "Approved claims", worded as listed.
- Google responsive search ads: headlines at most 30 characters (aim for 10–15 distinct ones), descriptions at most 90 characters (2–4). Keywords are what local customers would search, PHRASE or EXACT match, no brand names of competitors. Add negative keywords for jobs, DIY, cheap/free, and services the business excludes.
- Meta lead ads: plain, friendly primary text, headlines at most 40 characters.
- Image and video concepts must be producible by an AI generator without depicting real customers, logos of other brands, or fabricated results.
- Recommend Google when people search for this service when they need it; add Meta for awareness-heavy or visual services. Explain briefly why.`

function profilePrompt(customer, profile) {
  return [
    `Business: ${customer.name}`,
    `Website: ${profile.website || 'none (use the GetShowUps booking page)'}`,
    `Industry: ${profile.industry}`,
    `Services: ${profile.services.join('; ')}`,
    `Service area ZIP codes: ${profile.serviceArea.zips.join(', ')}`,
    `Excluded work: ${profile.exclusions || 'none stated'}`,
    `Typical first-job value: ${profile.customerValueCents ? `$${Math.round(profile.customerValueCents / 100)}` : 'not stated'}`,
    `Objective: ${profile.objective}`,
    `Monthly ad budget: ${profile.monthlyBudgetCents ? `$${Math.round(profile.monthlyBudgetCents / 100)}` : 'not stated'}`,
    `Approved claims: ${profile.approvedClaims.length ? profile.approvedClaims.join('; ') : 'none'}`,
  ].join('\n')
}

const keepTexts = (list, len, claims) =>
  [...new Set((list || []).map((t) => String(t).replace(/\s+/g, ' ').trim()))].filter((t) => t && t.length <= len && unapprovedClaims(t, claims).length === 0)

// Filters a raw plan to what the platforms and our claim rules allow. Never throws.
export function sanitizePlan(raw, profile) {
  const claims = profile.approvedClaims
  const g = raw?.google || {}
  const m = raw?.meta || {}
  const excluded = String(profile.exclusions || '').toLowerCase()
  const plan = {
    recommendedChannels: [...new Set((raw?.recommendedChannels || []).filter((c) => c === 'google' || c === 'meta'))],
    googleBudgetShare: Number.isFinite(raw?.googleBudgetShare) ? Math.min(1, Math.max(0, raw.googleBudgetShare)) : null,
    rationale: String(raw?.rationale || '').slice(0, 600),
    google: {
      keywords: (g.keywords || [])
        .map((k) => ({ text: String(k?.text || '').toLowerCase().replace(/[^a-z0-9 '&.-]/g, '').trim(), match: k?.match === 'EXACT' ? 'EXACT' : 'PHRASE' }))
        .filter((k) => k.text && k.text.length <= 80 && !(excluded && excluded.includes(k.text)))
        .filter((k, i, all) => all.findIndex((x) => x.text === k.text && x.match === k.match) === i)
        .slice(0, LIMITS.google.keywords),
      // The owner's exclusions are always negatives, whatever the planner suggested.
      negativeKeywords: [...new Set([...(g.negativeKeywords || []), ...exclusionTerms(profile)].map((n) => String(n).toLowerCase().trim()))].filter(Boolean).slice(0, LIMITS.google.negatives),
      headlines: keepTexts(g.headlines, LIMITS.google.headline, claims).slice(0, LIMITS.google.headlinesMax),
      descriptions: keepTexts(g.descriptions, LIMITS.google.description, claims).slice(0, LIMITS.google.descriptionsMax),
      ...(/^[A-Za-z0-9-]{1,15}$/.test(g.path1 || '') ? { path1: g.path1 } : {}),
      ...(/^[A-Za-z0-9-]{1,15}$/.test(g.path2 || '') && g.path1 ? { path2: g.path2 } : {}),
    },
    meta: {
      primaryTexts: keepTexts(m.primaryTexts, LIMITS.meta.primaryText, claims).slice(0, 3),
      headlines: keepTexts(m.headlines, LIMITS.meta.headline, claims).slice(0, 3),
      ...(m.description && keepTexts([m.description], LIMITS.meta.description, claims).length ? { description: m.description.trim() } : {}),
      callToAction: ['GET_QUOTE', 'BOOK_NOW', 'LEARN_MORE', 'CONTACT_US'].includes(m.callToAction) ? m.callToAction : 'GET_QUOTE',
    },
    imageConcepts: keepTexts(raw?.imageConcepts, 400, claims).slice(0, 3),
    videoConcepts: keepTexts(raw?.videoConcepts, 400, claims).slice(0, 2),
    tracking: (raw?.tracking || []).map((t) => String(t).slice(0, 200)).slice(0, 5),
    landing: String(raw?.landing || '').slice(0, 300),
  }
  if (!plan.recommendedChannels.length) plan.recommendedChannels = ['google']
  return plan
}

// Services as separate items. Profiles saved before comma-splitting may hold "A, B, C" as one service; that is
// split here (the stored profile is not rewritten).
export const serviceList = (profile) =>
  [...new Set((profile?.services || []).flatMap((x) => String(x ?? '').split(/[,\n;]+/)).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))]

// Towns typed as "Charleston, Mount Pleasant" are separate places (older profiles were saved as one string).
export const cityList = (profile) =>
  [...new Set((profile?.serviceArea?.cities || []).flatMap((x) => String(x ?? '').split(/[,\n;]+/)).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))]

// The owner's "work you don't want" becomes negative keywords (as typed, lowercased, keyword-safe characters).
export const exclusionTerms = (profile) =>
  [...new Set(String(profile?.exclusions || '').split(/[,\n;]+/).map((x) => x.toLowerCase().replace(/[^a-z0-9 '&.-]/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 3 && x.length <= 80))]

// Fits ad text into `max` characters without cutting a word in half: too-long text is shortened at a word
// boundary and loses a dangling connector or punctuation ("Pool repair and" → "Pool repair"). Returns null
// when nothing meaningful is left (e.g. one very long word).
const DANGLING = /(?:[\s,;:.\-–—/&+|]+|\s+(?:and|or|of|for|the|a|an|to|in|with|at|by|from|our|your))$/i
export function fitText(text, max) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length <= max) return t
  t = t.slice(0, max + 1)
  // A list ("A, B, C") is cut after the last whole item; other text at the last whole word.
  const comma = t.lastIndexOf(',')
  t = comma >= 3 ? t.slice(0, comma) : t.includes(' ') ? t.slice(0, t.lastIndexOf(' ')) : ''
  for (let before = null; before !== t; ) {
    before = t
    t = t.replace(DANGLING, '').trim()
  }
  return t.length >= 3 ? t : null
}
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1)
const uniqueFit = (list, max, limit) => {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const t = fitText(raw, max)
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  return out.slice(0, limit)
}

// Deterministic starter plan (no AI): honest, generic, and editable.
export function templatePlan(customer, profile) {
  const services = serviceList(profile)
  const service = (services[0] || profile.industry || 'service').toLowerCase()
  const cities = cityList(profile)
  const city = cities[0] || ''
  const near = city.toLowerCase()
  // High-intent searches: each service in the main town and "near me", the trade in town, the main service in a second town.
  const terms = (services.length ? services : [service]).slice(0, 5).map((x) => x.toLowerCase())
  const keywords = [
    ...terms.flatMap((t) => [...(near ? [`${t} ${near}`] : []), `${t} near me`]),
    ...(near && profile.industry ? [`${profile.industry.toLowerCase()} ${near}`] : []),
    ...(cities[1] ? [`${terms[0]} ${cities[1].toLowerCase()}`] : []),
  ]
  return sanitizePlan(
    {
      recommendedChannels: ['google'],
      googleBudgetShare: 1,
      rationale: 'Starter draft without AI: people search for this service when they need it, so search ads come first. Edit before approving.',
      google: {
        keywords: keywords.map((text) => ({ text, match: 'PHRASE' })),
        negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap'],
        // Whole words only: the business name, up to three services, then generic booking lines.
        headlines: uniqueFit(
          [customer.name, ...services.slice(0, 3).map(capitalize), ...(city ? [`Serving ${city}`] : []), 'Book Online in Minutes', 'Pick a Time That Works', 'Local, Friendly Service'],
          LIMITS.google.headline,
          LIMITS.google.headlinesMax,
        ),
        descriptions: [
          `${customer.name} serves your area. Pick a time online and get booked.`.length <= LIMITS.google.description
            ? `${customer.name} serves your area. Pick a time online and get booked.`
            : 'We serve your area. Pick a time online and get booked.',
          'Tell us what you need and choose an appointment that fits your schedule.',
        ],
      },
      meta: {
        primaryTexts: [`Need ${service}? ${customer.name} serves your area. Request a time in under a minute.`],
        headlines: ['Book a visit online'],
        callToAction: 'GET_QUOTE',
      },
      imageConcepts: [`A clean, bright photo-style image representing ${service} at a residential home, no people's faces, no text.`],
      videoConcepts: [`A slow 10-second pan across a well-kept home exterior related to ${service}, calm and natural.`],
      tracking: ['Count a lead when the booking form is submitted', 'Count a booking when an appointment is confirmed'],
      landing: 'Send ad clicks to the GetShowUps booking page so every lead is captured and can book immediately.',
    },
    profile,
  )
}

// Calls Claude for a plan. `client` is injectable for tests. Returns { ok, plan, source, costCents } or failure.
export async function generatePlan(env, customer, profile, { client, now = Date.now() } = {}) {
  if (!env.ANTHROPIC_API_KEY && !client) return { ok: true, plan: templatePlan(customer, profile), source: 'template', costCents: 0 }
  const reserved = await recordTextUsage(env, customer.id, 15, now) // reserve ~15¢; adjusted below
  if (!reserved.ok) return reserved
  const anthropic = client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120000 })
  let response
  try {
    response = await anthropic.beta.messages.create({
      model: STRATEGY_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: profilePrompt(customer, profile) }],
    })
  } catch (err) {
    await env.ONBOARDING_DB.prepare('DELETE FROM ai_usage WHERE id = ?1').bind(reserved.usageId).run()
    const status = err?.status
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'ai_rate_limited', retryable: true }
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'ai_not_configured' }
    if (err instanceof Anthropic.APIError && status >= 500) return { ok: false, error: 'ai_unavailable', retryable: true }
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: 'ai_unavailable', retryable: true }
    console.error('strategy: AI request failed:', status ?? err?.name)
    return { ok: false, error: 'ai_error' }
  }
  const costCents = Math.max(1, Math.ceil(((response.usage?.input_tokens ?? 0) * PRICE.inputPerM + (response.usage?.output_tokens ?? 0) * PRICE.outputPerM) / 1e6 * 100))
  await env.ONBOARDING_DB.prepare('UPDATE ai_usage SET cost_cents = ?2 WHERE id = ?1').bind(reserved.usageId, costCents).run()
  if (response.stop_reason === 'refusal') return { ok: false, error: 'ai_declined' }
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'ai_invalid_output' }
  }
  return { ok: true, plan: sanitizePlan(raw, profile), source: 'ai', costCents }
}

// Turns a plan into draft specs (unvalidated drafts; strict validation happens at approval).
export function draftSpecs(customer, profile, plan, { dailyCeilingCents, bookingUrl }) {
  const channels = plan.recommendedChannels
  const share = channels.length === 2 ? (plan.googleBudgetShare ?? 0.6) : 1
  const total = Math.max(0, dailyCeilingCents)
  const daily = { google: Math.floor(total * (channels.includes('meta') ? share : 1)), meta: Math.floor(total * (channels.includes('google') ? 1 - share : 1)) }
  const url = (platform, id) => `${bookingUrl}?utm_source=${platform}&utm_medium=paid&utm_campaign=${id}`
  return channels.map((platform) => ({
    platform,
    url: (id) => url(platform, id),
    spec: {
      version: 1,
      platform,
      name: `${customer.name} — ${platform === 'google' ? 'Search' : 'Lead ads'}`,
      dailyBudgetCents: daily[platform],
      geo: { zips: profile.serviceArea.zips },
      ...(platform === 'google'
        ? { google: plan.google }
        : { meta: { ...plan.meta, destination: 'instant_form', imageCreativeIds: [], videoCreativeIds: [], formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'] } }),
    },
  }))
}
