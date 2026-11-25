// Dashboard after setup. Four places: Overview (is it working, what needs me), Appointments,
// Website, Settings. Nothing technical; billing appears only when billing needs attention.
import { Suspense, useCallback, useEffect, useState } from 'react'
import { lazyPage } from '../lib/lazy.js'
import Logo from '../components/Logo.jsx'
import { api, fmt } from '../lib/api.js'
import { AvailabilityForm, BusinessForm, HoursForm, PoliciesForm, ProfileForm, ServicesForm } from './forms.jsx'
import { CloseBusiness, Notices, People, Services, SetupCheck, SignInSecurity, YourAccount, YourData } from './AccountSettings.jsx'
import PlanDetails from './PlanCard.jsx'
import { connectCalendar } from '../lib/connect.js'
import { NextStep } from './Readiness.jsx'
import Appointments, { Appointment, OutcomeList } from './Appointments.jsx'
import { AssistantButton, MetricCard, MetricHint, TitleHelp } from './Help.jsx'
import { clearMemory, setMemoryOwner } from './assistant-memory.js'
import { setAssistantView } from './assistant-store.js'
import Insight from './Insight.jsx'
import Scorecard from './Scorecard.jsx'
import { useInsights } from './insights-data.js'
import { LoadError, Pill } from './ui.jsx'

const Ads = lazyPage(() => import('./Ads.jsx'))
const GhlSettings = lazyPage(() => import('./GhlSettings.jsx'))
const WebsiteTab = lazyPage(() => import('./WebsiteTab.jsx'))
const FollowUps = lazyPage(() => import('./FollowUps.jsx'))
const Receptionist = lazyPage(() => import('./Receptionist.jsx'))
const TeachAI = lazyPage(() => import('./TeachAI.jsx'))

export function SignOut({ email, label = 'Sign out', to = '/dashboard', extra = null }) {
  const signOut = async () => {
    clearMemory() // first: also when the page is closed before the server answers
    await api('/api/auth/logout', { method: 'POST' })
    location.replace(to)
  }
  return (
    <div className="header-user">
      {extra}
      {/* Owner pages only (not /admin): the plan promises direct help from the founding team, so it is reachable from
          every owner screen, including onboarding, not just when an account has a problem. */}
      {to === '/dashboard' && (
        <a className="link-btn" href="mailto:hello@getshowups.com?subject=GetShowUps%20help">
          Help
        </a>
      )}
      <span className="header-email">{email}</span>
      <button type="button" className="link-btn" onClick={signOut}>
        {label}
      </button>
    </div>
  )
}

// ---------- billing (only for businesses that pay; pilots never see it) ----------
function useBilling() {
  const [billing, setBilling] = useState(null)
  const load = useCallback(() => api('/api/dashboard/billing').then(({ status, data }) => setBilling(status === 200 && data.configured && data.billed ? data : null)), [])
  useEffect(() => {
    load()
  }, [load])
  return [billing, load]
}

async function openBilling(body, setState) {
  setState({ busy: true })
  const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body })
  if (status === 200 && data.url) return window.location.assign(data.url)
  setState({ error: 'Billing is unavailable right now. Please try again.' })
}

const SUB_LABEL = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Ended', incomplete: 'Not completed' }
const shortDate = (ms) => fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric' })

