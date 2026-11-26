// Text helpers for anything a person reads (docs/DESIGN_SYSTEM.md "Copy"). Pure functions, no DOM: used by the
// dashboard, the admin console and unit tests (test/format.test.js).
//   plural(2, 'visit')              → "2 visits"      plural(1, 'visit') → "1 visit"   (never "1 visits", never "visit(s)")
//   plural(3, 'person', 'people')   → "3 people"      pluralWord(1, 'business') → "business"
//   humanDate('2026-11-26')         → "Thu, Nov 26"   (an ISO date is never shown as typed; the year appears when it isn't this year)
//   humanDateTime(ms, { timeZone }) → "Thu, Nov 26, 3:00 PM"
//   money(-1026600)                 → "−$10,266"      (cents in; a real minus sign BEFORE the dollar sign; null → "—")

const IRREGULAR = { person: 'people', business: 'businesses', child: 'children', man: 'men', woman: 'women' }

// The plural of an English noun: an explicit form wins, then a few irregulars, then the regular rules.
export function pluralWord(n, one, many) {
  if (Number(n) === 1) return one
  if (many) return many
  const lower = one.toLowerCase()
  if (IRREGULAR[lower]) return one === lower ? IRREGULAR[lower] : IRREGULAR[lower].replace(/^./, (c) => c.toUpperCase())
  if (/[^aeiou]y$/i.test(one)) return `${one.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(one)) return `${one}es`
  return `${one}s`
}

// A count with its noun. The number is grouped ("1,200 visits"); a missing count reads as 0.
export function plural(n, one, many) {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0
  return `${count.toLocaleString('en-US')} ${pluralWord(count, one, many)}`
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

// A calendar date ("2026-11-26") names a day, not an instant: it is read at noon UTC and printed in UTC so it never
// slips to the day before in a western time zone. Anything else (ISO timestamp, milliseconds, Date) is an instant.
function parse(value) {
  if (value == null || value === '') return null
  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    const d = new Date(`${value}T12:00:00Z`)
    return Number.isNaN(d.getTime()) ? null : { date: d, timeZone: 'UTC' }
  }
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : { date: d }
}

const yearOf = (date, timeZone) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(date)

// "Thu, Nov 26" · with another year "Nov 26, 2025" · { weekday: false } → "Nov 26" · { year: true } always shows it ·
// { long: true } → "Thursday, November 26". Unreadable input → '' (callers show their own "not set" text).
export function humanDate(value, { timeZone, weekday = true, year, long = false, now = Date.now() } = {}) {
  const p = parse(value)
  if (!p) return ''
  const tz = p.timeZone || timeZone
  const showYear = year ?? yearOf(p.date, tz) !== yearOf(new Date(now), tz)
  const style = long ? 'long' : 'short'
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: style, day: 'numeric', ...(showYear ? { year: 'numeric' } : {}), ...(weekday && !showYear ? { weekday: style } : {}) }).format(p.date)
}

// "Thu, Nov 26, 3:00 PM" (the year is added when it isn't this year). A date-only value has no time: its date is returned.
export function humanDateTime(value, { timeZone, now = Date.now() } = {}) {
  const p = parse(value)
  if (!p) return ''
  if (p.timeZone) return humanDate(value, { now })
  const showYear = yearOf(p.date, timeZone) !== yearOf(new Date(now), timeZone)
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(showYear ? { year: 'numeric' } : {}) }).format(p.date)
}

// Money from cents: "$1,234", "$12.50" (cents only when there are any, or with { cents: true }), "−$10,266" for a
// negative amount (U+2212 before the dollar sign, never "$-10,266"). Missing or not a number → `empty` ("—").
export function money(cents, { cents: showCents, empty = '—' } = {}) {
  if (cents == null || !Number.isFinite(Number(cents))) return empty
  const value = Math.round(Number(cents))
  const digits = showCents ?? value % 100 !== 0 ? 2 : 0
  const text = (Math.abs(value) / 100).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${value < 0 ? '−' : ''}$${text}`
}
