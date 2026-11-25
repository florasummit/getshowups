// Business and booking-hours forms, shared by setup and settings.
import { useEffect, useRef, useState } from 'react'
import { LoadError } from './ui.jsx'
import AiWrite from './AiWrite.jsx'
import { api, browserTimeZone, DAY_SHORT, timeZones } from '../lib/api.js'

// A settings save refused because the saved values changed elsewhere (another tab or device) since this page loaded.
const CHANGED_ELSEWHERE = 'These settings were changed somewhere else (another tab or device) since this page opened, so this change wasn’t saved. Reload the page to see the latest, then make your change again.'

const ERRORS = {
  invalid_name: 'Enter your business name.',
  invalid_timezone: 'Choose a time zone.',
  invalid_zips: 'Use ZIP codes separated by commas.',
  invalid_hours: 'End time must be after start time.',
  invalid_workdays: 'Choose at least one day.',
  invalid_slot_minutes: 'Choose an appointment length.',
  invalid_mode: 'Choose where appointments happen.',
  already_exists: 'Your business was just created. Refreshing…',
}
// The setup check re-reads after any save on this page.
const saved = () => window.dispatchEvent(new Event('gsu:settings-saved'))
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

export function BusinessForm({ customer, submitLabel, onSaved }) {
  const [name, setName] = useState(customer?.name || '')
  const [timezone, setTimezone] = useState(customer?.timezone || browserTimeZone())
  const [zips, setZips] = useState((customer?.serviceZips || []).join(', '))
  const [mode, setMode] = useState(customer?.appointmentMode || 'at_business')
  const [state, setState] = useState({})

  const submit = async (e) => {
    e.preventDefault()
    setState({ saving: true })
    let source
    try {
      source = localStorage.getItem('gsu_source') || undefined
    } catch {
      source = undefined
    }
    const { status, data } = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone, serviceZips: zips, appointmentMode: mode, source } })
    if (status === 200 || status === 201) {
      saved()
      return onSaved?.(data)
    }
    if (data.error === 'already_exists') return onSaved?.(data)
    setState({ error: errorText(data.error) })
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Business name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="organization" autoFocus={!customer} />
      </label>
      <fieldset className="field">
        <legend>Where do appointments happen?</legend>
        <div className="choice" role="radiogroup">
          {[
            ['at_business', 'At my location'],
            ['at_customer', 'At the customer’s location'],
          ].map(([value, label]) => (
            <label key={value} className="choice-option">
              <input type="radio" name="appointmentMode" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Time zone</span>
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {[...new Set([timezone, ...timeZones()])].map((tz) => (
            <option key={tz} value={tz}>
              {tz.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          Service ZIP codes <em>optional</em>
        </span>
        <input value={zips} onChange={(e) => setZips(e.target.value)} placeholder="Leave empty to accept everyone" inputMode="text" />
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.saving}>
        {state.saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}

const LENGTHS = [30, 45, 60, 90, 120]

export function HoursForm({ customer, submitLabel, onSaved }) {
  const [workdays, setWorkdays] = useState(customer.workdays)
  const [dayStart, setDayStart] = useState(customer.dayStart)
  const [dayEnd, setDayEnd] = useState(customer.dayEnd)
  const [slotMinutes, setSlotMinutes] = useState(customer.slotMinutes)
  const [state, setState] = useState({})
  // The saved hours this form started from: sent as `base` (a change made elsewhere meanwhile → 409, nothing replaced).
  const base = useRef({ workdays: customer.workdays, dayStart: customer.dayStart, dayEnd: customer.dayEnd, slotMinutes: customer.slotMinutes })

  const toggle = (d) => setWorkdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))

  const submit = async (e) => {
    e.preventDefault()
    setState({ saving: true })
    const { status, data } = await api('/api/dashboard/hours', { method: 'POST', body: { workdays, dayStart, dayEnd, slotMinutes, base: base.current } })
    if (status === 200) {
      base.current = data.hours || base.current
      saved()
      setState({ saved: true })
      setTimeout(() => setState((s) => (s.saved ? {} : s)), 2000)
      return onSaved?.()
    }
    setState({ error: status === 409 ? CHANGED_ELSEWHERE : errorText(data.error) })
  }

  return (
    <form className="form" onSubmit={submit}>
      <fieldset className="field">
        <legend>Days</legend>
        <div className="day-toggles">
          {DAY_SHORT.map((label, d) => (
            <button key={label} type="button" className="day-toggle" aria-pressed={workdays.includes(d)} onClick={() => toggle(d)}>
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field-row">
        <label className="field">
          <span>From</span>
          <input type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} required step={900} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} required step={900} />
        </label>
      </div>
      <label className="field">
        <span>{customer.appointmentMode === 'at_customer' ? 'Visit length' : 'Appointment length'}</span>
        <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
          {[...new Set([slotMinutes, ...LENGTHS])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m > 60 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.saving}>
        {state.saving ? 'Saving…' : state.saved ? 'Saved ✓' : submitLabel}
      </button>
    </form>
  )
}

// Business details shown on the website (phone, what you do, towns, description).
export function ProfileForm({ onSaved }) {
  const [p, setP] = useState(undefined)
  const [state, setState] = useState({})
  // The saved details this form shows (only when they loaded): sent as `base`, so a change made elsewhere meanwhile is
  // never silently replaced (409 conflict).
  const base = useRef(null)
  const load = () =>
    api('/api/dashboard/profile').then(({ status, data }) => {
      if (status === 200 && data.profile) base.current = data.profile
      setP(status === 200 ? data.profile || {} : null)
    })
  useEffect(() => {
    load()
    // The services form saves the same record: keep what this form starts from current, without touching what's typed.
    const on = (e) => {
      base.current = e.detail
      setP(e.detail)
    }
    window.addEventListener('gsu:profile', on)
    return () => window.removeEventListener('gsu:profile', on)
  }, [])
  if (p === null) return <LoadError what="your details" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const submit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setState({ saving: true })
    const { status, data } = await api('/api/dashboard/profile', {
      method: 'POST',
      body: { phone: f.get('phone'), industry: f.get('industry'), description: f.get('description'), cities: f.get('cities'), services: p.services || [], ...(base.current ? { base: base.current } : {}) },
    })
    if (status === 200) {
      base.current = data.profile
      setP(data.profile)
      setState({ saved: true })
      window.dispatchEvent(new CustomEvent('gsu:profile', { detail: data.profile }))
      saved()
      onSaved?.()
    } else if (status === 409) setState({ error: CHANGED_ELSEWHERE })
    else setState({ error: data.fields?.includes('phone') ? 'Enter a 10-digit US phone number, or leave it empty.' : data.fields?.includes('industry') ? 'Tell us what kind of business this is.' : 'Please check the details and try again.' })
  }
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Business phone <em>(shown on your website)</em></span>
        <input name="phone" type="tel" defaultValue={p.phone || ''} autoComplete="tel" inputMode="tel" />
      </label>
      <label className="field">
        <span>What do you do?</span>
        <input name="industry" defaultValue={p.industry || ''} maxLength={60} required placeholder="Pool service" />
      </label>
      <label className="field">
        <span>Towns you serve <em>(comma separated)</em></span>
        <input name="cities" defaultValue={(p.cities || []).join(', ')} />
      </label>
      <label className="field">
        <span>Short description <em>(optional)</em></span>
        <textarea name="description" rows={3} maxLength={400} defaultValue={p.description || ''} />
      </label>
      <AiWrite field="description" draft />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="fine" role="status">
          Saved.
        </p>
      )}
      <button className="btn btn-quiet btn-block" disabled={state.saving}>
        Save details
      </button>
    </form>
  )
}

const POLICY_ERRORS = {
  beforeVisit: 'Keep “Before the appointment” under 300 characters.',
  cancellation: 'Keep the cancellation note under 300 characters.',
  'beforeVisit:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
  'cancellation:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
}

// What customers should know: shown on the booking page and in the confirmation and day-before reminder.
export function PoliciesForm() {
  const [p, setP] = useState(undefined)
  const [state, setState] = useState({})
  const base = useRef(null) // the saved policies this form shows (see ProfileForm)
  const load = () =>
    api('/api/dashboard/policies').then(({ status, data }) => {
      if (status === 200) base.current = data.policies
      setP(status === 200 ? data.policies : null)
    })
  useEffect(() => {
    load()
  }, [])
  if (p === null) return <LoadError what="these notes" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const submit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setState({ saving: true })
    const { status, data } = await api('/api/dashboard/policies', { method: 'POST', body: { beforeVisit: f.get('beforeVisit'), cancellation: f.get('cancellation'), ...(base.current ? { base: base.current } : {}) } })
    if (status === 200) {
      base.current = data.policies
      setP(data.policies)
      setState({ saved: true })
      saved()
    } else if (status === 409) setState({ error: CHANGED_ELSEWHERE })
    else setState({ error: POLICY_ERRORS[data.fields?.[0]] || 'Couldn’t save. Please try again.' })
  }
  return (
    <form className="form" onSubmit={submit}>
      <p className="fine">Shown on your booking page and in the confirmation and day-before reminder. Leave a box empty to leave it out.</p>
      <label className="field">
        <span>Before the appointment <em>(optional)</em></span>
        <textarea name="beforeVisit" rows={3} maxLength={300} defaultValue={p.beforeVisit} placeholder="Please unlock the gate and keep pets inside." />
      </label>
      <AiWrite field="beforeVisit" />
      <label className="field">
        <span>Cancellations <em>(optional)</em></span>
        <textarea name="cancellation" rows={2} maxLength={300} defaultValue={p.cancellation} placeholder="Please cancel at least 24 hours ahead." />
      </label>
      <AiWrite field="cancellation" />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="fine" role="status">
          Saved.
        </p>
      )}
      <button className="btn btn-quiet btn-block" disabled={state.saving}>
        Save
      </button>
    </form>
  )
}

