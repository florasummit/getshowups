// Connected services, one honest view: what is connected, what it does, what stops when it is disconnected, and what
// GetShowUps can't do (a grant held by Google or Meta is the owner's to remove there). Reads records only, never a token.
import { decrypt, revokeUnlessInUse } from './google-oauth.js'
import { forgetConnection } from './ads/connections.js'
import { adsAccess } from './ads/access.js'
import { gbpEnabled } from './ads/gbp.js'
import { openaiAdsEnabled } from './ads/openai.js'
import { setCampaignStatus } from './ads/campaigns.js'
import { adsHold } from './ads/holds.js'
import { domainFor } from './domains.js'
import { recordEvent } from './auditlog.js'

const soft = (p, d) => Promise.resolve(p).catch(() => d)

// state: connected | attention | off | unavailable (not offered yet) | unknown (couldn't be read)
export async function listServices(env, customer) {
  const db = env.ONBOARDING_DB
  const id = customer.id
  const UNKNOWN = Symbol('unknown')
  const [cal, conns, gbp, ghl, key, domain, sms, lsa, ads] = await Promise.all([
    soft(env.GOOGLE_TOKENS.get(`google:${id}`).then(Boolean), UNKNOWN),
    soft(db.prepare('SELECT platform, account_name, status FROM ad_connections WHERE customer = ?1').bind(id).all().then((r) => Object.fromEntries(r.results.map((x) => [x.platform, x]))), UNKNOWN),
    soft(db.prepare('SELECT status, title FROM gbp_connections WHERE customer = ?1').bind(id).first(), null),
    soft(env.GOOGLE_TOKENS.get(`ghl:${id}`).then(Boolean), false),
    soft(db.prepare('SELECT provider, hint, status FROM ai_credentials WHERE customer = ?1').bind(id).first(), null),
    soft(domainFor(env, id), UNKNOWN),
    soft(db.prepare('SELECT status FROM sms_accounts WHERE customer = ?1').bind(id).first(), null),
    soft(db.prepare('SELECT count(*) AS n FROM lsa_leads WHERE customer = ?1').bind(id).first(), null),
    soft(adsAccess(env, customer), false),
  ])
  const adState = (p) => (conns === UNKNOWN ? 'unknown' : !conns[p] ? 'off' : conns[p].status === 'connected' ? 'connected' : 'attention')
  const adName = (p) => (conns === UNKNOWN ? null : conns[p]?.account_name || null)
  const items = [
    { id: 'calendar', name: 'Google Calendar', state: cal === UNKNOWN ? 'unknown' : cal ? 'connected' : 'off', does: 'Shows your open times and adds bookings.', stops: 'New bookings stop: your booking page and receptionist can’t offer times, and your GetShowUps website goes offline until you connect again. Events already in your calendar stay there, but appointments can’t be cancelled from GetShowUps (by you or your customers) until you connect again.', external: 'Our stored access is deleted. We also ask Google to remove the permission when no other connection could be using it; you can always remove it at myaccount.google.com/permissions.', here: true, page: 'settings' },
    { id: 'google', name: 'Google Ads', state: adState('google'), detail: adName('google'), does: 'Creates, changes and reports on the ads you approve.', stops: 'We stop managing and reporting the account. You choose whether running campaigns are paused first. Campaigns stay in your Google Ads account.', external: 'Our stored access is deleted. Google’s own permission stays until you remove it at myaccount.google.com/permissions.', page: 'ads', offered: ads },
    { id: 'lsa', name: 'Local Services Ads', state: adState('google') === 'off' ? 'off' : lsa?.n > 0 ? 'connected' : 'off', detail: lsa?.n > 0 ? `${lsa.n} leads read` : null, does: 'Reads Google’s lead records (never contact details).', stops: 'It uses the Google Ads connection: disconnecting Google Ads stops it. Your Local Services account is unchanged.', page: 'ads', offered: ads },
    { id: 'meta', name: 'Meta ads', state: adState('meta'), detail: adName('meta'), does: 'Runs Facebook and Instagram lead ads and receives their leads.', stops: 'Leads stop arriving and we stop managing the account. Campaigns stay in your Meta account.', external: 'Our stored access is deleted. Remove the app in Facebook → Settings → Business integrations to end Meta’s permission.', here: adState('meta') !== 'off', page: 'ads', offered: ads },
    { id: 'openai', name: 'ChatGPT ads', state: adState('openai'), detail: adName('openai'), does: 'Manages ChatGPT ads with your own key.', stops: 'We stop managing the account. Pause running campaigns first.', external: 'Our stored key is deleted. Revoke it in OpenAI’s Ads Manager.', page: 'ads', offered: ads && openaiAdsEnabled(env) },
    { id: 'gbp', name: 'Google Business Profile', state: gbp ? (gbp.status === 'connected' ? 'connected' : 'attention') : 'off', detail: gbp?.title || null, does: 'Reads your listing and its verification.', stops: 'We stop reading the listing. The listing itself is unchanged.', external: 'Google’s own permission stays until you remove it at myaccount.google.com/permissions.', here: Boolean(gbp), page: 'ads', offered: gbpEnabled(env) || Boolean(gbp) },
    { id: 'ghl', name: 'GoHighLevel', state: ghl ? 'connected' : 'off', does: 'Copies your leads into your pipeline.', stops: 'Nothing new is copied. Contacts already copied stay in your GoHighLevel account.', external: 'Our stored token is deleted. Remove the private integration in GoHighLevel to end it there.', page: 'settings', offered: env.GHL_ENABLED === 'true' || ghl },
    { id: 'ai_key', name: 'Your own AI key', state: key ? (key.status !== 'ok' ? 'attention' : 'connected') : 'off', detail: key ? `${key.provider === 'openai' ? 'OpenAI' : 'Claude'} …${String(key.hint).slice(-4)}` : null, does: 'Pays for website design on your own AI account.', stops: 'The AI designer stops. Your website and drafts stay.', external: 'Our stored key is deleted. Revoke it in your AI account.', page: 'website' },
    { id: 'domain', name: 'Your domain', state: domain === UNKNOWN ? 'unknown' : !domain ? 'off' : domain.status === 'connected' ? 'connected' : 'attention', detail: domain && domain !== UNKNOWN ? domain.hostname : null, does: 'Serves your website on your own address.', stops: 'Your website is served on its GetShowUps address only.', external: 'The domain and its DNS stay yours; we never change them.', page: 'website' },
    { id: 'texting', name: 'Texting', state: sms ? (sms.status === 'active' ? 'connected' : 'attention') : 'unavailable', does: 'Texts your customers from your own number.', stops: 'Texts stop.', page: 'followups' },
  ]
  return items.filter((x) => x.state !== 'off' || x.offered !== false).map(({ offered: _o, ...x }) => x)
}

