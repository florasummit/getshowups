// US ZIP codes: the ONE rule for reading a ZIP a visitor typed or said, and for where it stands against a business's
// service area. Used by the booking page, website forms, the AI receptionist and the owner's coverage decisions.
// (Not to be confused with server/zip.js, the .zip archive writer.)
//
// checkZip(raw) → { zip, check }
//   check 'invalid'  not a US ZIP (wrong length / letters): ask for a correction; keep everything else they typed
//         'unknown'  well-formed but not a ZIP Code Tabulation Area (U.S. Census, server/zip-data.js): could be a typo,
//                    could be a PO-box-only ZIP. Ask to double-check; if they confirm it, it is accepted as uncertain
//         'valid'    a real ZIP area
// areaFor(customer, zip, check) → 'in' | 'outside' | 'uncertain'
//   'in' ONLY when the business explicitly lists that exact ZIP (or lists none: area not limited). Numeric closeness
//   means nothing (neighbouring codes can be far apart); a state, county or nearby code is never treated as served.
//   'uncertain' = a ZIP we couldn't verify; 'outside' = a real ZIP the business doesn't list.
import { ZCTA_BITS } from './zip-data.js'

let bits = null
const table = () => (bits ||= Uint8Array.from(atob(ZCTA_BITS), (c) => c.charCodeAt(0)))

export function normalizeZip(raw) {
  const m = /^\s*(\d{5})(?:[\s-]?\d{4})?\s*$/.exec(String(raw ?? ''))
  return m ? m[1] : ''
}

export function isRealZip(zip) {
  if (!/^\d{5}$/.test(zip)) return false
  const n = Number(zip)
  return Boolean(table()[n >> 3] & (1 << (n & 7)))
}

export function checkZip(raw) {
  const zip = normalizeZip(raw)
  if (!zip) return { zip: '', check: 'invalid' }
  return { zip, check: isRealZip(zip) ? 'valid' : 'unknown' }
}

export function areaFor(customer, zip, check = checkZip(zip).check) {
  const list = customer?.serviceZips || []
  if (list.length === 0) return 'in'
  if (zip && list.includes(zip)) return 'in'
  return check === 'valid' ? 'outside' : 'uncertain'
}
