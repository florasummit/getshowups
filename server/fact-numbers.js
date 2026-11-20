// The invented-number check for AI-written text (website copy, the AI designer, follow-up answers): every number in
// the text must be a number in the business's facts. Compared as WHOLE numbers, never as digit substrings: "15 years"
// is not backed by ZIP 33156, and "12 technicians" is not backed by the phone number (954) 555-0123.
// A phone number written in any common format counts when its digits are one of the facts' phone numbers.

const NUM_RE = /\d[\d,.]*/g
// A run of digits joined by phone separators (spaces, dots, dashes, brackets), at least 7 digits overall.
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g
const digits = (s) => s.replace(/\D/g, '')
const trim = (n) => n.replace(/[.,]+$/, '')
// 1,200 = 1200; 120.00 = 120; 09 = 9 (times such as 09:00). Anything else is compared as written.
const norm = (n) => {
  const s = trim(n).replace(/,/g, '')
  return /^\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s
}

export function inventedNumbers(text, factsText) {
  const facts = String(factsText ?? '')
  const known = new Set((facts.match(NUM_RE) || []).map(norm))
  const phones = (facts.match(PHONE_RE) || []).map(digits).filter((d) => d.length >= 7)
  // A phone number in the text that matches a known phone (with or without the country code) is fine as a whole.
  // Any other digit run is checked number by number below.
  const rest = String(text ?? '').replace(PHONE_RE, (m) => {
    const d = digits(m)
    return d.length >= 7 && phones.some((p) => p === d || p.endsWith(d) || d.endsWith(p)) ? ' ' : m
  })
  return (rest.match(NUM_RE) || []).map(trim).filter((n) => n && !known.has(norm(n)))
}
