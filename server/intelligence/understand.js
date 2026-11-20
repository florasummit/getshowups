// Business Intelligence Engine: what a customer's words already tell us, deterministically (no model call, no I/O,
// microseconds). Used to (1) tell the conversation model what is known so nothing is asked twice, (2) enforce the
// owner's rules on the server, and (3) power "Test your AI" without spending anything.
//
// It recognizes only what it can recognize reliably: the business's own towns, ZIP codes, street addresses, urgency
// and safety words, equipment words, days, intents (price, reschedule, a person, installation, commercial, complaint,
// complex job) and corrections. Anything else stays unknown and is asked for (or recorded by the model with the
// note_answer tool, checked against the customer's own words). It never decides eligibility: decide.js does.
import { spokenToDigits } from '../receptionist/digits.js'

const lc = (s) => String(s || '').toLowerCase()
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (s) => lc(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
// Rough stem so install / installs / installation / installing compare equal.
const stem = (w) => w.replace(/(ations?|ation|ings?|ers?|ed|es|s)$/, '') || w
const GENERIC = new Set(['service', 'services', 'servic', 'system', 'work', 'job', 'new', 'equipment', 'the', 'and', 'for', 'our', 'your', 'care', 'all', 'any', 'repair', 'repairs', 'pool', 'home', 'house', 'residential', 'general'])
const sig = (s) =>
  words(s)
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC.has(w))
    .map(stem)

