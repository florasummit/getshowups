// /api/messages/unsubscribe?l=<lead id>&k=<signed token> — the "no more follow-up emails" link in follow-ups.
//   GET  shows the business name and a button (read-only: email scanners prefetch links).
//   POST records the opt-out for that business (message_optouts; the address only as a hash).
// The signed token only works for its own lead. Booking confirmations and reminders are not affected.
import { escapeHtml, page } from '../../../server/google-oauth.js'
import { verifyLinkToken } from '../../../server/links.js'
import { isOptedOut, recordOptOut } from '../../../server/optouts.js'
import { track } from '../../../server/events.js'
import { hitByIp, tooManyPage } from '../../../server/ratelimit.js'

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/ // lead ids: randomToken(12)
const HEADERS = { 'Referrer-Policy': 'same-origin' }

const invalid = () => page(404, 'Link not valid', 'This link is not valid. Please use the link from your most recent email.', HEADERS, '', false)
const done = (name) =>
  page(200, 'You’re unsubscribed', `You won’t get more follow-up emails from ${name}. If you book an appointment, you’ll still get its confirmation and reminders.`, HEADERS, '', false)

async function handle(request, env, l, k, confirm) {
  const rl = await hitByIp(env, 'unsubscribe', request)
  if (rl.limited) return tooManyPage(rl.retryAfter)
  if (!ID_RE.test(String(l)) || !(await verifyLinkToken(env, 'unsubscribe', l, k))) return invalid()
  let row
  try {
    row = await env.ONBOARDING_DB.prepare('SELECT l.id, l.customer, l.email, c.name FROM leads l JOIN customers c ON c.id = l.customer WHERE l.id = ?1').bind(l).first()
  } catch (err) {
    console.error('unsubscribe: lookup failed:', err?.message)
    return page(503, 'Please try again', 'We couldn’t load this right now. Please try again in a minute.', HEADERS, '', false)
  }
  if (!row) return invalid()
  if (await isOptedOut(env, row.customer, 'email', row.email)) return done(row.name)
  if (!confirm) {
    const form = `<form method="post" action="/api/messages/unsubscribe"><input type="hidden" name="l" value="${escapeHtml(l)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><button type="submit">Unsubscribe</button></form>`
    return page(200, 'Stop follow-up emails?', `Stop follow-up emails from ${row.name}. Booking confirmations and reminders still arrive if you book.`, HEADERS, form, false)
  }
  try {
    if (await recordOptOut(env, row.customer, 'email', row.email, 'unsubscribe_link')) {
      await track(env, 'message_optout', { id: `optout:email:${row.id}`, customer: row.customer, props: { channel: 'email' } })
    }
  } catch (err) {
    console.error('unsubscribe: record failed:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return page(503, 'Please try again', 'We couldn’t save this right now. Please try again in a minute.', HEADERS, '', false)
  }
  return done(row.name)
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  return handle(request, env, url.searchParams.get('l'), url.searchParams.get('k'), false)
}

export async function onRequestPost({ request, env }) {
  let form
  try {
    form = await request.formData()
  } catch {
    return invalid()
  }
  return handle(request, env, form.get('l'), form.get('k'), true)
}