function BillingCard({ billing, reload }) {
  const [state, setState] = useState({})
  const sub = billing.subscription
  const live = sub && !['canceled', 'incomplete', 'sandbox'].includes(sub.status)
  if (billing.complimentary) {
    return (
      <section className="card" data-billing="complimentary">
        <h2 className="card-title">Plan and billing</h2>
        <p className="status status--ok">
          <span className="status-dot" aria-hidden="true" />
          Complimentary GetShowUps account
        </p>
        <p className="fine">This business runs on GetShowUps without a subscription. There is nothing to pay here; outside services you choose (ads, your own AI keys) are billed by those providers.</p>
      </section>
    )
  }
  return (
    <section className="card">
      <h2 className="card-title">Plan and billing</h2>
      {live ? (
        <div className="form">
          <p className={`status status--${sub.status === 'past_due' ? 'bad' : 'ok'}`}>
            <span className="status-dot" aria-hidden="true" />
            {billing.plans.find((p) => p.id === sub.planId)?.name || 'Subscription'} · {SUB_LABEL[sub.status]}
            {sub.currentPeriodEnd && (
              <span className="status-detail">
                {sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {shortDate(sub.currentPeriodEnd)}
              </span>
            )}
          </p>
          <PlanDetails sub={sub} owner={billing.owner !== false} reload={reload} portal={() => openBilling({ action: 'portal' }, setState)} />
        </div>
      ) : (
        <div className="form">
          {billing.recovery && (
            <p className="notice-info" role="status" data-recovery={billing.recovery.expired ? 'ended' : 'open'}>
              Your plan ended {shortDate(billing.recovery.endedAt)}.{' '}
              {billing.recovery.expired
                ? billing.recovery.retentionScheduled
                  ? 'The 90-day recovery period is over, so this account and its data are being removed under our retention policy.'
                  : 'The 90-day recovery period is over. Reactivate to keep using GetShowUps, or contact us about your data.'
                : `Everything is kept until ${shortDate(billing.recovery.until)}. Reactivate before then and your website, bookings and settings come back as they were.${billing.recovery.retentionScheduled ? ' After that date the account and its data are removed under our retention policy.' : ''}`}
            </p>
          )}
          {sub?.status === 'sandbox' && (
            <p className="notice-info" role="status" data-billing="sandbox">
              Your earlier sign-up used a test payment, so no plan is active yet. Choose a plan to keep using GetShowUps. You haven’t been charged.
            </p>
          )}
          {billing.plans.map((p) => (
            <button key={p.id} type="button" className="btn btn-primary btn-block" disabled={state.busy} onClick={() => openBilling({ action: 'checkout', plan: p.id }, setState)}>
              {sub?.status === 'canceled' ? `Reactivate ${p.name}` : `Choose ${p.name}`}
            </button>
          ))}
        </div>
      )}
      <p className="fine">
        If you cancel, your website stays online until the end of the period you paid for, plus 14 days to move. Your domain is always yours, and you can download your website content from the Website tab.
      </p>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  )
}

function SetupCheckCard({ go }) {
  return (
    <div className="setup-check-card">
      <SetupCheck go={go} compact />
    </div>
  )
}

function AccountNotice({ customer, billing, closing, go }) {
  const [state, setState] = useState({})
  const s = billing?.subscription?.status
  if (closing)
    return (
      <div className="notice enter" role="status">
        <p>This business is closed and will be deleted on {shortDate(closing)}.</p>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => go('settings')}>
          Keep or review in Settings
        </button>
      </div>
    )
  if (customer.status !== 'suspended' && s !== 'past_due') return null
  return (
    <div className="notice enter" role="status">
      <p>{customer.status === 'suspended' ? 'Your booking page is paused.' : 'Your last payment didn’t go through.'}</p>
      {billing?.subscription?.manageable ? (
        <button type="button" className="btn btn-sm btn-primary" disabled={state.busy} onClick={() => openBilling({ action: 'portal' }, setState)}>
          Update billing
        </button>
      ) : (
        <a className="btn btn-sm btn-quiet" href="mailto:hello@getshowups.com">
          Contact us
        </a>
      )}
    </div>
  )
}

function CopyLink({ url, label = 'Copy link' }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('Copy your link', url)
    }
  }
  return (
    <button type="button" className="btn btn-quiet" onClick={copy}>
      {copied ? 'Copied' : label}
    </button>
  )
}

// ---------- overview ----------
function useOverview() {
  const [data, setData] = useState(null)
  const load = useCallback(
    () =>
      api('/api/dashboard/overview').then(({ status, data: d }) => {
        setData(status === 200 ? d : { failed: true })
      }),
    [],
  )
  useEffect(() => {
    load()
  }, [load])
  return [data, load]
}

function useSite() {
  const [site, setSite] = useState(null)
  useEffect(() => {
    api('/api/dashboard/website').then(({ status, data }) => setSite(status === 200 ? data : null))
  }, [])
  return site
}

