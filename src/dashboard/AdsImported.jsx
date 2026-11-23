// Campaigns that already exist in the business's Google Ads account (Journey A: they advertise already). A read-only
// copy read from Google (/api/dashboard/ads/imported): what runs, what it costs, what Google counts as conversions,
// and each Search campaign's settings in plain words. Nothing here changes a campaign; GetShowUps' own campaigns
// are the cards below this section.
import { useEffect, useState } from 'react'
import { api, timeAgo } from '../lib/api.js'
import { Pill } from './ui.jsx'

const usd = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`)
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const STATE = {
  running: ['ok', 'Running'],
  paused: ['neutral', 'Paused'],
  ended: ['neutral', 'Ended'],
  scheduled: ['info', 'Scheduled'],
  'not serving': ['warn', 'Not serving'],
  removed: ['neutral', 'Removed'],
  other: ['neutral', 'Other'],
}
const BIDDING = {
  TARGET_SPEND: 'Maximize clicks',
  MAXIMIZE_CONVERSIONS: 'Maximize conversions',
  MAXIMIZE_CONVERSION_VALUE: 'Maximize conversion value',
  TARGET_CPA: 'Target cost per action',
  TARGET_ROAS: 'Target return on ad spend',
  MANUAL_CPC: 'Manual cost per click',
  TARGET_IMPRESSION_SHARE: 'Target impression share',
  MANUAL_CPA: 'Manual cost per lead',
}
const ERRORS = {
  not_connected: 'Choose a Google Ads account first.',
  needs_account: 'Choose a Google Ads account first.',
  reconnect_required: 'Reconnect Google Ads; access has expired.',
  not_approved_for_production: 'Google only lets GetShowUps read Google Ads test accounts for now.',
  permission_denied: 'This Google sign-in doesn’t have permission for that Google Ads account.',
  transient: 'Google Ads didn’t respond. Please try again in a minute.',
  quota_exhausted: 'Google Ads is busy. Please try again in a few minutes.',
  not_ready: 'Not available yet.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
}
const words = (xs, max = 6) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`)

