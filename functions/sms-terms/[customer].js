// GET /sms-terms/<business id> — the public texting program terms for one business (what carriers check for A2P 10DLC:
// program description, who sends, frequency, costs, STOP/HELP, privacy). Built from records only; no scripts.
import { CUSTOMER_RE } from '../../server/invites.js'
import { getProfile } from '../../server/onboarding.js'
import { hitByIp, tooManyPage } from '../../server/ratelimit.js'
import { siteOrigin } from '../../server/auth.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const page = (status, title, body) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:32px 20px;color:#16181d;background:#fff}h1{font-size:1.6rem;line-height:1.25}h2{font-size:1.1rem;margin-top:1.8em}p,li{color:#333}a{color:#0b57d0}figure{margin:12px 0;padding:14px 16px;border:1px solid #d6d9de;border-radius:10px;background:#f7f8fa}figcaption{font-size:.85rem;color:#5b616e;margin-bottom:8px}label{display:flex;gap:10px;align-items:flex-start;font-size:.92rem;color:#333}input{margin-top:4px;flex:none}</style></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' } },
  )

export async function onRequestGet({ request, env, params }) {
  const rl = await hitByIp(env, 'pageView', request)
  if (rl.limited) return tooManyPage(rl.retryAfter)
  const id = String(params.customer || '').toLowerCase()
  const notFound = () => page(404, 'Not found', '<h1>Not found</h1>')
  if (!CUSTOMER_RE.test(id) || !env.ONBOARDING_DB) return notFound()
  const c = await env.ONBOARDING_DB.prepare("SELECT id, name FROM customers WHERE id = ?1 AND status = 'active'").bind(id).first()
  if (!c) return notFound()
  const p = await getProfile(env.ONBOARDING_DB, id).catch(() => null)
  const name = esc(c.name)
  const origin = siteOrigin(env)
  return page(
    200,
    `${c.name}: text message terms`,
    `<h1>${name}: text message terms</h1>
<p>${name} uses GetShowUps to text customers who ask to be contacted.</p>
<h2>What you'll receive</h2>
<ul><li>Replies about the request you sent ${name} (through its website or booking page).</li><li>Appointment confirmations and reminders, and, if you didn't book yet, up to two reminders to pick a time.</li><li>Answers when you text ${name}.</li></ul>
<p>Message frequency varies with your request. Message and data rates may apply. We never send marketing to purchased lists.</p>
<h2>How you agree</h2>
<p>Only by checking the optional, unchecked texting box on ${name}'s <a href="${esc(origin)}/book/${esc(c.id)}">booking page</a> or website form, or by texting ${name} first. Agreeing is never required to book or to get a reply by email. We never ask for consent by text.</p>
<p>This is exactly what the box looks like (shown here unchecked and inactive):</p>
<figure><figcaption>Booking page</figcaption><label><input type="checkbox" disabled><span>Text me about this appointment (confirmation and reminders) from ${name} via GetShowUps. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Not required to book. <a href="${esc(origin)}/sms-terms/${esc(c.id)}">Texting terms</a> · <a href="${esc(origin)}/privacy">Privacy</a></span></label></figure>
<figure><figcaption>Website contact and quote forms</figcaption><label><input type="checkbox" disabled><span>Text me about my request from ${name} via GetShowUps. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Not required. <a href="${esc(origin)}/sms-terms/${esc(c.id)}">Texting terms</a> · <a href="${esc(origin)}/privacy">Privacy</a></span></label></figure>
<h2>Stop or get help</h2>
<p>Reply <strong>STOP</strong> at any time to stop texts from ${name}; you'll get one confirmation and nothing more. Reply <strong>START</strong> to resubscribe. Reply <strong>HELP</strong> for help${p?.phone ? `, or call ${esc(p.phone)}` : ''}.</p>
<h2>Privacy</h2>
<p>Mobile numbers and texting consent are not shared with or sold to third parties or affiliates for marketing. They're used only to send the messages described here. See the <a href="${esc(origin)}/privacy">privacy policy</a>.</p>
<h2>Who sends these texts</h2>
<p>${name} sends them through GetShowUps (getshowups.com), which provides its booking and messaging tools.</p>
<p>Carriers are not liable for delayed or undelivered messages.</p>`,
  )
}
