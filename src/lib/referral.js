// Referral first touch, kept on this device the same way the acquisition source (gsu_source) is: the first codes seen
// via a referral link (/r/<code> → ?partner=<code>) or ?ref=<code>, oldest first, at most 3, each with the time it was
// first seen. The server decides which (if any) is a valid partner when the business is created; the first valid one wins.
const KEY = 'gsu_partner'
const CODE = /^[a-z0-9]{6,32}$/
const MAX = 3

export function referralCandidates() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list.filter((c) => CODE.test(c?.code) && Number.isFinite(c?.at)).slice(0, MAX) : []
  } catch {
    return []
  }
}

export function captureReferral(search = window.location.search, now = Date.now()) {
  try {
    const params = new URLSearchParams(search)
    const code = String(params.get('partner') || params.get('ref') || '').trim().toLowerCase()
    if (!CODE.test(code)) return
    const list = referralCandidates()
    if (list.length >= MAX || list.some((c) => c.code === code)) return
    localStorage.setItem(KEY, JSON.stringify([...list, { code, at: now }]))
  } catch {
    // storage unavailable: no referral is recorded
  }
}
