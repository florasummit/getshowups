// The field rules of a lead (name, email, phone, need, service address): ONE definition, used by the server
// (server/booking.js validateLead / validateAddress) and by the public booking page (src/booking/BookingPage.jsx), so a
// step never lets through what the server will refuse and every problem can be shown at once, by its field.
// Pure: no imports, nothing stored, safe to ship to browsers. The ZIP's existence check stays on the server
// (server/zipcode.js); here only its shape.

export const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

// Same pattern as server/auth.js EMAIL_RE (a test keeps the two identical).
export const LEAD_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
const PHONE_RE = /^[0-9+().\-\s]{7,25}$/
export const ZIP5_RE = /^\d{5}(-\d{4})?$/
// What server/zipcode.js normalizeZip accepts (ZIP or ZIP+4, with a space or hyphen).
export const ZIP_SHAPE_RE = /^\s*\d{5}(?:[\s-]?\d{4})?\s*$/
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '))

// A phone number: digits and the usual punctuation, at least 7 digits. fullNumber (the booking page, where a person
// types their own number): a number without a country code is a US number and needs its area code (10 digits or
// more); "+1…" needs exactly 11; another "+<country>" number is accepted as before.
export function phoneOk(v, { fullNumber = false } = {}) {
  const p = clean(v, 25)
  const digits = p.replace(/\D/g, '')
  if (!PHONE_RE.test(p) || digits.length < 7) return false
  if (!fullNumber) return true
  if (p.startsWith('+')) return p.startsWith('+1') ? digits.length === 11 : true
  return digits.length >= 10
}

// Every problem of a US service address, in field order: invalid_street | invalid_city | invalid_state | invalid_zip.
export function addressProblems(raw) {
  const street = clean(raw?.street, 100)
  const city = clean(raw?.city, 60)
  const out = []
  if (street.length < 5 || !/\d/.test(street) || !/[A-Za-z]/.test(street)) out.push('invalid_street')
  if (city.length < 2 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city)) out.push('invalid_city')
  if (!US_STATES.has(clean(raw?.state, 2).toUpperCase())) out.push('invalid_state')
  if (!ZIP5_RE.test(clean(raw?.zip, 10))) out.push('invalid_zip')
  return out
}

// Every problem of a lead submission, in the order validateLead reports them (its first error is this list's first).
export function leadProblems(body, mode = 'at_business', { requireEmail = true, requirePhone = true, fullNumber = false } = {}) {
  const email = clean(body?.email, 254).toLowerCase()
  const phone = clean(body?.phone, 25)
  const out = []
  if (clean(body?.name, 80).length < 2) out.push('invalid_name')
  if ((requireEmail || email) && !LEAD_EMAIL_RE.test(email)) out.push('invalid_email')
  if ((requirePhone || phone) && !phoneOk(phone, { fullNumber })) out.push('invalid_phone')
  if (clean(body?.need, 500).length < 2) out.push('invalid_need')
  if (mode === 'at_customer') out.push(...addressProblems(body?.address))
  return out
}
