// Dashboard home: booking link, results, who to mark, what's next, who to call. Settings in one view.
import { useCallback, useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, fmt } from '../lib/api.js'
import { BusinessForm, HoursForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'

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

// Billing (shown only when Stripe and at least one plan are configured).
function useBilling() {
  const [billing, setBilling] = useState(null)
  useEffect(() => {
    api('/api/dashboard/billing').then(({ status, data }) => setBilling(status === 200 && data.configured ? data : null))
  }, [])
  return billing
}

async function openBilling(body, setState) {
  setState({ busy: true })
  const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body })
  if (status === 200 && data.url) return window.location.assign(data.url)
  setState({ error: 'Billing is unavailable right now. Please try again.' })
}

const SUB_LABEL = { trialing: 'Free trial', active: 'Active', past_due: 'Payment failed', canceled: 'Canceled', incomplete: 'Incomplete' }

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
                {sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {fmt(new Date(sub.currentPeriodEnd).toISOString(), undefined, { month: 'short', day: 'numeric' })}
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
              {!sub && p.trialDays > 0 ? `Start ${p.trialDays}-day trial · ${p.name}` : `Choose ${p.name}`}
            </button>
          ))}
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  )
}

// One quiet, actionable notice for account problems.
function AccountNotice({ customer, billing }) {
  const [state, setState] = useState({})
  const pastDue = billing?.subscription?.status === 'past_due'
  if (customer.status !== 'suspended' && !pastDue) return null
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

function CopyLink({ url }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('Copy your booking link', url)
    }
  }
  return (
    <button type="button" className="btn btn-primary" onClick={copy}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

const when = (iso, tz) => fmt(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function Appointment({ a, tz, children }) {
  return (
    <li className="row">
      <div className="row-main">
        <p className="row-title">{a.name}</p>
        <p className="row-sub">
          {when(a.start, tz)} · <a href={`tel:${a.phone}`}>{a.phone}</a>
        </p>
        <p className="row-note">{a.need}</p>
      </div>
      {children}
    </li>
  )
}

function Outcome({ a, tz, onDone }) {
  const [busy, setBusy] = useState(false)
  const mark = async (outcome) => {
    setBusy(true)
    const { status } = await api('/api/dashboard/outcome', { method: 'POST', body: { id: a.id, outcome } })
    if (status === 200) onDone()
    else setBusy(false)
  }
  return (
    <Appointment a={a} tz={tz}>
      <div className="row-actions">
        <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => mark('no_show')}>
          No-show
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => mark('showed')}>
          Showed
        </button>
      </div>
    </Appointment>
  )
}

