// Dashboard after setup. Four places: Overview (is it working, what needs me), Appointments,
// Website, Settings. Nothing technical; billing appears only when billing needs attention.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, fmt } from '../lib/api.js'
import { BusinessForm, HoursForm, ProfileForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { NextStep } from './Readiness.jsx'
import Appointments, { Appointment, OutcomeList } from './Appointments.jsx'

const Ads = lazy(() => import('./Ads.jsx'))
const GhlSettings = lazy(() => import('./GhlSettings.jsx'))
const WebsiteTab = lazy(() => import('./WebsiteTab.jsx'))

export function SignOut({ email, label = 'Sign out' }) {
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' })
    location.replace('/dashboard')
  }
  return (
    <div className="header-user">
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
  useEffect(() => {
    api('/api/dashboard/billing').then(({ status, data }) => setBilling(status === 200 && data.configured && data.billed ? data : null))
  }, [])
  return billing
}

async function openBilling(body, setState) {
  setState({ busy: true })
  const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body })
  if (status === 200 && data.url) return window.location.assign(data.url)
  setState({ error: 'Billing is unavailable right now. Please try again.' })
}

const SUB_LABEL = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Ended', incomplete: 'Not completed' }
const shortDate = (ms) => fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric' })

function BillingCard({ billing }) {
  const [state, setState] = useState({})
  const sub = billing.subscription
  const live = sub && sub.status !== 'canceled' && sub.status !== 'incomplete'
  return (
    <section className="card">
      <h2 className="card-title">Plan</h2>
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
          <button type="button" className="btn btn-quiet btn-block" disabled={state.busy || !sub.manageable} onClick={() => openBilling({ action: 'portal' }, setState)}>
            Manage billing
          </button>
        </div>
      ) : (
        <div className="form">
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

function AccountNotice({ customer, billing }) {
  const [state, setState] = useState({})
  const s = billing?.subscription?.status
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
    <section className="card card--hero enter" aria-label="Your website">
      <p className="eyebrow-sm">Your website</p>
      {!site ? (
        <p className="fine">Checking…</p>
      ) : w?.published ? (
        <>
          <a className="booking-url" href={url} target="_blank" rel="noreferrer">
            {url.replace(/^https?:\/\//, '')}
          </a>
          <p className="hero-status">
            <span className="status-dot status-dot--ok" aria-hidden="true" /> Live and taking bookings
          </p>
          <div className="card-actions">
            <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">
              View website
            </a>
            <CopyLink url={url} />
          </div>
        </>
      ) : (
        <>
          <p className="hero-title">Your website isn’t published yet.</p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary" onClick={() => go('website')}>
              Finish my website
            </button>
            <CopyLink url={me.bookingUrl} label="Copy booking link" />
          </div>
        </>
      )}
    </section>
  )
}

function Stats({ stats, visit }) {
  const recorded = stats.showed + stats.noShow
  const rows = [
    ['Leads', stats.leads],
    ['Bookings', stats.booked],
    [visit ? 'Visits' : 'Show-ups', stats.showed],
  ]
  // Rates only once there are enough outcomes to mean something.
  if (!visit && recorded >= 5) rows.push(['Show-up rate', `${stats.showRate}%`])
  if (visit && stats.completed + stats.notCompleted >= 5) rows.push(['Jobs completed', `${stats.completionRate}%`])
  return (
    <section aria-label="Last 30 days">
      <div className={`stats stats--${rows.length}`}>
        {rows.map(([label, value]) => (
          <div key={label} className="stat">
            <p className="stat-value">{value}</p>
            <p className="stat-label">{label}</p>
          </div>
        ))}
      </div>
      <p className="fine stats-note">Last 30 days</p>
    </section>
  )
}

function Overview({ me, data, reload, go, site }) {
  const tz = me.customer.timezone
  const visit = me.customer.appointmentMode === 'at_customer'
  return (
    <>
      <WebsiteCard me={me} site={site} go={go} />
      <NextStep onOpen={go} skip={site && !site.website?.published ? ['page'] : []} />
      {data?.failed && (
        <p className="form-error" role="alert">
          Couldn’t load your results.{' '}
          <button type="button" className="link-btn" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {data && !data.failed && (
        <div className="enter">
          <Stats stats={data.stats} visit={visit} />
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
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api('/api/dashboard/overview').then(({ status, data }) => status === 200 && setA(data.automation)), [])
  useEffect(() => {
    load()
  }, [load])
  if (!a) return <div aria-busy="true" />
  const sending = a.enabled && (a.email || a.sms) && !a.testMode
  const toggle = async () => {
    setBusy(true)
    await api('/api/dashboard/automations', { method: 'POST', body: { enabled: !a.enabled } })
    await load()
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
    </div>
  )
}

function Settings({ me, reload, billing }) {
  const c = me.customer
  return (
    <div className="enter">
      <h1 className="title title--page">Settings</h1>
      <section className="card">
        <h2 className="card-title">Business</h2>
        <BusinessForm customer={c} submitLabel="Save business" onSaved={reload} />
      </section>
      <section className="card">
        <h2 className="card-title">Details on your website</h2>
        <ProfileForm />
      </section>
      <section className="card">
        <h2 className="card-title">Booking hours</h2>
        <HoursForm customer={c} submitLabel="Save hours" onSaved={reload} />
      </section>
      <section className="card">
        <h2 className="card-title">Google Calendar</h2>
        <CalendarSettings />
      </section>
      <section className="card">
        <h2 className="card-title">Reminders</h2>
        <Reminders />
      </section>
      {billing && <BillingCard billing={billing} />}
      {me.features?.ghl && (
        <section className="card">
          <h2 className="card-title">GoHighLevel</h2>
          <Suspense fallback={<div aria-busy="true" />}>
            <GhlSettings />
          </Suspense>
        </section>
      )}
    </div>
  )
}

// ---------- shell ----------
const TABS = [
  ['overview', 'Overview'],
  ['appointments', 'Appointments'],
  ['website', 'Website'],
  ['settings', 'Settings'],
]
const tabFromPath = () => {
  const t = window.location.pathname.split('/')[2]
  return ['appointments', 'website', 'settings', 'ads'].includes(t) ? t : 'overview'
}

export default function Home({ me, reload }) {
  const [view, setView] = useState(tabFromPath)
  const billing = useBilling()
  const [data, loadOverview] = useOverview()
  const site = useSite()
  const tabs = me.features?.ads ? [...TABS.slice(0, 3), ['ads', 'Ads'], TABS[3]] : TABS
  useEffect(() => {
    const onPop = () => setView(tabFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = (where) => {
    const tab = where === 'billing' ? 'settings' : where
    if (where === 'billing' && billing?.subscription?.status === 'past_due' && billing.subscription.manageable) return openBilling({ action: 'portal' }, () => {})
    window.history.pushState(null, '', tab === 'overview' ? '/dashboard' : `/dashboard/${tab}`)
    setView(tab)
    window.scrollTo(0, 0)
  }
  return (
    <div className={`app${view === 'website' ? ' app--wide' : ''}`}>
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={me.email} />
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
      <main className="app-main">
        {view === 'overview' && (
          <>
            <h1 className="title title--page">{me.customer.name}</h1>
            <AccountNotice customer={me.customer} billing={billing} />
            <Overview me={me} data={data} reload={loadOverview} go={go} site={site} />
          </>
        )}
        {view === 'appointments' && <Appointments me={me} data={data && !data.failed ? data : null} reload={loadOverview} />}
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
        {view === 'settings' && <Settings me={me} reload={reload} billing={billing} />}
      </main>
    </div>
  )
}
