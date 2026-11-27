// Dashboard after setup. Four places: Overview (is it working, what needs me), Appointments,
// Website, Settings. Nothing technical; billing appears only when billing needs attention.
import { Suspense, useCallback, useEffect, useState } from 'react'
import { lazyPage } from '../lib/lazy.js'
import Logo from '../components/Logo.jsx'
import { api, fmt } from '../lib/api.js'
import { AvailabilityForm, BusinessAddressForm, BusinessForm, HoursForm, PoliciesForm, ProfileForm, ServicesForm } from './forms.jsx'
import { CalendarDisconnect, CloseBusiness, Notices, People, Services, SetupCheck, SignInSecurity, YourAccount, YourData } from './AccountSettings.jsx'
import PlanDetails from './PlanCard.jsx'
import { connectCalendar } from '../lib/connect.js'
import { NextStep } from './Readiness.jsx'
import Appointments, { Appointment, OutcomeList } from './Appointments.jsx'
import { AssistantButton, HelpButton, MetricCard, MetricHint, TitleHelp } from './Help.jsx'
import { clearMemory, setMemoryOwner } from './assistant-memory.js'
import { setAssistantView } from './assistant-store.js'
import Insight from './Insight.jsx'
import Scorecard from './Scorecard.jsx'
import { useInsights } from './insights-data.js'
import { LoadError, Pill, TabBar } from './ui.jsx'
import { plural } from '../lib/format.js'
import CopyLink from './CopyLink.jsx'
import { scrollToCard } from './owner-lib.js'
import { usePageTitle } from './ui-hooks.js'

const Ads = lazyPage(() => import('./Ads.jsx'))
const GhlSettings = lazyPage(() => import('./GhlSettings.jsx'))
const PhoneSettings = lazyPage(() => import('./PhoneSettings.jsx'))
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
          every owner screen, including onboarding, not just when an account has a problem. It opens help in the page
          (topics + our address as text): a bare mailto link does nothing in a browser without a mail program. */}
      {to === '/dashboard' && <HelpButton />}
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
            <CopyLink url={url} label="Copy website link" />
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
    // DASH-08: each tile says which date it counts by (the assistant counts the same way: operator-tools.js rangeStats).
    ['New inquiries', stats.leads, 'inquiries', 'came in these 30 days'],
    ['Booked', stats.booked, 'booked', 'bookings made these 30 days, cancelled left out'],
    [visit ? 'Visits' : 'Show-ups', stats.showed, 'showed', 'scheduled these 30 days, marked as happened'],
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