function WebsiteCard({ me, site, go }) {
  const w = site?.website
  const url = site ? (site.domain?.status === 'connected' ? site.domain.url : site.url) : null
  return (
    <section className="card ui-site-card" aria-label="Your website">
      <div className="ui-site-card-head">
        <h2 className="card-title">Your website</h2>
        {site && (w?.published ? <Pill tone="ok">Live</Pill> : <Pill tone="neutral">Not published</Pill>)}
      </div>
      {!site ? (
        <p className="fine">Checking…</p>
      ) : w?.published ? (
        <>
          <p className="ui-site-card-status">
            <a className="ui-site-url" href={url} target="_blank" rel="noreferrer">
              {url.replace(/^https?:\/\//, '')}
            </a>{' '}
            · Live and taking bookings
          </p>
          <div className="card-actions">
            <a className="btn btn-quiet btn-sm" href={url} target="_blank" rel="noreferrer">
              View website
            </a>
            <CopyLink url={url} />
          </div>
        </>
      ) : (
        <>
          <p className="ui-site-card-status">Your website isn’t published yet. Customers can still book with your booking link.</p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => go('website')}>
              Finish my website
            </button>
            <CopyLink url={me.bookingUrl} label="Copy booking link" />
          </div>
        </>
      )}
    </section>
  )
}

// Results from real records only. A rate appears once there are enough recorded outcomes to mean something;
// until then it says so instead of showing 0%.
function Stats({ stats, visit, upcoming }) {
  const recorded = stats.showed + stats.noShow
  const rows = [
    ['New inquiries', stats.leads, 'inquiries', 'people who left details'],
    ['Booked', stats.booked, 'booked', 'cancelled ones left out'],
    [visit ? 'Visits' : 'Show-ups', stats.showed, 'showed', 'you marked as happened'],
  ]
  if (!visit && recorded >= 5) rows.push(['Show-up rate', `${stats.showRate}%`, 'show_rate'])
  if (visit && stats.completed + stats.notCompleted >= 5) rows.push(['Jobs completed', `${stats.completionRate}%`, 'completed'])
  const pendingRate = visit ? stats.completed + stats.notCompleted < 5 : recorded < 5
  return (
    <section aria-label="Last 30 days">
      <div className="ui-section-head ui-section-head--flush">
        <h2 className="ui-section-title">Last 30 days</h2>
        <span className="fine">{upcoming} upcoming</span>
      </div>
      <div className={`stats stats--${rows.length}`}>
        {rows.map(([label, value, topic, hint]) => (
          <MetricCard key={label} topic={topic} label={label} value={value} hint={hint} />
        ))}
      </div>
      <MetricHint />
      {pendingRate && <p className="fine stats-note">{visit ? 'Job completion rate' : 'Show-up rate'} appears after 5 recorded outcomes.</p>}
    </section>
  )
}

// What needs the owner, most urgent first. Each item has one obvious action. Empty → "All caught up".
function Attention({ data, go }) {
  const { items, unread } = data.attention
  return (
    <section className="card ui-attention" aria-label="Needs your attention">
      <h2 className="card-title">Needs your attention</h2>
      {items.length ? (
        <ul className="ui-attention-list">
          {items.map((i) => (
            <li key={i.text}>
              <span className="ui-attention-text">
                <Pill tone={i.urgent ? 'bad' : 'warn'}>{i.tag}</Pill> {i.text}
              </span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => go(i.page)}>
                {i.label}
              </button>
            </li>
          ))}
        </ul>
      ) : unread.length ? null : (
        <p className="ui-all-clear">
          <Pill tone="ok">All caught up</Pill> Nobody is waiting on you.
        </p>
      )}
      {unread.length > 0 && <p className="fine">Some of this couldn’t be checked just now.</p>}
    </section>
  )
}

