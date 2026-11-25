// Campaign specification: the only shape that ever reaches an ad platform adapter. AI output and
// owner edits are both validated here; adapters never receive free-form model output.
//
//   {
//     version: 1,
//     platform: 'google' | 'meta' | 'openai',
//     name: string,
//     dailyBudgetCents: integer,
//     geo: { zips: string[], radiusMiles?: number },
//     finalUrl: https URL (Google) | omitted when Meta uses an instant form,
//     google?: { keywords: [{ text, match: 'PHRASE'|'EXACT' }], negativeKeywords: string[],
//                headlines: string[3..15] (≤30 chars), descriptions: string[2..4] (≤90 chars),
//                path1?: ≤15, path2?: ≤15 },
//     meta?:   { primaryTexts: string[1..5] (≤500), headlines: string[1..5] (≤40), description?: ≤60,
//                callToAction: 'GET_QUOTE'|'BOOK_NOW'|'LEARN_MORE'|'CONTACT_US',
//                imageCreativeIds: string[], videoCreativeIds: string[], destination: 'instant_form'|'website',
//                formQuestions: ('FULL_NAME'|'PHONE'|'EMAIL'|'ZIP')[],
//                placements?: ('facebook'|'instagram')[] (omitted = Meta's automatic placements),
//                audience?: { ageMin: 18..65, ageMax?: ageMin..65 } (omitted = 18+),
//                endDate?: 'YYYY-MM-DD' (the ad set's end time; the owner sees daily × days as the most it can spend) }
//     openai?: { title: 3–50, body: ≤100 (ChatGPT chat card), contextHints: string[0..10] (≤200),
//                locations: [{ id, name, type: 'market'|'region' }] 1..25 (OpenAI targets whole markets/regions only;
//                geo.zips stays the service area the booking page checks) } — server/ads/openai.js
//   }
//
// Text limits: Google responsive search ads use 30-character headlines (3–15), 90-character descriptions
// (2–4) and 15-character display paths (Google Ads ad specs). Meta limits are kept conservative.

export const LIMITS = {
  google: { headline: 30, headlinesMin: 3, headlinesMax: 15, description: 90, descriptionsMin: 2, descriptionsMax: 4, path: 15, keywords: 50, negatives: 100 },
  meta: { primaryText: 500, headline: 40, description: 60, textsMax: 5 },
  openai: { titleMin: 3, title: 50, body: 100, contextHints: 10, contextHint: 200, locations: 25 }, // OpenAI Ads API CreateAdCreativeParams / targeting
  zips: 200,
  minDailyBudgetCents: 500, // $5/day: below this platforms rarely deliver
}

const CTA = ['GET_QUOTE', 'BOOK_NOW', 'LEARN_MORE', 'CONTACT_US']
const FORM_FIELDS = ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP']
export const META_PLACEMENTS = ['facebook', 'instagram'] // Meta targeting publisher_platforms (Marketing API targeting spec)
const YMD = /^\d{4}-\d{2}-\d{2}$/
const ZIP_RE = /^\d{5}$/
export const PLATFORMS = ['google', 'meta', 'openai']
const LOCATION_ID = /^[A-Za-z0-9_-]{1,100}$/