function Overview({ me }) {
  const tz = me.customer.timezone
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const load = useCallback(
    () =>
      api('/api/dashboard/overview').then(({ status, data: d }) => {
        if (status === 200) {
          setData(d)
          setError(false)
        } else setError(true)
      }),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  return (
    <>
      <section className="card card--hero enter">
        <p className="eyebrow-sm">Your booking page</p>
        <a className="booking-url" href={me.bookingUrl} target="_blank" rel="noreferrer">
          {me.bookingUrl.replace(/^https?:\/\//, '')}
        </a>
        <div className="card-actions">
          <CopyLink url={me.bookingUrl} />
          <a className="btn btn-quiet" href={me.bookingUrl} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </section>

      {error && (
        <p className="form-error" role="alert">
          Couldn’t load your results.{' '}
          <button type="button" className="link-btn" onClick={load}>
            Retry
          </button>
        </p>
      )}

      {data && (
        <div className="enter">
          <section aria-label="Last 30 days" className="stats">
            {[
              ['Leads', data.stats.leads],
              ['Booked', data.stats.booked],
              ['Showed', data.stats.showed],
              ['Show rate', data.stats.showRate === null ? '—' : `${data.stats.showRate}%`],
            ].map(([label, value]) => (
              <div key={label} className="stat">
                <p className="stat-value">{value}</p>
                <p className="stat-label">{label}</p>
              </div>
            ))}
          </section>
          <p className="fine stats-note">Last 30 days</p>

          {data.needsOutcome.length > 0 && (
            <section className="card">
              <h2 className="card-title">Did they show up?</h2>
              <ul className="rows">
                {data.needsOutcome.map((a) => (
                  <Outcome key={a.id} a={a} tz={tz} onDone={load} />
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h2 className="card-title">Upcoming</h2>
            {data.upcoming.length ? (
              <ul className="rows">
                {data.upcoming.map((a) => (
                  <Appointment key={a.id} a={a} tz={tz} />
                ))}
              </ul>
            ) : (
              <p className="empty">No upcoming appointments. Share your booking page to get the next one.</p>
            )}
          </section>

          {data.followUp.length > 0 && (
            <section className="card">
              <h2 className="card-title">Haven’t booked yet</h2>
              <ul className="rows">
                {data.followUp.map((l) => (
                  <li key={l.id} className="row">
                    <div className="row-main">
                      <p className="row-title">
                        {l.name}
                        {l.status === 'unqualified' && <span className="tag">Outside service area</span>}
                      </p>
                      <p className="row-sub">
                        <a href={`tel:${l.phone}`}>{l.phone}</a> · <a href={`mailto:${l.email}`}>{l.email}</a>
                      </p>
                      <p className="row-note">{l.need}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.recent.length > 0 && (
            <section className="card">
              <h2 className="card-title">Recent results</h2>
              <ul className="rows">
                {data.recent.map((a) => (
                  <Appointment key={a.id} a={a} tz={tz}>
                    <span className={`tag ${a.status === 'showed' ? 'tag--ok' : 'tag--bad'}`}>{a.status === 'showed' ? 'Showed' : 'No-show'}</span>
                  </Appointment>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  )
}

const CAL_STATUS = {
  healthy: ['Connected', 'ok'],
  not_connected: ['Not connected', 'bad'],
  reconnect_required: ['Needs reconnecting', 'bad'],
}

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
      <button type="button" className={`btn btn-block ${tone === 'ok' ? 'btn-quiet' : 'btn-primary'}`} onClick={reconnect} disabled={busy || !status}>
        {busy ? 'Opening Google…' : 'Reconnect Google Calendar'}
      </button>
    </div>
  )
}

function Settings({ me, reload, onClose, billing }) {
  const c = me.customer
  return (
    <div className="enter">
      <button type="button" className="link-btn back-btn" onClick={onClose}>
        ← Back
      </button>
      <h1 className="title">Settings</h1>
      <section className="card">
        <h2 className="card-title">Booking hours</h2>
        <HoursForm customer={c} submitLabel="Save hours" onSaved={reload} />
      </section>
      <section className="card">
        <h2 className="card-title">Google Calendar</h2>
        <CalendarSettings />
      </section>
      {billing && <BillingCard billing={billing} />}
      <section className="card">
        <h2 className="card-title">Business</h2>
        <BusinessForm customer={c} submitLabel="Save business" onSaved={reload} />
      </section>
    </div>
  )
}

export default function Home({ me, reload }) {
  const [view, setView] = useState('home')
  const billing = useBilling()
  return (
    <div className="app">
      <header className="app-header">
        <Logo href="/" />
        <div className="header-nav">
          <button type="button" className="link-btn" onClick={() => setView(view === 'home' ? 'settings' : 'home')} aria-pressed={view === 'settings'}>
            Settings
          </button>
          <SignOut email={me.email} />
        </div>
      </header>
      <main className="app-main">
        {view === 'home' ? (
          <>
            <h1 className="title title--page">{me.customer.name}</h1>
            <AccountNotice customer={me.customer} billing={billing} />
            <Overview me={me} />
          </>
        ) : (
          <Settings me={me} reload={reload} billing={billing} onClose={() => setView('home')} />
        )}
      </main>
    </div>
  )
}
