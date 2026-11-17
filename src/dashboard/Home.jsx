// Dashboard after setup. Four places: Overview (is it working, what needs me), Appointments,
// Website, Settings. Nothing technical; billing appears only when billing needs attention.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, fmt } from '../lib/api.js'
import { BusinessForm, HoursForm, PoliciesForm, ProfileForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { NextStep } from './Readiness.jsx'
import Appointments, { Appointment, OutcomeList } from './Appointments.jsx'
import { Pill } from './ui.jsx'

const Ads = lazy(() => import('./Ads.jsx'))
const GhlSettings = lazy(() => import('./GhlSettings.jsx'))
const WebsiteTab = lazy(() => import('./WebsiteTab.jsx'))
const FollowUps = lazy(() => import('./FollowUps.jsx'))
const Receptionist = lazy(() => import('./Receptionist.jsx'))

export function SignOut({ email, label = 'Sign out', to = '/dashboard' }) {
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' })
    location.replace(to)
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

// Permanent deletion (only when the platform has it switched on). No undo: the owner types the business name.
function DeleteAccount({ name }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState({})
  const matches = typed.trim().replace(/\s+/g, ' ').toLowerCase() === String(name).trim().replace(/\s+/g, ' ').toLowerCase()
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/account', { method: 'POST', body: { action: 'delete', confirm: true, name: typed } })
    setState(status === 202 ? { done: true } : { error: data.error === 'name_mismatch' ? 'The name doesn’t match.' : 'Couldn’t delete the account. Please try again.' })
  }
  if (state.done)
    return (
      <div className="stack" role="status" data-account-deleted>
        <p>
          <strong>Your account is being deleted.</strong> Your website and booking page are offline, your ads are paused, billing has stopped and
          your data is being erased. This can’t be undone.
        </p>
        <a className="btn btn-sm" href="/">
          Done
        </a>
      </div>
    )
  return (
    <div className="stack">
      <p className="fine">
        Permanently deletes {name}: the website and booking page go offline, running ads are paused, your subscription is canceled right away
        (no further charges), connected Google, ad and GoHighLevel accounts are disconnected, and your customers’ details, appointments and
        website are erased. Billing records we must keep for tax and accounting stay, without your customers’ details. There is no undo; to
        come back later you start a new account. To stop paying but keep everything, cancel your plan in Billing instead.
      </p>
      {!open ? (
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
          Delete account…
        </button>
      ) : (
        <form className="stack" onSubmit={submit} aria-label="Confirm account deletion">
          <label className="field">
            <span>Type the business name ({name}) to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          {state.error && (
            <p className="form-error" role="alert">
              {state.error}
            </p>
          )}
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-danger" disabled={!matches || state.busy}>
              Permanently delete account
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

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
    ['New inquiries', stats.leads],
    ['Booked', stats.booked],
    [visit ? 'Visits' : 'Show-ups', stats.showed],
  ]
  if (!visit && recorded >= 5) rows.push(['Show-up rate', `${stats.showRate}%`])
  if (visit && stats.completed + stats.notCompleted >= 5) rows.push(['Jobs completed', `${stats.completionRate}%`])
  const pendingRate = visit ? stats.completed + stats.notCompleted < 5 : recorded < 5
  return (
    <section aria-label="Last 30 days">
      <div className="ui-section-head ui-section-head--flush">
        <h2 className="ui-section-title">Last 30 days</h2>
        <span className="fine">{upcoming} upcoming</span>
      </div>
      <div className={`stats stats--${rows.length}`}>
        {rows.map(([label, value]) => (
          <div key={label} className="stat">
            <p className="stat-value">{value}</p>
            <p className="stat-label">{label}</p>
          </div>
        ))}
      </div>
      {pendingRate && <p className="fine stats-note">{visit ? 'Job completion rate' : 'Show-up rate'} appears after 5 recorded outcomes.</p>}
    </section>
  )
}

// What needs the owner, most urgent first. Each item has one obvious action. Empty → "All caught up".
function Attention({ data, go }) {
  const items = []
  const r = data.requests
  if (r?.open)
    items.push({
      tone: r.urgent ? 'bad' : 'warn',
      tag: r.urgent ? 'Urgent' : 'Callback',
      text: `${r.open} ${r.open === 1 ? 'customer is' : 'customers are'} waiting for a call back`,
      action: ['Open receptionist', 'receptionist'],
    })
  const unbooked = data.followUp.filter((l) => !l.test && l.status === 'new').length
  if (unbooked)
    items.push({ tone: 'warn', tag: 'Follow up', text: `${unbooked} ${unbooked === 1 ? 'person asked' : 'people asked'} but ${unbooked === 1 ? 'hasn’t' : 'haven’t'} booked yet`, action: ['Review', 'appointments'] })
  return (
    <section className="card ui-attention" aria-label="Needs your attention">
      <h2 className="card-title">Needs your attention</h2>
      {items.length ? (
        <ul className="ui-attention-list">
          {items.map((i) => (
            <li key={i.text}>
              <span className="ui-attention-text">
                <Pill tone={i.tone}>{i.tag}</Pill> {i.text}
              </span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => go(i.action[1])}>
                {i.action[0]}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-all-clear">
          <Pill tone="ok">All caught up</Pill> Nobody is waiting on you.
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
  const tiles = [
    ['Ad spend', money(ads.spendCents)],
    ['Clicks', ads.clicks ?? '—'],
    ['Leads from ads', ads.leads],
    ['Bookings', ads.booked],
    ['Show-ups', ads.showed],
    ['Cost per booking', money(ads.costPerBookingCents)],
    ['Cost per show-up', money(ads.costPerShowUpCents)],
  ]
  return (
    <section aria-label="Advertising, last 30 days" data-ads-results>
      <h2 className="card-title">Advertising</h2>
      <div className="stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat">
            <p className="stat-value">{value}</p>
            <p className="stat-label">{label}</p>
          </div>
        ))}
      </div>
      <p className="fine stats-note">
        Last 30 days · — means not available yet{ads.spendCents === null ? ' (no ad spend recorded)' : ''}.
        {ads.testAccount && ' Google Ads test account: no real ads ran, so these are test figures, not business results.'}
      </p>
    </section>
  )
}

function Overview({ me, data, reload, go, site }) {
  const tz = me.customer.timezone
  const visit = me.customer.appointmentMode === 'at_customer'
  return (
    <>
      <NextStep onOpen={go} skip={site && !site.website?.published ? ['page'] : []} />
      {!data && <div className="ui-skeleton-block" aria-busy="true" />}
      {data?.failed && (
        <p className="form-error" role="alert">
          Couldn’t load your results.{' '}
          <button type="button" className="link-btn" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {data && !data.failed && (
        <div className="enter ui-overview">
          <Attention data={data} go={go} />
          <Stats stats={data.stats} visit={visit} upcoming={data.upcoming.length} />
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
        <h2 className="card-title">What customers should know</h2>
        <PoliciesForm />
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
      {me.features?.accountDeletion && (
        <section className="card" aria-labelledby="delete-account-title">
          <h2 className="card-title" id="delete-account-title">
            Delete account
          </h2>
          <DeleteAccount name={c.name} />
        </section>
      )}
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
  return ['appointments', 'followups', 'receptionist', 'website', 'settings', 'ads'].includes(t) ? t : 'overview'
}

export default function Home({ me, reload }) {
  const [requested, setView] = useState(tabFromPath)
  // /dashboard/ads for a business without the Ads feature (e.g. back from a refused ad sign-in) → Overview.
  const view = requested === 'ads' && !me.features?.ads ? 'overview' : requested
  const billing = useBilling()
  const [data, loadOverview] = useOverview()
  const site = useSite()
  const tabs = me.features?.ads ? [...TABS.slice(0, -1), ['ads', 'Ads'], TABS.at(-1)] : TABS
  useEffect(() => {
    const onPop = () => setView(tabFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // On narrow screens the tab bar scrolls: keep the current tab in view.
  useEffect(() => {
    document.querySelector('.tabs [aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [view])
  const go = (where) => {
    const tab = where === 'billing' ? 'settings' : where
    if (where === 'billing' && billing?.subscription?.status === 'past_due' && billing.subscription.manageable) return openBilling({ action: 'portal' }, () => {})
    window.history.pushState(null, '', tab === 'overview' ? '/dashboard' : `/dashboard/${tab}`)
    setView(tab)
    window.scrollTo(0, 0)
  }
  return (
    <div className={`app${view === 'website' || view === 'followups' ? ' app--wide' : ''}`}>
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
            <h1 className="ui-page-title ui-page-title--top">{me.customer.name}</h1>
            <AccountNotice customer={me.customer} billing={billing} />
            <Overview me={me} data={data} reload={loadOverview} go={go} site={site} />
          </>
        )}
        {view === 'appointments' && <Appointments me={me} data={data && !data.failed ? data : null} reload={loadOverview} />}
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
