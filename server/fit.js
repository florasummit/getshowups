// Makes a result fit a size without cutting a record in half: whole list items are left out and counted, long texts end
// with a marker. Anything left out is said, so "not listed here" is never read as "does not exist".
const size = (v) => JSON.stringify(v).length
function longest(v, best = { list: null, n: 1 }) {
  if (Array.isArray(v)) {
    const n = size(v)
    if (v.length > 1 && n > best.n) Object.assign(best, { list: v, n })
    v.forEach((x) => longest(x, best))
  } else if (v && typeof v === 'object') Object.values(v).forEach((x) => longest(x, best))
  return best
}
export function fit(value, max) {
  if (size(value) <= max) return JSON.stringify(value)
  const v = structuredClone(value)
  const cut = new Map()
  for (let i = 0; i < 500 && size(v) > max; i++) {
    const { list } = longest(v)
    if (!list) break
    if (typeof list.at(-1)?.left_out === 'number') list.pop()
    list.pop()
    cut.set(list, (cut.get(list) || 0) + 1)
    list.push({ left_out: cut.get(list), note: 'more exist; look them up before saying anything about them' })
  }
  return size(v) <= max ? JSON.stringify(v) : JSON.stringify({ error: 'too_large', note: 'This result was too large to show. Narrow it down; do not conclude anything from it.' })
}
// Text kept whole up to a generous limit; cut at a word and marked after that.
export const keep = (text, max) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')} (text continues)`)
