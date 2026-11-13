// One rule for website addresses typed by business owners (any business, any field that takes a website URL).
//   example.com, www.example.com      → https://example.com, https://www.example.com (https by default)
//   http://… / https://…              → kept exactly as typed (an explicit scheme is preserved)
//   subdomains, paths, query strings  → kept
// Refused: malformed input, other protocols (javascript:, data:, ftp:, mailto:, …), credentials in the URL,
// and destinations that are not public websites (localhost, *.local/.internal, IP addresses, single-label
// hosts). Returns [error, url]; error is one of 'invalid_url' | 'unsupported_protocol' | 'unsafe_url'.
// Saved values that were valid before (https://…) come back unchanged, so re-saving never rewrites them.
const MAX_LENGTH = 2048
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const PRIVATE_TLDS = new Set(['localhost', 'local', 'internal', 'lan', 'home', 'corp', 'intranet', 'arpa'])

export function normalizeWebsiteUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw || raw.length > MAX_LENGTH || /[\s\\<>"]/.test(raw)) return ['invalid_url']
  // "name:" is a scheme unless it is host:port (digits follow) or contains a dot (a hostname).
  const m = raw.match(SCHEME)
  const scheme = m && !m[1].includes('.') && !/^\d/.test(raw.slice(m[0].length)) ? m[1].toLowerCase() : null
  if (scheme && scheme !== 'http' && scheme !== 'https') return ['unsupported_protocol']
  if (scheme && !/^https?:\/\/[^/]/i.test(raw)) return ['invalid_url'] // e.g. "http:example.com", "https:///x"
  if (!scheme && raw.startsWith('/')) return ['invalid_url']
  const url = scheme ? raw : `https://${raw}`
  let u
  try {
    u = new URL(url)
  } catch {
    return ['invalid_url']
  }
  if (u.username || u.password) return ['unsafe_url']
  const host = u.hostname.replace(/\.$/, '')
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return ['unsafe_url'] // IP literals
  const labels = host.split('.')
  if (labels.length < 2) return ['unsafe_url'] // localhost, intranet names
  if (PRIVATE_TLDS.has(labels.at(-1))) return ['unsafe_url']
  if (host.length > 253 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1))) return ['invalid_url']
  return [null, url]
}