// Services and prices: one list for the receptionist, the assistant, ads and new websites. The published website keeps its
// own copy (a visitor never sees it change without a publish); the setup check says when the two disagree.
export function ServicesForm() {
  const [p, setP] = useState(undefined)
  const [rows, setRows] = useState(null)
  const [state, setState] = useState({})
  const base = useRef(null)
  const load = () =>
    api('/api/dashboard/profile').then(({ status, data }) => {
      if (status === 200 && data.profile) base.current = data.profile
      setP(status === 200 ? data.profile || {} : null)
    })
  useEffect(() => {
    load()
    const on = (e) => {
      base.current = e.detail
      setP(e.detail)
    }
    window.addEventListener('gsu:profile', on)
    return () => window.removeEventListener('gsu:profile', on)
  }, [])
  if (p === null) return <LoadError what="your services" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const list = rows ?? (p.services?.length ? p.services : [{ name: '', price: '' }])
  const set = (i, k) => (e) => setRows(list.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))
  const fromWebsite = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website')
    const found = (status === 200 ? data.draft?.services || [] : []).filter((x) => x?.name).slice(0, 8).map((x) => ({ name: String(x.name).slice(0, 60), price: String(x.price || '').slice(0, 40) }))
    if (found.length) setRows(found)
    setState(found.length ? { note: 'Copied from your website. Check them, then save.' } : { error: 'Your website lists no services.' })
  }
  const submit = async (e) => {
    e.preventDefault()
    const industry = p.industry || new FormData(e.currentTarget).get('industry')
    setState({ busy: true })
    const services = list.filter((r) => r.name.trim()).map(({ name, price }) => ({ name, price: price || '' }))
    const { status, data } = await api('/api/dashboard/profile', { method: 'POST', body: { phone: p.phone, industry, description: p.description, cities: p.cities || [], services, ...(base.current ? { base: base.current } : {}) } })
    if (status === 200) {
      base.current = data.profile
      setP(data.profile)
      setRows(null)
      setState({ saved: true })
      window.dispatchEvent(new CustomEvent('gsu:profile', { detail: data.profile }))
      saved()
    } else setState({ error: status === 409 ? CHANGED_ELSEWHERE : data.fields?.includes('services:unapproved_claim') ? 'Please remove promises like guarantees, discounts or ratings from names and prices.' : data.fields?.includes('industry') ? 'Tell us what kind of business this is.' : 'Please check the services and try again.' })
  }
  return (
    <form className="form" onSubmit={submit}>
      <p className="fine">What the receptionist, the assistant and your ads say you do. Write what a price covers: “$300 per month”, “From $150 per visit”, “$95 per hour”.</p>
      {!p.industry && (
        <label className="field">
          <span>What do you do?</span>
          <input name="industry" maxLength={60} required placeholder="Pool service" />
        </label>
      )}
      {list.map((r, i) => (
        <div key={i} className="service-row">
          <label className="field">
            <span className={i ? 'sr-only' : undefined}>Service</span>
            <input value={r.name} onChange={set(i, 'name')} maxLength={60} aria-label={`Service ${i + 1}`} />
          </label>
          <label className="field field--price">
            <span className={i ? 'sr-only' : undefined}>Price</span>
            <input value={r.price || ''} onChange={set(i, 'price')} maxLength={40} placeholder="$150 per visit" aria-label={`Price for service ${i + 1}`} />
          </label>
          <button type="button" className="link-btn service-remove" aria-label={`Remove service ${i + 1}`} onClick={() => setRows(list.filter((_, j) => j !== i))} disabled={list.length === 1}>
            Remove
          </button>
        </div>
      ))}
      <div className="row-actions">
        {list.length < 8 && (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setRows([...list, { name: '', price: '' }])}>
            Add a service
          </button>
        )}
        <button type="button" className="btn btn-sm btn-quiet" onClick={fromWebsite} disabled={state.busy}>
          Copy from my website
        </button>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {(state.saved || state.note) && (
        <p className="fine" role="status">
          {state.saved ? 'Saved. The receptionist uses it now. Your website changes when you edit and publish it.' : state.note}
        </p>
      )}
      <button className="btn btn-quiet btn-block" disabled={state.busy}>
        Save services
      </button>
    </form>
  )
}

