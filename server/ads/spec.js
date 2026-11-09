// Campaign specification: the only shape that ever reaches an ad platform adapter. AI output and
// owner edits are both validated here; adapters never receive free-form model output.
//
//   {
//     version: 1,
//     platform: 'google' | 'meta',
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
//                formQuestions: ('FULL_NAME'|'PHONE'|'EMAIL'|'ZIP')[] }
//   }
//
// Text limits: Google responsive search ads use 30-character headlines (3–15), 90-character descriptions
// (2–4) and 15-character display paths (Google Ads ad specs). Meta limits are kept conservative.

export const LIMITS = {
  google: { headline: 30, headlinesMin: 3, headlinesMax: 15, description: 90, descriptionsMin: 2, descriptionsMax: 4, path: 15, keywords: 50, negatives: 100 },
  meta: { primaryText: 500, headline: 40, description: 60, textsMax: 5 },
  zips: 200,
  minDailyBudgetCents: 500, // $5/day: below this platforms rarely deliver
}

const CTA = ['GET_QUOTE', 'BOOK_NOW', 'LEARN_MORE', 'CONTACT_US']
const FORM_FIELDS = ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP']
const ZIP_RE = /^\d{5}$/

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
  if (!['google', 'meta'].includes(platform)) return [['platform: must be google or meta'], null]

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
    spec.meta = {
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
