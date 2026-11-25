import { sealClickId } from './conversions.js'
// Lead attribution for booking-page leads. Ad clicks land on /book/:id?utm_source=google|meta&utm_campaign=<our id>.
// A lead is attributed to a campaign only when that campaign belongs to the same business; otherwise
// it is recorded as a plain booking-page lead. Stores only non-personal parameters.
const SOURCE = { google: 'google_ads', meta: 'meta_lead_form', openai: 'openai_ad_click' }
// The lead source recorded for a click on a GetShowUps campaign (ChatGPT Ads links carry utm_source=openai through the
// campaign's query_string_template, server/ads/openai.js trackingTemplate).
const CLICK_SOURCE = { google: 'google_ads', meta: 'meta_ad_click', openai: 'openai_ad_click' }

export function parseUtm(input) {
  const s = input && typeof input === 'object' ? input : {}
  const pick = (k) => (typeof s[k] === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s[k]) ? s[k] : null)
  return { source: pick('utm_source'), medium: pick('utm_medium'), campaign: pick('utm_campaign'), gclid: typeof s.gclid === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(s.gclid) ? 'present' : null }
}

// For places that keep attribution longer than a click id may be kept (a receptionist conversation): the campaign
// parameters and only WHETHER a click id was present, never the id itself.
export function keepableAttribution(raw) {
  const u = parseUtm(raw)
  const out = {}
  if (u.source) out.utm_source = u.source
  if (u.medium) out.utm_medium = u.medium
  if (u.campaign) out.utm_campaign = u.campaign
  if (u.gclid) out.gclidPresent = true
  return Object.keys(out).length ? out : null
}

export async function recordAttribution(env, customerId, leadId, rawUtm, now = Date.now()) {
  const utm = parseUtm(rawUtm)
  if (!utm.gclid && rawUtm?.gclidPresent === true) utm.gclid = 'present'
  let source = 'booking_page'
  let campaignId = null
  if (utm.campaign && SOURCE[utm.source]) {
    const row = await env.ONBOARDING_DB.prepare('SELECT id, platform FROM ad_campaigns WHERE id = ?1 AND customer = ?2').bind(utm.campaign, customerId).first()
    if (row && row.platform === utm.source) {
      source = CLICK_SOURCE[row.platform]
      campaignId = row.id
    } else if (utm.source === 'google' && /^\d{1,20}$/.test(utm.campaign)) {
      // A campaign the business runs itself in Google Ads (imported, read-only), when its links carry
      // utm_campaign=<Google campaign id>. Counted separately from GetShowUps' campaigns (never against our spend).
      const imported = await env.ONBOARDING_DB.prepare("SELECT id FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google' AND external_id = ?2").bind(customerId, utm.campaign).first().catch(() => null)
      if (imported) {
        source = 'google_ads_imported'
        campaignId = imported.id
      }
    }
  }
  // Meta website clicks are 'meta_ad_click'; Meta instant-form leads ('meta_lead_form') come from the webhook.
  // The click id itself is kept (encrypted, 90 days) only for a GetShowUps Google campaign and only when conversion
  // reporting is on (ADS_CONVERSIONS_ENABLED); otherwise just whether one was present.
  // A link that isn't one of this business's own campaigns (an ad run directly in Google/Meta/ChatGPT Ads, a newsletter,
  // a partner) keeps its utm_source/utm_campaign codes (validated, never personal), so results can still be read by source.
  const linkSource = source === 'booking_page' && utm.source ? { utmSource: utm.source, ...(utm.campaign ? { utmCampaign: utm.campaign } : {}) } : {}
  const gclidEnc = source === 'google_ads' ? await sealClickId(env, rawUtm?.gclid) : null
  await env.ONBOARDING_DB.prepare('INSERT OR IGNORE INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(leadId, customerId, source, campaignId, JSON.stringify({ medium: utm.medium, gclid: utm.gclid, ...(gclidEnc ? { gclidEnc } : {}), ...linkSource }), now)
    .run()
  return { source, campaignId }
}
