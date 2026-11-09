// Business and booking-hours forms, shared by setup and settings.
import { useState } from 'react'
import { api, browserTimeZone, DAY_SHORT, timeZones } from '../lib/api.js'

const ERRORS = {
  invalid_name: 'Enter your business name.',
  invalid_timezone: 'Choose a time zone.',
  invalid_zips: 'Use ZIP codes separated by commas.',
  invalid_hours: 'End time must be after start time.',
  invalid_workdays: 'Choose at least one day.',
  invalid_slot_minutes: 'Choose an appointment length.',
  already_exists: 'Your business was just created. Refreshing…',
}
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

export function BusinessForm({ customer, submitLabel, onSaved }) {
  const [name, setName] = useState(customer?.name || '')
  const [timezone, setTimezone] = useState(customer?.timezone || browserTimeZone())
  const [zips, setZips] = useState((customer?.serviceZips || []).join(', '))
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
    const { status, data } = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone, serviceZips: zips, source } })
    if (status === 200 || status === 201) return onSaved?.(data)
    if (data.error === 'already_exists') return onSaved?.(data)
    setState({ error: errorText(data.error) })
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Business name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="organization" autoFocus={!customer} />
      </label>
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

  const toggle = (d) => setWorkdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))

  const submit = async (e) => {
    e.preventDefault()
    setState({ saving: true })
    const { status, data } = await api('/api/dashboard/hours', { method: 'POST', body: { workdays, dayStart, dayEnd, slotMinutes } })
    if (status === 200) {
      setState({ saved: true })
      setTimeout(() => setState((s) => (s.saved ? {} : s)), 2000)
      return onSaved?.()
    }
    setState({ error: errorText(data.error) })
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
        <span>Appointment length</span>
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
