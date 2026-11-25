// Calendar dates as YYYY-MM-DD text, and the US federal holidays a service business most often closes for.
export function realDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
}
export function dateIn(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay()

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const nth = (y, m, dow, n) => iso(y, m, 1 + ((dow - new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 7) % 7) + (n - 1) * 7)
const lastMonday = (y, m) => {
  const last = new Date(Date.UTC(y, m, 0))
  return iso(y, m, last.getUTCDate() - ((last.getUTCDay() + 6) % 7))
}
const inYear = (y) => [
  [iso(y, 1, 1), 'New Year’s Day'],
  [lastMonday(y, 5), 'Memorial Day'],
  [iso(y, 7, 4), 'Independence Day'],
  [nth(y, 9, 1, 1), 'Labor Day'],
  [nth(y, 11, 4, 4), 'Thanksgiving'],
  [iso(y, 12, 25), 'Christmas Day'],
]
// Holidays from `from` through `days` later, inclusive.
export function holidays(from, days) {
  const y = Number(from.slice(0, 4))
  const to = addDays(from, days)
  return [...inYear(y), ...inYear(y + 1)].filter(([d]) => d >= from && d <= to).map(([date, label]) => ({ date, label }))
}