// The disconnects that live in Settings. Same rules as the Google Ads one: nothing is left running by accident.
export async function disconnectService(env, session, service, { pauseRunning = false } = {}) {
  const db = env.ONBOARDING_DB
  const customer = session.customer
  const id = customer.id
  const note = (details, outcome = 'success') => recordEvent(db, { type: 'integration.disconnected', actorType: 'owner', actor: `owner:${session.email}`, customer: id, capability: 'account.integrations', resource: { type: 'integration', id: service }, outcome, details })
  if (service === 'calendar') {
    const raw = await env.GOOGLE_TOKENS.get(`google:${id}`)
    if (!raw) return { ok: false, status: 404, error: 'not_connected' }
    let rec = null
    try {
      rec = JSON.parse(raw)
    } catch {}
    await env.GOOGLE_TOKENS.delete(`google:${id}`)
    for (const k of (await env.GOOGLE_TOKENS.list({ prefix: `google-archive:${id}:` })).keys) await env.GOOGLE_TOKENS.delete(k.name)
    let revoked = false
    if (rec?.refreshToken) {
      const token = await decrypt(env, rec.refreshToken).catch(() => null)
      if (token) revoked = (await revokeUnlessInUse(token, rec.googleSub, env, rec.clientId ?? env.GOOGLE_CLIENT_ID).catch(() => false)) === true
    }
    await note({ revokeAsked: revoked })
    return { ok: true, revokeAsked: revoked, left: 'Events already in your Google Calendar stay there.' }
  }
  if (service === 'meta') {
    const { results: running } = await db.prepare("SELECT id FROM ad_campaigns WHERE customer = ?1 AND platform = 'meta' AND status = 'active'").bind(id).all()
    if (running.length && !pauseRunning) return { ok: false, status: 409, error: (await adsHold(env, id)) ? 'ads_on_hold_pause_first' : 'campaigns_running', running: running.length }
    for (const r of running) {
      const p = await setCampaignStatus(env, customer, r.id, 'paused', `owner:${session.email}`)
      if (!p.ok) return { ok: false, status: 502, error: 'pause_failed' }
    }
    if (!(await env.GOOGLE_TOKENS.get(`ads:meta:${id}`)) && !(await db.prepare("SELECT 1 AS x FROM ad_connections WHERE customer = ?1 AND platform = 'meta'").bind(id).first())) return { ok: false, status: 404, error: 'not_connected' }
    await forgetConnection(env, 'meta', id)
    await note({ paused: running.length })
    return { ok: true, paused: running.length, revokeAsked: false }
  }
  if (service === 'gbp') {
    await forgetConnection(env, 'gbp', id)
    const r = await db.prepare('DELETE FROM gbp_connections WHERE customer = ?1').bind(id).run()
    if (!r.meta.changes) return { ok: false, status: 404, error: 'not_connected' }
    await note({})
    return { ok: true, revokeAsked: false }
  }
  return { ok: false, status: 400, error: 'invalid_request' }
}