// Whole dollars when exact, cents otherwise; '—' when unavailable (never an estimate).
const money = (cents) => {
  if (cents === null || cents === undefined) return '—'
  const exact = cents % 100 === 0
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: exact ? 0 : 2, maximumFractionDigits: exact ? 0 : 2 })}`
}

// Advertising results (shown only while the Ads feature is on). '—' means not available yet: no ad
// spend has been recorded, or there is nothing to divide by.
function AdsResults({ ads }) {
  const missing = (topic) => (topic === 'ad_clicks' ? 'Google has reported no clicks yet.' : ads.spendCents == null ? 'No ad spend reported yet.' : 'Nothing to divide the spend by yet.')
  const tiles = [
    ['Ad spend', money(ads.spendCents), 'ad_spend'],
    ['Clicks', ads.clicks ?? '—', 'ad_clicks'],
    ['Leads from ads', ads.leads, 'ad_leads'],
    ['Bookings', ads.booked, 'ad_booked'],
    ['Show-ups', ads.showed, 'ad_showed'],
    ['Cost per booking', money(ads.costPerBookingCents), 'cost_per_booking', 'spend ÷ bookings'],
    ['Cost per show-up', money(ads.costPerShowUpCents), 'cost_per_showup', 'spend ÷ show-ups'],
  ]
  return (
    <section aria-label="Advertising, last 30 days" data-ads-results>
      <h2 className="card-title">Advertising</h2>
      <div className="stats">
        {tiles.map(([label, value, topic, hint]) => (
          <MetricCard key={label} topic={topic} label={label} value={value} hint={hint} missing={missing(topic)} note={ads.testAccount ? 'Google Ads test account: not a business result' : undefined} />
        ))}
      </div>
      <p className="fine stats-note">
        {ads.spendCents === null && !ads.leads && !ads.booked
          ? 'Nothing recorded yet: connect an ad account in the Ads tab and spend, leads and cost per booking appear here. — means not available yet.'
          : `Last 30 days · — means not available yet${ads.spendCents === null ? ' (no ad spend recorded)' : ''}.`}
        {ads.testAccount && ' Google Ads test account: no real ads ran, so these are test figures, not business results.'}
      </p>
    </section>
  )
}

function Overview({ me, data, reload, go, site, insight }) {
  const tz = me.customer.timezone
  const visit = me.customer.appointmentMode === 'at_customer'
  return (
    <>
      <NextStep onOpen={go} skip={site && !site.website?.published ? ['page'] : []} />
      {!data && <div className="ui-skeleton-block" aria-busy="true" />}
      {data?.failed && (
        <LoadError what="your results" onRetry={reload} />
      )}
      {data && !data.failed && (
        <div className="enter ui-overview">
          <Attention data={data} go={go} />
          <Stats stats={data.stats} visit={visit} upcoming={data.upcoming.filter((a) => !a.test).length} />
          {insight}
          <Scorecard />
          {data.ads && <AdsResults ads={data.ads} />}
          {data.needsOutcome.length > 0 && (
            <section className="card">
              <h2 className="card-title">{visit ? 'How did these visits go?' : 'Did they show up?'}</h2>
              <OutcomeList items={data.needsOutcome.slice(0, 3)} tz={tz} visit={visit} onDone={reload} simple />
              {data.needsOutcome.length > 3 && (
                <button type="button" className="link-btn" onClick={() => go('appointments')}>
                  See all {data.needsOutcome.length}
                </button>
              )}
            </section>
          )}
          <section className="card">
            <h2 className="card-title">Upcoming</h2>
            {data.upcoming.length ? (
              <ul className="rows">
                {data.upcoming.slice(0, 3).map((a) => (
                  <Appointment key={a.id} a={a} tz={tz} compact />
                ))}
              </ul>
            ) : (
              <p className="empty">No upcoming {visit ? 'visits' : 'appointments'} yet.</p>
            )}
            <button type="button" className="link-btn" onClick={() => go('appointments')}>
              All appointments
            </button>
          </section>
        </div>
      )}
      <WebsiteCard me={me} site={site} go={go} />
    </>
  )
}

// ---------- settings ----------
const CAL_STATUS = { healthy: ['Connected', 'ok'], not_connected: ['Not connected', 'bad'], reconnect_required: ['Needs reconnecting', 'bad'] }

function CalendarSettings() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api('/api/dashboard/calendar').then(({ status: s, data }) => setStatus(s === 200 ? data : { status: 'error' }))
  }, [])
  const [label, tone] = CAL_STATUS[status?.status] || ['Couldn’t check right now', 'bad']
  const reconnect = async () => {
    setBusy(true)
    if (!(await connectCalendar())) setBusy(false)
  }
  return (
    <div className="form">
      {status ? (
        <p className={`status status--${tone}`} data-status={status.status}>
          <span className="status-dot" aria-hidden="true" />
          {label}
          {status.account?.email && <span className="status-detail">{status.account.email}</span>}
        </p>
      ) : (
        <p className="fine">Checking…</p>
      )}
      {tone !== 'ok' || !status ? (
        <button type="button" className="btn btn-block btn-primary" onClick={reconnect} disabled={busy || !status}>
          {busy ? 'Opening Google…' : 'Reconnect Google Calendar'}
        </button>
      ) : (
        <button type="button" className="link-btn" onClick={reconnect} disabled={busy}>
          Use a different calendar
        </button>
      )}
    </div>
  )
}

// Reminders: on/off and whether they're actually sending yet. Never shown as a failure.
function Reminders() {
  const [a, setA] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api('/api/dashboard/overview').then(({ status, data }) => setA(status === 200 ? data.automation : { failed: true })), [])
  useEffect(() => {
    load()
  }, [load])
  if (!a) return <div aria-busy="true" />
  if (a.failed) return <LoadError what="reminders" onRetry={load} />
  const sending = a.enabled && (a.email || a.sms) && !a.testMode
  const toggle = async () => {
    setBusy(true)
    const { status } = await api('/api/dashboard/automations', { method: 'POST', body: { enabled: !a.enabled } })
    setError(status === 200 ? '' : 'Couldn’t change this. Please try again.')
    if (status === 200) await load()
    setBusy(false)
  }
  return (
    <div className="form">
      <p className="fine" data-automation={!a.enabled ? 'off' : sending ? 'live' : 'activating'}>
        {!a.enabled
          ? 'Off. Customers won’t get reminders.'
          : sending
            ? 'On. Customers get a confirmation and reminders before their appointment.'
            : 'On. Email confirmations and reminders are activating soon; we’ll let you know when they start sending.'}
      </p>
      <button type="button" className="link-btn" disabled={busy} onClick={toggle}>
        {a.enabled ? 'Turn reminders off' : 'Turn reminders on'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function Settings({ me, reload, billing, reloadBilling, go }) {
  const c = me.customer
  return (
    <div className="enter">
      <h1 className="title title--page">Settings</h1>
      <nav className="settings-nav" aria-label="Settings sections">
        {[
          ['business', 'Business'],
          ['services', 'Services'],
          ['booking-hours', 'Booking'],
          ['connected', 'Connections'],
          ['people', 'People'],
          ...(billing ? [['plan', 'Plan']] : []),
          ['notifications', 'Notifications'],
          ['data', 'Your data'],
          ['close', 'Close'],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <section className="card" aria-labelledby="setup-check-title">
        <h2 className="card-title" id="setup-check-title">
          Setup check
        </h2>
        <SetupCheck go={go} />
      </section>
      <section className="card" id="business">
        <TitleHelp help="service_area">Business</TitleHelp>
        <BusinessForm key={c.serviceZips.join()} customer={c} submitLabel="Save business" onSaved={reload} />
      </section>
      <section className="card" id="services">
        <h2 className="card-title">Services and prices</h2>
        <ServicesForm />
      </section>
      <section className="card" id="details">
        <TitleHelp help="website_details">Details on your website</TitleHelp>
        <ProfileForm />
      </section>
      <section className="card" id="policies">
        <TitleHelp help="policies">What customers should know</TitleHelp>
        <PoliciesForm />
      </section>
      <section className="card" id="booking-hours">
        <TitleHelp help="hours">Booking hours</TitleHelp>
        <HoursForm customer={c} submitLabel="Save hours" onSaved={reload} />
      </section>
      <section className="card" id="closed-dates">
        <h2 className="card-title">Closed dates and notice</h2>
        <AvailabilityForm />
      </section>
      <section className="card" id="google-calendar">
        <TitleHelp help="calendar">Google Calendar</TitleHelp>
        <CalendarSettings />
      </section>
      <section className="card">
        <TitleHelp help="reminders">Reminders</TitleHelp>
        <Reminders />
      </section>
      <div id="plan">{billing && <BillingCard billing={billing} reload={reloadBilling} />}</div>
      {me.features?.ghl && (
        <section className="card">
          <h2 className="card-title">GoHighLevel</h2>
          <Suspense fallback={<div aria-busy="true" />}>
            <GhlSettings />
          </Suspense>
        </section>
      )}
      <section className="card" id="connected">
        <h2 className="card-title">Connected services</h2>
        <Services go={go} />
      </section>
      <section className="card" id="people">
        <h2 className="card-title">People</h2>
        <People />
      </section>
      <section className="card">
        <h2 className="card-title">Sign-in and security</h2>
        <SignInSecurity />
        <p className="fine">
          How we use and protect data: <a href="/privacy">Privacy policy</a>. Questions or requests: <a href="mailto:hello@getshowups.com">hello@getshowups.com</a>.
        </p>
      </section>
      <section className="card" id="notifications">
        <h2 className="card-title">Notifications to you</h2>
        <Notices />
      </section>
      <section className="card" id="data">
        <h2 className="card-title">Your data</h2>
        <YourData />
      </section>
      <section className="card" id="close">
        <h2 className="card-title">Close the business</h2>
        <CloseBusiness />
      </section>
      <section className="card">
        <h2 className="card-title">Your own account</h2>
        <YourAccount />
      </section>
    </div>
  )
}

// ---------- shell ----------
const TABS = [
  ['overview', 'Overview'],
  ['appointments', 'Appointments'],
  ['followups', 'Follow-ups'],
  ['receptionist', 'Receptionist'],
  ['website', 'Website'],
  ['settings', 'Settings'],
]
const tabFromPath = () => {
  const t = window.location.pathname.split('/')[2]
  return ['appointments', 'followups', 'receptionist', 'teach', 'website', 'settings', 'ads'].includes(t) ? t : 'overview'
}

export default function Home({ me, reload }) {
  const [requested, setView] = useState(tabFromPath)
  // /dashboard/ads (or /teach) for a business without that feature (e.g. back from a refused ad sign-in) → Overview.
  const view = (requested === 'ads' && !me.features?.ads) || (requested === 'teach' && !me.features?.teachAi) ? 'overview' : requested
  const [found, dropInsight] = useInsights(view)
  const [billing, reloadBilling] = useBilling()
  const [data, loadOverview] = useOverview()
  const site = useSite()
  // Teach Your AI (after Receptionist) and Ads (before Settings) exist for every eligible business (server/eligibility.js);
  // the API says when they don't (before payment, suspended, emergency switch) and the tab is then simply absent.
  const base = me.features?.teachAi ? TABS.flatMap((t) => (t[0] === 'receptionist' ? [t, ['teach', 'Teach Your AI']] : [t])) : TABS
  const tabs = me.features?.ads ? [...base.slice(0, -1), ['ads', 'Ads'], base.at(-1)] : base
  useEffect(() => {
    const onPop = () => setView(tabFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => setAssistantView(view), [view])
  setMemoryOwner(`${me.customer.id}:${me.email}`)
  useEffect(() => {
    const on = () => {
      reload()
      loadOverview()
    }
    window.addEventListener('gsu:changed', on)
    return () => window.removeEventListener('gsu:changed', on)
  }, [reload, loadOverview])
  // On narrow screens the tab bar scrolls: keep the current tab in view.
  useEffect(() => {
    document.querySelector('.tabs [aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [view])
  const go = (where) => {
    const tab = where === 'billing' ? 'settings' : where
    if (tab !== view && document.querySelector('.app-main form[data-dirty]') && !window.confirm('You have changes that aren’t saved. Leave this page and lose them?')) return
    if (where === 'billing' && billing?.subscription?.status === 'past_due' && billing.subscription.manageable) return openBilling({ action: 'portal' }, () => {})
    window.history.pushState(null, '', tab === 'overview' ? '/dashboard' : `/dashboard/${tab}`)
    setView(tab)
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const on = (e) => go(e.detail)
    window.addEventListener('gsu:go', on)
    return () => window.removeEventListener('gsu:go', on)
  })
  return (
    <div className={`app${view === 'website' || view === 'followups' || view === 'teach' ? ' app--wide' : ''}`}>
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={me.email} extra={<AssistantButton />} />
      </header>
      <nav className="tabs" aria-label="Dashboard">
        {tabs.map(([id, label]) => (
          <a
            key={id}
            href={id === 'overview' ? '/dashboard' : `/dashboard/${id}`}
            aria-current={view === id ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault()
              go(id)
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {/* A form someone typed in is marked until it is submitted, so changing tabs never silently drops the text. */}
      <main
        className="app-main"
        onInput={(e) => e.target.closest?.('form')?.setAttribute('data-dirty', '')}
        onSubmit={(e) => e.target.removeAttribute?.('data-dirty')}
      >
        {view !== 'overview' && <Insight view={view} list={found} drop={dropInsight} go={go} />}
        {view === 'overview' && (
          <>
            <h1 className="ui-page-title ui-page-title--top">{me.customer.name}</h1>
            <AccountNotice customer={me.customer} billing={billing} closing={me.closing} go={go} />
            <SetupCheckCard go={go} />
            <Overview me={me} data={data} reload={loadOverview} go={go} site={site} insight={<Insight view="overview" list={found} drop={dropInsight} go={go} covered={data?.followUp?.some((l) => !l.test && l.status === 'new') ? ['unanswered'] : []} />} />
          </>
        )}
        {view === 'appointments' && <Appointments me={me} data={data} reload={loadOverview} />}
        {view === 'followups' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <FollowUps />
          </Suspense>
        )}
        {view === 'receptionist' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <Receptionist />
          </Suspense>
        )}
        {view === 'teach' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <TeachAI />
          </Suspense>
        )}
        {view === 'website' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <WebsiteTab />
          </Suspense>
        )}
        {view === 'ads' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <Ads />
          </Suspense>
        )}
        {view === 'settings' && <Settings me={me} reload={reload} billing={billing} reloadBilling={reloadBilling} go={go} />}
      </main>
    </div>
  )
}