// Problem words per industry (what they need), and equipment words.
const NEEDS = {
  pool: /\b(green(?: pool| water)?|cloudy|algae|pump|filter|heater|leak(?:ing)?|(?:weekly|regular|routine) (?:cleaning|service|care)|clean(?:ing)?|opening|closing|chemicals?|salt (?:cell|system)|pool light)\b/i,
  hvac: /\b(no heat|not heating|not cooling|no (?:ac|a\/c|air|cooling)|(?:ac|a\/c|air conditioner|air)(?: is| isn't| is not| won't| not)? (?:not )?(?:cooling|working|turning on|blowing)[a-z ]{0,20}|blowing (?:warm|hot|cold) air|furnace|heat pump|thermostat|(?:strange |loud |weird )?nois(?:e|y)|leak(?:ing)?|tune[- ]?up|maintenance|install(?:ation)?|replace(?:ment)?|new (?:system|unit))\b/i,
  electrical: /\b(outlets?|breakers?|panel|wiring|(?:lights?|lighting) (?:flicker\w*|out|not working)|flicker\w*|sparks?|ev charger|generator|ceiling fan|light switch|switch|install(?:ation)?|rewir\w*)\b/i,
  general: /\b(?:need|want|looking for|help with|interested in)\s+(?:a |an |some |the )?([a-z][a-z -]{2,40})/i,
}
const EQUIPMENT = {
  pool: /\b(pump|filter|heater|salt cell|chlorinator|automation|pool light|robot(?:ic)? cleaner|cleaner)\b/i,
  hvac: /\b(furnace|heat pump|central air|ac unit|a\/c unit|air conditioner|mini[- ]split|boiler|thermostat|duct(?:s|work)?|(?:carrier|trane|lennox|rheem|goodman|york|daikin|bryant)(?: unit| system)?)\b/i,
  electrical: /\b(panel|breaker box|fuse box|outlets?|switch(?:es)?|fixtures?|ev charger|generator|ceiling fan)\b/i,
}
const SAFETY = [
  ['call_911', /\b(smell(?:s|ing)? (?:of |like )?gas|gas (?:smell|leak)|carbon monoxide|co (?:alarm|detector)|(?:house|room|kitchen|panel|outlet) (?:is )?on fire|there'?s a fire|fire in|smoke (?:coming|from))\b/i],
  ['electrical_hazard', /\b(sparks?|sparking|burning smell|smell(?:s|ing)? (?:something |like )?burn\w*|something(?:'s| is)? burning|(?:got |been )?shock(?:ed)?|exposed wires?|water (?:near|on|in|around) (?:the )?(?:panel|outlet|breaker|electrical)|flooding near)\b/i],
]
const NOT_URGENT = /\b(not urgent|no rush|not in a (?:hurry|rush)|no hurry|not an emergency|isn'?t an emergency|it can wait|can wait|whenever (?:works|is fine|you can)|next week is fine|any ?time is fine)\b/i
const URGENT = /\b(emergency|urgent(?:ly)?|asap|as soon as possible|right away|immediately|today|tonight|right now)\b/i
const DAYS = /\b(today|tomorrow|this weekend|weekend|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const PART = /\b(morning|afternoon|evening)\b/i
const EXISTING_YES = /\b(existing customer|already (?:a )?customer|regular customer|been (?:a )?customer|my (?:regular|usual) (?:tech|technician|guy)|you (?:guys )?(?:came|were (?:here|out)|did|serviced|service|clean(?:ed)?|fixed|installed|put in)\b[a-z ,]{0,30}\b(?:before|last|already|ago))\b/i
const EXISTING_NO = /\b(new customer|first time|never used you|haven'?t used you|never (?:had|hired) you)\b/i
export const INTENTS = {
  price: /\b(how much|price|pricing|cost|quote|estimate|charge|fee|rates?)\b/i,
  reschedule: /\b(reschedul\w*|move my (?:appointment|visit)|change my (?:appointment|visit|time)|different time for my)\b/i,
  cancel: /\bcancel (?:my|the) (?:appointment|visit|booking)\b/i,
  person: /\b(real person|a human|human being|speak (?:to|with) (?:a |the |an )?(?:person|someone|owner|manager|technician|tech|representative)|talk (?:to|with) (?:a |the |an )?(?:person|someone|owner|manager|representative)|a manager|the owner)\b/i,
  installation: /\b(install\w*|replac\w*|new (?:system|unit|ac|a\/c|furnace|heat pump|panel|heater|pump|outlet|circuit))\b/i,
  commercial: /\b(commercial|office building|restaurant|warehouse|business property|storefront|apartment complex|hoa)\b/i,
  complaint: /\b(complain\w*|not happy|unhappy|still (?:broken|not working|green)|you (?:guys )?(?:broke|damaged)|didn'?t fix|bad job|refund)\b/i,
  complex: /\b(whole[- ](?:house|home)|rewir\w*|remodel\w*|renovat\w*|addition|new construction|service upgrade|panel upgrade|several rooms|multiple (?:rooms|units|buildings))\b/i,
}
const CORRECTION = /\b(actually|sorry,? i meant|i meant|correction|i mean|no,? (?:it'?s|i'?m|we'?re|the))\b/i
const HESITATION = /\b(u+m+|u+h+|hmm+|let me think|not sure|i don'?t know|i'?m not sure)\b/i
const STREET = /\b(\d{1,6})\s+((?:[a-z0-9.'-]+\s+){0,4}?)(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl|circle|cir|highway|hwy|parkway|pkwy|terrace|ter|trail|trl)\b\.?(?:,?\s*(?:apt|unit|suite|#)\s*[a-z0-9-]+)?/i
// After the street: ", Mount Pleasant, SC 29464" / ", Charleston SC" / ", Summerville".
const ADDRESS_TAIL = /^\s*,\s*([A-Za-z][A-Za-z .'-]{1,39}?)\s*(?=,|$|[.!?]|\s+[A-Za-z]{2}\b|\s+\d{5})/
const UNKNOWN_CITY = /\b(?:i'?m in|i am in|we'?re in|we are in|i live in|we live in|located in|out in|over in|i'?m from|we'?re from|live in|house is in|home is in|property is in)\s+([A-Za-z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/i
// "… in Summerville": a capitalized place name after "in" (case-sensitive; months, days and common words excluded).
const IN_PLACE = /\bin\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})\b/
const NOT_A_PLACE = /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|The|My|Our|A|An|Spanish|English|Person)\b/
const NOT_A_CITY = /^(the|a|an|my|our|need|trouble|a hurry|a rush|town|here|there|charge|luck|pain|good|bad|this|that|it)$/i

// Digit runs: spoken single digits joined ("2 9 4 6 4" → "29464"), phone numbers set aside so their digits never
// look like a ZIP. Returns { zips: [...], phone: '##########' | null }.
function numbers(text) {
  let t = spokenToDigits(text).replace(/\b\d(?:[ -]\d\b)+/g, (m) => m.replace(/[ -]/g, ''))
  let phone = null
  t = t.replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, (m) => {
    const d = m.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
    if (d.length === 10) phone = phone || d
    return ' '
  })
  return { zips: [...new Set(t.match(/\b\d{5}\b/g) || [])], phone, text: t }
}

// Known towns in the text, longest first so "North Charleston" wins over "Charleston" (a found town is masked, so the
// shorter name inside it isn't found again). → [{ town, at }] with each town's position in the message.
function townsAt(text, towns) {
  let rest = ` ${words(text)} `
  const found = []
  for (const town of [...towns].sort((a, b) => b.length - a.length)) {
    const w = words(town)
    if (!w) continue
    const at = rest.indexOf(` ${w} `)
    if (at >= 0) {
      found.push({ town, at })
      rest = `${rest.slice(0, at)} ${'|'.repeat(w.length)} ${rest.slice(at + w.length + 2)}`
    }
  }
  return found
}
const townsIn = (text, towns) => townsAt(text, towns).map((t) => t.town)

function matchService(text, list) {
  const said = new Set(sig(text))
  let best = null
  for (const name of list) {
    const toks = sig(name)
    if (!toks.length) continue
    const hit = toks.filter((t) => said.has(t)).length
    if (hit && (!best || hit / toks.length > best.score)) best = { name, score: hit / toks.length }
  }
  return best?.name || null
}

// One customer message → the facts it states. `ctx`: { industry, towns, services (names), excluded, triggers, phrases }.
export function understand(text, ctx = {}) {
  const raw = String(text || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').slice(0, 1500)
  const out = { intents: [] }
  const ind = ctx.industry && NEEDS[ctx.industry] ? ctx.industry : 'general'
  const nums = numbers(raw)
  // Street address first, so its house number is never read as a ZIP.
  const addr = raw.match(STREET)
  let rest = raw
  if (addr) {
    out.street = `${addr[1]} ${(addr[2] || '').trim()} ${addr[3]}`.replace(/\s+/g, ' ').trim()
    const tail = raw.slice(addr.index + addr[0].length)
    const town = tail.match(ADDRESS_TAIL)
    if (town) out.city = (townsIn(town[1], ctx.towns || [])[0] || town[1].trim()).replace(/\b\w/g, (c) => c.toUpperCase())
    const sz = tail.slice(0, 60).match(/\b([A-Z]{2})\b,?\s*(\d{5})?\b/)
    if (sz && !/^(IN|ON|AT|BY|IS|IT|MY|WE|TO|OK)$/.test(sz[1])) out.state = sz[1]
    const zip = tail.slice(0, 60).match(/\b(\d{5})\b/)
    if (zip) out.zip = zip[1]
    rest = raw.replace(addr[0], ' ').replace(tail.slice(0, 60).match(/^[^.!?]*/)[0], ' ')
  }
  const restNums = numbers(rest)
  if (!out.zip) {
    if (restNums.zips.length === 1) out.zip = restNums.zips[0]
    else if (restNums.zips.length > 1) out.conflicts = [...(out.conflicts || []), 'zip']
  }
  if (nums.phone) out.phone = nums.phone

  const found = townsAt(rest, ctx.towns || [])
  const towns = found.map((f) => f.town)
  if (towns.length === 1 && !out.city) out.city = towns[0]
  else if (towns.length > 1) {
    // "We're in Charleston, actually Mount Pleasant" → the later one; two towns otherwise → ask which.
    if (CORRECTION.test(raw)) out.city = [...found].sort((a, b) => b.at - a.at)[0].town
    else out.conflicts = [...(out.conflicts || []), 'city']
  } else if (!out.city) {
    const m = rest.match(UNKNOWN_CITY) || (rest.match(IN_PLACE) && !NOT_A_PLACE.test(rest.match(IN_PLACE)[1]) ? rest.match(IN_PLACE) : null)
    if (m) {
      const name = m[1].split(/\s+/).filter((w, i) => i === 0 || /^[A-Z]/.test(w)).join(' ').replace(/[.'-]+$/, '')
      if (name && !NOT_A_CITY.test(name) && !DAYS.test(name) && !PART.test(name) && !/\d/.test(name)) out.city = name.replace(/\b\w/g, (c) => c.toUpperCase())
    }
  }

  // Safety (platform) first: it is urgent whatever else was said.
  for (const [kind, re] of SAFETY) if (re.test(raw)) out.safety = out.safety || kind
  const triggers = (ctx.triggers || []).filter((p) => p && new RegExp(`\\b${esc(lc(p))}\\b`).test(lc(raw)))
  if (triggers.length) out.trigger = triggers[0]
  if (NOT_URGENT.test(raw)) out.urgency = 'not_urgent'
  else if (out.safety || triggers.length || URGENT.test(raw)) out.urgency = 'urgent'

  const service = matchService(raw, ctx.services || [])
  const excluded = matchService(raw, ctx.excluded || [])
  if (excluded && (!service || sig(excluded).some((t) => sig(raw).includes(t)))) out.excluded = excluded
  const needMatch = raw.match(NEEDS[ind]) || (ind !== 'general' ? raw.match(NEEDS.general) : null)
  if (service) out.service = service
  if (needMatch) out.need = (needMatch[1] || needMatch[0]).trim().slice(0, 80)
  else if (service) out.need = service
  const eq = EQUIPMENT[ind] && raw.match(EQUIPMENT[ind])
  if (eq) out.equipment = eq[0].toLowerCase()

  const name = raw.match(/\b(?:[Mm]y name is|[Nn]ame'?s|[Tt]his is|[Ii]'?m|[Ii] am|[Ii]t'?s)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)\b/)
  if (name && !(ctx.towns || []).some((t) => lc(t).startsWith(lc(name[1]))) && !DAYS.test(name[1]) && !/^(In|At|From|Not|Calling|Looking|Having|Just|Actually|Sorry|Here|Out|Over|The|A)$/.test(name[1].split(' ')[0])) out.name = name[1]
  const day = raw.match(DAYS)
  if (day) out.day = day[1].replace(/^\w/, (c) => c.toUpperCase())
  const part = raw.match(PART)
  if (part) out.part = part[1].toLowerCase()
  if (EXISTING_NO.test(raw)) out.existing = false
  else if (EXISTING_YES.test(raw)) out.existing = true
  for (const [k, re] of Object.entries(INTENTS)) if (re.test(raw)) out.intents.push(k)
  for (const p of ctx.phrases || []) if (p && new RegExp(`\\b${esc(lc(p))}\\b`).test(lc(raw))) out.intents.push(`phrase:${p}`)
  if (CORRECTION.test(raw)) out.correction = true
  if (HESITATION.test(raw) && Object.keys(out).filter((k) => !['intents'].includes(k)).length === 0) out.hesitant = true
  return out
}

const FACT_KEYS = ['need', 'service', 'excluded', 'city', 'zip', 'zipKnown', 'street', 'state', 'name', 'phone', 'urgency', 'safety', 'trigger', 'equipment', 'day', 'part', 'existing']
// Folds one message's facts into what is known. The newest statement wins (corrections), and a changed value is
// recorded so the AI acknowledges it instead of carrying on with the old one. Conflicts (two ZIPs in one breath)
// are kept until a later message settles them.
export function mergeFacts(prior = {}, next = {}) {
  const known = { ...prior, intents: [...new Set([...(prior.intents || []), ...(next.intents || [])])].slice(-20) }
  const changed = []
  for (const k of FACT_KEYS) {
    if (next[k] === undefined) continue
    if (known[k] !== undefined && known[k] !== next[k]) changed.push(k)
    known[k] = next[k]
  }
  // A new street without a new city/ZIP: the old city/ZIP may belong to the old address — keep them (never invent).
  const settled = FACT_KEYS.filter((k) => next[k] !== undefined)
  known.conflicts = [...new Set([...(prior.conflicts || []).filter((c) => !settled.includes(c)), ...(next.conflicts || [])])]
  if (changed.length) known.corrected = [...new Set([...(prior.corrected || []), ...changed])].slice(-10)
  if (next.hesitant) known.hesitant = true
  return { known, changed }
}

// Customer words contain the answer (for note_answer): every significant word of the answer was said, or the answer
// is a short phrase found verbatim. Keeps the model from recording answers the customer never gave.
export function saidByCustomer(answer, customerText) {
  const a = words(answer)
  const t = ` ${words(customerText)} `
  if (!a) return false
  if (t.includes(` ${a} `)) return true
  const toks = a.split(' ').filter((w) => w.length >= 3)
  return toks.length > 0 && toks.every((w) => t.includes(` ${w}`) || t.includes(` ${stem(w)}`))
}