const LEAD_TYPE = { PHONE_CALL: 'phone call', MESSAGE: 'message', BOOKING: 'booking', COUNT: 'coupon', UNKNOWN: 'other' }
const LEAD_STATUS = { NEW: 'New', ACTIVE: 'Active', BOOKED: 'Booked', DECLINED: 'Declined', CONSUMER_DECLINED: 'Customer declined', EXPIRED: 'Expired', DISABLED: 'Disabled', WIPED_OUT: 'Removed', UNKNOWN: 'Other' }
const when = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// Google's Local Services leads for one campaign: counts, cost per charged lead, the recent ones (no contact details).
function LocalServicesLeads({ leads }) {
  const types = Object.entries(leads.byType || {}).map(([t, n]) => `${n} ${LEAD_TYPE[t] || 'other'}${n === 1 ? '' : 's'}`)
  return (
    <>
      <div>
        <dt>Leads from Google</dt>
        <dd data-lsa-leads>
          {leads.total ? `${leads.total} lead${leads.total === 1 ? '' : 's'} (${types.join(', ')}) · ${leads.charged} charged${leads.credited ? `, ${leads.credited} credited back` : ''}${leads.booked ? ` · ${leads.booked} marked booked in Google` : ''}` : 'No leads reported by Google in this period.'}
        </dd>
      </div>
      <div>
        <dt>Cost per charged lead</dt>
        <dd data-lsa-cpl>{leads.costPerChargedLeadCents != null ? `${usd(leads.costPerChargedLeadCents)} (${usd(leads.spendCents)} ÷ ${leads.charged})` : leads.spendCents != null && leads.spendCents > 0 ? `— (${usd(leads.spendCents)} spent, no charged lead yet)` : '— (no spend reported)'}</dd>
      </div>
      {leads.recent?.length > 0 && (
        <div>
          <dt>Recent leads</dt>
          <dd>
            <ul className="ai-leads">
              {leads.recent.slice(0, 8).map((l) => (
                <li key={l.id}>
                  {when(l.createdAt)} · {LEAD_TYPE[l.type] || 'other'} · {LEAD_STATUS[l.status] || 'Other'}
                  {l.charged ? ' · charged' : ''}
                  {l.creditState === 'CREDITED' ? ' · credited' : l.creditState === 'PENDING' ? ' · credit pending' : ''}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      <div>
        <dt>Note</dt>
        <dd>These are Google’s lead records (who called or messaged through the ad). GetShowUps’ own leads and bookings are in Results.</dd>
      </div>
    </>
  )
}

function Settings({ c }) {
  const s = c.settings || {}
  if (c.channelType !== 'SEARCH') {
    return (
      <dl className="ai-body">
        {c.channelType === 'LOCAL_SERVICES' && c.leads && <LocalServicesLeads leads={c.leads} />}
        <div>
          <dt>What GetShowUps reads</dt>
          <dd>For {c.channelLabel} campaigns Google exposes status, budget and results here; settings stay in Google Ads.</dd>
        </div>
        {(s.startDate || s.endDate) && (
          <div>
            <dt>Dates</dt>
            <dd>{[s.startDate, s.endDate ? `until ${s.endDate}` : null].filter(Boolean).join(' ')}</dd>
          </div>
        )}
      </dl>
    )
  }
  const locations = (s.locations || []).map((l) => l.name).filter(Boolean)
  const ad = (s.ads || [])[0]
  return (
    <dl className="ai-body">
      <div>
        <dt>Where</dt>
        <dd>
          {locations.length ? words(locations, 5) : s.locationIds?.length ? `${s.locationIds.length} location${s.locationIds.length === 1 ? '' : 's'}` : 'No location targeting read'}
          {s.geoTargetType === 'PRESENCE' ? ' · people in the area' : s.geoTargetType === 'PRESENCE_OR_INTEREST' ? ' · people in or interested in the area' : ''}
          {s.languages ? ` · ${s.languages} language${s.languages === 1 ? '' : 's'}` : ''}
          {s.adSchedules ? ` · ad schedule set` : ''}
        </dd>
      </div>
      <div>
        <dt>Keywords</dt>
        <dd>
          {s.keywords?.length ? `${s.keywords.length}: ${words(s.keywords.map((k) => k.text), 10)}` : 'None read'}
          {s.negativeKeywords?.length ? ` · ${s.negativeKeywords.length} excluded search${s.negativeKeywords.length === 1 ? '' : 'es'}` : ''}
        </dd>
      </div>
      <div>
        <dt>Ads</dt>
        <dd>
          {s.ads?.length ? `${s.ads.length} ad${s.ads.length === 1 ? '' : 's'} in ${s.adGroups?.length || 0} ad group${s.adGroups?.length === 1 ? '' : 's'}` : 'No ads read'}
          {ad?.headlines?.length ? <span className="ai-ad"> · {ad.headlines.slice(0, 3).join(' | ')}{ad.descriptions?.[0] ? ` — ${ad.descriptions[0]}` : ''}</span> : null}
        </dd>
      </div>
      <div>
        <dt>Landing page</dt>
        <dd>{s.finalUrls?.length ? words(s.finalUrls, 2) : 'None read'}</dd>
      </div>
      <div>
        <dt>Bidding and goals</dt>
        <dd>
          {BIDDING[s.bidding] || s.bidding || 'Not read'}
          {s.networks?.searchPartners ? ' · search partners on' : ''}
          {s.networks?.display ? ' · Display Network on' : ''}
          {s.conversionGoals?.length ? ` · goals: ${words([...new Set(s.conversionGoals.map((g) => g.category.toLowerCase().replace(/_/g, ' ')))], 4)}` : ' · no conversion goals read'}
        </dd>
      </div>
      {(s.startDate || s.endDate) && (
        <div>
          <dt>Dates</dt>
          <dd>{[s.startDate, s.endDate ? `until ${s.endDate}` : null].filter(Boolean).join(' ')}</dd>
        </div>
      )}
    </dl>
  )
}

export default function AdsImported() {
  const [days, setDays] = useState(30)
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    api(`/api/dashboard/ads/imported?days=${days}`).then(({ status, data }) => live && setD(status === 200 ? data : { failed: true }))
    return () => {
      live = false
    }
  }, [days])
  const refresh = async () => {
    setBusy(true)
    setErr(null)
    const { status, data } = await api('/api/dashboard/ads/imported', { method: 'POST', body: { action: 'refresh', days } })
    setBusy(false)
    if (status === 200) setD(data)
    else setErr(status === 429 ? ERRORS.rate_limited : ERRORS[data?.error] || 'Couldn’t read your Google Ads account. Try again in a minute.')
  }
  if (!d) return <div className="ui-skeleton-block" aria-busy="true" />
  if (d.failed || !d.ready) return null // not available (migration not applied, or a load error the next load fixes): never a broken section
  const live = d.campaigns.filter((c) => c.status !== 'REMOVED')
  const removed = d.campaigns.length - live.length
  return (
    <section className="ui-section ai" aria-label="Campaigns in your Google Ads account" data-imported data-imported-count={live.length}>
      <div className="ui-section-head">
        <h2 className="ui-section-title">Your Google Ads campaigns</h2>
        <div className="fchips" role="group" aria-label="Period">
          {[7, 30, 90].map((n) => (
            <button key={n} type="button" className="fchip" aria-pressed={days === n} onClick={() => setDays(n)}>
              {n} days
            </button>
          ))}
        </div>
      </div>
      <p className="ar-source" data-imported-source>
        {d.syncedAt ? `Read from Google ${timeAgo(d.syncedAt)}` : 'Not read from Google yet'}
        {live.length ? ` · ${live.length} campaign${live.length === 1 ? '' : 's'}, ${d.totals.running} running` : ''}
        {d.lastResult?.error ? ` · last read failed (${ERRORS[d.lastResult.error] || 'Google Ads didn’t answer'})` : d.lastResult?.partial ? ' · some settings couldn’t be read' : ''}
        {' · '}
        <button type="button" className="link-btn" onClick={refresh} disabled={busy} data-imported-refresh>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </p>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      {!live.length ? (
        <p className="fine" data-imported-empty>
          {d.syncedAt ? 'No other campaigns in this account. Campaigns GetShowUps creates for you appear below.' : 'Press Refresh to read the campaigns already in this account.'}
        </p>
      ) : (
        <>
          <div className="ai-head" aria-hidden="true">
            <span>Campaign</span>
            <span>Daily budget</span>
            <span>Spend</span>
            <span>Clicks</span>
            <span>Google conversions</span>
          </div>
          <ul className="ai-list">
            {live.map((c) => {
              const [tone, label] = STATE[c.state] || STATE.other
              return (
                <li key={c.id}>
                  <details className="ai-item" data-imported-campaign={c.externalId}>
                    <summary>
                      <span className="ai-name">
                        <span>{c.name || 'Untitled campaign'}</span>
                        <span className="chip">{c.channelLabel}</span>
                        <Pill tone={tone}>{label}</Pill>
                      </span>
                      <span className="ai-num">
                        <small>Daily budget</small>
                        {c.sharedBudget ? 'shared' : c.dailyBudgetCents != null ? `${usd(c.dailyBudgetCents)}/day` : '—'}
                      </span>
                      <span className="ai-num">
                        <small>Spend</small>
                        {usd(c.metrics?.spendCents ?? null)}
                      </span>
                      <span className="ai-num">
                        <small>Clicks</small>
                        {num(c.metrics?.clicks ?? null)}
                      </span>
                      <span className="ai-num">
                        <small>Google conversions</small>
                        {num(c.metrics?.conversions ?? null)}
                      </span>
                    </summary>
                    <Settings c={c} />
                  </details>
                </li>
              )
            })}
          </ul>
          <p className="fine">
            Last {d.days} days, Google’s own numbers (spend, clicks and what Google counts as conversions). Leads and bookings in Results are GetShowUps’ records. Read only: GetShowUps never changes these campaigns.
            {removed ? ` ${removed} campaign${removed === 1 ? '' : 's'} removed in Google Ads ${removed === 1 ? 'is' : 'are'} no longer shown.` : ''}
          </p>
        </>
      )}
      {d.localServices?.readiness && <LocalServicesReadiness r={d.localServices.readiness} />}
    </section>
  )
}

const READY_STATE = { done: ['ok', 'On record'], likely: ['ok', 'Likely'], check: ['warn', 'Check'], owner: ['neutral', 'You, with Google'] }
// A business without Local Services Ads: what Google needs, as facts; the setup is Google's own.
function LocalServicesReadiness({ r }) {
  return (
    <details className="ai-readiness" data-lsa-readiness>
      <summary>Local Services Ads (pay per lead): what Google needs before you can run them</summary>
      <ul className="ai-ready-list">
        {r.items.map((i) => {
          const [tone, label] = READY_STATE[i.state] || READY_STATE.owner
          return (
            <li key={i.id}>
              <span className="ai-ready-main">
                <strong>{i.label}</strong>
                <span className="fine">{i.detail}</span>
              </span>
              <Pill tone={tone}>{label}</Pill>
            </li>
          )
        })}
      </ul>
      <p className="fine">
        {r.note}{' '}
        <a href={r.setupUrl} target="_blank" rel="noreferrer">
          Start with Google
        </a>
      </p>
    </details>
  )
}
