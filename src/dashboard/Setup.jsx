// Guided setup. The server decides the ordered steps from saved data (server/onboarding.js), so setup
// resumes at the right place on any device. Self-serve: business → payment → details → services →
// calendar → hours → website → address → publish → launch. Older businesses keep business → calendar → hours.
import { useEffect, useRef, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, browserTimeZone, timeZones } from '../lib/api.js'
import { BusinessForm, HoursForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { SignOut } from './Home.jsx'
import Readiness from './Readiness.jsx'
import WebsiteEditor, { WebsitePreview } from './WebsiteEditor.jsx'
import { useWebsite } from './website-data.js'
import DomainSettings from './DomainSettings.jsx'
import { PublishBox } from './WebsiteTab.jsx'
import WebsiteGenerator from './WebsiteGenerator.jsx'

const LABELS = { business: 'Business', payment: 'Plan', details: 'Details', services: 'Services', calendar: 'Calendar', hours: 'Hours', website: 'Website', address: 'Address', publish: 'Publish', launch: 'Done' }
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
        <section key={current} className={`panel enter ${current === 'website' || current === 'publish' ? 'panel--wide panel--site' : current === 'address' ? 'panel--medium' : 'panel--narrow'}`} aria-labelledby="step-title">
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
  if (id === 'website') return <WebsiteStep onDone={done} back={back} />
  if (id === 'address') return <AddressStep onDone={done} back={back} />
  if (id === 'publish') return <PublishStep onDone={done} back={back} />
  return <LaunchStep me={me} onDone={done} />
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
        Let’s get your website ready
      </h1>
      <p className="lede">A few quick questions. We’ll build your website from your answers.</p>
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

// ---------- 7. Website: generate (or keep the current site) → choose design → preview → edit ----------
function WebsiteStep({ onDone, back }) {
  const [data, setData] = useWebsite()
  const latest = useRef(null)
  const [stamp, setStamp] = useState(0)
  const [editorKey, setEditorKey] = useState(0)
  const [keep, setKeep] = useState(false)
  const [state, setState] = useState({})
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const w = data.website
  const next = async () => {
    setState({ busy: true })
    const { status } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'save', content: latest.current || w.draft } })
    if (status === 200) return onDone()
    setState({ error: 'Please check the highlighted text, then continue.' })
  }
  const keepCurrent = async () => {
    setState({ busy: true })
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'keep_website' } })
    onDone()
  }
  if (w.generated) {
    return (
      <div className="form">
        <h1 id="step-title" className="title">
          Create your website
        </h1>
        {!keep ? (
          <>
            <WebsiteGenerator
              intro="We’ll write a professional website from your answers. You pick the design, check everything, and nothing is public until you publish."
              onApplied={(d) => {
                setData(d)
                setStamp((n) => n + 1)
              }}
            />
            <button type="button" className="link-btn" onClick={() => setKeep(true)}>
              I already have a website
            </button>
          </>
        ) : (
          <div className="stack">
            <p className="lede">No problem. Keep your current website and add a “Book now” link to it. You’ll get the link at the end of setup. You can create a GetShowUps website later.</p>
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={keepCurrent}>
              Keep my current website
            </button>
            <button type="button" className="link-btn" onClick={() => setKeep(false)}>
              Create a website instead
            </button>
          </div>
        )}
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Here’s your website
      </h1>
      <p className="lede">Check it on a computer and a phone. Change anything you like below; it saves as you go.</p>
      <WebsitePreview stamp={stamp} />
      <details className="more">
        <summary>Edit text and photos</summary>
        <WebsiteEditor key={editorKey} initial={w.draft} colors={data.options.colors} compact onEdit={(c) => (latest.current = c)} onSaved={() => setStamp((n) => n + 1)} />
      </details>
      <details className="more">
        <summary>Write it again</summary>
        <WebsiteGenerator
          hasDraft
          onApplied={(d) => {
            setData(d)
            latest.current = null
            setEditorKey((k) => k + 1)
            setStamp((n) => n + 1)
          }}
        />
      </details>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={next}>
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

// ---------- 8. Address: GetShowUps address (default), your own domain, or a new one ----------
function AddressStep({ onDone, back }) {
  const [data] = useWebsite()
  const [domain, setDomain] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!data) return <div aria-busy="true" />
  const next = async () => {
    setBusy(true)
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'address', choice: domain || data.domain ? 'own' : 'getshowups' } })
    onDone()
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Choose your website address
      </h1>
      <p className="lede">Start with your free GetShowUps address. You can connect your own domain now or any time later.</p>
      <DomainSettings siteUrl={data.url || ''} compact onChange={(d) => setDomain(d.domain)} />
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={next}>
        Continue
      </button>
      <p className="fine">Connecting a domain keeps going in the background. Your website works on your GetShowUps address meanwhile.</p>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}

// ---------- 9. Preview and publish (explicit approval) ----------
function PublishStep({ onDone, back }) {
  const [data] = useWebsite()
  const [busy, setBusy] = useState(false)
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const later = async () => {
    setBusy(true)
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'keep_private' } })
    onDone()
  }
  return (
    <div className="form">
        <h1 id="step-title" className="title">
          Preview and publish
        </h1>
        <p className="lede">This is exactly what customers will see. Publish when you’re happy. You can change it any time.</p>
        <WebsitePreview stamp={0} />
        <PublishBox
          data={data}
          label="Publish my website"
          onDone={onDone}
          secondary={
            <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={later}>
              Keep it private for now
            </button>
          }
        />
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
    </div>
  )
}

// ---------- 10. Done ----------
function LaunchStep({ me, onDone }) {
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
        You’re all set
      </h1>
      <Readiness compact />
      <div className="field">
        <span>Your booking link (add it to your website, Google profile or social pages)</span>
        <input readOnly value={me.bookingUrl} onFocus={(e) => e.target.select()} aria-label="Your booking link" />
      </div>
      <a className="btn btn-quiet btn-block" href={me.bookingUrl} target="_blank" rel="noreferrer">
        See my booking page
      </a>
      <p className="fine">A booking you make there goes on your Google Calendar like a real one. We mark bookings from your own email as tests, so they don’t count in your results.</p>
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