const NOTICE = [
  [0, 'None: any open time'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
  [720, '12 hours'],
  [1440, '1 day (no same-day)'],
  [2880, '2 days'],
]
const AVAIL_ERRORS = { invalid_date: 'Choose a date.', too_many_closures: 'That’s too many closed dates.', invalid_label: 'Keep the note under 60 characters.', not_available_yet: 'Closed dates aren’t available yet. Block the time in Google Calendar (as Busy) meanwhile.' }
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// Closed dates and minimum notice: the booking page, the receptionist and every booking link follow them at once.
export function AvailabilityForm() {
  const [d, setD] = useState(undefined)
  const [edit, setEdit] = useState(null)
  const [date, setDate] = useState('')
  const [label, setLabel] = useState('')
  const [state, setState] = useState({})
  const load = () => api('/api/dashboard/availability').then(({ status, data }) => setD(status === 200 ? data : null))
  useEffect(() => {
    load()
  }, [])
  if (d === null) return <LoadError what="your closed dates" onRetry={load} />
  if (d === undefined) return <div aria-busy="true" />
  if (!d.ready) return <p className="fine">Closed dates and minimum notice aren’t available yet. Meanwhile, block time in Google Calendar and mark it Busy; booking follows it.</p>
  const cur = edit ?? { minNoticeMinutes: d.minNoticeMinutes, closures: d.closures }
  const add = (x) => setEdit({ ...cur, closures: [...cur.closures.filter((c) => c.date !== x.date), x].sort((a, b) => a.date.localeCompare(b.date)) })
  const submit = async (e) => {
    e.preventDefault()
    const body = date ? { ...cur, closures: [...cur.closures.filter((c) => c.date !== date), { date, label }] } : cur
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/availability', { method: 'POST', body: { ...body, base: { minNoticeMinutes: d.minNoticeMinutes, closures: d.closures } } })
    if (status !== 200) return setState({ error: status === 409 && data.error === 'conflict' ? CHANGED_ELSEWHERE : AVAIL_ERRORS[data.error] || 'Couldn’t save. Please try again.' })
    setD(data)
    setEdit(null)
    setDate('')
    setLabel('')
    setState({ saved: true })
    saved()
  }
  const suggested = d.suggested.filter((h) => !cur.closures.some((c) => c.date === h.date))
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Minimum notice before a visit</span>
        <select value={cur.minNoticeMinutes} onChange={(e) => setEdit({ ...cur, minNoticeMinutes: Number(e.target.value) })}>
          {NOTICE.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="field">
        <legend>Closed dates</legend>
        {cur.closures.length ? (
          <ul className="rows" data-closures-list>
            {cur.closures.map((c) => (
              <li key={c.date} className="row">
                <div className="row-main">
                  <p className="row-title">{longDate(c.date)}</p>
                  <p className="row-sub">
                    {c.label}
                    {d.booked[c.date] ? ` ${d.booked[c.date]} booked already: closing doesn’t cancel them.` : ''}
                  </p>
                </div>
                <button type="button" className="link-btn" onClick={() => setEdit({ ...cur, closures: cur.closures.filter((x) => x.date !== c.date) })}>
                  Remove<span className="sr-only"> {c.date}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fine">None. You’re open on every booking day.</p>
        )}
      </fieldset>
      {suggested.length > 0 && (
        <div className="row-actions" role="group" aria-label="Upcoming holidays">
          {suggested.map((h) => (
            <button key={h.date} type="button" className="btn btn-sm btn-quiet" onClick={() => add(h)}>
              Close {h.label}
            </button>
          ))}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>Another date</span>
          <input type="date" value={date} min={d.today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>
            Note <em>optional</em>
          </span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </label>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="fine" role="status">
          Saved. Customers see it now.
        </p>
      )}
      <button className="btn btn-quiet btn-block" disabled={state.busy}>
        Save closed dates and notice
      </button>
    </form>
  )
}