// What needs the owner: ONE list, most urgent first. People who are waiting come before setup notices (the same items
// Settings → Setup check lists, here without the optional ones). One vocabulary for severity everywhere: Urgent, Important
// (and Optional, in Settings only). Each row has one obvious action; a notice the owner may ignore can be dismissed.
const SETUP_ROWS = 3
const OPEN_LABEL = { settings: 'Fix in Settings', receptionist: 'Open receptionist', website: 'Open website', appointments: 'Open appointments' }
function Attention({ attention, failed, go }) {
  const [setup, setSetup] = useState(undefined)
  const [error, setError] = useState('')
  const load = useCallback(() => api('/api/dashboard/setup-check').then(({ status, data }) => setSetup(status === 200 ? data : null)), [])
  useEffect(() => {
    load()
    window.addEventListener('gsu:settings-saved', load)
    return () => window.removeEventListener('gsu:settings-saved', load)
  }, [load])
  const dismiss = async (id) => {
    setError('')
    const { status, data } = await api('/api/dashboard/setup-check', { method: 'POST', body: { id, action: 'dismiss' } })
    if (status === 200) setSetup(data)
    else setError('Couldn’t save that. Please try again.')
  }
  if (!attention && setup === undefined) return <div className="ui-skeleton-block" aria-busy="true" />
  const fixes = (setup?.items || []).filter((x) => x.level !== 'optional')
  const rows = [
    // "Review" lands on the card where those people are listed, each with a way to reach them.
    ...(attention?.items || []).map((i) => ({ key: i.id || i.text, urgent: i.urgent, text: i.text, label: i.label, where: ['unbooked', 'coverage'].includes(i.id) ? 'appointments#not-booked' : i.page })),
    ...fixes.slice(0, SETUP_ROWS).map((x) => ({ key: `setup-${x.id}`, check: x.id, urgent: x.level === 'critical', text: x.title, sub: `${x.why} ${x.fix}`, label: OPEN_LABEL[x.where.split('#')[0]] || 'Open', where: x.where, dismiss: x.dismiss })),
  ]
  const unread = (attention?.unread.length || 0) + (setup?.unread.length || 0) + (setup === null ? 1 : 0) + (failed ? 1 : 0)
  return (
    <section className="card ui-attention" aria-label="Needs your attention">
      <h2 className="card-title">Needs your attention</h2>
      {rows.length ? (
        <ul className="ui-attention-list">
          {rows.map((r) => (
            <li key={r.key} data-attention={r.urgent ? 'urgent' : 'important'} data-check={r.check}>
              <span className="ui-attention-text">
                <Pill tone={r.urgent ? 'bad' : 'warn'}>{r.urgent ? 'Urgent' : 'Important'}</Pill> {r.text}
                {r.sub && <span className="ui-attention-sub">{r.sub}</span>}
              </span>
              <span className="ui-attention-actions">
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => go(r.where)}>
                  {r.label}
                </button>
                {r.dismiss && (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => dismiss(r.check)} data-dismiss={r.check}>
                    {r.dismiss}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : unread ? null : (
        <p className="ui-all-clear">
          <Pill tone="ok">All caught up</Pill> Nobody is waiting on you.
        </p>
      )}
      {fixes.length > SETUP_ROWS && (
        <button type="button" className="link-btn" onClick={() => go('settings#setup-check')}>
          {plural(fixes.length - SETUP_ROWS, 'more setup notice')} in Settings
        </button>
      )}
      {unread > 0 && <p className="fine">Some of this couldn’t be checked just now.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
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
  const ok = data && !data.failed
  return (
    <>
      {/* First: who and what needs the owner (on a phone an urgent row is inside the first screen). Then the day's work
          (outcomes to record, what is coming up), then the one setup step, then numbers. */}
      <Attention attention={ok ? data.attention : null} failed={Boolean(data?.failed)} go={go} />
      {data?.failed && <LoadError what="your results" onRetry={reload} />}
      {ok && (
        <div className="enter ui-overview">
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
      <NextStep onOpen={go} skip={site && !site.website?.published ? ['page'] : []} bookingUrl={me.bookingUrl} />
      {ok && (
        <div className="enter ui-overview">
          <Stats stats={data.stats} visit={visit} upcoming={data.upcoming.filter((a) => !a.test).length} />
          {insight}
          <Scorecard />
          {data.ads && <AdsResults ads={data.ads} />}
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
    const load = () => api('/api/dashboard/calendar').then(({ status: s, data }) => setStatus(s === 200 ? data : { status: 'error' }))
    load()
    // Disconnected just below (CalendarDisconnect): the status line follows.
    window.addEventListener('gsu:settings-saved', load)
    return () => window.removeEventListener('gsu:settings-saved', load)
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
      {/* Shown once, here: what stops if it is disconnected, and the disconnect itself (not a second row further down). */}
      {tone === 'ok' && <CalendarDisconnect />}
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

// Every card of the page, in order: [id, the card's heading, short name for the menu]. The menu stays in reach while the
// page scrolls (a row of links on a wide screen, one "Jump to" control on a phone), so no card is a long scroll away.
const settingsSections = ({ plan, ghl, phone }) =>
  [
    ['setup-check', 'Setup check'],
    ['business', 'Business'],
    ['services', 'Services and prices', 'Services'],
    ['details', 'Details on your website (phone number)', 'Phone and details'],
    phone && ['phone', 'Phone line', 'Phone line'],
    ['policies', 'What customers should know'],
    ['booking-hours', 'Booking hours'],
    ['closed-dates', 'Closed dates and notice', 'Closed dates'],
    ['google-calendar', 'Google Calendar'],
    ['reminders', 'Reminders'],
    plan && ['plan', 'Plan and billing', 'Plan'],
    ghl && ['ghl', 'GoHighLevel'],
    ['connected', 'Connected services', 'Connections'],
    ['people', 'People'],
    ['sign-in', 'Sign-in and security', 'Sign-in'],
    ['notifications', 'Notifications to you', 'Notifications'],
    ['data', 'Your data'],
    ['close', 'Close the business', 'Close'],
    ['account', 'Your own account', 'Your account'],
  ].filter(Boolean)

function SettingsMenu({ sections }) {
  return (
    <div className="settings-menu" data-settings-menu>
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map(([id, title, short]) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => {
              e.preventDefault()
              scrollToCard(id)
            }}
          >
            {short || title}
          </a>
        ))}
      </nav>
      <label className="settings-jump">
        <span className="sr-only">Jump to a section</span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) scrollToCard(e.target.value)
            e.target.blur()
          }}
        >
          <option value="">Jump to a section…</option>
          {sections.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function Settings({ me, reload, billing, reloadBilling, go }) {
  const c = me.customer
  // "Plan and billing" exists only for a business with a plan to manage: sentences that send the owner there are shown
  // (as a link to the card) only then. A complimentary account has the card but nothing to cancel.
  const planCard = Boolean(billing)
  const hasPlan = planCard && !billing.complimentary
  return (
    <div className="enter">
      <h1 className="title title--page">Settings</h1>
      <SettingsMenu sections={settingsSections({ plan: planCard, ghl: me.features?.ghl, phone: me.features?.phone })} />
      <section className="card" id="setup-check" aria-labelledby="setup-check-title">
        <h2 className="card-title" id="setup-check-title">
          Setup check
        </h2>
        <SetupCheck go={go} />
      </section>
      <section className="card" id="business">
        <TitleHelp help="service_area">Business</TitleHelp>
        <BusinessForm customer={c} submitLabel="Save business" onSaved={reload} inline />
        <BusinessAddressForm mode={c.appointmentMode} />
      </section>
      <section className="card" id="services">
        <h2 className="card-title">Services and prices</h2>
        <ServicesForm />
      </section>
      <section className="card" id="details">
        <TitleHelp help="website_details">Details on your website</TitleHelp>
        <ProfileForm />
      </section>
      {me.features?.phone && (
        <section className="card" id="phone">
          <h2 className="card-title">Phone line</h2>
          <Suspense fallback={<div aria-busy="true" />}>
            <PhoneSettings />
          </Suspense>
        </section>
      )}
      <section className="card" id="policies">
        <TitleHelp help="policies">What customers should know</TitleHelp>
        <PoliciesForm />
      </section>
      <section className="card" id="booking-hours">
        <TitleHelp help="hours">Booking hours</TitleHelp>
        <HoursForm customer={c} submitLabel="Save hours" onSaved={reload} inline />
      </section>
      <section className="card" id="closed-dates">
        <h2 className="card-title">Closed dates and notice</h2>
        <AvailabilityForm />
      </section>
      <section className="card" id="google-calendar">
        <TitleHelp help="calendar">Google Calendar</TitleHelp>
        <CalendarSettings />
      </section>
      <section className="card" id="reminders">
        <TitleHelp help="reminders">Reminders</TitleHelp>
        <Reminders />
      </section>
      <div id="plan">{billing && <BillingCard billing={billing} reload={reloadBilling} />}</div>
      {me.features?.ghl && (
        <section className="card" id="ghl">
          <h2 className="card-title">GoHighLevel</h2>
          <Suspense fallback={<div aria-busy="true" />}>
            <GhlSettings />
          </Suspense>
        </section>
      )}
      <section className="card" id="connected">
        <h2 className="card-title">Connected services</h2>
        {/* Google Calendar has its own card above (status, reconnect, disconnect): listed once, in one style. */}
        <Services go={go} skip={['calendar']} />
      </section>
      <section className="card" id="people">
        <h2 className="card-title">People</h2>
        <People hasPlan={hasPlan} />
      </section>
      <section className="card" id="sign-in">
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
        <CloseBusiness hasPlan={hasPlan} />
      </section>
      <section className="card" id="account">
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
  // The browser tab names the page (the tab row itself keeps the current tab in view: TabBar).
  usePageTitle(tabs.find(([id]) => id === view)?.[1])
  // where: a tab ("website"), a card of a tab ("settings#booking-hours": the page opens and scrolls to it) or "billing".
  const go = (where) => {
    const [page, card] = String(where).split('#')
    const tab = page === 'billing' ? 'settings' : page
    if (tab !== view && document.querySelector('.app-main form[data-dirty]') && !window.confirm('You have changes that aren’t saved. Leave this page and lose them?')) return
    if (page === 'billing' && billing?.subscription?.status === 'past_due' && billing.subscription.manageable) return openBilling({ action: 'portal' }, () => {})
    if (tab !== view || !card) {
      window.history.pushState(null, '', tab === 'overview' ? '/dashboard' : `/dashboard/${tab}`)
      setView(tab)
      window.scrollTo(0, 0)
    }
    const id = card || (page === 'billing' ? 'plan' : null)
    if (id) scrollToCard(id)
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
      <TabBar label="Dashboard" tabs={tabs.map(([id, label]) => [id, label, id === 'overview' ? '/dashboard' : `/dashboard/${id}`])} current={view} onGo={go} />
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
            <Overview me={me} data={data} reload={loadOverview} go={go} site={site} insight={<Insight view="overview" list={found} drop={dropInsight} go={go} covered={data?.followUp?.some((l) => !l.test && l.status === 'new') ? ['unanswered'] : []} />} />
          </>
        )}
        {view === 'appointments' && <Appointments me={me} data={data} reload={loadOverview} go={go} />}
        {view === 'followups' && (
          <Suspense fallback={<div aria-busy="true" />}>
            <FollowUps overview={data && !data.failed ? data : null} go={go} />
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
