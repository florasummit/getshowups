// Guided setup. The server decides the ordered steps from saved data (server/onboarding.js), so setup
// resumes at the right place on any device. Self-serve: business → payment → details → services →
// calendar → hours → page → test → launch. Older businesses keep business → calendar → hours.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, browserTimeZone, fmt, timeZones } from '../lib/api.js'
import { BusinessForm, HoursForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { SignOut } from './Home.jsx'
import Readiness from './Readiness.jsx'

const LandingPreview = lazy(() => import('../landing/LandingPage.jsx'))

const LABELS = { business: 'Business', payment: 'Plan', details: 'Details', services: 'Services', calendar: 'Calendar', hours: 'Hours', page: 'Page', test: 'Test', launch: 'Launch' }
const PLAN_KEY = 'gsu_plan'
const storedPlan = () => {
  try {
    return localStorage.getItem(PLAN_KEY) || ''
  } catch {
    return ''
  }
}

export default function Setup({ me, reload }) {
  const { progress, email } = me
  const steps = progress.steps
  const [editing, setEditing] = useState(null)
  const current = editing || steps.find((s) => !s.done)?.id || steps.at(-1).id
  const index = steps.findIndex((s) => s.id === current)

  return (
    <div className="app">
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={email} />
      </header>
      <main className="center-page center-page--top">
        {steps.length > 1 && (
          <ol className="steps-bar steps-bar--wrap" aria-label="Setup progress">
            {steps.map((s, i) => (
              <li key={s.id} className={s.done && i !== index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={i === index ? 'step' : undefined}>
                <span className="steps-bar-dot">{s.done && i !== index ? '✓' : i + 1}</span>
                <span className="steps-bar-label">{LABELS[s.id]}</span>
              </li>
            ))}
          </ol>
        )}
        <section key={current} className={`panel enter ${current === 'page' ? 'panel--wide' : 'panel--narrow'}`} aria-labelledby="step-title">
          <Step
            id={current}
            me={me}
            done={() => {
              setEditing(null)
              reload()
            }}
            back={index > 1 && steps[index - 1].id !== 'payment' ? () => setEditing(steps[index - 1].id) : null}
          />
        </section>
        {progress.selfServe && <p className="fine setup-foot">Your progress saves automatically. You can leave and come back any time.</p>}
      </main>
    </div>
  )
}

function Step({ id, me, done, back }) {
  const { progress, customer } = me
  if (id === 'business') return me.signupPlan || progress.selfServe ? <NameStep onDone={done} plan={me.signupPlan} /> : <LegacyBusiness customer={customer} onDone={done} />
  if (id === 'payment') return <PaymentStep me={me} onDone={done} />
  if (id === 'details') return <DetailsStep customer={customer} onDone={done} />
  if (id === 'services') return <ServicesStep onDone={done} back={back} />
  if (id === 'calendar') return <CalendarStep onBack={back} />
  if (id === 'hours') return <HoursStep customer={customer} onDone={done} />
  if (id === 'page') return <PageStep onDone={done} back={back} />
  if (id === 'test') return <TestStep me={me} onDone={done} back={back} />
  return <LaunchStep onDone={done} />
}

function LegacyBusiness({ customer, onDone }) {
  return (
    <>
      <h1 id="step-title" className="title">
        {customer ? 'Your business' : 'Let’s set up your booking page'}
      </h1>
      <BusinessForm customer={customer} submitLabel="Continue" onSaved={onDone} />
    </>
  )
}

// ---------- 1. Business name (creates the account's business on the chosen plan) ----------
function NameStep({ onDone, plan }) {
  const [name, setName] = useState('')
  const [state, setState] = useState({})
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    let source
    try {
      source = localStorage.getItem('gsu_source') || undefined
    } catch {
      source = undefined
    }
    const { status, data } = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone: browserTimeZone(), serviceZips: '', plan: plan?.id || storedPlan(), source } })
    if (status === 200 || status === 201 || data.error === 'already_exists') return onDone()
    setState({ error: data.error === 'invalid_name' ? 'Enter your business name.' : 'Something went wrong. Please try again.' })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        What’s your business called?
      </h1>
      <p className="lede">This is the name customers will see on your page.</p>
      <label className="field">
        <span>Business name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="organization" autoFocus />
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        {plan ? 'Continue to plan' : 'Continue'}
      </button>
    </form>
  )
}