// Claims the AI may not invent. A phrase is allowed only when the owner listed it in approvedClaims.
const RISKY = [
  [/\bguarantee[ds]?\b/i, 'guarantee'],
  [/\b\d{1,3}\s?%\s*off\b|\bdiscount\b|\bfree\b|\bcoupon\b|\bsave \$?\d/i, 'discount'],
  [/\b(licensed|insured|bonded|certified|accredited)\b/i, 'credential'],
  [/#1\b|\b(number one|best in|top[- ]rated|award[- ]winning)\b/i, 'superlative'],
  [/\b\d(\.\d)?\s?(stars?|★)|\breviews?\b|\btestimonial/i, 'reviews'],
  [/\bbefore (and|&) after\b/i, 'before_after'],
  [/\b(same[- ]day|24\/7|within \d+ (hours?|minutes?))\b/i, 'speed'],
]

// Returns the risky claim categories in `text` that the owner has not approved.
export function unapprovedClaims(text, approvedClaims = []) {
  const approved = approvedClaims.map((c) => String(c).toLowerCase())
  const found = []
  for (const [re, category] of RISKY) {
    const m = String(text).match(re)
    if (!m) continue
    const phrase = m[0].toLowerCase()
    if (!approved.some((a) => a.includes(phrase) || phrase.includes(a))) found.push(category)
  }
  return [...new Set(found)]
}

const isHttps = (u) => {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function checkTexts(list, { min, max, len, field }, errors, approvedClaims) {
  if (!Array.isArray(list) || list.length < min || list.length > max) errors.push(`${field}: need ${min}–${max}`)
  const seen = new Set()
  for (const [i, raw] of (list || []).entries()) {
    const t = clean(raw)
    if (!t) errors.push(`${field}[${i}]: empty`)
    if (t.length > len) errors.push(`${field}[${i}]: longer than ${len} characters`)
    if (seen.has(t.toLowerCase())) errors.push(`${field}[${i}]: duplicate`)
    seen.add(t.toLowerCase())
    for (const c of unapprovedClaims(t, approvedClaims)) errors.push(`${field}[${i}]: unapproved claim (${c})`)
  }
}

// Validates and normalizes a spec. `ceilingDailyCents` is the most this campaign may spend per day
// under the owner's approval (remaining approved budget). Returns [errors[], normalizedSpec].
export function validateSpec(input, { approvedClaims = [], ceilingDailyCents = Infinity } = {}) {
  const errors = []
  const s = input && typeof input === 'object' ? input : {}
  const platform = s.platform
  if (!PLATFORMS.includes(platform)) return [['platform: must be google, meta or openai'], null]

  const spec = { version: 1, platform, name: clean(s.name).slice(0, 120), dailyBudgetCents: s.dailyBudgetCents, geo: {} }
  if (!spec.name) errors.push('name: required')
  if (!Number.isInteger(spec.dailyBudgetCents) || spec.dailyBudgetCents < LIMITS.minDailyBudgetCents) {
    errors.push(`dailyBudgetCents: at least ${LIMITS.minDailyBudgetCents}`)
  } else if (spec.dailyBudgetCents > ceilingDailyCents) {
    errors.push('dailyBudgetCents: exceeds the approved budget')
  }

  const zips = [...new Set((s.geo?.zips || []).map((z) => clean(z).slice(0, 5)))]
  if (!zips.length || zips.length > LIMITS.zips || zips.some((z) => !ZIP_RE.test(z))) errors.push('geo.zips: 1–200 five-digit ZIP codes')
  spec.geo.zips = zips
  if (s.geo?.radiusMiles != null) {
    if (!(Number.isFinite(s.geo.radiusMiles) && s.geo.radiusMiles >= 1 && s.geo.radiusMiles <= 50)) errors.push('geo.radiusMiles: 1–50')
    else spec.geo.radiusMiles = s.geo.radiusMiles
  }

  if (platform === 'google') {
    const g = s.google || {}
    const L = LIMITS.google
    if (!isHttps(s.finalUrl)) errors.push('finalUrl: https URL required')
    spec.finalUrl = s.finalUrl
    const keywords = (g.keywords || []).map((k) => ({ text: clean(k?.text).toLowerCase(), match: k?.match }))
    if (!keywords.length || keywords.length > L.keywords) errors.push(`google.keywords: 1–${L.keywords}`)
    for (const [i, k] of keywords.entries()) {
      if (!k.text || k.text.length > 80 || !/^[a-z0-9 '&.-]+$/.test(k.text)) errors.push(`google.keywords[${i}]: invalid text`)
      if (!['PHRASE', 'EXACT'].includes(k.match)) errors.push(`google.keywords[${i}]: match must be PHRASE or EXACT`)
    }
    const negatives = [...new Set((g.negativeKeywords || []).map((n) => clean(n).toLowerCase()))].filter(Boolean)
    if (negatives.length > L.negatives) errors.push('google.negativeKeywords: too many')
    checkTexts(g.headlines, { min: L.headlinesMin, max: L.headlinesMax, len: L.headline, field: 'google.headlines' }, errors, approvedClaims)
    checkTexts(g.descriptions, { min: L.descriptionsMin, max: L.descriptionsMax, len: L.description, field: 'google.descriptions' }, errors, approvedClaims)
    for (const p of ['path1', 'path2']) {
      if (g[p] != null && !/^[A-Za-z0-9-]{1,15}$/.test(g[p])) errors.push(`google.${p}: 1–15 letters, digits or hyphens`)
    }
    if (g.path2 && !g.path1) errors.push('google.path2: requires path1')
    spec.google = {
      keywords,
      negativeKeywords: negatives,
      headlines: (g.headlines || []).map(clean),
      descriptions: (g.descriptions || []).map(clean),
      ...(g.path1 ? { path1: g.path1 } : {}),
      ...(g.path2 ? { path2: g.path2 } : {}),
    }
  } else if (platform === 'openai') {
    const o = s.openai || {}
    const L = LIMITS.openai
    if (!isHttps(s.finalUrl)) errors.push('finalUrl: https URL required')
    spec.finalUrl = s.finalUrl
    const title = clean(o.title)
    const body = clean(o.body)
    if (title.length < L.titleMin || title.length > L.title) errors.push(`openai.title: ${L.titleMin}–${L.title} characters`)
    if (!body || body.length > L.body) errors.push(`openai.body: 1–${L.body} characters`)
    for (const [field, t] of [['openai.title', title], ['openai.body', body]]) for (const c of unapprovedClaims(t, approvedClaims)) errors.push(`${field}: unapproved claim (${c})`)
    const hints = [...new Set((Array.isArray(o.contextHints) ? o.contextHints : []).map(clean).filter(Boolean))]
    if (hints.length > L.contextHints || hints.some((h) => h.length > L.contextHint)) errors.push(`openai.contextHints: up to ${L.contextHints}, each ≤${L.contextHint} characters`)
    for (const [i, h] of hints.entries()) for (const c of unapprovedClaims(h, approvedClaims)) errors.push(`openai.contextHints[${i}]: unapproved claim (${c})`)
    const seenLoc = new Set()
    const locations = (Array.isArray(o.locations) ? o.locations : [])
      .map((l) => ({ id: clean(l?.id), name: clean(l?.name).slice(0, 120), type: l?.type }))
      .filter((l) => !seenLoc.has(l.id) && seenLoc.add(l.id))
    if (!locations.length || locations.length > L.locations || locations.some((l) => !LOCATION_ID.test(l.id) || !['market', 'region'].includes(l.type))) errors.push(`openai.locations: 1–${L.locations} markets or regions`)
    spec.openai = { title, body, contextHints: hints, locations }
  } else {
    const m = s.meta || {}
    const L = LIMITS.meta
    checkTexts(m.primaryTexts, { min: 1, max: L.textsMax, len: L.primaryText, field: 'meta.primaryTexts' }, errors, approvedClaims)
    checkTexts(m.headlines, { min: 1, max: L.textsMax, len: L.headline, field: 'meta.headlines' }, errors, approvedClaims)
    if (m.description != null) checkTexts([m.description], { min: 1, max: 1, len: L.description, field: 'meta.description' }, errors, approvedClaims)
    if (!CTA.includes(m.callToAction)) errors.push(`meta.callToAction: one of ${CTA.join(', ')}`)
    if (!['instant_form', 'website'].includes(m.destination)) errors.push('meta.destination: instant_form or website')
    if (m.destination === 'website' && !isHttps(s.finalUrl)) errors.push('finalUrl: https URL required for website destination')
    const images = (m.imageCreativeIds || []).filter((x) => typeof x === 'string')
    const videos = (m.videoCreativeIds || []).filter((x) => typeof x === 'string')
    if (!images.length && !videos.length) errors.push('meta: at least one approved image or video')
    const fields = m.formQuestions || ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP']
    if (m.destination === 'instant_form' && (!fields.length || fields.some((f) => !FORM_FIELDS.includes(f)))) errors.push('meta.formQuestions: invalid')
    if (m.destination === 'website') spec.finalUrl = s.finalUrl
    // Placements: a subset of the supported platforms, deduplicated; omitted (or both) = automatic placements.
    const placements = Array.isArray(m.placements) ? [...new Set(m.placements)] : null
    if (placements && (!placements.length || placements.some((p) => !META_PLACEMENTS.includes(p)))) errors.push(`meta.placements: one or more of ${META_PLACEMENTS.join(', ')}`)
    // Audience: an age range inside Meta's 18–65 bounds.
    const aud = m.audience && typeof m.audience === 'object' ? m.audience : null
    const ageMin = aud?.ageMin == null ? null : Number(aud.ageMin)
    const ageMax = aud?.ageMax == null ? null : Number(aud.ageMax)
    if (ageMin != null && !(Number.isInteger(ageMin) && ageMin >= 18 && ageMin <= 65)) errors.push('meta.audience.ageMin: 18–65')
    if (ageMax != null && !(Number.isInteger(ageMax) && ageMax >= (ageMin ?? 18) && ageMax <= 65)) errors.push('meta.audience.ageMax: between the minimum age and 65')
    // End date: a calendar day; the owner's "most it can spend" is daily × days to that date.
    const endDate = m.endDate == null || m.endDate === '' ? null : String(m.endDate)
    if (endDate && (!YMD.test(endDate) || Number.isNaN(Date.parse(`${endDate}T00:00:00Z`))) ) errors.push('meta.endDate: YYYY-MM-DD')
    spec.meta = {
      ...(placements && placements.length && placements.length < META_PLACEMENTS.length ? { placements } : {}),
      ...(ageMin != null || ageMax != null ? { audience: { ...(ageMin != null ? { ageMin } : {}), ...(ageMax != null ? { ageMax } : {}) } } : {}),
      ...(endDate ? { endDate } : {}),
      primaryTexts: (m.primaryTexts || []).map(clean),
      headlines: (m.headlines || []).map(clean),
      ...(m.description != null ? { description: clean(m.description) } : {}),
      callToAction: m.callToAction,
      destination: m.destination,
      imageCreativeIds: images,
      videoCreativeIds: videos,
      ...(m.destination === 'instant_form' ? { formQuestions: fields } : {}),
    }
  }
  return [errors, errors.length ? null : spec]
}

// The approved monthly ceiling expressed per day (30.4-day month), the hard cap for all active
// campaigns of a business combined.
export const dailyCeilingCents = (monthlyCents) => Math.floor(monthlyCents / 30.4)
