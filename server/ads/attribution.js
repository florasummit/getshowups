// Lead attribution for booking-page leads. Ad clicks land on /book/:id?utm_source=google|meta&utm_campaign=<our id>.
// A lead is attributed to a campaign only when that campaign belongs to the same business; otherwise
// it is recorded as a plain booking-page lead. Stores only non-personal parameters.
const SOURCE = { google: 'google_ads', meta: 'meta_lead_form' }

export function parseUtm(input) {
  const s = input && typeof input === 'object' ? input : {}
  const pick = (k) => (typeof s[k] === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s[k]) ? s[k] : null)
  return { source: pick('utm_source'), medium: pick('utm_medium'), campaign: pick('utm_campaign'), gclid: typeof s.gclid === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(s.gclid) ? 'present' : null }
}

export async function recordAttribution(env, customerId, leadId, rawUtm, now = Date.now()) {
  const utm = parseUtm(rawUtm)
  let source = 'booking_page'
  let campaignId = null
  if (utm.campaign && SOURCE[utm.source]) {
    const row = await env.ONBOARDING_DB.prepare('SELECT id, platform FROM ad_campaigns WHERE id = ?1 AND customer = ?2').bind(utm.campaign, customerId).first()
    if (row && row.platform === utm.source) {
      source = row.platform === 'google' ? 'google_ads' : 'meta_ad_click'
      campaignId = row.id
    }
  }
  // Meta website clicks are 'meta_ad_click'; Meta instant-form leads ('meta_lead_form') come from the webhook.
  await env.ONBOARDING_DB.prepare('INSERT OR IGNORE INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(leadId, customerId, source, campaignId, JSON.stringify({ medium: utm.medium, gclid: utm.gclid }), now)
    .run()
  return { source, campaignId }
}