// ---------- 2. Founding plan checkout (Stripe-hosted) ----------
function PaymentStep({ me, onDone }) {
  const params = new URLSearchParams(window.location.search)
  const returned = params.get('billing')
  const [state, setState] = useState(returned === 'success' ? { confirming: true } : {})
  const billing = me.progress.billing
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })

  useEffect(() => {
    if (!state.confirming) return
    // Access follows Stripe's signed webhook; poll briefly while it arrives.
    let tries = 0
    const t = setInterval(async () => {
      tries++
      const { data } = await api('/api/dashboard/me')
      if (data?.progress?.steps?.find((s) => s.id === 'payment')?.done) {
        clearInterval(t)
        window.history.replaceState(null, '', '/dashboard')
        doneRef.current()
      } else if (tries >= 20) {
        clearInterval(t)
        setState({ slow: true })
      }
    }, 2000)
    return () => clearInterval(t)
  }, [state.confirming])

  const checkout = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body: { action: 'checkout', plan: me.progress.planId } })
    if (status === 200 && data.url) return window.location.assign(data.url)
    if (data.error === 'use_portal') return setState({ confirming: true })
    setState({ error: 'Checkout is unavailable right now. Please try again in a moment.' })
  }

  if (state.confirming) {
    return (
      <div className="form" aria-live="polite">
        <h1 id="step-title" className="title">
          Confirming your payment…
        </h1>
        <p className="lede">This usually takes a few seconds.</p>
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        {billing === 'canceled' ? 'Reactivate your plan' : 'Start your founding plan'}
      </h1>
      {returned === 'canceled' && (
        <p className="notice-soft" role="status">
          Checkout was cancelled. You haven’t been charged.
        </p>
      )}
      {state.slow && (
        <p className="notice-soft" role="status">
          We haven’t received confirmation from Stripe yet. If you completed payment, refresh in a minute.
        </p>
      )}
      <div className="plan-box">
        <p className="plan-name">GetShowUps Founding</p>
        <p className="plan-price">
          $499<span>/month</span>
        </p>
        <ul className="plan-points">
          <li>No free trial. Billed monthly; cancel any time from your billing page.</li>
          <li>Advertising spend is separate and paid directly to Google or Meta.</li>
          <li>Secure payment by Stripe. We never see your card details.</li>
        </ul>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={checkout}>
        {state.busy ? 'Opening checkout…' : 'Continue to secure checkout'}
      </button>
    </div>
  )
}

// ---------- 3. Business details ----------
const INDUSTRIES = ['Pool service', 'Lawn care', 'House cleaning', 'Pest control', 'HVAC', 'Plumbing', 'Electrical', 'Pressure washing', 'Handyman', 'Window cleaning', 'Roofing', 'Landscaping']
const PROFILE_ERRORS = {
  phone: 'Enter a 10-digit US phone number, or leave it empty.',
  industry: 'Tell us what kind of business this is.',
  description: 'Keep the description under 400 characters.',
  'description:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
  cities: 'List up to 6 towns, separated by commas.',
  services: 'Add at least one service (up to 8).',
  'services:unapproved_claim': 'Service names and prices can’t include guarantees, discounts or ratings.',
}
const profileError = (fields = []) => fields.map((f) => PROFILE_ERRORS[f]).filter(Boolean)[0] || 'Please check the form and try again.'

function useProfile() {
  const [profile, setProfile] = useState(undefined)
  useEffect(() => {
    api('/api/dashboard/profile').then(({ status, data }) => setProfile(status === 200 ? data.profile || null : null))
  }, [])
  return profile
}

function DetailsStep({ customer, onDone }) {
  const profile = useProfile()
  const [state, setState] = useState({})
  if (profile === undefined) return <div aria-busy="true" />
  const p = profile || {}
  const submit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setState({ busy: true })
    const biz = await api('/api/dashboard/business', {
      method: 'POST',
      body: { name: f.get('name'), timezone: f.get('timezone'), serviceZips: f.get('zips'), appointmentMode: f.get('mode') },
    })
    if (biz.status !== 200) return setState({ error: biz.data.error === 'invalid_zips' ? 'Use 5-digit ZIP codes separated by commas.' : 'Please check your business name and time zone.' })
    const r = await api('/api/dashboard/profile', {
      method: 'POST',
      body: { phone: f.get('phone'), industry: f.get('industry'), description: f.get('description'), cities: f.get('cities'), services: p.services || [] },
    })
    if (r.status === 200) return onDone()
    setState({ error: profileError(r.data.fields) })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        About your business
      </h1>
      <label className="field">
        <span>Business name</span>
        <input name="name" defaultValue={customer.name} maxLength={80} required autoComplete="organization" />
      </label>
      <label className="field">
        <span>What do you do?</span>
        <input name="industry" defaultValue={p.industry || ''} list="industries" maxLength={60} required placeholder="Pool service" />
        <datalist id="industries">
          {INDUSTRIES.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>
          Business phone <em>(optional, shown on your page)</em>
        </span>
        <input name="phone" type="tel" defaultValue={p.phone || ''} autoComplete="tel" inputMode="tel" />
      </label>
      <fieldset className="field">
        <legend>Where do appointments happen?</legend>
        <div className="choice" role="radiogroup">
          {[
            ['at_customer', 'At the customer’s home or site'],
            ['at_business', 'At my location'],
          ].map(([value, label]) => (
            <label key={value} className="choice-option">
              <input type="radio" name="mode" value={value} defaultChecked={(customer.appointmentMode || 'at_business') === value} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>
          Towns you serve <em>(comma separated)</em>
        </span>
        <input name="cities" defaultValue={(p.cities || []).join(', ')} placeholder="Charleston, Mount Pleasant" />
      </label>
      <label className="field">
        <span>
          ZIP codes you serve <em>(optional; leads outside them are marked for you)</em>
        </span>
        <input name="zips" defaultValue={(customer.serviceZips || []).join(', ')} inputMode="numeric" placeholder="29403, 29407" />
      </label>
      <label className="field">
        <span>
          Short description <em>(optional)</em>
        </span>
        <textarea name="description" rows={3} maxLength={400} defaultValue={p.description || ''} placeholder="Family-run pool care for homes across Charleston." />
      </label>
      <label className="field">
        <span>Time zone</span>
        <select name="timezone" defaultValue={customer.timezone || browserTimeZone()}>
          {timeZones().map((z) => (
            <option key={z} value={z}>
              {z.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        Continue
      </button>
    </form>
  )
}

// ---------- 4. Services ----------
const SUGGESTED = {
  'pool service': ['Weekly pool cleaning', 'Pool opening', 'Pool closing', 'Green pool cleanup', 'Equipment repair'],
  'lawn care': ['Lawn mowing', 'Fertilization', 'Aeration', 'Leaf cleanup'],
  'house cleaning': ['Standard cleaning', 'Deep cleaning', 'Move-out cleaning'],
  'pest control': ['General pest treatment', 'Termite inspection', 'Mosquito treatment'],
  hvac: ['AC repair', 'Furnace repair', 'System tune-up', 'New system estimate'],
  plumbing: ['Leak repair', 'Drain cleaning', 'Water heater service'],
  'pressure washing': ['House washing', 'Driveway cleaning', 'Deck cleaning'],
}
function ServicesStep({ onDone, back }) {
  const profile = useProfile()
  const [edited, setRows] = useState(null)
  const [state, setState] = useState({})
  if (profile === undefined) return <div aria-busy="true" />
  // Saved services, else suggestions for the industry, until the owner edits them.
  const saved = profile?.services || []
  const suggestions = SUGGESTED[(profile?.industry || '').toLowerCase()] || []
  const rows = edited ?? (saved.length ? saved : (suggestions.length ? suggestions.slice(0, 3) : ['']).map((name) => ({ name, price: '' })))
  const set = (i, k) => (e) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const r = await api('/api/dashboard/profile', { method: 'POST', body: { ...profile, services: rows.filter((r) => r.name.trim()), requireServices: true } })
    if (r.status === 200) return onDone()
    setState({ error: profileError(r.data.fields) })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        What can customers book?
      </h1>
      <p className="lede">We’ve suggested a few. Edit, remove or add your own. Prices are optional.</p>
      {rows.map((r, i) => (
        <div key={i} className="service-row">
          <label className="field">
            <span className={i ? 'sr-only' : undefined}>Service</span>
            <input value={r.name} onChange={set(i, 'name')} maxLength={60} aria-label={`Service ${i + 1}`} />
          </label>
          <label className="field field--price">
            <span className={i ? 'sr-only' : undefined}>Price</span>
            <input value={r.price} onChange={set(i, 'price')} maxLength={40} placeholder="From $150" aria-label={`Price for service ${i + 1}`} />
          </label>
          <button type="button" className="link-btn service-remove" aria-label={`Remove service ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>
            Remove
          </button>
        </div>
      ))}
      {rows.length < 8 && (
        <button type="button" className="btn btn-quiet" onClick={() => setRows([...rows, { name: '', price: '' }])}>
          Add a service
        </button>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        Continue
      </button>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </form>
  )
}

// ---------- 5. Calendar ----------
function CalendarStep({ onBack }) {
  const [state, setState] = useState({})
  const failed = new URLSearchParams(window.location.search).get('calendar_error')
  const start = async () => {
    setState({ busy: true })
    if (!(await connectCalendar())) setState({ failed: true })
  }
  return (
    <>
      <h1 id="step-title" className="title">
        Connect Google Calendar
      </h1>
      <p className="lede">We check when you’re free and add booked appointments to your calendar. We never read event details.</p>
      {(state.failed || failed) && (
        <p className="form-error" role="alert">
          That didn’t connect. Please try again and allow calendar access.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={start} disabled={state.busy}>
        {state.busy ? 'Opening Google…' : 'Connect Google Calendar'}
      </button>
      {onBack && (
        <button type="button" className="link-btn" onClick={onBack}>
          Back
        </button>
      )}
    </>
  )
}

// ---------- 6. Hours (calendar verified live first) ----------
function CalendarHealth() {
  const [cal, setCal] = useState(null)
  useEffect(() => {
    api('/api/dashboard/calendar').then(({ data }) => setCal(data || {}))
  }, [])
  if (!cal) return <p className="fine">Checking your calendar connection…</p>
  if (cal.status === 'healthy')
    return (
      <p className="status status--ok">
        <span className="status-dot" aria-hidden="true" />
        Google Calendar connected{cal.account ? ` (${cal.account})` : ''}
      </p>
    )
  return (
    <div className="notice-soft" role="alert">
      <p>We can’t reach your Google Calendar right now.</p>
      <button type="button" className="btn btn-sm btn-quiet" onClick={() => connectCalendar()}>
        Reconnect
      </button>
    </div>
  )
}
function HoursStep({ customer, onDone }) {
  return (
    <>
      <h1 id="step-title" className="title">
        When can customers book?
      </h1>
      <CalendarHealth />
      <p className="lede">Times already busy on your Google Calendar are hidden automatically.</p>
      <HoursForm customer={customer} submitLabel="Continue" onSaved={onDone} />
    </>
  )
}

// ---------- 7. Landing page: draft → preview → publish with explicit authorization ----------
function PageStep({ onDone, back }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [ok, setOk] = useState(false)
  const [state, setState] = useState({})
  useEffect(() => {
    Promise.all([api('/api/dashboard/landing'), api('/api/dashboard/me'), api('/api/dashboard/profile')]).then(([l, m, p]) => {
      setData({ url: l.data.url, name: m.data.customer.name, mode: m.data.customer.appointmentMode, phone: p.data.profile?.phone || '', id: m.data.customer.id })
      setDraft(l.data.page)
    })
  }, [])
  if (!draft) return <div aria-busy="true" />
  const save = async (publish) => {
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/landing', { method: 'POST', body: { ...draft, publish } })
    if (status === 200) return onDone()
    setState({ error: d.fields?.some((f) => f.endsWith('unapproved_claim')) ? 'Please remove promises like guarantees, discounts, ratings or credentials you haven’t confirmed with us.' : 'Please check the headline and introduction.' })
  }
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value })
  return (
    <div className="page-step">
      <div className="form">
        <h1 id="step-title" className="title">
          Your landing page
        </h1>
        <p className="lede">We drafted it from your details. Edit anything, check the preview, then publish when you’re happy.</p>
        <label className="field">
          <span>Headline</span>
          <input value={draft.headline} onChange={set('headline')} maxLength={80} />
        </label>
        <label className="field">
          <span>Introduction</span>
          <textarea rows={3} value={draft.intro} onChange={set('intro')} maxLength={400} />
        </label>
        <label className="field">
          <span>Service area</span>
          <input value={draft.area} onChange={set('area')} maxLength={200} />
        </label>
        <label className="check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>The details are accurate and I want this page to be public at {data.url.replace(/^https?:\/\//, '')}.</span>
        </label>
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ok || state.busy} onClick={() => save(true)}>
          Publish my page
        </button>
        <button type="button" className="btn btn-quiet btn-block" disabled={state.busy} onClick={() => save(false)}>
          Save as a private draft for now
        </button>
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
      </div>
      <figure className="preview" aria-label="Preview of your landing page">
        <figcaption className="fine">Preview (not public until you publish)</figcaption>
        <div className="preview-frame">
          <Suspense fallback={<div aria-busy="true" />}>
            <LandingPreview id={data.id} preview={{ name: data.name, appointmentMode: data.mode, phone: data.phone, ...draft }} />
          </Suspense>
        </div>
      </figure>
    </div>
  )
}

// ---------- 8. Booking test ----------
function TestStep({ me, onDone, back }) {
  const [check, setCheck] = useState(null)
  useEffect(() => {
    api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'check_availability' } }).then(({ status, data }) => setCheck(status === 200 ? data : { status: 'unavailable', slots: 0 }))
  }, [])
  const next = async () => {
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'tested' } })
    onDone()
  }
  const tz = me.customer.timezone
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Check your booking page
      </h1>
      {!check ? (
        <p className="fine">Checking your open times…</p>
      ) : check.status === 'ok' && check.slots > 0 ? (
        <p className="status status--ok">
          <span className="status-dot" aria-hidden="true" />
          {check.slots} open times over the next two weeks. First: {fmt(check.first, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </p>
      ) : (
        <p className="notice-soft" role="alert">
          No open times found. Check your booking hours, or that your calendar isn’t fully busy.
        </p>
      )}
      <p className="lede">Open your booking page to see exactly what customers see. If you make a test booking, it goes on your Google Calendar like a real one, and a time can’t be booked twice.</p>
      <a className="btn btn-quiet btn-block" href={me.bookingUrl} target="_blank" rel="noreferrer">
        Open my booking page
      </a>
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={next}>
        Continue
      </button>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}

// ---------- 9. Launch checklist ----------
function LaunchStep({ onDone }) {
  const [state, setState] = useState({})
  const finish = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'finish' } })
    if (status === 200) return onDone()
    setState({ error: data.missing ? `Please finish: ${data.missing.map((m) => LABELS[m]).join(', ')}.` : 'Something went wrong. Please try again.' })
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        You’re ready to take bookings
      </h1>
      <Readiness />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={finish}>
        Go to my dashboard
      </button>
    </div>
  )
}
